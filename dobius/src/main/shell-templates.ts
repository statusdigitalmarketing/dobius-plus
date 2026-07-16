// Why: local PTYs and the daemon/SSH path must use identical ZDOTDIR discovery;
// small drift here breaks different terminal transports in different ways.

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function getZshEnvTemplate(zshDir: string, headerPrefix = ''): string {
  const header = headerPrefix
    ? `Dobius ${headerPrefix} zsh shell-ready wrapper`
    : 'Dobius zsh shell-ready wrapper'
  return `# ${header}
_dobius_spawn_orig_zdotdir="\${DOBIUS_ORIG_ZDOTDIR:-}"
_dobius_user_zdotdir="\${_dobius_spawn_orig_zdotdir:-$HOME}"
_dobius_zshenv_source_dir="\${DOBIUS_ZSHENV_SOURCE_DIR:-$HOME}"
_dobius_zshenv_path=""
unset DOBIUS_ZSHENV_SOURCE_DIR

# Normalize fallback and source roots before reading user .zshenv so nested
# Dobius PTYs never source another Dobius wrapper recursively.
while [[ "\${_dobius_user_zdotdir}" == */ ]]; do
  _dobius_user_zdotdir="\${_dobius_user_zdotdir%/}"
done
case "\${_dobius_user_zdotdir}" in
  ""|*/shell-ready/zsh) _dobius_user_zdotdir="$HOME" ;;
esac
while [[ "\${_dobius_zshenv_source_dir}" == */ ]]; do
  _dobius_zshenv_source_dir="\${_dobius_zshenv_source_dir%/}"
done
case "\${_dobius_zshenv_source_dir}" in
  ""|*/shell-ready/zsh) _dobius_zshenv_source_dir="$HOME" ;;
esac

# Why: source at wrapper top level, not in a function/subshell, so .zshenv
# exports, functions, path/fpath typesets, and zsh options keep normal scope.
unset ZDOTDIR
if [[ -n "\${_dobius_zshenv_source_dir:-}" && -f "\${_dobius_zshenv_source_dir}/.zshenv" ]]; then
  _dobius_zshenv_path="\${_dobius_zshenv_source_dir}/.zshenv"
fi
if [[ -n "\${_dobius_zshenv_path:-}" ]]; then
  source "\${_dobius_zshenv_path}"
fi

_dobius_discovered_zdotdir="\${ZDOTDIR:-}"

while [[ "\${_dobius_discovered_zdotdir}" == */ ]]; do
  _dobius_discovered_zdotdir="\${_dobius_discovered_zdotdir%/}"
done

case "\${_dobius_discovered_zdotdir}" in
  *[![:space:]]*) ;;
  *) _dobius_discovered_zdotdir="" ;;
esac

if [[ -n "\${_dobius_discovered_zdotdir}" && ! -d "\${_dobius_discovered_zdotdir}" ]]; then
  [[ "\${DOBIUS_DEBUG:-0}" == "1" ]] && echo "[dobius-shell-ready] Discovered ZDOTDIR '\${_dobius_discovered_zdotdir}' does not exist, falling back" >&2
  _dobius_discovered_zdotdir=""
fi

export DOBIUS_ORIG_ZDOTDIR="\${_dobius_discovered_zdotdir:-\${_dobius_user_zdotdir:-$HOME}}"

while [[ "\${DOBIUS_ORIG_ZDOTDIR}" == */ ]]; do
  DOBIUS_ORIG_ZDOTDIR="\${DOBIUS_ORIG_ZDOTDIR%/}"
done

case "\${DOBIUS_ORIG_ZDOTDIR}" in
  ""|*/shell-ready/zsh) export DOBIUS_ORIG_ZDOTDIR="$HOME" ;;
esac

export ZDOTDIR=${quotePosixSingle(zshDir)}
unset _dobius_spawn_orig_zdotdir _dobius_user_zdotdir _dobius_zshenv_source_dir _dobius_zshenv_path _dobius_discovered_zdotdir
`
}

export function getZshStartupFileSourceBlock(options: {
  fileName: '.zprofile' | '.zshrc' | '.zlogin'
  homeExpression?: string
  interactiveOnly?: boolean
  skipWhenHomeIsCurrentZdotdir?: boolean
}): string {
  const homeExpression = options.homeExpression ?? '"${DOBIUS_ORIG_ZDOTDIR:-$HOME}"'
  const checks = [
    options.skipWhenHomeIsCurrentZdotdir ? '"$_dobius_home" != "$ZDOTDIR"' : null,
    options.interactiveOnly ? '-o interactive' : null,
    `-f "$_dobius_home/${options.fileName}"`
  ].filter(Boolean)

  return `_dobius_home=${homeExpression}
case "\${_dobius_home%/}" in
  */shell-ready/zsh) _dobius_home="$HOME" ;;
esac
if [[ ${checks.join(' && ')} ]]; then
  _dobius_wrapper_zdotdir="$ZDOTDIR"
  # Why: user startup files resolve plugin/config paths from their own ZDOTDIR;
  # Dobius restores its wrapper dir afterward so zsh still loads wrapper files.
  export ZDOTDIR="$_dobius_home"
  source "$_dobius_home/${options.fileName}"
  export ZDOTDIR="$_dobius_wrapper_zdotdir"
  unset _dobius_wrapper_zdotdir
fi
`
}

// Why: zsh precmd fires before zle switches the PTY into line-editing mode,
// so the marker must be emitted from zle-line-init. Registering it through
// add-zle-hook-widget is unsafe: the azhw dispatcher aborts its hook chain
// when an earlier hook exits non-zero, and a pre-existing raw user widget
// (e.g. oh-my-zsh vi-mode without VI_MODE_SET_CURSOR) is preserved as the
// first hook and fails — silently suppressing the marker and stalling every
// startup command on the pre-ready timeout. Instead, own zle-line-init: emit
// the marker first, then chain to whatever widget was installed before.
export function getZshShellReadyMarkerRegistrationBlock(escapedMarker: string): string {
  return `if [[ "\${DOBIUS_SHELL_READY_MARKER:-0}" == "1" ]]; then
  # Why: capture the prior zle-line-init so the marker chains to it. On a
  # re-source we are already the bound widget, so keep the function captured
  # the first time instead of clobbering it to empty (which would silently
  # drop the user's widget on every prompt after the second source). Only
  # user-defined widgets are chainable as plain functions; builtin/completion
  # forms (rare for zle-line-init) are left unchained.
  if [[ "\${widgets[zle-line-init]:-}" == "user:__dobius_prompt_mark" ]]; then
    :
  elif (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" == user:* ]]; then
    __dobius_prev_line_init_fn="\${widgets[zle-line-init]#user:}"
  else
    __dobius_prev_line_init_fn=""
  fi
  __dobius_prompt_mark() {
    printf "${escapedMarker}"
    # Why: call the prior hook as a plain function, not an aliased widget, so
    # $WIDGET stays zle-line-init for add-zle-hook-widget dispatchers.
    if [[ -n "\${__dobius_prev_line_init_fn:-}" ]]; then
      "\${__dobius_prev_line_init_fn}" "$@"
    fi
  }
  zle -N zle-line-init __dobius_prompt_mark
fi
`
}

export function getZshFinalZdotdirRestoreBlock(homeExpression = '"${DOBIUS_ORIG_ZDOTDIR:-$HOME}"') {
  return `_dobius_home=${homeExpression}
case "\${_dobius_home%/}" in
  */shell-ready/zsh) _dobius_home="$HOME" ;;
esac
# Why: after Dobius's last wrapper file has loaded, the interactive shell should
# expose the same ZDOTDIR a normal zsh startup would expose.
export ZDOTDIR="$_dobius_home"
unset _dobius_home
`
}
