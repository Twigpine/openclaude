import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Resolves the override env value for the config home directory.
 * Resolves the OpenClaude config home override.
 *
 * Intentionally does not read `CLAUDE_CONFIG_DIR`: OpenClaude config must stay
 * independent from Claude Code config and credentials.
 */
export function resolveConfigDirEnv(options?: {
  openClaudeConfigDir?: string
  legacyConfigDir?: string
  warn?: (message: string) => void
}): string | undefined {
  void options?.legacyConfigDir
  void options?.warn
  return options?.openClaudeConfigDir || undefined
}

/**
 * Test-only escape hatch — resets the once-per-process conflict warning so
 * unit tests can re-trigger it.
 */
export function __resetConfigDirEnvWarningForTesting(): void {
  // Kept as a no-op for older tests importing this helper.
}

export function resolveClaudeConfigHomeDir(options?: {
  configDirEnv?: string
  homeDir?: string
}): string {
  if (options?.configDirEnv) {
    return options.configDirEnv.normalize('NFC')
  }

  const homeDir = options?.homeDir ?? homedir()
  const openClaudeDir = join(homeDir, '.openclaude')

  return openClaudeDir.normalize('NFC')
}

let claudeConfigHomeDirOverride: string | undefined

export function setClaudeConfigHomeDirForTesting(
  configDir: string | undefined,
): void {
  claudeConfigHomeDirOverride = configDir?.normalize('NFC')
}

export function getClaudeConfigHomeDirOverrideForTesting(): string | undefined {
  return claudeConfigHomeDirOverride
}

// Memoized for the default home-dir path: 150+ callers, many on hot paths.
// Explicit env overrides and test overrides bypass this cache so runtime
// overrides cannot be masked by a previously memoized default path.
const getDefaultClaudeConfigHomeDir = memoize(
  (): string => {
    const homeDir = homedir()
    return resolveClaudeConfigHomeDir({
      homeDir,
    })
  },
  () => homedir(),
)

export const getClaudeConfigHomeDir = Object.assign(
  (): string => {
    if (claudeConfigHomeDirOverride) {
      return claudeConfigHomeDirOverride
    }

    const configDirEnv = resolveConfigDirEnv({
      openClaudeConfigDir: process.env.OPENCLAUDE_CONFIG_DIR,
    })
    if (configDirEnv) {
      return resolveClaudeConfigHomeDir({ configDirEnv })
    }

    return getDefaultClaudeConfigHomeDir()
  },
  { cache: getDefaultClaudeConfigHomeDir.cache },
)

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 *
 * Mirrors Node's `ParseNodeOptionsEnvVar` (src/node_options.cc):
 * - double quotes toggle `is_in_string` and are stripped
 * - backslash escapes the next character only when `is_in_string`
 * - spaces outside quotes delimit tokens; single quotes are literal
 * - value-taking options consume the next token as a value so
 *   `--conditions "--use-system-ca"` does not count as `--use-system-ca`
 * Handles `--flag=value` forms (e.g. `--max-old-space-size=4096`) and avoids
 * prefix false positives (e.g. `--inspect` must not match `--inspect-brk`).
 * Fails closed (returns false) when quoting is malformed: an unterminated
 * double-quoted string or an incomplete in-string escape means Node would
 * reject the whole NODE_OPTIONS value, so no option is reported active.
 * For `--use-system-ca` / `--use-openssl-ca`, later `--no-*` occurrences
 * disable earlier positives (and vice versa) in token order.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }

  // Node's ParseNodeOptionsEnvVar (src/node_options.cc)
  const rawTokens: string[] = []
  let isInString = false
  let willStartNewArg = true
  let malformed = false
  for (let i = 0; i < nodeOptions.length; i++) {
    let c = nodeOptions[i]!
    if (c === '\\' && isInString) {
      if (i + 1 >= nodeOptions.length) {
        // Trailing escape with nothing to escape: Node rejects the value.
        malformed = true
        break
      }
      c = nodeOptions[++i]!
    } else if (c === ' ' && !isInString) {
      willStartNewArg = true
      continue
    } else if (c === '"') {
      isInString = !isInString
      continue
    } else if (c === '\t' && !isInString) {
      willStartNewArg = true
      continue
    }

    if (willStartNewArg) {
      rawTokens.push(c)
      willStartNewArg = false
    } else {
      rawTokens[rawTokens.length - 1] += c
    }
  }

  // Node rejects unterminated quotes / incomplete escapes at startup. This
  // helper can also run after bootstrap (settings re-applies NODE_OPTIONS,
  // clears CA/proxy/mTLS caches, rebuilds agents), so fail closed here to
  // avoid trusting system roots from an invalid option string.
  if (malformed || isInString) {
    return false
  }

  // Options whose value is required and may look like a flag (e.g. --conditions).
  // These always consume the next token as value, even if it starts with '-'.
  const ALWAYS_CONSUMES_NEXT = new Set(['--conditions', '-C'])

  // Other value-taking options (std::string / vector / int / HostPort) that
  // require a value but whose values are typically paths/names. We only skip
  // the next token if it does not look like an option (does not start with '-'),
  // to avoid false negatives like `--inspect --use-system-ca`.
  const VALUE_TAKING = new Set([
    '--allow-fs-read',
    '--allow-fs-write',
    '--cpu-prof-dir',
    '--cpu-prof-interval',
    '--cpu-prof-name',
    '--diagnostic-dir',
    '--disable-proto',
    '--disable-warning',
    '--dns-result-order',
    '--experimental-default-type',
    '--experimental-import-meta-resolve',
    '--experimental-loader',
    '--heap-prof-dir',
    '--heap-prof-interval',
    '--heap-prof-name',
    '--heapsnapshot-near-heap-limit',
    '--heapsnapshot-signal',
    '--icu-data-dir',
    '--import',
    '--input-type',
    '--localstorage-file',
    '--max-http-header-size',
    '--network-family-autoselection-attempt-timeout',
    '--openssl-config',
    '--redirect-warnings',
    '--report-dir',
    '--report-directory',
    '--report-filename',
    '--report-signal',
    '--require',
    '-r',
    '--secure-heap',
    '--secure-heap-min',
    '--snapshot-blob',
    '--test-coverage-branches',
    '--test-coverage-exclude',
    '--test-coverage-functions',
    '--test-coverage-include',
    '--test-coverage-lines',
    '--test-name-pattern',
    '--test-reporter',
    '--test-reporter-destination',
    '--test-shard',
    '--test-skip-pattern',
    '--title',
    '--tls-cipher-list',
    '--tls-keylog',
    '--trace-event-categories',
    '--trace-event-file-pattern',
    '--trace-require-module',
    '--unhandled-rejections',
    '--use-largepages',
    '--v8-pool-size',
    '--watch-kill-signal',
    '--watch-path',
    '--max-old-space-size',
    '--max-old-space-size-percentage',
    '--max-semi-space-size',
    '--stack-trace-limit',
  ])

  // Build the effective option stream: value-taking options consume the
  // next token so `--conditions "--use-system-ca"` does not count as a flag.
  // Use a pending-consume flag (not raw-prev lookup) so a consumed value that
  // happens to spell an option (e.g. `--conditions --conditions X`) cannot
  // itself consume the following token.
  const effectiveTokens: string[] = []
  let pendingAlwaysConsume = false
  let pendingValueConsume = false
  for (const token of rawTokens) {
    if (pendingAlwaysConsume) {
      pendingAlwaysConsume = false
      continue
    }
    if (pendingValueConsume) {
      pendingValueConsume = false
      if (!token.startsWith('-')) {
        continue
      }
      // Flag-like token: not a value, fall through as an option.
    }
    effectiveTokens.push(token)
    const base = token.split('=')[0]!
    if (!token.includes('=')) {
      if (ALWAYS_CONSUMES_NEXT.has(base)) {
        pendingAlwaysConsume = true
      } else if (VALUE_TAKING.has(base)) {
        pendingValueConsume = true
      }
    }
  }

  // CA flags are boolean options with `--no-*` negations applied in order.
  // Later occurrences win so `--use-system-ca=1 --no-use-system-ca` disables
  // (Node leaves bundled roots) and the reverse re-enables.
  const CA_NEGATIONS: Record<string, string> = {
    '--use-system-ca': '--no-use-system-ca',
    '--use-openssl-ca': '--no-use-openssl-ca',
  }
  const CA_POSITIVES: Record<string, string> = {
    '--no-use-system-ca': '--use-system-ca',
    '--no-use-openssl-ca': '--use-openssl-ca',
  }
  let positive = flag
  let negative: string | undefined
  if (flag in CA_NEGATIONS) {
    negative = CA_NEGATIONS[flag]
  } else if (flag in CA_POSITIVES) {
    positive = CA_POSITIVES[flag]!
    negative = flag
  }

  if (negative !== undefined) {
    let enabled = false
    for (const token of effectiveTokens) {
      if (token === positive || token.startsWith(positive + '=')) {
        enabled = true
      } else if (token === negative || token.startsWith(negative + '=')) {
        enabled = false
      }
    }
    return enabled
  }

  for (const token of effectiveTokens) {
    if (token === flag || token.startsWith(flag + '=')) {
      return true
    }
  }
  return false
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether Claude Code is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
