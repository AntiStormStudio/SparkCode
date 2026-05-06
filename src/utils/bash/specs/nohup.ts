import type { CommandSpec } from '../registry.js'

const nohup: CommandSpec = {
  name: 'nohup',
  description: '运行不受挂断影响的命令',
  args: {
    name: 'command',
    description: '要通过 nohup 运行的命令',
    isCommand: true,
  },
}

export default nohup
