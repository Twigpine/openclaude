import type { ModelCatalogEntry } from '../../integrations/descriptors.js'
import type { ModelOption } from './modelOptions.js'

function toDescription(
  entry: ModelCatalogEntry,
  routeLabel: string,
  isRouteDefault: boolean,
): string {
  const parts: string[] = []
  const isRecommended = entry.default || isRouteDefault

  if (isRecommended) {
    parts.push('Recommended')
  }
  if (entry.notes?.trim()) {
    parts.push(entry.notes.trim())
  }
  parts.push(`Provider: ${routeLabel}`)

  return parts.join(' · ')
}

export function mergeRouteCatalogEntries(
  staticEntries: ModelCatalogEntry[],
  discoveredEntries: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const merged = [...staticEntries]
  const existingApiNames = new Set(
    staticEntries.map(entry => entry.apiName.toLowerCase()),
  )

  for (const entry of discoveredEntries) {
    if (existingApiNames.has(entry.apiName.toLowerCase())) {
      continue
    }

    existingApiNames.add(entry.apiName.toLowerCase())
    merged.push(entry)
  }

  return merged
}

export function buildRouteCatalogModelOptions(
  routeLabel: string,
  entries: ModelCatalogEntry[],
  routeDefaultModel?: string,
): ModelOption[] {
  const seen = new Set<string>()
  const options: ModelOption[] = []
  const apiNameCounts = new Map<string, number>()
  const normalizedRouteDefault = routeDefaultModel?.trim().toLowerCase()
  const routeDefaultMatchesEntryId = normalizedRouteDefault !== undefined &&
    entries.some(entry => entry.id.trim().toLowerCase() === normalizedRouteDefault)
  for (const entry of entries) {
    const key = entry.apiName.trim().toLowerCase()
    apiNameCounts.set(key, (apiNameCounts.get(key) ?? 0) + 1)
  }

  for (const entry of entries) {
    const apiName = entry.apiName.trim()
    const value = (apiNameCounts.get(apiName.toLowerCase()) ?? 0) > 1
      ? entry.id.trim()
      : apiName
    if (!value || seen.has(value.toLowerCase())) {
      continue
    }

    seen.add(value.toLowerCase())
    const label = entry.label?.trim() || value
    const isRouteDefault = normalizedRouteDefault !== undefined &&
      (routeDefaultMatchesEntryId
        ? entry.id.trim().toLowerCase() === normalizedRouteDefault
        : apiName.toLowerCase() === normalizedRouteDefault)
    const description = toDescription(entry, routeLabel, isRouteDefault)

    options.push({
      value,
      label,
      description,
      descriptionForModel:
        label === value
          ? description
          : `${description} (${value})`,
    })
  }

  return options
}
