import chalk from 'chalk'
import * as React from 'react'
import { BackendModelPicker } from '../../components/BackendModelPicker.js'
import { COMMON_HELP_ARGS } from '../../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from '../../utils/model/check1mAccess.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import {
  fetchBackendModelList,
  findBackendModelMatch,
} from '../../utils/model/backendModels.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const CLEAR_DEFAULT_MODEL_ARGS = new Set(['default', 'auto', 'unset', 'clear'])

function DefaultModelPickerWrapper({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()

  function handleCancel(): void {
    onDone('已取消修改默认模型', { display: 'system' })
  }

  function handleSelect(model: string): void {
    logEvent('tengu_default_model_command_menu', {
      action:
        (model ?? 'default') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model:
        mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    const result = persistDefaultModel(model)
    if (result.error) {
      onDone(`默认模型设置失败：${result.error.message}`, { display: 'system' })
      return
    }

    const suffix = updateRuntimeModel(model, isFastMode, setAppState)
    onDone(formatDefaultModelMessage(model, suffix))
  }

  return (
    <BackendModelPicker
      initial={mainLoopModel}
      onSelect={handleSelect}
      onCancel={handleCancel}
      onError={message => onDone(message, { display: 'system' })}
      headerText="选择默认模型。会写入配置文件，之后的新会话也会使用这个模型。"
    />
  )
}

function ApplyDefaultModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const model = parseDefaultModelArg(args)

  React.useEffect(() => {
    async function handleDefaultModelChange(): Promise<void> {
      const validation = await validateDefaultModel(model)
      if (validation.error) {
        onDone(validation.error, { display: 'system' })
        return
      }

      const result = persistDefaultModel(validation.model)
      if (result.error) {
        onDone(`默认模型设置失败：${result.error.message}`, {
          display: 'system',
        })
        return
      }

      const suffix = updateRuntimeModel(validation.model, isFastMode, setAppState)
      onDone(formatDefaultModelMessage(validation.model, suffix))
    }

    void handleDefaultModelChange()
  }, [isFastMode, model, onDone, setAppState])

  return null
}

function parseDefaultModelArg(args: string): string | null {
  const trimmed = args.trim()
  return CLEAR_DEFAULT_MODEL_ARGS.has(trimmed.toLowerCase()) ? null : trimmed
}

function persistDefaultModel(model: string | null): { error: Error | null } {
  return updateSettingsForSource('userSettings', {
    model: model ?? undefined,
  })
}

function updateRuntimeModel(
  model: string | null,
  isFastMode: boolean | undefined,
  setAppState: ReturnType<typeof useSetAppState>,
): string {
  let wasFastModeToggledOff = false

  if (isFastModeEnabled()) {
    clearFastModeCooldown()
    wasFastModeToggledOff =
      !isFastModeSupportedByModel(model) && Boolean(isFastMode)
  }

  setAppState(prev => ({
    ...prev,
    mainLoopModel: model,
    mainLoopModelForSession: null,
    ...(wasFastModeToggledOff ? { fastMode: false } : {}),
  }))

  const parts: string[] = []
  if (
    isBilledAsExtraUsage(
      model,
      isFastModeEnabled() && Boolean(isFastMode) && !wasFastModeToggledOff,
      isOpus1mMergeEnabled(),
    )
  ) {
    parts.push('按额外用量计费')
  }
  if (wasFastModeToggledOff) {
    parts.push('快速模式已关闭')
  }

  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

function formatDefaultModelMessage(model: string | null, suffix = ''): string {
  if (model === null) {
    return `已恢复默认模型配置${suffix}`
  }
  return `已将默认模型设置为 ${chalk.bold(renderModelLabel(model))}${suffix}`
}

async function validateDefaultModel(
  model: string | null,
): Promise<{ model: string | null; error: string | null }> {
  if (!model) return { model: null, error: null }

  if (isOpus1mUnavailable(model)) {
    return {
      model,
      error: '当前账号暂不支持 Opus 4.6 的 1M 上下文。',
    }
  }
  if (isSonnet1mUnavailable(model)) {
    return {
      model,
      error: '当前账号暂不支持 Sonnet 4.6 的 1M 上下文。',
    }
  }
  if (isKnownAlias(model)) {
    if (!isModelAllowed(model)) {
      return {
        model,
        error: `模型 ${model} 不可用：当前组织限制了模型选择。`,
      }
    }
    return { model, error: null }
  }

  try {
    const { items } = await fetchBackendModelList()
    const match = findBackendModelMatch(items, model)
    return match
      ? { model: match.id, error: null }
      : {
          model,
          error: `没有找到模型：${model}，可用 /default-model 打开模型列表选择。`,
        }
  } catch (error) {
    return {
      model,
      error: `模型校验失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(
    model.toLowerCase().trim(),
  )
}

function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return (
    !checkOpus1mAccess() &&
    !isOpus1mMergeEnabled() &&
    m.includes('opus') &&
    m.includes('[1m]')
  )
}

function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return (
    !checkSonnet1mAccess() &&
    (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'))
  )
}

function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return model === null ? `${rendered}（默认）` : rendered
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      '用法：/default-model [model]\n\n直接输入 /default-model 会打开模型列表；/default-model auto 会清除配置里的默认模型。',
      { display: 'system' },
    )
    return
  }

  if (args) {
    logEvent('tengu_default_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <ApplyDefaultModelAndClose args={args} onDone={onDone} />
  }

  return <DefaultModelPickerWrapper onDone={onDone} />
}
