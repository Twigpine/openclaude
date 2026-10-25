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
 * How a NODE_OPTIONS option consumes its value, mirroring Node's
 * `OptionsParser::Parse` (src/node_options.cc).
 */
type NodeOptionRole =
  /** The option takes no value (`--use-system-ca`). */
  | 'boolean'
  /**
   * The option requires a value: either attached with `=` (and not empty) or
   * supplied as the next argument, which must not start with `-`.
   */
  | 'value'
  /**
   * The option requires its value to be attached with `=`. An empty inline
   * value is accepted (V8-owned flags such as `--max-old-space-size`).
   */
  | 'inline-value'
  /**
   * The option requires a non-empty inline value; a separate argument is not
   * accepted (`--stack-trace-limit`).
   */
  | 'inline-required'

/**
 * NODE_OPTIONS options whose role differs from the default boolean.
 * Originally audited against Node 22.23.2; newer required-value test options
 * are also modeled for the supported Node 24/26 runtimes. Missing values fail
 * the scoped parse, including the V8 flags with distinct attachment rules.
 *
 * Options that are not listed here are treated as booleans: they never
 * consume the following argument. Unknown-option and disallowed-option
 * validation is deliberately out of scope — Node rejects those streams
 * outright, which this helper does not attempt to model.
 */
const NODE_OPTION_ROLES: ReadonlyMap<string, NodeOptionRole> = new Map<
  string,
  NodeOptionRole
>([
  // V8-owned flags. The value must be attached with `=`; V8 tolerates an
  // empty inline value (`--max-old-space-size=` starts and only warns) but
  // rejects a bare flag and a separate value.
  ['--max-old-space-size', 'inline-value'],
  ['--max-semi-space-size', 'inline-value'],
  // Node-owned flag that Node forwards to V8. The value must be attached
  // with `=`: an empty inline value is rejected by Node itself, and a
  // separate value is forwarded to V8 without its value, which V8 rejects.
  ['--stack-trace-limit', 'inline-required'],
  // Node-owned options that take a value.
  ['--allow-fs-read', 'value'],
  ['--allow-fs-write', 'value'],
  ['--conditions', 'value'],
  ['-C', 'value'],
  ['--cpu-prof-dir', 'value'],
  ['--cpu-prof-interval', 'value'],
  ['--cpu-prof-name', 'value'],
  ['--debug-port', 'value'],
  ['--diagnostic-dir', 'value'],
  ['--disable-proto', 'value'],
  ['--disable-warning', 'value'],
  ['--dns-result-order', 'value'],
  ['--experimental-default-type', 'value'],
  ['--experimental-loader', 'value'],
  ['--heap-prof-dir', 'value'],
  ['--heap-prof-interval', 'value'],
  ['--heap-prof-name', 'value'],
  ['--heapsnapshot-near-heap-limit', 'value'],
  ['--heapsnapshot-signal', 'value'],
  ['--icu-data-dir', 'value'],
  ['--import', 'value'],
  ['--input-type', 'value'],
  ['--inspect-port', 'value'],
  ['--inspect-publish-uid', 'value'],
  ['--loader', 'value'],
  ['--localstorage-file', 'value'],
  ['--max-http-header-size', 'value'],
  ['--max-old-space-size-percentage', 'value'],
  ['--network-family-autoselection-attempt-timeout', 'value'],
  ['--openssl-config', 'value'],
  ['--redirect-warnings', 'value'],
  ['--report-dir', 'value'],
  ['--report-directory', 'value'],
  ['--report-filename', 'value'],
  ['--report-signal', 'value'],
  ['--require', 'value'],
  ['-r', 'value'],
  ['--secure-heap', 'value'],
  ['--secure-heap-min', 'value'],
  ['--snapshot-blob', 'value'],
  ['--test-coverage-branches', 'value'],
  ['--test-coverage-exclude', 'value'],
  ['--test-coverage-functions', 'value'],
  ['--test-coverage-include', 'value'],
  ['--test-coverage-lines', 'value'],
  ['--test-global-setup', 'value'],
  ['--test-isolation', 'value'],
  ['--test-name-pattern', 'value'],
  ['--test-reporter', 'value'],
  ['--test-reporter-destination', 'value'],
  ['--test-rerun-failures', 'value'],
  ['--test-shard', 'value'],
  ['--test-skip-pattern', 'value'],
  ['--title', 'value'],
  ['--tls-cipher-list', 'value'],
  ['--tls-keylog', 'value'],
  ['--trace-event-categories', 'value'],
  ['--trace-event-file-pattern', 'value'],
  ['--trace-require-module', 'value'],
  ['--unhandled-rejections', 'value'],
  ['--use-largepages', 'value'],
  ['--v8-pool-size', 'value'],
  ['--watch-kill-signal', 'value'],
  ['--watch-path', 'value'],
])

/**
 * Node's alias expansions (src/node_options.cc `AddAlias`) for the options
 * this helper models. The value lists the options an alias expands to; the
 * first entry owns the value.
 */
const NODE_OPTION_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['-C', ['--conditions']],
  ['-r', ['--require']],
  ['--debug-port', ['--inspect-port']],
  ['--loader', ['--experimental-loader']],
  ['--report-directory', ['--report-dir']],
  ['--experimental-test-isolation', ['--test-isolation']],
])

/**
 * Aliases Node only matches in the `--name=value` form. They expand to
 * `--inspect-port <value>` plus the matching boolean option, so the inline
 * value is required and must not be empty.
 */
const NODE_INLINE_OPTION_ALIASES: ReadonlyMap<string, readonly string[]> =
  new Map([
    ['--inspect=', ['--inspect-port', '--inspect']],
    ['--inspect-brk=', ['--inspect-port', '--inspect-brk']],
    ['--inspect-brk-node=', ['--inspect-port', '--inspect-brk-node']],
    ['--inspect-wait=', ['--inspect-port', '--inspect-wait']],
  ])

/** An option Node accepted, with its `--no-` prefix resolved. */
interface NodeOptionOccurrence {
  /** The option name, without any `--no-` prefix. */
  name: string
  /** Whether the option was spelled as `--no-<name>`. */
  negated: boolean
}

interface NodeOptionsParse {
  /** False when Node would reject the whole NODE_OPTIONS value. */
  valid: boolean
  /** The options Node accepted, in the order they appear. */
  options: NodeOptionOccurrence[]
}

/**
 * Tokenize NODE_OPTIONS the way Node's `ParseNodeOptionsEnvVar` does
 * (src/node_options.cc).
 *
 * - double quotes toggle `is_in_string` and are stripped
 * - a backslash escapes the next character, but only inside a string
 * - only ASCII spaces outside strings delimit arguments (tabs are literal)
 * - single quotes are literal characters
 *
 * Returns null when Node would reject the value: an unterminated string or
 * an incomplete escape.
 */
function tokenizeNodeOptions(nodeOptions: string): string[] | null {
  const tokens: string[] = []
  let isInString = false
  let willStartNewArg = true
  for (let i = 0; i < nodeOptions.length; i++) {
    let c = nodeOptions[i]!
    if (c === '\\' && isInString) {
      if (i + 1 >= nodeOptions.length) {
        // Trailing escape with nothing to escape: Node rejects the value.
        return null
      }
      c = nodeOptions[++i]!
    } else if (c === ' ' && !isInString) {
      willStartNewArg = true
      continue
    } else if (c === '"') {
      isInString = !isInString
      continue
    }

    if (willStartNewArg) {
      tokens.push(c)
      willStartNewArg = false
    } else {
      tokens[tokens.length - 1] += c
    }
  }

  // Node rejects unterminated strings at startup.
  if (isInString) {
    return null
  }
  return tokens
}

/**
 * Resolve an option name to its role and to the option names Node records
 * for it, expanding aliases the way Node does (aliases are resolved before
 * the option lookup, and the `=`-only aliases only match that spelling).
 */
function resolveNodeOption(
  name: string,
  hasInlineValue: boolean,
): { role: NodeOptionRole; names: string[] } {
  if (hasInlineValue) {
    const inlineAlias = NODE_INLINE_OPTION_ALIASES.get(`${name}=`)
    if (inlineAlias) {
      return {
        role: NODE_OPTION_ROLES.get(inlineAlias[0]!) ?? 'boolean',
        names: [name, ...inlineAlias],
      }
    }
  }

  const alias = NODE_OPTION_ALIASES.get(name)
  if (alias) {
    return {
      role: NODE_OPTION_ROLES.get(alias[0]!) ?? 'boolean',
      names: [name, ...alias],
    }
  }

  return { role: NODE_OPTION_ROLES.get(name) ?? 'boolean', names: [name] }
}

/**
 * Parse NODE_OPTIONS into the options Node would accept.
 *
 * The result is either a valid option list or `valid: false` for the inputs
 * Node rejects outright: malformed quoting, a missing or invalid required
 * value, the negation of a non-boolean option, or `--`.
 */
function parseNodeOptions(nodeOptions: string): NodeOptionsParse {
  const tokens = tokenizeNodeOptions(nodeOptions)
  if (!tokens) {
    return { valid: false, options: [] }
  }

  const options: NodeOptionOccurrence[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1

    // Node stops parsing options at the first argument that is not an option
    // (src/node_options.cc: `if (args.first().size() <= 1 ||
    // args.first()[0] != '-') break;`), so everything from there on is
    // ignored — including options that would otherwise be seen.
    if (token.length <= 1 || token[0] !== '-') {
      break
    }

    // `--` is not allowed in NODE_OPTIONS.
    if (token === '--') {
      return { valid: false, options: [] }
    }

    // Only `--name=value` uses `=` as a separator.
    const equalsIndex = token.startsWith('--') ? token.indexOf('=') : -1
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex)
    const inlineValue =
      equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1)

    // Node converts `--no-foo` to `--foo` and remembers the negation.
    let optionName = name
    let negated = false
    if (optionName.startsWith('--no-')) {
      optionName = `--${optionName.slice('--no-'.length)}`
      negated = true
    }

    const { role, names } = resolveNodeOption(optionName, equalsIndex !== -1)

    // Node rejects the negation of any option that is not a boolean.
    if (negated && role !== 'boolean') {
      return { valid: false, options: [] }
    }

    switch (role) {
      case 'boolean':
        break
      case 'value': {
        if (inlineValue !== undefined) {
          // An empty inline value is rejected by Node
          // (`--title= requires an argument`).
          if (inlineValue === '') {
            return { valid: false, options: [] }
          }
          break
        }
        // The value is the next argument. Node rejects it when it is missing
        // or when it looks like another option (`--title --use-system-ca`).
        const next = tokens[index]
        if (next === undefined || next.startsWith('-')) {
          return { valid: false, options: [] }
        }
        index += 1
        break
      }
      case 'inline-value': {
        // V8-owned flags must carry their value inline. V8 accepts an empty
        // inline value (it warns but starts) and rejects a bare flag.
        if (inlineValue === undefined) {
          return { valid: false, options: [] }
        }
        break
      }
      case 'inline-required': {
        if (inlineValue === undefined || inlineValue === '') {
          return { valid: false, options: [] }
        }
        break
      }
    }

    // An alias can expand to an option that is already part of the expansion
    // (`--inspect=` expands to `--inspect-port` and `--inspect`); record each
    // option once per token so repeated tokens keep their own occurrence.
    const recorded = new Set<string>()
    for (const occurrenceName of names) {
      if (recorded.has(occurrenceName)) {
        continue
      }
      recorded.add(occurrenceName)
      options.push({ name: occurrenceName, negated })
    }
  }

  return { valid: true, options }
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 *
 * Mirrors Node's `ParseNodeOptionsEnvVar` and `OptionsParser::Parse`
 * (src/node_options.cc) closely enough to answer what the CA and telemetry
 * callers ask: "would Node have enabled this option?".
 *
 * - double quotes toggle `is_in_string` and are stripped
 * - a backslash escapes the next character, but only inside a string
 * - only ASCII spaces outside strings delimit arguments (tabs are literal);
 *   single quotes are literal
 * - `--flag=value` is supported and `--flag` never matches `--flag-other`
 * - value-taking options own their value, so `--conditions "--use-system-ca"`
 *   does not enable `--use-system-ca`; `--experimental-import-meta-resolve`
 *   is a boolean and never consumes the following argument
 * - Node stops parsing options at the first argument that is not an option,
 *   so options after it are ignored
 * - malformed quoting, a missing or invalid required value, the negation of a
 *   non-boolean option, and `--` make Node reject the whole NODE_OPTIONS
 *   value; the helper then fails closed and reports no option as active
 * - boolean options are applied in order, so a later `--no-<flag>` disables
 *   an earlier `--<flag>` and vice versa
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }

  // This helper can also run after bootstrap (settings re-applies
  // NODE_OPTIONS, clears CA/proxy/mTLS caches, rebuilds agents), so an
  // invalid option string must never be read as "the flag is enabled".
  const parsed = parseNodeOptions(nodeOptions)
  if (!parsed.valid) {
    return false
  }

  // Node applies boolean options in order, so the last occurrence wins.
  // A query for the negated spelling (`--no-<flag>`) asks whether the
  // negation is the effective state, which requires the option to be present.
  const negatedQuery = flag.startsWith('--no-')
  const optionName = negatedQuery ? `--${flag.slice('--no-'.length)}` : flag
  let enabled = false
  let seen = false
  for (const option of parsed.options) {
    if (option.name === optionName) {
      enabled = !option.negated
      seen = true
    }
  }
  return negatedQuery ? seen && !enabled : enabled
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
