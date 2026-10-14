import type { ModelCatalogEntry } from '../../integrations/descriptors.js'
import type { ModelOption } from './modelOptions.js'
import { formatAvailabilityState, type ModelAvailability } from './modelAvailability.js'

function toDescription(
  entry: ModelCatalogEntry,
  routeLabel: string,
  isRouteDefault: boolean,
  availability?: ModelAvailability,
): string {
  const parts: string[] = []
  const isRecommended = entry.default || isRouteDefault

  if (isRecommended) {
    parts.push('Recommended')
  }
  // A verified-bad model is the single most useful thing to surface: it is
  // offered by the upstream catalog but rejected at request time.
  if (availability && availability.state !== 'available') {
    parts.push(formatAvailabilityState(availability.state))
  }
  if (entry.notes?.trim()) {
    parts.push(entry.notes.trim())
  }
  parts.push(`Provider: ${routeLabel}`)

  return parts.join(' · ')
}

/**
 * Attach cached availability verdicts to a set of options, marking the
 * description so an unusable model is obvious before it is chosen. Verdicts
 * are matched on the option `value` (the apiName sent on the wire) so a
 * duplicate-id dedup or profile-qualified value can never borrow another
 * model's status.
 */
export function applyAvailabilityToOptions(
  options: ModelOption[],
  availability: Record<string, ModelAvailability>,
): ModelOption[] {
  return options.map(option => {
    const valueKey = typeof option.value === 'string' ? option.value : undefined
    const verdict = (valueKey !== undefined ? availability[valueKey] : undefined) ??
      availability[option.label]
    if (!verdict) {
      return option
    }
    return {
      ...option,
      availability: verdict,
      description: `${option.description} · ${formatAvailabilityState(verdict.state)}`,
      descriptionForModel: option.descriptionForModel
        ? `${option.descriptionForModel} · ${formatAvailabilityState(verdict.state)}`
        : undefined,
    }
  })
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
  availability?: Record<string, ModelAvailability>,
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
    const description = toDescription(entry, routeLabel, isRouteDefault, availability?.[apiName])

    options.push({
      value,
      label,
      description,
      descriptionForModel:
        label === value
          ? description
          : `${description} (${value})`,
      availability: availability?.[apiName],
    })
  }

  return options
}
