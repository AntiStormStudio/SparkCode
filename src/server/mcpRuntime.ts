import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import type { Tool } from '../Tool.js'
import type { Command } from '../types/command.js'

export type ServerMcpRuntime = {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
}

export function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = item.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function mcpRuntimeSnapshot(input: {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
}): ServerMcpRuntime {
  return {
    clients: [...input.clients],
    tools: dedupeByName(input.tools),
    commands: dedupeByName(input.commands),
    resources: { ...input.resources },
  }
}

export async function loadServerMcpRuntime(options: { timeoutMs?: number } = {}): Promise<ServerMcpRuntime> {
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []
  const commands: Command[] = []
  const resources: Record<string, ServerResource[]> = {}

  const load = getMcpToolsCommandsAndResources(result => {
    const existingIndex = clients.findIndex(client => client.name === result.client.name)
    if (existingIndex >= 0) {
      clients[existingIndex] = result.client
    } else {
      clients.push(result.client)
    }
    tools.push(...result.tools)
    commands.push(...result.commands)
    if (result.resources?.length) {
      resources[result.client.name] = result.resources
    }
  })

  if (!options.timeoutMs || options.timeoutMs <= 0) {
    await load
    return mcpRuntimeSnapshot({ clients, tools, commands, resources })
  }

  return await Promise.race([
    load.then(() => mcpRuntimeSnapshot({ clients, tools, commands, resources })),
    new Promise<ServerMcpRuntime>(resolve => {
      setTimeout(() => {
        resolve(mcpRuntimeSnapshot({ clients, tools, commands, resources }))
      }, options.timeoutMs)
    }),
  ])
}
