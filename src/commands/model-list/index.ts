import type { Command } from '../../commands.js'

const modelList = {
  type: 'local',
  name: 'model-list',
  description: '查看后端可用模型列表',
  supportsNonInteractive: true,
  load: () => import('./model-list.js'),
} satisfies Command

export default modelList
