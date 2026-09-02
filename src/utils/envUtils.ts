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
 * Handles `--flag=value` forms (e.g. `--max-old-space-size=4096`,
 * `--inspect=0.0.0.0:9229`) and double-quoted tokens (matching Node's
 * option lexer; single quotes are literal once inside `process.env`).
 * Matches exact flag or flag with an `=value` suffix to avoid false
 * positives on prefix-related flags (e.g. `--inspect` must not match
 * `--inspect-brk`).
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  const tokens = nodeOptions.split(/\s+/).filter(Boolean)
  for (let token of tokens) {
    // Only double quotes are interpreted by Node's NODE_OPTIONS parser;
    // single quotes are kept literal (Node leaves them as part of the token).
    if (
      token.length >= 2 &&
      token.startsWith('"') &&
      token.endsWith('"')
    ) {
      token = token.slice(1, -1)
    }
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
