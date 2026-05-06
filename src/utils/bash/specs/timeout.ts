import type { CommandSpec } from '../registry.js'

const timeout: CommandSpec = {
  name: 'timeout',
  description: '带超时限制运行命令',
  args: [
    {
      name: 'duration',
      description: '超时前等待的时长（例如 10、5s、2m）',
      isOptional: false,
    },
    {
      name: 'command',
      description: '要运行的命令',
      isCommand: true,
    },
  ],
}

export default timeout
