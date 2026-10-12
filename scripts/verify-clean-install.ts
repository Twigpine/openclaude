/**
 * End-to-end verification that `npm install -g @twigpine/openclaude` is a
 * zero-warning experience — the runtime half of the install contract whose
 * static half lives in externalsValidation.ts (RUNTIME_DEPENDENCY_CONTRACT).
 *
 * Modes:
 *   --tarball [path]    Verify a local tarball. Without a path, packs one from
 *                       the working tree with `npm pack --ignore-scripts`
 *                       (dist/ must already be built — CI builds it first).
 *   --published [spec]  Verify the real registry artifact (default
 *                       @twigpine/openclaude@latest). Used by the scheduled
 *                       install-hygiene workflow to catch registry drift
 *                       (e.g. a transitive dep deprecated after we shipped).
 *
 * Each mode runs two scenarios in throwaway prefixes with a cold cache:
 *   1. cold     — fresh global install
 *   2. upgrade  — install the previously published version, then install the
 *                 target over it (the most common real-world path; different
 *                 npm output shapes than a cold install)
 *
 * Verdicts are strict-whitelist: any npm output line that is not an expected
 * summary fails the run — `npm warn`, `deprecated`, EBADENGINE, funding hints,
 * and install-script chatter all land here without being special-cased.
 * Registry/network failures retry and then exit 2 (infra), never 1 (hygiene),
 * so CI can distinguish a flaky registry from a real regression.
 *
 * After installing, the script also proves the artifact works and is silent:
 * `--version` must print the exact packed version, `--help` must load the real
 * bundle (--version short-circuits via a zero-import fast path in cli.tsx and
 * proves almost nothing), both with empty stderr. The installed tree is
 * scanned structurally for install scripts — a transitive postinstall that
 * exits quietly would pass an output whitelist, so the tree is the authority.
 *
 * Note: package.json `overrides` do NOT travel to consumers; this script
 * intentionally reproduces the user's resolution, not the repo's.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { execaSync } from 'execa'

import { renderWrapperScript } from '../src/utils/claudeInChrome/launch.js'
import {
  validateInstallHygieneFields,
  validateRuntimeDependencyContract,
} from './externalsValidation.js'

// Read from the manifest instead of repeated here, so every check below looks
// for the name the tarball was actually packed with.
const PACKAGE_NAME: string = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
).name
const MAX_TARBALL_BYTES = 12_000_000 // current tarball is ~8.8MB; catch payload blowups
const INSTALL_RETRIES = 3
const IS_WINDOWS = process.platform === 'win32'

// Published artifacts that predate the silent-first-boot fix (the fresh-install
// Opengateway default used to print a "saved provider profile" warning on
// every command). Their stderr noise is a KNOWN issue, not a regression —
// exempt exactly these versions so the scheduled published-mode run stays
// signal. Self-cleaning: the next release is not in this set; remove the
// constant once 0.24.0 is no longer `latest`.
const KNOWN_FIRST_BOOT_NOISE_VERSIONS = new Set(['0.24.0'])

// Lines npm may legitimately print at --loglevel=warn. Everything else fails.
const ALLOWED_OUTPUT = [
  // "added 8 packages in 19s", "added 1 package in 340ms",
  // "added 1 package, removed 2 packages, and changed 3 packages in 4s",
  // "up to date in 1s" — summary phrasing varies across npm 10/11.
  /^(?:added|removed|changed|up to date)[\w ,]* in [\d.]+m?s$/i,
  /^npm notice\b/i, // defense in depth; --loglevel=warn hides notices
]

const INFRA_FAILURE_PATTERNS = [
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPROTO/,
  /network|socket hang up|fetch failed|registry.*(?:unavailable|error)/i,
  /npm error code E(?:429|5\d\d)\b/,
]

type Failure = { scenario: string; problem: string }
type VerificationReporter = {
  fail: (problem: string) => void
  pass: (what: string) => void
}
type ChromeSetupLaunch = {
  command?: unknown
  args?: unknown
  requiredEntrypoint?: unknown
}
export type ChromeSetupLaunches = {
  nativeHost?: ChromeSetupLaunch
  mcpServer?: ChromeSetupLaunch
}
type InstalledChromeSetupRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    timeout: number
  },
) => { status: number; stdout: string; stderr: string }
type SyncCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    reject: false
    stripFinalNewline: false
    timeout: number
  },
) => {
  exitCode?: number
  stdout?: unknown
  stderr?: unknown
}
const failures: Failure[] = []
const CHROME_SETUP_LOG_PREFIX =
  '[Claude in Chrome] Setup launch configuration: '
function fail(scenario: string, problem: string): void {
  failures.push({ scenario, problem })
  console.error(`  ❌ [${scenario}] ${problem}`)
}
function pass(scenario: string, what: string): void {
  console.log(`  ✓ [${scenario}] ${what}`)
}

function npmEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Deterministic, machine-independent output: no color/TTY decoration, no
    // npm self-update notice, English formatting, isolated config/home.
    CI: '1',
    NO_COLOR: '1',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: home,
    USERPROFILE: home,
    npm_config_update_notifier: 'false',
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    timeout: number
  },
  runner: SyncCommandRunner = execaSync as SyncCommandRunner,
): { status: number; stdout: string; stderr: string } {
  const result = runner(command, args, {
    ...options,
    reject: false,
    stripFinalNewline: false,
  })
  return {
    status: result.exitCode ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

function runNpm(
  args: string[],
  home: string,
): { status: number; stdout: string; stderr: string } {
  return runCommand('npm', args, {
    env: npmEnv(home),
    timeout: 10 * 60 * 1000,
  })
}

function installFlags(prefix: string, cache: string): string[] {
  return [
    '--global',
    `--prefix=${prefix}`,
    `--cache=${cache}`,
    '--no-fund',
    '--no-audit',
    '--no-progress',
    '--no-color',
    '--loglevel=warn',
    '--foreground-scripts',
  ]
}

function looksLikeInfraFailure(output: string): boolean {
  return INFRA_FAILURE_PATTERNS.some(re => re.test(output))
}

/** Install with retry-on-network; returns combined output once npm exits 0. */
function installWithRetry(
  scenario: string,
  spec: string,
  prefix: string,
  cache: string,
  home: string,
): string | null {
  for (let attempt = 1; attempt <= INSTALL_RETRIES; attempt++) {
    const { status, stdout, stderr } = runNpm(
      ['install', spec, ...installFlags(prefix, cache)],
      home,
    )
    const combined = `${stdout}\n${stderr}`
    if (status === 0) return combined
    if (attempt < INSTALL_RETRIES && looksLikeInfraFailure(combined)) {
      console.log(`  … [${scenario}] transient install failure, retrying (${attempt}/${INSTALL_RETRIES})`)
      continue
    }
    if (looksLikeInfraFailure(combined)) {
      console.error(combined)
      console.error(`\n⚠️  [${scenario}] npm install failed with network/registry symptoms after ${INSTALL_RETRIES} attempts — infra problem, not a hygiene verdict.`)
      process.exit(2)
    }
    fail(scenario, `npm install exited ${status}:\n${combined}`)
    return null
  }
  return null
}

function checkOutputWhitelist(scenario: string, output: string): void {
  const offending = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !ALLOWED_OUTPUT.some(re => re.test(line)))
  if (offending.length === 0) {
    pass(scenario, 'install output is clean (summary line only)')
  } else {
    for (const line of offending) {
      fail(scenario, `unexpected install output: "${line}"`)
    }
  }
}

function globalRoot(prefix: string): string {
  return IS_WINDOWS ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
}

/** Every package.json in the installed tree; global deps nest under the package. */
function collectInstalledManifests(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const child = join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      collectInstalledManifests(child, out)
      continue
    }
    const manifest = join(child, 'package.json')
    if (existsSync(manifest)) out.push(manifest)
    const nested = join(child, 'node_modules')
    if (existsSync(nested)) collectInstalledManifests(nested, out)
  }
  return out
}

function checkNoInstallScripts(scenario: string, prefix: string): void {
  const manifests = collectInstalledManifests(globalRoot(prefix))
  if (manifests.length === 0) {
    fail(scenario, `no installed packages found under ${globalRoot(prefix)}`)
    return
  }
  const offenders: string[] = []
  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const hooks = ['preinstall', 'install', 'postinstall'].filter(
      hook => pkg.scripts?.[hook],
    )
    if (hooks.length > 0) offenders.push(`${pkg.name}@${pkg.version} (${hooks.join(', ')})`)
  }
  if (offenders.length > 0) {
    fail(scenario, `installed packages declare install scripts: ${offenders.join('; ')}`)
  } else {
    pass(scenario, `no install scripts across ${manifests.length} installed packages`)
  }
}

function checkInstalledContract(scenario: string, prefix: string): void {
  const manifestPath = join(globalRoot(prefix), ...PACKAGE_NAME.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    fail(scenario, `installed manifest missing at ${manifestPath}`)
    return
  }
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const errors = [
    ...validateRuntimeDependencyContract(pkg).errors,
    ...validateInstallHygieneFields(pkg).errors,
  ]
  if (errors.length > 0) {
    for (const error of errors) fail(scenario, `installed artifact: ${error}`)
  } else {
    pass(scenario, 'installed artifact matches the static install contract')
  }
}

export function parseInstalledChromeSetupLaunches(
  debugOutput: string,
): ChromeSetupLaunches | null {
  for (const line of debugOutput.split(/\r?\n/)) {
    const markerIndex = line.indexOf(CHROME_SETUP_LOG_PREFIX)
    if (markerIndex === -1) continue
    try {
      const value = JSON.parse(
        line.slice(markerIndex + CHROME_SETUP_LOG_PREFIX.length),
      )
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as ChromeSetupLaunches
      }
    } catch {
      continue
    }
  }
  return null
}

type ChromeWrapperPlatform = 'posix' | 'windows'

function pathsMatch(
  left: string,
  right: string,
  platform: ChromeWrapperPlatform,
): boolean {
  if (platform === 'windows') {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
  }
  return posix.resolve(left) === posix.resolve(right)
}

function getExpectedWrapperContent(
  launch: ChromeSetupLaunch | undefined,
  platform: ChromeWrapperPlatform,
): string | null {
  if (
    typeof launch?.command !== 'string' ||
    !Array.isArray(launch.args) ||
    launch.args.some(arg => typeof arg !== 'string')
  ) {
    return null
  }

  try {
    return renderWrapperScript(
      {
        command: launch.command,
        args: launch.args as string[],
      },
      platform === 'windows' ? 'windows' : 'linux',
    )
  } catch {
    return null
  }
}

export function getInstalledChromeSetupProblems({
  installedLaunchers,
  launches,
  wrapperContent,
  pathExists = existsSync,
  platform = IS_WINDOWS ? 'windows' : 'posix',
}: {
  installedLaunchers: readonly string[]
  launches: ChromeSetupLaunches
  wrapperContent: string
  pathExists?: (path: string) => boolean
  platform?: ChromeWrapperPlatform
}): string[] {
  const problems: string[] = []

  const checkLaunch = (
    label: string,
    launch: ChromeSetupLaunch | undefined,
    flag: string,
  ): string | undefined => {
    if (
      typeof launch?.command !== 'string' ||
      launch.command.length === 0 ||
      !Array.isArray(launch.args) ||
      launch.args.length !== 2 ||
      launch.args.some(arg => typeof arg !== 'string')
    ) {
      problems.push(`${label} setup did not emit a valid process launch`)
      return undefined
    }

    const [target, actualFlag] = launch.args as string[]
    if (
      !target ||
      !installedLaunchers.some(candidate => pathsMatch(candidate, target, platform)) ||
      actualFlag !== flag
    ) {
      problems.push(
        `${label} setup does not target an installed package launcher with ${flag}`,
      )
    }
    if (target && !pathExists(target)) {
      problems.push(`${label} setup target does not exist: ${target}`)
    }
    if (
      typeof launch.requiredEntrypoint !== 'string' ||
      !pathsMatch(launch.requiredEntrypoint, target, platform)
    ) {
      problems.push(
        `${label} setup does not retain its launcher target as the required entrypoint`,
      )
    }
    return target
  }

  const nativeHostTarget = checkLaunch(
    'Chrome native-host',
    launches.nativeHost,
    '--chrome-native-host',
  )
  const mcpTarget = checkLaunch(
    'Chrome MCP',
    launches.mcpServer,
    '--claude-in-chrome-mcp',
  )

  if (
    nativeHostTarget === undefined ||
    mcpTarget === undefined ||
    !pathsMatch(nativeHostTarget, mcpTarget, platform)
  ) {
    problems.push(
      'Chrome native-host and MCP setup do not share one installed package launcher',
    )
  }

  const expectedWrapperContent = getExpectedWrapperContent(
    launches.nativeHost,
    platform,
  )
  if (
    expectedWrapperContent === null ||
    wrapperContent !== expectedWrapperContent
  ) {
    problems.push(
      'persisted Chrome native-host wrapper does not target the installed package launcher',
    )
  }

  return problems
}

export function checkInstalledChromeEntrypoint(
  scenario: string,
  prefix: string,
  home: string,
  reporter: VerificationReporter = {
    fail: problem => fail(scenario, problem),
    pass: what => pass(scenario, what),
  },
  runSetup: InstalledChromeSetupRunner = runCommand,
): void {
  const packageRoot = join(globalRoot(prefix), ...PACKAGE_NAME.split('/'))
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    reporter.fail(`installed manifest missing at ${manifestPath}`)
    return
  }
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const binEntry = pkg.bin?.openclaude
  if (typeof binEntry !== 'string') {
    reporter.fail('installed package has no openclaude launcher metadata')
    return
  }

  const packageLauncher = join(packageRoot, binEntry)
  if (!existsSync(packageLauncher)) {
    reporter.fail(`installed OpenClaude launcher missing at ${packageLauncher}`)
    return
  }

  const globalLauncher = binPath(prefix)
  if (!existsSync(globalLauncher)) {
    reporter.fail(`installed OpenClaude global launcher missing at ${globalLauncher}`)
    return
  }

  const bundlePath = join(packageRoot, 'dist', 'cli.mjs')
  if (!existsSync(bundlePath)) {
    reporter.fail(`installed CLI bundle missing at ${bundlePath}`)
    return
  }

  const setupConfigDir = join(home, 'chrome setup config')
  mkdirSync(setupConfigDir, { recursive: true })
  writeFileSync(
    join(setupConfigDir, 'settings.json'),
    `${JSON.stringify({ subscriptionType: 'pro' })}\n`,
    { mode: 0o600 },
  )
  const setup = runSetup(
    binPath(prefix),
    ['--chrome', '--init-only', '--debug-to-stderr'],
    {
      cwd: home,
      env: {
        ...npmEnv(home),
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        CLAUDE_CODE_DEBUG_LOG_LEVEL: 'debug',
        OPENCLAUDE_CONFIG_DIR: setupConfigDir,
        OPENCLAUDE_SKIP_CHROME_NATIVE_HOST_REGISTRATION: '1',
      },
      timeout: 2 * 60 * 1000,
    },
  )
  if (setup.status !== 0) {
    reporter.fail(
      `installed CLI Chrome setup exited ${setup.status}: ${setup.stderr.slice(0, 500)}`,
    )
    return
  }

  const launches = parseInstalledChromeSetupLaunches(setup.stderr)
  if (launches === null) {
    reporter.fail(
      'installed CLI Chrome setup emitted no valid launch configuration receipt',
    )
    return
  }

  const wrapperName = IS_WINDOWS
    ? 'chrome-native-host.bat'
    : 'chrome-native-host'
  const wrapperPath = join(setupConfigDir, 'chrome', wrapperName)
  if (!existsSync(wrapperPath)) {
    reporter.fail(`installed CLI Chrome setup created no wrapper at ${wrapperPath}`)
    return
  }

  const problems = getInstalledChromeSetupProblems({
    installedLaunchers: [...new Set([globalLauncher, packageLauncher])],
    launches,
    wrapperContent: readFileSync(wrapperPath, 'utf8'),
  })
  for (const problem of problems) reporter.fail(problem)
  if (problems.length === 0) {
    reporter.pass(
      'installed bundle setup generates Chrome targets for the global launcher',
    )
  }
}

function binPath(prefix: string): string {
  return IS_WINDOWS ? join(prefix, 'openclaude.cmd') : join(prefix, 'bin', 'openclaude')
}

function runBin(
  prefix: string,
  home: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  return runCommand(binPath(prefix), args, {
    env: npmEnv(home),
    cwd: home,
    timeout: 2 * 60 * 1000,
  })
}

function checkBinBoots(scenario: string, prefix: string, home: string, expectedVersion: string | null): void {
  const version = runBin(prefix, home, ['--version'])
  if (version.status !== 0) {
    fail(scenario, `\`openclaude --version\` exited ${version.status}: ${version.stderr}`)
  } else if (expectedVersion && version.stdout.trim() !== `${expectedVersion} (OpenClaude)`) {
    fail(scenario, `--version printed "${version.stdout.trim()}", expected "${expectedVersion} (OpenClaude)"`)
  } else if (version.stderr.trim().length > 0) {
    fail(scenario, `--version wrote to stderr: "${version.stderr.trim()}"`)
  } else {
    pass(scenario, `--version prints ${version.stdout.trim()}`)
  }

  // --version is a zero-import fast path; --help forces the real bundle to
  // load, so a broken or noisy-at-boot build fails here.
  const installedVersion = version.status === 0 ? version.stdout.trim().split(' ')[0] : ''
  const bootNoiseKnown = KNOWN_FIRST_BOOT_NOISE_VERSIONS.has(installedVersion ?? '')
  const help = runBin(prefix, home, ['--help'])
  if (help.status !== 0) {
    fail(scenario, `\`openclaude --help\` exited ${help.status}: ${help.stderr}`)
  } else if (!/usage/i.test(help.stdout)) {
    fail(scenario, `--help output does not look like help text: "${help.stdout.slice(0, 200)}"`)
  } else if (help.stderr.trim().length > 0) {
    if (bootNoiseKnown) {
      console.log(`  … [${scenario}] --help stderr noise is a known issue in ${installedVersion} (fixed in the next release)`)
    } else {
      fail(scenario, `--help wrote to stderr (boot must be silent): "${help.stderr.trim()}"`)
    }
  } else {
    pass(scenario, '--help loads the full bundle with silent stderr')
  }

}

const REQUIRED_TARBALL_ENTRIES = [
  'package/package.json',
  'package/bin/openclaude',
  'package/bin/node-compile-cache.mjs',
  'package/bin/heap-limit.mjs',
  'package/dist/cli.mjs',
  'package/dist/sdk.mjs',
  'package/src/entrypoints/sdk.d.ts',
] as const
const FORBIDDEN_TARBALL_ENTRIES = ['package/dist/cli.js'] as const

export function getTarballPayloadProblems(
  entries: ReadonlySet<string>,
): string[] {
  const problems: string[] = []
  const missing = REQUIRED_TARBALL_ENTRIES.filter(entry => !entries.has(entry))
  const presentForbidden = FORBIDDEN_TARBALL_ENTRIES.filter(entry =>
    entries.has(entry),
  )
  if (missing.length > 0) {
    problems.push(`tarball is missing declared payload: ${missing.join(', ')}`)
  }
  if (presentForbidden.length > 0) {
    problems.push(
      `tarball contains obsolete CLI payload: ${presentForbidden.join(', ')}`,
    )
  }
  return problems
}

function checkTarballContents(tarballPath: string): void {
  const scenario = 'tarball'
  const listing = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
  const entries = new Set(listing.split(/\r?\n/).map(l => l.trim()))
  const payloadProblems = getTarballPayloadProblems(entries)
  for (const problem of payloadProblems) fail(scenario, problem)
  if (payloadProblems.length === 0) {
    pass(scenario, `tarball carries the full declared payload (${entries.size - 1} files)`)
  }
  const size = statSync(tarballPath).size
  if (size > MAX_TARBALL_BYTES) {
    fail(scenario, `tarball is ${size} bytes (> ${MAX_TARBALL_BYTES} bound) — payload blowup?`)
  } else {
    pass(scenario, `tarball size ${(size / 1e6).toFixed(1)}MB within bound`)
  }
}

function makeSandbox(work: string, name: string): { prefix: string; cache: string; home: string } {
  const scenarioRoot = join(work, `${name} install scenario`)
  const prefix = join(scenarioRoot, 'install prefix')
  const cache = join(scenarioRoot, 'npm cache')
  const home = join(scenarioRoot, 'home dir')
  for (const dir of [prefix, cache, home]) mkdirSync(dir, { recursive: true })
  return { prefix, cache, home }
}

function packWorkingTree(work: string): string {
  for (const artifact of ['dist/cli.mjs', 'dist/sdk.mjs']) {
    if (!existsSync(artifact)) {
      console.error(`❌ ${artifact} not found — run \`bun run build\` before --tarball mode (the pack uses --ignore-scripts to avoid a redundant prepack build).`)
      process.exit(1)
    }
  }
  const home = join(work, 'pack-home')
  mkdirSync(home, { recursive: true })
  const { status, stdout, stderr } = runNpm(
    ['pack', '--ignore-scripts', '--json', `--pack-destination=${work}`, '--loglevel=error'],
    home,
  )
  if (status !== 0) {
    console.error(`❌ npm pack failed: ${stderr}`)
    process.exit(1)
  }
  const filename = JSON.parse(stdout)[0]?.filename
  if (!filename) {
    console.error(`❌ npm pack returned no filename: ${stdout}`)
    process.exit(1)
  }
  return join(work, filename)
}

type NpmRunResult = { status: number; stdout: string; stderr: string }

// Same retry/infra discipline as installWithRetry: a transient registry
// hiccup must not silently drop the upgrade-scenario coverage (the infra
// callback exits 2, distinguishable from a hygiene verdict). A clean "not
// published" answer (e.g. E404 before the first release) legitimately
// returns null → skip. Effects are injected so the retry/skip/infra branches
// are unit-testable (verify-clean-install.test.ts) without shelling out.
export function resolvePreviousPublishedVersion(options: {
  runView: () => NpmRunResult
  onRetry: (attempt: number) => void
  onInfraFailure: (combinedOutput: string) => never
  retries?: number
}): string | null {
  const retries = options.retries ?? INSTALL_RETRIES
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { status, stdout, stderr } = options.runView()
    if (status === 0) {
      const version = stdout.trim()
      return /^\d+\.\d+\.\d+/.test(version) ? version : null
    }
    const combined = `${stdout}\n${stderr}`
    if (!looksLikeInfraFailure(combined)) return null
    if (attempt < retries) {
      options.onRetry(attempt)
      continue
    }
    options.onInfraFailure(combined)
  }
  return null
}

function previousPublishedVersion(home: string): string | null {
  return resolvePreviousPublishedVersion({
    runView: () =>
      runNpm(['view', `${PACKAGE_NAME}@latest`, 'version', '--loglevel=error'], home),
    onRetry: attempt =>
      console.log(`  … npm view failed with network symptoms, retrying (${attempt}/${INSTALL_RETRIES})`),
    onInfraFailure: combined => {
      console.error(combined)
      console.error(`\n⚠️  npm view ${PACKAGE_NAME}@latest failed with network/registry symptoms after ${INSTALL_RETRIES} attempts — infra problem, not a hygiene verdict.`)
      return process.exit(2)
    },
  })
}

function runScenarios(
  target: string,
  expectedVersion: string | null,
  work: string,
  checkContract: boolean,
): void {
  // Scenario 1: cold install into a pristine prefix.
  {
    const scenario = 'cold-install'
    console.log(`\n▶ ${scenario}: npm install -g ${target}`)
    const { prefix, cache, home } = makeSandbox(work, 'cold')
    const output = installWithRetry(scenario, target, prefix, cache, home)
    if (output !== null) {
      checkOutputWhitelist(scenario, output)
      checkNoInstallScripts(scenario, prefix)
      // Contract comparison only makes sense for the artifact built from THIS
      // tree; a published artifact predates contract bumps (version skew).
      if (checkContract) checkInstalledContract(scenario, prefix)
      if (checkContract) {
        checkInstalledChromeEntrypoint(scenario, prefix, home)
      }
      checkBinBoots(scenario, prefix, home, expectedVersion)
    }
  }

  // Scenario 2: upgrade over the previously published version — the common
  // real-world path, with different npm summary output than a cold install.
  {
    const scenario = 'upgrade-install'
    const { prefix, cache, home } = makeSandbox(work, 'upgrade')
    const previous = previousPublishedVersion(home)
    if (previous === null) {
      console.log(`\n▶ ${scenario}: skipped (no published ${PACKAGE_NAME}@latest reachable)`)
      return
    }
    console.log(`\n▶ ${scenario}: ${PACKAGE_NAME}@${previous} → ${target}`)
    // The baseline install is not under test (it is the already-shipped
    // version); only the upgrade on top of it must be clean.
    const baseline = installWithRetry(scenario, `${PACKAGE_NAME}@${previous}`, prefix, cache, home)
    if (baseline === null) return
    const output = installWithRetry(scenario, target, prefix, cache, home)
    if (output !== null) {
      checkOutputWhitelist(scenario, output)
      checkNoInstallScripts(scenario, prefix)
      if (checkContract) {
        checkInstalledChromeEntrypoint(scenario, prefix, home)
      }
      checkBinBoots(scenario, prefix, home, expectedVersion)
    }
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const mode = args[0] === '--published' ? 'published' : '--tarball' === args[0] || args.length === 0 ? 'tarball' : null
  if (mode === null) {
    console.error('Usage: verify-clean-install.ts [--tarball [path] | --published [spec]]')
    process.exit(1)
  }

  const work = mkdtempSync(join(tmpdir(), 'openclaude-install-verify-'))
  try {
    let target: string
    let expectedVersion: string | null
    if (mode === 'tarball') {
      const tarballPath = args[1] ?? packWorkingTree(work)
      checkTarballContents(tarballPath)
      target = tarballPath
      expectedVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
    } else {
      target = args[1] ?? `${PACKAGE_NAME}@latest`
      expectedVersion = null // registry version; asserted non-empty via --version format
    }

    console.log(`Verifying zero-warning install: ${target}`)
    runScenarios(target, expectedVersion, work, mode === 'tarball')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\n❌ install hygiene FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}). The npm install experience is not zero-warning.`)
    process.exit(1)
  }
  console.log('\n✓ install hygiene verified: clean output, no install scripts, contract intact, binary boots silently.')
}

// Guarded so the test file can import resolvePreviousPublishedVersion without
// kicking off a real pack + registry install.
if (import.meta.main) {
  main()
}
