import type { Command } from '../../commands.js'

const outputStyle = {
  type: 'local-jsx',
  name: 'output-style',
  description: '已弃用：请使用 /config 修改输出风格',
  isHidden: true,
  load: () => import('./output-style.js'),
} satisfies Command

export default outputStyle
