import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = join(import.meta.dir, '..')
const cli = join(repo, 'dist/cli.mjs')
const currentVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version as string
const targetVersion = `${Number(currentVersion.split('.')[0]) + 1}.0.0`
const preload = join(import.meta.dir, 'fixtures/updater-preload.mjs')

type Event = { type: string; file?: string; args: string[]; pid?: number; resolved?: string }

function fixture(owner = 'npm') {
  if (!existsSync(cli)) throw new Error('Run bun run build before updater integration tests')
  const root = mkdtempSync(join(tmpdir(), 'updater-integration-'))
  for (const name of ['home', 'config', 'npm/bun/bin', ...(owner === 'npm' ? ['npm-prefix'] : [])]) {
    mkdirSync(join(root, name), { recursive: true })
  }
  writeFileSync(join(root, 'config/settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }))
  const children: ReturnType<typeof Bun.spawn>[] = []
  return {
    root,
    lock: join(root, 'config/.update.lock'),
    events: (): Event[] => existsSync(join(root, 'events'))
      ? readFileSync(join(root, 'events'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [],
    start(extraEnv: Record<string, string> = {}) {
      const child = Bun.spawn(['node', '--import', pathToFileURL(preload).href, cli, 'update'], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: '', NODE_ENV: 'production', NO_COLOR: '1', CI: '1',
          OPENCLAUDE_CONFIG_DIR: join(root, 'config'),
          BUN_INSTALL: join(root, 'npm/bun'),
          UPDATER_TEST_ROOT: root, UPDATER_TEST_OWNER: owner, UPDATER_TEST_VERSION: targetVersion,
          ...extraEnv,
        },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
      })
      children.push(child)
      return (async () => ({
        code: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      }))()
    },
    async close() {
      writeFileSync(join(root, 'release'), '')
      for (const child of children) {
        await Promise.race([child.exited, Bun.sleep(500)])
        if (child.exitCode === null) child.kill()
        await child.exited
      }
      if (existsSync(join(root, 'lifecycle-ready'))) {
        await waitFor(() => existsSync(join(root, 'lifecycle-exited')))
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for updater readiness')
    await Bun.sleep(10)
  }
}

// Child deadlines are 15 seconds; allow time for barriers, assertions and teardown.
describe('published updater under Node', () => {
  test('bounds fixture startup when cleanup removes the readiness directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'updater-readiness-'))
    rmSync(root, { recursive: true })
    // The lifecycle worker cannot publish a heartbeat after cleanup. The manager
    // must reach its own 12-second deadline before this 15-second outer watchdog.
    const child = Bun.spawn(['node', join(import.meta.dir, 'fixtures/updater-process.mjs'), 'timeout', '0'], {
      cwd: repo,
      env: { ...process.env, NODE_OPTIONS: '', UPDATER_TEST_ROOT: root },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 15_000,
    })
    try {
      expect(await child.exited).toBe(124)
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test('reports the installed version as current without installing', async () => {
    const f = fixture()
    try {
      const result = await f.start({ UPDATER_TEST_VERSION: currentVersion })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`up to date (${currentVersion})`)
      expect(f.events().filter(e => e.type === 'lookup')).toHaveLength(1)
      expect(f.events().filter(e => e.type === 'install')).toHaveLength(0)
      expect(existsSync(f.lock)).toBe(false)
    } finally { await f.close() }
  }, 20_000)

  test.each(['npm', 'bun'].flatMap(owner => [false, true].map(windows => ({ owner, windows }))))('installs the selected stable version with $owner (Windows wrappers: $windows) and releases the lock', async ({ owner, windows }) => {
    const f = fixture(owner)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await f.start(windows ? { UPDATER_TEST_WINDOWS_WRAPPERS: '1' } : {})
        expect(result, JSON.stringify(result)).toMatchObject({ code: 0 })
        expect(result.stdout).toContain(`to version ${targetVersion}`)
        expect(existsSync(f.lock)).toBe(false)
      }
      const events = f.events()
      expect(events.filter(e => e.type === 'lookup').every(e => e.args.includes('@twigpine/openclaude@stable'))).toBe(true)
      expect(events.filter(e => e.type === 'install').map(e => [e.file, e.args])).toEqual([
        [owner, [owner === 'npm' ? 'install' : 'add', '-g', `@twigpine/openclaude@${targetVersion}`]],
        [owner, [owner === 'npm' ? 'install' : 'add', '-g', `@twigpine/openclaude@${targetVersion}`]],
      ])
      if (owner === 'bun') expect(existsSync(join(f.root, 'npm-prefix'))).toBe(false)
      if (windows) {
        const spec = `@twigpine/openclaude@${targetVersion}`
        const dispatched = events.filter(e => e.type === 'command' && e.args.join(' ').includes(spec))
        const isCmd = (e: Event) => win32.basename(e.file || '').toLowerCase() === 'cmd.exe'
        expect(dispatched).toHaveLength(2)
        expect(dispatched.every(e => owner === 'npm' ? isCmd(e) : e.file === 'bun')).toBe(true)
        expect(events.filter(e => e.type === 'command' && isCmd(e) && e.args.join(' ').includes('@twigpine/openclaude@stable'))).toHaveLength(2)
        // On Windows, production cross-spawn has already wrapped npm before
        // interception. Only the POSIX simulation generates parser metadata.
        if (process.platform !== 'win32') {
          const parsed = events.filter(e => e.type === 'parsed-command' && e.args.join(' ').includes(spec))
          expect(parsed).toHaveLength(2)
          expect(dispatched.map(e => [e.file, e.args])).toEqual(parsed.map(e => [e.file, e.args]))
          if (owner === 'bun') expect(parsed.every(e => e.resolved === join(f.root, 'bin/bun.exe'))).toBe(true)
        }
      }
    } finally { await f.close() }
  }, 40_000)

  test.each([false, true])('allows one simultaneous installer (missing-directory retry: %s)', async missingDirectory => {
    const f = fixture()
    try {
      const env = { UPDATER_TEST_BARRIER: '1', UPDATER_TEST_HOLD: '1', ...(missingDirectory ? { UPDATER_TEST_MISSING_DIRECTORY: '1' } : {}) }
      const first = f.start(env)
      const second = f.start(env)
      await waitFor(() => f.events().some(e => e.type === 'install'))
      // A loser must exit while the winner is still holding the install open.
      const loser = await Promise.race([first, second])
      expect(loser.code).toBe(1)
      expect(f.events().filter(e => e.type === 'install')).toHaveLength(1)
      writeFileSync(join(f.root, 'release'), '')
      const results = await Promise.all([first, second])
      expect(results.map(r => r.code).sort()).toEqual([0, 1])
      expect(existsSync(f.lock)).toBe(false)
      expect(readdirSync(join(f.root, 'config')).some(name => name.includes('.update.lock'))).toBe(false)
    } finally { await f.close() }
  }, 40_000)

  test.each(['fresh-live', 'aged-live', 'dead', 'malformed'])('preserves an existing %s lock against two contenders', async state => {
    const f = fixture()
    try {
      const pid = state === 'malformed' ? '' : state === 'dead' ? '2147483647' : String(process.pid)
      writeFileSync(f.lock, pid)
      if (state !== 'fresh-live') utimesSync(f.lock, new Date(0), new Date(0))
      const results = await Promise.all([f.start(), f.start()])
      expect(results.map(r => r.code)).toEqual([1, 1])
      expect(results.every(r => r.stderr.includes('Could not acquire the update lock'))).toBe(true)
      expect(f.events().filter(e => e.type === 'install')).toHaveLength(0)
      expect(readFileSync(f.lock, 'utf8')).toBe(pid)
    } finally { await f.close() }
  }, 40_000)

  test('releases after a failed install so another update can run', async () => {
    const f = fixture()
    try {
      expect((await f.start({ UPDATER_TEST_INSTALL_EXIT: '1' })).code).toBe(1)
      expect(existsSync(f.lock)).toBe(false)
      expect((await f.start()).code).toBe(0)
    } finally { await f.close() }
  }, 40_000)

  test.each(['timeout', 'output-limit', 'timeout-kill-failure', 'output-limit-kill-failure', 'SIGTERM', 'SIGKILL'])('retains the lock while lifecycle work survives an installer %s', async failure => {
    const f = fixture()
    try {
      const first = await f.start({ UPDATER_TEST_UNCERTAIN: failure })
      expect(first.code, first.stderr).toBe(1)
      expect(first.stderr).toContain('Installer may still be running')
      expect(first.stderr).toContain('README update-lock recovery instructions')
      expect(first.stderr).not.toContain('npm install')
      const heartbeat = () => existsSync(join(f.root, 'heartbeat')) ? readFileSync(join(f.root, 'heartbeat'), 'utf8').length : 0
      const before = heartbeat()
      await waitFor(() => heartbeat() > before)
      if (failure.endsWith('-kill-failure')) expect(f.events().some(e => e.type === 'kill-error')).toBe(true)
      expect(existsSync(f.lock)).toBe(true)
      const install = f.events().filter(e => e.type === 'install')
      expect(install).toHaveLength(1)
      expect(readFileSync(f.lock, 'utf8')).toBe(String(install[0]!.pid))
      const second = await f.start()
      expect(second.code).toBe(1)
      expect(second.stderr).toContain('Could not acquire the update lock')
      expect(f.events().filter(e => e.type === 'install')).toHaveLength(1)
    } finally { await f.close() }
  }, 40_000)
})
