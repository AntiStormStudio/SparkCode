import pkg from '../../package.json'
import { randomBytes } from 'crypto'
import { startServer } from './server.js'
import { SessionManager } from './sessionManager.js'
import {
  initializeServerRegistries,
  ServerQueryBackend,
} from './backends/queryBackend.js'
import { printBanner } from './serverBanner.js'
import { createServerLogger } from './serverLog.js'
import { enableConfigs } from '../utils/config.js'
import {
  probeRunningServer,
  removeServerLock,
  writeServerLock,
} from './lockfile.js'
import { installExitDiagnostics } from '../utils/exitDiagnostics.js'

installExitDiagnostics()

type MacroConfig = {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  VERSION_CHANGELOG: string
  ISSUES_EXPLAINER: string
  FEEDBACK_CHANNEL: string
}

const defaultMacro: MacroConfig = {
  VERSION: pkg.version,
  BUILD_TIME: '',
  PACKAGE_URL: pkg.name,
  NATIVE_PACKAGE_URL: pkg.name,
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: '请在你的 SPARK-Code 仓库里提交 issue',
  FEEDBACK_CHANNEL: 'github',
}

if (!('MACRO' in globalThis)) {
  ;(globalThis as typeof globalThis & { MACRO: MacroConfig }).MACRO =
    defaultMacro
}

type ServerArgs = {
  port: string
  host: string
  authToken?: string
  unix?: string
  workspace?: string
  idleTimeout: string
  maxSessions: string
}

function parseArgs(argv: string[]): ServerArgs {
  const args = argv[0] === 'server' ? argv.slice(1) : argv
  const result: ServerArgs = {
    port: '0',
    host: '0.0.0.0',
    idleTimeout: '600000',
    maxSessions: '32',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    const readValue = () => {
      if (!next) throw new Error(`缺少参数值：${arg}`)
      i++
      return next
    }

    if (arg === '--port') result.port = readValue()
    else if (arg?.startsWith('--port=')) result.port = arg.slice(7)
    else if (arg === '--host') result.host = readValue()
    else if (arg?.startsWith('--host=')) result.host = arg.slice(7)
    else if (arg === '--auth-token') result.authToken = readValue()
    else if (arg?.startsWith('--auth-token=')) result.authToken = arg.slice(13)
    else if (arg === '--unix') result.unix = readValue()
    else if (arg?.startsWith('--unix=')) result.unix = arg.slice(7)
    else if (arg === '--workspace') result.workspace = readValue()
    else if (arg?.startsWith('--workspace=')) result.workspace = arg.slice(12)
    else if (arg === '--idle-timeout') result.idleTimeout = readValue()
    else if (arg?.startsWith('--idle-timeout=')) result.idleTimeout = arg.slice(15)
    else if (arg === '--max-sessions') result.maxSessions = readValue()
    else if (arg?.startsWith('--max-sessions=')) result.maxSessions = arg.slice(15)
    else if (arg !== '--no-orphans') throw new Error(`未知参数：${arg}`)
  }

  return result
}

async function main() {
  process.env.SPARK_CODE_BACKEND_ENTRY = 'server-entry'
  enableConfigs()
  initializeServerRegistries()

  const opts = parseArgs(process.argv.slice(2))
  const existing = await probeRunningServer()
  if (existing) {
    process.stderr.write(
      `已有 Spark Code 服务器正在运行（pid ${existing.pid}）：${existing.httpUrl}\n`,
    )
    process.exit(1)
  }

  const authToken =
    opts.authToken ?? `sk-ant-cc-${randomBytes(16).toString('base64url')}`
  const config = {
    port: parseInt(opts.port, 10),
    host: opts.host,
    authToken,
    unix: opts.unix,
    workspace: opts.workspace,
    idleTimeoutMs: parseInt(opts.idleTimeout, 10),
    maxSessions: parseInt(opts.maxSessions, 10),
  }
  const backend = new ServerQueryBackend()
  const sessionManager = new SessionManager(backend, {
    idleTimeoutMs: config.idleTimeoutMs,
    maxSessions: config.maxSessions,
  })
  const logger = createServerLogger()
  const server = startServer(config, sessionManager, logger)
  const actualPort = server.port ?? config.port

  printBanner(config, authToken, actualPort)
  await writeServerLock({
    pid: process.pid,
    port: actualPort,
    host: config.host,
    httpUrl: config.unix
      ? `unix:${config.unix}`
      : `http://${config.host}:${actualPort}`,
    startedAt: Date.now(),
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    server.stop(true)
    await sessionManager.destroyAll()
    await removeServerLock()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

await main()
