import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ModelCatalogEntry } from './descriptors.js'
import {
  clearDiscoveryCache,
  getCachedModels,
  getDiscoveryCachePath,
  isCacheStale,
  parseDurationString,
  recordDiscoveryError,
  setCachedModels,
} from './discoveryCache.js'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../utils/fsOperations.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const originalConfigDir = process.env.OPENCLAUDE_CONFIG_DIR

let tempDir: string

function createModel(id: string): ModelCatalogEntry {
  return {
    id,
    apiName: id,
    label: id,
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('discoveryCache.test.ts')
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-discovery-cache-test-'))
  process.env.OPENCLAUDE_CONFIG_DIR = tempDir
  setOriginalFsImplementation()
  await clearDiscoveryCache()
})

afterEach(() => {
  try {
    setOriginalFsImplementation()
    if (originalConfigDir === undefined) {
      delete process.env.OPENCLAUDE_CONFIG_DIR
    } else {
      process.env.OPENCLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

describe('parseDurationString', () => {
  test('parses minute, hour, day, and raw millisecond values', () => {
    expect(parseDurationString('30m')).toBe(1_800_000)
    expect(parseDurationString('1h')).toBe(3_600_000)
    expect(parseDurationString('2d')).toBe(172_800_000)
    expect(parseDurationString('5000')).toBe(5000)
    expect(parseDurationString(2500)).toBe(2500)
  })

  test('rejects invalid duration values', () => {
    expect(() => parseDurationString('')).toThrow()
    expect(() => parseDurationString('-1')).toThrow()
    expect(() => parseDurationString('15s')).toThrow()
  })
})

describe('discovery cache storage', () => {
  test('stores and returns fresh cached models, then reports stale entries', async () => {
    const updatedAt = Date.now() - 250
    await setCachedModels('ollama', {
      models: [createModel('llama3')],
      updatedAt,
    })

    await expect(getCachedModels('ollama', 1_000)).resolves.toEqual({
      models: [createModel('llama3')],
      updatedAt,
      error: null,
    })
    await expect(isCacheStale('ollama', 1_000)).resolves.toBe(false)
    await expect(getCachedModels('ollama', 100)).resolves.toBeNull()
    await expect(
      getCachedModels('ollama', 100, { includeStale: true }),
    ).resolves.toEqual({
      models: [createModel('llama3')],
      updatedAt,
      error: null,
    })
    await expect(isCacheStale('ollama', 100)).resolves.toBe(true)
  })

  test('recordDiscoveryError preserves stale data and appends error metadata', async () => {
    const updatedAt = Date.now() - 10_000
    await setCachedModels('openrouter', {
      models: [createModel('openai/gpt-5-mini')],
      updatedAt,
    })

    await recordDiscoveryError('openrouter', new Error('discovery failed'))

    const raw = JSON.parse(
      readFileSync(getDiscoveryCachePath(), 'utf-8'),
    ) as {
      entries: Record<
        string,
        {
          models: ModelCatalogEntry[]
          updatedAt: number | null
          error: { message: string; recordedAt: number } | null
        }
      >
    }

    expect(raw.entries.openrouter.models).toEqual([
      createModel('openai/gpt-5-mini'),
    ])
    expect(raw.entries.openrouter.updatedAt).toBe(updatedAt)
    expect(raw.entries.openrouter.error?.message).toBe('discovery failed')
    expect(raw.entries.openrouter.error?.recordedAt).toBeNumber()
    await expect(getCachedModels('openrouter', 1_000)).resolves.toBeNull()
    await expect(
      getCachedModels('openrouter', 1_000, { includeStale: true }),
    ).resolves.toEqual({
      models: [createModel('openai/gpt-5-mini')],
      updatedAt,
      error: {
        message: 'discovery failed',
        recordedAt: expect.any(Number),
      },
    })
  })

  test('recordDiscoveryError stores error-only entry when no cache exists', async () => {
    await recordDiscoveryError('lmstudio', 'boom')

    const raw = JSON.parse(
      readFileSync(getDiscoveryCachePath(), 'utf-8'),
    ) as {
      entries: Record<
        string,
        {
          models: ModelCatalogEntry[]
          updatedAt: number | null
          error: { message: string; recordedAt: number } | null
        }
      >
    }

    expect(raw.entries.lmstudio.models).toEqual([])
    expect(raw.entries.lmstudio.updatedAt).toBeNull()
    expect(raw.entries.lmstudio.error?.message).toBe('boom')
    await expect(getCachedModels('lmstudio', 1_000)).resolves.toBeNull()
    await expect(
      getCachedModels('lmstudio', 1_000, { includeStale: true }),
    ).resolves.toEqual({
      models: [],
      updatedAt: null,
      error: {
        message: 'boom',
        recordedAt: expect.any(Number),
      },
    })
    await expect(isCacheStale('lmstudio', 1_000)).resolves.toBe(true)
  })

  test('clearDiscoveryCache clears one route or the full cache', async () => {
    await setCachedModels('ollama', { models: [createModel('llama3')] })
    await setCachedModels('atomic-chat', { models: [createModel('qwen3')] })

    await clearDiscoveryCache('ollama')
    await expect(getCachedModels('ollama', 60_000)).resolves.toBeNull()
    await expect(getCachedModels('atomic-chat', 60_000)).resolves.not.toBeNull()

    await clearDiscoveryCache()
    await expect(getCachedModels('atomic-chat', 60_000)).resolves.toBeNull()
  })

  test('corruption fallback returns empty cache without crashing', async () => {
    writeFileSync(getDiscoveryCachePath(), '{not-json', 'utf-8')

    await expect(getCachedModels('ollama', 60_000)).resolves.toBeNull()
    await expect(isCacheStale('ollama', 60_000)).resolves.toBe(true)
  })
})

describe('discovery cache write safety', () => {
  test('failed atomic rename preserves existing cache file', async () => {
    await setCachedModels('ollama', { models: [createModel('llama3')] })

    const originalFs = getFsImplementation()
    setFsImplementation({
      ...originalFs,
      rename: async () => {
        throw new Error('simulated rename crash')
      },
    })

    await setCachedModels('ollama', { models: [createModel('qwen3')] })

    setOriginalFsImplementation()

    await expect(getCachedModels('ollama', 60_000)).resolves.toEqual({
      models: [createModel('llama3')],
      updatedAt: expect.any(Number),
      error: null,
    })
  })

  test('concurrent writes are serialized by the discovery cache lock', async () => {
    const originalFs = getFsImplementation()
    let activeRenames = 0
    let maxActiveRenames = 0

    setFsImplementation({
      ...originalFs,
      rename: async (oldPath: string, newPath: string) => {
        activeRenames++
        maxActiveRenames = Math.max(maxActiveRenames, activeRenames)
        await Bun.sleep(25)
        try {
          await originalFs.rename(oldPath, newPath)
        } finally {
          activeRenames--
        }
      },
    })

    await Promise.all([
      setCachedModels('ollama', { models: [createModel('llama3')] }),
      setCachedModels('openrouter', { models: [createModel('openai/gpt-5-mini')] }),
      setCachedModels('atomic-chat', { models: [createModel('qwen3')] }),
    ])

    expect(maxActiveRenames).toBe(1)
  })
})
