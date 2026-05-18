import type { Command } from '../../commands.js'

const modelReflex = {
  type: 'local',
  name: 'model-reflex',
  description: '配置模型映射别名',
  argumentHint: 'add/delete <别名> [目标模型]',
  supportsNonInteractive: true,
  load: () => import('./model-reflex.js'),
} satisfies Command

export default modelReflex
