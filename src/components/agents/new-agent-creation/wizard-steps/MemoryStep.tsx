import React, { type ReactNode } from 'react'
import { Box } from '../../../../ink.js'
import { useKeybinding } from '../../../../keybindings/useKeybinding.js'
import { isAutoMemoryEnabled } from '../../../../memdir/paths.js'
import {
  type AgentMemoryScope,
  loadAgentMemoryPrompt,
} from '../../../../tools/AgentTool/agentMemory.js'
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js'
import { Select } from '../../../CustomSelect/select.js'
import { Byline } from '../../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'
import type { AgentWizardData } from '../types.js'

type MemorySelectValue = AgentMemoryScope | 'none'

type MemoryOption = {
  label: string
  value: MemorySelectValue
}

function normalizeMemory(value: unknown): MemorySelectValue | undefined {
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

function hasOptionValue(
  options: MemoryOption[],
  value: MemorySelectValue,
): boolean {
  return options.some(option => option.value === value)
}

export function MemoryStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } =
    useWizard<AgentWizardData>()

  useKeybinding('confirm:no', goBack, { context: 'Confirmation' })

  const isUserScope = wizardData.location === 'userSettings'

  const memoryOptions: MemoryOption[] = isUserScope
    ? [
        {
          label: '用户级（~/.claude/agent-memory/）（推荐）',
          value: 'user',
        },
        { label: '不启用（不持久化记忆）', value: 'none' },
        { label: '项目级（.claude/agent-memory/）', value: 'project' },
        {
          label: '本地级（.claude/agent-memory-local/）',
          value: 'local',
        },
      ]
    : [
        {
          label: '项目级（.claude/agent-memory/）（推荐）',
          value: 'project',
        },
        { label: '不启用（不持久化记忆）', value: 'none' },
        { label: '用户级（~/.claude/agent-memory/）', value: 'user' },
        {
          label: '本地级（.claude/agent-memory-local/）',
          value: 'local',
        },
      ]

  const initialMemory = normalizeMemory(wizardData.selectedMemory)
  const initialSelection = initialMemory && hasOptionValue(memoryOptions, initialMemory)
    ? initialMemory
    : undefined

  const handleSelect = (value: string): void => {
    const selectedValue = value as MemorySelectValue
    const memory = selectedValue === 'none' ? undefined : selectedValue
    const agentType = wizardData.finalAgent?.agentType

    updateWizardData({
      selectedMemory: selectedValue,
      finalAgent: wizardData.finalAgent
        ? {
            ...wizardData.finalAgent,
            memory,
            getSystemPrompt:
              isAutoMemoryEnabled() && memory && agentType
                ? () =>
                    wizardData.systemPrompt +
                    '\n\n' +
                    loadAgentMemoryPrompt(agentType, memory)
                : () => wizardData.systemPrompt,
          }
        : undefined,
    })

    goNext()
  }

  return (
    <WizardDialogLayout
      subtitle="配置 Agent 记忆"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="↑↓" action="移动" />
          <KeyboardShortcutHint shortcut="Enter" action="选择" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="返回"
          />
        </Byline>
      }
    >
      <Box>
        <Select
          key="memory-select"
          options={memoryOptions}
          defaultValue={initialSelection}
          defaultFocusValue={initialSelection}
          onChange={handleSelect}
          onCancel={goBack}
        />
      </Box>
    </WizardDialogLayout>
  )
}
