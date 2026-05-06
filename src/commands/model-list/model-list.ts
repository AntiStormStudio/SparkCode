import type { LocalCommandResult } from '../../types/command.js'
import {
  fetchBackendModelList,
  formatBackendModelList,
} from '../../utils/model/backendModels.js'

export async function call(): Promise<LocalCommandResult> {
  try {
    const modelList = await fetchBackendModelList()
    return {
      type: 'text' as const,
      value: formatBackendModelList(modelList),
    }
  } catch (error) {
    return {
      type: 'text' as const,
      value:
        error instanceof Error
          ? `模型列表获取失败：${error.message}`
          : '模型列表获取失败',
    }
  }
}
