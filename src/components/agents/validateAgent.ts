import type { Tools } from '../../Tool.js'
import { resolveAgentTools } from '../../tools/AgentTool/agentToolUtils.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getAgentSourceDisplayName } from './utils.js'

export type AgentValidationResult = {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

export function validateAgentType(agentType: string): string | null {
  if (!agentType) {
    return 'Agent 类型不能为空'
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(agentType)) {
    return 'Agent 类型必须以字母或数字开头和结尾，并且只能包含字母、数字和连字符'
  }

  if (agentType.length < 3) {
    return 'Agent 类型长度至少为 3 个字符'
  }

  if (agentType.length > 50) {
    return 'Agent 类型长度不能超过 50 个字符'
  }

  return null
}

export function validateAgent(
  agent: Omit<CustomAgentDefinition, 'location'>,
  availableTools: Tools,
  existingAgents: AgentDefinition[],
): AgentValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Validate agent type
  if (!agent.agentType) {
    errors.push('Agent 类型不能为空')
  } else {
    const typeError = validateAgentType(agent.agentType)
    if (typeError) {
      errors.push(typeError)
    }

    // Check for duplicates (excluding self for editing)
    const duplicate = existingAgents.find(
      a => a.agentType === agent.agentType && a.source !== agent.source,
    )
    if (duplicate) {
      errors.push(
        `Agent 类型“${agent.agentType}”已存在于 ${getAgentSourceDisplayName(duplicate.source)}`,
      )
    }
  }

  // Validate description
  if (!agent.whenToUse) {
    errors.push('说明（description）不能为空')
  } else if (agent.whenToUse.length < 10) {
    warnings.push(
      '说明建议更具体一些（至少 10 个字符）',
    )
  } else if (agent.whenToUse.length > 5000) {
    warnings.push('说明过长（超过 5000 个字符）')
  }

  // Validate tools
  if (agent.tools !== undefined && !Array.isArray(agent.tools)) {
    errors.push('工具配置必须是数组')
  } else {
    if (agent.tools === undefined) {
      warnings.push('该 Agent 将可访问全部工具')
    } else if (agent.tools.length === 0) {
      warnings.push(
        '未选择工具，Agent 能力会非常受限',
      )
    }

    // Check for invalid tools
    const resolvedTools = resolveAgentTools(agent, availableTools, false)

    if (resolvedTools.invalidTools.length > 0) {
      errors.push(`无效工具：${resolvedTools.invalidTools.join(', ')}`)
    }
  }

  // Validate system prompt
  const systemPrompt = agent.getSystemPrompt()
  if (!systemPrompt) {
    errors.push('系统提示词不能为空')
  } else if (systemPrompt.length < 20) {
    errors.push('系统提示词过短（至少 20 个字符）')
  } else if (systemPrompt.length > 10000) {
    warnings.push('系统提示词过长（超过 10,000 个字符）')
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  }
}
