import type { Command } from '../../commands.js'

const openTerminal = {
  type: 'local',
  name: 'openterminal',
  aliases: ['open-terminal'],
  description: '启动网页可访问的 OpenTerminal 本地终端工具',
  argumentHint: '[status|stop|restart|reset-key] [--port 8000] [--cwd 路径]',
  supportsNonInteractive: false,
  load: () => import('./openterminal.js'),
} satisfies Command

export default openTerminal
