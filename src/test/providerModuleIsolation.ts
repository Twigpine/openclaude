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
