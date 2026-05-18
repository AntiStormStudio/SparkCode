import type { LocalCommandCall, LocalCommandResult } from '../../types/command.js'
import {
  getOpenTerminalServerInfo,
  getSavedOpenTerminalConfig,
  startOpenTerminalServer,
  stopOpenTerminalServer,
  type OpenTerminalServerInfo,
} from '../../services/openTerminal/openTerminalServer.js'

type ParsedArgs = {
  action: 'start' | 'status' | 'stop' | 'restart' | 'reset-key'
  port?: number
  host?: string
  cwd?: string
}

const HELP = `用法：/openterminal [status|stop|restart|reset-key] [--port 8000] [--cwd 路径]

默认会启动一个本机 OpenTerminal 兼容服务，供 Spark-EDU 网页端添加为 Open Terminal 连接。`

function tokenize(value: string): string[] {
  const tokens = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return tokens.map(token => token.replace(/^(['"])(.*)\1$/, '$2'))
}

function parseArgs(args: string): ParsedArgs {
  const tokens = tokenize(args)
  const parsed: ParsedArgs = { action: 'start' }
  let index = 0

  const first = tokens[0]
  if (
    first === 'start' ||
    first === 'status' ||
    first === 'stop' ||
    first === 'restart' ||
    first === 'reset-key'
  ) {
    parsed.action = first
    index = 1
  } else if (first && /^\d+$/.test(first)) {
    parsed.port = Number(first)
    index = 1
  }

  while (index < tokens.length) {
    const token = tokens[index]
    const next = tokens[index + 1]
    if (token === '--port' || token === '-p') {
      parsed.port = Number(next)
      index += 2
      continue
    }
    if (token === '--host') {
      parsed.host = next
      index += 2
      continue
    }
    if (token === '--cwd') {
      parsed.cwd = next
      index += 2
      continue
    }
    if (token === '--help' || token === '-h') {
      throw new Error(HELP)
    }
    index += 1
  }

  if (parsed.port !== undefined && (!Number.isFinite(parsed.port) || parsed.port <= 0)) {
    throw new Error('端口无效')
  }
  return parsed
}

function formatConnection(info: OpenTerminalServerInfo, prefix: string): string {
  return `${prefix}

Spark-EDU 添加 Open Terminal 连接时填写：
名称：Spark Code
URL：${info.url}
openapi.json：/openapi.json
鉴权：Bearer
API Key：${info.apiKey}

当前工作目录：${info.cwd}`
}

export const call: LocalCommandCall = async (
  args,
): Promise<LocalCommandResult> => {
  try {
    const parsed = parseArgs(args)

    if (parsed.action === 'status') {
      const running = getOpenTerminalServerInfo()
      if (running) {
        return {
          type: 'text',
          value: formatConnection(running, 'OpenTerminal 已运行。'),
        }
      }
      const saved = await getSavedOpenTerminalConfig()
      return {
        type: 'text',
        value: saved.apiKey
          ? `OpenTerminal 未运行。已保存端口：${saved.port ?? 8000}`
          : 'OpenTerminal 未运行。',
      }
    }

    if (parsed.action === 'stop') {
      const stopped = await stopOpenTerminalServer()
      return {
        type: 'text',
        value: stopped ? 'OpenTerminal 已停止。' : 'OpenTerminal 当前没有运行。',
      }
    }

    if (parsed.action === 'restart') {
      await stopOpenTerminalServer()
      const info = await startOpenTerminalServer({
        port: parsed.port,
        host: parsed.host,
        cwd: parsed.cwd,
      })
      return {
        type: 'text',
        value: formatConnection(info, 'OpenTerminal 已重启。'),
      }
    }

    if (parsed.action === 'reset-key') {
      await stopOpenTerminalServer()
      const info = await startOpenTerminalServer({
        port: parsed.port,
        host: parsed.host,
        cwd: parsed.cwd,
        rotateKey: true,
      })
      return {
        type: 'text',
        value: formatConnection(info, 'OpenTerminal 已启动，并已重置 API Key。'),
      }
    }

    const existing = getOpenTerminalServerInfo()
    if (existing) {
      return {
        type: 'text',
        value: formatConnection(existing, 'OpenTerminal 已经在运行。'),
      }
    }

    const info = await startOpenTerminalServer({
      port: parsed.port,
      host: parsed.host,
      cwd: parsed.cwd,
    })
    return {
      type: 'text',
      value: formatConnection(info, 'OpenTerminal 已启动。'),
    }
  } catch (error) {
    return {
      type: 'text',
      value: error instanceof Error ? error.message : 'OpenTerminal 操作失败',
    }
  }
}
