import type { LocalCommandResult } from '../../types/command.js'
import {
  fetchBackendModelList,
  findBackendModelMatch,
} from '../../utils/model/backendModels.js'
import {
  deleteModelReflex,
  getModelReflexMap,
  setModelReflex,
} from '../../utils/model/modelReflex.js'

const USAGE =
  '用法：/model-reflex add <别名> <目标模型>\n' +
  '      /model-reflex delete <别名>\n\n' +
  '示例：/model-reflex add claude-opus-4-6 中转站.kimi-k2.6'

function text(value: string): LocalCommandResult {
  return { type: 'text', value }
}

function formatModelReflexList(): string {
  const entries = Object.entries(getModelReflexMap())
  if (entries.length === 0) {
    return `暂无模型映射。\n\n${USAGE}`
  }
  return ['模型映射：', ...entries.map(([alias, target]) => `${alias} => ${target}`)].join(
    '\n',
  )
}

export async function call(args = ''): Promise<LocalCommandResult> {
  const [actionRaw = '', alias = '', ...rest] = args.trim().split(/\s+/)
  const action = actionRaw.toLowerCase()

  if (!action || action === 'list' || action === 'show') {
    return text(formatModelReflexList())
  }

  if (action === 'help' || action === '--help' || action === '-h') {
    return text(USAGE)
  }

  if (action === 'delete' || action === 'del' || action === 'remove' || action === 'rm') {
    if (!alias || rest.length > 0) {
      return text(USAGE)
    }
    try {
      const deleted = deleteModelReflex(alias)
      return text(deleted ? `已删除模型映射：${alias}` : `模型映射不存在：${alias}`)
    } catch (error) {
      return text(error instanceof Error ? error.message : '模型映射删除失败')
    }
  }

  if (action === 'add') {
    const targetInput = rest.join(' ').trim()
    if (!alias || !targetInput) {
      return text(USAGE)
    }
    try {
      const { items } = await fetchBackendModelList()
      const match = findBackendModelMatch(items, targetInput)
      if (!match) {
        return text(`没有找到目标模型：${targetInput}，可用 /model-list 查看可用模型。`)
      }
      const saved = setModelReflex(alias, match.id)
      return text(`已添加模型映射：${saved.alias} => ${saved.target}`)
    } catch (error) {
      return text(
        `模型映射设置失败：${error instanceof Error ? error.message : '未知错误'}`,
      )
    }
  }

  return text(USAGE)
}
