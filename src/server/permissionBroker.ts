import { randomUUID } from 'crypto'

export type GuiPermissionDecision = 'allow_once' | 'allow_session' | 'deny'

export type GuiPermissionRequest = {
  id: string
  session_id: string
  tool_use_id: string
  tool_name: string
  message: string
  description: string
  input: unknown
  suggestions: unknown[]
  blocked_path: string | null
  created_at: number
}

export type GuiPermissionResponse = {
  decision: GuiPermissionDecision
}

type PendingPermission = {
  request: GuiPermissionRequest
  resolve: (response: GuiPermissionResponse) => void
  timeout: ReturnType<typeof setTimeout>
}

const pendingPermissions = new Map<string, PendingPermission>()

export function listPendingPermissions(sessionId?: string): GuiPermissionRequest[] {
  return Array.from(pendingPermissions.values())
    .map(item => item.request)
    .filter(request => !sessionId || request.session_id === sessionId)
}

export function requestGuiPermission(input: {
  sessionId: string
  toolUseId: string
  toolName: string
  message: string
  description: string
  toolInput: unknown
  suggestions?: unknown[]
  blockedPath?: string
  onRequest?: (request: GuiPermissionRequest) => void
  timeoutMs?: number
}): Promise<GuiPermissionResponse> {
  const request: GuiPermissionRequest = {
    id: randomUUID(),
    session_id: input.sessionId,
    tool_use_id: input.toolUseId,
    tool_name: input.toolName,
    message: input.message,
    description: input.description,
    input: input.toolInput,
    suggestions: input.suggestions ?? [],
    blocked_path: input.blockedPath ?? null,
    created_at: Date.now(),
  }

  return new Promise(resolve => {
    const finish = (response: GuiPermissionResponse) => {
      const pending = pendingPermissions.get(request.id)
      if (pending) {
        clearTimeout(pending.timeout)
        pendingPermissions.delete(request.id)
      }
      resolve(response)
    }

    const timeout = setTimeout(() => {
      finish({ decision: 'deny' })
    }, input.timeoutMs ?? 120_000)

    pendingPermissions.set(request.id, {
      request,
      resolve: finish,
      timeout,
    })
    input.onRequest?.(request)
  })
}

export function respondToPermissionRequest(
  requestId: string,
  response: GuiPermissionResponse,
): boolean {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return false
  pending.resolve(response)
  return true
}
