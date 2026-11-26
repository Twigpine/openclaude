import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { setReplModeEnabledForSession } from '../tools/REPLTool/constants.js'

const actualGrowthbook = {
  ...await import(`../services/analytics/growthbook.js?real=${Date.now()}-${Math.random()}`),
}

async function importMemdirWithPastContextEnabled() {
  const realGrowthbook = await import(
    `../services/analytics/growthbook.js?real=${Date.now()}-${Math.random()}`
  )
  mock.module('../services/analytics/growthbook.js', () => ({
    ...realGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: () => true,
  }))
  return import(`./memdir.js?code-mode-test=${Date.now()}-${Math.random()}`)
}

let originalEmbeddedSearchTools: string | undefined

beforeAll(async () => {
  await acquireSharedMutationLock('memdir/memdir.codeMode.test.ts')
  originalEmbeddedSearchTools = process.env.EMBEDDED_SEARCH_TOOLS
  process.env.EMBEDDED_SEARCH_TOOLS = '0'
})

afterEach(() => {
  setReplModeEnabledForSession(false)
})

afterAll(() => {
  try {
    mock.restore()
    mock.module('../services/analytics/growthbook.js', () => actualGrowthbook)
    if (originalEmbeddedSearchTools === undefined) {
      delete process.env.EMBEDDED_SEARCH_TOOLS
    } else {
      process.env.EMBEDDED_SEARCH_TOOLS = originalEmbeddedSearchTools
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('memory search guidance uses the direct Grep tool when Code Mode is inactive', async () => {
  const { buildSearchingPastContextSection } = await importMemdirWithPastContextEnabled()
  setReplModeEnabledForSession(false)

  const text = buildSearchingPastContextSection('/tmp/memory').join('\n')

  expect(text).toContain('Grep with pattern="<search term>" path="/tmp/memory" glob="*.md"')
  expect(text).not.toContain('grep -rn "<search term>" /tmp/memory')
})

test('memory search guidance uses shell grep form when Code Mode is active', async () => {
  const { buildSearchingPastContextSection } = await importMemdirWithPastContextEnabled()
  setReplModeEnabledForSession(true)

  const text = buildSearchingPastContextSection('/tmp/memory').join('\n')

  expect(text).toContain('grep -rn "<search term>" /tmp/memory --include="*.md"')
  expect(text).not.toContain('Grep with pattern="<search term>" path="/tmp/memory"')
})
