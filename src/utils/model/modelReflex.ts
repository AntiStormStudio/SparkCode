import { getGlobalConfig, saveGlobalConfig } from '../config.js'

export type ModelReflexMap = Record<string, string>

function normalizeModelReflexKey(model: string): string {
  const normalized = model.trim()
  if (!normalized) {
    throw new Error('模型别名不能为空')
  }
  if (/\s/.test(normalized)) {
    throw new Error('模型别名不能包含空白字符')
  }
  return normalized
}

function sanitizeModelReflexMap(map: unknown): ModelReflexMap {
  const result: ModelReflexMap = {}
  if (!map || typeof map !== 'object') {
    return result
  }
  for (const [alias, target] of Object.entries(map)) {
    const normalizedAlias = alias.trim()
    const normalizedTarget = typeof target === 'string' ? target.trim() : ''
    if (normalizedAlias && normalizedTarget) {
      result[normalizedAlias] = normalizedTarget
    }
  }
  return result
}

export function getModelReflexMap(): ModelReflexMap {
  return sanitizeModelReflexMap(getGlobalConfig().modelReflex)
}

export function getModelReflexTarget(model: string): string | null {
  const alias = model.trim()
  if (!alias) {
    return null
  }
  return getModelReflexMap()[alias] ?? null
}

export function isModelReflexAlias(model: string): boolean {
  try {
    return getModelReflexTarget(model) !== null
  } catch {
    return false
  }
}

export function resolveModelReflex(model: string): string {
  return getModelReflexTarget(model) ?? model
}

export function setModelReflex(alias: string, target: string): {
  alias: string
  target: string
} {
  const normalizedAlias = normalizeModelReflexKey(alias)
  const normalizedTarget = target.trim()
  if (!normalizedTarget) {
    throw new Error('目标模型不能为空')
  }

  saveGlobalConfig(current => ({
    ...current,
    modelReflex: {
      ...sanitizeModelReflexMap(current.modelReflex),
      [normalizedAlias]: normalizedTarget,
    },
  }))

  return { alias: normalizedAlias, target: normalizedTarget }
}

export function deleteModelReflex(alias: string): boolean {
  const normalizedAlias = normalizeModelReflexKey(alias)
  let deleted = false
  saveGlobalConfig(current => {
    const next = sanitizeModelReflexMap(current.modelReflex)
    if (!(normalizedAlias in next)) {
      return current
    }
    delete next[normalizedAlias]
    deleted = true
    return {
      ...current,
      modelReflex: Object.keys(next).length > 0 ? next : undefined,
    }
  })
  return deleted
}
