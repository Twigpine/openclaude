import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import type { ModelAvailability } from './modelAvailability.js'
import {
  AVAILABILITY_CACHE_TTL_MS,
  clearCachedAvailability,
  getCachedAvailability,
  hasCachedAvailability,
  setCachedAvailability,
} from './modelAvailabilityCache.js'

function availability(
  state: ModelAvailability['state'],
  checkedAt: number,
): ModelAvailability {
  return { state, checkedAt }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'availability-cache-'))
  setClaudeConfigHomeDirForTesting(tempDir)
})

describe('model availability cache', () => {
  test('an absent cache reads as empty', () => {
    expect(getCachedAvailability('route|x|credential')).toEqual({})
    expect(hasCachedAvailability('route|x|credential')).toBe(false)
  })

  test('written verdicts round-trip', () => {
    const results = {
      'a': availability('available', Date.now()),
      'b': availability('deprecated', Date.now()),
    }

    setCachedAvailability('route|x|credential', results)

    expect(getCachedAvailability('route|x|credential')).toEqual(results)
    expect(hasCachedAvailability('route|x|credential')).toBe(true)
  })

  test('verdicts are scoped per route and credential', () => {
    setCachedAvailability('a|owner|credential', { m: availability('available', Date.now()) })
    setCachedAvailability('b|owner|anonymous', { m: availability('unavailable', Date.now()) })

    expect(getCachedAvailability('a|owner|credential').m?.state).toBe('available')
    expect(getCachedAvailability('b|owner|anonymous').m?.state).toBe('unavailable')
  })

  test('stale verdicts are dropped on read', () => {
    setCachedAvailability('route|x|credential', {
      fresh: availability('available', Date.now()),
      stale: availability('unavailable', Date.now() - AVAILABILITY_CACHE_TTL_MS - 1000),
    })

    const cached = getCachedAvailability('route|x|credential')

    expect(Object.keys(cached)).toEqual(['fresh'])
  })

  test('an empty result set clears the scope but not others', () => {
    setCachedAvailability('keep', { m: availability('available', Date.now()) })
    setCachedAvailability('drop', { m: availability('available', Date.now()) })

    setCachedAvailability('drop', {})

    expect(hasCachedAvailability('drop')).toBe(false)
    expect(hasCachedAvailability('keep')).toBe(true)
  })

  test('clearCachedAvailability removes one scope or all of them', () => {
    setCachedAvailability('a', { m: availability('available', Date.now()) })
    setCachedAvailability('b', { m: availability('available', Date.now()) })

    clearCachedAvailability('a')
    expect(hasCachedAvailability('a')).toBe(false)
    expect(hasCachedAvailability('b')).toBe(true)

    clearCachedAvailability()
    expect(hasCachedAvailability('b')).toBe(false)
  })

  test('a corrupt cache file degrades to empty rather than throwing', () => {
    const path = join(tempDir, 'model-availability-cache.json')
    require('fs').writeFileSync(path, '{not json', { mode: 0o600 })

    expect(getCachedAvailability('whatever')).toEqual({})
  })

  test('the cache file is written with owner-only permissions', () => {
    setCachedAvailability('route', { m: availability('available', Date.now()) })

    const path = join(tempDir, 'model-availability-cache.json')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('route')
  })
})
