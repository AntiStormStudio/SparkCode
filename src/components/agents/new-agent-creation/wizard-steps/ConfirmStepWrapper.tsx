import chalk from 'chalk'
import React, { type ReactNode, useCallback, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { useSetAppState } from 'src/state/AppState.js'
import type { Tools } from '../../../../Tool.js'
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js'
import { getActiveAgentsFromList } from '../../../../tools/AgentTool/loadAgentsDir.js'
import {
  type AgentWizardDefaults,
  saveGlobalConfig,
} from '../../../../utils/config.js'
import { editFileInEditor } from '../../../../utils/promptEditor.js'
import { useWizard } from '../../../wizard/index.js'
import { getNewAgentFilePath, saveAgentToFile } from '../../agentFileUtils.js'
import type { AgentWizardData } from '../types.js'
import { ConfirmStep } from './ConfirmStep.js'

type Props = {
  tools: Tools
  existingAgents: AgentDefinition[]
  onComplete: (message: string) => void
}

function normalizeLocation(value: unknown): AgentWizardDefaults['location'] {
  if (value === 'projectSettings' || value === 'userSettings') {
    return value
  }

  return undefined
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeMemory(value: unknown): AgentWizardDefaults['selectedMemory'] {
  if (
    value === 'user' ||
    value === 'project' ||
    value === 'local' ||
    value === 'none'
  ) {
    return value
  }

  return undefined
}

function normalizeTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const filtered = value.filter(
    tool => typeof tool === 'string' && tool.trim().length > 0,
  )

  if (filtered.length > 0) return filtered
  if (value.length === 0) return []

  return undefined
}

function areStringArraysEqual(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false

  return left.every((item, index) => item === right[index])
}

function areDefaultsEqual(
  left: AgentWizardDefaults | undefined,
  right: AgentWizardDefaults,
): boolean {
  if (!left) return false

  return (
    left.location === right.location &&
    left.selectedModel === right.selectedModel &&
    left.selectedMemory === right.selectedMemory &&
    areStringArraysEqual(left.selectedTools, right.selectedTools)
  )
}

function persistAgentWizardDefaults(wizardData: AgentWizardData): void {
  const location = normalizeLocation(wizardData.location)
  const selectedModel = normalizeModel(
    wizardData.selectedModel ?? wizardData.finalAgent?.model,
  )
  const selectedMemory = normalizeMemory(
    wizardData.selectedMemory ?? wizardData.finalAgent?.memory,
  )
  const selectedTools = normalizeTools(
    wizardData.selectedTools ?? wizardData.finalAgent?.tools,
  )

  const defaults: AgentWizardDefaults = {
    ...(location ? { location } : {}),
    ...(selectedModel ? { selectedModel } : {}),
    ...(selectedMemory ? { selectedMemory } : {}),
    ...(selectedTools !== undefined ? { selectedTools } : {}),
  }

  saveGlobalConfig(current => {
    if (areDefaultsEqual(current.lastAgentWizardDefaults, defaults)) {
      return current
    }

    return {
      ...current,
      lastAgentWizardDefaults: defaults,
    }
  })
}

export function ConfirmStepWrapper({
  tools,
  existingAgents,
  onComplete,
}: Props): ReactNode {
  const { wizardData } = useWizard<AgentWizardData>()
  const [saveError, setSaveError] = useState<string | null>(null)
  const setAppState = useSetAppState()

  const saveAgent = useCallback(
    async (openInEditor: boolean): Promise<void> => {
      if (!wizardData?.finalAgent) return

      try {
        await saveAgentToFile(
          wizardData.location!,
          wizardData.finalAgent.agentType,
          wizardData.finalAgent.whenToUse,
          wizardData.finalAgent.tools,
          wizardData.finalAgent.getSystemPrompt(),
          true,
          wizardData.finalAgent.color,
          wizardData.finalAgent.model,
          wizardData.finalAgent.memory,
        )

        setAppState(state => {
          if (!wizardData.finalAgent) return state

          const allAgents = state.agentDefinitions.allAgents.concat(
            wizardData.finalAgent,
          )

          return {
            ...state,
            agentDefinitions: {
              ...state.agentDefinitions,
              activeAgents: getActiveAgentsFromList(allAgents),
              allAgents,
            },
          }
        })

        persistAgentWizardDefaults(wizardData)

        if (openInEditor) {
          const filePath = getNewAgentFilePath({
            source: wizardData.location!,
            agentType: wizardData.finalAgent.agentType,
          })
          await editFileInEditor(filePath)
        }

        logEvent(
          'tengu_agent_created',
          {
            agent_type: wizardData.finalAgent.agentType,
            generation_method: wizardData.wasGenerated ? 'generated' : 'manual',
            source: wizardData.location!,
            tool_count: wizardData.finalAgent.tools?.length ?? 'all',
            has_custom_model: !!wizardData.finalAgent.model,
            has_custom_color: !!wizardData.finalAgent.color,
            has_memory: !!wizardData.finalAgent.memory,
            memory_scope: wizardData.finalAgent.memory ?? 'none',
            ...(openInEditor ? { opened_in_editor: true } : {}),
          } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        )

        const message = openInEditor
          ? `已创建 Agent：${chalk.bold(wizardData.finalAgent.agentType)}，并已在编辑器中打开。` +
            ' 若有修改，请重启以加载最新版本。'
          : `已创建 Agent：${chalk.bold(wizardData.finalAgent.agentType)}`

        onComplete(message)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : '保存 Agent 失败')
      }
    },
    [wizardData, onComplete, setAppState],
  )

  const handleSave = useCallback(() => saveAgent(false), [saveAgent])
  const handleSaveAndEdit = useCallback(() => saveAgent(true), [saveAgent])

  return (
    <ConfirmStep
      tools={tools}
      existingAgents={existingAgents}
      onSave={handleSave}
      onSaveAndEdit={handleSaveAndEdit}
      error={saveError}
    />
  )
}
