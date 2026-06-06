import type { Command } from '../../commands.js'

const remote = {
  type: 'local-jsx',
  name: 'remote',
  description: '配置 Spark Code Remote 远程控制',
  argumentHint: '[后端地址|bind <绑定码>|status|session|unbind]',
  load: () => import('./remote.js'),
} satisfies Command

export default remote
