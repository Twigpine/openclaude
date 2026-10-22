export const REAL_PROVIDER_TEST_CHILD_ENV =
  'OPENCLAUDE_REAL_PROVIDER_TEST_CHILD'
export const REAL_PROVIDER_TEST_TIMEOUT_MS = 30_000

type ProviderModule = Pick<
  typeof import('../utils/model/providers.js'),
  | 'getAPIProvider'
  | 'usesAnthropicAccountFlow'
  | 'isFirstPartyAnthropicProvider'
  | 'isCustomAnthropicProvider'
  | 'isGithubNativeAnthropicMode'
  | 'getAPIProviderForStatsig'
  | 'isFirstPartyAnthropicBaseUrl'
>

const PROVIDER_FUNCTIONS = [
  'getAPIProvider',
  'usesAnthropicAccountFlow',
  'isFirstPartyAnthropicProvider',
  'isCustomAnthropicProvider',
  'isGithubNativeAnthropicMode',
  'getAPIProviderForStatsig',
  'isFirstPartyAnthropicBaseUrl',
] as const satisfies readonly (keyof ProviderModule)[]

export function providerModuleIsMocked(
  loaded: ProviderModule,
  cacheBustedReal: ProviderModule,
): boolean {
  return PROVIDER_FUNCTIONS.some(
    name => String(loaded[name]) !== String(cacheBustedReal[name]),
  )
}

function exportSurfacesDiffer(loaded: object, real: object): boolean {
  const loadedKeys = Reflect.ownKeys(loaded)
  const realKeys = Reflect.ownKeys(real)
  if (
    loadedKeys.length !== realKeys.length ||
    realKeys.some(key => !Object.hasOwn(loaded, key))
  ) return true

  return realKeys.some(key => {
    const actual: unknown = Reflect.get(loaded, key)
    const expected: unknown = Reflect.get(real, key)
    if (typeof actual !== typeof expected) return true
    if (typeof actual === 'function' && typeof expected === 'function') {
      const actualSource = Function.prototype.toString.call(actual)
      const expectedSource = Function.prototype.toString.call(expected)
      // Native/bound functions cannot be inspected reliably.
      return actualSource.includes('[native code]') ||
        expectedSource.includes('[native code]') || actualSource !== expectedSource
    }
    // These modules currently export functions and primitives. Unknown mutable
    // objects (including symbols) cannot establish a clean comparison.
    if ((typeof actual === 'object' && actual !== null) ||
      typeof actual === 'symbol') return true
    return !Object.is(actual, expected)
  })
}

export async function attributionModulesNeedIsolation(): Promise<boolean> {
  // Check before any imports: a clean child must never recurse.
  if (process.env[REAL_PROVIDER_TEST_CHILD_ENV] === '1') return false

  // This detects replaced exports, not arbitrary stale dependency caches.
  // Auth is checked independently even when routing has unchanged source.
  const modulePaths = [
    '../utils/model/providers.js',
    '../utils/auth.js',
    '../utils/betas.js',
    '../services/api/authRouting.js',
    '../integrations/routeMetadata.js',
    '../services/api/client.js',
  ]
  try {
    for (const path of modulePaths) {
      const loaded = await import(path)
      const real = await import(
        `${path}?attributionReal=${Date.now()}-${Math.random()}`
      )
      if (exportSurfacesDiffer(loaded, real)) return true
    }
    return false
  } catch {
    // Missing exports, throwing getters, and failed imports require isolation.
    return true
  }
}

export async function runTestFileWithRealProviders(
  testFile: string,
): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'test', testFile],
    cwd: process.cwd(),
    env: {
      ...process.env,
      [REAL_PROVIDER_TEST_CHILD_ENV]: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: REAL_PROVIDER_TEST_TIMEOUT_MS,
    killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(
      `provider-isolated test process failed for ${testFile} (${exitCode})\n${stdout}\n${stderr}`,
    )
  }
}
