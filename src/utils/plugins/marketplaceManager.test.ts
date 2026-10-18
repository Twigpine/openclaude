import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  type Mock,
  test,
} from 'bun:test'
import * as realAxios from 'axios'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as realExecFileNoThrow from '../execFileNoThrow.js'
import {
  getFsImplementation,
  NodeFsOperations,
  setFsImplementation,
  type FsOperations,
} from '../fsOperations.js'

import type { MarketplaceSource } from './schemas.js'

// @ts-expect-error -- query-string cache-buster: the import specifier ends with `?bust=...`
// so TypeScript cannot resolve the bare path. The runtime import works under Bun (treats the
// query string as a distinct module id that bypasses other test files' mock.module registrations).
import { _test, removeMarketplaceSource, getMarketplaceCacheOnly, getPluginByIdCacheOnly } from './marketplaceManager.js?bust=this-test-needs-the-real-module'

const { loadAndCacheMarketplace } = _test

/**
 * The static import above uses a query-string suffix to bypass Bun's
 * mock.module() registry under the bare `./marketplaceManager.js` path.
 *
 * Why: in the full test suite, `lspRecommendation.test.ts` (line 32) and
 * `officialMarketplaceStartupCheck.test.ts` (line 96) both call
 * `mock.module('./marketplaceManager.js', () => ({...}))` at module
 * top-level to stub out `addMarketplaceSource`, `getMarketplace`, etc.
 * Neither stub exports `_test`, so a static import under the bare path
 * would resolve to a mock without `_test` and every test below would fail
 * with "Export named '_test' not found" when those test files run first.
 *
 * The `?bust=...` suffix makes Bun treat this URL as a distinct module id
 * and skip the mock.module() registration for the bare path. The same trick
 * is used in src/utils/betas.test.ts (per-test, with `?ts=${Date.now()}-`)
 * to force fresh imports that re-evaluate memoized provider detection. We
 * use a constant suffix here because we only need the import to happen
 * once at module top-level — no per-test re-evaluation.
 *
 * The `// @ts-expect-error` above is required because TypeScript
 * resolves the import specifier at compile time and rejects the query
 * string. The runtime import works under Bun; the type assertion is
 * only to satisfy `tsc --noEmit`.
 */

/**
 * Regression test for issue #1500 / PR #1531.
 *
 * On case-insensitive filesystems (Windows NTFS), the temporary cache path
 * and the final cache path can differ only in case — meaning they point at
 * the SAME directory. The old finalization code called fs.rm(finalCachePath)
 * unconditionally, which destroyed the source data and made the subsequent
 * fs.rename fail with ENOENT.
 *
 * The fix adds a `samePathCaseInsensitive` guard that skips the rm + rename
 * block when temporaryCachePath.toLowerCase() === finalCachePath.toLowerCase().
 *
 * A `settings` source is the cleanest way to drive this branch: it is
 * non-local (so the rename block is entered, unlike file/directory sources),
 * needs no network, and synthesizes its marketplace.json on disk under the
 * source's name. With a mixed-case name the temp path keeps the original case
 * while the final path is lowercased — so the two differ only in case.
 */
describe('loadAndCacheMarketplace — Windows cache finalization (#1500)', () => {
  let tempDir: string
  let originalFs: FsOperations
  let originalCacheDir: string | undefined
  let rmCallCount: number
  let renameSpy: Mock<typeof NodeFsOperations.rename>
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    // These cases model the Windows (case-insensitive) bug from #1500, so pin
    // the platform: the finalization now skips the rm/rename only on a
    // case-insensitive filesystem, and the host CI runner is case-sensitive
    // Linux. See the case-sensitive sibling test below for the inverse.
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    })
    tempDir = mkdtempSync(join(tmpdir(), 'mp-cache-'))
    // getPluginsDirectory() honours this env var, so getMarketplacesCacheDir()
    // resolves to <tempDir>/marketplaces.
    originalCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = tempDir

    // Wrap the real filesystem so all operations actually happen, but rm and
    // rename are observable. The guard is a pure string comparison, so its
    // effect on control flow is identical on every platform.
    originalFs = getFsImplementation()
    rmCallCount = 0
    const rmWrapper = async (
      path: string,
      options?: { recursive?: boolean; force?: boolean },
    ) => {
      rmCallCount++
      rmSync(path, options ?? { recursive: true, force: true })
    }
    renameSpy = mock((oldPath: string, newPath: string) =>
      NodeFsOperations.rename(oldPath, newPath),
    )
    setFsImplementation({
      ...NodeFsOperations,
      rm: rmWrapper,
      rename: renameSpy,
    })
  })

  afterEach(() => {
    setFsImplementation(originalFs)
    if (originalCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalCacheDir
    }
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('skips rm/rename when temp and final cache paths differ only in case', async () => {
    const source: MarketplaceSource = {
      source: 'settings',
      name: 'MyMarketplace',
      plugins: [],
    }

    const result = await loadAndCacheMarketplace!(source)

    const cacheDir = join(tempDir, 'marketplaces')
    const temporaryCachePath = join(cacheDir, 'MyMarketplace')
    const finalCachePath = join(cacheDir, 'mymarketplace')

    // Sanity check: this test only exercises the guard if the two paths really
    // do differ only in case. If this ever stops holding, the assertions below
    // would pass vacuously.
    expect(temporaryCachePath).not.toBe(finalCachePath)
    expect(temporaryCachePath.toLowerCase()).toBe(finalCachePath.toLowerCase())

    // The rename block must be skipped entirely — rename is the call that
    // failed with ENOENT once rm had destroyed the source.
    expect(renameSpy).not.toHaveBeenCalled()

    // fs.rm must never target the final cache path, which on a case-insensitive
    // filesystem is the very directory holding the freshly written manifest.
    expect(rmCallCount).toBe(0)

    // The cached source survives: the manifest is still on disk and the
    // returned cache path keeps the original (un-renamed) directory.
    expect(result.marketplace.name).toBe('MyMarketplace')
    expect(result.cachePath).toBe(temporaryCachePath)
    expect(
      existsSync(join(temporaryCachePath, '.claude-plugin', 'marketplace.json')),
    ).toBe(true)
  })

  // Regression test explicitly modeling the exact #1500 bug report scenario:
  // a mixed-case GitHub repo like 'AgriciDaniel/claude-obsidian' whose
  // marketplace.json has a matching (or case-variant) name. On Windows,
  // paths differing only in case point to the same directory — the old
  // code would rm the destination (destroying the source data) and then
  // fail the rename with ENOENT.
  test('skips rm/rename for mixed-case GitHub-style names (issue #1500)', async () => {
    const source: MarketplaceSource = {
      source: 'settings',
      name: 'AgriciDaniel-claude-obsidian', // mixed-case, like the GitHub repo
      plugins: [],
    }

    const result = await loadAndCacheMarketplace!(source)

    const cacheDir = join(tempDir, 'marketplaces')
    const temporaryCachePath = join(cacheDir, 'AgriciDaniel-claude-obsidian')
    const finalCachePath = join(cacheDir, 'agricidaniel-claude-obsidian')

    // Paths differ only in case — same directory on case-insensitive fs
    expect(temporaryCachePath).not.toBe(finalCachePath)
    expect(temporaryCachePath.toLowerCase()).toBe(finalCachePath.toLowerCase())

    // The case-insensitive guard must prevent rm + rename
    expect(renameSpy).not.toHaveBeenCalled()

    expect(rmCallCount).toBe(0)

    // Data survives and cache path preserves the original case
    expect(result.marketplace.name).toBe('AgriciDaniel-claude-obsidian')
    expect(result.cachePath).toBe(temporaryCachePath)
    expect(
      existsSync(join(temporaryCachePath, '.claude-plugin', 'marketplace.json')),
    ).toBe(true)
  })

  // When the source name is already lowercase, getCachePathForSource (for
  // github sources) and finalCachePath both produce lowercase strings —
  // they are identical, so the rename block at line 1725 is skipped at the
  // string-equality check without ever reaching the case-only guard. This
  // is the post-fix fast path for GitHub marketplaces.
  test('skips rm/rename when temp and final paths are already identical (lowercase)', async () => {
    const source: MarketplaceSource = {
      source: 'settings',
      name: 'claude-obsidian', // already lowercase, like a marketplace name
      plugins: [],
    }

    const result = await loadAndCacheMarketplace!(source)

    const cacheDir = join(tempDir, 'marketplaces')
    const cachePath = join(cacheDir, 'claude-obsidian')

    // Both temp and final paths are the same string — the rename block
    // is skipped at line 1725 (temporaryCachePath !== finalCachePath).
    expect(renameSpy).not.toHaveBeenCalled()

    // fs.rm must not target the cache directory at all
    expect(rmCallCount).toBe(0)

    expect(result.marketplace.name).toBe('claude-obsidian')
    expect(result.cachePath).toBe(cachePath)
    expect(
      existsSync(join(cachePath, '.claude-plugin', 'marketplace.json')),
    ).toBe(true)
  })
})

/**
 * Regression test: rename-failure fallback (EXDEV).
 *
 * When fs.rename fails (e.g. EXDEV on cross-device moves), the cache
 * finalization must fall back to cp + rm. This test uses a 'url' source
 * (with a mocked HTTP response) so that the temporary cache path (timestamp-
 * based) and the final cache path (marketplace.name.toLowerCase()) truly
 * differ, ensuring the samePathCaseInsensitive guard does not skip the
 * rename block. The test then forces rename to throw and verifies the
 * fallback correctly copies the temp cache to the final location, cleans up
 * the temp path, and returns the final cache path.
 */
describe('loadAndCacheMarketplace — rename failure fallback (EXDEV)', () => {
  let loadAndCacheWithMockedAxios: typeof loadAndCacheMarketplace
  let getMarketplaceWithMockedAxios: typeof import('./marketplaceManager.js').getMarketplace
  let getPluginByIdWithMockedAxios: typeof import('./marketplaceManager.js').getPluginById
  let saveKnownMarketplacesConfigWithMockedAxios: typeof import('./marketplaceManager.js').saveKnownMarketplacesConfig
  let loadKnownMarketplacesConfigWithMockedAxios: typeof import('./marketplaceManager.js').loadKnownMarketplacesConfig
  let clearMarketplacesCacheWithMockedAxios: typeof import('./marketplaceManager.js').clearMarketplacesCache
  let tempDir: string
  let originalFs: FsOperations
  let originalCacheDir: string | undefined
  let rmCallCount: number
  let renameSpy: Mock<typeof NodeFsOperations.rename>
  let cpSpy: Mock<typeof NodeFsOperations.cp>

  // Mock axios so the 'url' source can fetch without network.
  // Wrapped inside this describe block so mocks don't leak to other tests
  // when running the full suite.
  const fakeMarketplaceJson = {
    name: 'MyMarketplace',
    owner: { name: 'test' },
    plugins: [{ name: 'demo-plugin', source: './' }],
  }
  const axiosGetSpy = mock(async () => ({
    data: fakeMarketplaceJson,
    status: 200,
    headers: {},
  }))

  beforeAll(async () => {
    mock.module('axios', () => ({
      default: {
        get: axiosGetSpy,
      },
      isAxiosError: () => false,
    }))
    mock.module('../execFileNoThrow.js', () => ({
      ...realExecFileNoThrow,
      execFileNoThrow: async () => ({
        code: 255,
        stdout: '',
        stderr: 'Permission denied',
      }),
      execFileNoThrowWithCwd: async (
        _file: string,
        args: string[] = [],
      ) => {
        if (args.includes('clone')) {
          const targetPath = args.at(-1)
          if (targetPath) {
            mkdirSync(join(targetPath, '.claude-plugin'), { recursive: true })
            writeFileSync(
              join(targetPath, '.claude-plugin', 'marketplace.json'),
              JSON.stringify(fakeMarketplaceJson),
            )
          }
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'not a git repository' }
      },
    }))

    // Re-import with mocked axios so the module under test picks up the mock.
    // The `?bust=` suffix is the same trick the dynamic import at the top of
    // this file uses — it gives Bun a unique module id that bypasses any
    // mock.module('./marketplaceManager.js', ...) registration made by
    // other test files (lspRecommendation, officialMarketplaceStartupCheck).
    // Without it, when those test files run first their partial mock is
    // picked up here and `_test` is undefined.
    // Template literal with interpolation so TypeScript treats the
    // specifier as a dynamic `string` and doesn't try to resolve the
    // query string at compile time. The `as typeof import(...)` cast on
    // the result then types it as the real module shape. Same pattern
    // as src/utils/hookChains.integration.test.ts:43-50.
    const mod = (await import(
      `./marketplaceManager.ts?bust=exdev-test-reimport-${Date.now()}`
    )) as typeof import('./marketplaceManager.js')
    loadAndCacheWithMockedAxios = mod._test.loadAndCacheMarketplace
    getMarketplaceWithMockedAxios = mod.getMarketplace
    getPluginByIdWithMockedAxios = mod.getPluginById
    saveKnownMarketplacesConfigWithMockedAxios = mod.saveKnownMarketplacesConfig
    loadKnownMarketplacesConfigWithMockedAxios = mod.loadKnownMarketplacesConfig
    clearMarketplacesCacheWithMockedAxios = mod.clearMarketplacesCache
  })

  afterAll(() => {
    mock.module('axios', () => realAxios)
    mock.module('../execFileNoThrow.js', () => realExecFileNoThrow)
  })

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mp-cache-'))
    originalCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = tempDir

    originalFs = getFsImplementation()
    rmCallCount = 0
    const rmWrapper = async (
      path: string,
      options?: { recursive?: boolean; force?: boolean },
    ) => {
      rmCallCount++
      rmSync(path, options ?? { recursive: true, force: true })
    }
    renameSpy = mock((oldPath: string, newPath: string) =>
      NodeFsOperations.rename(oldPath, newPath),
    )
    cpSpy = mock(
      (
        source: string,
        destination: string,
        options?: { recursive?: boolean },
      ) => NodeFsOperations.cp(source, destination, options),
    )
    setFsImplementation({
      ...NodeFsOperations,
      rm: rmWrapper,
      rename: renameSpy,
      cp: cpSpy,
    })
  })

  afterEach(() => {
    clearMarketplacesCacheWithMockedAxios?.()
    setFsImplementation(originalFs)
    if (originalCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalCacheDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('falls back to cp+rm when rename throws EXDEV', async () => {
    // Force rename to throw, simulating a cross-device move error.
    renameSpy.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted, rename')
    })

    // Use a 'url' source so the temp cache path (temp_<timestamp>.json
    // from getCachePathForSource) differs from the final cache path
    // (mymarketplace from marketplace.name.toLowerCase()). This bypasses
    // the samePathCaseInsensitive guard and lets the rename block execute.
    // Note: the source's own `name` field is unused for url sources
    // (finalCachePath is derived from the marketplace manifest name), so
    // the schema does not allow it. Hardcode only the fields the schema
    // permits.
    const source: MarketplaceSource = {
      source: 'url',
      url: 'https://example.com/marketplace.json',
    }

    const cacheDir = join(tempDir, 'marketplaces')
    const finalCachePath = join(cacheDir, 'mymarketplace')

    // Create the cache directory and snapshot its contents BEFORE calling
    // the function under test. This makes the assertion platform-agnostic:
    // we compare against the pre-call state instead of assuming the
    // directory is empty (which fails on case-sensitive filesystems where
    // the temp file and final file can coexist as distinct entries).
    mkdirSync(cacheDir, { recursive: true })
    const beforeEntries = new Set(readdirSync(cacheDir))

    const result = await loadAndCacheWithMockedAxios!(source)

    // After the fallback, the result cache path must be the final path
    expect(result.cachePath).toBe(finalCachePath)

    // The marketplace manifest must exist at the final location.
    // For 'url' sources the cache is stored as a flat JSON file named
    // after the marketplace (e.g. 'mymarketplace'), not a directory.
    expect(existsSync(finalCachePath)).toBe(true)

    // renameSpy must have been called at least once and must have thrown,
    // proving the code entered the catch block that triggers the cp+rm
    // fallback. Without this assertion, the test would still pass if the
    // code somehow reached the final file via a different path.
    expect(renameSpy).toHaveBeenCalled()
    const renameCalls = renameSpy.mock.calls
    expect(renameCalls.length).toBeGreaterThan(0)

    // The cp+rm fallback must have copied the temp cache to the final path
    // with { recursive: true }. Asserting on the cp spy (not just the end
    // state) proves the fallback branch actually executed rather than the
    // file arriving via some other path.
    expect(cpSpy).toHaveBeenCalledTimes(1)
    const [cpSource, cpDest, cpOptions] = cpSpy.mock.calls[0]!
    expect(cpDest).toBe(finalCachePath)
    expect(cpSource.startsWith(join(cacheDir, 'temp_'))).toBe(true)
    expect(cpOptions).toEqual({ recursive: true })

    // The cp+rm fallback must have invoked fs.rm on the temporary file.
    expect(rmCallCount).toBeGreaterThan(0)

    // The temporary file (temp_<timestamp>.json) MUST be cleaned up — no
    // temp artifacts may remain after the fallback runs.
    const afterEntries = readdirSync(cacheDir)
    const lingeringTempFiles = afterEntries.filter(e =>
      e.startsWith('temp_'),
    )
    expect(lingeringTempFiles).toEqual([])

    // Compare post-call directory state against the pre-call snapshot to
    // verify only the final file was added.
    const newEntries = afterEntries.filter(e => !beforeEntries.has(e))
    expect(newEntries).toEqual(['mymarketplace'])
  })

  test('keeps the temp cache when copy fallback throws ENOENT (issue #2183)', async () => {
    renameSpy.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted, rename')
    })
    cpSpy.mockImplementation(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, copyfile 'chromedevtools-chrome-devtools-mcp/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps' -> 'chrome-devtools-plugins/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps'",
        ),
        { code: 'ENOENT' },
      )
    })

    const source: MarketplaceSource = {
      source: 'url',
      url: 'https://example.com/marketplace.json',
    }

    const cacheDir = join(tempDir, 'marketplaces')
    mkdirSync(cacheDir, { recursive: true })

    const result = await loadAndCacheWithMockedAxios!(source)

    expect(result.marketplace.name).toBe('MyMarketplace')
    expect(result.cachePath.startsWith(join(cacheDir, 'temp_'))).toBe(true)
    expect(existsSync(result.cachePath)).toBe(true)
    expect(existsSync(join(cacheDir, 'mymarketplace'))).toBe(false)
    expect(cpSpy).toHaveBeenCalled()
  })

  test('keeps the temp cache when dest cleanup after copy ENOENT throws', async () => {
    renameSpy.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted, rename')
    })
    let copyAttempted = false
    cpSpy.mockImplementation(async () => {
      copyAttempted = true
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, copyfile 'chromedevtools-chrome-devtools-mcp/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps' -> 'chrome-devtools-plugins/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps'",
        ),
        { code: 'ENOENT' },
      )
    })

    const cacheDir = join(tempDir, 'marketplaces')
    mkdirSync(cacheDir, { recursive: true })
    const finalCachePath = join(cacheDir, 'mymarketplace')

    setFsImplementation({
      ...NodeFsOperations,
      rm: async (path, options?: { recursive?: boolean; force?: boolean }) => {
        rmCallCount++
        if (copyAttempted && path === finalCachePath) {
          throw Object.assign(new Error('EPERM: operation not permitted'), {
            code: 'EPERM',
          })
        }
        rmSync(path, options ?? { recursive: true, force: true })
      },
      rename: renameSpy,
      cp: cpSpy,
    })

    const source: MarketplaceSource = {
      source: 'url',
      url: 'https://example.com/marketplace.json',
    }

    const result = await loadAndCacheWithMockedAxios!(source)

    expect(result.marketplace.name).toBe('MyMarketplace')
    expect(result.cachePath.startsWith(join(cacheDir, 'temp_'))).toBe(true)
    expect(existsSync(result.cachePath)).toBe(true)
    expect(cpSpy).toHaveBeenCalled()
  })

  test('getMarketplace refetch persists keep-temp cachePath as installLocation', async () => {
    renameSpy.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted, rename')
    })
    cpSpy.mockImplementation(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, copyfile 'chromedevtools-chrome-devtools-mcp/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps' -> 'chrome-devtools-plugins/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps'",
        ),
        { code: 'ENOENT' },
      )
    })

    const cacheDir = join(tempDir, 'marketplaces')
    mkdirSync(cacheDir, { recursive: true })
    const staleCanonicalPath = join(cacheDir, 'mymarketplace')

    await saveKnownMarketplacesConfigWithMockedAxios!({
      MyMarketplace: {
        source: {
          source: 'url',
          url: 'https://example.com/marketplace.json',
        },
        installLocation: staleCanonicalPath,
        lastUpdated: '2020-01-01T00:00:00.000Z',
      },
    })
    clearMarketplacesCacheWithMockedAxios!()

    const marketplace = await getMarketplaceWithMockedAxios!('MyMarketplace')
    expect(marketplace.name).toBe('MyMarketplace')

    const config = await loadKnownMarketplacesConfigWithMockedAxios!()
    const persisted = config.MyMarketplace?.installLocation
    expect(persisted?.startsWith(join(cacheDir, 'temp_'))).toBe(true)
    expect(existsSync(persisted!)).toBe(true)
    expect(persisted).not.toBe(staleCanonicalPath)
  })

  test('getPluginById returns persisted keep-temp installLocation after refetch', async () => {
    renameSpy.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted, rename')
    })
    cpSpy.mockImplementation(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, copyfile 'chromedevtools-chrome-devtools-mcp/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps' -> 'chrome-devtools-plugins/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps'",
        ),
        { code: 'ENOENT' },
      )
    })

    const cacheDir = join(tempDir, 'marketplaces')
    mkdirSync(cacheDir, { recursive: true })
    const staleCanonicalPath = join(cacheDir, 'mymarketplace')

    await saveKnownMarketplacesConfigWithMockedAxios!({
      MyMarketplace: {
        source: {
          source: 'url',
          url: 'https://example.com/marketplace.json',
        },
        installLocation: staleCanonicalPath,
        lastUpdated: '2020-01-01T00:00:00.000Z',
      },
    })
    clearMarketplacesCacheWithMockedAxios!()

    const pluginInfo = await getPluginByIdWithMockedAxios!(
      'demo-plugin@MyMarketplace',
    )
    expect(pluginInfo).not.toBeNull()
    expect(pluginInfo!.entry.name).toBe('demo-plugin')
    expect(
      pluginInfo!.marketplaceInstallLocation.startsWith(
        join(cacheDir, 'temp_'),
      ),
    ).toBe(true)
    expect(pluginInfo!.marketplaceInstallLocation).not.toBe(staleCanonicalPath)
  })

  test('keeps the GitHub clone directory when copy fallback throws ENOENT', async () => {
    renameSpy.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted, rename')
    })
    cpSpy.mockImplementation(async () => {
      throw Object.assign(
        new Error(
          "ENOENT: no such file or directory, copyfile 'chromedevtools-chrome-devtools-mcp/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps' -> 'chrome-devtools-plugins/third_party/devtools-frontend/build/android/gyp/binary_baseline_profile.pydeps'",
        ),
        { code: 'ENOENT' },
      )
    })

    const source: MarketplaceSource = {
      source: 'github',
      repo: 'ChromeDevTools/chrome-devtools-mcp',
    }

    const cacheDir = join(tempDir, 'marketplaces')
    mkdirSync(cacheDir, { recursive: true })

    const result = await loadAndCacheWithMockedAxios!(source)
    const cloneDir = join(cacheDir, 'chromedevtools-chrome-devtools-mcp')

    expect(result.marketplace.name).toBe('MyMarketplace')
    expect(result.cachePath).toBe(cloneDir)
    expect(
      existsSync(join(cloneDir, '.claude-plugin', 'marketplace.json')),
    ).toBe(true)
    expect(existsSync(join(cacheDir, 'mymarketplace'))).toBe(false)
    expect(cpSpy).toHaveBeenCalled()
  })

  test('getMarketplace refetch does not rewrite local file installLocation', async () => {
    const localRoot = join(tempDir, 'local-marketplace')
    mkdirSync(join(localRoot, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(localRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(fakeMarketplaceJson),
    )
    const storedManifestPath = join(
      localRoot,
      '.claude-plugin',
      'marketplace.json',
    )
    const missingCachePath = join(tempDir, 'missing-installLocation.json')

    await saveKnownMarketplacesConfigWithMockedAxios!({
      MyMarketplace: {
        source: {
          source: 'file',
          path: storedManifestPath,
        },
        installLocation: missingCachePath,
        lastUpdated: '2020-01-01T00:00:00.000Z',
      },
    })
    clearMarketplacesCacheWithMockedAxios!()

    const marketplace = await getMarketplaceWithMockedAxios!('MyMarketplace')
    expect(marketplace.name).toBe('MyMarketplace')

    const config = await loadKnownMarketplacesConfigWithMockedAxios!()
    expect(config.MyMarketplace?.installLocation).toBe(missingCachePath)
    expect(config.MyMarketplace?.installLocation).not.toBe(localRoot)
  })
})

/**
 * Probe-based filesystem case-sensitivity detection (review follow-up).
 *
 * isCaseInsensitiveFsAt() must NOT assume case behavior from process.platform:
 * macOS can mount case-sensitive APFS/HFS+ volumes, where two cache paths that
 * differ only in case are distinct directories. These tests inject statSync to
 * simulate each volume kind, so they are fully portable (no real case-sensitive
 * mount required) — the inode comparison decides the result.
 */
describe('isCaseInsensitiveFsAt — probes the volume, not the platform', () => {
  let originalFs: FsOperations
  let originalPlatform: PropertyDescriptor | undefined

  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true })
  const fakeStat = (ino: number, dev = 1) =>
    ({ ino, dev }) as unknown as ReturnType<FsOperations['statSync']>

  beforeEach(() => {
    originalFs = getFsImplementation()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    _test._clearCaseInsensitiveFsCache()
  })

  afterEach(() => {
    setFsImplementation(originalFs)
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    _test._clearCaseInsensitiveFsCache()
  })

  test('win32: always case-insensitive without probing the filesystem', () => {
    setPlatform('win32')
    let statCalls = 0
    setFsImplementation({
      ...originalFs,
      statSync: () => {
        statCalls++
        return fakeStat(1)
      },
    })
    expect(_test.isCaseInsensitiveFsAt('/Cache/Dir')).toBe(true)
    expect(statCalls).toBe(0)
  })

  test('case-insensitive volume: flipped path resolves to the same inode', () => {
    setPlatform('darwin')
    setFsImplementation({ ...originalFs, statSync: () => fakeStat(42, 7) })
    expect(_test.isCaseInsensitiveFsAt('/Volumes/Insensitive/cache')).toBe(true)
  })

  test('case-sensitive volume: flipped path is a distinct inode', () => {
    setPlatform('darwin')
    let n = 0
    setFsImplementation({
      ...originalFs,
      statSync: () => fakeStat(n++ === 0 ? 1 : 2),
    })
    expect(_test.isCaseInsensitiveFsAt('/Volumes/Sensitive/cache')).toBe(false)
  })

  test('case-sensitive volume: flipped path does not exist (ENOENT)', () => {
    setPlatform('darwin')
    let n = 0
    setFsImplementation({
      ...originalFs,
      statSync: () => {
        if (n++ === 0) return fakeStat(1)
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(_test.isCaseInsensitiveFsAt('/Volumes/Sensitive/cache')).toBe(false)
  })

  test('pathsEqualForFs follows the probe: case-only paths match only when insensitive', () => {
    setPlatform('darwin')
    // Insensitive volume: same inode for both case variants.
    setFsImplementation({ ...originalFs, statSync: () => fakeStat(9, 3) })
    _test._clearCaseInsensitiveFsCache()
    expect(_test.pathsEqualForFs('/cache/MyMP', '/cache/mymp', '/cache')).toBe(
      true,
    )

    // Sensitive volume: distinct inodes — the same case-only pair is now NOT
    // equal, so old-cache cleanup is not skipped.
    let n = 0
    setFsImplementation({
      ...originalFs,
      statSync: () => fakeStat(n++ === 0 ? 1 : 2),
    })
    _test._clearCaseInsensitiveFsCache()
    expect(_test.pathsEqualForFs('/cache/MyMP', '/cache/mymp', '/cache')).toBe(
      false,
    )
  })
})

const PROTO_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
]

describe('removeMarketplaceSource — prototype-shadowing names', () => {
  let originalFs: FsOperations
  let rmCalls: string[]

  beforeEach(() => {
    originalFs = getFsImplementation()
    rmCalls = []
    // No config file on disk → loadKnownMarketplacesConfig returns an empty
    // config. Writes are stubbed so the test stays hermetic even if a
    // regression let execution fall past the "not found" guard.
    const enoent = (): never => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      })
    }
    setFsImplementation({
      ...originalFs,
      readFile: async () => enoent(),
      mkdir: async () => {},
      rm: async (path: string) => {
        rmCalls.push(path)
      },
    })
  })

  afterEach(() => {
    setFsImplementation(originalFs)
  })

  // A marketplace name that shadows an Object.prototype member must report
  // "not found" — not resolve the inherited member via the prototype chain and
  // then crash / silently mis-act on a bogus entry.
  test.each(PROTO_NAMES)(
    'reports "not found" for prototype-shadowing name %p',
    async name => {
      await expect(removeMarketplaceSource(name)).rejects.toThrow(
        `Marketplace '${name}' not found`,
      )
      // The not-found path must short-circuit before touching the filesystem:
      // never rm a cache directory derived from a bogus inherited entry.
      expect(rmCalls).toEqual([])
    },
  )
})

describe('cache-only lookups — prototype-shadowing names', () => {
  let originalFs: FsOperations
  let configReads: number
  let readPaths: string[]
  const SENTINEL_INSTALL_LOCATION = '/__bogus_inherited_install_location__'

  beforeEach(() => {
    originalFs = getFsImplementation()
    configReads = 0
    readPaths = []
    // Sentinel installLocation on Object.prototype so that *if* the hardening
    // is removed, the inherited entry (`config['constructor']`, etc.) carries a
    // real string installLocation and the reader proceeds to read a marketplace
    // cache path derived from it — which we can then detect. With the
    // null-prototype guard in place, the lookup resolves to `undefined`, the
    // "not found" guard short-circuits, and this path is never touched.
    ;(Object.prototype as Record<string, unknown>).installLocation =
      SENTINEL_INSTALL_LOCATION
    // A *valid* (but empty) config file exists on disk, so the cache-only
    // readers reach the `config[name]` lookup instead of bailing on ENOENT.
    setFsImplementation({
      ...originalFs,
      readFile: async (path: string) => {
        configReads++
        readPaths.push(String(path))
        return '{}'
      },
    })
  })

  afterEach(() => {
    setFsImplementation(originalFs)
    delete (Object.prototype as Record<string, unknown>).installLocation
  })

  // Direct regression signal for getMarketplaceCacheOnly: the missing-marketplace
  // lookup must short-circuit BEFORE attempting to read a marketplace cache path.
  // Without the null-prototype guard, `config[name]` is the inherited Object
  // member; its (sentinel) installLocation drives readCachedMarketplace into
  // reading a cache path, which this asserts never happens.
  test.each(PROTO_NAMES)(
    'getMarketplaceCacheOnly returns null and never reads a cache path for shadowing name %p',
    async name => {
      await expect(getMarketplaceCacheOnly(name)).resolves.toBeNull()
      // The only read is the config file itself; no cache path derived from a
      // bogus inherited installLocation is ever touched.
      expect(
        readPaths.some(p => p.includes(SENTINEL_INSTALL_LOCATION)),
      ).toBe(false)
      expect(configReads).toBe(1)
    },
  )

  // The strong regression signal for the plugin path: without the guard,
  // `config[name]` resolves to the inherited Object member, the "not found"
  // check passes, and the reader re-enters `getMarketplaceCacheOnly(name)`,
  // re-reading the config file a *second* time before failing. The hardened
  // path short-circuits on the first lookup, so the config is read exactly once.
  test.each(PROTO_NAMES)(
    'getPluginByIdCacheOnly returns null and does not re-resolve a shadowing marketplace %p',
    async name => {
      await expect(
        getPluginByIdCacheOnly(`some-plugin@${name}`),
      ).resolves.toBeNull()
      expect(configReads).toBe(1)
    },
  )
})
