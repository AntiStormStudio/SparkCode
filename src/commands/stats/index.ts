import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: '显示 Spark Code 使用统计与活动',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
