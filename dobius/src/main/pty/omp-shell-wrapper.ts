// Why: OMP 15.x discovers built-in user extensions from ~/.omp/agent, but a
// typed `omp` in an existing terminal still needs Dobius's status extension
// passed explicitly. Do not redirect PI_CODING_AGENT_DIR here: that variable
// is OMP's mutable home, so config/auth/session commands must keep the user's
// normal source of truth.

const OMP_SUBCOMMANDS = [
  '__complete',
  'acp',
  'agents',
  'auth-broker',
  'auth-gateway',
  'bench',
  'commit',
  'completions',
  'config',
  'dry-balance',
  'gallery',
  'grep',
  'grievances',
  'install',
  'join',
  'models',
  'plugin',
  'read',
  'say',
  'search',
  'setup',
  'shell',
  'ssh',
  'stats',
  'tiny-models',
  'token',
  'ttsr',
  'update',
  'usage',
  'worktree',
  'q',
  'wt'
] as const

export function getPosixOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.join('|')
  return `# Why: OMP does not auto-load Dobius's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
__dobius_omp_should_skip_extension() {
  case "\${1:-}" in
    help|--help|-h|--version|-v) return 0 ;;
    ${subcommands}) return 0 ;;
  esac
  return 1
}
__dobius_omp() {
  local __dobius_use_extension=1
  __dobius_omp_should_skip_extension "\${1:-}" && __dobius_use_extension=0
  if [[ $__dobius_use_extension -eq 1 && -n "\${DOBIUS_OMP_STATUS_EXTENSION:-}" && -f "\${DOBIUS_OMP_STATUS_EXTENSION}" ]]; then
    if [[ "\${1:-}" == "launch" ]]; then
      shift
      command omp launch --extension "\${DOBIUS_OMP_STATUS_EXTENSION}" "$@"
    else
      command omp --extension "\${DOBIUS_OMP_STATUS_EXTENSION}" "$@"
    fi
  else
    command omp "$@"
  fi
}
if [[ -n "\${DOBIUS_OMP_STATUS_EXTENSION:-}" ]]; then
  omp() { __dobius_omp "$@"; }
fi
`
}

export function getPowerShellOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join(', ')
  return `# Why: OMP does not auto-load Dobius's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
function Global:__DobiusOmpShouldSkipExtension {
    param([string]$Name)
    $skip = @("help", "--help", "-h", "--version", "-v") + @(${subcommands})
    return $skip -contains $Name
}
if ($env:DOBIUS_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $dobiusUseExtension = -not (__DobiusOmpShouldSkipExtension -Name ([string]($args[0])))
        $dobiusStatus = 0
        $dobiusCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $dobiusCommand) {
            Write-Error "omp executable not found"
            $dobiusStatus = 127
        } elseif ($dobiusUseExtension -and $env:DOBIUS_OMP_STATUS_EXTENSION -and
            (Test-Path -LiteralPath $env:DOBIUS_OMP_STATUS_EXTENSION)) {
            if ($args.Count -gt 0 -and $args[0] -eq "launch") {
                $dobiusLaunchArgs = @($args | Select-Object -Skip 1)
                & $dobiusCommand.Source launch --extension $env:DOBIUS_OMP_STATUS_EXTENSION @dobiusLaunchArgs
            } else {
                & $dobiusCommand.Source --extension $env:DOBIUS_OMP_STATUS_EXTENSION @args
            }
            $dobiusStatus = $LASTEXITCODE
        } else {
            & $dobiusCommand.Source @args
            $dobiusStatus = $LASTEXITCODE
        }

        $global:LASTEXITCODE = $dobiusStatus
    }
}
`
}
