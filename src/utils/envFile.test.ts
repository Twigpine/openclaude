import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyLoadedEnvFileValues,
  clearRememberedEnvFileValuesForTests,
  loadEnvFile,
  parseEnvFile,
  parseProviderEnvFileArgs,
  reapplyRememberedEnvFileValues,
  rememberLoadedEnvFileValues,
} from './envFile.js'
import { PROVIDER_SELECTION_FLAGS } from './providerSelectionFlags.js'

const TEST_ENV_KEYS = [
  'NODE_OPTIONS',
  'AZURE_OPENAI_API_VERSION',
  'CLAUDE_CODE_USE_OPENAI',
  'CODEX_AUTH_JSON_PATH',
  'CODEX_HOME',
  'LLMTR_API_KEY',
  'MERGE_GATEWAY_API_KEY',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'CONCENTRATE_API_KEY',
  'CONCENTRATE_BASE_URL',
  'CONCENTRATE_MODEL',
  'APISMART_API_KEY',
  'APISMART_MODEL',
  'API_ROUTE_API_KEY',
  'API_ROUTE_MODEL',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'OPENAI_AZURE_STYLE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENCLAUDE_OLLAMA_NUM_CTX',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  ...PROVIDER_SELECTION_FLAGS,
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_VERTEX_PROJECT',
  'GEMINI_VERTEX_LOCATION',
  'GEMINI_VERTEX_MODEL',
  'GEMINI_VERTEX_AUTH_MODE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_PROJECT_ID',
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
]

const originalEnv = new Map<string, string | undefined>()
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-env-file-test-'))
  for (const key of TEST_ENV_KEYS) {
    originalEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  clearRememberedEnvFileValuesForTests()
  rmSync(tempDir, { recursive: true, force: true })
  for (const key of TEST_ENV_KEYS) {
    const originalValue = originalEnv.get(key)
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
  originalEnv.clear()
})

function writeTempEnvFile(content: string, fileName = '.env'): string {
  const filePath = join(tempDir, fileName)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('envFile parser', () => {
  it('parses basic KEY=VALUE', () => {
    const result = parseEnvFile('FOO=bar\nBAZ=qux')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('handles quotes', () => {
    const result = parseEnvFile('FOO="bar"\nBAZ=\'qux\'')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('handles export prefix', () => {
    const result = parseEnvFile('export FOO=bar\nexport BAZ="qux"')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('ignores comments and empty lines', () => {
    const content = `
# This is a comment
FOO=bar

# Another comment
BAZ=qux
`
    const result = parseEnvFile(content)
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('rejects invalid lines', () => {
    expect(() => parseEnvFile('FOO=bar\ninvalid_line\nBAZ=qux')).toThrow(
      'Invalid line 2: expected KEY=VALUE',
    )
  })

  it('rejects invalid variable names', () => {
    expect(() => parseEnvFile('BAD KEY=value')).toThrow(
      'Invalid variable name on line 1',
    )
  })

  it('preserves inner equals signs', () => {
    const result = parseEnvFile('FOO=bar=baz')
    expect(result).toEqual({ FOO: 'bar=baz' })
  })

  it('uses the last value when a key appears multiple times', () => {
    const result = parseEnvFile('FOO=first\nFOO=second')
    expect(result).toEqual({ FOO: 'second' })
  })

  it('trims whitespace', () => {
    const result = parseEnvFile('  FOO = bar  ')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('handles empty values', () => {
    const result = parseEnvFile('FOO=\nBAZ=""')
    expect(result).toEqual({ FOO: '', BAZ: '' })
  })

  it('handles values with spaces inside quotes', () => {
    const result = parseEnvFile('FOO=" bar "\nBAZ=\' qux \'')
    expect(result).toEqual({ FOO: ' bar ', BAZ: ' qux ' })
  })

  it('handles escaped quote characters inside quoted values', () => {
    const result = parseEnvFile([
      'FOO="{\\"k\\":\\"v\\"}"',
      "BAZ='it\\'s ok'",
    ].join('\n'))

    expect(result).toEqual({
      FOO: '{"k":"v"}',
      BAZ: "it's ok",
    })
  })

  it('collapses escaped backslashes inside quoted values', () => {
    // The value content is C:\\Users\\me — escaped backslashes that the
    // closing-quote scanner already treats as single backslashes, so the
    // unescaper must collapse them too.
    const result = parseEnvFile('FOO="C:\\\\Users\\\\me"')
    expect(result).toEqual({ FOO: 'C:\\Users\\me' })
  })

  it('keeps lone backslashes in quoted values intact', () => {
    // A single backslash before an ordinary character is not an escape and
    // must survive verbatim (e.g. a Windows path written without doubling).
    const result = parseEnvFile('FOO="C:\\Users\\me"')
    expect(result).toEqual({ FOO: 'C:\\Users\\me' })
  })

  it('collapses an escaped backslash adjacent to the closing quote', () => {
    // The value content is a\\ — the escaped backslash sits right before the
    // terminator, the trickiest interaction between findClosingQuote (which
    // counts the even backslash run and keeps scanning) and unescapeQuotedValue
    // (which must collapse the pair to one trailing backslash).
    const result = parseEnvFile('FOO="a\\\\"')
    expect(result).toEqual({ FOO: 'a\\' })
  })

  it('strips inline comments from unquoted values', () => {
    const result = parseEnvFile('FOO=bar # comment\nBAZ=qux')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('preserves hash signs inside unquoted strings if not preceded by space', () => {
    const result = parseEnvFile('FOO=bar#comment')
    expect(result).toEqual({ FOO: 'bar#comment' })
  })

  it('preserves inline comments in quoted values', () => {
    const result = parseEnvFile('FOO="bar # comment"')
    expect(result).toEqual({ FOO: 'bar # comment' })
  })

  it('strips trailing comments after quoted values', () => {
    const result = parseEnvFile('FOO="bar" # comment')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('handles Windows line endings', () => {
    const result = parseEnvFile('FOO=bar\r\nBAZ=qux')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })
})

describe('loadEnvFile', () => {
  it('loads variables without overwriting existing process environment', () => {
    process.env.OPENAI_API_KEY = 'from-shell'
    const filePath = writeTempEnvFile([
      'OPENAI_MODEL=from-file',
      'OPENAI_API_KEY=from-file',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(process.env.OPENAI_API_KEY).toBe('from-shell')
    expect(process.env.OPENAI_MODEL).toBe('from-file')
    expect(loaded).toEqual({ OPENAI_MODEL: 'from-file' })
  })

  it('returns loaded values that can be restored after later settings mutations', () => {
    const filePath = writeTempEnvFile([
      'OPENAI_BASE_URL=https://file.example/v1',
      'OPENAI_MODEL=from-file',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)
    process.env.OPENAI_BASE_URL = 'https://settings.example/v1'
    process.env.OPENAI_MODEL = 'from-settings'

    applyLoadedEnvFileValues(loaded)

    expect(process.env.OPENAI_BASE_URL).toBe('https://file.example/v1')
    expect(process.env.OPENAI_MODEL).toBe('from-file')
  })

  it('reapplies remembered loaded values after later settings mutations', () => {
    const filePath = writeTempEnvFile([
      'OPENAI_BASE_URL=https://file.example/v1',
      'OPENAI_MODEL=from-file',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)
    rememberLoadedEnvFileValues(loaded)
    process.env.OPENAI_BASE_URL = 'https://settings.example/v1'
    process.env.OPENAI_MODEL = 'from-settings'

    reapplyRememberedEnvFileValues()

    expect(process.env.OPENAI_BASE_URL).toBe('https://file.example/v1')
    expect(process.env.OPENAI_MODEL).toBe('from-file')
  })

  it('loads and reapplies OpenAI credential pools from provider env files', () => {
    const filePath = writeTempEnvFile([
      'CLAUDE_CODE_USE_OPENAI=1',
      'OPENAI_BASE_URL=https://api.openai.com/v1',
      'OPENAI_MODEL=gpt-4o',
      'OPENAI_API_KEYS=key-a,key-b',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)
    rememberLoadedEnvFileValues(loaded)
    process.env.OPENAI_API_KEYS = 'settings-key'

    reapplyRememberedEnvFileValues()

    expect(process.env.OPENAI_API_KEYS).toBe('key-a,key-b')
    expect(loaded).toEqual({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEYS: 'key-a,key-b',
    })
  })

  it('loads documented ApiSmart env-only provider setup values', () => {
    const filePath = writeTempEnvFile([
      'APISMART_API_KEY=apismart-key',
      'APISMART_MODEL=KIMI_K3',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(process.env.APISMART_API_KEY).toBe('apismart-key')
    expect(process.env.APISMART_MODEL).toBe('KIMI_K3')
    expect(loaded).toEqual({
      APISMART_API_KEY: 'apismart-key',
      APISMART_MODEL: 'KIMI_K3',
    })
  })

  it('loads documented API Route env-only provider setup values', () => {
    const filePath = writeTempEnvFile([
      'API_ROUTE_API_KEY=api-route-key',
      'API_ROUTE_MODEL=claude-sonnet-4-6',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(process.env.API_ROUTE_API_KEY).toBe('api-route-key')
    expect(process.env.API_ROUTE_MODEL).toBe('claude-sonnet-4-6')
    expect(loaded).toEqual({
      API_ROUTE_API_KEY: 'api-route-key',
      API_ROUTE_MODEL: 'claude-sonnet-4-6',
    })
  })

  it('preserves existing API Route env values over provider env-file values', () => {
    process.env.API_ROUTE_API_KEY = 'shell-api-route-key'
    process.env.API_ROUTE_MODEL = 'shell-api-route-model'
    const filePath = writeTempEnvFile([
      'API_ROUTE_API_KEY=file-api-route-key',
      'API_ROUTE_MODEL=file-api-route-model',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(process.env.API_ROUTE_API_KEY).toBe('shell-api-route-key')
    expect(process.env.API_ROUTE_MODEL).toBe('shell-api-route-model')
    expect(loaded).toEqual({})
  })

  it('rejects API Route env files atomically when any variable is unsupported', () => {
    const filePath = writeTempEnvFile([
      'API_ROUTE_API_KEY=api-route-key',
      'UNSAFE_API_ROUTE_SETTING=blocked',
    ].join('\n'))

    expect(() => loadEnvFile(filePath)).toThrow(
      'Unsupported variable UNSAFE_API_ROUTE_SETTING in --provider-env-file',
    )
    expect(process.env.API_ROUTE_API_KEY).toBeUndefined()
  })

  it('loads a usable Merge credential with shell precedence and remembered replay', async () => {
    const { getProviderValidationError } = await import('./providerValidation.js')
    const filePath = writeTempEnvFile('MERGE_GATEWAY_API_KEY=file-merge-key')
    const loaded = loadEnvFile(filePath)
    expect(loaded).toEqual({ MERGE_GATEWAY_API_KEY: 'file-merge-key' })
    const validateMerge = () => getProviderValidationError({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api-gateway.merge.dev/v1/openai',
      OPENAI_MODEL: 'openai/gpt-5.5',
      MERGE_GATEWAY_API_KEY: process.env.MERGE_GATEWAY_API_KEY,
    })
    expect(await validateMerge()).toBeNull()

    rememberLoadedEnvFileValues(loaded)
    delete process.env.MERGE_GATEWAY_API_KEY
    expect(await validateMerge()).toContain('MERGE_GATEWAY_API_KEY')
    reapplyRememberedEnvFileValues()
    expect<string | undefined>(process.env.MERGE_GATEWAY_API_KEY).toBe('file-merge-key')
    expect(await validateMerge()).toBeNull()

    process.env.MERGE_GATEWAY_API_KEY = 'shell-merge-key'
    expect(loadEnvFile(filePath)).toEqual({})
    expect(process.env.MERGE_GATEWAY_API_KEY).toBe('shell-merge-key')
  })

  it('loads the dedicated LLMTR credential without selecting a route', () => {
    const filePath = writeTempEnvFile('LLMTR_API_KEY=llmtr-key')

    const loaded = loadEnvFile(filePath)

    expect(process.env.LLMTR_API_KEY).toBe('llmtr-key')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(loaded).toEqual({ LLMTR_API_KEY: 'llmtr-key' })
  })

  it('loads the dedicated Command Code credential without selecting a route', () => {
    const filePath = writeTempEnvFile('CMD_API_KEY=cmd-key')

    const loaded = loadEnvFile(filePath)

    expect(process.env.CMD_API_KEY).toBe('cmd-key')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(loaded).toEqual({ CMD_API_KEY: 'cmd-key' })
  })

  it('loads the official Command Code credential without selecting a route', () => {
    const filePath = writeTempEnvFile(
      'COMMAND_CODE_API_KEY=official-command-code-key',
    )

    const loaded = loadEnvFile(filePath)

    expect(process.env.COMMAND_CODE_API_KEY).toBe('official-command-code-key')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(loaded).toEqual({
      COMMAND_CODE_API_KEY: 'official-command-code-key',
    })
  })

  it('loads documented Concentrate env-only provider setup values', () => {
    const filePath = writeTempEnvFile([
      'CONCENTRATE_API_KEY=concentrate-key',
      'CONCENTRATE_BASE_URL=https://api.concentrate.ai/v1',
      'CONCENTRATE_MODEL=claude-sonnet-5',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(process.env.CONCENTRATE_API_KEY).toBe('concentrate-key')
    expect(process.env.CONCENTRATE_BASE_URL).toBe('https://api.concentrate.ai/v1')
    expect(process.env.CONCENTRATE_MODEL).toBe('claude-sonnet-5')
    expect(loaded).toEqual({
      CONCENTRATE_API_KEY: 'concentrate-key',
      CONCENTRATE_BASE_URL: 'https://api.concentrate.ai/v1',
      CONCENTRATE_MODEL: 'claude-sonnet-5',
    })
  })

  it('loads documented Azure OpenAI API version values', () => {
    const filePath = writeTempEnvFile(
      'AZURE_OPENAI_API_VERSION=2024-12-01-preview',
    )

    const loaded = loadEnvFile(filePath)

    expect(process.env.AZURE_OPENAI_API_VERSION).toBe('2024-12-01-preview')
    expect(loaded).toEqual({
      AZURE_OPENAI_API_VERSION: '2024-12-01-preview',
    })
  })

  it('loads documented Azure-style handling flag values', () => {
    const filePath = writeTempEnvFile('OPENAI_AZURE_STYLE=1')

    const loaded = loadEnvFile(filePath)

    expect(process.env.OPENAI_AZURE_STYLE).toBe('1')
    expect(loaded).toEqual({
      OPENAI_AZURE_STYLE: '1',
    })
  })

  it('loads documented Ollama request context window values', () => {
    const filePath = writeTempEnvFile('OPENCLAUDE_OLLAMA_NUM_CTX=32768')

    const loaded = loadEnvFile(filePath)

    expect(process.env.OPENCLAUDE_OLLAMA_NUM_CTX).toBe('32768')
    expect(loaded).toEqual({
      OPENCLAUDE_OLLAMA_NUM_CTX: '32768',
    })
  })

  it('loads documented Ollama web search values', () => {
    const filePath = writeTempEnvFile([
      'OLLAMA_API_KEY=ollama-key',
      'OLLAMA_BASE_URL=http://localhost:11434',
      'WEB_SEARCH_PROVIDER=ollama',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(loaded).toEqual({
      OLLAMA_API_KEY: 'ollama-key',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      WEB_SEARCH_PROVIDER: 'ollama',
    })
  })

  it('loads documented custom web search and Codex auth-file setup values', () => {
    const filePath = writeTempEnvFile([
      'WEB_SEARCH_PROVIDER=custom',
      'WEB_PROVIDER=searxng',
      'WEB_KEY=web-key',
      'WEB_SEARCH_API=https://search.example.com/search',
      'WEB_QUERY_PARAM=query',
      'WEB_METHOD=POST',
      'WEB_PARAMS={"lang":"en","count":"10"}',
      'WEB_URL_TEMPLATE=https://api.example.com/v2/search/{query}',
      'WEB_BODY_TEMPLATE={"input":{"text":"{query}"}}',
      'WEB_AUTH_HEADER=X-Api-Key',
      'WEB_AUTH_SCHEME=',
      'WEB_HEADERS=Accept: application/json; X-Tenant: acme',
      'WEB_JSON_PATH=response.payload.results',
      'WEB_SEARCH_TIMEOUT_SEC=30',
      'WEB_CUSTOM_TIMEOUT_SEC=15',
      'WEB_CUSTOM_MAX_BODY_KB=300',
      'WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS=true',
      'WEB_CUSTOM_ALLOW_HTTP=true',
      'WEB_CUSTOM_ALLOW_PRIVATE=true',
      'CODEX_AUTH_JSON_PATH=/tmp/codex-auth.json',
      'CODEX_HOME=/tmp/codex',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(loaded).toEqual({
      WEB_SEARCH_PROVIDER: 'custom',
      WEB_PROVIDER: 'searxng',
      WEB_KEY: 'web-key',
      WEB_SEARCH_API: 'https://search.example.com/search',
      WEB_QUERY_PARAM: 'query',
      WEB_METHOD: 'POST',
      WEB_PARAMS: '{"lang":"en","count":"10"}',
      WEB_URL_TEMPLATE: 'https://api.example.com/v2/search/{query}',
      WEB_BODY_TEMPLATE: '{"input":{"text":"{query}"}}',
      WEB_AUTH_HEADER: 'X-Api-Key',
      WEB_AUTH_SCHEME: '',
      WEB_HEADERS: 'Accept: application/json; X-Tenant: acme',
      WEB_JSON_PATH: 'response.payload.results',
      WEB_SEARCH_TIMEOUT_SEC: '30',
      WEB_CUSTOM_TIMEOUT_SEC: '15',
      WEB_CUSTOM_MAX_BODY_KB: '300',
      WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS: 'true',
      WEB_CUSTOM_ALLOW_HTTP: 'true',
      WEB_CUSTOM_ALLOW_PRIVATE: 'true',
      CODEX_AUTH_JSON_PATH: '/tmp/codex-auth.json',
      CODEX_HOME: '/tmp/codex',
    })
    expect(process.env.WEB_SEARCH_API).toBe('https://search.example.com/search')
    expect(process.env.WEB_SEARCH_TIMEOUT_SEC).toBe('30')
    expect(process.env.CODEX_AUTH_JSON_PATH).toBe('/tmp/codex-auth.json')
  })

  it('accepts every registered provider-selection flag', () => {
    // Guards against a new CLAUDE_CODE_USE_* flag (like Gemini Vertex) being
    // added to PROVIDER_SELECTION_FLAGS but silently rejected by the env-file
    // allowlist, which would break --provider-env-file end-to-end wiring.
    const filePath = writeTempEnvFile(
      PROVIDER_SELECTION_FLAGS.map(flag => `${flag}=1`).join('\n'),
    )

    const loaded = loadEnvFile(filePath)

    for (const flag of PROVIDER_SELECTION_FLAGS) {
      expect(loaded[flag]).toBe('1')
      expect(process.env[flag]).toBe('1')
    }
  })

  it('loads the documented Gemini Vertex provider setup', () => {
    const filePath = writeTempEnvFile([
      'CLAUDE_CODE_USE_GEMINI_VERTEX=1',
      'GEMINI_VERTEX_PROJECT=my-project',
      'GEMINI_VERTEX_LOCATION=us-central1',
      'GEMINI_VERTEX_MODEL=gemini-2.0-flash',
      'GEMINI_VERTEX_AUTH_MODE=adc',
      'GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json',
      'GCLOUD_PROJECT=my-project',
      'GOOGLE_PROJECT_ID=my-project',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    expect(loaded).toEqual({
      CLAUDE_CODE_USE_GEMINI_VERTEX: '1',
      GEMINI_VERTEX_PROJECT: 'my-project',
      GEMINI_VERTEX_LOCATION: 'us-central1',
      GEMINI_VERTEX_MODEL: 'gemini-2.0-flash',
      GEMINI_VERTEX_AUTH_MODE: 'adc',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json',
      GCLOUD_PROJECT: 'my-project',
      GOOGLE_PROJECT_ID: 'my-project',
    })
    expect(process.env.CLAUDE_CODE_USE_GEMINI_VERTEX).toBe('1')
  })

  it('rejects unsupported variables before mutating process environment', () => {
    const filePath = writeTempEnvFile([
      'OPENAI_MODEL=from-file',
      'NODE_OPTIONS=--require ./malicious.js',
    ].join('\n'))

    expect(() => loadEnvFile(filePath)).toThrow(
      'Unsupported variable NODE_OPTIONS in --provider-env-file',
    )
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.NODE_OPTIONS).toBeUndefined()
  })

  it('rejects lowercase spellings of supported variables', () => {
    const filePath = writeTempEnvFile('openai_model=from-file')

    expect(() => loadEnvFile(filePath)).toThrow(
      'Unsupported variable openai_model in --provider-env-file',
    )
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })

  it('keeps earlier file values when multiple files define the same key', () => {
    const firstFilePath = writeTempEnvFile('OPENAI_MODEL=first', '.env')
    const secondFilePath = writeTempEnvFile('OPENAI_MODEL=second', '.env.local')

    loadEnvFile(firstFilePath)
    loadEnvFile(secondFilePath)

    expect(process.env.OPENAI_MODEL).toBe('first')
  })

  it('wraps file read errors with env-file context', () => {
    const filePath = join(tempDir, 'missing.env')

    let message = ''
    try {
      loadEnvFile(filePath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain(`Failed to load --provider-env-file at ${filePath}:`)
  })

  it('wraps parse errors without exposing secret values from the file', () => {
    const filePath = writeTempEnvFile([
      'OPENAI_API_KEY=super-secret-value',
      'invalid_line',
    ].join('\n'))

    let message = ''
    try {
      loadEnvFile(filePath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain(`Failed to load --provider-env-file at ${filePath}:`)
    expect(message).toContain('Invalid line 2: expected KEY=VALUE')
    expect(message).not.toContain('super-secret-value')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe('parseProviderEnvFileArgs', () => {
  it('extracts repeatable provider env-file paths', () => {
    const result = parseProviderEnvFileArgs([
      '--provider-env-file',
      '.env',
      '--provider-env-file=.env.local',
    ])

    expect(result).toEqual({ paths: ['.env', '.env.local'] })
  })

  it('returns an error when the flag has no path', () => {
    const result = parseProviderEnvFileArgs(['--provider-env-file'])

    expect(result).toEqual({
      paths: [],
      error: 'Error: --provider-env-file requires a path',
    })
  })

  it('does not parse provider env-file flags after end-of-options marker', () => {
    const result = parseProviderEnvFileArgs([
      '--',
      '--provider-env-file',
      '.env',
    ])

    expect(result).toEqual({ paths: [] })
  })
})
