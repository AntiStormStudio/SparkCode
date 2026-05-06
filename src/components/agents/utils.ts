import type { SettingSource } from 'src/utils/settings/constants.js'
import { getSettingSourceName } from 'src/utils/settings/constants.js'

export function getAgentSourceDisplayName(
  source: SettingSource | 'all' | 'built-in' | 'plugin',
): string {
  if (source === 'all') {
    return 'Agent'
  }
  if (source === 'built-in') {
    return '内置 Agent'
  }
  if (source === 'plugin') {
    return '插件 Agent'
  }
  return getSettingSourceName(source)
}
