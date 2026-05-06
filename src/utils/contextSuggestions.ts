import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import type { ContextData } from './analyzeContext.js'
import { getDisplayPath } from './file.js'
import { formatTokens } from './format.js'

// --

export type SuggestionSeverity = 'info' | 'warning'

export type ContextSuggestion = {
  severity: SuggestionSeverity
  title: string
  detail: string
  /** Estimated tokens that could be saved */
  savingsTokens?: number
}

// Thresholds for triggering suggestions
const LARGE_TOOL_RESULT_PERCENT = 15 // tool results > 15% of context
const LARGE_TOOL_RESULT_TOKENS = 10_000
const READ_BLOAT_PERCENT = 5 // Read results > 5% of context
const NEAR_CAPACITY_PERCENT = 80
const MEMORY_HIGH_PERCENT = 5
const MEMORY_HIGH_TOKENS = 5_000

// --

export function generateContextSuggestions(
  data: ContextData,
): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = []

  checkNearCapacity(data, suggestions)
  checkLargeToolResults(data, suggestions)
  checkReadResultBloat(data, suggestions)
  checkMemoryBloat(data, suggestions)
  checkAutoCompactDisabled(data, suggestions)

  // Sort: warnings first, then by savings descending
  suggestions.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'warning' ? -1 : 1
    }
    return (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0)
  })

  return suggestions
}

// --

function checkNearCapacity(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (data.percentage >= NEAR_CAPACITY_PERCENT) {
    suggestions.push({
      severity: 'warning',
      title: `上下文已使用 ${data.percentage}%`,
      detail: data.isAutoCompactEnabled
        ? '自动压缩即将触发，较早的消息会被丢弃。现在运行 /compact 可以控制保留内容。'
        : '自动压缩已关闭。可以用 /compact 释放空间，或在 /config 中开启自动压缩。',
    })
  }
}

function checkLargeToolResults(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (!data.messageBreakdown) return

  for (const tool of data.messageBreakdown.toolCallsByType) {
    const totalToolTokens = tool.callTokens + tool.resultTokens
    const percent = (totalToolTokens / data.rawMaxTokens) * 100

    if (
      percent < LARGE_TOOL_RESULT_PERCENT ||
      totalToolTokens < LARGE_TOOL_RESULT_TOKENS
    ) {
      continue
    }

    const suggestion = getLargeToolSuggestion(
      tool.name,
      totalToolTokens,
      percent,
    )
    if (suggestion) {
      suggestions.push(suggestion)
    }
  }
}

function getLargeToolSuggestion(
  toolName: string,
  tokens: number,
  percent: number,
): ContextSuggestion | null {
  const tokenStr = formatTokens(tokens)

  switch (toolName) {
    case BASH_TOOL_NAME:
      return {
        severity: 'warning',
        title: `Bash 结果占用 ${tokenStr} token（${percent.toFixed(0)}%）`,
        detail:
          '可以把输出通过 head、tail 或 grep 过滤后再查看。大文件不要直接 cat，改用 Read 的 offset/limit。',
        savingsTokens: Math.floor(tokens * 0.5),
      }
    case FILE_READ_TOOL_NAME:
      return {
        severity: 'info',
        title: `Read 结果占用 ${tokenStr} token（${percent.toFixed(0)}%）`,
        detail:
          '使用 offset 和 limit 只读取需要的部分。只看几行时不要重复读取整文件。',
        savingsTokens: Math.floor(tokens * 0.3),
      }
    case GREP_TOOL_NAME:
      return {
        severity: 'info',
        title: `Grep 结果占用 ${tokenStr} token（${percent.toFixed(0)}%）`,
        detail:
          '把模式写得更具体，或者用 glob / type 参数缩小文件范围。找文件时优先考虑 Glob，不要只依赖 Grep。',
        savingsTokens: Math.floor(tokens * 0.3),
      }
    case WEB_FETCH_TOOL_NAME:
      return {
        severity: 'info',
        title: `WebFetch 结果占用 ${tokenStr} token（${percent.toFixed(0)}%）`,
        detail:
          '网页内容可能很大，尽量只提取需要的具体信息。',
        savingsTokens: Math.floor(tokens * 0.4),
      }
    default:
      if (percent >= 20) {
        return {
          severity: 'info',
          title: `${toolName} 占用 ${tokenStr} token（${percent.toFixed(0)}%）`,
          detail: `这个工具正在消耗相当一部分上下文。`,
          savingsTokens: Math.floor(tokens * 0.2),
        }
      }
      return null
  }
}

function checkReadResultBloat(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (!data.messageBreakdown) return

  const callsByType = data.messageBreakdown.toolCallsByType
  const readTool = callsByType.find(t => t.name === FILE_READ_TOOL_NAME)
  if (!readTool) return

  const totalReadTokens = readTool.callTokens + readTool.resultTokens
  const totalReadPercent = (totalReadTokens / data.rawMaxTokens) * 100
  const readPercent = (readTool.resultTokens / data.rawMaxTokens) * 100

  // Skip if already covered by checkLargeToolResults (>= 15% band)
  if (
    totalReadPercent >= LARGE_TOOL_RESULT_PERCENT &&
    totalReadTokens >= LARGE_TOOL_RESULT_TOKENS
  ) {
    return
  }

  if (
    readPercent >= READ_BLOAT_PERCENT &&
    readTool.resultTokens >= LARGE_TOOL_RESULT_TOKENS
  ) {
    suggestions.push({
      severity: 'info',
      title: `文件读取占用 ${formatTokens(readTool.resultTokens)} token（${readPercent.toFixed(0)}%）`,
      detail:
        '如果你在重复读取文件，尽量引用前面的结果。大文件继续用 offset/limit。',
      savingsTokens: Math.floor(readTool.resultTokens * 0.3),
    })
  }
}

function checkMemoryBloat(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  const totalMemoryTokens = data.memoryFiles.reduce(
    (sum, f) => sum + f.tokens,
    0,
  )
  const memoryPercent = (totalMemoryTokens / data.rawMaxTokens) * 100

  if (
    memoryPercent >= MEMORY_HIGH_PERCENT &&
    totalMemoryTokens >= MEMORY_HIGH_TOKENS
  ) {
    const largestFiles = [...data.memoryFiles]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map(f => {
        const name = getDisplayPath(f.path)
        return `${name} (${formatTokens(f.tokens)})`
      })
      .join(', ')

    suggestions.push({
      severity: 'info',
      title: `Memory 文件占用 ${formatTokens(totalMemoryTokens)} token（${memoryPercent.toFixed(0)}%）`,
      detail: `占用最多的是：${largestFiles}。可以用 /memory 查看并清理过期内容。`,
      savingsTokens: Math.floor(totalMemoryTokens * 0.3),
    })
  }
}

function checkAutoCompactDisabled(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (
    !data.isAutoCompactEnabled &&
    data.percentage >= 50 &&
    data.percentage < NEAR_CAPACITY_PERCENT
  ) {
    suggestions.push({
      severity: 'info',
      title: '自动压缩已关闭',
      detail:
        '不启用自动压缩时，很容易碰到上下文上限并丢失对话。可以在 /config 中开启，或手动运行 /compact。',
    })
  }
}
