import React, { type ReactNode } from 'react'
import { Box } from '../../../../ink.js'
import type { SettingSource } from '../../../../utils/settings/constants.js'
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js'
import { Select } from '../../../CustomSelect/select.js'
import { Byline } from '../../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'
import type { AgentWizardData } from '../types.js'

function normalizeLocation(value: unknown): SettingSource | undefined {
  if (value === 'projectSettings' || value === 'userSettings') {
    return value
  }

  return undefined
}

export function LocationStep(): ReactNode {
  const { goNext, updateWizardData, cancel, wizardData } =
    useWizard<AgentWizardData>()

  const locationOptions = [
    {
      label: '项目（.claude/agents/）',
      value: 'projectSettings' as SettingSource,
    },
    {
      label: '个人（~/.claude/agents/）',
      value: 'userSettings' as SettingSource,
    },
  ]

  const initialLocation = normalizeLocation(wizardData.location)

  return (
    <WizardDialogLayout
      subtitle="选择保存位置"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="↑↓" action="移动" />
          <KeyboardShortcutHint shortcut="Enter" action="选择" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="取消"
          />
        </Byline>
      }
    >
      <Box>
        <Select
          key="location-select"
          options={locationOptions}
          defaultValue={initialLocation}
          defaultFocusValue={initialLocation}
          onChange={(value: string) => {
            updateWizardData({ location: value as SettingSource })
            goNext()
          }}
          onCancel={() => cancel()}
        />
      </Box>
    </WizardDialogLayout>
  )
}
