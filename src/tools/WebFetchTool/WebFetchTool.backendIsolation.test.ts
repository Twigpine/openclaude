import { test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REAL_PROVIDER_TEST_TIMEOUT_MS,
  runTestFileWithRealProviders,
} from '../../test/providerModuleIsolation.js'

for (const inheritedMock of [false, true]) {
  test(`backend tests restore queryHaiku (inherited mock: ${inheritedMock})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'webfetch-backend-isolation-'))
    const entry = join(root, 'isolation.test.ts')
    try {
      // Exercise the actual suite's setup, calls and teardown in a disposable
      // process so this deliberately inherited module mock cannot leak either.
      await writeFile(entry, `
        import { afterEach, expect, mock } from 'bun:test'
        import * as claudeApi from ${JSON.stringify(join(import.meta.dir, '../../services/api/claude.ts'))}
        const inheritedMock = ${inheritedMock}
        const original = inheritedMock ? mock(async () => 'prior response') : claudeApi.queryHaiku
        if (inheritedMock) {
          mock.module(${JSON.stringify(join(import.meta.dir, '../../services/api/claude.ts'))}, () => ({
            ...claudeApi, queryHaiku: original,
          }))
        }
        await import(${JSON.stringify(join(import.meta.dir, 'WebFetchTool.backend.test.ts'))})
        afterEach(async () => {
          expect(claudeApi.queryHaiku).toBe(original)
          if (inheritedMock) {
            expect(await claudeApi.queryHaiku({ userPrompt: 'after backend tests' })).toBe('prior response')
          } else {
            expect('mock' in claudeApi.queryHaiku).toBe(false)
          }
        })
      `)
      await runTestFileWithRealProviders(entry)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    // Allow the child deadline plus time for assertions and fixture cleanup.
  }, { timeout: REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000 })
}
