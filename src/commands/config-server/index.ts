import type { Command } from '../../commands.js'

const configServer = {
  type: 'local-jsx',
  name: 'config-server',
  description: '修改项目后端地址',
  argumentHint: '[后端地址]',
  load: () => import('./config-server.js'),
} satisfies Command

export default configServer
