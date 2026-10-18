import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'

import {
  buildMiniMaxUsageRows,
  getMiniMaxUsageUrls,
  normalizeMiniMaxUsagePayload,
} from './minimaxUsage.js'

const fixture = (name: string) =>
  Bun.file(resolve(import.meta.dir, '__fixtures__', name))

beforeEach(async () => {
  await acquireSharedMutationLock('minimaxUsage.test.ts')
})

afterEach(() => {
  releaseSharedMutationLock()
})

describe('normalizeMiniMaxUsagePayload', () => {
  test('normalizes interval and weekly quota payloads', () => {
    const usage = normalizeMiniMaxUsagePayload({
      plan_type: 'plus_highspeed',
      data: {
        'MiniMax-M2.7-highspeed': {
          current_interval_usage_count: 4200,
          max_interval_usage_count: 4500,
          current_weekly_usage_count: 43000,
          max_weekly_usage_count: 45000,
        },
      },
    })

    expect(usage).toMatchObject({
      availability: 'available',
      planType: 'Plus Highspeed',
      snapshots: [
        {
          limitName: 'MiniMax-M2.7-highspeed',
          windows: [
            {
              label: '5h limit',
              usedPercent: 93,
              remaining: 300,
              total: 4500,
            },
            {
              label: 'Weekly limit',
              usedPercent: 96,
              remaining: 2000,
              total: 45000,
            },
          ],
        },
      ],
    })
  })

  test('normalizes daily quota payloads from generic usage records', () => {
    const usage = normalizeMiniMaxUsagePayload({
      models: {
        image_01: {
          daily_remaining: 12,
          daily_quota: 50,
        },
      },
    })

    expect(usage).toMatchObject({
      availability: 'available',
      snapshots: [
        {
          limitName: 'image_01',
          windows: [
            {
              label: 'Daily limit',
              usedPercent: 76,
              remaining: 12,
              total: 50,
            },
          ],
        },
      ],
    })
  })

  test('normalizes MiniMax model_remains payloads from a captured fixture', async () => {
    const payload = await fixture('minimax-model-remains.json').json()
    const originalDateNow = Date.now
    Date.now = () => Date.parse('2026-02-20T15:00:00.000Z')

    try {
      const usage = normalizeMiniMaxUsagePayload(payload)

      expect(usage).toMatchObject({
        availability: 'available',
        planType: 'Plus Highspeed',
        snapshots: [
          {
            limitName: 'MiniMax-M2.7',
            windows: [
              {
                label: '5h limit',
                usedPercent: 96,
                remaining: 63,
                total: 1500,
                resetsAt: '2026-02-20T16:00:00.000Z',
              },
            ],
          },
          {
            limitName: 'MiniMax-M2.7-highspeed',
            windows: [
              {
                label: '5h limit',
                usedPercent: 50,
                remaining: 1000,
                total: 2000,
                resetsAt: '2026-02-20T16:00:00.000Z',
              },
            ],
          },
        ],
      })
    } finally {
      Date.now = originalDateNow
    }
  })

  test('treats current_interval_usage_count as used count for MiniMax subscription payloads', () => {
    const usage = normalizeMiniMaxUsagePayload({
      model_remains: [
        {
          current_interval_total_count: 1500,
          current_interval_usage_count: 1,
          model_name: 'MiniMax-M2.7',
        },
      ],
    })

    expect(usage).toMatchObject({
      availability: 'available',
      snapshots: [
        {
          limitName: 'MiniMax-M2.7',
          windows: [
            {
              label: '5h limit',
              usedPercent: 0,
              remaining: 1499,
              total: 1500,
            },
          ],
        },
      ],
    })
  })

  test('treats MiniMax usage_percent as remaining percentage', () => {
    const usage = normalizeMiniMaxUsagePayload({
      model_remains: [
        {
          model_name: 'MiniMax-M2.7-highspeed',
          usage_percent: 96,
        },
      ],
    })

    expect(usage).toMatchObject({
      availability: 'available',
      snapshots: [
        {
          limitName: 'MiniMax-M2.7-highspeed',
          windows: [
            {
              label: '5h limit',
              usedPercent: 4,
            },
          ],
        },
      ],
    })
  })

  test('returns unknown availability when no quota windows can be parsed', () => {
    const usage = normalizeMiniMaxUsagePayload({
      message: 'quota status unavailable',
      ok: true,
    })

    expect(usage).toEqual({
      availability: 'unknown',
      planType: undefined,
      snapshots: [],
      message:
        'Usage details are not available for this MiniMax account. This plan or MiniMax endpoint may not expose quota status.',
    })
  })
})

describe('buildMiniMaxUsageRows', () => {
  test('builds provider-prefixed labels and remaining subtext', () => {
    const rows = buildMiniMaxUsageRows([
      {
        limitName: 'MiniMax-M2.7',
        windows: [
          {
            label: '5h limit',
            usedPercent: 20,
            remaining: 1200,
            total: 1500,
          },
          {
            label: 'Weekly limit',
            usedPercent: 10,
            remaining: 13500,
            total: 15000,
          },
        ],
      },
      {
        limitName: 'image_01',
        windows: [
          {
            label: 'Daily limit',
            usedPercent: 76,
            remaining: 12,
            total: 50,
          },
        ],
      },
    ])

    expect(rows).toEqual([
      {
        kind: 'text',
        label: 'MiniMax-M2.7 quota',
        value: '',
      },
      {
        kind: 'window',
        label: '5h limit',
        usedPercent: 20,
        resetsAt: undefined,
        extraSubtext: '1200/1500 remaining',
      },
      {
        kind: 'window',
        label: 'Weekly limit',
        usedPercent: 10,
        resetsAt: undefined,
        extraSubtext: '13500/15000 remaining',
      },
      {
        kind: 'window',
        label: 'Image 01 Daily limit',
        usedPercent: 76,
        resetsAt: undefined,
        extraSubtext: '12/50 remaining',
      },
    ])
  })
})

describe('MiniMax usage helpers', () => {
  test('keeps usage endpoints on the configured provider host and path', () => {
    expect(
      getMiniMaxUsageUrls('https://proxy.example/providers/minimax/v1'),
    ).toEqual([
      'https://proxy.example/providers/minimax/v1/token_plan/remains',
      'https://proxy.example/providers/minimax/v1/api/openplatform/coding_plan/remains',
    ])
  })

  test('falls back to OPENAI_API_BASE when OPENAI_BASE_URL is unset', () => {
    const originalBaseUrl = process.env.OPENAI_BASE_URL
    const originalApiBase = process.env.OPENAI_API_BASE
    delete process.env.OPENAI_BASE_URL
    process.env.OPENAI_API_BASE = 'https://gateway.example/openai/v1'

    try {
      expect(getMiniMaxUsageUrls()).toEqual([
        'https://gateway.example/openai/v1/token_plan/remains',
        'https://gateway.example/openai/v1/api/openplatform/coding_plan/remains',
      ])
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL
      } else {
        process.env.OPENAI_BASE_URL = originalBaseUrl
      }

      if (originalApiBase === undefined) {
        delete process.env.OPENAI_API_BASE
      } else {
        process.env.OPENAI_API_BASE = originalApiBase
      }
    }
  })

  test('throws when an explicitly configured MiniMax base url is invalid', () => {
    expect(() => getMiniMaxUsageUrls('not a url')).toThrow(
      'MiniMax usage base URL is invalid: not a url',
    )
  })

  test('uses the default MiniMax base url when no provider base is configured', () => {
    const originalBaseUrl = process.env.OPENAI_BASE_URL
    const originalApiBase = process.env.OPENAI_API_BASE
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE

    try {
      expect(getMiniMaxUsageUrls()).toEqual([
        'https://api.minimax.io/v1/token_plan/remains',
        'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
      ])
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL
      } else {
        process.env.OPENAI_BASE_URL = originalBaseUrl
      }

      if (originalApiBase === undefined) {
        delete process.env.OPENAI_API_BASE
      } else {
        process.env.OPENAI_API_BASE = originalApiBase
      }
    }
  })
})

for (const setup of ['openai-profile', 'native-profile-trailing-dot']) {
  for (const baseEnv of ['OPENAI_BASE_URL', 'OPENAI_API_BASE']) {
    for (const protocol of ['http', 'https']) {
      test(`China quota ${protocol} via ${setup} and ${baseEnv}`, async () => {
        const { applyProviderProfileToProcessEnv, clearProviderProfileEnvFromProcessEnv } = await import('../../utils/providerProfiles.js')
        const { buildStartupEnvFromProfile } = await import('../../utils/providerProfile.js')
        const { getProviderValidationError } = await import('../../utils/providerValidation.js')
        const { resolveActiveUsageId } = await import('../../commands/usage/index.js')
        const { fetchMiniMaxUsage } = await import('./minimaxUsage.js')
        const savedEnv = { ...process.env }
        const clearedEnv = { ...process.env }
        clearProviderProfileEnvFromProcessEnv(clearedEnv)
        const managedKeys = Object.keys(savedEnv).filter(key => !(key in clearedEnv))
        const savedFetch = globalThis.fetch
        const globals = globalThis as Record<string, unknown>
        const savedMacro = globals.MACRO
        globals.MACRO = { VERSION: '0.0.0-test' }
        const calls: { url: string; auth: string | null }[] = []
        const nativeProfile = setup === 'native-profile-trailing-dot'
        const quotaHost = nativeProfile ? 'api.minimaxi.com.' : 'api.minimaxi.com'
        try {
          applyProviderProfileToProcessEnv({
            id: 'china-quota-test', name: 'China quota test', provider: nativeProfile ? 'minimax' : 'custom',
            model: 'MiniMax-M3',
            baseUrl: nativeProfile ? 'https://api.minimaxi.com/anthropic' : `${protocol}://${quotaHost}/v1`,
            apiKey: 'quota-test-key',
          })
          process.env.OPENAI_BASE_URL = `${protocol}://${quotaHost}/v1`
          if (baseEnv === 'OPENAI_API_BASE') {
            process.env.OPENAI_API_BASE = process.env.OPENAI_BASE_URL
            delete process.env.OPENAI_BASE_URL
          }
          const startup = await buildStartupEnvFromProfile({ processEnv: process.env, persisted: null })
          expect(resolveActiveUsageId(startup)).toBe('minimax')
          globalThis.fetch = (async (input, init) => {
            calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
            return new Response('{}', { status: 404 })
          }) as typeof fetch
          if (protocol === 'http') {
            await expect(fetchMiniMaxUsage()).rejects.toThrow('MiniMax base URL must use HTTPS')
            expect(calls).toEqual([])
            await expect(getProviderValidationError(startup)).resolves.toBe(nativeProfile ? null : 'MiniMax base URL must use HTTPS')
          } else {
            await expect(getProviderValidationError(startup)).resolves.toBeNull()
            await expect(fetchMiniMaxUsage()).resolves.toMatchObject({ availability: 'unknown' })
            expect(calls).toEqual([
              { url: `https://${quotaHost}/v1/token_plan/remains`, auth: 'Bearer quota-test-key' },
              { url: `https://${quotaHost}/v1/api/openplatform/coding_plan/remains`, auth: 'Bearer quota-test-key' },
            ])
          }
        } finally {
          globalThis.fetch = savedFetch
          globals.MACRO = savedMacro
          clearProviderProfileEnvFromProcessEnv()
          for (const key of managedKeys) process.env[key] = savedEnv[key]
        }
      })
    }
  }
}
