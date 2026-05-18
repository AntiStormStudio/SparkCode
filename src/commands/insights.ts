import { execFileSync } from 'child_process'
import { diffLines } from 'diff'
import { constants as fsConstants } from 'fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import type { Command } from '../commands.js'
import { queryWithModel } from '../services/api/claude.js'
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
} from '../tools/AgentTool/constants.js'
import type { LogOption } from '../types/logs.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { toError } from '../utils/errors.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { logError } from '../utils/log.js'
import { extractTextContent } from '../utils/messages.js'
import { getDefaultOpusModel } from '../utils/model/model.js'
import {
  getProjectsDir,
  getSessionFilesWithMtime,
  getSessionIdFromLog,
  loadAllLogsFromSessionFile,
} from '../utils/sessionStorage.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { countCharInString } from '../utils/stringUtils.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { escapeXmlAttr as escapeHtml } from '../utils/xml.js'

// Model for facet extraction and summarization (Opus - best quality)
function getAnalysisModel(): string {
  return getDefaultOpusModel()
}

// Model for narrative insights (Opus - best quality)
function getInsightsModel(): string {
  return getDefaultOpusModel()
}

// ============================================================================
// Homespace Data Collection
// ============================================================================

type RemoteHostInfo = {
  name: string
  sessionCount: number
}

/* eslint-disable custom-rules/no-process-env-top-level */
const getRunningRemoteHosts: () => Promise<string[]> =
  process.env.USER_TYPE === 'ant'
    ? async () => {
        const { stdout, code } = await execFileNoThrow(
          'coder',
          ['list', '-o', 'json'],
          { timeout: 30000 },
        )
        if (code !== 0) return []
        try {
          const workspaces = jsonParse(stdout) as Array<{
            name: string
            latest_build?: { status?: string }
          }>
          return workspaces
            .filter(w => w.latest_build?.status === 'running')
            .map(w => w.name)
        } catch {
          return []
        }
      }
    : async () => []

const getRemoteHostSessionCount: (hs: string) => Promise<number> =
  process.env.USER_TYPE === 'ant'
    ? async (homespace: string) => {
        const { stdout, code } = await execFileNoThrow(
          'ssh',
          [
            `${homespace}.coder`,
            'find /root/.claude/projects -name "*.jsonl" 2>/dev/null | wc -l',
          ],
          { timeout: 30000 },
        )
        if (code !== 0) return 0
        return parseInt(stdout.trim(), 10) || 0
      }
    : async () => 0

const collectFromRemoteHost: (
  hs: string,
  destDir: string,
) => Promise<{ copied: number; skipped: number }> =
  process.env.USER_TYPE === 'ant'
    ? async (homespace: string, destDir: string) => {
        const result = { copied: 0, skipped: 0 }

        // Create temp directory
        const tempDir = await mkdtemp(join(tmpdir(), 'claude-hs-'))

        try {
          // SCP the projects folder
          const scpResult = await execFileNoThrow(
            'scp',
            ['-rq', `${homespace}.coder:/root/.claude/projects/`, tempDir],
            { timeout: 300000 },
          )
          if (scpResult.code !== 0) {
            // SCP failed
            return result
          }

          const projectsDir = join(tempDir, 'projects')
          let projectDirents: Awaited<ReturnType<typeof readdir>>
          try {
            projectDirents = await readdir(projectsDir, { withFileTypes: true })
          } catch {
            return result
          }

          // Merge into destination (parallel per project directory)
          await Promise.all(
            projectDirents.map(async dirent => {
              const projectName = dirent.name
              const projectPath = join(projectsDir, projectName)

              // Skip if not a directory
              if (!dirent.isDirectory()) return

              const destProjectName = `${projectName}__${homespace}`
              const destProjectPath = join(destDir, destProjectName)

              try {
                await mkdir(destProjectPath, { recursive: true })
              } catch {
                // Directory may already exist
              }

              // Copy session files (skip existing)
              let files: Awaited<ReturnType<typeof readdir>>
              try {
                files = await readdir(projectPath, { withFileTypes: true })
              } catch {
                return
              }
              await Promise.all(
                files.map(async fileDirent => {
                  const fileName = fileDirent.name
                  if (!fileName.endsWith('.jsonl')) return

                  const srcFile = join(projectPath, fileName)
                  const destFile = join(destProjectPath, fileName)

                  try {
                    await copyFile(srcFile, destFile, fsConstants.COPYFILE_EXCL)
                    result.copied++
                  } catch {
                    // EEXIST from COPYFILE_EXCL means dest already exists
                    result.skipped++
                  }
                }),
              )
            }),
          )
        } finally {
          try {
            await rm(tempDir, { recursive: true, force: true })
          } catch {
            // Ignore cleanup errors
          }
        }

        return result
      }
    : async () => ({ copied: 0, skipped: 0 })

const collectAllRemoteHostData: (destDir: string) => Promise<{
  hosts: RemoteHostInfo[]
  totalCopied: number
  totalSkipped: number
}> =
  process.env.USER_TYPE === 'ant'
    ? async (destDir: string) => {
        const rHosts = await getRunningRemoteHosts()
        const result: RemoteHostInfo[] = []
        let totalCopied = 0
        let totalSkipped = 0

        // Collect from all hosts in parallel (SCP per host can take seconds)
        const hostResults = await Promise.all(
          rHosts.map(async hs => {
            const sessionCount = await getRemoteHostSessionCount(hs)
            if (sessionCount > 0) {
              const { copied, skipped } = await collectFromRemoteHost(
                hs,
                destDir,
              )
              return { name: hs, sessionCount, copied, skipped }
            }
            return { name: hs, sessionCount, copied: 0, skipped: 0 }
          }),
        )

        for (const hr of hostResults) {
          result.push({ name: hr.name, sessionCount: hr.sessionCount })
          totalCopied += hr.copied
          totalSkipped += hr.skipped
        }

        return { hosts: result, totalCopied, totalSkipped }
      }
    : async () => ({ hosts: [], totalCopied: 0, totalSkipped: 0 })
/* eslint-enable custom-rules/no-process-env-top-level */

// ============================================================================
// Types
// ============================================================================

type SessionMeta = {
  session_id: string
  project_path: string
  start_time: string
  duration_minutes: number
  user_message_count: number
  assistant_message_count: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  input_tokens: number
  output_tokens: number
  first_prompt: string
  summary?: string
  // New stats
  user_interruptions: number
  user_response_times: number[]
  tool_errors: number
  tool_error_categories: Record<string, number>
  uses_task_agent: boolean
  uses_mcp: boolean
  uses_web_search: boolean
  uses_web_fetch: boolean
  // Additional stats
  lines_added: number
  lines_removed: number
  files_modified: number
  message_hours: number[]
  user_message_timestamps: string[] // ISO timestamps for multi-clauding detection
}

type SessionFacets = {
  session_id: string
  underlying_goal: string
  goal_categories: Record<string, number>
  outcome: string
  user_satisfaction_counts: Record<string, number>
  claude_helpfulness: string
  session_type: string
  friction_counts: Record<string, number>
  friction_detail: string
  primary_success: string
  brief_summary: string
  user_instructions_to_claude?: string[]
}

type AggregatedData = {
  total_sessions: number
  total_sessions_scanned?: number
  sessions_with_facets: number
  date_range: { start: string; end: string }
  total_messages: number
  total_duration_hours: number
  total_input_tokens: number
  total_output_tokens: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  projects: Record<string, number>
  goal_categories: Record<string, number>
  outcomes: Record<string, number>
  satisfaction: Record<string, number>
  helpfulness: Record<string, number>
  session_types: Record<string, number>
  friction: Record<string, number>
  success: Record<string, number>
  session_summaries: Array<{
    id: string
    date: string
    summary: string
    goal?: string
  }>
  // New aggregated stats
  total_interruptions: number
  total_tool_errors: number
  tool_error_categories: Record<string, number>
  user_response_times: number[]
  median_response_time: number
  avg_response_time: number
  sessions_using_task_agent: number
  sessions_using_mcp: number
  sessions_using_web_search: number
  sessions_using_web_fetch: number
  // Additional stats from Python reference
  total_lines_added: number
  total_lines_removed: number
  total_files_modified: number
  days_active: number
  messages_per_day: number
  message_hours: number[] // Hour of day for each user message (for time of day chart)
  // Multi-clauding stats (matching Python reference)
  multi_clauding: {
    overlap_events: number
    sessions_involved: number
    user_messages_during: number
  }
}

// ============================================================================
// Constants
// ============================================================================

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.sh': 'Shell',
  '.css': 'CSS',
  '.html': 'HTML',
}

// Label map for cleaning up category names (matching Python reference)
const LABEL_MAP: Record<string, string> = {
  // Goal categories
  debug_investigate: '调试/排查',
  implement_feature: '实现功能',
  fix_bug: '修复 Bug',
  write_script_tool: '编写脚本/工具',
  refactor_code: '重构代码',
  configure_system: '配置系统',
  create_pr_commit: '创建 PR/提交',
  analyze_data: '分析数据',
  understand_codebase: '理解代码库',
  write_tests: '编写测试',
  write_docs: '编写文档',
  deploy_infra: '部署/基础设施',
  warmup_minimal: '缓存预热',
  // Success factors
  fast_accurate_search: '快速准确搜索',
  correct_code_edits: '正确修改代码',
  good_explanations: '解释清楚',
  proactive_help: '主动帮忙',
  multi_file_changes: '多文件修改',
  handled_complexity: '处理复杂问题',
  good_debugging: '调试有效',
  // Friction types
  misunderstood_request: '误解需求',
  wrong_approach: '方案不对',
  buggy_code: '代码有问题',
  user_rejected_action: '用户拒绝操作',
  claude_got_blocked: '执行受阻',
  user_stopped_early: '用户提前停止',
  wrong_file_or_location: '文件/位置不对',
  excessive_changes: '改动过多',
  slow_or_verbose: '太慢/太啰嗦',
  tool_failed: '工具失败',
  user_unclear: '需求不清',
  external_issue: '外部问题',
  // Satisfaction labels
  frustrated: '很不满意',
  dissatisfied: '不满意',
  likely_satisfied: '可能满意',
  satisfied: '满意',
  happy: '开心',
  unsure: '不确定',
  neutral: '中性',
  delighted: '非常满意',
  // Session types
  single_task: '单任务',
  multi_task: '多任务',
  iterative_refinement: '反复调整',
  exploration: '探索',
  quick_question: '快速提问',
  // Outcomes
  fully_achieved: '完全达成',
  mostly_achieved: '基本达成',
  partially_achieved: '部分达成',
  not_achieved: '未达成',
  unclear_from_transcript: '不清楚',
  // Helpfulness
  unhelpful: '没帮上忙',
  slightly_helpful: '有一点帮助',
  moderately_helpful: '有帮助',
  very_helpful: '很有帮助',
  essential: '关键帮助',
}

// Lazy getters: getClaudeConfigHomeDir() is memoized and reads process.env.
// Calling it at module scope would populate the memoize cache before
// entrypoints can set CLAUDE_CONFIG_DIR, breaking all 150+ other callers.
function getDataDir(): string {
  return join(getClaudeConfigHomeDir(), 'usage-data')
}
function getFacetsDir(): string {
  return join(getDataDir(), 'facets')
}
function getSessionMetaDir(): string {
  return join(getDataDir(), 'session-meta')
}

const FACET_EXTRACTION_PROMPT = `分析这个 Spark Code 会话，并提取结构化维度。

重要规则：

1. **goal_categories**：只统计用户明确提出的目标。
   - 不要统计 Claude 自己做的代码库探索
   - 不要统计 Claude 自己决定做的工作
   - 只在用户明确提出“能不能...”“请...”“我需要...”“我们...”时统计

2. **user_satisfaction_counts**：只基于用户明确表达的反馈。
   - "Yay!", "great!", "perfect!" → happy
   - "thanks", "looks good", "that works" → satisfied
   - "ok, now let's..." (continuing without complaint) → likely_satisfied
   - "that's not right", "try again" → dissatisfied
   - "this is broken", "I give up" → frustrated

3. **friction_counts**：具体说明哪里出了问题。
   - misunderstood_request：Claude 理解错了
   - wrong_approach：目标对，但方案不对
   - buggy_code：代码没有正常工作
   - user_rejected_action：用户拒绝或停止了工具调用
   - excessive_changes：过度设计或改动太大

4. 如果会话很短，或只是预热缓存，goal_category 使用 warmup_minimal。

SESSION:
`

// ============================================================================
// Helper Functions
// ============================================================================

function getLanguageFromPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] || null
}

function extractToolStats(log: LogOption): {
  toolCounts: Record<string, number>
  languages: Record<string, number>
  gitCommits: number
  gitPushes: number
  inputTokens: number
  outputTokens: number
  // New stats
  userInterruptions: number
  userResponseTimes: number[]
  toolErrors: number
  toolErrorCategories: Record<string, number>
  usesTaskAgent: boolean
  usesMcp: boolean
  usesWebSearch: boolean
  usesWebFetch: boolean
  // Additional stats
  linesAdded: number
  linesRemoved: number
  filesModified: Set<string>
  messageHours: number[]
  userMessageTimestamps: string[] // ISO timestamps for multi-clauding detection
} {
  const toolCounts: Record<string, number> = {}
  const languages: Record<string, number> = {}
  let gitCommits = 0
  let gitPushes = 0
  let inputTokens = 0
  let outputTokens = 0

  // New stats
  let userInterruptions = 0
  const userResponseTimes: number[] = []
  let toolErrors = 0
  const toolErrorCategories: Record<string, number> = {}
  let usesTaskAgent = false

  // Additional stats
  let linesAdded = 0
  let linesRemoved = 0
  const filesModified = new Set<string>()
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = [] // For multi-clauding detection
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let lastAssistantTimestamp: string | null = null

  for (const msg of log.messages) {
    // Get message timestamp for response time calculation
    const msgTimestamp = (msg as { timestamp?: string }).timestamp

    if (msg.type === 'assistant' && msg.message) {
      // Track timestamp for response time calculation
      if (msgTimestamp) {
        lastAssistantTimestamp = msgTimestamp
      }

      const usage = (
        msg.message as {
          usage?: { input_tokens?: number; output_tokens?: number }
        }
      ).usage
      if (usage) {
        inputTokens += usage.input_tokens || 0
        outputTokens += usage.output_tokens || 0
      }

      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && 'name' in block) {
            const toolName = block.name as string
            toolCounts[toolName] = (toolCounts[toolName] || 0) + 1

            // Check for special tool usage
            if (
              toolName === AGENT_TOOL_NAME ||
              toolName === LEGACY_AGENT_TOOL_NAME
            )
              usesTaskAgent = true
            if (toolName.startsWith('mcp__')) usesMcp = true
            if (toolName === 'WebSearch') usesWebSearch = true
            if (toolName === 'WebFetch') usesWebFetch = true

            const input = (block as { input?: Record<string, unknown> }).input

            if (input) {
              const filePath = (input.file_path as string) || ''
              if (filePath) {
                const lang = getLanguageFromPath(filePath)
                if (lang) {
                  languages[lang] = (languages[lang] || 0) + 1
                }
                // Track files modified by Edit/Write tools
                if (toolName === 'Edit' || toolName === 'Write') {
                  filesModified.add(filePath)
                }
              }

              if (toolName === 'Edit') {
                const oldString = (input.old_string as string) || ''
                const newString = (input.new_string as string) || ''
                for (const change of diffLines(oldString, newString)) {
                  if (change.added) linesAdded += change.count || 0
                  if (change.removed) linesRemoved += change.count || 0
                }
              }

              // Track lines from Write tool (all added)
              if (toolName === 'Write') {
                const writeContent = (input.content as string) || ''
                if (writeContent) {
                  linesAdded += countCharInString(writeContent, '\n') + 1
                }
              }

              const command = (input.command as string) || ''
              if (command.includes('git commit')) gitCommits++
              if (command.includes('git push')) gitPushes++
            }
          }
        }
      }
    }

    // Check user messages
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content

      // Check if this is an actual human message (has text) vs just tool_result
      // matching Python reference logic
      let isHumanMessage = false
      if (typeof content === 'string' && content.trim()) {
        isHumanMessage = true
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            isHumanMessage = true
            break
          }
        }
      }

      // Only track message hours and response times for actual human messages
      if (isHumanMessage) {
        // Track message hour for time-of-day analysis and timestamp for multi-clauding
        if (msgTimestamp) {
          try {
            const msgDate = new Date(msgTimestamp)
            const hour = msgDate.getHours() // Local hour 0-23
            messageHours.push(hour)
            // Collect timestamp for multi-clauding detection (matching Python)
            userMessageTimestamps.push(msgTimestamp)
          } catch {
            // Skip invalid timestamps
          }
        }

        // Calculate response time (time from last assistant message to this user message)
        // Only count gaps > 2 seconds (real user think time, not tool results)
        if (lastAssistantTimestamp && msgTimestamp) {
          const assistantTime = new Date(lastAssistantTimestamp).getTime()
          const userTime = new Date(msgTimestamp).getTime()
          const responseTimeSec = (userTime - assistantTime) / 1000
          // Only count reasonable response times (2s-1 hour) matching Python
          if (responseTimeSec > 2 && responseTimeSec < 3600) {
            userResponseTimes.push(responseTimeSec)
          }
        }
      }

      // Process tool results (for error tracking)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && 'content' in block) {
            const isError = (block as { is_error?: boolean }).is_error

            // Count and categorize tool errors (matching Python reference logic)
            if (isError) {
              toolErrors++
              const resultContent = (block as { content?: string }).content
              let category = 'Other'
              if (typeof resultContent === 'string') {
                const lowerContent = resultContent.toLowerCase()
                if (lowerContent.includes('exit code')) {
                  category = 'Command Failed'
                } else if (
                  lowerContent.includes('rejected') ||
                  lowerContent.includes("doesn't want")
                ) {
                  category = 'User Rejected'
                } else if (
                  lowerContent.includes('string to replace not found') ||
                  lowerContent.includes('no changes')
                ) {
                  category = 'Edit Failed'
                } else if (lowerContent.includes('modified since read')) {
                  category = 'File Changed'
                } else if (
                  lowerContent.includes('exceeds maximum') ||
                  lowerContent.includes('too large')
                ) {
                  category = 'File Too Large'
                } else if (
                  lowerContent.includes('file not found') ||
                  lowerContent.includes('does not exist')
                ) {
                  category = 'File Not Found'
                }
              }
              toolErrorCategories[category] =
                (toolErrorCategories[category] || 0) + 1
            }
          }
        }
      }

      // Check for interruptions (matching Python reference)
      if (typeof content === 'string') {
        if (content.includes('[Request interrupted by user')) {
          userInterruptions++
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'text' &&
            'text' in block &&
            (block.text as string).includes('[Request interrupted by user')
          ) {
            userInterruptions++
            break
          }
        }
      }
    }
  }

  return {
    toolCounts,
    languages,
    gitCommits,
    gitPushes,
    inputTokens,
    outputTokens,
    // New stats
    userInterruptions,
    userResponseTimes,
    toolErrors,
    toolErrorCategories,
    usesTaskAgent,
    usesMcp,
    usesWebSearch,
    usesWebFetch,
    // Additional stats
    linesAdded,
    linesRemoved,
    filesModified,
    messageHours,
    userMessageTimestamps,
  }
}

function hasValidDates(log: LogOption): boolean {
  return (
    !Number.isNaN(log.created.getTime()) &&
    !Number.isNaN(log.modified.getTime())
  )
}

function logToSessionMeta(log: LogOption): SessionMeta {
  const stats = extractToolStats(log)
  const sessionId = getSessionIdFromLog(log) || 'unknown'
  const startTime = log.created.toISOString()
  const durationMinutes = Math.round(
    (log.modified.getTime() - log.created.getTime()) / 1000 / 60,
  )

  let userMessageCount = 0
  let assistantMessageCount = 0
  for (const msg of log.messages) {
    if (msg.type === 'assistant') assistantMessageCount++
    // Only count user messages that have actual text content (human messages)
    // not just tool_result messages (matching Python reference)
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content
      let isHumanMessage = false
      if (typeof content === 'string' && content.trim()) {
        isHumanMessage = true
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            isHumanMessage = true
            break
          }
        }
      }
      if (isHumanMessage) {
        userMessageCount++
      }
    }
  }

  return {
    session_id: sessionId,
    project_path: log.projectPath || '',
    start_time: startTime,
    duration_minutes: durationMinutes,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    tool_counts: stats.toolCounts,
    languages: stats.languages,
    git_commits: stats.gitCommits,
    git_pushes: stats.gitPushes,
    input_tokens: stats.inputTokens,
    output_tokens: stats.outputTokens,
    first_prompt: log.firstPrompt || '',
    summary: log.summary,
    // New stats
    user_interruptions: stats.userInterruptions,
    user_response_times: stats.userResponseTimes,
    tool_errors: stats.toolErrors,
    tool_error_categories: stats.toolErrorCategories,
    uses_task_agent: stats.usesTaskAgent,
    uses_mcp: stats.usesMcp,
    uses_web_search: stats.usesWebSearch,
    uses_web_fetch: stats.usesWebFetch,
    // Additional stats
    lines_added: stats.linesAdded,
    lines_removed: stats.linesRemoved,
    files_modified: stats.filesModified.size,
    message_hours: stats.messageHours,
    user_message_timestamps: stats.userMessageTimestamps,
  }
}

/**
 * Deduplicate conversation branches within the same session.
 *
 * When a session file has multiple leaf messages (from retries or branching),
 * loadAllLogsFromSessionFile produces one LogOption per leaf. Each branch
 * shares the same root message, so its duration overlaps with sibling
 * branches. This keeps only the branch with the most user messages
 * (tie-break by longest duration) per session_id.
 */
export function deduplicateSessionBranches(
  entries: Array<{ log: LogOption; meta: SessionMeta }>,
): Array<{ log: LogOption; meta: SessionMeta }> {
  const bestBySession = new Map<string, { log: LogOption; meta: SessionMeta }>()
  for (const entry of entries) {
    const id = entry.meta.session_id
    const existing = bestBySession.get(id)
    if (
      !existing ||
      entry.meta.user_message_count > existing.meta.user_message_count ||
      (entry.meta.user_message_count === existing.meta.user_message_count &&
        entry.meta.duration_minutes > existing.meta.duration_minutes)
    ) {
      bestBySession.set(id, entry)
    }
  }
  return [...bestBySession.values()]
}

function formatTranscriptForFacets(log: LogOption): string {
  const lines: string[] = []
  const meta = logToSessionMeta(log)

  lines.push(`Session: ${meta.session_id.slice(0, 8)}`)
  lines.push(`Date: ${meta.start_time}`)
  lines.push(`Project: ${meta.project_path}`)
  lines.push(`Duration: ${meta.duration_minutes} min`)
  lines.push('')

  for (const msg of log.messages) {
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content
      if (typeof content === 'string') {
        lines.push(`[用户]: ${content.slice(0, 500)}`)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            lines.push(`[用户]: ${(block.text as string).slice(0, 500)}`)
          }
        }
      }
    } else if (msg.type === 'assistant' && msg.message) {
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            lines.push(`[助手]: ${(block.text as string).slice(0, 300)}`)
          } else if (block.type === 'tool_use' && 'name' in block) {
            lines.push(`[工具: ${block.name}]`)
          }
        }
      }
    }
  }

  return lines.join('\n')
}

const SUMMARIZE_CHUNK_PROMPT = `总结这段 Spark Code 会话记录。重点关注：
1. 用户提出了什么需求
2. Claude 做了什么（使用的工具、修改的文件）
3. 任何阻塞或问题
4. 最终结果

保持简洁，用 3-5 句中文。保留文件名、错误消息、用户反馈等具体细节。

会话片段：
`

async function summarizeTranscriptChunk(chunk: string): Promise<string> {
  try {
    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt: SUMMARIZE_CHUNK_PROMPT + chunk,
      signal: new AbortController().signal,
      options: {
        model: getAnalysisModel(),
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 500,
      },
    })

    const text = extractTextContent(result.message.content)
    return text || chunk.slice(0, 2000)
  } catch {
    // On error, just return truncated chunk
    return chunk.slice(0, 2000)
  }
}

async function formatTranscriptWithSummarization(
  log: LogOption,
): Promise<string> {
  const fullTranscript = formatTranscriptForFacets(log)

  // If under 30k chars, use as-is
  if (fullTranscript.length <= 30000) {
    return fullTranscript
  }

  // For long transcripts, split into chunks and summarize in parallel
  const CHUNK_SIZE = 25000
  const chunks: string[] = []

  for (let i = 0; i < fullTranscript.length; i += CHUNK_SIZE) {
    chunks.push(fullTranscript.slice(i, i + CHUNK_SIZE))
  }

  // Summarize all chunks in parallel
  const summaries = await Promise.all(chunks.map(summarizeTranscriptChunk))

  // Combine summaries with session header
  const meta = logToSessionMeta(log)
  const header = [
    `Session: ${meta.session_id.slice(0, 8)}`,
    `Date: ${meta.start_time}`,
    `Project: ${meta.project_path}`,
    `Duration: ${meta.duration_minutes} min`,
    `[Long session - ${chunks.length} parts summarized]`,
    '',
  ].join('\n')

  return header + summaries.join('\n\n---\n\n')
}

async function loadCachedFacets(
  sessionId: string,
): Promise<SessionFacets | null> {
  const facetPath = join(getFacetsDir(), `${sessionId}.json`)
  try {
    const content = await readFile(facetPath, { encoding: 'utf-8' })
    const parsed: unknown = jsonParse(content)
    if (!isValidSessionFacets(parsed)) {
      // Delete corrupted cache file so it gets re-extracted next run
      try {
        await unlink(facetPath)
      } catch {
        // Ignore deletion errors
      }
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function saveFacets(facets: SessionFacets): Promise<void> {
  try {
    await mkdir(getFacetsDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
  const facetPath = join(getFacetsDir(), `${facets.session_id}.json`)
  await writeFile(facetPath, jsonStringify(facets, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

async function loadCachedSessionMeta(
  sessionId: string,
): Promise<SessionMeta | null> {
  const metaPath = join(getSessionMetaDir(), `${sessionId}.json`)
  try {
    const content = await readFile(metaPath, { encoding: 'utf-8' })
    return jsonParse(content)
  } catch {
    return null
  }
}

async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  try {
    await mkdir(getSessionMetaDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
  const metaPath = join(getSessionMetaDir(), `${meta.session_id}.json`)
  await writeFile(metaPath, jsonStringify(meta, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

async function extractFacetsFromAPI(
  log: LogOption,
  sessionId: string,
): Promise<SessionFacets | null> {
  try {
    // Use summarization for long transcripts
    const transcript = await formatTranscriptWithSummarization(log)

    // Build prompt asking for JSON directly (no tool use)
    const jsonPrompt = `${FACET_EXTRACTION_PROMPT}${transcript}

只返回符合以下结构的合法 JSON 对象：
{
  "underlying_goal": "用户真正想完成的事情，请用简体中文",
  "goal_categories": {"category_name": count, ...},
  "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript",
  "user_satisfaction_counts": {"level": count, ...},
  "claude_helpfulness": "unhelpful|slightly_helpful|moderately_helpful|very_helpful|essential",
  "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
  "friction_counts": {"friction_type": count, ...},
  "friction_detail": "一句中文描述阻塞点，没有就留空",
  "primary_success": "none|fast_accurate_search|correct_code_edits|good_explanations|proactive_help|multi_file_changes|good_debugging",
  "brief_summary": "一句中文总结用户想要什么，以及是否达成"
}`

    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt: jsonPrompt,
      signal: new AbortController().signal,
      options: {
        model: getAnalysisModel(),
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 4096,
      },
    })

    const text = extractTextContent(result.message.content)

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed: unknown = jsonParse(jsonMatch[0])
    if (!isValidSessionFacets(parsed)) return null
    const facets: SessionFacets = { ...parsed, session_id: sessionId }
    return facets
  } catch (err) {
    logError(new Error(`Facet extraction failed: ${toError(err).message}`))
    return null
  }
}

/**
 * Detects multi-clauding (using multiple Claude sessions concurrently).
 * Uses a sliding window to find the pattern: session1 -> session2 -> session1
 * within a 30-minute window.
 */
export function detectMultiClauding(
  sessions: Array<{
    session_id: string
    user_message_timestamps: string[]
  }>,
): {
  overlap_events: number
  sessions_involved: number
  user_messages_during: number
} {
  const OVERLAP_WINDOW_MS = 30 * 60000
  const allSessionMessages: Array<{ ts: number; sessionId: string }> = []

  for (const session of sessions) {
    for (const timestamp of session.user_message_timestamps) {
      try {
        const ts = new Date(timestamp).getTime()
        allSessionMessages.push({ ts, sessionId: session.session_id })
      } catch {
        // Skip invalid timestamps
      }
    }
  }

  allSessionMessages.sort((a, b) => a.ts - b.ts)

  const multiClaudeSessionPairs = new Set<string>()
  const messagesDuringMulticlaude = new Set<string>()

  // Sliding window: sessionLastIndex tracks the most recent index for each session
  let windowStart = 0
  const sessionLastIndex = new Map<string, number>()

  for (let i = 0; i < allSessionMessages.length; i++) {
    const msg = allSessionMessages[i]!

    // Shrink window from the left
    while (
      windowStart < i &&
      msg.ts - allSessionMessages[windowStart]!.ts > OVERLAP_WINDOW_MS
    ) {
      const expiring = allSessionMessages[windowStart]!
      if (sessionLastIndex.get(expiring.sessionId) === windowStart) {
        sessionLastIndex.delete(expiring.sessionId)
      }
      windowStart++
    }

    // Check if this session appeared earlier in the window (pattern: s1 -> s2 -> s1)
    const prevIndex = sessionLastIndex.get(msg.sessionId)
    if (prevIndex !== undefined) {
      for (let j = prevIndex + 1; j < i; j++) {
        const between = allSessionMessages[j]!
        if (between.sessionId !== msg.sessionId) {
          const pair = [msg.sessionId, between.sessionId].sort().join(':')
          multiClaudeSessionPairs.add(pair)
          messagesDuringMulticlaude.add(
            `${allSessionMessages[prevIndex]!.ts}:${msg.sessionId}`,
          )
          messagesDuringMulticlaude.add(`${between.ts}:${between.sessionId}`)
          messagesDuringMulticlaude.add(`${msg.ts}:${msg.sessionId}`)
          break
        }
      }
    }

    sessionLastIndex.set(msg.sessionId, i)
  }

  const sessionsWithOverlaps = new Set<string>()
  for (const pair of multiClaudeSessionPairs) {
    const [s1, s2] = pair.split(':')
    if (s1) sessionsWithOverlaps.add(s1)
    if (s2) sessionsWithOverlaps.add(s2)
  }

  return {
    overlap_events: multiClaudeSessionPairs.size,
    sessions_involved: sessionsWithOverlaps.size,
    user_messages_during: messagesDuringMulticlaude.size,
  }
}

function aggregateData(
  sessions: SessionMeta[],
  facets: Map<string, SessionFacets>,
): AggregatedData {
  const result: AggregatedData = {
    total_sessions: sessions.length,
    sessions_with_facets: facets.size,
    date_range: { start: '', end: '' },
    total_messages: 0,
    total_duration_hours: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    tool_counts: {},
    languages: {},
    git_commits: 0,
    git_pushes: 0,
    projects: {},
    goal_categories: {},
    outcomes: {},
    satisfaction: {},
    helpfulness: {},
    session_types: {},
    friction: {},
    success: {},
    session_summaries: [],
    // New stats
    total_interruptions: 0,
    total_tool_errors: 0,
    tool_error_categories: {},
    user_response_times: [],
    median_response_time: 0,
    avg_response_time: 0,
    sessions_using_task_agent: 0,
    sessions_using_mcp: 0,
    sessions_using_web_search: 0,
    sessions_using_web_fetch: 0,
    // Additional stats
    total_lines_added: 0,
    total_lines_removed: 0,
    total_files_modified: 0,
    days_active: 0,
    messages_per_day: 0,
    message_hours: [],
    // Multi-clauding stats (matching Python reference)
    multi_clauding: {
      overlap_events: 0,
      sessions_involved: 0,
      user_messages_during: 0,
    },
  }

  const dates: string[] = []
  const allResponseTimes: number[] = []
  const allMessageHours: number[] = []

  for (const session of sessions) {
    dates.push(session.start_time)
    result.total_messages += session.user_message_count
    result.total_duration_hours += session.duration_minutes / 60
    result.total_input_tokens += session.input_tokens
    result.total_output_tokens += session.output_tokens
    result.git_commits += session.git_commits
    result.git_pushes += session.git_pushes

    // New stats aggregation
    result.total_interruptions += session.user_interruptions
    result.total_tool_errors += session.tool_errors
    for (const [cat, count] of Object.entries(session.tool_error_categories)) {
      result.tool_error_categories[cat] =
        (result.tool_error_categories[cat] || 0) + count
    }
    allResponseTimes.push(...session.user_response_times)
    if (session.uses_task_agent) result.sessions_using_task_agent++
    if (session.uses_mcp) result.sessions_using_mcp++
    if (session.uses_web_search) result.sessions_using_web_search++
    if (session.uses_web_fetch) result.sessions_using_web_fetch++

    // Additional stats aggregation
    result.total_lines_added += session.lines_added
    result.total_lines_removed += session.lines_removed
    result.total_files_modified += session.files_modified
    allMessageHours.push(...session.message_hours)

    for (const [tool, count] of Object.entries(session.tool_counts)) {
      result.tool_counts[tool] = (result.tool_counts[tool] || 0) + count
    }

    for (const [lang, count] of Object.entries(session.languages)) {
      result.languages[lang] = (result.languages[lang] || 0) + count
    }

    if (session.project_path) {
      result.projects[session.project_path] =
        (result.projects[session.project_path] || 0) + 1
    }

    const sessionFacets = facets.get(session.session_id)
    if (sessionFacets) {
      // Goal categories
      for (const [cat, count] of safeEntries(sessionFacets.goal_categories)) {
        if (count > 0) {
          result.goal_categories[cat] =
            (result.goal_categories[cat] || 0) + count
        }
      }

      // Outcomes
      result.outcomes[sessionFacets.outcome] =
        (result.outcomes[sessionFacets.outcome] || 0) + 1

      // Satisfaction counts
      for (const [level, count] of safeEntries(
        sessionFacets.user_satisfaction_counts,
      )) {
        if (count > 0) {
          result.satisfaction[level] = (result.satisfaction[level] || 0) + count
        }
      }

      // Helpfulness
      result.helpfulness[sessionFacets.claude_helpfulness] =
        (result.helpfulness[sessionFacets.claude_helpfulness] || 0) + 1

      // Session types
      result.session_types[sessionFacets.session_type] =
        (result.session_types[sessionFacets.session_type] || 0) + 1

      // Friction counts
      for (const [type, count] of safeEntries(sessionFacets.friction_counts)) {
        if (count > 0) {
          result.friction[type] = (result.friction[type] || 0) + count
        }
      }

      // Success factors
      if (sessionFacets.primary_success !== 'none') {
        result.success[sessionFacets.primary_success] =
          (result.success[sessionFacets.primary_success] || 0) + 1
      }
    }

    if (result.session_summaries.length < 50) {
      result.session_summaries.push({
        id: session.session_id.slice(0, 8),
        date: session.start_time.split('T')[0] || '',
        summary: session.summary || session.first_prompt.slice(0, 100),
        goal: sessionFacets?.underlying_goal,
      })
    }
  }

  dates.sort()
  result.date_range.start = dates[0]?.split('T')[0] || ''
  result.date_range.end = dates[dates.length - 1]?.split('T')[0] || ''

  // Calculate response time stats
  result.user_response_times = allResponseTimes
  if (allResponseTimes.length > 0) {
    const sorted = [...allResponseTimes].sort((a, b) => a - b)
    result.median_response_time = sorted[Math.floor(sorted.length / 2)] || 0
    result.avg_response_time =
      allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length
  }

  // Calculate days active and messages per day
  const uniqueDays = new Set(dates.map(d => d.split('T')[0]))
  result.days_active = uniqueDays.size
  result.messages_per_day =
    result.days_active > 0
      ? Math.round((result.total_messages / result.days_active) * 10) / 10
      : 0

  // Store message hours for time-of-day chart
  result.message_hours = allMessageHours

  result.multi_clauding = detectMultiClauding(sessions)

  return result
}

// ============================================================================
// Parallel Insights Generation (6 sections)
// ============================================================================

type InsightSection = {
  name: string
  prompt: string
  maxTokens: number
}

// Sections that run in parallel first
const INSIGHT_SECTIONS: InsightSection[] = [
  {
    name: 'project_areas',
    prompt: `分析这份 Spark Code 使用数据，识别用户主要投入的项目领域。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "areas": [
    {"name": "领域名称", "session_count": N, "description": "2-3 句说明做了什么，以及 Spark Code 是怎么被使用的。"}
  ]
}

包含 4-5 个领域。跳过内部 CC 操作。`,
    maxTokens: 8192,
  },
  {
    name: 'interaction_style',
    prompt: `分析这份 Spark Code 使用数据，描述用户的交互方式。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "narrative": "2-3 段分析用户如何与 Spark Code 互动。用第二人称“你”。描述模式：是快速迭代，还是先给详细规格？经常打断，还是让 Claude 跑完？包含具体例子。关键洞察用 **加粗**。",
  "key_pattern": "一句话总结最明显的交互模式"
}`,
    maxTokens: 8192,
  },
  {
    name: 'what_works',
    prompt: `分析这份 Spark Code 使用数据，找出对用户来说运行良好的地方。用第二人称“你”。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "intro": "一句上下文说明",
  "impressive_workflows": [
    {"title": "简短标题（3-6 个词）", "description": "2-3 句说明值得保留的工作流或方法。用“你”，不要用“用户”。"}
  ]
}

包含 3 个工作流。`,
    maxTokens: 8192,
  },
  {
    name: 'friction_analysis',
    prompt: `分析这份 Spark Code 使用数据，识别用户遇到的阻塞点。用第二人称“你”。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "intro": "一句话总结阻塞模式",
  "categories": [
    {"category": "具体分类名称", "description": "1-2 句解释这个分类，以及之后可以怎么做得不同。用“你”，不要用“用户”。", "examples": ["带结果的具体例子", "另一个例子"]}
  ]
}

包含 3 个阻塞分类，每类 2 个例子。`,
    maxTokens: 8192,
  },
  {
    name: 'suggestions',
    prompt: `分析这份 Spark Code 使用数据，并给出改进建议。

## CC 功能参考（features_to_try 从这里挑）：
1. **MCP Servers**：通过 Model Context Protocol 连接 Claude 与外部工具、数据库和 API。
   - 使用方式：运行 \`claude mcp add <server-name> -- <command>\`
   - 适合：数据库查询、Slack 集成、GitHub issue 查询、连接内部 API

2. **Custom Skills**：把可复用提示写成 markdown 文件，然后通过一个 /command 运行。
   - 使用方式：创建 \`.claude/skills/commit/SKILL.md\` 写入说明，然后输入 \`/commit\` 运行。
   - 适合：重复工作流，例如 /commit、/review、/test、/deploy、/pr，或复杂多步骤流程

3. **Hooks**：在特定生命周期事件自动运行 shell 命令。
   - 使用方式：加入 \`.claude/settings.json\` 的 "hooks" 字段。
   - 适合：自动格式化代码、运行类型检查、强制执行规范

4. **Headless Mode**：从脚本和 CI/CD 非交互式运行 Claude。
   - 使用方式：\`claude -p "fix lint errors" --allowedTools "Edit,Read,Bash"\`
   - 适合：CI/CD 集成、批量修复代码、自动审查

5. **Task Agents**：Claude 为复杂探索或并行工作启动专门的子 agent。
   - 使用方式：Claude 会在有帮助时自动调用，也可以直接说“用一个 agent 探索 X”。
   - 适合：探索代码库、理解复杂系统

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "claude_md_additions": [
    {"addition": "基于工作流模式建议加入 SPARK.md 的具体行或段落。例如：修改认证相关文件后总是运行测试。", "why": "一句话说明为什么这对实际会话有帮助", "prompt_scaffold": "说明应该加到 SPARK.md 哪里。例如：加入 ## 测试 部分"}
  ],
  "features_to_try": [
    {"feature": "上面 CC 功能参考中的功能名", "one_liner": "它能做什么", "why_for_you": "基于你的会话说明为什么它会帮到你", "example_code": "可复制的实际命令或配置"}
  ],
  "usage_patterns": [
    {"title": "简短标题", "suggestion": "1-2 句总结", "detail": "3-4 句说明它如何适用于你的工作", "copyable_prompt": "可复制尝试的具体提示"}
  ]
}

claude_md_additions 的重点：优先选择在用户数据中多次出现的指令。如果用户在 2 个以上会话里告诉 Claude 同一件事（例如“总是运行测试”“使用 TypeScript”），这就是强候选项，用户不应该反复说。

features_to_try 的重点：从上面的 CC 功能参考里挑 2-3 个。每个分类包含 2-3 项。`,
    maxTokens: 8192,
  },
  {
    name: 'on_the_horizon',
    prompt: `分析这份 Spark Code 使用数据，识别未来可以尝试的机会。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "intro": "一句话说明 AI 辅助开发正在如何演进",
  "opportunities": [
    {"title": "简短标题（4-8 个词）", "whats_possible": "2-3 句有野心但具体的自主工作流描述", "how_to_try": "1-2 句提到相关工具", "copyable_prompt": "可尝试的详细提示"}
  ]
}

包含 3 个机会。可以更大胆：自主工作流、并行 agents、围绕测试迭代。`,
    maxTokens: 8192,
  },
  ...(process.env.USER_TYPE === 'ant'
    ? [
        {
          name: 'cc_team_improvements',
          prompt: `分析这份 Spark Code 使用数据，并给 CC 团队提出产品改进建议。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "improvements": [
    {"title": "产品/工具改进", "detail": "3-4 句描述改进内容", "evidence": "3-4 句具体会话例证"}
  ]
}

基于观察到的阻塞模式，包含 2-3 条改进建议。`,
          maxTokens: 8192,
        },
        {
          name: 'model_behavior_improvements',
          prompt: `分析这份 Spark Code 使用数据，并提出模型行为改进建议。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "improvements": [
    {"title": "模型行为调整", "detail": "3-4 句说明模型应该如何做得不同", "evidence": "3-4 句具体例证"}
  ]
}

基于观察到的阻塞模式，包含 2-3 条改进建议。`,
          maxTokens: 8192,
        },
      ]
    : []),
  {
    name: 'fun_ending',
    prompt: `分析这份 Spark Code 使用数据，找出一个让人有印象的时刻。

只返回合法 JSON 对象，所有面向用户的字符串都用简体中文：
{
  "headline": "从对话记录中提炼一个有记忆点的定性时刻，不要写统计数据。可以是有人味、有趣或让人意外的事情。",
  "detail": "简要说明这个时刻发生在什么时候/哪里"
}

从会话摘要中找一个真正有意思或有趣的点。`,
    maxTokens: 8192,
  },
]

type InsightResults = {
  at_a_glance?: {
    whats_working?: string
    whats_hindering?: string
    quick_wins?: string
    ambitious_workflows?: string
  }
  project_areas?: {
    areas?: Array<{ name: string; session_count: number; description: string }>
  }
  interaction_style?: {
    narrative?: string
    key_pattern?: string
  }
  what_works?: {
    intro?: string
    impressive_workflows?: Array<{ title: string; description: string }>
  }
  friction_analysis?: {
    intro?: string
    categories?: Array<{
      category: string
      description: string
      examples?: string[]
    }>
  }
  suggestions?: {
    claude_md_additions?: Array<{
      addition: string
      why: string
      where?: string
      prompt_scaffold?: string
    }>
    features_to_try?: Array<{
      feature: string
      one_liner: string
      why_for_you: string
      example_code?: string
    }>
    usage_patterns?: Array<{
      title: string
      suggestion: string
      detail?: string
      copyable_prompt?: string
    }>
  }
  on_the_horizon?: {
    intro?: string
    opportunities?: Array<{
      title: string
      whats_possible: string
      how_to_try?: string
      copyable_prompt?: string
    }>
  }
  cc_team_improvements?: {
    improvements?: Array<{
      title: string
      detail: string
      evidence?: string
    }>
  }
  model_behavior_improvements?: {
    improvements?: Array<{
      title: string
      detail: string
      evidence?: string
    }>
  }
  fun_ending?: {
    headline?: string
    detail?: string
  }
}

async function generateSectionInsight(
  section: InsightSection,
  dataContext: string,
): Promise<{ name: string; result: unknown }> {
  try {
    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt: section.prompt + '\n\nDATA:\n' + dataContext,
      signal: new AbortController().signal,
      options: {
        model: getInsightsModel(),
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: section.maxTokens,
      },
    })

    const text = extractTextContent(result.message.content)

    if (text) {
      // Parse JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          return { name: section.name, result: jsonParse(jsonMatch[0]) }
        } catch {
          return { name: section.name, result: null }
        }
      }
    }
    return { name: section.name, result: null }
  } catch (err) {
    logError(new Error(`${section.name} failed: ${toError(err).message}`))
    return { name: section.name, result: null }
  }
}

async function generateParallelInsights(
  data: AggregatedData,
  facets: Map<string, SessionFacets>,
): Promise<InsightResults> {
  // Build data context string
  const facetSummaries = Array.from(facets.values())
    .slice(0, 50)
    .map(f => `- ${f.brief_summary} (${f.outcome}, ${f.claude_helpfulness})`)
    .join('\n')

  const frictionDetails = Array.from(facets.values())
    .filter(f => f.friction_detail)
    .slice(0, 20)
    .map(f => `- ${f.friction_detail}`)
    .join('\n')

  const userInstructions = Array.from(facets.values())
    .flatMap(f => f.user_instructions_to_claude || [])
    .slice(0, 15)
    .map(i => `- ${i}`)
    .join('\n')

  const dataContext = jsonStringify(
    {
      sessions: data.total_sessions,
      analyzed: data.sessions_with_facets,
      date_range: data.date_range,
      messages: data.total_messages,
      hours: Math.round(data.total_duration_hours),
      commits: data.git_commits,
      top_tools: Object.entries(data.tool_counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
      top_goals: Object.entries(data.goal_categories)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
      outcomes: data.outcomes,
      satisfaction: data.satisfaction,
      friction: data.friction,
      success: data.success,
      languages: data.languages,
    },
    null,
    2,
  )

  const fullContext =
    dataContext +
    '\n\nSESSION SUMMARIES:\n' +
    facetSummaries +
    '\n\nFRICTION DETAILS:\n' +
    frictionDetails +
    '\n\nUSER INSTRUCTIONS TO CLAUDE:\n' +
    (userInstructions || 'None captured')

  // Run sections in parallel first (excluding at_a_glance)
  const results = await Promise.all(
    INSIGHT_SECTIONS.map(section =>
      generateSectionInsight(section, fullContext),
    ),
  )

  // Combine results
  const insights: InsightResults = {}
  for (const { name, result } of results) {
    if (result) {
      ;(insights as Record<string, unknown>)[name] = result
    }
  }

  // Build rich context from generated sections for At a Glance
  const projectAreasText =
    (
      insights.project_areas as {
        areas?: Array<{ name: string; description: string }>
      }
    )?.areas
      ?.map(a => `- ${a.name}: ${a.description}`)
      .join('\n') || ''

  const bigWinsText =
    (
      insights.what_works as {
        impressive_workflows?: Array<{ title: string; description: string }>
      }
    )?.impressive_workflows
      ?.map(w => `- ${w.title}: ${w.description}`)
      .join('\n') || ''

  const frictionText =
    (
      insights.friction_analysis as {
        categories?: Array<{ category: string; description: string }>
      }
    )?.categories
      ?.map(c => `- ${c.category}: ${c.description}`)
      .join('\n') || ''

  const featuresText =
    (
      insights.suggestions as {
        features_to_try?: Array<{ feature: string; one_liner: string }>
      }
    )?.features_to_try
      ?.map(f => `- ${f.feature}: ${f.one_liner}`)
      .join('\n') || ''

  const patternsText =
    (
      insights.suggestions as {
        usage_patterns?: Array<{ title: string; suggestion: string }>
      }
    )?.usage_patterns
      ?.map(p => `- ${p.title}: ${p.suggestion}`)
      .join('\n') || ''

  const horizonText =
    (
      insights.on_the_horizon as {
        opportunities?: Array<{ title: string; whats_possible: string }>
      }
    )?.opportunities
      ?.map(o => `- ${o.title}: ${o.whats_possible}`)
      .join('\n') || ''

  // Now generate the overview with access to other sections' outputs
  const atAGlancePrompt = `你正在为 Spark Code 用户编写“快速概览”总结。目标是帮助用户理解自己的使用方式，并改进和 Claude 协作的方式，尤其是随着模型能力增强后如何更好地使用。

使用下面 4 部分结构：

1. **有效的地方**：用户与 Claude 互动的独特风格是什么？他们做过哪些有影响的事？可以包含一两个细节，但保持高层次，因为用户可能已经不记得具体细节。不要空泛夸奖，也不要把重点放在工具调用上。

2. **卡住你的地方**：拆成两类：(a) Claude 的问题（误解、方案不对、bug），(b) 用户侧阻塞（上下文不足、环境问题，尽量总结成跨项目的通用问题）。要诚实但有建设性。

3. **可以马上试的改进**：从下面例子中挑具体的 Spark Code 功能，或提出你认为确实有价值的工作流技巧。避免“让 Claude 操作前确认”或“提前多写上下文”这种不够有力的建议。

4. **更进一步的工作流**：未来 3-6 个月模型能力继续增强后，用户应该准备什么？现在看起来不太可能的哪些工作流会变得可行？从下面对应章节中提炼。

每部分控制在 2-3 句，不要太长。不要给用户太多信息。不要提具体数字统计，也不要提下面数据里的 underlined_categories。语气像教练，直接、实用。

只返回合法 JSON 对象，所有值都用简体中文：
{
  "whats_working": "按上面的说明填写",
  "whats_hindering": "按上面的说明填写",
  "quick_wins": "按上面的说明填写",
  "ambitious_workflows": "按上面的说明填写"
}

会话数据：
${fullContext}

## 项目领域（用户主要做什么）
${projectAreasText}

## 做得不错的事
${bigWinsText}

## 阻塞分类（哪里容易出问题）
${frictionText}

## 可以尝试的功能
${featuresText}

## 可以采用的使用模式
${patternsText}

## 接下来可以尝试（更强模型下的进阶工作流）
${horizonText}`

  const atAGlanceSection: InsightSection = {
    name: 'at_a_glance',
    prompt: atAGlancePrompt,
    maxTokens: 8192,
  }

  const atAGlanceResult = await generateSectionInsight(atAGlanceSection, '')
  if (atAGlanceResult.result) {
    insights.at_a_glance = atAGlanceResult.result as {
      whats_working?: string
      whats_hindering?: string
      quick_wins?: string
      ambitious_workflows?: string
    }
  }

  return insights
}

// Escape HTML but render **bold** as <strong>
function escapeHtmlWithBold(text: string): string {
  const escaped = escapeHtml(text)
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

// Fixed orderings for specific charts (matching Python reference)
const SATISFACTION_ORDER = [
  'frustrated',
  'dissatisfied',
  'likely_satisfied',
  'satisfied',
  'happy',
  'unsure',
]

const OUTCOME_ORDER = [
  'not_achieved',
  'partially_achieved',
  'mostly_achieved',
  'fully_achieved',
  'unclear_from_transcript',
]

function generateBarChart(
  data: Record<string, number>,
  color: string,
  maxItems = 6,
  fixedOrder?: string[],
): string {
  let entries: [string, number][]

  if (fixedOrder) {
    // Use fixed order, only including items that exist in data
    entries = fixedOrder
      .filter(key => key in data && (data[key] ?? 0) > 0)
      .map(key => [key, data[key] ?? 0] as [string, number])
  } else {
    // Sort by count descending
    entries = Object.entries(data)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxItems)
  }

  if (entries.length === 0) return '<p class="empty">暂无数据</p>'

  const maxVal = Math.max(...entries.map(e => e[1]))
  return entries
    .map(([label, count]) => {
      const pct = (count / maxVal) * 100
      // Use LABEL_MAP if available, otherwise clean up underscores and title case
      const cleanLabel =
        LABEL_MAP[label] ||
        label.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      return `<div class="bar-row">
        <div class="bar-label">${escapeHtml(cleanLabel)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="bar-value">${count}</div>
      </div>`
    })
    .join('\n')
}

function generateResponseTimeHistogram(times: number[]): string {
  if (times.length === 0) return '<p class="empty">暂无响应时间数据</p>'

  // Create buckets (matching Python reference)
  const buckets: Record<string, number> = {
    '2-10s': 0,
    '10-30s': 0,
    '30s-1m': 0,
    '1-2m': 0,
    '2-5m': 0,
    '5-15m': 0,
    '>15m': 0,
  }

  for (const t of times) {
    if (t < 10) buckets['2-10s'] = (buckets['2-10s'] ?? 0) + 1
    else if (t < 30) buckets['10-30s'] = (buckets['10-30s'] ?? 0) + 1
    else if (t < 60) buckets['30s-1m'] = (buckets['30s-1m'] ?? 0) + 1
    else if (t < 120) buckets['1-2m'] = (buckets['1-2m'] ?? 0) + 1
    else if (t < 300) buckets['2-5m'] = (buckets['2-5m'] ?? 0) + 1
    else if (t < 900) buckets['5-15m'] = (buckets['5-15m'] ?? 0) + 1
    else buckets['>15m'] = (buckets['>15m'] ?? 0) + 1
  }

  const maxVal = Math.max(...Object.values(buckets))
  if (maxVal === 0) return '<p class="empty">暂无响应时间数据</p>'

  return Object.entries(buckets)
    .map(([label, count]) => {
      const pct = (count / maxVal) * 100
      return `<div class="bar-row">
        <div class="bar-label">${label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:#6366f1"></div></div>
        <div class="bar-value">${count}</div>
      </div>`
    })
    .join('\n')
}

function generateTimeOfDayChart(messageHours: number[]): string {
  if (messageHours.length === 0) return '<p class="empty">暂无时间数据</p>'

  // Group into time periods
  const periods = [
    { label: '上午 (6-12)', range: [6, 7, 8, 9, 10, 11] },
    { label: '下午 (12-18)', range: [12, 13, 14, 15, 16, 17] },
    { label: '晚上 (18-24)', range: [18, 19, 20, 21, 22, 23] },
    { label: '凌晨 (0-6)', range: [0, 1, 2, 3, 4, 5] },
  ]

  const hourCounts: Record<number, number> = {}
  for (const h of messageHours) {
    hourCounts[h] = (hourCounts[h] || 0) + 1
  }

  const periodCounts = periods.map(p => ({
    label: p.label,
    count: p.range.reduce((sum, h) => sum + (hourCounts[h] || 0), 0),
  }))

  const maxVal = Math.max(...periodCounts.map(p => p.count)) || 1

  const barsHtml = periodCounts
    .map(
      p => `
      <div class="bar-row">
        <div class="bar-label">${p.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(p.count / maxVal) * 100}%;background:#8b5cf6"></div></div>
        <div class="bar-value">${p.count}</div>
      </div>`,
    )
    .join('\n')

  return `<div id="hour-histogram">${barsHtml}</div>`
}

function getHourCountsJson(messageHours: number[]): string {
  const hourCounts: Record<number, number> = {}
  for (const h of messageHours) {
    hourCounts[h] = (hourCounts[h] || 0) + 1
  }
  return jsonStringify(hourCounts)
}

function generateHtmlReport(
  data: AggregatedData,
  insights: InsightResults,
): string {
  const markdownToHtml = (md: string): string => {
    if (!md) return ''
    return md
      .split('\n\n')
      .map(p => {
        let html = escapeHtml(p)
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        html = html.replace(/^- /gm, '• ')
        html = html.replace(/\n/g, '<br>')
        return `<p>${html}</p>`
      })
      .join('\n')
  }

  // Build At a Glance section (new 4-part format with links to sections)
  const atAGlance = insights.at_a_glance
  const atAGlanceHtml = atAGlance
    ? `
    <div class="at-a-glance">
      <div class="glance-title">快速概览</div>
      <div class="glance-sections">
        ${atAGlance.whats_working ? `<div class="glance-section"><strong>有效的地方：</strong> ${escapeHtmlWithBold(atAGlance.whats_working)} <a href="#section-wins" class="see-more">做得不错的事 →</a></div>` : ''}
        ${atAGlance.whats_hindering ? `<div class="glance-section"><strong>卡住你的地方：</strong> ${escapeHtmlWithBold(atAGlance.whats_hindering)} <a href="#section-friction" class="see-more">哪里容易出问题 →</a></div>` : ''}
        ${atAGlance.quick_wins ? `<div class="glance-section"><strong>可以马上试的改进：</strong> ${escapeHtmlWithBold(atAGlance.quick_wins)} <a href="#section-features" class="see-more">可以试的功能 →</a></div>` : ''}
        ${atAGlance.ambitious_workflows ? `<div class="glance-section"><strong>更进一步的工作流：</strong> ${escapeHtmlWithBold(atAGlance.ambitious_workflows)} <a href="#section-horizon" class="see-more">接下来可以尝试 →</a></div>` : ''}
      </div>
    </div>
    `
    : ''

  // Build project areas section
  const projectAreas = insights.project_areas?.areas || []
  const projectAreasHtml =
    projectAreas.length > 0
      ? `
    <h2 id="section-work">你主要在做什么</h2>
    <div class="project-areas">
      ${projectAreas
        .map(
          area => `
        <div class="project-area">
          <div class="area-header">
            <span class="area-name">${escapeHtml(area.name)}</span>
            <span class="area-count">约 ${area.session_count} 次会话</span>
          </div>
          <div class="area-desc">${escapeHtml(area.description)}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  // Build interaction style section
  const interactionStyle = insights.interaction_style
  const interactionHtml = interactionStyle?.narrative
    ? `
    <h2 id="section-usage">你怎么使用 Spark Code</h2>
    <div class="narrative">
      ${markdownToHtml(interactionStyle.narrative)}
      ${interactionStyle.key_pattern ? `<div class="key-insight"><strong>关键模式：</strong> ${escapeHtml(interactionStyle.key_pattern)}</div>` : ''}
    </div>
    `
    : ''

  // Build what works section
  const whatWorks = insights.what_works
  const whatWorksHtml =
    whatWorks?.impressive_workflows && whatWorks.impressive_workflows.length > 0
      ? `
    <h2 id="section-wins">做得不错的事</h2>
    ${whatWorks.intro ? `<p class="section-intro">${escapeHtml(whatWorks.intro)}</p>` : ''}
    <div class="big-wins">
      ${whatWorks.impressive_workflows
        .map(
          wf => `
        <div class="big-win">
          <div class="big-win-title">${escapeHtml(wf.title || '')}</div>
          <div class="big-win-desc">${escapeHtml(wf.description || '')}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  // Build friction section
  const frictionAnalysis = insights.friction_analysis
  const frictionHtml =
    frictionAnalysis?.categories && frictionAnalysis.categories.length > 0
      ? `
    <h2 id="section-friction">哪里容易出问题</h2>
    ${frictionAnalysis.intro ? `<p class="section-intro">${escapeHtml(frictionAnalysis.intro)}</p>` : ''}
    <div class="friction-categories">
      ${frictionAnalysis.categories
        .map(
          cat => `
        <div class="friction-category">
          <div class="friction-title">${escapeHtml(cat.category || '')}</div>
          <div class="friction-desc">${escapeHtml(cat.description || '')}</div>
          ${cat.examples ? `<ul class="friction-examples">${cat.examples.map(ex => `<li>${escapeHtml(ex)}</li>`).join('')}</ul>` : ''}
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  // Build suggestions section
  const suggestions = insights.suggestions
  const suggestionsHtml = suggestions
    ? `
    ${
      suggestions.claude_md_additions &&
      suggestions.claude_md_additions.length > 0
        ? `
    <h2 id="section-features">可以试试的现有功能</h2>
    <div class="claude-md-section">
      <h3>建议加入 SPARK.md 的内容</h3>
      <p style="font-size: 12px; color: #64748b; margin-bottom: 12px;">复制到 Spark Code 后即可加入你的 SPARK.md。</p>
      <div class="claude-md-actions">
        <button class="copy-all-btn" onclick="copyAllCheckedClaudeMd()">复制已勾选</button>
      </div>
      ${suggestions.claude_md_additions
        .map(
          (add, i) => `
        <div class="claude-md-item">
          <input type="checkbox" id="cmd-${i}" class="cmd-checkbox" checked data-text="${escapeHtml(add.prompt_scaffold || add.where || 'Add to SPARK.md')}\\n\\n${escapeHtml(add.addition)}">
          <label for="cmd-${i}">
            <code class="cmd-code">${escapeHtml(add.addition)}</code>
            <button class="copy-btn" onclick="copyCmdItem(${i})">复制</button>
          </label>
          <div class="cmd-why">${escapeHtml(add.why)}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    `
        : ''
    }
    ${
      suggestions.features_to_try && suggestions.features_to_try.length > 0
        ? `
    <p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">复制到 Spark Code，它会帮你配置好。</p>
    <div class="features-section">
      ${suggestions.features_to_try
        .map(
          feat => `
        <div class="feature-card">
          <div class="feature-title">${escapeHtml(feat.feature || '')}</div>
          <div class="feature-oneliner">${escapeHtml(feat.one_liner || '')}</div>
          <div class="feature-why"><strong>为什么适合你：</strong> ${escapeHtml(feat.why_for_you || '')}</div>
          ${
            feat.example_code
              ? `
          <div class="feature-examples">
            <div class="feature-example">
              <div class="example-code-row">
                <code class="example-code">${escapeHtml(feat.example_code)}</code>
                <button class="copy-btn" onclick="copyText(this)">复制</button>
              </div>
            </div>
          </div>
          `
              : ''
          }
        </div>
      `,
        )
        .join('')}
    </div>
    `
        : ''
    }
    ${
      suggestions.usage_patterns && suggestions.usage_patterns.length > 0
        ? `
    <h2 id="section-patterns">新的使用方式</h2>
    <p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">复制到 Spark Code，它会带你完成。</p>
    <div class="patterns-section">
      ${suggestions.usage_patterns
        .map(
          pat => `
        <div class="pattern-card">
          <div class="pattern-title">${escapeHtml(pat.title || '')}</div>
          <div class="pattern-summary">${escapeHtml(pat.suggestion || '')}</div>
          ${pat.detail ? `<div class="pattern-detail">${escapeHtml(pat.detail)}</div>` : ''}
          ${
            pat.copyable_prompt
              ? `
          <div class="copyable-prompt-section">
            <div class="prompt-label">粘贴到 Spark Code：</div>
            <div class="copyable-prompt-row">
              <code class="copyable-prompt">${escapeHtml(pat.copyable_prompt)}</code>
              <button class="copy-btn" onclick="copyText(this)">复制</button>
            </div>
          </div>
          `
              : ''
          }
        </div>
      `,
        )
        .join('')}
    </div>
    `
        : ''
    }
    `
    : ''

  // Build On the Horizon section
  const horizonData = insights.on_the_horizon
  const horizonHtml =
    horizonData?.opportunities && horizonData.opportunities.length > 0
      ? `
    <h2 id="section-horizon">接下来可以尝试</h2>
    ${horizonData.intro ? `<p class="section-intro">${escapeHtml(horizonData.intro)}</p>` : ''}
    <div class="horizon-section">
      ${horizonData.opportunities
        .map(
          opp => `
        <div class="horizon-card">
          <div class="horizon-title">${escapeHtml(opp.title || '')}</div>
          <div class="horizon-possible">${escapeHtml(opp.whats_possible || '')}</div>
          ${opp.how_to_try ? `<div class="horizon-tip"><strong>怎么开始：</strong> ${escapeHtml(opp.how_to_try)}</div>` : ''}
          ${opp.copyable_prompt ? `<div class="pattern-prompt"><div class="prompt-label">粘贴到 Spark Code：</div><code>${escapeHtml(opp.copyable_prompt)}</code><button class="copy-btn" onclick="copyText(this)">复制</button></div>` : ''}
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  // Build Team Feedback section (collapsible, ant-only)
  const ccImprovements =
    process.env.USER_TYPE === 'ant'
      ? insights.cc_team_improvements?.improvements || []
      : []
  const modelImprovements =
    process.env.USER_TYPE === 'ant'
      ? insights.model_behavior_improvements?.improvements || []
      : []
  const teamFeedbackHtml =
    ccImprovements.length > 0 || modelImprovements.length > 0
      ? `
    <h2 id="section-feedback" class="feedback-header">给产品和模型团队的反馈</h2>
    <p class="feedback-intro">基于你的使用模式整理的建议，点击可展开。</p>
    ${
      ccImprovements.length > 0
        ? `
    <div class="collapsible-section">
      <div class="collapsible-header" onclick="toggleCollapsible(this)">
        <span class="collapsible-arrow">▶</span>
        <h3>给产品团队的改进建议</h3>
      </div>
      <div class="collapsible-content">
        <div class="suggestions-section">
          ${ccImprovements
            .map(
              imp => `
            <div class="feedback-card team-card">
              <div class="feedback-title">${escapeHtml(imp.title || '')}</div>
              <div class="feedback-detail">${escapeHtml(imp.detail || '')}</div>
              ${imp.evidence ? `<div class="feedback-evidence"><em>依据：</em> ${escapeHtml(imp.evidence)}</div>` : ''}
            </div>
          `,
            )
            .join('')}
        </div>
      </div>
    </div>
    `
        : ''
    }
    ${
      modelImprovements.length > 0
        ? `
    <div class="collapsible-section">
      <div class="collapsible-header" onclick="toggleCollapsible(this)">
        <span class="collapsible-arrow">▶</span>
        <h3>给模型行为的改进建议</h3>
      </div>
      <div class="collapsible-content">
        <div class="suggestions-section">
          ${modelImprovements
            .map(
              imp => `
            <div class="feedback-card model-card">
              <div class="feedback-title">${escapeHtml(imp.title || '')}</div>
              <div class="feedback-detail">${escapeHtml(imp.detail || '')}</div>
              ${imp.evidence ? `<div class="feedback-evidence"><em>依据：</em> ${escapeHtml(imp.evidence)}</div>` : ''}
            </div>
          `,
            )
            .join('')}
        </div>
      </div>
    </div>
    `
        : ''
    }
    `
      : ''

  // Build Fun Ending section
  const funEnding = insights.fun_ending
  const funEndingHtml = funEnding?.headline
    ? `
    <div class="fun-ending">
      <div class="fun-headline">"${escapeHtml(funEnding.headline)}"</div>
      ${funEnding.detail ? `<div class="fun-detail">${escapeHtml(funEnding.detail)}</div>` : ''}
    </div>
    `
    : ''

  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f8fafc; color: #334155; line-height: 1.65; padding: 48px 24px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 32px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
    h2 { font-size: 20px; font-weight: 600; color: #0f172a; margin-top: 48px; margin-bottom: 16px; }
    .subtitle { color: #64748b; font-size: 15px; margin-bottom: 32px; }
    .nav-toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 32px 0; padding: 16px; background: white; border-radius: 8px; border: 1px solid #e2e8f0; }
    .nav-toc a { font-size: 12px; color: #64748b; text-decoration: none; padding: 6px 12px; border-radius: 6px; background: #f1f5f9; transition: all 0.15s; }
    .nav-toc a:hover { background: #e2e8f0; color: #334155; }
    .stats-row { display: flex; gap: 24px; margin-bottom: 40px; padding: 20px 0; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
    .stat { text-align: center; }
    .stat-value { font-size: 24px; font-weight: 700; color: #0f172a; }
    .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; }
    .at-a-glance { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #f59e0b; border-radius: 12px; padding: 20px 24px; margin-bottom: 32px; }
    .glance-title { font-size: 16px; font-weight: 700; color: #92400e; margin-bottom: 16px; }
    .glance-sections { display: flex; flex-direction: column; gap: 12px; }
    .glance-section { font-size: 14px; color: #78350f; line-height: 1.6; }
    .glance-section strong { color: #92400e; }
    .see-more { color: #b45309; text-decoration: none; font-size: 13px; white-space: nowrap; }
    .see-more:hover { text-decoration: underline; }
    .project-areas { display: flex; flex-direction: column; gap: 12px; margin-bottom: 32px; }
    .project-area { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .area-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .area-name { font-weight: 600; font-size: 15px; color: #0f172a; }
    .area-count { font-size: 12px; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 4px; }
    .area-desc { font-size: 14px; color: #475569; line-height: 1.5; }
    .narrative { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .narrative p { margin-bottom: 12px; font-size: 14px; color: #475569; line-height: 1.7; }
    .key-insight { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 14px; color: #166534; }
    .section-intro { font-size: 14px; color: #64748b; margin-bottom: 16px; }
    .big-wins { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
    .big-win { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; }
    .big-win-title { font-weight: 600; font-size: 15px; color: #166534; margin-bottom: 8px; }
    .big-win-desc { font-size: 14px; color: #15803d; line-height: 1.5; }
    .friction-categories { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
    .friction-category { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; }
    .friction-title { font-weight: 600; font-size: 15px; color: #991b1b; margin-bottom: 6px; }
    .friction-desc { font-size: 13px; color: #7f1d1d; margin-bottom: 10px; }
    .friction-examples { margin: 0 0 0 20px; font-size: 13px; color: #334155; }
    .friction-examples li { margin-bottom: 4px; }
    .claude-md-section { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
    .claude-md-section h3 { font-size: 14px; font-weight: 600; color: #1e40af; margin: 0 0 12px 0; }
    .claude-md-actions { margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #dbeafe; }
    .copy-all-btn { background: #2563eb; color: white; border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-weight: 500; transition: all 0.2s; }
    .copy-all-btn:hover { background: #1d4ed8; }
    .copy-all-btn.copied { background: #16a34a; }
    .claude-md-item { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; padding: 10px 0; border-bottom: 1px solid #dbeafe; }
    .claude-md-item:last-child { border-bottom: none; }
    .cmd-checkbox { margin-top: 2px; }
    .cmd-code { background: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; color: #1e40af; border: 1px solid #bfdbfe; font-family: monospace; display: block; white-space: pre-wrap; word-break: break-word; flex: 1; }
    .cmd-why { font-size: 12px; color: #64748b; width: 100%; padding-left: 24px; margin-top: 4px; }
    .features-section, .patterns-section { display: flex; flex-direction: column; gap: 12px; margin: 16px 0; }
    .feature-card { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; }
    .pattern-card { background: #f0f9ff; border: 1px solid #7dd3fc; border-radius: 8px; padding: 16px; }
    .feature-title, .pattern-title { font-weight: 600; font-size: 15px; color: #0f172a; margin-bottom: 6px; }
    .feature-oneliner { font-size: 14px; color: #475569; margin-bottom: 8px; }
    .pattern-summary { font-size: 14px; color: #475569; margin-bottom: 8px; }
    .feature-why, .pattern-detail { font-size: 13px; color: #334155; line-height: 1.5; }
    .feature-examples { margin-top: 12px; }
    .feature-example { padding: 8px 0; border-top: 1px solid #d1fae5; }
    .feature-example:first-child { border-top: none; }
    .example-desc { font-size: 13px; color: #334155; margin-bottom: 6px; }
    .example-code-row { display: flex; align-items: flex-start; gap: 8px; }
    .example-code { flex: 1; background: #f1f5f9; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155; overflow-x: auto; white-space: pre-wrap; }
    .copyable-prompt-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e2e8f0; }
    .copyable-prompt-row { display: flex; align-items: flex-start; gap: 8px; }
    .copyable-prompt { flex: 1; background: #f8fafc; padding: 10px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155; border: 1px solid #e2e8f0; white-space: pre-wrap; line-height: 1.5; }
    .feature-code { background: #f8fafc; padding: 12px; border-radius: 6px; margin-top: 12px; border: 1px solid #e2e8f0; display: flex; align-items: flex-start; gap: 8px; }
    .feature-code code { flex: 1; font-family: monospace; font-size: 12px; color: #334155; white-space: pre-wrap; }
    .pattern-prompt { background: #f8fafc; padding: 12px; border-radius: 6px; margin-top: 12px; border: 1px solid #e2e8f0; }
    .pattern-prompt code { font-family: monospace; font-size: 12px; color: #334155; display: block; white-space: pre-wrap; margin-bottom: 8px; }
    .prompt-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; margin-bottom: 6px; }
    .copy-btn { background: #e2e8f0; border: none; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; color: #475569; flex-shrink: 0; }
    .copy-btn:hover { background: #cbd5e1; }
    .charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
    .chart-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .chart-title { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-bottom: 12px; }
    .bar-row { display: flex; align-items: center; margin-bottom: 6px; }
    .bar-label { width: 100px; font-size: 11px; color: #475569; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { flex: 1; height: 6px; background: #f1f5f9; border-radius: 3px; margin: 0 8px; }
    .bar-fill { height: 100%; border-radius: 3px; }
    .bar-value { width: 28px; font-size: 11px; font-weight: 500; color: #64748b; text-align: right; }
    .empty { color: #94a3b8; font-size: 13px; }
    .horizon-section { display: flex; flex-direction: column; gap: 16px; }
    .horizon-card { background: linear-gradient(135deg, #faf5ff 0%, #f5f3ff 100%); border: 1px solid #c4b5fd; border-radius: 8px; padding: 16px; }
    .horizon-title { font-weight: 600; font-size: 15px; color: #5b21b6; margin-bottom: 8px; }
    .horizon-possible { font-size: 14px; color: #334155; margin-bottom: 10px; line-height: 1.5; }
    .horizon-tip { font-size: 13px; color: #6b21a8; background: rgba(255,255,255,0.6); padding: 8px 12px; border-radius: 4px; }
    .feedback-header { margin-top: 48px; color: #64748b; font-size: 16px; }
    .feedback-intro { font-size: 13px; color: #94a3b8; margin-bottom: 16px; }
    .feedback-section { margin-top: 16px; }
    .feedback-section h3 { font-size: 14px; font-weight: 600; color: #475569; margin-bottom: 12px; }
    .feedback-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .feedback-card.team-card { background: #eff6ff; border-color: #bfdbfe; }
    .feedback-card.model-card { background: #faf5ff; border-color: #e9d5ff; }
    .feedback-title { font-weight: 600; font-size: 14px; color: #0f172a; margin-bottom: 6px; }
    .feedback-detail { font-size: 13px; color: #475569; line-height: 1.5; }
    .feedback-evidence { font-size: 12px; color: #64748b; margin-top: 8px; }
    .fun-ending { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #fbbf24; border-radius: 12px; padding: 24px; margin-top: 40px; text-align: center; }
    .fun-headline { font-size: 18px; font-weight: 600; color: #78350f; margin-bottom: 8px; }
    .fun-detail { font-size: 14px; color: #92400e; }
    .collapsible-section { margin-top: 16px; }
    .collapsible-header { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
    .collapsible-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: #475569; }
    .collapsible-arrow { font-size: 12px; color: #94a3b8; transition: transform 0.2s; }
    .collapsible-content { display: none; padding-top: 16px; }
    .collapsible-content.open { display: block; }
    .collapsible-header.open .collapsible-arrow { transform: rotate(90deg); }
    @media (max-width: 640px) { .charts-row { grid-template-columns: 1fr; } .stats-row { justify-content: center; } }
  `

  const hourCountsJson = getHourCountsJson(data.message_hours)

  const js = `
    function toggleCollapsible(header) {
      header.classList.toggle('open');
      const content = header.nextElementSibling;
      content.classList.toggle('open');
    }
    function copyText(btn) {
      const code = btn.previousElementSibling;
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 2000);
      });
    }
    function copyCmdItem(idx) {
      const checkbox = document.getElementById('cmd-' + idx);
      if (checkbox) {
        const text = checkbox.dataset.text;
        navigator.clipboard.writeText(text).then(() => {
          const btn = checkbox.nextElementSibling.querySelector('.copy-btn');
          if (btn) { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 2000); }
        });
      }
    }
    function copyAllCheckedClaudeMd() {
      const checkboxes = document.querySelectorAll('.cmd-checkbox:checked');
      const texts = [];
      checkboxes.forEach(cb => {
        if (cb.dataset.text) { texts.push(cb.dataset.text); }
      });
      const combined = texts.join('\\n');
      const btn = document.querySelector('.copy-all-btn');
      if (btn) {
        navigator.clipboard.writeText(combined).then(() => {
          btn.textContent = '已复制 ' + texts.length + ' 项';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = '复制所有已选项'; btn.classList.remove('copied'); }, 2000);
        });
      }
    }
    // Timezone selector for time of day chart (data is from our own analytics, not user input)
    const rawHourCounts = ${hourCountsJson};
    function updateHourHistogram(offsetFromPT) {
      const periods = [
        { label: "早晨（6-12）", range: [6,7,8,9,10,11] },
        { label: "下午（12-18）", range: [12,13,14,15,16,17] },
        { label: "晚上（18-24）", range: [18,19,20,21,22,23] },
        { label: "深夜（0-6）", range: [0,1,2,3,4,5] }
      ];
      const adjustedCounts = {};
      for (const [hour, count] of Object.entries(rawHourCounts)) {
        const newHour = (parseInt(hour) + offsetFromPT + 24) % 24;
        adjustedCounts[newHour] = (adjustedCounts[newHour] || 0) + count;
      }
      const periodCounts = periods.map(p => ({
        label: p.label,
        count: p.range.reduce((sum, h) => sum + (adjustedCounts[h] || 0), 0)
      }));
      const maxCount = Math.max(...periodCounts.map(p => p.count)) || 1;
      const container = document.getElementById('hour-histogram');
      container.textContent = '';
      periodCounts.forEach(p => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        const label = document.createElement('div');
        label.className = 'bar-label';
        label.textContent = p.label;
        const track = document.createElement('div');
        track.className = 'bar-track';
        const fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = (p.count / maxCount) * 100 + '%';
        fill.style.background = '#8b5cf6';
        track.appendChild(fill);
        const value = document.createElement('div');
        value.className = 'bar-value';
        value.textContent = p.count;
        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(value);
        container.appendChild(row);
      });
    }
    document.getElementById('timezone-select').addEventListener('change', function() {
      const customInput = document.getElementById('custom-offset');
      if (this.value === 'custom') {
        customInput.style.display = 'inline-block';
        customInput.focus();
      } else {
        customInput.style.display = 'none';
        updateHourHistogram(parseInt(this.value));
      }
    });
    document.getElementById('custom-offset').addEventListener('change', function() {
      const offset = parseInt(this.value) + 8;
      updateHourHistogram(offset);
    });
  `

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Spark Code 使用洞察</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${css}</style>
</head>
<body>
  <div class="container">
    <h1>Spark Code 使用洞察</h1>
    <p class="subtitle">${data.total_messages.toLocaleString()} 条消息，来自 ${data.total_sessions} 次会话${data.total_sessions_scanned && data.total_sessions_scanned > data.total_sessions ? `（共扫描 ${data.total_sessions_scanned.toLocaleString()} 次）` : ''} | ${data.date_range.start} 至 ${data.date_range.end}</p>

    ${atAGlanceHtml}

    <nav class="nav-toc">
      <a href="#section-work">你主要做什么</a>
      <a href="#section-usage">怎么使用</a>
      <a href="#section-wins">做得不错的事</a>
      <a href="#section-friction">容易出问题的地方</a>
      <a href="#section-features">可以试的功能</a>
      <a href="#section-patterns">新的使用方式</a>
      <a href="#section-horizon">接下来尝试</a>
      <a href="#section-feedback">团队反馈</a>
    </nav>

    <div class="stats-row">
      <div class="stat"><div class="stat-value">${data.total_messages.toLocaleString()}</div><div class="stat-label">消息</div></div>
      <div class="stat"><div class="stat-value">+${data.total_lines_added.toLocaleString()}/-${data.total_lines_removed.toLocaleString()}</div><div class="stat-label">行数</div></div>
      <div class="stat"><div class="stat-value">${data.total_files_modified}</div><div class="stat-label">文件</div></div>
      <div class="stat"><div class="stat-value">${data.days_active}</div><div class="stat-label">天数</div></div>
      <div class="stat"><div class="stat-value">${data.messages_per_day}</div><div class="stat-label">消息/天</div></div>
    </div>

    ${projectAreasHtml}

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">你想完成什么</div>
        ${generateBarChart(data.goal_categories, '#2563eb')}
      </div>
      <div class="chart-card">
        <div class="chart-title">最常用工具</div>
        ${generateBarChart(data.tool_counts, '#0891b2')}
      </div>
    </div>

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">语言</div>
        ${generateBarChart(data.languages, '#10b981')}
      </div>
      <div class="chart-card">
        <div class="chart-title">会话类型</div>
        ${generateBarChart(data.session_types || {}, '#8b5cf6')}
      </div>
    </div>

    ${interactionHtml}

    <!-- Response Time Distribution -->
    <div class="chart-card" style="margin: 24px 0;">
      <div class="chart-title">用户响应时间分布</div>
      ${generateResponseTimeHistogram(data.user_response_times)}
      <div style="font-size: 12px; color: #64748b; margin-top: 8px;">
        中位数：${data.median_response_time.toFixed(1)} 秒 &bull; 平均：${data.avg_response_time.toFixed(1)} 秒
      </div>
    </div>

    <!-- Multi-clauding Section (matching Python reference) -->
    <div class="chart-card" style="margin: 24px 0;">
      <div class="chart-title">多会话并行</div>
      ${
        data.multi_clauding.overlap_events === 0
          ? `
        <p style="font-size: 14px; color: #64748b; padding: 8px 0;">
          未检测到并行会话。你通常一次只使用一个 Spark Code 会话。
        </p>
      `
          : `
        <div style="display: flex; gap: 24px; margin: 12px 0;">
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #7c3aed;">${data.multi_clauding.overlap_events}</div>
            <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">重叠事件</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #7c3aed;">${data.multi_clauding.sessions_involved}</div>
            <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">涉及会话</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #7c3aed;">${data.total_messages > 0 ? Math.round((100 * data.multi_clauding.user_messages_during) / data.total_messages) : 0}%</div>
            <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">消息占比</div>
          </div>
        </div>
        <p style="font-size: 13px; color: #475569; margin-top: 12px;">
          你会同时运行多个 Spark Code 会话。当会话时间重叠时，会被识别为并行工作流。
        </p>
      `
      }
    </div>

    <!-- Time of Day & Tool Errors -->
    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title" style="display: flex; align-items: center; gap: 12px;">
          按时间段统计的用户消息
          <select id="timezone-select" style="font-size: 12px; padding: 4px 8px; border-radius: 4px; border: 1px solid #e2e8f0;">
            <option value="0">PT (UTC-8)</option>
            <option value="3">ET (UTC-5)</option>
            <option value="8">伦敦 (UTC)</option>
            <option value="9">CET (UTC+1)</option>
            <option value="17">东京 (UTC+9)</option>
            <option value="custom">自定义偏移...</option>
          </select>
          <input type="number" id="custom-offset" placeholder="UTC 偏移" style="display: none; width: 80px; font-size: 12px; padding: 4px; border-radius: 4px; border: 1px solid #e2e8f0;">
        </div>
        ${generateTimeOfDayChart(data.message_hours)}
      </div>
      <div class="chart-card">
        <div class="chart-title">遇到的工具错误</div>
        ${Object.keys(data.tool_error_categories).length > 0 ? generateBarChart(data.tool_error_categories, '#dc2626') : '<p class="empty">没有工具错误</p>'}
      </div>
    </div>

    ${whatWorksHtml}

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">最有帮助的能力</div>
        ${generateBarChart(data.success, '#16a34a')}
      </div>
      <div class="chart-card">
        <div class="chart-title">完成结果</div>
        ${generateBarChart(data.outcomes, '#8b5cf6', 6, OUTCOME_ORDER)}
      </div>
    </div>

    ${frictionHtml}

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">主要阻塞类型</div>
        ${generateBarChart(data.friction, '#dc2626')}
      </div>
      <div class="chart-card">
        <div class="chart-title">推断满意度（模型估算）</div>
        ${generateBarChart(data.satisfaction, '#eab308', 6, SATISFACTION_ORDER)}
      </div>
    </div>

    ${suggestionsHtml}

    ${horizonHtml}

    ${funEndingHtml}

    ${teamFeedbackHtml}
  </div>
  <script>${js}</script>
</body>
</html>`
}

// ============================================================================
// Export Types & Functions
// ============================================================================

/**
 * Structured export format for claudescope consumption
 */
export type InsightsExport = {
  metadata: {
    username: string
    generated_at: string
    claude_code_version: string
    date_range: { start: string; end: string }
    session_count: number
    remote_hosts_collected?: string[]
  }
  aggregated_data: AggregatedData
  insights: InsightResults
  facets_summary?: {
    total: number
    goal_categories: Record<string, number>
    outcomes: Record<string, number>
    satisfaction: Record<string, number>
    friction: Record<string, number>
  }
}

/**
 * Build export data from already-computed values.
 * Used by background upload to S3.
 */
export function buildExportData(
  data: AggregatedData,
  insights: InsightResults,
  facets: Map<string, SessionFacets>,
  remoteStats?: { hosts: RemoteHostInfo[]; totalCopied: number },
): InsightsExport {
  const version = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

  const remote_hosts_collected = remoteStats?.hosts
    .filter(h => h.sessionCount > 0)
    .map(h => h.name)

  const facets_summary = {
    total: facets.size,
    goal_categories: {} as Record<string, number>,
    outcomes: {} as Record<string, number>,
    satisfaction: {} as Record<string, number>,
    friction: {} as Record<string, number>,
  }
  for (const f of facets.values()) {
    for (const [cat, count] of safeEntries(f.goal_categories)) {
      if (count > 0) {
        facets_summary.goal_categories[cat] =
          (facets_summary.goal_categories[cat] || 0) + count
      }
    }
    facets_summary.outcomes[f.outcome] =
      (facets_summary.outcomes[f.outcome] || 0) + 1
    for (const [level, count] of safeEntries(f.user_satisfaction_counts)) {
      if (count > 0) {
        facets_summary.satisfaction[level] =
          (facets_summary.satisfaction[level] || 0) + count
      }
    }
    for (const [type, count] of safeEntries(f.friction_counts)) {
      if (count > 0) {
        facets_summary.friction[type] =
          (facets_summary.friction[type] || 0) + count
      }
    }
  }

  return {
    metadata: {
      username: process.env.SAFEUSER || process.env.USER || 'unknown',
      generated_at: new Date().toISOString(),
      claude_code_version: version,
      date_range: data.date_range,
      session_count: data.total_sessions,
      ...(remote_hosts_collected &&
        remote_hosts_collected.length > 0 && {
          remote_hosts_collected,
        }),
    },
    aggregated_data: data,
    insights,
    facets_summary,
  }
}

// ============================================================================
// Lite Session Scanning
// ============================================================================

type LiteSessionInfo = {
  sessionId: string
  path: string
  mtime: number
  size: number
}

/**
 * Scans all project directories using filesystem metadata only (no JSONL parsing).
 * Returns a list of session file info sorted by mtime descending.
 * Yields to the event loop between project directories to keep the UI responsive.
 */
async function scanAllSessions(): Promise<LiteSessionInfo[]> {
  const projectsDir = getProjectsDir()

  let dirents: Awaited<ReturnType<typeof readdir>>
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const allSessions: LiteSessionInfo[] = []

  for (let i = 0; i < projectDirs.length; i++) {
    const sessionFiles = await getSessionFilesWithMtime(projectDirs[i]!)
    for (const [sessionId, fileInfo] of sessionFiles) {
      allSessions.push({
        sessionId,
        path: fileInfo.path,
        mtime: fileInfo.mtime,
        size: fileInfo.size,
      })
    }
    // Yield to event loop every 10 project directories
    if (i % 10 === 9) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  // Sort by mtime descending (most recent first)
  allSessions.sort((a, b) => b.mtime - a.mtime)
  return allSessions
}

// ============================================================================
// Main Function
// ============================================================================

export async function generateUsageReport(options?: {
  collectRemote?: boolean
}): Promise<{
  insights: InsightResults
  htmlPath: string
  data: AggregatedData
  remoteStats?: { hosts: RemoteHostInfo[]; totalCopied: number }
  facets: Map<string, SessionFacets>
}> {
  let remoteStats: { hosts: RemoteHostInfo[]; totalCopied: number } | undefined

  // Optionally collect data from remote hosts first (ant-only)
  if (process.env.USER_TYPE === 'ant' && options?.collectRemote) {
    const destDir = join(getClaudeConfigHomeDir(), 'projects')
    const { hosts, totalCopied } = await collectAllRemoteHostData(destDir)
    remoteStats = { hosts, totalCopied }
  }

  // Phase 1: Lite scan — filesystem metadata only (no JSONL parsing)
  const allScannedSessions = await scanAllSessions()
  const totalSessionsScanned = allScannedSessions.length

  // Phase 2: Load SessionMeta — use cache where available, parse only uncached
  // Read cached metas in parallel batches to avoid blocking the event loop
  const META_BATCH_SIZE = 50
  const MAX_SESSIONS_TO_LOAD = 200
  let allMetas: SessionMeta[] = []
  const uncachedSessions: LiteSessionInfo[] = []

  for (let i = 0; i < allScannedSessions.length; i += META_BATCH_SIZE) {
    const batch = allScannedSessions.slice(i, i + META_BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async sessionInfo => ({
        sessionInfo,
        cached: await loadCachedSessionMeta(sessionInfo.sessionId),
      })),
    )
    for (const { sessionInfo, cached } of results) {
      if (cached) {
        allMetas.push(cached)
      } else if (uncachedSessions.length < MAX_SESSIONS_TO_LOAD) {
        uncachedSessions.push(sessionInfo)
      }
    }
  }

  // Load full message data only for uncached sessions and compute SessionMeta
  const logsForFacets = new Map<string, LogOption>()

  // Filter out /insights meta-sessions (facet extraction API calls get logged as sessions)
  const isMetaSession = (log: LogOption): boolean => {
    for (const msg of log.messages.slice(0, 5)) {
      if (msg.type === 'user' && msg.message) {
        const content = msg.message.content
        if (typeof content === 'string') {
          if (
            content.includes('RESPOND WITH ONLY A VALID JSON OBJECT') ||
            content.includes('record_facets')
          ) {
            return true
          }
        }
      }
    }
    return false
  }

  // Load uncached sessions in batches to yield to event loop between batches
  const LOAD_BATCH_SIZE = 10
  for (let i = 0; i < uncachedSessions.length; i += LOAD_BATCH_SIZE) {
    const batch = uncachedSessions.slice(i, i + LOAD_BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async sessionInfo => {
        try {
          return await loadAllLogsFromSessionFile(sessionInfo.path)
        } catch {
          return []
        }
      }),
    )
    // Collect metas synchronously, then save them in parallel (independent writes)
    const metasToSave: SessionMeta[] = []
    for (const logs of batchResults) {
      for (const log of logs) {
        if (isMetaSession(log) || !hasValidDates(log)) continue
        const meta = logToSessionMeta(log)
        allMetas.push(meta)
        metasToSave.push(meta)
        // Keep the log around for potential facet extraction
        logsForFacets.set(meta.session_id, log)
      }
    }
    await Promise.all(metasToSave.map(meta => saveSessionMeta(meta)))
  }

  // Deduplicate session branches (keep the one with most user messages per session_id)
  // This prevents inflated totals when a session has multiple conversation branches
  const bestBySession = new Map<string, SessionMeta>()
  for (const meta of allMetas) {
    const existing = bestBySession.get(meta.session_id)
    if (
      !existing ||
      meta.user_message_count > existing.user_message_count ||
      (meta.user_message_count === existing.user_message_count &&
        meta.duration_minutes > existing.duration_minutes)
    ) {
      bestBySession.set(meta.session_id, meta)
    }
  }
  // Replace allMetas with deduplicated list and remove unused logs from logsForFacets
  const keptSessionIds = new Set(bestBySession.keys())
  allMetas = [...bestBySession.values()]
  for (const sessionId of logsForFacets.keys()) {
    if (!keptSessionIds.has(sessionId)) {
      logsForFacets.delete(sessionId)
    }
  }

  // Sort all metas by start_time descending (most recent first)
  allMetas.sort((a, b) => b.start_time.localeCompare(a.start_time))

  // Pre-filter obviously minimal sessions to save API calls
  // (matching Python's substantive filtering concept)
  const isSubstantiveSession = (meta: SessionMeta): boolean => {
    // Skip sessions with very few user messages
    if (meta.user_message_count < 2) return false
    // Skip very short sessions (< 1 minute)
    if (meta.duration_minutes < 1) return false
    return true
  }

  const substantiveMetas = allMetas.filter(isSubstantiveSession)

  // Phase 3: Facet extraction — only for sessions without cached facets
  const facets = new Map<string, SessionFacets>()
  const toExtract: Array<{ log: LogOption; sessionId: string }> = []
  const MAX_FACET_EXTRACTIONS = 50

  // Load cached facets for all substantive sessions in parallel
  const cachedFacetResults = await Promise.all(
    substantiveMetas.map(async meta => ({
      sessionId: meta.session_id,
      cached: await loadCachedFacets(meta.session_id),
    })),
  )
  for (const { sessionId, cached } of cachedFacetResults) {
    if (cached) {
      facets.set(sessionId, cached)
    } else {
      const log = logsForFacets.get(sessionId)
      if (log && toExtract.length < MAX_FACET_EXTRACTIONS) {
        toExtract.push({ log, sessionId })
      }
    }
  }

  // Extract facets for sessions that need them (50 concurrent)
  const CONCURRENCY = 50
  for (let i = 0; i < toExtract.length; i += CONCURRENCY) {
    const batch = toExtract.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async ({ log, sessionId }) => {
        const newFacets = await extractFacetsFromAPI(log, sessionId)
        return { sessionId, newFacets }
      }),
    )
    // Collect facets synchronously, save in parallel (independent writes)
    const facetsToSave: SessionFacets[] = []
    for (const { sessionId, newFacets } of results) {
      if (newFacets) {
        facets.set(sessionId, newFacets)
        facetsToSave.push(newFacets)
      }
    }
    await Promise.all(facetsToSave.map(f => saveFacets(f)))
  }

  // Filter out warmup/minimal sessions (matching Python's is_minimal)
  // A session is minimal if warmup_minimal is the ONLY goal category
  const isMinimalSession = (sessionId: string): boolean => {
    const sessionFacets = facets.get(sessionId)
    if (!sessionFacets) return false
    const cats = sessionFacets.goal_categories
    const catKeys = safeKeys(cats).filter(k => (cats[k] ?? 0) > 0)
    return catKeys.length === 1 && catKeys[0] === 'warmup_minimal'
  }

  const substantiveSessions = substantiveMetas.filter(
    s => !isMinimalSession(s.session_id),
  )

  const substantiveFacets = new Map<string, SessionFacets>()
  for (const [sessionId, f] of facets) {
    if (!isMinimalSession(sessionId)) {
      substantiveFacets.set(sessionId, f)
    }
  }

  const aggregated = aggregateData(substantiveSessions, substantiveFacets)
  aggregated.total_sessions_scanned = totalSessionsScanned

  // Generate parallel insights from Claude (6 sections)
  const insights = await generateParallelInsights(aggregated, facets)

  // Generate HTML report
  const htmlReport = generateHtmlReport(aggregated, insights)

  // Save reports
  try {
    await mkdir(getDataDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }

  const htmlPath = join(getDataDir(), 'report.html')
  await writeFile(htmlPath, htmlReport, {
    encoding: 'utf-8',
    mode: 0o600,
  })

  return {
    insights,
    htmlPath,
    data: aggregated,
    remoteStats,
    facets: substantiveFacets,
  }
}

function safeEntries<V>(
  obj: Record<string, V> | undefined | null,
): [string, V][] {
  return obj ? Object.entries(obj) : []
}

function safeKeys(obj: Record<string, unknown> | undefined | null): string[] {
  return obj ? Object.keys(obj) : []
}

// ============================================================================
// Command Definition
// ============================================================================

const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: '生成 Spark Code 会话分析报告',
  contentLength: 0, // Dynamic content
  progressMessage: '正在分析你的会话',
  source: 'builtin',
  async getPromptForCommand(args) {
    let collectRemote = false
    let remoteHosts: string[] = []
    let hasRemoteHosts = false

    if (process.env.USER_TYPE === 'ant') {
      // Parse --homespaces flag
      collectRemote = args?.includes('--homespaces') ?? false

      // Check for available remote hosts
      remoteHosts = await getRunningRemoteHosts()
      hasRemoteHosts = remoteHosts.length > 0

      // Show collection message if collecting
      if (collectRemote && hasRemoteHosts) {
        // biome-ignore lint/suspicious/noConsole: intentional
        console.error(
          `正在从 ${remoteHosts.length} 个 homespace 收集会话：${remoteHosts.join(', ')}...`,
        )
      }
    }

    const { insights, htmlPath, data, remoteStats } = await generateUsageReport(
      { collectRemote },
    )

    let reportUrl = `file://${htmlPath}`
    let uploadHint = ''

    if (process.env.USER_TYPE === 'ant') {
      // Try to upload to S3
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '_')
        .slice(0, 15)
      const username = process.env.SAFEUSER || process.env.USER || 'unknown'
      const filename = `${username}_insights_${timestamp}.html`
      const s3Path = `s3://anthropic-serve/atamkin/cc-user-reports/${filename}`
      const s3Url = `https://s3-frontend.infra.ant.dev/anthropic-serve/atamkin/cc-user-reports/${filename}`

      reportUrl = s3Url
      try {
        execFileSync('ff', ['cp', htmlPath, s3Path], {
          timeout: 60000,
          stdio: 'pipe', // Suppress output
        })
      } catch {
        // Upload failed - fall back to local file and show upload command
        reportUrl = `file://${htmlPath}`
        uploadHint = `\n自动上传失败。请确认你在 boron namespace，可尝试 \`use-bo\`，并确认已经运行过 \`sso\`。
如需分享，请运行：ff cp ${htmlPath} ${s3Path}
然后访问：${s3Url}`
      }
    }

    // Build header with stats
    const sessionLabel =
      data.total_sessions_scanned &&
      data.total_sessions_scanned > data.total_sessions
        ? `共 ${data.total_sessions_scanned.toLocaleString()} 次会话 · 已分析 ${data.total_sessions} 次`
        : `${data.total_sessions} 次会话`
    const stats = [
      sessionLabel,
      `${data.total_messages.toLocaleString()} 条消息`,
      `${Math.round(data.total_duration_hours)} 小时`,
      `${data.git_commits} 次提交`,
    ].join(' · ')

    // Build remote host info (ant-only)
    let remoteInfo = ''
    if (process.env.USER_TYPE === 'ant') {
      if (remoteStats && remoteStats.totalCopied > 0) {
        const hsNames = remoteStats.hosts
          .filter(h => h.sessionCount > 0)
          .map(h => h.name)
          .join(', ')
        remoteInfo = `\n_已从这些 homespace 收集 ${remoteStats.totalCopied} 个新会话：${hsNames}_\n`
      } else if (!collectRemote && hasRemoteHosts) {
        // Suggest using --homespaces if they have remote hosts but didn't use the flag
        remoteInfo = `\n_提示：运行 \`/insights --homespaces\` 可包含 ${remoteHosts.length} 个正在运行的 homespace 会话_\n`
      }
    }

    // Build markdown summary from insights
    const atAGlance = insights.at_a_glance
    const summaryText = atAGlance
      ? `## 快速概览

${atAGlance.whats_working ? `**有效的地方：**${atAGlance.whats_working} 见 _做得不错的事_。` : ''}

${atAGlance.whats_hindering ? `**卡住你的地方：**${atAGlance.whats_hindering} 见 _哪里容易出问题_。` : ''}

${atAGlance.quick_wins ? `**可以马上试的改进：**${atAGlance.quick_wins} 见 _可以试的功能_。` : ''}

${atAGlance.ambitious_workflows ? `**更进一步的工作流：**${atAGlance.ambitious_workflows} 见 _接下来可以尝试_。` : ''}`
      : '_未生成洞察_'

    const header = `# Spark Code 使用洞察

${stats}
${data.date_range.start} 至 ${data.date_range.end}
${remoteInfo}
`

    const userSummary = `${header}${summaryText}

可分享的完整洞察报告已生成：${reportUrl}${uploadHint}`

    // Return prompt for Claude to respond to
    return [
      {
        type: 'text',
        text: `用户刚刚运行 /insights，生成了一份分析 Spark Code 会话的使用报告。

以下是完整洞察数据：
${jsonStringify(insights, null, 2)}

报告 URL：${reportUrl}
HTML 文件：${htmlPath}
Facets 目录：${getFacetsDir()}

用户会看到：
${userSummary}

现在严格输出下面这段消息：

<message>
可分享的洞察报告已生成：
${reportUrl}${uploadHint}

要看某个章节，或者试试里面的某条建议吗？
</message>`,
      },
    ]
  },
}

function isValidSessionFacets(obj: unknown): obj is SessionFacets {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    typeof o.underlying_goal === 'string' &&
    typeof o.outcome === 'string' &&
    typeof o.brief_summary === 'string' &&
    o.goal_categories !== null &&
    typeof o.goal_categories === 'object' &&
    o.user_satisfaction_counts !== null &&
    typeof o.user_satisfaction_counts === 'object' &&
    o.friction_counts !== null &&
    typeof o.friction_counts === 'object'
  )
}

export default usageReport
