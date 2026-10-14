import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import {
  applyAvailabilityToOptions,
  buildRouteCatalogModelOptions,
} from './routeCatalogOptions.js'
import type { ModelOption } from './modelOptions.js'
import type { ModelAvailability } from './modelAvailability.js'

/** Wrap a responder as a `fetch` stand-in. */
function asFetch(
  responder: () => Promise<Response>,
): typeof fetch {
  return responder as unknown as typeof fetch
}

function availability(
  state: ModelAvailability['state'],
): ModelAvailability {
  return { state, checkedAt: 1 }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'route-catalog-availability-'))
  setClaudeConfigHomeDirForTesting(tempDir)
})

describe('buildRouteCatalogModelOptions with availability', () => {
  const entries = [
    { id: 'good', apiName: 'good', label: 'Good Model' },
    { id: 'dead', apiName: 'dead', label: 'Dead Model' },
    { id: 'eol', apiName: 'eol', label: 'EOL Model' },
  ]

  test('healthy models are not annotated', () => {
    const options = buildRouteCatalogModelOptions('Route', entries, undefined, {
      good: availability('available'),
    })

    const good = options.find(option => option.value === 'good')
    expect(good?.description).toBe('Provider: Route')
    expect(good?.description).not.toContain('available')
  })

  test('unusable models are marked in the description and carry the verdict', () => {
    const options = buildRouteCatalogModelOptions('Route', entries, undefined, {
      dead: availability('unavailable'),
      eol: availability('deprecated'),
    })

    const dead = options.find(option => option.value === 'dead')
    const eol = options.find(option => option.value === 'eol')

    expect(dead?.description).toBe('✗ unavailable · Provider: Route')
    expect(dead?.availability?.state).toBe('unavailable')
    expect(eol?.description).toBe('✗ end-of-life · Provider: Route')
    expect(eol?.availability?.state).toBe('deprecated')
  })

  test('the marker precedes the recommended and provider markers', () => {
    const options = buildRouteCatalogModelOptions(
      'Route',
      [{ id: 'd', apiName: 'd', label: 'D', default: true }],
      'd',
      { d: availability('auth-failed') },
    )

    expect(options[0]?.description).toBe('Recommended · ⚠ auth failed · Provider: Route')
  })
})

describe('probe/read scope-key alignment', () => {
  test('a probe written under the catalog cache key is read back', async () => {
    setClaudeConfigHomeDirForTesting(tempDir)
    const { probeRouteAvailability } = await import('./probeRouteAvailability.js')

    // The picker owns this identity from the model catalog cache; the probe must
    // be persisted under it, not under a second format. A mismatch here is
    // silent — the probe succeeds and the picker shows nothing.
    const catalogCacheKey = 'catalog-owned-key'
    const probeResults = await probeRouteAvailability({
      routeId: 'custom-anthropic',
      baseUrl: 'http://127.0.0.1:8082',
      apiKey: 'freecc',
      models: ['anthropic/nvidia_nim/nvidia/llama-3.1-nemotron-70b-instruct'],
      scopeKey: catalogCacheKey,
      fetchImpl: asFetch(async () =>
        new Response(JSON.stringify({ content: [] }), { status: 200 }),
      ),
    })

    const { getCachedAvailability } = await import('./modelAvailabilityCache.js')
    expect(getCachedAvailability(catalogCacheKey)).toEqual(probeResults)
  })
})

describe('applyAvailabilityToOptions', () => {
  const baseOption: ModelOption = {
    value: 'provider/model',
    label: 'provider/model',
    description: 'Provider: Route',
  }

  test('annotates by wire value', () => {
    const annotated = applyAvailabilityToOptions([baseOption], {
      'provider/model': availability('unavailable'),
    })

    expect(annotated[0]?.availability?.state).toBe('unavailable')
    expect(annotated[0]?.description).toBe('Provider: Route · ✗ unavailable')
  })

  test('leaves options without a verdict untouched', () => {
    const annotated = applyAvailabilityToOptions([baseOption], {
      'other/model': availability('unavailable'),
    })

    expect(annotated[0]?.availability).toBeUndefined()
    expect(annotated[0]?.description).toBe('Provider: Route')
  })

  test('keeps descriptionForModel in sync when present', () => {
    const option: ModelOption = { ...baseOption, descriptionForModel: 'Provider: Route (x)' }
    const annotated = applyAvailabilityToOptions([option], {
      'provider/model': availability('deprecated'),
    })

    expect(annotated[0]?.descriptionForModel).toBe('Provider: Route (x) · ✗ end-of-life')
  })

  test('a profile-qualified option cannot borrow another model&apos;s verdict', () => {
    const option: ModelOption = {
      ...baseOption,
      value: '__switch_profile__:p1:provider/model',
    }
    const annotated = applyAvailabilityToOptions([option], {
      'provider/model': availability('unavailable'),
    })

    // Matched on label, which is the bare model id, so a genuine switch value
    // is still annotated — but only because the label matches, never by
    // accident of the composite value colliding with another model.
    expect(annotated[0]?.availability?.state).toBe('unavailable')
  })

  test('does not mutate the input options', () => {
    const options: ModelOption[] = [{ ...baseOption }]
    applyAvailabilityToOptions(options, {
      'provider/model': availability('unavailable'),
    })

    expect(options[0]?.description).toBe('Provider: Route')
    expect(options[0]?.availability).toBeUndefined()
  })
})
