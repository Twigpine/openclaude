import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const actualGrowthbook = {
  ...await import(`../services/analytics/growthbook.js?real=${Date.now()}-${Math.random()}`),
}

async function importFileModuleWithKillswitchEnabled(
  killswitchEnabled: boolean,
) {
  const realGrowthbook = await import(
    `../services/analytics/growthbook.js?real=${Date.now()}-${Math.random()}`
  )
  mock.module('../services/analytics/growthbook.js', () => ({
    ...realGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: () => killswitchEnabled,
  }))

  return import(`./file.js?ts=${Date.now()}-${Math.random()}`)
}

beforeAll(async () => {
  await acquireSharedMutationLock('utils/file.test.ts')
})

afterAll(() => {
  try {
    mock.restore()
    mock.module('../services/analytics/growthbook.js', () => actualGrowthbook)
  } finally {
    releaseSharedMutationLock()
  }
})

describe('addLineNumbers', () => {
  test('uses unambiguous arrow compact prefix and preserves leading tabs', async () => {
    const { addLineNumbers } = await importFileModuleWithKillswitchEnabled(false)

    const result = addLineNumbers({
      content: '\tfirst\n\t\tsecond',
      startLine: 41,
    })

    expect(result).toBe('41→\tfirst\n42→\t\tsecond')
  })

  test('keeps padded arrow format when compact mode is disabled', async () => {
    const { addLineNumbers } = await importFileModuleWithKillswitchEnabled(true)

    const result = addLineNumbers({
      content: 'alpha\nbeta',
      startLine: 1,
    })

    expect(result).toBe('     1→alpha\n     2→beta')
  })
})

describe('stripLineNumberPrefix', () => {
  test('strips compact arrow, padded arrow, and legacy tab prefixes', async () => {
    const { stripLineNumberPrefix } = await importFileModuleWithKillswitchEnabled(
      false,
    )

    expect(stripLineNumberPrefix('41→\tfirst')).toBe('\tfirst')
    expect(stripLineNumberPrefix('     2→beta')).toBe('beta')
    expect(stripLineNumberPrefix('7\t\tlegacy-tab')).toBe('\tlegacy-tab')
  })
})
