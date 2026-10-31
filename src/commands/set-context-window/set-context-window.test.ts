import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { call as clearContextWindow } from '../clear-context-window/clear-context-window.js'
import { call as setContextWindow } from './set-context-window.js'
import {
  clearSessionContextWindowOverride,
  getContextWindowForModel,
  resolveContextWindowForModel,
} from '../../utils/context.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from '../../services/compact/autoCompact.js'

let hasSharedMutationLock = false
const savedEnv = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
}

beforeEach(async () => {
  await acquireSharedMutationLock('commands/set-context-window/set-context-window.test.ts')
  hasSharedMutationLock = true
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000'
  delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  clearSessionContextWindowOverride('claude-sonnet-4')
})

afterEach(() => {
  clearSessionContextWindowOverride('claude-sonnet-4')
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  if (hasSharedMutationLock) {
    releaseSharedMutationLock()
    hasSharedMutationLock = false
  }
})

test('/set-context-window updates tokens and compaction immediately; clear restores defaults', async () => {
  const context = {
    options: { mainLoopModel: 'claude-sonnet-4' },
  } as never

  expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(50_000)
  const result = await setContextWindow('1000000', context)
  expect(result).toMatchObject({ type: 'text', value: expect.stringContaining('1,000,000') })
  expect(getContextWindowForModel('claude-sonnet-4')).toBe(1_000_000)
  expect(getEffectiveContextWindowSize('claude-sonnet-4')).toBe(980_000)
  expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(950_000)

  await clearContextWindow('claude-sonnet-4', context)
  expect(getContextWindowForModel('claude-sonnet-4')).toBe(200_000)
  expect(getEffectiveContextWindowSize('claude-sonnet-4')).toBe(80_000)
  expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(50_000)
})

const SAVE_MODEL = 'my-private-model'

async function withCustomProviderSettings(
  initialSettings: string | undefined,
  run: (settingsPath: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-set-context-window-'))
  const settingsPath = join(root, 'settings.json')
  if (initialSettings !== undefined) {
    writeFileSync(settingsPath, initialSettings)
  }
  const restoreEnv = snapshotEnv(
    [
      'CLAUDE_CODE_USE_OPENAI',
      'OPENAI_BASE_URL',
      'OPENAI_API_BASE',
      'OPENAI_MODEL',
      'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
    ],
    { clear: true },
  )
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://llm.example.test/v1'
  const previousConfigDir = getClaudeConfigHomeDirOverrideForTesting()
  setClaudeConfigHomeDirForTesting(root)
  resetSettingsCache()
  try {
    await run(settingsPath)
  } finally {
    clearSessionContextWindowOverride(SAVE_MODEL)
    setClaudeConfigHomeDirForTesting(previousConfigDir)
    resetSettingsCache()
    restoreEnv()
    rmSync(root, { recursive: true, force: true })
  }
}

const saveContext = { options: { mainLoopModel: SAVE_MODEL } } as never

async function runSetContextWindow(args: string): Promise<string> {
  const result = await setContextWindow(args, saveContext)
  if (result.type !== 'text') throw new Error(`unexpected result type ${result.type}`)
  return result.value
}

test('/set-context-window --save persists the active model window for the next session', async () => {
  await withCustomProviderSettings(
    JSON.stringify({
      env: { KEEP_ME: '1' },
      modelLimits: { [SAVE_MODEL]: { maxOutputTokens: 32_768 } },
    }),
    async settingsPath => {
      expect(await runSetContextWindow('500000')).toContain('(session only)')
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).modelLimits).toEqual({
        [SAVE_MODEL]: { maxOutputTokens: 32_768 },
      })

      const output = await runSetContextWindow('1000000 --save')
      expect(output).toContain(`Saved to modelLimits["${SAVE_MODEL}"] in ${settingsPath}.`)
      expect(output).not.toContain('After a restart')
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
        env: { KEEP_ME: '1' },
        modelLimits: {
          [SAVE_MODEL]: { maxOutputTokens: 32_768, contextWindow: 1_000_000 },
        },
      })

      // A new session starts without session overrides and re-reads settings.
      clearSessionContextWindowOverride()
      resetSettingsCache()
      expect(resolveContextWindowForModel(SAVE_MODEL)).toEqual({
        contextWindow: 1_000_000,
        source: 'model-limits',
      })
    },
  )
})

test('/set-context-window --save reports when a higher-precedence source will shadow the saved value', async () => {
  await withCustomProviderSettings(undefined, async settingsPath => {
    process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({ [SAVE_MODEL]: 200_000 })

    const output = await runSetContextWindow(`${SAVE_MODEL} 1000000 --save`)

    expect(output).toContain(`Saved to modelLimits["${SAVE_MODEL}"] in ${settingsPath}.`)
    expect(output).toContain(
      'After a restart, CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS (exact match) will set 200,000 tokens instead of the saved value.',
    )
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).modelLimits).toEqual({
      [SAVE_MODEL]: { contextWindow: 1_000_000 },
    })
    expect(getContextWindowForModel(SAVE_MODEL)).toBe(1_000_000)
  })
})

test.each([
  ['the active model', '9007199254740992 --save'],
  ['an explicit model', `${SAVE_MODEL} 9007199254740992 --save`],
])('/set-context-window --save does not write a window the settings schema rejects (%s)', async (_form, args) => {
  const initialSettings = JSON.stringify({
    env: { KEEP_ME: '1' },
    modelLimits: { [SAVE_MODEL]: { maxOutputTokens: 32_768 } },
  })
  await withCustomProviderSettings(initialSettings, async settingsPath => {
    const output = await runSetContextWindow(args)

    expect(output).toContain(
      `Not saved: modelLimits.${SAVE_MODEL}.contextWindow: Too big: expected int to be <=9007199254740991`,
    )
    expect(output).toContain('The override applies to this session only.')
    expect(output).not.toContain('Saved to modelLimits')
    expect(readFileSync(settingsPath, 'utf8')).toBe(initialSettings)
    expect(getContextWindowForModel(SAVE_MODEL)).toBe(9_007_199_254_740_992)
  })
})

test.each([
  ['the active model', '1000000 --save'],
  ['an explicit model', '__proto__ 1000000 --save'],
])('/set-context-window --save does not report a save for a model name settings cannot store (%s)', async (_form, args) => {
  const initialSettings = JSON.stringify({ env: { KEEP_ME: '1' } })
  await withCustomProviderSettings(initialSettings, async settingsPath => {
    try {
      const result = await setContextWindow(args, {
        options: { mainLoopModel: '__proto__' },
      } as never)

      expect(result).toMatchObject({ type: 'text' })
      const output = result.type === 'text' ? result.value : ''
      expect(output).toContain(
        'Not saved: modelLimits["__proto__"]: settings cannot store this model name',
      )
      expect(output).toContain('The override applies to this session only.')
      expect(output).not.toContain('Saved to modelLimits')
      expect(readFileSync(settingsPath, 'utf8')).toBe(initialSettings)
      expect(getContextWindowForModel('__proto__')).toBe(1_000_000)
    } finally {
      clearSessionContextWindowOverride('__proto__')
    }
  })
})

test('/set-context-window --save reports when other invalid settings stop the saved file from loading', async () => {
  await withCustomProviderSettings(
    JSON.stringify({
      env: { KEEP_ME: '1' },
      modelLimits: { [SAVE_MODEL]: { maxOutputTokens: -1 } },
    }),
    async settingsPath => {
      const output = await runSetContextWindow('1000000 --save')

      expect(output).toContain(`Saved to modelLimits["${SAVE_MODEL}"] in ${settingsPath}.`)
      expect(output).toContain(
        `After a restart, the saved value will not apply: ${settingsPath} has invalid settings, so the whole file is ignored until they are fixed.\n  modelLimits.${SAVE_MODEL}.maxOutputTokens: Number must be greater than or equal to 0`,
      )
      expect(output).not.toContain('instead of the saved value')
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
        env: { KEEP_ME: '1' },
        modelLimits: {
          [SAVE_MODEL]: { maxOutputTokens: -1, contextWindow: 1_000_000 },
        },
      })
      expect(getContextWindowForModel(SAVE_MODEL)).toBe(1_000_000)
    },
  )
})

test('/set-context-window --save reports a plain save when it replaces an invalid saved window', async () => {
  await withCustomProviderSettings(
    JSON.stringify({ modelLimits: { [SAVE_MODEL]: { contextWindow: -5 } } }),
    async settingsPath => {
      const output = await runSetContextWindow('1000000 --save')

      expect(output).toContain(`Saved to modelLimits["${SAVE_MODEL}"] in ${settingsPath}.`)
      expect(output).not.toContain('After a restart')
      clearSessionContextWindowOverride()
      resetSettingsCache()
      expect(resolveContextWindowForModel(SAVE_MODEL)).toEqual({
        contextWindow: 1_000_000,
        source: 'model-limits',
      })
    },
  )
})

test.each([
  ['the active model', '1000000 --save'],
  ['an explicit model', `${SAVE_MODEL} 1000000 --save`],
])('/set-context-window --save reports env settings that a repair makes loadable (%s)', async (_form, args) => {
  const contextWindows = JSON.stringify({ [SAVE_MODEL]: 200_000 })
  await withCustomProviderSettings(
    JSON.stringify({
      env: { CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: contextWindows },
      modelLimits: { [SAVE_MODEL]: { contextWindow: -5 } },
    }),
    async settingsPath => {
      // Startup ignored the invalid file, so its env was never applied.
      expect(process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS).toBeUndefined()

      const output = await runSetContextWindow(args)

      expect(output).toContain(`Saved to modelLimits["${SAVE_MODEL}"] in ${settingsPath}.`)
      expect(output).toContain(
        `${settingsPath} had invalid settings before this save, so this session did not load its env settings (CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS). They can apply after a restart and change which window is used; this report does not account for them.`,
      )
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
        env: { CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: contextWindows },
        modelLimits: { [SAVE_MODEL]: { contextWindow: 1_000_000 } },
      })
      expect(process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS).toBeUndefined()
      expect(getContextWindowForModel(SAVE_MODEL)).toBe(1_000_000)
    },
  )
})

test.each([
  ['modelLimits', 'the active model', '1000000 --save', { modelLimits: [] }],
  ['modelLimits', 'an explicit model', `${SAVE_MODEL} 1000000 --save`, { modelLimits: [] }],
  [`modelLimits["${SAVE_MODEL}"]`, 'the active model', '1000000 --save', { modelLimits: { [SAVE_MODEL]: [] } }],
  [`modelLimits["${SAVE_MODEL}"]`, 'an explicit model', `${SAVE_MODEL} 1000000 --save`, { modelLimits: { [SAVE_MODEL]: [] } }],
])('/set-context-window --save does not report a save when %s is an array (%s)', async (container, _form, args, initial) => {
  const initialSettings = { env: { KEEP_ME: '1' }, ...initial }
  await withCustomProviderSettings(JSON.stringify(initialSettings), async settingsPath => {
    const output = await runSetContextWindow(args)

    expect(output).toContain(`Not saved: ${container} in ${settingsPath} is an array`)
    expect(output).toContain('The override applies to this session only.')
    expect(output).not.toContain('Saved to modelLimits')
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(initialSettings)
    expect(getContextWindowForModel(SAVE_MODEL)).toBe(1_000_000)
  })
})

test('/set-context-window --save keeps the session override when saving fails', async () => {
  await withCustomProviderSettings('{ not json', async settingsPath => {
    const output = await runSetContextWindow('1000000 --save')

    expect(output).toContain(`Not saved: Invalid JSON syntax in settings file at ${settingsPath}`)
    expect(output).toContain('The override applies to this session only.')
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json')
    expect(getContextWindowForModel(SAVE_MODEL)).toBe(1_000_000)
  })
})
