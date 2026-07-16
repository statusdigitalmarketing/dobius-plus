import { DaemonServer, type DaemonServerOptions } from './daemon-server'

export type DaemonStartOptions = {
  socketPath: string
  tokenPath: string
  historyPath?: string
  spawnSubprocess: DaemonServerOptions['spawnSubprocess']
}

export type DaemonHandle = {
  shutdown(opts?: { markSessionsEnded?: boolean }): Promise<void>
}

export async function startDaemon(opts: DaemonStartOptions): Promise<DaemonHandle> {
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    tokenPath: opts.tokenPath,
    historyPath: opts.historyPath,
    spawnSubprocess: opts.spawnSubprocess
  })

  await server.start()

  return {
    shutdown: (opts) => server.shutdown(opts)
  }
}
