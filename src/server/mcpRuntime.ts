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

export async function loadServerMcpRuntime(): Promise<ServerMcpRuntime> {
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []
  const commands: Command[] = []
  const resources: Record<string, ServerResource[]> = {}

  await getMcpToolsCommandsAndResources(result => {
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

  return {
    clients,
    tools: dedupeByName(tools),
    commands: dedupeByName(commands),
    resources,
  }
}
