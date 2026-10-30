import { describe, expect, test } from 'bun:test'
import { withMockMacro } from 'src/test/mockMacro.js'

async function importFreshUpdateCommand() {
  return import(`./update.js?ts=${Date.now()}-${Math.random()}`)
}

describe('removeStaleNativeLauncherForNpmUpdate', () => {
  test('removes stale native launchers for npm-only builds before npm update', async () => {
    let removed = 0

    await withMockMacro({ PACKAGE_URL: '@twigpine/openclaude' }, async () => {
      const { removeStaleNativeLauncherForNpmUpdate } =
        await importFreshUpdateCommand()
      await expect(
        removeStaleNativeLauncherForNpmUpdate({
          getConfig: () => ({ installMethod: 'native' }),
          hasNativeDistribution: () => false,
          removeInstalledSymlink: async () => {
            removed++
          },
        }),
      ).resolves.toBe(true)
    })

    expect(removed).toBe(1)
  })

  test('preserves native launchers for native-capable builds', async () => {
    let removed = 0

    await withMockMacro({ PACKAGE_URL: '@twigpine/openclaude' }, async () => {
      const { removeStaleNativeLauncherForNpmUpdate } =
        await importFreshUpdateCommand()
      await expect(
        removeStaleNativeLauncherForNpmUpdate({
          getConfig: () => ({ installMethod: 'native' }),
          hasNativeDistribution: () => true,
          removeInstalledSymlink: async () => {
            removed++
          },
        }),
      ).resolves.toBe(false)
    })

    expect(removed).toBe(0)
  })

  test('keeps existing cleanup for non-native config states', async () => {
    let removed = 0

    await withMockMacro({ PACKAGE_URL: '@twigpine/openclaude' }, async () => {
      const { removeStaleNativeLauncherForNpmUpdate } =
        await importFreshUpdateCommand()
      await expect(
        removeStaleNativeLauncherForNpmUpdate({
          getConfig: () => ({ installMethod: 'global' }),
          hasNativeDistribution: () => true,
          removeInstalledSymlink: async () => {
            removed++
          },
        }),
      ).resolves.toBe(true)
    })

    expect(removed).toBe(1)
  })
})

test('retained-lock errors show recovery in the view and completion without a manual-install bypass', async () => {
  const child = Bun.spawn([process.execPath, 'run', `${import.meta.dir}/../../../scripts/fixtures/update-recovery.ts`], {
    cwd: `${import.meta.dir}/../../..`, env: { ...process.env, NODE_ENV: 'production' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual([
    { status: 'termination_uncertain', recovery: true, manual: false, recoveryOnDone: true },
    { status: 'install_failed', recovery: false, manual: true, recoveryOnDone: false },
  ])
}, 20_000)
