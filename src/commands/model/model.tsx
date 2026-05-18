import chalk from 'chalk';
import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { BackendModelPicker } from '../../components/BackendModelPicker.js';
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { EffortLevel } from '../../utils/effort.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { clearFastModeCooldown, isFastModeAvailable, isFastModeEnabled, isFastModeSupportedByModel } from '../../utils/fastMode.js';
import { MODEL_ALIASES } from '../../utils/model/aliases.js';
import { checkOpus1mAccess, checkSonnet1mAccess } from '../../utils/model/check1mAccess.js';
import { getDefaultMainLoopModelSetting, isOpus1mMergeEnabled, renderDefaultModelSetting } from '../../utils/model/model.js';
import { fetchBackendModelList, findBackendModelMatch } from '../../utils/model/backendModels.js';
import { isModelAllowed } from '../../utils/model/modelAllowlist.js';
import { isModelReflexAlias } from '../../utils/model/modelReflex.js';
function ModelPickerWrapper(t0) {
  const {
    onDone
  } = t0;
  const mainLoopModel = useAppState(_temp);
  const mainLoopModelForSession = useAppState(_temp2);
  const isFastMode = useAppState(_temp3);
  const setAppState = useSetAppState();

  function handleCancel(): void {
    logEvent("tengu_model_command_menu", {
      action: "cancel" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    const displayModel = renderModelLabel(mainLoopModel);
    onDone(`已保持当前模型：${chalk.bold(displayModel)}`, {
      display: "system"
    });
  }

  function handleSelect(model: string): void {
    logEvent("tengu_model_command_menu", {
      action: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model: mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setAppState(prev => ({
      ...prev,
      mainLoopModelForSession: model
    }));
    let message = `已将当前模型设置为 ${chalk.bold(renderModelLabel(model))}`;
    let wasFastModeToggledOn = undefined;
    if (isFastModeEnabled()) {
      clearFastModeCooldown();
      if (!isFastModeSupportedByModel(model) && isFastMode) {
        setAppState(prev => ({
          ...prev,
          fastMode: false
        }));
        wasFastModeToggledOn = false;
      } else if (isFastModeSupportedByModel(model) && isFastModeAvailable() && isFastMode) {
        message = message + " \xB7 快速模式已开启";
        wasFastModeToggledOn = true;
      }
    }
    if (isBilledAsExtraUsage(model, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
      message = message + " \xB7 按额外用量计费";
    }
    if (wasFastModeToggledOn === false) {
      message = message + " \xB7 快速模式已关闭";
    }
    onDone(message);
  }

  return <BackendModelPicker initial={mainLoopModelForSession ?? mainLoopModel} onSelect={handleSelect} onCancel={handleCancel} onError={message => onDone(message, {
    display: "system"
  })} headerText="选择当前会话使用的模型。这个设置不会写入默认配置。" />;
}
function _temp3(s_1) {
  return s_1.fastMode;
}
function _temp2(s_0) {
  return s_0.mainLoopModelForSession;
}
function _temp(s) {
  return s.mainLoopModel;
}
function SetModelAndClose({
  args,
  onDone
}: {
  args: string;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode);
  const setAppState = useSetAppState();
  const model = args === 'default' ? null : args;
  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (!model) {
        setModel(null);
        return;
      }

      if (isOpus1mUnavailable(model)) {
        onDone(`当前账号暂不支持 Opus 4.6 的 1M 上下文。`, {
          display: 'system'
        });
        return;
      }
      if (isSonnet1mUnavailable(model)) {
        onDone(`当前账号暂不支持 Sonnet 4.6 的 1M 上下文。`, {
          display: 'system'
        });
        return;
      }

      if (isKnownAlias(model)) {
        if (!isModelAllowed(model)) {
          onDone(`模型 ${model} 不可用：当前组织限制了模型选择。`, {
            display: 'system'
          });
          return;
        }
        setModel(model);
        return;
      }
      if (isModelReflexAlias(model)) {
        setModel(model);
        return;
      }

      try {
        const { items } = await fetchBackendModelList();
        const match = findBackendModelMatch(items, model);
        if (!match) {
          onDone(`没有找到模型：${model}，可用 /model 打开模型列表选择。`, {
            display: 'system'
          });
          return;
        }
        setModel(match.id);
      } catch (error) {
        onDone(`模型校验失败：${error instanceof Error ? error.message : '未知错误'}`, {
          display: 'system'
        });
      }
    }
    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModelForSession: modelValue
      }));
      let message = `已将当前模型设置为 ${chalk.bold(renderModelLabel(modelValue))}`;
      let wasFastModeToggledOn = undefined;
      if (isFastModeEnabled()) {
        clearFastModeCooldown();
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev_0 => ({
            ...prev_0,
            fastMode: false
          }));
          wasFastModeToggledOn = false;
          // 自动降级，不写入 fast mode 配置
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ` · 快速模式已开启`;
          wasFastModeToggledOn = true;
        }
      }
      if (isBilledAsExtraUsage(modelValue, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
        message += ` · 按额外用量计费`;
      }
      if (wasFastModeToggledOn === false) {
        message += ` · 快速模式已关闭`;
      }
      onDone(message);
    }
    void handleModelChange();
  }, [isFastMode, model, onDone, setAppState]);
  return null;
}
function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase().trim());
}
function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase();
  return !checkOpus1mAccess() && !isOpus1mMergeEnabled() && m.includes('opus') && m.includes('[1m]');
}
function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase();
  // Warn about Sonnet and Sonnet 4.6, but not Sonnet 4.5 since that had
  // a different access criteria.
  return !checkSonnet1mAccess() && (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'));
}
function ShowModelAndClose(t0) {
  const {
    onDone
  } = t0;
  const mainLoopModel = useAppState(_temp7);
  const mainLoopModelForSession = useAppState(_temp8);
  const effortValue = useAppState(_temp9);
  const displayModel = renderModelLabel(mainLoopModel);
  const effortInfo = effortValue !== undefined ? `（${formatEffortLevel(effortValue)}）` : "";
  if (mainLoopModelForSession) {
    onDone(`当前模型：${chalk.bold(renderModelLabel(mainLoopModelForSession))}（当前会话临时指定）\n默认模型：${displayModel}${effortInfo}`);
  } else {
    onDone(`当前模型：${displayModel}${effortInfo}`);
  }
  return null;
}
function _temp9(s_1) {
  return s_1.effortValue;
}
function _temp8(s_0) {
  return s_0.mainLoopModelForSession;
}
function _temp7(s) {
  return s.mainLoopModel;
}
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || '';
  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <ShowModelAndClose onDone={onDone} />;
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('用法：/model [model]\n\n直接输入 /model 会打开模型列表；/model default 会清除当前会话的临时模型。', {
      display: 'system'
    });
    return;
  }
  if (args) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <SetModelAndClose args={args} onDone={onDone} />;
  }
  return <ModelPickerWrapper onDone={onDone} />;
};
function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(model ?? getDefaultMainLoopModelSetting());
  return model === null ? `${rendered}（默认）` : rendered;
}

function formatEffortLevel(effort: EffortLevel | string | undefined): string {
  switch (effort) {
    case 'low':
      return '低';
    case 'medium':
      return '中';
    case 'high':
      return '高';
    case 'max':
      return '最高';
    default:
      return '自动';
  }
}
