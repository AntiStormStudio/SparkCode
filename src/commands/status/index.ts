import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    '显示 Spark Code 状态：版本、模型、账号、API 连通性与工具状态',
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
