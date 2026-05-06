import type { ZodIssueCode } from 'zod/v4'

// v4 ZodIssueCode is a value, not a type - use typeof to get the type
type ZodIssueCodeType = (typeof ZodIssueCode)[keyof typeof ZodIssueCode]

export type ValidationTip = {
  suggestion?: string
  docLink?: string
}

export type TipContext = {
  path: string
  code: ZodIssueCodeType | string
  expected?: string
  received?: unknown
  enumValues?: string[]
  message?: string
  value?: unknown
}

type TipMatcher = {
  matches: (context: TipContext) => boolean
  tip: ValidationTip
}

const DOCUMENTATION_BASE = 'https://code.claude.com/docs/en'

const TIP_MATCHERS: TipMatcher[] = [
  {
    matches: (ctx): boolean =>
      ctx.path === 'permissions.defaultMode' && ctx.code === 'invalid_value',
    tip: {
      suggestion:
        '有效模式："acceptEdits"（修改文件前询问）、"plan"（仅分析）、"bypassPermissions"（自动接受全部）、"default"（标准行为）',
      docLink: `${DOCUMENTATION_BASE}/iam#permission-modes`,
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path === 'apiKeyHelper' && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        '请提供一个会把 API Key 输出到 stdout 的 shell 命令。脚本应只输出 API Key。示例："/bin/generate_temp_api_key.sh"',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path === 'cleanupPeriodDays' &&
      ctx.code === 'too_small' &&
      ctx.expected === '0',
    tip: {
      suggestion:
        '必须大于等于 0。填正数表示保留对话记录的天数（默认 30）。填 0 会完全关闭会话持久化：不写入新记录，并在启动时删除已有记录。',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path.startsWith('env.') && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        '环境变量必须是字符串。数字和布尔值请加引号。示例："DEBUG": "true", "PORT": "3000"',
      docLink: `${DOCUMENTATION_BASE}/settings#environment-variables`,
    },
  },
  {
    matches: (ctx): boolean =>
      (ctx.path === 'permissions.allow' || ctx.path === 'permissions.deny') &&
      ctx.code === 'invalid_type' &&
      ctx.expected === 'array',
    tip: {
      suggestion:
        '权限规则必须写在数组里。格式：["Tool(specifier)"]。示例：["Bash(npm run build)", "Edit(docs/**)", "Read(~/.zshrc)"]。可用 * 表示通配。',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path.includes('hooks') && ctx.code === 'invalid_type',
    tip: {
      suggestion:
        // gh-31187 / CC-282: prior example showed {"matcher": {"tools": ["BashTool"]}}
        // — an object format that never existed in the schema (matcher is z.string(),
        // always has been). Users copied the tip's example and got the same validation
        // error again. See matchesPattern() in hooks.ts: matcher is exact-match,
        // pipe-separated ("Edit|Write"), or regex. Empty/"*" matches all.
        'Hooks 使用 matcher + hooks 数组。matcher 是字符串：可以是工具名（"Bash"）、竖线分隔列表（"Edit|Write"），留空则匹配全部。示例：{"PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "echo Done"}]}]}',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.code === 'invalid_type' && ctx.expected === 'boolean',
    tip: {
      suggestion:
        '请使用不带引号的 true 或 false。示例："includeCoAuthoredBy": true',
    },
  },
  {
    matches: (ctx): boolean => ctx.code === 'unrecognized_keys',
    tip: {
      suggestion:
        '请检查拼写，或参考文档确认有效字段',
      docLink: `${DOCUMENTATION_BASE}/settings`,
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.code === 'invalid_value' && ctx.enumValues !== undefined,
    tip: {
      suggestion: undefined,
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.code === 'invalid_type' &&
      ctx.expected === 'object' &&
      ctx.received === null &&
      ctx.path === '',
    tip: {
      suggestion:
        '请检查是否缺少逗号、括号不匹配或存在尾随逗号。可用 JSON 校验器定位具体语法错误。',
    },
  },
  {
    matches: (ctx): boolean =>
      ctx.path === 'permissions.additionalDirectories' &&
      ctx.code === 'invalid_type',
    tip: {
      suggestion:
        '必须是目录路径数组。示例：["~/projects", "/tmp/workspace"]。也可以使用 --add-dir 参数或 /add-dir 命令。',
      docLink: `${DOCUMENTATION_BASE}/iam#working-directories`,
    },
  },
]

const PATH_DOC_LINKS: Record<string, string> = {
  permissions: `${DOCUMENTATION_BASE}/iam#configuring-permissions`,
  env: `${DOCUMENTATION_BASE}/settings#environment-variables`,
  hooks: `${DOCUMENTATION_BASE}/hooks`,
}

export function getValidationTip(context: TipContext): ValidationTip | null {
  const matcher = TIP_MATCHERS.find(m => m.matches(context))

  if (!matcher) return null

  const tip: ValidationTip = { ...matcher.tip }

  if (
    context.code === 'invalid_value' &&
    context.enumValues &&
    !tip.suggestion
  ) {
    tip.suggestion = `Valid values: ${context.enumValues.map(v => `"${v}"`).join(', ')}`
  }

  // Add documentation link based on path prefix
  if (!tip.docLink && context.path) {
    const pathPrefix = context.path.split('.')[0]
    if (pathPrefix) {
      tip.docLink = PATH_DOC_LINKS[pathPrefix]
    }
  }

  return tip
}
