import type { ServerConfig } from './types.js'

export function printBanner(
  config: ServerConfig,
  authToken: string,
  actualPort: number,
): void {
  const httpUrl = config.unix
    ? `unix:${config.unix}`
    : `http://${config.host}:${actualPort}`

  process.stderr.write(`Spark Code session server: ${httpUrl}\n`)
  process.stderr.write(`Auth token: ${authToken}\n`)
}
