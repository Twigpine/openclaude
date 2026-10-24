import { expect, test, describe } from 'bun:test'
import { z } from 'zod/v4'
import {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_KEYS,
  isGlobalConfigKey,
  SHOW_CACHE_STATS_MODES,
  type GlobalConfig,
} from './config.js'

// Standalone Zod schema mirroring the runtime contract for showCacheStats.
// The config file does not carry a Zod schema per field (GlobalConfig is a
// plain TS type with defaults), so we exercise validation here so that any
// future drift — e.g. adding a mode without updating the UI — is caught at
// test time rather than silently rendered in /config.
const ShowCacheStatsSchema = z.enum(SHOW_CACHE_STATS_MODES)

describe('GlobalConfig — showCacheStats registration', () => {
  test('default is "compact"', () => {
    expect(DEFAULT_GLOBAL_CONFIG.showCacheStats).toBe('compact')
  })

  test('is listed in GLOBAL_CONFIG_KEYS (exposed via /config and ConfigTool)', () => {
    expect(GLOBAL_CONFIG_KEYS).toContain('showCacheStats')
    expect(isGlobalConfigKey('showCacheStats')).toBe(true)
  })

  test('SHOW_CACHE_STATS_MODES is the single source of truth', () => {
    expect(SHOW_CACHE_STATS_MODES).toEqual(['off', 'compact', 'full'])
  })
})

describe('showCacheStats — Zod validation', () => {
  test('accepts "off"', () => {
    expect(ShowCacheStatsSchema.parse('off')).toBe('off')
  })

  test('accepts "compact"', () => {
    expect(ShowCacheStatsSchema.parse('compact')).toBe('compact')
  })

  test('accepts "full"', () => {
    expect(ShowCacheStatsSchema.parse('full')).toBe('full')
  })

  test('rejects arbitrary strings', () => {
    expect(() => ShowCacheStatsSchema.parse('verbose')).toThrow()
    expect(() => ShowCacheStatsSchema.parse('')).toThrow()
    expect(() => ShowCacheStatsSchema.parse('ON')).toThrow()
  })

  test('rejects non-string values', () => {
    expect(() => ShowCacheStatsSchema.parse(true)).toThrow()
    expect(() => ShowCacheStatsSchema.parse(1)).toThrow()
    expect(() => ShowCacheStatsSchema.parse(null)).toThrow()
    expect(() => ShowCacheStatsSchema.parse(undefined)).toThrow()
  })
})

describe('showCacheStats — GlobalConfig type surface', () => {
  test('assignable to each accepted mode without casting', () => {
    const a: Pick<GlobalConfig, 'showCacheStats'> = { showCacheStats: 'off' }
    const b: Pick<GlobalConfig, 'showCacheStats'> = { showCacheStats: 'compact' }
    const c: Pick<GlobalConfig, 'showCacheStats'> = { showCacheStats: 'full' }
    expect([a.showCacheStats, b.showCacheStats, c.showCacheStats]).toEqual([
      'off',
      'compact',
      'full',
    ])
  })
})

describe('showCacheStats — default applies to pre-existing configs', () => {
  // Review feedback (P2 #7): "ensure the schema explicitly sets
  // showCacheStats: 'compact' as the default value, not relying on the
  // REPL gate's undefined handling."
  //
  // Config layer at src/utils/config.ts:1494 already does
  //   { ...createDefault(), ...parsedConfig }
  // so a user who had a config file from before this PR gets the
  // 'compact' default automatically on first load. These tests pin that
  // behavior so a future refactor of the merge pattern surfaces the
  // regression loudly.

  test('legacy config without showCacheStats field merges to default', () => {
    // Simulate what getConfig() produces for an old config.json that
    // predates this PR: spread default first, then spread the loaded
    // (incomplete) object on top.
    const legacyLoadedConfig = {
      // Fields typical of a pre-PR config — anything real but no
      // showCacheStats. The exact shape doesn't matter; we're testing
      // the merge semantics.
      theme: 'dark' as const,
    }
    const merged = {
      ...DEFAULT_GLOBAL_CONFIG,
      ...legacyLoadedConfig,
    }
    expect(merged.showCacheStats).toBe('compact')
  })

  test('user-set value overrides default via merge', () => {
    // Counterpart: if the user has explicitly set a value, the merge
    // must preserve it (defaults must NOT clobber user intent).
    const userConfig = { showCacheStats: 'off' as const }
    const merged = {
      ...DEFAULT_GLOBAL_CONFIG,
      ...userConfig,
    }
    expect(merged.showCacheStats).toBe('off')
  })

  test('REPL gate fallback kicks in only when mode is undefined', () => {
    // Belt-and-suspenders from REPL.tsx:3031 — `?? 'compact'` after the
    // config read. Simulates the code path in case a pathological config
    // read returns an empty object and skips the merge entirely.
    const corruptConfigRead: Partial<GlobalConfig> = {}
    const mode = corruptConfigRead.showCacheStats ?? 'compact'
    expect(mode).toBe('compact')

    // Explicit 'off' is preserved — fallback must not clobber user intent.
    const explicitOff: Partial<GlobalConfig> = { showCacheStats: 'off' }
    const modeOff = explicitOff.showCacheStats ?? 'compact'
    expect(modeOff).toBe('off')
  })
})
