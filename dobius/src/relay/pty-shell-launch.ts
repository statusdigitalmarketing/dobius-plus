import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getPosixOmpShellWrapper } from '../main/pty/omp-shell-wrapper'
import {
  getZshFinalZdotdirRestoreBlock,
  getZshShellReadyMarkerRegistrationBlock,
  getZshStartupFileSourceBlock
} from '../main/shell-templates'

const RELAY_SHELL_READY_DIR = '.dobius-relay/shell-ready'
const POSIX_LOGIN_ARGS = ['-l']
const SHELL_READY_MARKER_ESCAPED = '\\033]777;dobius-shell-ready\\007'

export type RelayShellLaunchConfig = {
  args: string[]
  env: Record<string, string>
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellBasename(shellPath: string): string {
  return shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

function windowsShellArgs(
  shellName: string,
  options: { terminalWindowsWslDistro?: string | null } = {}
): string[] | null {
  if (shellName === 'powershell.exe' || shellName === 'powershell') {
    return ['-NoLogo']
  }
  if (shellName === 'pwsh.exe' || shellName === 'pwsh') {
    return ['-NoLogo']
  }
  if (shellName === 'cmd.exe' || shellName === 'cmd') {
    return []
  }
  if (shellName === 'wsl.exe' || shellName === 'wsl') {
    const distro = options.terminalWindowsWslDistro?.trim()
    return distro ? ['-d', distro] : []
  }
  return null
}

function hasOverlayRestoreEnv(env: Record<string, string>): boolean {
  return Boolean(
    env.DOBIUS_OPENCODE_CONFIG_DIR ||
    env.DOBIUS_MIMOCODE_HOME ||
    env.DOBIUS_REMOTE_CLI_BIN_DIR ||
    env.DOBIUS_OMP_STATUS_EXTENSION
  )
}

function getWrapperRoot(env: Record<string, string>): string {
  return join(env.HOME || process.env.HOME || homedir(), RELAY_SHELL_READY_DIR)
}

function normalizeOriginalZdotdirCandidate(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const normalized = value.replace(/\/+$/, '')
  if (!normalized || normalized.endsWith('/shell-ready/zsh')) {
    return null
  }
  return value
}

function resolveOriginalZdotdir(env: Record<string, string>): string {
  return (
    normalizeOriginalZdotdirCandidate(env.ZDOTDIR) ||
    normalizeOriginalZdotdirCandidate(env.DOBIUS_ORIG_ZDOTDIR) ||
    env.HOME ||
    process.env.HOME ||
    ''
  )
}

function ensureOverlayRestoreWrappers(root: string): void {
  const zshDir = join(root, 'zsh')
  const bashDir = join(root, 'bash')

  const zshEnv = `# Dobius relay zsh overlay wrapper
export DOBIUS_ORIG_ZDOTDIR="\${DOBIUS_ORIG_ZDOTDIR:-$HOME}"
case "\${DOBIUS_ORIG_ZDOTDIR%/}" in
  */shell-ready/zsh) export DOBIUS_ORIG_ZDOTDIR="$HOME" ;;
esac
[[ -f "$DOBIUS_ORIG_ZDOTDIR/.zshenv" ]] && source "$DOBIUS_ORIG_ZDOTDIR/.zshenv"
export DOBIUS_USER_ZDOTDIR="\${ZDOTDIR:-\${DOBIUS_ORIG_ZDOTDIR:-$HOME}}"
case "\${DOBIUS_USER_ZDOTDIR%/}" in
  */shell-ready/zsh) export DOBIUS_USER_ZDOTDIR="$HOME" ;;
esac
export ZDOTDIR=${quotePosixSingle(zshDir)}
`
  const zshProfile = `# Dobius relay zsh overlay wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zprofile',
  homeExpression: '"${DOBIUS_USER_ZDOTDIR:-${DOBIUS_ORIG_ZDOTDIR:-$HOME}}"'
})}
`
  const zshRc = `# Dobius relay zsh overlay wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zshrc',
  homeExpression: '"${DOBIUS_USER_ZDOTDIR:-${DOBIUS_ORIG_ZDOTDIR:-$HOME}}"',
  interactiveOnly: true
})}
if [[ ! -o login ]]; then
  # Why: remote startup files can re-export user defaults after relay spawn.
  [[ -n "\${DOBIUS_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${DOBIUS_OPENCODE_CONFIG_DIR}"
  [[ -n "\${DOBIUS_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${DOBIUS_MIMOCODE_HOME}"
  [[ -n "\${DOBIUS_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${DOBIUS_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${DOBIUS_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac
  ${getPosixOmpShellWrapper()}
fi
if [[ ! -o login ]]; then
${getZshFinalZdotdirRestoreBlock('"${DOBIUS_USER_ZDOTDIR:-${DOBIUS_ORIG_ZDOTDIR:-$HOME}}"')}
fi
`
  const zshLogin = `# Dobius relay zsh overlay wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zlogin',
  homeExpression: '"${DOBIUS_USER_ZDOTDIR:-${DOBIUS_ORIG_ZDOTDIR:-$HOME}}"',
  interactiveOnly: true
})}
# Why: .zlogin is the final zsh login startup file before the prompt.
[[ -n "\${DOBIUS_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${DOBIUS_OPENCODE_CONFIG_DIR}"
[[ -n "\${DOBIUS_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${DOBIUS_MIMOCODE_HOME}"
[[ -n "\${DOBIUS_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${DOBIUS_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${DOBIUS_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac
${getPosixOmpShellWrapper()}
${getZshFinalZdotdirRestoreBlock('"${DOBIUS_USER_ZDOTDIR:-${DOBIUS_ORIG_ZDOTDIR:-$HOME}}"')}
${getZshShellReadyMarkerRegistrationBlock(SHELL_READY_MARKER_ESCAPED)}
`
  const bashRc = `# Dobius relay bash overlay wrapper
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: remote startup files can re-export user defaults after relay spawn.
[[ -n "\${DOBIUS_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${DOBIUS_OPENCODE_CONFIG_DIR}"
[[ -n "\${DOBIUS_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${DOBIUS_MIMOCODE_HOME}"
[[ -n "\${DOBIUS_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${DOBIUS_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${DOBIUS_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac
${getPosixOmpShellWrapper()}
# Why: SSH bash sessions need the same command lifecycle markers as local
# bash so agent rows stop showing "working" when the foreground command exits.
__dobius_osc133_precmd() {
  local exit_code=$?
  __dobius_in_prompt_command=1
  if [[ -n "\${__dobius_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __dobius_in_command
  fi
  printf "\\033]133;A\\007"
}
__dobius_osc133_prompt_done() {
  unset __dobius_in_prompt_command
}
__dobius_run_user_debug_trap() {
  if [[ -n "\${__dobius_user_debug_trap:-}" ]]; then
    eval "$__dobius_user_debug_trap" || true
  fi
}
__dobius_osc133_preexec() {
  __dobius_run_user_debug_trap
  [[ -z "\${__dobius_in_prompt_command:-}" ]] || return
  case "$BASH_COMMAND" in
    *__dobius_osc133_precmd*|*__dobius_osc133_prompt_done*) return ;;
  esac
  printf "\\033]133;C\\007"
  __dobius_in_command=1
}
__dobius_normalize_prompt_command() {
  local __dobius_joined="" __dobius_prompt_part
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    for __dobius_prompt_part in "\${PROMPT_COMMAND[@]}"; do
      [[ -n "$__dobius_prompt_part" ]] || continue
      if [[ -n "$__dobius_joined" ]]; then
        __dobius_joined="$__dobius_joined;$__dobius_prompt_part"
      else
        __dobius_joined="$__dobius_prompt_part"
      fi
    done
    PROMPT_COMMAND="$__dobius_joined"
  fi
  # Why: RHEL-family /etc/bashrc can leave an inherited PROMPT_COMMAND ending in
  # a ";"/whitespace separator; trim it so Dobius's prepend/append never form ";;".
  while [[ "\${PROMPT_COMMAND:-}" == *[[:space:]\\;] ]]; do
    PROMPT_COMMAND="\${PROMPT_COMMAND%?}"
  done
}
__dobius_prepend_prompt_command() {
  __dobius_normalize_prompt_command
  PROMPT_COMMAND="__dobius_osc133_precmd\${PROMPT_COMMAND:+;\${PROMPT_COMMAND}}"
}
__dobius_append_prompt_command() {
  local command="$1"
  __dobius_normalize_prompt_command
  if [[ -n "\${PROMPT_COMMAND:-}" ]]; then
    PROMPT_COMMAND="\${PROMPT_COMMAND};$command"
  else
    PROMPT_COMMAND="$command"
  fi
}
__dobius_prepend_prompt_command
# Why: SSH startup commands are renderer-delivered; emit the same internal
# readiness marker as local shells only when that delivery mode asks for it.
if [[ "\${DOBIUS_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __dobius_prompt_mark() {
    printf "${SHELL_READY_MARKER_ESCAPED}"
  }
  __dobius_append_prompt_command "__dobius_prompt_mark"
fi
__dobius_append_prompt_command "__dobius_osc133_prompt_done"
__dobius_debug_trap_spec="$(trap -p DEBUG)"
if [[ -n "$__dobius_debug_trap_spec" ]]; then
  __dobius_debug_trap_command="\${__dobius_debug_trap_spec#trap -- }"
  __dobius_debug_trap_command="\${__dobius_debug_trap_command% DEBUG}"
  eval "__dobius_user_debug_trap=$__dobius_debug_trap_command"
fi
unset __dobius_debug_trap_spec __dobius_debug_trap_command
unset -f __dobius_normalize_prompt_command __dobius_prepend_prompt_command __dobius_append_prompt_command
# Why: arm DEBUG after wrapper setup so the relay rcfile itself does not emit
# fake command-start/end markers before the first prompt.
trap '__dobius_osc133_preexec' DEBUG
`

  const files = [
    [join(zshDir, '.zshenv'), zshEnv],
    [join(zshDir, '.zprofile'), zshProfile],
    [join(zshDir, '.zshrc'), zshRc],
    [join(zshDir, '.zlogin'), zshLogin],
    [join(bashDir, 'rcfile'), bashRc]
  ] as const

  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true })
    let existing: string | null = null
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = null
    }
    // Why: relay wrapper files persist under ~/.dobius-relay across app
    // upgrades. Existence alone is not enough; stale wrappers would miss
    // later fixes such as preserving post-.zshenv ZDOTDIR.
    if (existing !== content) {
      writeFileSync(path, content, 'utf8')
    }
    chmodSync(path, 0o644)
  }
}

export function getRelayShellLaunchConfig(
  shellPath: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  options: { emitReadyMarker?: boolean; terminalWindowsWslDistro?: string | null } = {}
): RelayShellLaunchConfig {
  const shellName = shellBasename(shellPath)
  const emitReadyMarker = options.emitReadyMarker === true
  if (platform === 'win32') {
    // Why: pwsh also exists on POSIX remotes; Windows-specific shell args must
    // only apply when the relay itself is running on native Windows.
    return {
      args:
        windowsShellArgs(shellName, {
          terminalWindowsWslDistro: options.terminalWindowsWslDistro
        }) ?? [],
      env: {}
    }
  }

  if (shellName !== 'zsh' && shellName !== 'bash') {
    return { args: POSIX_LOGIN_ARGS, env: {} }
  }
  // Why: preserve plain zsh startup fast path; only force wrappers when
  // shell-ready or overlay env restoration is requested.
  if (shellName === 'zsh' && !hasOverlayRestoreEnv(env) && !emitReadyMarker) {
    return { args: POSIX_LOGIN_ARGS, env: {} }
  }

  const root = getWrapperRoot(env)
  ensureOverlayRestoreWrappers(root)

  if (shellName === 'zsh') {
    return {
      args: POSIX_LOGIN_ARGS,
      env: {
        DOBIUS_ORIG_ZDOTDIR: resolveOriginalZdotdir(env),
        ZDOTDIR: join(root, 'zsh'),
        ...(emitReadyMarker ? { DOBIUS_SHELL_READY_MARKER: '1' } : {})
      }
    }
  }

  return {
    args: ['--rcfile', join(root, 'bash', 'rcfile')],
    env: emitReadyMarker ? { DOBIUS_SHELL_READY_MARKER: '1' } : {}
  }
}
