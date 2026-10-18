import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const actualSettings = await import('../utils/settings/settings.js')
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

beforeAll(async () => {
  await acquireSharedMutationLock('StartupScreen.test.ts')
  mock.module('../utils/settings/settings.js', () => ({
    ...actualSettings,
    getSettings_DEPRECATED: () => ({}),
  }))
})

afterAll(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

import { stripVTControlCharacters as stripAnsi } from 'node:util'
import { detectProvider, printStartupScreen } from './StartupScreen.js'
import {
  type GlobalConfig,
  getGlobalConfig,
  saveGlobalConfig,
} from '../utils/config.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../utils/settings/settingsCache.js'

const ENV_KEYS = [
  'CI',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_MISTRAL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'GEMINI_MODEL',
  'MISTRAL_MODEL',
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'NVIDIA_NIM',
  'MINIMAX_API_KEY',
  'XAI_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
]

const originalEnv: Record<string, string | undefined> = {}
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const originalIsTTY = process.stdout.isTTY
const originalWrite = process.stdout.write
const originalColumns = process.stdout.columns
// `model` is a legacy loose key not declared on GlobalConfig.
const originalModel = (getGlobalConfig() as GlobalConfig & Record<string, unknown>).model

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
  setSessionSettingsCache({ settings: {}, errors: [] })
  saveGlobalConfig(current => ({
    ...current,
    model: undefined,
  }))
})

afterEach(() => {
  resetSettingsCache()
  saveGlobalConfig(current => ({
    ...current,
    model: originalModel,
  }))
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: originalIsTTY,
  })
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: originalColumns,
  })
  process.stdout.write = originalWrite
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

function setupOpenAIMode(baseUrl: string, model: string): void {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = baseUrl
  process.env.OPENAI_MODEL = model
  process.env.OPENAI_API_KEY = 'test-key'
}

describe('printStartupScreen logo', () => {
  test('renders CLAUDE with a D-shaped D instead of an O-shaped block', () => {
    ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    })

    let output = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString()
      return true
    }) as typeof process.stdout.write

    printStartupScreen()

    const plainOutput = stripAnsi(output)
    expect(plainOutput).toContain('██████╗  ███████╗')
    expect(plainOutput).toContain('██║  ██║ █████╗')
    expect(plainOutput).toContain('██████╔╝ ███████╗')
    expect(plainOutput).not.toContain('██║   ██║ █████╗')
  })
})

// --- Logo layout: one centered row on wide terminals, stacked fallback ---

function renderStartupScreen(columns: number): string {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: true,
  })
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: columns,
  })

  let output = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString()
    return true
  }) as typeof process.stdout.write

  printStartupScreen()

  process.stdout.write = originalWrite
  return stripAnsi(output)
}

function logoLines(plainOutput: string): string[] {
  // Letter rows contain █; the bottom shadow row only ╚═╝ glyphs. Neither
  // pattern occurs in the tagline, info box, or version line.
  return plainOutput.split('\n').filter(line => line.includes('█') || line.includes('╚═╝'))
}

// Visible widths of the current art: OPEN 38 + gap 2 + CLAUDE 54.
const ONE_ROW_WIDTH = 94
const BOX_WIDTH = 62

describe('printStartupScreen layout', () => {
  test('wide terminal renders OPEN and CLAUDE side by side as one 6-line block', () => {
    const out = renderStartupScreen(120)
    const logo = logoLines(out)
    expect(logo).toHaveLength(6)
    // End of N (OPEN) and start of C (CLAUDE) share a line
    expect(logo[0]).toContain('███╗   ██╗   ██████╗ ██╗')
  })

  test('one-row logo is centered and rows are aligned as a block', () => {
    const out = renderStartupScreen(120)
    const logo = logoLines(out)
    const pad = ' '.repeat(Math.floor((120 - ONE_ROW_WIDTH) / 2))
    expect(logo[1]!.startsWith(`${pad}██╔═══██╗`)).toBe(true)
    expect(logo[4]!.startsWith(`${pad}╚██████╔╝`)).toBe(true)
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(120)
    }
  })

  test('narrow terminal falls back to two stacked centered blocks', () => {
    const out = renderStartupScreen(80)
    expect(logoLines(out)).toHaveLength(12)
    expect(out).not.toContain('███╗   ██╗   ██████╗')
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
  })

  test('layout switches exactly at the one-row width', () => {
    expect(logoLines(renderStartupScreen(ONE_ROW_WIDTH))).toHaveLength(6)
    expect(logoLines(renderStartupScreen(ONE_ROW_WIDTH - 1))).toHaveLength(12)
  })

  test('provider box, tagline, and version line are centered', () => {
    const out = renderStartupScreen(120)
    const lines = out.split('\n')

    // The logo letterforms also contain ╔ — the box's top border is the line
    // that starts with it.
    const boxTop = lines.find(line => line.trimStart().startsWith('╔'))
    expect(boxTop).toBeDefined()
    expect(boxTop!.indexOf('╔')).toBe(Math.floor((120 - BOX_WIDTH) / 2))

    const tagline = lines.find(line => line.includes('✦'))
    expect(tagline).toBeDefined()
    expect(tagline!.indexOf('✦')).toBe(
      Math.floor((120 - tagline!.trim().length) / 2),
    )

    const version = lines.find(line => line.includes('openclaude v'))
    expect(version).toBeDefined()
    expect(version!.indexOf('openclaude')).toBe(
      Math.floor((120 - version!.trim().length) / 2),
    )
  })
})

// --- Issue #855: aggregator URL must win over vendor-prefixed model name ---

describe('detectProvider — aggregator URL authoritative over model-name substring (#855)', () => {
  test('OpenRouter + deepseek/deepseek-chat labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'deepseek/deepseek-chat')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + moonshotai/kimi-k2 labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'moonshotai/kimi-k2')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + mistralai/mistral-large labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'mistralai/mistral-large')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + meta-llama/llama-3.3 labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('Together + deepseek-ai/DeepSeek-V3 labels as Together AI', () => {
    setupOpenAIMode('https://api.together.xyz/v1', 'deepseek-ai/DeepSeek-V3')
    expect(detectProvider().name).toBe('Together AI')
  })

  test('Together + meta-llama/Llama-3.3 labels as Together AI', () => {
    setupOpenAIMode('https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo')
    expect(detectProvider().name).toBe('Together AI')
  })

  test('Groq + deepseek-r1-distill-llama-70b labels as Groq', () => {
    setupOpenAIMode('https://api.groq.com/openai/v1', 'deepseek-r1-distill-llama-70b')
    expect(detectProvider().name).toBe('Groq')
  })

  test('Groq + llama-3.3-70b-versatile labels as Groq', () => {
    setupOpenAIMode('https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile')
    expect(detectProvider().name).toBe('Groq')
  })

  test('Azure + any deepseek deployment labels as Azure OpenAI', () => {
    setupOpenAIMode('https://my-resource.openai.azure.com/', 'deepseek-chat')
    expect(detectProvider().name).toBe('Azure OpenAI')
  })
})

// --- Direct vendor endpoints still label correctly (regression) ---

describe('detectProvider — direct vendor endpoints', () => {
  test('api.deepseek.com labels as DeepSeek', () => {
    setupOpenAIMode('https://api.deepseek.com/v1', 'deepseek-chat')
    expect(detectProvider().name).toBe('DeepSeek')
  })

  test('api.kimi.com labels as Moonshot AI - Kimi Code', () => {
    setupOpenAIMode('https://api.kimi.com/coding/v1', 'kimi-for-coding')
    expect(detectProvider().name).toBe('Moonshot AI - Kimi Code')
  })

  test('api.moonshot.cn labels as Moonshot AI - API', () => {
    setupOpenAIMode('https://api.moonshot.cn/v1', 'moonshot-v1-8k')
    expect(detectProvider().name).toBe('Moonshot AI - API')
  })

  test('api.mistral.ai labels from descriptor route metadata', () => {
    setupOpenAIMode('https://api.mistral.ai/v1', 'mistral-large-latest')
    expect(detectProvider().name).toBe('Mistral AI')
  })

  test('api.z.ai labels from descriptor route metadata', () => {
    setupOpenAIMode('https://api.z.ai/api/coding/paas/v4', 'GLM-5.1')
    expect(detectProvider().name).toBe('Z.AI')
  })

  test('default OpenAI URL + gpt-4o labels as OpenAI', () => {
    setupOpenAIMode('https://api.openai.com/v1', 'gpt-4o')
    expect(detectProvider().name).toBe('OpenAI')
  })
})

// --- rawModel fallback for generic/custom endpoints ---

describe('detectProvider — rawModel fallback when URL is generic', () => {
  test('custom proxy + deepseek-chat falls back to DeepSeek', () => {
    setupOpenAIMode('https://my-proxy.internal/v1', 'deepseek-chat')
    expect(detectProvider().name).toBe('DeepSeek')
  })

  test('custom proxy + kimi-for-coding falls back to Moonshot AI - Kimi Code', () => {
    setupOpenAIMode('https://my-proxy.internal/v1', 'kimi-for-coding')
    expect(detectProvider().name).toBe('Moonshot AI - Kimi Code')
  })

  test('custom proxy + kimi-k2 falls back to Moonshot AI - API', () => {
    setupOpenAIMode('https://my-proxy.internal/v1', 'kimi-k2-instruct')
    expect(detectProvider().name).toBe('Moonshot AI - API')
  })

  test('custom proxy + llama-3.3 falls back to Meta Llama', () => {
    setupOpenAIMode('https://my-proxy.internal/v1', 'llama-3.3-70b')
    expect(detectProvider().name).toBe('Meta Llama')
  })

  test('custom proxy + mistral-large falls back to Mistral', () => {
    setupOpenAIMode('https://my-proxy.internal/v1', 'mistral-large-latest')
    expect(detectProvider().name).toBe('Mistral')
  })

  test('custom proxy + exact uppercase GLM ID stays generic without route metadata', () => {
    setupOpenAIMode('https://my-proxy.internal/v1', 'GLM-5.1')
    expect(detectProvider().name).toBe('OpenAI')
  })

  test('custom proxy + lowercase glm ID stays generic OpenAI', () => {
    setupOpenAIMode('https://my-proxy.internal/v1', 'glm-5.1')
    expect(detectProvider().name).toBe('OpenAI')
  })

  test('DashScope lowercase glm ID is not mislabeled as Z.AI', () => {
    setupOpenAIMode('https://dashscope.aliyuncs.com/compatible-mode/v1', 'glm-5.1')
    expect(detectProvider().name).toBe('OpenAI')
  })
})

// --- Explicit env flags win over URL heuristics ---

describe('detectProvider — explicit dedicated-provider env flags', () => {
  test('NVIDIA_NIM=1 overrides aggregator URL', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'some-nim-model')
    process.env.NVIDIA_NIM = '1'
    expect(detectProvider().name).toBe('NVIDIA NIM')
  })

  test('MINIMAX_API_KEY overrides aggregator URL', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'any-model')
    process.env.MINIMAX_API_KEY = 'test-key'
    expect(detectProvider().name).toBe('MiniMax')
  })

  test('Anthropic-compatible MiniMax profile is labeled MiniMax', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic'
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.ANTHROPIC_MODEL = 'MiniMax-M2.7'

    expect(detectProvider().name).toBe('MiniMax')
    expect(detectProvider().baseUrl).toBe('https://api.minimax.io/anthropic')
  })
})

// --- modelOverride from --model flag ---

describe('detectProvider — modelOverride from --model flag', () => {
  test('modelOverride overrides default Anthropic model', () => {
    const result = detectProvider('claude-opus-4-6')
    expect(result.name).toBe('Anthropic')
    expect(result.model).toContain('opus')
  })

  test('modelOverride alias is resolved for Anthropic', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6'
    const result = detectProvider('opus')
    expect(result.name).toBe('Anthropic')
    expect(result.model).toContain('opus')
  })

  test('modelOverride takes priority over ANTHROPIC_MODEL env var', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
    const result = detectProvider('claude-opus-4-6')
    expect(result.name).toBe('Anthropic')
    expect(result.model).toContain('opus')
  })

  test('modelOverride takes priority over CLAUDE_MODEL env var', () => {
    process.env.CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
    const result = detectProvider('claude-opus-4-6')
    expect(result.name).toBe('Anthropic')
    expect(result.model).toContain('opus')
  })

  test('modelOverride works for OpenAI provider', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-4o'
    const result = detectProvider('gpt-4-turbo')
    expect(result.model).toContain('gpt-4-turbo')
  })

  test('modelOverride works for Gemini provider', () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    const result = detectProvider('gemini-2.5-pro')
    expect(result.name).toBe('Google AI / Gemini')
    expect(result.model).toBe('gemini-2.5-pro')
  })

  test('modelOverride works for Mistral provider', () => {
    process.env.CLAUDE_CODE_USE_MISTRAL = '1'
    const result = detectProvider('mistral-large-latest')
    expect(result.model).toBe('mistral-large-latest')
  })

  test('modelOverride works for GitHub provider', () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    const result = detectProvider('gpt-4o')
    expect(result.model).toContain('gpt-4o')
  })

  test('undefined modelOverride preserves default behavior', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
    const result = detectProvider(undefined)
    expect(result.name).toBe('Anthropic')
    expect(result.model).toContain('sonnet')
  })

  test('no argument preserves default behavior', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
    const result = detectProvider()
    expect(result.name).toBe('Anthropic')
    expect(result.model).toContain('sonnet')
  })
})
