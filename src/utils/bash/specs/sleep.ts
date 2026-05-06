import type { CommandSpec } from '../registry.js'

const sleep: CommandSpec = {
  name: 'sleep',
  description: '延迟指定时长',
  args: {
    name: 'duration',
    description: '睡眠时长（秒数，或 5s、2m、1h 这样的后缀）',
    isOptional: false,
  },
}

export default sleep
