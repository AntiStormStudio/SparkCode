/**
 * Auto mode subcommand handlers — dump default/merged classifier rules and
 * critique user-written rules. Dynamically imported when `claude auto-mode ...` runs.
 */

import { errorMessage } from '../../utils/errors.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  type AutoModeRules,
  buildDefaultExternalSystemPrompt,
  getDefaultExternalAutoModeRules,
} from '../../utils/permissions/yoloClassifier.js'
import { getAutoModeConfig } from '../../utils/settings/settings.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonStringify } from '../../utils/slowOperations.js'

function writeRules(rules: AutoModeRules): void {
  process.stdout.write(jsonStringify(rules, null, 2) + '\n')
}

export function autoModeDefaultsHandler(): void {
  writeRules(getDefaultExternalAutoModeRules())
}

/**
 * Dump the effective auto mode config: user settings where provided, external
 * defaults otherwise. Per-section REPLACE semantics — matches how
 * buildYoloSystemPrompt resolves the external template (a non-empty user
 * section replaces that section's defaults entirely; an empty/absent section
 * falls through to defaults).
 */
export function autoModeConfigHandler(): void {
  const config = getAutoModeConfig()
  const defaults = getDefaultExternalAutoModeRules()
  writeRules({
    allow: config?.allow?.length ? config.allow : defaults.allow,
    soft_deny: config?.soft_deny?.length
      ? config.soft_deny
      : defaults.soft_deny,
    environment: config?.environment?.length
      ? config.environment
      : defaults.environment,
  })
}

const CRITIQUE_SYSTEM_PROMPT =
  '你是 Spark Code 自动模式分类规则的专家评审。\n' +
  '\n' +
  'Spark Code 的“自动模式”会使用 AI 分类器判断工具调用应该自动批准，' +
  '还是需要用户确认。用户可以在三类规则中编写自定义内容：\n' +
  '\n' +
  '- **allow**：分类器应自动批准的操作\n' +
  '- **soft_deny**：分类器应阻止并要求用户确认的操作\n' +
  '- **environment**：关于用户环境的上下文，用于帮助分类器决策\n' +
  '\n' +
  '你的任务是从清晰度、完整性和潜在问题角度评审用户的自定义规则。' +
  '分类器是一个 LLM，会把这些规则作为系统提示的一部分读取。\n' +
  '\n' +
  '请逐条评估：\n' +
  '1. **清晰度**：规则是否明确？分类器是否可能误解？\n' +
  '2. **完整性**：是否遗漏场景或边界情况？\n' +
  '3. **冲突**：规则之间是否互相冲突？\n' +
  '4. **可执行性**：规则是否足够具体，分类器能否据此行动？\n' +
  '\n' +
  '请保持简洁、建设性。只评论需要改进的规则；如果所有规则都没问题，请直接说明。'

export async function autoModeCritiqueHandler(options: {
  model?: string
}): Promise<void> {
  const config = getAutoModeConfig()
  const hasCustomRules =
    (config?.allow?.length ?? 0) > 0 ||
    (config?.soft_deny?.length ?? 0) > 0 ||
    (config?.environment?.length ?? 0) > 0

  if (!hasCustomRules) {
    process.stdout.write(
      '未找到自定义自动模式规则。\n\n' +
        '请在设置文件的 autoMode.{allow, soft_deny, environment} 下添加规则。\n' +
        '可运行 `sparkc auto-mode defaults` 查看默认规则作为参考。\n',
    )
    return
  }

  const model = options.model
    ? parseUserSpecifiedModel(options.model)
    : getMainLoopModel()

  const defaults = getDefaultExternalAutoModeRules()
  const classifierPrompt = buildDefaultExternalSystemPrompt()

  const userRulesSummary =
    formatRulesForCritique('allow', config?.allow ?? [], defaults.allow) +
    formatRulesForCritique(
      'soft_deny',
      config?.soft_deny ?? [],
      defaults.soft_deny,
    ) +
    formatRulesForCritique(
      'environment',
      config?.environment ?? [],
      defaults.environment,
    )

  process.stdout.write('正在分析你的自动模式规则…\n\n')

  let response
  try {
    response = await sideQuery({
      querySource: 'auto_mode_critique',
      model,
      system: CRITIQUE_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            '以下是自动模式分类器收到的完整系统提示：\n\n' +
            '<classifier_system_prompt>\n' +
            classifierPrompt +
            '\n</classifier_system_prompt>\n\n' +
            '以下是用户自定义规则，它们会替换对应的默认部分：\n\n' +
            userRulesSummary +
            '\n请评审这些自定义规则。',
        },
      ],
    })
  } catch (error) {
    process.stderr.write(
      '分析规则失败：' + errorMessage(error) + '\n',
    )
    process.exitCode = 1
    return
  }

  const textBlock = response.content.find(block => block.type === 'text')
  if (textBlock?.type === 'text') {
    process.stdout.write(textBlock.text + '\n')
  } else {
    process.stdout.write('没有生成评审结果，请重试。\n')
  }
}

function formatRulesForCritique(
  section: string,
  userRules: string[],
  defaultRules: string[],
): string {
  if (userRules.length === 0) return ''
  const customLines = userRules.map(r => '- ' + r).join('\n')
  const defaultLines = defaultRules.map(r => '- ' + r).join('\n')
  return (
    '## ' +
    section +
    '（自定义规则，将替换默认规则）\n' +
    '自定义：\n' +
    customLines +
    '\n\n' +
    '被替换的默认规则：\n' +
    defaultLines +
    '\n\n'
  )
}
