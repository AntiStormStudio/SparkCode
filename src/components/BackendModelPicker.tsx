import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import {
  type BackendModelEntry,
  fetchBackendModelList,
} from '../utils/model/backendModels.js'
import { Select } from './CustomSelect/index.js'

type Props = {
  initial: string | null
  headerText: string
  onSelect: (model: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export function BackendModelPicker({
  initial,
  headerText,
  onSelect,
  onCancel,
  onError,
}: Props): React.ReactNode {
  const [models, setModels] = useState<BackendModelEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadModels(): Promise<void> {
      try {
        const { items } = await fetchBackendModelList()
        if (cancelled) return

        if (items.length === 0) {
          onError('后端没有返回可用模型。')
          return
        }

        setModels(items)
      } catch (error) {
        if (cancelled) return
        onError(
          error instanceof Error
            ? `模型列表获取失败：${error.message}`
            : '模型列表获取失败',
        )
      }
    }

    void loadModels()

    return () => {
      cancelled = true
    }
  }, [onError])

  const options = useMemo(
    () =>
      (models ?? []).map(model => ({
        value: model.id,
        label: model.id,
        description: [model.name, model.description]
          .filter(Boolean)
          .join(' · '),
      })),
    [models],
  )

  const defaultFocusValue =
    initial && options.some(option => option.value === initial)
      ? initial
      : options[0]?.value

  if (!models) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>{headerText}</Text>
        <Text dimColor>正在加载模型列表…</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{headerText}</Text>
      <Select
        options={options}
        onChange={onSelect}
        onCancel={onCancel}
        defaultFocusValue={defaultFocusValue}
        visibleOptionCount={Math.min(10, options.length)}
      />
    </Box>
  )
}
