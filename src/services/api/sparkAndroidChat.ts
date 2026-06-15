import { randomUUID } from 'crypto'
import {
  clearConfiguredAndroidAuth,
  getConfiguredApiBaseUrl,
  getConfiguredAuthToken,
  getConfiguredAuthRefreshToken,
  normalizeApiBaseUrl,
} from '../../utils/auth.js'
import { getUserAgent } from '../../utils/http.js'
import { refreshConfiguredAndroidToken } from '../../utils/sparkAndroidAuth.js'

const ANDROID_CHAT_COMPLETIONS_PATH = '/api/v1/android/chat/completions'
const ANDROID_AUTH_EXPIRED_MESSAGE =
  '登录已过期或令牌无效，请运行 /login 重新登录'

type JsonObject = Record<string, unknown>

type OpenAIMessage = {
  role: string
  content?: unknown
  reasoning_content?: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

type OpenAIToolCall = {
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url)
    return new URL(String(input))
  } catch {
    return null
  }
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (
    init?.method ??
    (input instanceof Request ? input.method : undefined) ??
    'GET'
  ).toUpperCase()
}

function isMessagesRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = getRequestUrl(input)
  if (!url) return false
  if (getRequestMethod(input, init) !== 'POST') return false
  return /\/v1\/messages\/?$/.test(url.pathname)
}

function isCountTokensRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  const url = getRequestUrl(input)
  if (!url) return false
  if (getRequestMethod(input, init) !== 'POST') return false
  return /\/v1\/messages\/count_tokens\/?$/.test(url.pathname)
}

async function readJsonBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<JsonObject> {
  const body = init?.body
  if (typeof body === 'string') {
    const parsed = JSON.parse(body)
    return isRecord(parsed) ? parsed : {}
  }

  if (body instanceof Uint8Array) {
    const parsed = JSON.parse(new TextDecoder().decode(body))
    return isRecord(parsed) ? parsed : {}
  }

  if (body) {
    const parsed = await new Response(body).json()
    return isRecord(parsed) ? parsed : {}
  }

  if (input instanceof Request) {
    const parsed = await input.clone().json()
    return isRecord(parsed) ? parsed : {}
  }

  return {}
}

function textFromAnthropicContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)

  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text') {
      const text = getString(block.text)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n')
}

function convertAnthropicContentToOpenAI(
  role: string,
  content: unknown,
): OpenAIMessage[] {
  if (typeof content === 'string') return [{ role, content }]
  if (!Array.isArray(content)) {
    return [{ role, content: content == null ? '' : String(content) }]
  }

  const textParts: string[] = []
  const reasoningParts: string[] = []
  const multimodalParts: JsonObject[] = []
  const toolCalls: OpenAIToolCall[] = []
  const toolMessages: OpenAIMessage[] = []

  for (const block of content) {
    if (!isRecord(block)) continue

    if (block.type === 'text') {
      const text = getString(block.text)
      if (text) {
        textParts.push(text)
        multimodalParts.push({ type: 'text', text })
      }
      continue
    }

    if (block.type === 'thinking') {
      const thinking = getString(block.thinking) ?? getString(block.reasoning_content)
      if (thinking) reasoningParts.push(thinking)
      continue
    }

    if (block.type === 'image' && isRecord(block.source)) {
      const mediaType = getString(block.source.media_type) ?? 'image/png'
      const data = getString(block.source.data)
      const url = getString(block.source.url)
      if (block.source.type === 'base64' && data) {
        multimodalParts.push({
          type: 'image_url',
          image_url: { url: `data:${mediaType};base64,${data}` },
        })
      } else if (block.source.type === 'url' && url) {
        multimodalParts.push({ type: 'image_url', image_url: { url } })
      }
      continue
    }

    if (block.type === 'tool_use') {
      toolCalls.push({
        id: getString(block.id) ?? `toolu_${randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: {
          name: getString(block.name) ?? '',
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        },
      })
      continue
    }

    if (block.type === 'tool_result') {
      toolMessages.push({
        role: 'tool',
        tool_call_id: getString(block.tool_use_id) ?? '',
        content: textFromAnthropicContent(block.content),
      })
    }
  }

  const messages: OpenAIMessage[] = []
  const reasoningContent = role === 'assistant' && reasoningParts.length > 0
    ? reasoningParts.join('\n')
    : undefined
  if (toolCalls.length > 0) {
    messages.push({
      role,
      content: textParts.join('\n'),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: toolCalls,
    })
  } else if (multimodalParts.length > 0) {
    const onlyText = multimodalParts.every(part => part.type === 'text')
    messages.push({
      role,
      content: onlyText ? textParts.join('\n') : multimodalParts,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    })
  } else if (reasoningContent) {
    messages.push({
      role,
      content: '',
      reasoning_content: reasoningContent,
    })
  }

  messages.push(...toolMessages)
  return messages.length > 0 ? messages : [{ role, content: '' }]
}

function convertAnthropicToOpenAI(payload: JsonObject): JsonObject {
  const messages: OpenAIMessage[] = []
  const system = payload.system

  if (typeof system === 'string' && system.trim()) {
    messages.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const systemText = textFromAnthropicContent(system)
    if (systemText) messages.push({ role: 'system', content: systemText })
  }

  const rawMessages = Array.isArray(payload.messages) ? payload.messages : []
  for (const message of rawMessages) {
    if (!isRecord(message)) continue
    const role = getString(message.role) ?? 'user'
    messages.push(...convertAnthropicContentToOpenAI(role, message.content))
  }

  const nextPayload: JsonObject = {
    model: getString(payload.model) ?? '',
    messages,
    stream: false,
  }

  if (typeof payload.max_tokens === 'number') {
    nextPayload.max_tokens = payload.max_tokens
  }
  if (typeof payload.temperature === 'number') {
    nextPayload.temperature = payload.temperature
  }
  if (typeof payload.top_p === 'number') {
    nextPayload.top_p = payload.top_p
  }
  if (Array.isArray(payload.stop_sequences)) {
    nextPayload.stop = payload.stop_sequences
  }

  if (Array.isArray(payload.tools)) {
    nextPayload.tools = payload.tools
      .filter(isRecord)
      .map(tool => ({
        type: 'function',
        function: {
          name: getString(tool.name) ?? '',
          description: getString(tool.description) ?? '',
          parameters: isRecord(tool.input_schema) ? tool.input_schema : {},
        },
      }))
  }

  if (isRecord(payload.tool_choice)) {
    const type = getString(payload.tool_choice.type) ?? 'auto'
    if (type === 'auto') {
      nextPayload.tool_choice = 'auto'
    } else if (type === 'any') {
      nextPayload.tool_choice = 'required'
    } else if (type === 'tool') {
      nextPayload.tool_choice = {
        type: 'function',
        function: { name: getString(payload.tool_choice.name) ?? '' },
      }
    }
  }

  return nextPayload
}

function mapStopReason(finishReason: unknown): string {
  switch (finishReason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

function sse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function openAIResponseToAnthropicSSE(
  response: JsonObject,
  requestedModel: string,
): string {
  const choice = Array.isArray(response.choices) && isRecord(response.choices[0])
    ? response.choices[0]
    : {}
  const message = isRecord(choice.message) ? choice.message : {}
  const usage = isRecord(response.usage) ? response.usage : {}
  const inputTokens =
    typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const outputTokens =
    typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const messageId = getString(response.id) ?? `msg_${randomUUID().replaceAll('-', '')}`
  const model = requestedModel || getString(response.model) || ''
  let index = 0
  let output = ''

  output += sse('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })

  const content = getString(message.content)
  const reasoningContent =
    getString(message.reasoning_content) ??
    getString(message.reasoning) ??
    getString(message.reasoningContent)
  if (reasoningContent) {
    output += sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
    output += sse('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: reasoningContent },
    })
    output += sse('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'signature_delta', signature: '' },
    })
    output += sse('content_block_stop', {
      type: 'content_block_stop',
      index,
    })
    index += 1
  }

  if (content) {
    output += sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
    output += sse('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: content },
    })
    output += sse('content_block_stop', {
      type: 'content_block_stop',
      index,
    })
    index += 1
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const rawToolCall of toolCalls) {
    if (!isRecord(rawToolCall)) continue
    const toolCall = rawToolCall as OpenAIToolCall
    const args = toolCall.function?.arguments ?? '{}'
    output += sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: toolCall.id ?? `toolu_${randomUUID().replaceAll('-', '')}`,
        name: toolCall.function?.name ?? '',
        input: {},
      },
    })
    if (args) {
      output += sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: args },
      })
    }
    output += sse('content_block_stop', {
      type: 'content_block_stop',
      index,
    })
    index += 1
  }

  output += sse('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: mapStopReason(choice.finish_reason),
      stop_sequence: null,
    },
    usage: { output_tokens: outputTokens },
  })
  output += sse('message_stop', { type: 'message_stop' })
  return output
}

function errorResponse(message: string, status = 502): Response {
  return new Response(
    JSON.stringify({
      error: { type: 'api_error', message },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

function estimateTokens(payload: JsonObject): number {
  return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4))
}

async function postAndroidChatCompletion(
  baseUrl: string,
  authToken: string,
  openAIPayload: JsonObject,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return fetch(`${baseUrl}${ANDROID_CHAT_COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
    },
    body: JSON.stringify(openAIPayload),
    signal,
  })
}

export async function maybeHandleSparkAndroidChatFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response | null> {
  if (!isMessagesRequest(input, init) && !isCountTokensRequest(input, init)) {
    return null
  }

  const configuredBaseUrl = getConfiguredApiBaseUrl()
  if (!configuredBaseUrl) return null

  const baseUrl = normalizeApiBaseUrl(configuredBaseUrl)
  let authToken = getConfiguredAuthToken()
  const hadAndroidAuth = !!authToken || !!getConfiguredAuthRefreshToken()

  const payload = await readJsonBody(input, init)

  if (isCountTokensRequest(input, init)) {
    return new Response(JSON.stringify({ input_tokens: estimateTokens(payload) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'request-id': `spark-count-${randomUUID()}`,
      },
    })
  }

  if (!authToken) {
    authToken = await refreshConfiguredAndroidToken(baseUrl)
    if (!authToken) {
      return hadAndroidAuth ? errorResponse(ANDROID_AUTH_EXPIRED_MESSAGE, 401) : null
    }
  }

  const openAIPayload = convertAnthropicToOpenAI(payload)
  const requestedModel = getString(payload.model) ?? ''
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)

  let response = await postAndroidChatCompletion(
    baseUrl,
    authToken,
    openAIPayload,
    signal,
  )

  if (response.status === 401) {
    const nextAuthToken = await refreshConfiguredAndroidToken(baseUrl)
    if (nextAuthToken) {
      response = await postAndroidChatCompletion(
        baseUrl,
        nextAuthToken,
        openAIPayload,
        signal,
      )
    }
    if (!nextAuthToken || response.status === 401) {
      clearConfiguredAndroidAuth()
      return errorResponse(ANDROID_AUTH_EXPIRED_MESSAGE, 401)
    }
  }

  if (!response.ok) {
    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  const data = await response.json()
  if (!isRecord(data)) {
    return errorResponse('后端聊天接口返回格式无效')
  }

  return new Response(openAIResponseToAnthropicSSE(data, requestedModel), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'request-id': response.headers.get('request-id') ?? `spark-${randomUUID()}`,
    },
  })
}
