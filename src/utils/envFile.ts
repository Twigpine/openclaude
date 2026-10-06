import { readFileSync } from 'node:fs'

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const ALLOWED_ENV_FILE_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ATLAS_CLOUD_API_KEY',
  'APISMART_API_KEY',
  'APISMART_MODEL',
  'API_ROUTE_API_KEY',
  'API_ROUTE_MODEL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'BANKR_BASE_URL',
  'BANKR_MODEL',
  'BING_API_KEY',
  'BNKR_API_KEY',
  'BRAVE_API_KEY',
  'CHATGPT_ACCOUNT_ID',
  'CLAUDE_CODE_DEFAULT_STARTUP_PROVIDER',
  'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
  'CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW',
  'CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'CLOUD_ML_REGION',
  'CODEX_ACCOUNT_ID',
  'CODEX_API_KEY',
  'CODEX_AUTH_JSON_PATH',
  'CODEX_CREDENTIAL_SOURCE',
  'CODEX_HOME',
  'CONCENTRATE_API_KEY',
  'CONCENTRATE_BASE_URL',
  'CONCENTRATE_MODEL',
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'EXA_API_KEY',
  'EXA_FREE_TIER',
  'EXA_NUM_RESULTS',
  'EXA_SEARCH_TYPE',
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_URL',
  'FIREWORKS_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_API_KEY',
  'GEMINI_AUTH_MODE',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GH_TOKEN',
  'GITHUB_COPILOT_ALLOW_SUBAGENTS',
  'GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS',
  'GITHUB_COPILOT_MAX_SUBAGENTS',
  'GITHUB_COPILOT_OPTIMIZATION_DISABLED',
  'GITHUB_TOKEN',
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CSE_ID',
  'GROQ_API_KEY',
  'HICAP_API_KEY',
  'JINA_API_KEY',
  'KIMI_API_KEY',
  'LINKUP_API_KEY',
  'LLMTR_API_KEY',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'LONGCAT_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'MINIMAX_MODEL',
  'MIMO_API_KEY',
  'MISTRAL_API_KEY',
  'MISTRAL_BASE_URL',
  'MISTRAL_MODEL',
  'MOJEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'NEARAI_API_KEY',
  'NVIDIA_API_KEY',
  'NVIDIA_MODEL',
  'NVIDIA_NIM',
  'OPENCODE_API_KEY',
  'OPENGATEWAY_API_KEY',
  'OPENGATEWAY_BASE_URL',
  'OPENCLAUDE_OLLAMA_NUM_CTX',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENAI_API_BASE',
  'OPENAI_API_FORMAT',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AZURE_STYLE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'TAVILY_API_KEY',
  'TOGETHER_API_KEY',
  'VENICE_API_KEY',
  'WEB_AUTH_HEADER',
  'WEB_AUTH_SCHEME',
  'WEB_BODY_TEMPLATE',
  'WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS',
  'WEB_CUSTOM_ALLOW_HTTP',
  'WEB_CUSTOM_ALLOW_PRIVATE',
  'WEB_CUSTOM_MAX_BODY_KB',
  'WEB_CUSTOM_TIMEOUT_SEC',
  'WEB_HEADERS',
  'WEB_JSON_PATH',
  'WEB_KEY',
  'WEB_METHOD',
  'WEB_PARAMS',
  'WEB_PROVIDER',
  'WEB_QUERY_PARAM',
  'WEB_SEARCH_API',
  'WEB_SEARCH_PROVIDER',
  'WEB_SEARCH_TIMEOUT_SEC',
  'WEB_URL_TEMPLATE',
  'XAI_API_KEY',
  'XAI_CREDENTIAL_SOURCE',
  'YOU_API_KEY',
])

const ALLOWED_ENV_FILE_PREFIXES = [
  'VERTEX_REGION_CLAUDE_',
]

let rememberedEnvFileValues: Record<string, string> | null = null

/**
 * Returns true when an env key is explicitly safe for provider setup files.
 */
function isAllowedEnvFileKey(key: string): boolean {
  return (
    ALLOWED_ENV_FILE_KEYS.has(key) ||
    ALLOWED_ENV_FILE_PREFIXES.some(prefix => key.startsWith(prefix))
  )
}

/**
 * Checks whether a quote is escaped by an odd-length backslash run.
 */
function isEscapedQuote(value: string, quoteIdx: number): boolean {
  let backslashCount = 0
  for (let i = quoteIdx - 1; i >= 0 && value[i] === '\\'; i--) {
    backslashCount++
  }
  return backslashCount % 2 === 1
}

/**
 * Finds the next matching quote that is not escaped.
 */
function findClosingQuote(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === quote && !isEscapedQuote(value, i)) {
      return i
    }
  }
  return -1
}

/**
 * Unescapes the active quote delimiter in a quoted env value.
 *
 * findClosingQuote/isEscapedQuote treat the value as backslash-escaped: an
 * odd-length backslash run escapes the following quote, so `\\` is already
 * consumed as a single escaped backslash when locating the closing quote.
 * Collapse `\\` to `\` here too, otherwise the two stages disagree and a
 * value like "a\\b" round-trips to the doubled "a\\b" instead of "a\b".
 */
function unescapeQuotedValue(raw: string, quote: string): string {
  let result = ''

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && (raw[i + 1] === quote || raw[i + 1] === '\\')) {
      result += raw[i + 1]
      i++
      continue
    }
    result += raw[i]
  }

  return result
}

/**
 * Parses an individual env value, handling simple quoted values and comments.
 */
function parseEnvValue(value: string, lineNumber: number): string {
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const commentIdx = value.indexOf(' #')
    return commentIdx === -1 ? value : value.substring(0, commentIdx).trim()
  }

  const quote = value[0]!
  const closingQuoteIdx = findClosingQuote(value, quote)
  if (closingQuoteIdx === -1) {
    throw new Error(`Invalid line ${lineNumber}: unterminated quoted value`)
  }

  const trailing = value.slice(closingQuoteIdx + 1).trim()
  if (trailing && !trailing.startsWith('#')) {
    throw new Error(`Invalid line ${lineNumber}: unexpected content after quoted value`)
  }

  return unescapeQuotedValue(value.slice(1, closingQuoteIdx), quote)
}

/**
 * Parses a simple .env file content.
 * Supports:
 * - KEY=VALUE
 * - KEY="VALUE"
 * - KEY='VALUE'
 * - export KEY=VALUE
 * - Ignores comments (#) and empty lines
 *
 * It does NOT support advanced features like variable expansion ($VAR).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = content.split(/\r?\n/)

  for (const [lineIdx, line] of lines.entries()) {
    const lineNumber = lineIdx + 1
    const trimmed = line.trim()
    // Ignore empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    // Strip optional "export " prefix
    const expression = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed

    const equalsIdx = expression.indexOf('=')
    if (equalsIdx === -1) {
      throw new Error(`Invalid line ${lineNumber}: expected KEY=VALUE`)
    }

    const key = expression.slice(0, equalsIdx).trim()
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid variable name on line ${lineNumber}`)
    }

    result[key] = parseEnvValue(
      expression.slice(equalsIdx + 1).trim(),
      lineNumber,
    )
  }

  return result
}

/**
 * Extracts repeatable --provider-env-file paths from raw CLI arguments.
 */
export function parseProviderEnvFileArgs(args: string[]): {
  paths: string[]
  error?: string
} {
  const paths: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      break
    }

    if (arg === '--provider-env-file') {
      const nextArg = args[i + 1]
      if (!nextArg || nextArg.startsWith('-') || !nextArg.trim()) {
        return {
          paths: [],
          error: 'Error: --provider-env-file requires a path',
        }
      }
      paths.push(nextArg.trim())
      i++
    } else if (arg.startsWith('--provider-env-file=')) {
      const filePath = arg.slice('--provider-env-file='.length).trim()
      if (!filePath) {
        return {
          paths: [],
          error: 'Error: --provider-env-file requires a path',
        }
      }
      paths.push(filePath)
    }
  }

  return { paths }
}

/**
 * Reapplies values that were explicitly loaded from --provider-env-file.
 */
export function applyLoadedEnvFileValues(
  values: Record<string, string>,
  targetEnv: NodeJS.ProcessEnv = process.env,
): void {
  Object.assign(targetEnv, values)
}

/**
 * Remembers values that were explicitly loaded from --provider-env-file.
 */
export function rememberLoadedEnvFileValues(
  values: Record<string, string>,
): void {
  if (Object.keys(values).length === 0) {
    return
  }
  rememberedEnvFileValues ??= {}
  Object.assign(rememberedEnvFileValues, values)
}

/**
 * Reapplies remembered --provider-env-file values after settings/profile env merges.
 */
export function reapplyRememberedEnvFileValues(
  targetEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (!rememberedEnvFileValues) {
    return
  }
  applyLoadedEnvFileValues(rememberedEnvFileValues, targetEnv)
}

export function clearRememberedEnvFileValuesForTests(): void {
  rememberedEnvFileValues = null
}

/**
 * Loads an environment file into process.env.
 * Existing process.env variables take precedence over the file's variables.
 * Returns only the values applied from the file so explicit CLI inputs can be
 * restored after later settings/profile env merges.
 */
export function loadEnvFile(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const parsed = parseEnvFile(content)

    for (const key of Object.keys(parsed)) {
      if (!isAllowedEnvFileKey(key)) {
        throw new Error(`Unsupported variable ${key} in --provider-env-file`)
      }
    }

    const loaded: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value
        loaded[key] = value
      }
    }
    return loaded
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load --provider-env-file at ${filePath}: ${message}`)
  }
}
