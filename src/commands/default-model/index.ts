import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'default-model',
  get description() {
    return `设置默认模型（当前 ${renderModelName(getMainLoopModel())}）`
  },
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./default-model.js'),
} satisfies Command
