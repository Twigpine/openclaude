import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
  vi,
} from 'bun:test'
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { Message } from '../../types/message.js'
import * as realConfig from '../../utils/config.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from '../../utils/interruptionTrace.js'

// Several earlier test files in the smoke suite call
// mock.module('../../utils/model/providers.js', ...) to stub getAPIProvider.
// bun:test's mock.module() registry is process-global and mock.restore() does
// NOT clear it, so the cached bare-path import of providers.js inside betas.ts
// (which compact.ts transitively imports) resolves to that stub unless we
// override it. We import the real providers module through a cache-busting URL
// and register it under the bare specifier while this suite holds the shared
// mutation lock.
const _realProvidersModule = await import(
  `../../utils/model/providers.js?real=${Date.now()}-${Math.random()}`
)

// Pre-import real modules that compact stubs but downstream tests need
// (goal continuation controller, runAgent provider routing).
const _realMessagesModule = await import(
  `../../utils/messages.js?real=${Date.now()}-${Math.random()}`
)
const _realSystemFactoriesModule = await import(
  `../../utils/messages/systemFactories.js?real=${Date.now()}-${Math.random()}`
)
const _realSlowOperationsModule = await import(
  `../../utils/slowOperations.js?real=${Date.now()}-${Math.random()}`
)
const _realBootstrapStateModule = await import(
  `../../bootstrap/state.js?real=${Date.now()}-${Math.random()}`
)
const _realSettingsModule = await import(
  `../../utils/settings/settings.js?real=${Date.now()}-${Math.random()}`
)
const _realModelModule = await import(
  `../../utils/model/model.js?real=${Date.now()}-${Math.random()}`
)
const _realAuthModule = await import(
  `../../utils/auth.js?real=${Date.now()}-${Math.random()}`
)
const _realPathModule = await import(
  `../../utils/path.js?real=${Date.now()}-${Math.random()}`
)
const _realConfigModule = await import(
  `../../utils/config.js?real=${Date.now()}-${Math.random()}`
)
const _realProjectInstructionsModule = await import(
  `../../utils/projectInstructions.js?real=${Date.now()}-${Math.random()}`
)
const _realTokenEstimationModule = await import(
  `../tokenEstimation.js?real=${Date.now()}-${Math.random()}`
)
const _realClaudeApiModule = await import(
  `../api/claude.js?real=${Date.now()}-${Math.random()}`
)
const _realGrowthBookModule = await import(
  `../analytics/growthbook.js?real=${Date.now()}-${Math.random()}`
)
const _realContextModule = await import(
  `../../utils/context.js?real=${Date.now()}-${Math.random()}`
)
const _realErrorsModule = await import(
  `../../utils/errors.js?real=${Date.now()}-${Math.random()}`
)
const _realTokensModule = await import(
  `../../utils/tokens.js?real=${Date.now()}-${Math.random()}`
)
const compactTestTaskOutputPath = join(
  tmpdir(),
  `openclaude-compact-test-${process.pid}-${randomUUID()}`,
)

const COMPACT_STUB_MODULES = [
  '../analytics/growthbook.js',
  '../analytics/index.js',
  '../api/claude.js',
  '../api/errors.js',
  '../api/promptCacheBreakDetection.js',
  '../api/withRetry.js',
  '../tokenEstimation.js',
  '../../bootstrap/state.js',
  '../../tools/FileReadTool/FileReadTool.js',
  '../../tools/FileReadTool/prompt.js',
  '../../tools/ToolSearchTool/ToolSearchTool.js',
  '../../utils/attachments.js',
  '../../utils/auth.js',
  '../../utils/config.js',
  '../../utils/context.js',
  '../../utils/contextAnalysis.js',
  '../../utils/debug.js',
  '../../utils/errors.js',
  '../../utils/fileStateCache.js',
  '../../utils/forkedAgent.js',
  '../../utils/hooks.js',
  '../../utils/log.js',
  '../../utils/memory/types.js',
  '../../utils/messages.js',
  '../../utils/messages/systemFactories.js',
  '../../utils/model/model.js',
  '../../utils/model/providers.js',
  '../../utils/model/modelSupportOverrides.js',
  '../../utils/path.js',
  '../../utils/plans.js',
  '../../utils/projectInstructions.js',
  '../../utils/sessionActivity.js',
  '../../utils/sessionStart.js',
  '../../utils/sessionStorage.js',
  '../../utils/settings/settings.js',
  '../../utils/sleep.js',
  '../../utils/slowOperations.js',
  '../../utils/systemPromptType.js',
  '../../utils/task/diskOutput.js',
  '../../utils/tokens.js',
  '../../utils/toolSearch.js',
  './grouping.js',
  './prompt.js',
] as const
let realCompactStubModules: Map<string, object> | undefined
let hasSharedMutationLock = false

async function captureRealCompactStubModules(): Promise<Map<string, object>> {
  if (!realCompactStubModules) {
    realCompactStubModules = new Map(
      await Promise.all(
        COMPACT_STUB_MODULES.map(async specifier =>
          [
            specifier,
            await import(`${specifier}?real=${Date.now()}-${Math.random()}`),
          ] as const,
        ),
      ),
    )
  }
  return realCompactStubModules
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMessage(content: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function assistantMessage(text: string): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      // AssistantMessageContent also requires id, model, usage at the type
      // level; the compact code paths under test don't read them, so cast
      // through unknown to keep the helper focused on the text content.
    } as never,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function assistantToolUseMessage(toolUseId: string): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      id: `msg-${toolUseId}`,
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Read',
          input: { file_path: '/tmp/example.txt' },
        },
      ],
    } as never,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function toolResultMessage(toolUseId: string): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'file contents',
        },
      ],
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  } as Message
}

function hasToolResultBlock(message: Message): boolean {
  const content =
    message.type === 'user' ? message.message.content : undefined
  return (
    Array.isArray(content) &&
    content.some(block => block.type === 'tool_result')
  )
}

function toolUseContext() {
  return {
    agentId: 'test-agent',
    options: {
      mainLoopModel: 'claude-sonnet-4-5',
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
    },
    getAppState: mock(() => ({
      toolPermissionContext: {},
      effortValue: undefined,
      tasks: {} as Record<string, unknown>,
    })),
    onCompactProgress: mock(() => {}),
    setStreamMode: mock(() => {}),
    setResponseLength: mock(() => {}),
    setSDKStatus: mock(() => {}),
    abortController: new AbortController(),
    readFileState: new Map(),
  } as never
}

function cacheSafeParams(messages: Message[]) {
  return {
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext: toolUseContext(),
    forkContextMessages: messages,
  } as never
}

// ---------------------------------------------------------------------------
// Env snapshot / restore
// ---------------------------------------------------------------------------

// Provider/profile env vars that can steer provider detection. We do NOT keep
// an "original" snapshot (the snapshot would be polluted by test files that run
// before this one in the smoke suite). Each test starts with a clean slate and
// sets only the vars it explicitly needs.
const PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'MINIMAX_API_KEY',
  'XAI_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'NEARAI_API_KEY',
  // See FIREWORKS_API_KEY comment in src/utils/betas.test.ts: a leaked
  // key is interpreted as 'firstParty' by getAPIProvider because the
  // 'fireworks' route has no switch case in that function.
  'FIREWORKS_API_KEY',
  'LONGCAT_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'USER_TYPE',
  'CLAUDE_CODE_ENTRYPOINT',
] as const

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key]
  }
}

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

/**
 * Options that control the behavior of the compact mock fixture.
 *
 * **Essential mocks** (required for the provider gate test — must be overridable):
 * - `runForkedAgent` — spy target; asserted on in both test cases
 * - `growthBookDefault` — controls the GrowthBook flag that gates cache-sharing
 *
 * **Provider gate control via environment variables:**
 * - The `isAnthropicProvider()` gate is tested by setting provider env vars
 *   (e.g. CLAUDE_CODE_USE_OPENAI=1) instead of mocking betas.ts. This avoids
 *   mock.module() leaks that cause CI failures in other test files.
 *
 * **Defensive stubs** (prevent transitive import/side-effect failures):
 * - Everything else registered by registerCommonCompactStubs is a defensive
 *   stub needed to let compactConversation() run start-to-finish without real
 *   network, GrowthBook, hooks, token counting, or filesystem I/O.
 */
export type CompactMockOptions = {
  /** Mock for runForkedAgent(). ESSENTIAL — spy asserted on by both tests. */
  runForkedAgent?: ReturnType<typeof mock>
  /** GrowthBook default for tengu_compact_cache_prefix. */
  growthBookDefault?: boolean
  /** Mock for executePreCompactHooks. */
  executePreCompactHooks?: ReturnType<typeof mock>
  /** Override for getGlobalConfig(), e.g. to set compactModel. */
  getGlobalConfig?: ReturnType<typeof mock>
  /** Override for queryModelWithStreaming(), to inspect the model/options passed in. */
  queryModelWithStreaming?: ReturnType<typeof mock>
  /** Override for getMaxOutputTokensForModel(). */
  getMaxOutputTokensForModel?: ReturnType<typeof mock>
}

/**
 * Register all common (defensive) stubs needed by compactConversation() and
 * streamCompactSummary(). Returns an object with hooks that the caller can
 * inspect or override, most importantly `runForkedAgent`.
 *
 * This is the **shared fixture** — new compact tests should call this instead
 * of copying the ~40 mock.module() calls.  Annotated inline: [ESSENTIAL] marks
 * mocks that the provider gate test specifically depends on; all others are
 * DEFENSIVE (prevent transitive import / side-effect / I/O failures).
 */
function registerCommonCompactStubs(options: CompactMockOptions = {}) {
  mock.restore()

  // --- Provider gate control ---
  // The isAnthropicProvider() gate is exercised via environment variables
  // (e.g. CLAUDE_CODE_USE_OPENAI=1) instead of mock.module() on betas.ts.
  // This avoids mock.module() leaks that cause CI failures in other test
  // files (betas.test.ts, autoCompact.test.ts) that import the real module.
  // The beforeEach hook already calls clearProviderEnv(), so each test
  // starts with a clean provider state and the real betas.ts /
  // providers.ts / envUtils.ts work from env vars.

  // --- Forked agent (ESSENTIAL — spy for call-count assertions) ---
  const runForkedAgent =
    options.runForkedAgent ??
    mock(async () => ({
      messages: [
        assistantMessage('This is a compact summary of the conversation.'),
      ],
      totalUsage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }))
  mock.module('../../utils/forkedAgent.js', () => ({
    runForkedAgent,
  }))

  // --- GrowthBook (DEFENSIVE) ---
  mock.module('../analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: mock(
      () => options.growthBookDefault ?? true,
    ),
  }))

  // --- Analytics (DEFENSIVE) ---
  mock.module('../analytics/index.js', () => ({
    logEvent: mock(() => {}),
  }))

  // --- Hooks (DEFENSIVE) ---
  mock.module('../../utils/hooks.js', () => ({
    executePreCompactHooks:
      options.executePreCompactHooks ??
      mock(async () => ({
        newCustomInstructions: null,
        userDisplayMessage: null,
        userMessage: null,
      })),
    executePostCompactHooks: mock(async () => []),
  }))

  // --- Token helpers (DEFENSIVE) ---
  mock.module('../../utils/tokens.js', () => ({
    tokenCountWithEstimation: mock(() => 1000),
    tokenCountFromLastAPIResponse: mock(() => 100),
    getTokenUsage: mock(() => ({
      input_tokens: 100,
      output_tokens: 50,
    })),
  }))

  // --- Token estimation (DEFENSIVE) ---
  mock.module('../tokenEstimation.js', () => ({
    roughTokenCountEstimation: mock(() => 100),
    roughTokenCountEstimationForMessages: mock(() => 500),
  }))

  // --- Message helpers (DEFENSIVE — stub just enough) ---
  mock.module('../../utils/messages.js', () => ({
    createUserMessage: _realMessagesModule.createUserMessage,
    createCompactBoundaryMessage: mock(() => ({
      type: 'system' as const,
      message: { role: 'system' as const, content: '' },
      uuid: `sys-${Math.random()}`,
      timestamp: new Date().toISOString(),
    })),
    getAssistantMessageText: _realMessagesModule.getAssistantMessageText,
    getLastAssistantMessage: mock(
      (msgs: Message[]) => msgs.findLast(m => m.type === 'assistant') ?? null,
    ),
    getMessagesAfterCompactBoundary: mock((msgs: Message[]) => msgs),
    isCompactBoundaryMessage: mock(() => false),
    normalizeMessagesForAPI: mock((msgs: Message[]) => msgs),
    selectToolPairSafeMessageRange:
      _realMessagesModule.selectToolPairSafeMessageRange,
  }))

  // --- API / streaming (DEFENSIVE) ---
  mock.module('../api/claude.js', () => ({
    queryModelWithStreaming:
      options.queryModelWithStreaming ??
      mock(async function* () {
        yield {
          type: 'assistant' as const,
          message: {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'Streamed summary.' }],
          },
          uuid: `stream-${Math.random()}`,
          timestamp: new Date().toISOString(),
        }
      }),
    getMaxOutputTokensForModel:
      options.getMaxOutputTokensForModel ?? mock(() => 8192),
  }))

  mock.module('../api/errors.js', () => ({
    getPromptTooLongTokenGap: mock(() => undefined),
    PROMPT_TOO_LONG_ERROR_MESSAGE: 'Prompt is too long',
    startsWithApiErrorPrefix: mock(() => false),
  }))

  mock.module('../api/promptCacheBreakDetection.js', () => ({
    notifyCompaction: mock(() => {}),
  }))

  mock.module('../api/withRetry.js', () => ({
    getRetryDelay: mock(() => 0),
  }))

  // --- Session activity (DEFENSIVE) ---
  mock.module('../../utils/sessionActivity.js', () => ({
    isSessionActivityTrackingActive: mock(() => false),
    sendSessionActivitySignal: mock(() => {}),
  }))

  // --- Tool search (DEFENSIVE) ---
  mock.module('../../utils/toolSearch.js', () => ({
    isToolSearchEnabled: mock(async () => false),
    extractDiscoveredToolNames: mock(() => new Set()),
  }))

  // --- Compact prompt (DEFENSIVE) ---
  mock.module('./prompt.js', () => ({
    getCompactPrompt: mock(() => 'Please summarize this conversation.'),
    getCompactUserSummaryMessage: mock(() => 'Conversation summary'),
    getPartialCompactPrompt: mock(() => 'Summarize this part.'),
  }))

  // --- Compact grouping (DEFENSIVE) ---
  mock.module('./grouping.js', () => ({
    groupMessagesByApiRound: mock((msgs: Message[]) => [msgs]),
  }))

  // --- Config (DEFENSIVE) ---
  mock.module('../../utils/config.js', () => ({
    ..._realConfigModule,
    getMemoryPath: mock(() => '/tmp/memory'),
    ...(options.getGlobalConfig
      ? { getGlobalConfig: options.getGlobalConfig }
      : {}),
  }))

  // --- File state cache (DEFENSIVE) ---
  mock.module('../../utils/fileStateCache.js', () => ({
    cacheToObject: mock(() => ({})),
  }))

  // --- Session storage (DEFENSIVE) ---
  mock.module('../../utils/sessionStorage.js', () => ({
    getTranscriptPath: mock(() => '/tmp/transcript'),
    reAppendSessionMetadata: mock(() => {}),
  }))

  // --- Session start hooks (DEFENSIVE) ---
  mock.module('../../utils/sessionStart.js', () => ({
    processSessionStartHooks: mock(async () => []),
  }))

  // --- Attachments (DEFENSIVE) ---
  mock.module('../../utils/attachments.js', () => ({
    createAttachmentMessage: mock(() => ({
      type: 'attachment' as const,
      attachment: { type: 'file' as const, path: '/tmp/test' },
      uuid: `att-${Math.random()}`,
      timestamp: new Date().toISOString(),
    })),
    generateFileAttachment: mock(() => ({})),
    getAgentListingDeltaAttachment: mock(() => []),
    getDeferredToolsDeltaAttachment: mock(() => []),
    getMcpInstructionsDeltaAttachment: mock(() => []),
  }))

  // --- Plans (DEFENSIVE) ---
  mock.module('../../utils/plans.js', () => ({
    getPlan: mock(() => null),
    getPlanFilePath: mock(() => '/tmp/plan'),
  }))

  // --- Path (DEFENSIVE) ---
  mock.module('../../utils/path.js', () => ({
    ..._realPathModule,
    expandPath: mock((p: string) => p),
  }))

  // --- Sleep (DEFENSIVE) ---
  mock.module('../../utils/sleep.js', () => ({
    sleep: mock(async () => {}),
  }))

  // --- Logging (DEFENSIVE) ---
  mock.module('../../utils/log.js', () => ({
    logError: mock(() => {}),
  }))

  mock.module('../../utils/debug.js', () => ({
    logForDebugging: mock(() => {}),
  }))

  // --- Slow operations (DEFENSIVE) ---
  mock.module('../../utils/slowOperations.js', () => ({
    jsonStringify: mock(() => '{}'),
  }))

  // --- Bootstrap state (DEFENSIVE) ---
  mock.module('../../bootstrap/state.js', () => ({
    markPostCompaction: mock(() => {}),
    getInvokedSkillsForAgent: mock(() => []),
    getOriginalCwd: mock(() => '/tmp'),
  }))

  // --- Tools (DEFENSIVE) ---
  mock.module('../../tools/FileReadTool/FileReadTool.js', () => ({
    FileReadTool: { name: 'Read', isMcp: false },
  }))

  mock.module('../../tools/FileReadTool/prompt.js', () => ({
    FILE_READ_TOOL_NAME: 'Read',
    FILE_UNCHANGED_STUB: '',
  }))

  mock.module('../../tools/ToolSearchTool/ToolSearchTool.js', () => ({
    ToolSearchTool: { name: 'ToolSearch', isMcp: false },
  }))

  // --- Context (DEFENSIVE) ---
  mock.module('../../utils/context.js', () => ({
    COMPACT_MAX_OUTPUT_TOKENS: 8192,
  }))

  mock.module('../../utils/contextAnalysis.js', () => ({
    analyzeContext: mock(() => ({})),
    tokenStatsToStatsigMetrics: mock(() => ({})),
  }))

  // --- Project instructions (DEFENSIVE) ---
  mock.module('../../utils/projectInstructions.js', () => ({
    getProjectInstructionFilePaths: mock(() => []),
  }))

  // --- Memory types (DEFENSIVE) ---
  mock.module('../../utils/memory/types.js', () => ({
    MEMORY_TYPE_VALUES: [],
  }))

  // --- System prompt type (DEFENSIVE) ---
  mock.module('../../utils/systemPromptType.js', () => ({
    asSystemPrompt: mock((arr: string[]) => arr),
  }))

  // --- Task output (DEFENSIVE) ---
  mock.module('../../utils/task/diskOutput.js', () => ({
    getTaskOutputPath: mock(() => compactTestTaskOutputPath),
  }))

  // --- Errors (DEFENSIVE) ---
  mock.module('../../utils/errors.js', () => ({
    hasExactErrorMessage: mock(() => false),
  }))

  // --- Auth (DEFENSIVE) ---
  mock.module('../../utils/auth.js', () => ({
    isClaudeAISubscriber: mock(() => false),
  }))

  // --- Model support overrides (DEFENSIVE) ---
  mock.module('../../utils/model/modelSupportOverrides.js', () => ({
    get3PModelCapabilityOverride: mock(() => undefined),
  }))

  // --- Settings (DEFENSIVE) ---
  mock.module('../../utils/settings/settings.js', () => ({
    ..._realSettingsModule,
    getInitialSettings: mock(() => ({})),
  }))

  // --- Model (DEFENSIVE) ---
  mock.module('../../utils/model/model.js', () => ({
    ..._realModelModule,
    getCanonicalName: mock((m: string) => m),
  }))

  return { runForkedAgent }
}

/**
 * Import the compact module with all transitive dependencies stubbed.
 *
 * **Provider gate control via environment variables:**
 * - The `isAnthropicProvider()` gate is exercised by setting provider env vars
 *   (e.g. CLAUDE_CODE_USE_OPENAI=1) in the test body, rather than via mock
 *   options. The beforeEach hook calls clearProviderEnv() so each test starts
 *   with a clean provider state and the real betas.ts / providers.ts read
 *   live env vars.
 * - `runForkedAgent` — spy target, returned so tests can assert call count
 * - `getFeatureValue_CACHED_MAY_BE_STALE` (growthBookDefault) — controls the
 *   GrowthBook flag that gates cache-sharing alongside isAnthropicProvider()
 *
 * **Defensive stubs (everything else):**
 * - All other mock.module() calls are defensive fall-through stubs that
 *   prevent the compactConversation() → streamCompactSummary() → post-compaction
 *   pipeline from hitting real network, GrowthBook, hooks, token counting,
 *   skill loading, or filesystem I/O.  Without them the import alone would
 *   trigger hundreds of failed transitive resolution steps.
 */
async function importCompact(options: CompactMockOptions = {}) {
  const { runForkedAgent } = registerCommonCompactStubs(options)

  // Dynamic import with cache-busting so each test gets fresh module state
  const nonce = `${Date.now()}-${Math.random()}`
  const mod = await import(`./compact.ts?test=${nonce}`)
  return { ...mod, runForkedAgent }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await acquireSharedMutationLock('services/compact/compact.test.ts')
  hasSharedMutationLock = true
  try {
    await captureRealCompactStubModules()
    mock.module('../../utils/model/providers.js', () => ({
      ..._realProvidersModule,
    }))
    clearProviderEnv()
  } catch (error) {
    releaseSharedMutationLock()
    hasSharedMutationLock = false
    throw error
  }
})

afterEach(async () => {
  if (!hasSharedMutationLock) {
    return
  }
  try {
    await restoreCompactTestMocks()
  } finally {
    releaseSharedMutationLock()
    hasSharedMutationLock = false
  }
})

// Safety net: scrub provider env vars and restore mocks after all tests in
// this file finish, so nothing leaks into subsequent test files.
async function restoreCompactTestMocks() {
  mock.restore()
  clearProviderEnv()
  const realCompactStubModules = await captureRealCompactStubModules()
  for (const specifier of COMPACT_STUB_MODULES) {
    const realModule = realCompactStubModules.get(specifier)
    if (!realModule) {
      throw new Error(`Missing real compact stub module: ${specifier}`)
    }
    mock.module(specifier, () => ({ ...realModule }))
  }
  // The generic loop above restores the full diskOutput module contract for
  // downstream tests (goal controller, runAgent routing, BashTool).
  mock.module('../../utils/messages.js', () => ({ ..._realMessagesModule }))
  mock.module('../../utils/messages/systemFactories.js', () => ({
    ..._realSystemFactoriesModule,
  }))
  mock.module('../../utils/slowOperations.js', () => ({
    ..._realSlowOperationsModule,
  }))
  mock.module('../../bootstrap/state.js', () => ({ ..._realBootstrapStateModule }))
  mock.module('../../utils/settings/settings.js', () => ({ ..._realSettingsModule }))
  mock.module('../../utils/model/model.js', () => ({ ..._realModelModule }))
  mock.module('../../utils/auth.js', () => ({ ..._realAuthModule }))
  mock.module('../../utils/path.js', () => ({ ..._realPathModule }))
  mock.module('../../utils/config.js', () => ({ ..._realConfigModule }))
  // These compact-only stubs affect the standalone microcompact and
  // auto-compact tests that run later in the serialized smoke suite.
  mock.module('../tokenEstimation.js', () => ({ ..._realTokenEstimationModule }))
  mock.module('../api/claude.js', () => ({ ..._realClaudeApiModule }))
  mock.module('../analytics/growthbook.js', () => ({ ..._realGrowthBookModule }))
  mock.module('../../utils/context.js', () => ({ ..._realContextModule }))
  mock.module('../../utils/errors.js', () => ({ ..._realErrorsModule }))
  mock.module('../../utils/tokens.js', () => ({ ..._realTokensModule }))
  // Keep the cleanup load-bearing: these modules are consumed by standalone
  // auto-compact tests when this file happens to run first in the smoke suite.
  const [
    restoredContext,
    restoredErrors,
    restoredTokens,
    restoredTokenEstimation,
    restoredClaudeApi,
    restoredGrowthBook,
  ] = await Promise.all([
    import('../../utils/context.js'),
    import('../../utils/errors.js'),
    import('../../utils/tokens.js'),
    import('../tokenEstimation.js'),
    import('../api/claude.js'),
    import('../analytics/growthbook.js'),
  ])
  expect(restoredContext.getContextWindowForModel).toBe(
    _realContextModule.getContextWindowForModel,
  )
  expect(restoredErrors.hasExactErrorMessage).toBe(
    _realErrorsModule.hasExactErrorMessage,
  )
  expect(restoredTokens.tokenCountWithEstimation).toBe(
    _realTokensModule.tokenCountWithEstimation,
  )
  expect(restoredTokenEstimation.roughTokenCountEstimation).toBe(
    _realTokenEstimationModule.roughTokenCountEstimation,
  )
  expect(restoredClaudeApi.getMaxOutputTokensForModel).toBe(
    _realClaudeApiModule.getMaxOutputTokensForModel,
  )
  expect(restoredGrowthBook.getFeatureValue_CACHED_MAY_BE_STALE).toBe(
    _realGrowthBookModule.getFeatureValue_CACHED_MAY_BE_STALE,
  )
  // projectInstructions: the stub above replaces the whole module with only
  // getProjectInstructionFilePaths, so every other export becomes undefined.
  // Downstream CLAUDE.md discovery in runAgent.routing.test.ts then crashes in
  // processMemoryFile(). Restore the full real module shape.
  mock.module('../../utils/projectInstructions.js', () => ({
    ..._realProjectInstructionsModule,
  }))
  // Clean up only the unique test-owned path returned by the mock above.
  try {
    await unlink(compactTestTaskOutputPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

afterAll(async () => {
  await acquireSharedMutationLock('services/compact/compact.test.ts teardown')
  try {
    await captureRealCompactStubModules()
    await restoreCompactTestMocks()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('compactConversation provider gate', () => {
  test('attributes cache-sharing timeout aborts to the compact fork', async () => {
    const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    vi.useFakeTimers()
    try {
      const runForkedAgent = mock(() => new Promise(() => {}))
      const { compactConversation } = await importCompact({ runForkedAgent })
      const messages = [userMessage('Hello'), assistantMessage('Hi there!')]
      const compactPromise = compactConversation(
        messages,
        toolUseContext(),
        cacheSafeParams(messages),
        false,
      )

      for (let attempt = 0; attempt < 10 && runForkedAgent.mock.calls.length === 0; attempt++) {
        await Promise.resolve()
      }
      expect(runForkedAgent).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(120_000)
      await compactPromise

      expect(
        __getInterruptionTraceSnapshotForTests().find(
          entry => entry.event === 'abort.requested',
        ),
      ).toMatchObject({
        source: 'compact_timeout',
        subsystem: 'compact',
        controllerRole: 'compact-fork',
      })
    } finally {
      vi.useRealTimers()
      await __waitForInterruptionTraceFlushForTests()
      __resetInterruptionTraceForTests()
      if (originalTrace === undefined) {
        delete process.env.OPENCLAUDE_INTERRUPT_TRACE
      } else {
        process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
      }
    }
  })

  test('skips forked-agent cache-sharing for non-Anthropic providers', async () => {
    // Simulate a non-Anthropic provider (e.g. OpenAI) via env vars.
    // The real isAnthropicProvider() reads from process.env and returns false.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'test-openai-key'
    const { compactConversation, runForkedAgent } = await importCompact({})

    const messages = [userMessage('Hello'), assistantMessage('Hi there!')]
    const ctx = toolUseContext()
    const csp = cacheSafeParams(messages)

    await compactConversation(messages, ctx, csp, false)

    expect(runForkedAgent).not.toHaveBeenCalled()
  })

  test('uses forked-agent cache-sharing for Anthropic providers', async () => {
    // All provider env vars are cleared by beforeEach → default firstParty
    // (Anthropic). The real isAnthropicProvider() returns true.
    const { compactConversation, runForkedAgent } = await importCompact({})

    const messages = [userMessage('Hello'), assistantMessage('Hi there!')]
    const ctx = toolUseContext()
    const csp = cacheSafeParams(messages)

    await compactConversation(messages, ctx, csp, false)

    expect(runForkedAgent).toHaveBeenCalled()
  })

  test('uses forked-agent cache-sharing for GitHub Native Anthropic mode', async () => {
    // CLAUDE_CODE_USE_GITHUB=1 with a Claude model resolves to the "github"
    // provider, so isAnthropicProvider() is false — but it routes through the
    // native Anthropic client where prompt caching works, and the beta gate
    // already treats it as Anthropic-capable. Compaction must do the same and
    // keep cache-sharing on, instead of taking the cold-cache path.
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    const { compactConversation, runForkedAgent } = await importCompact({})

    const messages = [userMessage('Hello'), assistantMessage('Hi there!')]
    // toolUseContext() uses a claude-* mainLoopModel, so this is Native
    // Anthropic mode (not a non-Claude GitHub/OpenAI-style model).
    const ctx = toolUseContext()
    const csp = cacheSafeParams(messages)

    await compactConversation(messages, ctx, csp, false)

    expect(runForkedAgent).toHaveBeenCalled()
  })
})

describe('compactConversation compactModel override', () => {
  test('resolves a compact model alias to full model ID before comparing and sending', async () => {
    // The ModelPicker stores alias values like 'sonnet' directly; compact must
    // resolve them with parseUserSpecifiedModel before comparing to mainLoopModel
    // or passing to the API, so 'sonnet' → 'claude-sonnet-4-6-20251001' etc.
    const compactModelAlias = 'sonnet'
    const resolvedModel = _realModelModule.parseUserSpecifiedModel(compactModelAlias)
    const queryModelWithStreaming = mock(async function* () {
      yield {
        type: 'assistant' as const,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Alias summary.' }],
        },
        uuid: `alias-${Math.random()}`,
        timestamp: new Date().toISOString(),
      }
    })

    const { compactConversation } = await importCompact({
      getGlobalConfig: mock(() => ({
        ..._realConfigModule.getGlobalConfig(),
        compactModel: compactModelAlias,
      })),
      queryModelWithStreaming,
    })

    const messages = [userMessage('Hello'), assistantMessage('Hi there!')]
    const ctx = toolUseContext()
    const csp = cacheSafeParams(messages)

    await compactConversation(messages, ctx, csp, false)

    expect(queryModelWithStreaming).toHaveBeenCalled()
    const [{ options: streamOptions }] = queryModelWithStreaming.mock.calls[0] as unknown as [
      { options: { model: string } },
    ]
    // The alias must be expanded — never sent verbatim to the API.
    expect(streamOptions.model).toBe(resolvedModel)
    expect(streamOptions.model).not.toBe(compactModelAlias)
  })

  test('skips cache-sharing and routes streaming compaction to compactModel when it differs from mainLoopModel', async () => {
    // All provider env vars are cleared by beforeEach, so this would normally
    // be eligible for forked-agent cache-sharing (Anthropic provider). Setting
    // compactModel to a different model than mainLoopModel must override that.
    const compactModel = 'claude-opus-4-1'
    // parseUserSpecifiedModel remaps legacy opus IDs to the current default —
    // the resolved form is what compact.ts sends to the API.
    const resolvedCompactModel = _realModelModule.parseUserSpecifiedModel(compactModel)
    const getMaxOutputTokensForModel = mock((model: string) =>
      model === resolvedCompactModel ? 4096 : 8192,
    )
    const queryModelWithStreaming = mock(async function* () {
      yield {
        type: 'assistant' as const,
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'Streamed summary.' }],
        },
        uuid: `stream-${Math.random()}`,
        timestamp: new Date().toISOString(),
      }
    })

    const { compactConversation, runForkedAgent } = await importCompact({
      getGlobalConfig: mock(() => ({
        ..._realConfigModule.getGlobalConfig(),
        compactModel,
      })),
      getMaxOutputTokensForModel,
      queryModelWithStreaming,
    })

    const messages = [userMessage('Hello'), assistantMessage('Hi there!')]
    const ctx = toolUseContext()
    const csp = cacheSafeParams(messages)

    await compactConversation(messages, ctx, csp, false)

    // modelChangesForCompaction forces promptCacheSharingEnabled to false,
    // even though the default (Anthropic) provider would normally allow
    // forked-agent cache-sharing.
    expect(runForkedAgent).not.toHaveBeenCalled()

    expect(queryModelWithStreaming).toHaveBeenCalled()
    const [{ options: streamOptions }] = queryModelWithStreaming.mock.calls[0] as unknown as [
      { options: { model: string; maxOutputTokensOverride: number } },
    ]
    expect(streamOptions.model).toBe(resolvedCompactModel)
    expect(streamOptions.maxOutputTokensOverride).toBe(4096)
  })
})

describe('partialCompactConversation tool-pair-safe boundaries', () => {
  test('up_to pivot on a tool_result keeps the dangling result out of the kept side', async () => {
    const { partialCompactConversation } = await importCompact({})
    const toolUseId = 'toolu_partial_up_to'
    const head = userMessage('older context')
    const assistant = assistantToolUseMessage(toolUseId)
    const result = toolResultMessage(toolUseId)
    const tail = userMessage('current context')
    const messages = [head, assistant, result, tail]

    const compacted = await partialCompactConversation(
      messages,
      2,
      toolUseContext(),
      cacheSafeParams(messages),
      undefined,
      'up_to',
    )

    expect(compacted.messagesToKeep.map(m => m.uuid)).toEqual([tail.uuid])
    expect(compacted.messagesToKeep.some(hasToolResultBlock)).toBe(false)
  })

  test('from pivot on a tool_result expands the summarized side backward to include the tool_use', async () => {
    const { partialCompactConversation } = await importCompact({})
    const toolUseId = 'toolu_partial_from'
    const head = userMessage('older context')
    const assistant = assistantToolUseMessage(toolUseId)
    const result = toolResultMessage(toolUseId)
    const tail = userMessage('current context')
    const messages = [head, assistant, result, tail]

    const compacted = await partialCompactConversation(
      messages,
      2,
      toolUseContext(),
      cacheSafeParams(messages),
      undefined,
      'from',
    )

    expect(compacted.messagesToKeep.map(m => m.uuid)).toEqual([head.uuid])
    expect(compacted.messagesToKeep.some(hasToolResultBlock)).toBe(false)
  })
})
