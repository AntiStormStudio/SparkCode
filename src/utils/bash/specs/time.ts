import type { CommandSpec } from '../registry.js'

const time: CommandSpec = {
  name: 'time',
  description: '统计命令耗时',
  args: {
    name: 'command',
    description: '要统计耗时的命令',
    isCommand: true,
  },
}

export default time
