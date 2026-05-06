import React, { type ReactNode, useMemo } from 'react'
import { isAutoMemoryEnabled } from '../../../memdir/paths.js'
import type { Tools } from '../../../Tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import { type AgentWizardDefaults, getGlobalConfig } from '../../../utils/config.js'
import { WizardProvider } from '../../wizard/index.js'
import type { WizardStepComponent } from '../../wizard/types.js'
import type { AgentWizardData } from './types.js'
import { ColorStep } from './wizard-steps/ColorStep.js'
import { ConfirmStepWrapper } from './wizard-steps/ConfirmStepWrapper.js'
import { DescriptionStep } from './wizard-steps/DescriptionStep.js'
import { GenerateStep } from './wizard-steps/GenerateStep.js'
import { LocationStep } from './wizard-steps/LocationStep.js'
import { MemoryStep } from './wizard-steps/MemoryStep.js'
import { MethodStep } from './wizard-steps/MethodStep.js'
import { ModelStep } from './wizard-steps/ModelStep.js'
import { PromptStep } from './wizard-steps/PromptStep.js'
import { ToolsStep } from './wizard-steps/ToolsStep.js'
import { TypeStep } from './wizard-steps/TypeStep.js'

type Props = {
  tools: Tools
  existingAgents: AgentDefinition[]
  onComplete: (message: string) => void
  onCancel: () => void
}

function normalizeLocation(
  value: AgentWizardDefaults['location'] | undefined,
): 'projectSettings' | 'userSettings' | undefined {
  if (value === 'projectSettings' || value === 'userSettings') {
    return value
  }

  return undefined
}

function normalizeMemory(
  value: AgentWizardDefaults['selectedMemory'] | undefined,
): 'user' | 'project' | 'local' | 'none' | undefined {
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

function normalizeModel(value: AgentWizardDefaults['selectedModel']):
  | string
  | undefined {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeTools(
  value: AgentWizardDefaults['selectedTools'],
): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const filtered = value.filter(
    tool => typeof tool === 'string' && tool.trim().length > 0,
  )

  if (filtered.length > 0) return filtered

  // 显式保存空数组时，代表“无工具”
  if (value.length === 0) return []

  return undefined
}

function getAgentWizardInitialData(): Partial<AgentWizardData> {
  const defaults = getGlobalConfig().lastAgentWizardDefaults
  if (!defaults) return {}

  const initialData: Record<string, unknown> = {}

  const location = normalizeLocation(defaults.location)
  if (location) {
    initialData.location = location
  }

  const selectedModel = normalizeModel(defaults.selectedModel)
  if (selectedModel) {
    initialData.selectedModel = selectedModel
  }

  const selectedMemory = normalizeMemory(defaults.selectedMemory)
  if (selectedMemory) {
    initialData.selectedMemory = selectedMemory
  }

  const selectedTools = normalizeTools(defaults.selectedTools)
  if (selectedTools !== undefined) {
    initialData.selectedTools = selectedTools
  }

  return initialData
}

export function CreateAgentWizard({
  tools,
  existingAgents,
  onComplete,
  onCancel,
}: Props): ReactNode {
  const steps: WizardStepComponent<AgentWizardData>[] = [
    LocationStep,
    MethodStep,
    GenerateStep,
    () => <TypeStep existingAgents={existingAgents} />,
    PromptStep,
    DescriptionStep,
    () => <ToolsStep tools={tools} />,
    ModelStep,
    ColorStep,
    ...(isAutoMemoryEnabled() ? [MemoryStep] : []),
    () => (
      <ConfirmStepWrapper
        tools={tools}
        existingAgents={existingAgents}
        onComplete={onComplete}
      />
    ),
  ]

  const initialData = useMemo(() => getAgentWizardInitialData(), [])

  return (
    <WizardProvider<AgentWizardData>
      steps={steps}
      initialData={initialData}
      onComplete={() => {
        // 向导完成由 ConfirmStepWrapper 处理
      }}
      onCancel={onCancel}
      title="创建新 Agent"
      showStepCounter={false}
    />
  )
}
