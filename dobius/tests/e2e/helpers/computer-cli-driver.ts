import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const RUNTIME_METADATA_FILE = 'dobius-runtime.json'
let dobiusDevUserDataPath: string | null = null
let dobiusServeProcess: ChildProcess | null = null
let dobiusServeStdout = ''
let dobiusServeStderr = ''

export type CliResult = {
  stdout: string
  stderr: string
}

type RunDobiusCliOptions = {
  retryMissingRuntimeMetadata?: boolean
}

export async function runDobiusCli(
  args: string[],
  options: RunDobiusCliOptions = {}
): Promise<CliResult> {
  try {
    return await runDobiusCliOnce(args)
  } catch (error) {
    if (
      options.retryMissingRuntimeMetadata !== false &&
      isMissingRuntimeMetadataError(args, error)
    ) {
      // Why: Windows CI can let the dev runtime exit while launching the
      // fixture app; reopen once so the desktop action gets a live runtime.
      await ensureDobiusRuntimeLaunched()
      return await runDobiusCliOnce(args)
    }
    throw error
  }
}

async function runDobiusCliOnce(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/dobius-dev.mjs')
  const command = process.env.DOBIUS_COMPUTER_CLI ?? process.execPath
  const cliArgs = process.env.DOBIUS_COMPUTER_CLI ? args : [devCli, ...args]
  const env = { ...process.env }
  if (!process.env.DOBIUS_COMPUTER_CLI && !env.DOBIUS_DEV_USER_DATA_PATH) {
    env.DOBIUS_DEV_USER_DATA_PATH = await getComputerE2eDobiusDevUserDataPath()
  }
  try {
    const result = await execFileAsync(command, cliArgs, {
      env,
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const output = error as { message: string; stdout: string; stderr: string }
      throw new Error(`${output.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
    }
    throw error
  }
}

export async function ensureDobiusRuntimeLaunched(): Promise<void> {
  if (!process.env.DOBIUS_COMPUTER_CLI && process.platform === 'win32') {
    await ensureDobiusRuntimeServed()
    return
  }
  await runDobiusCli(['open', '--json'], { retryMissingRuntimeMetadata: false })
  await waitForDobiusRuntimeReady()
}

export async function stopDobiusRuntime(): Promise<void> {
  const processToStop = dobiusServeProcess
  if (!processToStop?.pid) {
    return
  }
  dobiusServeProcess = null
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'])
    } catch {
      // The foreground test runtime may already have exited.
    }
    return
  }
  processToStop.kill()
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
}

async function getComputerE2eDobiusDevUserDataPath(): Promise<string> {
  if (!dobiusDevUserDataPath) {
    // Why: the shared dobius-dev profile can keep an older runtime alive across
    // local test runs, making computer-use E2E exercise stale provider code.
    dobiusDevUserDataPath = await mkdtemp(join(tmpdir(), 'dobius-computer-runtime-'))
  }
  return dobiusDevUserDataPath
}

async function waitForDobiusRuntimeReady(): Promise<void> {
  const userDataPath = await getComputerE2eDobiusDevUserDataPath()
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE)
  const deadline = Date.now() + 15000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      await access(metadataPath)
      const status = parseJsonOutput<{
        result: { runtime: { reachable: boolean } }
      }>((await runDobiusCli(['status', '--json'], { retryMissingRuntimeMetadata: false })).stdout)
      if (status.result.runtime.reachable) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  const detail = [
    lastError instanceof Error ? `Last error: ${lastError.message}` : null,
    dobiusServeStdout.trim() ? `serve stdout: ${dobiusServeStdout.trim()}` : null,
    dobiusServeStderr.trim() ? `serve stderr: ${dobiusServeStderr.trim()}` : null
  ]
    .filter(Boolean)
    .join(' ')
  throw new Error(`Dobius runtime metadata was not ready at ${metadataPath}.${detail}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureDobiusRuntimeServed(): Promise<void> {
  if (!dobiusServeProcess || dobiusServeProcess.exitCode !== null) {
    const devCli = join(process.cwd(), 'config/scripts/dobius-dev.mjs')
    const env = {
      ...process.env,
      DOBIUS_DEV_USER_DATA_PATH: await getComputerE2eDobiusDevUserDataPath()
    }
    dobiusServeStdout = ''
    dobiusServeStderr = ''
    dobiusServeProcess = spawn(process.execPath, [devCli, 'serve', '--no-pairing', '--json'], {
      env,
      windowsHide: true
    })
    dobiusServeProcess.stdout?.on('data', (chunk) => {
      dobiusServeStdout += String(chunk)
    })
    dobiusServeProcess.stderr?.on('data', (chunk) => {
      dobiusServeStderr += String(chunk)
    })
    dobiusServeProcess.once('exit', () => {
      dobiusServeProcess = null
    })
    process.once('exit', () => {
      dobiusServeProcess?.kill()
    })
  }
  await waitForDobiusRuntimeReady()
}

function isMissingRuntimeMetadataError(args: string[], error: unknown): boolean {
  if (args[0] !== 'computer') {
    return false
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message)
  return (
    message.includes('"code": "runtime_unavailable"') &&
    message.includes('Could not read Dobius runtime metadata')
  )
}
