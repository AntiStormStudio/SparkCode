import {
  formatDescriptionWithSource,
  getCommandName,
  getCommands,
} from '../commands.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { call as runCostCommand } from '../commands/cost/cost.js'
import { call as runReleaseNotesCommand } from '../commands/release-notes/release-notes.js'
import { call as runOpenTerminalCommand } from '../commands/openterminal/openterminal.js'
import { call as runStickersCommand } from '../commands/stickers/stickers.js'
import { clearConfiguredAndroidAuth } from '../utils/auth.js'
import type { ServerConfig } from './types.js'
import type { ServerLogger } from './serverLog.js'
import type { SessionManager } from './sessionManager.js'
import { dedupeByName, loadServerMcpRuntime } from './mcpRuntime.js'
import {
  COMMAND_CATEGORY,
  GUI_HANDLED_COMMAND_NAMES,
  GUI_MODEL_OPTIONS,
  GUI_SLASH_COMMANDS,
  isHiddenFromGuiSlashList,
} from './slashCommandPolicy.js'

type ServerHandle = {
  port?: number
  stop: (force?: boolean) => void
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

function readBearer(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function isAuthorized(req: Request, config: ServerConfig): boolean {
  if (!config.authToken) return true
  return readBearer(req) === config.authToken
}

function wsUrl(req: Request, sessionId: string): string {
  const url = new URL(req.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/sessions/${sessionId}/ws`
  url.search = ''
  return url.toString()
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) return {}
  const value = await req.json().catch(() => ({}))
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return undefined
}

function promptTextFromValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'text' in item) {
          return typeof item.text === 'string' ? item.text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value && typeof value === 'object' && 'text' in value) {
    return typeof value.text === 'string' ? value.text : ''
  }
  return ''
}

async function slashCommands(cwd: string) {
  const mcpRuntime = await loadServerMcpRuntime().catch(() => ({
    clients: [],
    tools: [],
    commands: [],
    resources: {},
  }))
  const commands = dedupeByName([
    ...await getCommands(cwd),
    ...mcpRuntime.commands,
  ])
  const dynamicCommands = dedupeByName(commands
    .filter(command => command.userInvocable !== false)
    .filter(command => !command.isHidden)
    .filter(command => {
      const name = getCommandName(command)
      if (GUI_HANDLED_COMMAND_NAMES.has(name)) return true
      if (command.type === 'prompt') return command.disableNonInteractive !== true
      if (command.type === 'local') return command.supportsNonInteractive === true
      return false
    })
    .map(command => {
      const name = getCommandName(command)
      const source = 'source' in command ? command.source : 'builtin'
      const guiOverride = GUI_SLASH_COMMANDS.find(([commandName]) => commandName === name)
      return {
        name,
        description: guiOverride?.[2] ?? formatDescriptionWithSource(command),
        aliases: command.aliases ?? [],
        category: guiOverride?.[1] ?? COMMAND_CATEGORY[name] ?? (
          command.loadedFrom === 'skills' || command.loadedFrom === 'bundled'
            ? 'Skill'
            : command.loadedFrom === 'mcp' || source === 'mcp'
              ? 'MCP'
            : source === 'plugin'
              ? 'Plugin'
              : '其他'
        ),
        accepts_args: guiOverride?.[3] ?? Boolean(command.argumentHint || command.type === 'prompt'),
        type: command.type,
        source,
        loaded_from: command.loadedFrom,
        argument_hint: command.argumentHint ?? '',
      }
    })
    .filter(command => !isHiddenFromGuiSlashList(command))
    .sort((a, b) => a.name.localeCompare(b.name)))

  if (process.env.SPARK_CODE_BACKEND_LAUNCHED_BY === 'sparkcode-app') {
    const existing = new Set(dynamicCommands.map(command => command.name))
    const fallbackCommands = GUI_SLASH_COMMANDS
      .filter(([name]) => !existing.has(name))
      .map(([name, category, description, acceptsArgs]) => ({
        name,
        description,
        aliases: [],
        category,
        accepts_args: acceptsArgs,
      }))
    return dedupeByName([...dynamicCommands, ...fallbackCommands]).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  }

  return dynamicCommands
}

function modelOptions() {
  if (process.env.SPARK_CODE_BACKEND_LAUNCHED_BY === 'sparkcode-app') {
    return {
      options: GUI_MODEL_OPTIONS.map(([id, name, description]) => ({
        id,
        name,
        description,
      })),
    }
  }

  return {
    options: getModelOptions().map(option => ({
      id: option.value ?? 'default',
      name: option.label,
      description: option.description,
    })),
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

async function runLocalCommand(name: string, args: string) {
  const normalized = name.trim().toLowerCase()
  const result = await (
    normalized === 'cost'
      ? runCostCommand(args, {} as never)
      : normalized === 'release-notes'
        ? runReleaseNotesCommand()
        : normalized === 'openterminal' || normalized === 'open-terminal'
          ? runOpenTerminalCommand(args, {} as never)
          : normalized === 'stickers'
            ? runStickersCommand()
            : null
  )

  if (!result) {
    throw new Error(`不支持的本地命令：${name}`)
  }
  if (result.type === 'text') {
    return stripAnsi(result.value)
  }
  if (result.type === 'skip') {
    return '已完成'
  }
  return result.displayText ?? '已完成'
}

export function startServer(
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
): ServerHandle {
  const sockets = new Map<string, Set<ServerWebSocket<{ sessionId: string }>>>()

  const server = Bun.serve<{ sessionId: string }>({
    hostname: config.unix ? undefined : config.host,
    port: config.unix ? undefined : config.port,
    unix: config.unix,
    async fetch(req, bunServer) {
      const url = new URL(req.url)

      if (url.pathname === '/health' || url.pathname === '/status') {
        return json({ ok: true, version: '0.2.0' })
      }

      if (!isAuthorized(req, config)) {
        return json({ error: 'unauthorized' }, 401)
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/slash-commands') {
        try {
          const body = req.method === 'POST' ? await readJson(req) : {}
          return json(await slashCommands(
            stringValue(body.cwd) ||
              url.searchParams.get('cwd') ||
              config.workspace ||
              process.cwd(),
          ))
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/model-options') {
        try {
          return json(modelOptions())
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if (req.method === 'POST' && url.pathname === '/auth/clear') {
        clearConfiguredAndroidAuth()
        return json({ ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/local-command') {
        try {
          const body = await readJson(req)
          const content = await runLocalCommand(
            stringValue(body.name) ?? '',
            stringValue(body.args) ?? '',
          )
          return json({ content })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        try {
          const body = await readJson(req)
          const session = sessionManager.createSession({
            cwd: stringValue(body.cwd) ?? config.workspace,
            sessionKey: stringValue(body.session_key),
          })
          return json({
            session_id: session.id,
            ws_url: wsUrl(req, session.id),
            work_dir: session.workDir,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400)
        }
      }

      if (req.method === 'POST' && url.pathname === '/prompt') {
        try {
          const body = await readJson(req)
          const sessionId =
            stringValue(body.session_id) ?? stringValue(body.sessionId)
          const cwd = stringValue(body.cwd) ?? config.workspace
          const session = sessionId
            ? sessionManager.getSession(sessionId) ??
              sessionManager.restoreSession({
                sessionId,
                cwd,
                sessionKey: stringValue(body.session_key),
                hasStarted: booleanValue(body.resume) === true,
              })
            : sessionManager.createSession({
                cwd,
                sessionKey: stringValue(body.session_key),
              })
          const content = await sessionManager.runPrompt(
            session.id,
            stringValue(body.prompt) ?? '',
            stringValue(body.model),
            stringValue(body.permission_mode) ?? stringValue(body.permissionMode),
          )
          return json({
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      const promptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompt$/)
      if (req.method === 'POST' && promptMatch) {
        try {
          const body = await readJson(req)
          const sessionId = decodeURIComponent(promptMatch[1])
          if (!sessionManager.getSession(sessionId)) {
            sessionManager.restoreSession({
              sessionId,
              cwd: stringValue(body.cwd) ?? config.workspace,
              sessionKey: stringValue(body.session_key),
              hasStarted: booleanValue(body.resume) === true,
            })
          }
	          const content = await sessionManager.runPrompt(
	            sessionId,
	            stringValue(body.prompt) ?? '',
	            stringValue(body.model),
	            stringValue(body.permission_mode) ?? stringValue(body.permissionMode),
	          )
          return json({
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/)
      if (req.method === 'GET' && wsMatch) {
        const sessionId = decodeURIComponent(wsMatch[1])
        const upgraded = bunServer.upgrade(req, {
          data: { sessionId },
        })
        return upgraded
          ? undefined
          : json({ error: 'websocket upgrade failed' }, 400)
      }

      return json({ error: 'not found' }, 404)
    },
    websocket: {
      open(ws) {
        const bucket = sockets.get(ws.data.sessionId) ?? new Set()
        bucket.add(ws)
        sockets.set(ws.data.sessionId, bucket)
      },
      async message(ws, raw) {
	        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
	        let prompt = text
	        let model: string | undefined
        let cwd: string | undefined
        let permissionMode: string | undefined
	        try {
	          const parsed = JSON.parse(text)
	          prompt =
	            promptTextFromValue(parsed?.message?.content) ||
	            promptTextFromValue(parsed?.prompt) ||
	            text
	          model = stringValue(parsed?.model)
          cwd = stringValue(parsed?.cwd)
          permissionMode =
            stringValue(parsed?.permission_mode) ?? stringValue(parsed?.permissionMode)
	        } catch {
	          // Raw text messages are accepted.
	        }
	
	        try {
          if (!sessionManager.getSession(ws.data.sessionId)) {
            sessionManager.restoreSession({
              sessionId: ws.data.sessionId,
              cwd: cwd ?? config.workspace,
            })
          }
          const content = await sessionManager.runPrompt(
            ws.data.sessionId,
            String(prompt),
            model,
            permissionMode,
          )
          ws.send(JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: content }],
            },
          }))
          ws.send(JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: content,
          }))
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'result',
            subtype: 'error',
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      },
      close(ws) {
        const bucket = sockets.get(ws.data.sessionId)
        bucket?.delete(ws)
        if (bucket?.size === 0) {
          sockets.delete(ws.data.sessionId)
        }
      },
    },
  })

  logger.info(`listening on ${config.unix ?? `${config.host}:${server.port}`}`)

  return {
    port: server.port,
    stop(force?: boolean) {
      server.stop(force)
      sockets.clear()
    },
  }
}
