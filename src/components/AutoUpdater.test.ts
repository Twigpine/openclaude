import { describe, expect, test } from 'bun:test'
import {
  getAutoUpdaterNpmMethod,
  shouldRemoveInstalledSymlinkForNpmUpdate,
  shouldUseNativeAutoUpdater,
} from '../utils/autoUpdaterRouting.js'

describe('getAutoUpdaterNpmMethod', () => {
  test('routes native npm-only builds to the global npm updater', () => {
    expect(getAutoUpdaterNpmMethod('native', 'native', false)).toBe('global')
  })

  test('leaves native-distribution builds to NativeAutoUpdater', () => {
    expect(getAutoUpdaterNpmMethod('native', 'native', true)).toBeNull()
  })

  test('preserves npm and unknown fallback routing', () => {
    expect(getAutoUpdaterNpmMethod('npm-local', undefined, false)).toBe('local')
    expect(getAutoUpdaterNpmMethod('npm-global', undefined, false)).toBe('global')
    expect(getAutoUpdaterNpmMethod('unknown', 'local', false)).toBe('local')
    expect(getAutoUpdaterNpmMethod('unknown', undefined, false)).toBe('global')
  })
})

describe('shouldUseNativeAutoUpdater', () => {
  test('only mounts NativeAutoUpdater for native builds with a native distribution', () => {
    expect(shouldUseNativeAutoUpdater('native', true)).toBe(true)
    expect(shouldUseNativeAutoUpdater('native', false)).toBe(false)
    expect(shouldUseNativeAutoUpdater('npm-global', true)).toBe(false)
    expect(shouldUseNativeAutoUpdater('development', true)).toBe(false)
  })
})

describe('shouldRemoveInstalledSymlinkForNpmUpdate', () => {
  test('removes stale native launchers for npm-only builds even with native config', () => {
    expect(shouldRemoveInstalledSymlinkForNpmUpdate('native', false)).toBe(true)
  })

  test('preserves native launchers for native-capable builds', () => {
    expect(shouldRemoveInstalledSymlinkForNpmUpdate('native', true)).toBe(false)
  })

  test('keeps existing npm-update cleanup for non-native config states', () => {
    expect(shouldRemoveInstalledSymlinkForNpmUpdate('global', false)).toBe(true)
    expect(shouldRemoveInstalledSymlinkForNpmUpdate('local', true)).toBe(true)
    expect(shouldRemoveInstalledSymlinkForNpmUpdate(undefined, true)).toBe(true)
  })
})

test('disabled initial and timer callbacks skip version lookups, with an enabled control', async () => {
  // The isolated child exercises the component callbacks with mocked hook
  // scheduling and network boundaries; it does not mount the terminal UI.
  const child = Bun.spawn([
    process.execPath, 'run',
    `${import.meta.dir}/../../scripts/fixtures/auto-updater-disabled.ts`,
  ], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...process.env, NODE_ENV: 'production' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 8_000,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    initial: { latest: 0, maximum: 0 },
    timer: { latest: 0, maximum: 0 },
    enabled: { latest: 1, maximum: 1 },
    recoveryNotice: true,
    ordinaryNotice: true,
  })
}, 10_000) // Longer than the child deadline to allow assertion and cleanup.
