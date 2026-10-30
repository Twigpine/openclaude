/**
 * Package consumer validation test.
 *
 * Ensures the packed SDK types compile correctly for a real TypeScript consumer.
 * Reproduces: npm pack file list → install into temp project → tsc with skipLibCheck:false.
 *
 * This catches issues like:
 * - Constructor parameter properties in .d.ts (not allowed)
 * - Missing local imports for re-exported types
 * - Self-referential type wrappers
 * - Declaration files or exports targets missing from the published `files`
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { execFile, execFileSync, execSync } from 'child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

const ROOT = join(import.meta.dir, '..', '..')
const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** All temp dirs created during tests — cleaned up in afterAll */
const tempDirs: string[] = []

let packedFiles: string[] | undefined

/** Files npm would publish, resolved from the real package.json `files` rules. */
function getPackedFiles(): string[] {
  packedFiles ??= (
    JSON.parse(
      execSync('npm pack --dry-run --json --ignore-scripts', {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as Array<{ files: Array<{ path: string }> }>
  )[0]!.files.map(file => file.path)
  return packedFiles
}

/**
 * Set up a minimal TypeScript consumer project that imports from the SDK.
 * Simulates what npm pack + install would produce.
 */
function setupConsumerProject(name: string): string {
  const tmpDir = join(ROOT, '.tmp', `sdk-consumer-${name}-${randomUUID().slice(0, 8)}`)
  tempDirs.push(tmpDir)
  mkdirSync(tmpDir, { recursive: true })

  // Create consumer tsconfig — skipLibCheck:false is critical
  writeFileSync(
    join(tmpDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    ),
  )

  // The consumer's own package.json stops TypeScript from self-resolving
  // @twigpine/openclaude through the repository root package.json.
  writeFileSync(
    join(tmpDir, 'package.json'),
    JSON.stringify({ name: `sdk-consumer-${name}`, private: true, type: 'module' }, null, 2),
  )

  // Install the packed package contents, including its real package.json, so
  // `files` and `exports` mistakes fail here as they would for npm consumers.
  const pkgDir = join(tmpDir, 'node_modules', '@twigpine', 'openclaude')
  for (const file of getPackedFiles()) {
    // Build output is not needed for type resolution and may be absent before a build
    if (file.startsWith('dist/')) continue
    mkdirSync(dirname(join(pkgDir, file)), { recursive: true })
    cpSync(join(ROOT, file), join(pkgDir, file))
  }

  // Dummy dist file so module resolution doesn't fail
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(join(pkgDir, 'dist', 'sdk.mjs'), 'export {}')

  return tmpDir
}

/** Compile a consumer, rejecting failed builds with their diagnostics and exit metadata. */
async function tsc(tmpDir: string, compiler = TSC_BIN, timeout = 20_000): Promise<string> {
  // Finish subprocess cleanup before the 30s test deadline. A synchronous wait
  // can trap Bun's isolated runner in dangling-process cleanup on timeout.
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [compiler, '-p', 'tsconfig.json', '--pretty', 'false'], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout,
      killSignal: 'SIGKILL',
    })
    return stdout.trim()
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim()) {
      error.message += `\n${error.stdout.trim()}`
    }
    throw error
  }
}

let artifactsBuilt = false

/** Build current sources once before validating package exports and runtime behavior. */
function ensureBuildArtifacts(): void {
  if (artifactsBuilt) return

  execSync('bun run build', {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  })
  artifactsBuilt = true
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows EBUSY — ignore, will be cleaned on next run or reboot
    }
  }
})

// tsc compilation can be slow under CPU contention — 30s timeout per test
describe('package consumer types', () => {
  test('compiler failures retain their diagnostics and nonzero exit code', async () => {
    const tmpDir = setupConsumerProject('compiler-diagnostics')
    writeFileSync(join(tmpDir, 'consumer.ts'), 'const value: string = 123\n')
    await expect(tsc(tmpDir)).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining('TS2322'),
    })
  }, 30_000)

  test('compiler deadline kills a child that ignores graceful termination', async () => {
    const tmpDir = setupConsumerProject('compiler-timeout')
    const compiler = join(tmpDir, 'stalled-compiler.cjs')
    const pidPath = join(tmpDir, 'compiler.pid')
    writeFileSync(compiler, `
      process.on('SIGTERM', () => {})
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
      setInterval(() => {}, 1000)
    `)
    await expect(tsc(tmpDir, compiler, 3000)).rejects.toMatchObject({
      killed: true,
      signal: 'SIGKILL',
    })
    const pid = Number(readFileSync(pidPath, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  test('SDK types compile for external consumer with skipLibCheck:false', async () => {
    const tmpDir = setupConsumerProject('basic')

    writeFileSync(
      join(tmpDir, 'consumer.ts'),
      [
        `import type {`,
        `  SDKMessage,`,
        `  SDKUserMessage,`,
        `  SDKResultMessage,`,
        `  SDKRateLimitError,`,
        `  QueryOptions,`,
        `  SDKSession,`,
        `  SDKSessionOptions,`,
        `} from '@twigpine/openclaude/sdk'`,
        ``,
        `// Use the types so they're not unused-imports-eliminated`,
        `type _Msg = SDKMessage`,
        `type _User = SDKUserMessage`,
        `type _Result = SDKResultMessage`,
        ``,
        `// Verify SDKRateLimitError properties are accessible`,
        `declare const err: SDKRateLimitError`,
        `const _resets: number | undefined = err.resetsAt`,
        `const _rateType: string | undefined = err.rateLimitType`,
        ``,
        `// Verify session types`,
        `declare const session: SDKSession`,
        `const _messages: SDKMessage[] = session.getMessages()`,
        ``,
        `// SDK-provided agents can rely on the runtime name fallback for description.`,
        `const _queryOptions: QueryOptions = {`,
        `  cwd: '/tmp/project',`,
        `  agents: {`,
        `    helper: {`,
        `      prompt: 'Help with package consumer type coverage',`,
        `      maxSteps: 2,`,
        `    },`,
        `  },`,
        `}`,
        `const _sessionOptions: SDKSessionOptions = {`,
        `  cwd: '/tmp/project',`,
        `  agents: {`,
        `    helper: {`,
        `      prompt: 'Help with persistent SDK session type coverage',`,
        `      maxSteps: 2,`,
        `    },`,
        `  },`,
        `}`,
      ].join('\n'),
    )

    expect(await tsc(tmpDir)).toBe('')
  }, 30_000)

  test('SDKMessage/SDKUserMessage/SDKResultMessage are re-exported correctly', async () => {
    const tmpDir = setupConsumerProject('reexports')

    writeFileSync(
      join(tmpDir, 'consumer.ts'),
      [
        `import type { SDKMessage, SDKUserMessage, SDKResultMessage } from '@twigpine/openclaude/sdk'`,
        ``,
        `// Discriminated union check — if types are broken, this won't compile`,
        `function handle(msg: SDKMessage) {`,
        `  if (msg.type === 'user') {`,
        `    const u: SDKUserMessage = msg`,
        `    console.log(u.message.content)`,
        `  }`,
        `  if (msg.type === 'result') {`,
        `    const r: SDKResultMessage = msg`,
        `    console.log(r.type)`,
        `  }`,
        `}`,
      ].join('\n'),
    )

    expect(await tsc(tmpDir)).toBe('')
  }, 30_000)

  test('result usage standard counters are required numbers', async () => {
    const tmpDir = setupConsumerProject('usage-counters')

    writeFileSync(
      join(tmpDir, 'consumer.ts'),
      [
        `import type { SDKResultMessage } from '@twigpine/openclaude/sdk'`,
        ``,
        `// Result messages are populated from QueryEngine.totalUsage`,
        `// (initialized from EMPTY_USAGE), so the standard counters are`,
        `// always-present numbers — strict consumers may sum them without`,
        `// undefined guards.`,
        `declare const result: SDKResultMessage`,
        `const _total: number =`,
        `  result.usage.input_tokens +`,
        `  result.usage.output_tokens +`,
        `  result.usage.cache_creation_input_tokens +`,
        `  result.usage.cache_read_input_tokens`,
        ``,
        `// Richer nested metadata is modeled explicitly`,
        `const _cache5m: number | undefined =`,
        `  result.usage.cache_creation?.ephemeral_5m_input_tokens`,
        `const _webSearches: number | undefined =`,
        `  result.usage.server_tool_use?.web_search_requests`,
        `const _tier: string | undefined = result.usage.service_tier`,
        ``,
        `// Unanticipated fields still flow through the index signature`,
        `const _extra: unknown = result.usage.inference_geo`,
      ].join('\n'),
    )

    expect(await tsc(tmpDir)).toBe('')
  }, 30_000)

  test('SDKRateLimitError has resetsAt and rateLimitType as class properties', async () => {
    const tmpDir = setupConsumerProject('ratelimit')

    writeFileSync(
      join(tmpDir, 'consumer.ts'),
      [
        `import { SDKRateLimitError } from '@twigpine/openclaude/sdk'`,
        ``,
        `// Constructor should accept (message?, resetsAt?, rateLimitType?)`,
        `const err = new SDKRateLimitError('rate limited', 12345, 'requests')`,
        ``,
        `// Properties should be accessible on the instance`,
        `const resets: number | undefined = err.resetsAt`,
        `const rateType: string | undefined = err.rateLimitType`,
        ``,
        `console.log(resets, rateType)`,
      ].join('\n'),
    )

    expect(await tsc(tmpDir)).toBe('')
  }, 30_000)

  test('control initialize response accepts generated model and account values', async () => {
    const tmpDir = setupConsumerProject('control-init')

    writeFileSync(
      join(tmpDir, 'consumer.ts'),
      [
        `import type { SDKControlInitializeResponse, ModelInfo } from '@twigpine/openclaude/sdk'`,
        ``,
        `const models: ModelInfo[] = [{`,
        `  value: 'claude-opus-4-6',`,
        `  displayName: 'Claude Opus 4.6',`,
        `  description: 'Most capable model',`,
        `  supportsEffort: true,`,
        `  supportedEffortLevels: ['low', 'medium', 'high', 'max'],`,
        `}]`,
        ``,
        `const response: SDKControlInitializeResponse = {`,
        `  commands: [],`,
        `  agents: [],`,
        `  output_style: 'default',`,
        `  available_output_styles: ['default'],`,
        `  models,`,
        `  account: { apiProvider: 'openai' },`,
        `  pid: 1234,`,
        `}`,
        ``,
        `console.log(response)`,
      ].join('\n'),
    )

    expect(await tsc(tmpDir)).toBe('')
  }, 30_000)
})

describe('package exports resolution', () => {
  test('package.json export is defined in exports map', () => {
    // Read the package.json and verify exports structure
    const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    expect(pkgJson.exports).toBeDefined()
    expect(pkgJson.exports['./package.json']).toBe('./package.json')
    expect(pkgJson.exports['./dist/cli.mjs']).toBe('./dist/cli.mjs')
    expect(pkgJson.exports['./sdk']).toBeDefined()
    expect(pkgJson.exports['./sdk'].import).toBe('./dist/sdk.mjs')
    expect(pkgJson.exports['./sdk'].types).toBe('./src/entrypoints/sdk.d.ts')
  })

  test('root export is not defined (intentionally blocked)', () => {
    // Verify that "." is not in exports map
    const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    expect(pkgJson.exports['.']).toBeUndefined()
    // No main field means root import is intentionally broken
    expect(pkgJson.main).toBeUndefined()
  })

  test('exported files exist after build', () => {
    ensureBuildArtifacts()

    // Verify the files referenced in exports exist
    expect(existsSync(join(ROOT, 'package.json'))).toBe(true)
    expect(existsSync(join(ROOT, 'dist', 'cli.mjs'))).toBe(true)
    expect(existsSync(join(ROOT, 'dist', 'sdk.mjs'))).toBe(true)
    expect(existsSync(join(ROOT, 'src', 'entrypoints', 'sdk.d.ts'))).toBe(true)
  }, 180_000)
})

test('built Node SDK preserves absence of inherited environment names', () => {
  ensureBuildArtifacts()
  const sdkUrl = new URL('../../dist/sdk.mjs', import.meta.url).href
  const result = execFileSync('node', ['--input-type=module', '-e', `
    import { unstable_v2_createSession } from ${JSON.stringify(sdkUrl)};
    const keys = ['__proto__', 'constructor', 'toString'];
    for (const key of keys) delete process.env[key];
    const session = unstable_v2_createSession({
      cwd: process.cwd(), env: Object.fromEntries(keys.map(key => [key, 'during'])),
    });
    const snapshot = await session.applySessionEnv();
    session.restoreSessionEnv(snapshot);
    session.close();
    if (keys.some(key => Object.hasOwn(process.env, key))) {
      throw new Error('restoration created an originally absent environment entry');
    }
    console.log('restored absence');
  `], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
  expect(result.trim()).toBe('restored absence')
}, 180_000)
