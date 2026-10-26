import { describe, expect, spyOn, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { z } from 'zod/v4'

import {
  createQueryTurnBudget,
  query,
  type QueryParams,
} from '../query.js'
import { buildTool, type Tools } from '../Tool.js'
import type { QueryDeps } from './deps.js'
import { resolveProviderRequest } from '../services/api/providerConfig.js'
import { FallbackTriggeredError } from '../services/api/withRetry.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { countToolUses } from '../tools/AgentTool/agentToolUtils.js'
import { AGENT_STEP_LIMIT_TOOL_RESULT_PREFIX } from './agentStepLimit.js'
import type { Terminal } from './transitions.js'
import type { Message } from '../types/message.js'
import { dequeueAll, enqueue } from '../utils/messageQueueManager.js'
import * as modelAllowlist from '../utils/model/modelAllowlist.js'
import * as providerProfiles from '../utils/providerProfiles.js'
import { getSessionId, getMainLoopModelOverride, setMainLoopModelOverride } from '../bootstrap/state.js'
import { createSubagentContext, getLastCacheSafeParams, saveCacheSafeParams } from '../utils/forkedAgent.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { clearSessionContextWindowOverride, getSessionContextWindowOverride, setSessionContextWindowOverride } from '../utils/context.js'
import { isAutoCompactEnabled, shouldAutoCompact } from '../services/compact/autoCompact.js'
import {
  clearSmartRoutingSessionDisable,
  getRoutingTally,
  resetRoutingTally,
} from '../services/api/smartRouting/index.js'

const echoCalls: string[] = []

const echoTool = buildTool({
  name: 'Echo',
  inputSchema: z.object({ text: z.string() }),
  maxResultSizeChars: Infinity,
  async description() {
    return 'Echo input text'
  },
  async prompt() {
    return ''
  },
  async call(input) {
    echoCalls.push(input.text)
    return { data: `echo:${input.text}` }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: String(content),
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
})

function makeToolUseContext(tools: Tools = []): QueryParams['toolUseContext'] {
  const abortController = new AbortController()
  let inProgressToolUseIDs = new Set<string>()

  return {
    abortController,
    agentId: 'agent-test',
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: [], clients: [] },
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      },
      sessionHooks: new Map(),
      mainLoopModel: 'gpt-4o',
      effortValue: undefined,
      advisorModel: undefined,
    }),
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools,
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      appendSystemPrompt: undefined,
      providerOverride: undefined,
      mainLoopModel: 'gpt-4o',
    },
    addNotification: () => {},
    messages: [],
    setInProgressToolUseIDs: updater => {
      inProgressToolUseIDs = updater(inProgressToolUseIDs)
    },
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as QueryParams['toolUseContext']
}

function makeParams(
  callModel: QueryDeps['callModel'],
  tools: Tools = [],
  agentStepLimit?: { maxSteps: number; agentType: string },
): QueryParams {
  const dispatchingCallModel: QueryDeps['callModel'] = async function* (input) {
    if (input.options.onProviderRequestStart?.() === false) return
    yield* callModel(input)
  }
  return {
    messages: [createUserMessage({ content: 'inspect' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext: makeToolUseContext(tools),
    querySource: 'agent:builtin:general-purpose',
    ...(agentStepLimit ? { agentStepLimit } : {}),
    deps: {
      callModel: dispatchingCallModel,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        compactionResult: null,
        consecutiveFailures: undefined,
      }),
      uuid: () => '00000000-0000-4000-8000-000000000000',
    } as unknown as QueryDeps,
  }
}

async function drain(params: QueryParams): Promise<{
  yielded: any[]
  returned: any
}> {
  const yielded: any[] = []
  const generator = query(params)
  while (true) {
    const next = await generator.next()
    if (next.done) return { yielded, returned: next.value }
    yielded.push(next.value)
  }
}

function makeAliasParent(callModel: QueryDeps['callModel']): QueryParams {
  const params = makeParams(callModel)
  delete params.toolUseContext.agentId
  const appState = params.toolUseContext.getAppState()
  params.toolUseContext.getAppState = () => ({ ...appState, mainLoopModel: 'codexplan' })
  params.toolUseContext.options.mainLoopModel = 'gpt-5.6-sol'
  params.toolUseContext.readFileState = createFileStateCacheWithSizeLimit(10)
  params.toolUseContext.setAppState = () => {}
  return params
}

function gatewayEffort(requestModel: string): string | undefined {
  return resolveProviderRequest({
    model: requestModel,
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      OPENAI_API_KEY: 'test-key',
    },
  }).reasoning?.effort
}

describe('fork request selection at context boundaries', () => {
  test.each([
    { route: undefined, fixed: false },
    { route: 'gpt-5.6-sol?reasoning=low', fixed: false },
    { route: 'gpt-5.6-sol?reasoning=low', fixed: true },
  ])('tool refresh then provider switch in nested forks: $route / fixed=$fixed', async ({ route, fixed }) => {
    let providerId = 'provider-a'
    const activeProvider = spyOn(providerProfiles, 'getActiveProviderProfile').mockImplementation(
      () => ({ id: providerId }) as ReturnType<typeof providerProfiles.getActiveProviderProfile>,
    )
    const allowlist = spyOn(modelAllowlist, 'isModelAllowed').mockReturnValue(true)
    const savedBefore = getLastCacheSafeParams()
    const requests: string[] = []
    let useTool = false
    const params = makeAliasParent(async function* ({ options }) {
      requests.push(options.requestModel ?? options.model)
      const content = useTool
        ? [{ type: 'tool_use' as const, id: 'toolu_selection_refresh', name: 'Echo', input: { text: 'refresh' } }]
        : 'done'
      useTool = false
      yield createAssistantMessage({ content })
    })
    const state = params.toolUseContext.getAppState()
    params.toolUseContext.getAppState = () => ({
      ...state, settings: providerId === 'provider-a' && route
        ? { smartRouting: { enabled: true, simpleModel: route, strongModel: route } } : {},
    })
    params.toolUseContext.options.tools = [echoTool]
    params.toolUseContext.options.refreshTools = () => [echoTool]
    if (fixed) params.toolUseContext.options.providerOverride = {
      model: route!, baseURL: 'https://provider-a.example/v1', apiKey: 'test-key',
    }
    let latestContext = params.toolUseContext
    params.deps = { ...params.deps!, autocompact: async (_messages, context) => {
      latestContext = context
      return { wasCompacted: false }
    } }
    clearSmartRoutingSessionDisable(getSessionId())
    resetRoutingTally()
    try {
      await drain(params)
      const inherited = route ?? 'codexplan'
      const child = createSubagentContext(params.toolUseContext)
      requests.length = 0
      useTool = true
      await drain({ ...params, toolUseContext: child })
      expect(requests).toEqual([inherited, inherited])
      expect(requests.map(gatewayEffort)).toEqual(route ? ['low', 'low'] : ['high', 'high'])

      // The next default fork uses the last accepted, internally refreshed context.
      // Both profiles configure codexplan; only A had a smart-routing selection.
      providerId = 'provider-b'
      const nested = createSubagentContext(latestContext)
      const expected = fixed ? inherited : 'codexplan'
      expect(nested.options.mainLoopModel).toBe(fixed ? route! : 'gpt-5.6-sol')
      requests.length = 0
      useTool = true
      await drain({ ...params, toolUseContext: nested })
      expect(requests).toEqual([expected, expected])
      expect(requests.map(gatewayEffort)).toEqual(fixed ? ['low', 'low'] : ['high', 'high'])

      // An explicit same-concrete-model choice still wins after both transitions.
      const explicit = createSubagentContext(latestContext, {
        options: { ...latestContext.options, mainLoopModel: 'gpt-5.6-sol', providerOverride: undefined },
      })
      requests.length = 0
      useTool = true
      await drain({ ...params, toolUseContext: explicit })
      expect(requests).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol'])
    } finally {
      activeProvider.mockRestore()
      allowlist.mockRestore()
      saveCacheSafeParams(savedBefore)
      resetRoutingTally()
      clearSmartRoutingSessionDisable(getSessionId())
    }
  })

  test.each(['accepted', 'fresh', 'nested'] as const)('fork model budgets retain concrete identity: %s', async source => {
    const environment = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      OPENAI_API_KEY: 'test-key',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    }
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
    const previousCap = getSessionContextWindowOverride('gpt-5.6-sol')
    Object.assign(process.env, environment)
    clearSessionContextWindowOverride('gpt-5.6-sol')
    try {
      const requests: string[] = []
      const params = makeAliasParent(async function* ({ options }) {
        requests.push(options.requestModel ?? options.model)
        yield createAssistantMessage({ content: 'done' })
      })
      if (source !== 'fresh') await drain(params)
      let child = createSubagentContext(params.toolUseContext)
      if (source === 'nested') child = createSubagentContext(child)
      const prior = createAssistantMessage({ content: 'earlier provider reply' })
      prior.message.model = 'gpt-5.6-sol'
      prior.message.usage = { ...prior.message.usage, input_tokens: 150000,
        output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      const fork = { ...params, toolUseContext: child, querySource: 'side_question' as const,
        messages: [createUserMessage({ content: 'earlier question' }), prior,
          createUserMessage({ content: 'side question' })] }
      requests.length = 0
      expect((await drain(fork)).returned.reason).toBe('completed')
      expect(requests).toEqual(['codexplan'])
      expect(gatewayEffort(requests[0]!)).toBe('high')

      setSessionContextWindowOverride('gpt-5.6-sol', 60000)
      prior.message.usage.input_tokens = 90000
      requests.length = 0
      expect((await drain(fork)).returned.reason).toBe('blocking_limit')
      expect(requests).toEqual([])

      clearSessionContextWindowOverride('gpt-5.6-sol')
      delete process.env.DISABLE_AUTO_COMPACT
      delete process.env.DISABLE_COMPACT
      expect(isAutoCompactEnabled()).toBe(true)
      prior.message.usage.input_tokens = 100000
      // Run the real compaction eligibility policy at query's production boundary;
      // no summarizer/provider IO is needed when this history fits the model.
      let compact: boolean | undefined
      fork.deps = { ...params.deps!, autocompact: async (messages, context, _cache, querySource) => {
        compact = await shouldAutoCompact(messages, context.options.mainLoopModel, querySource)
        return { wasCompacted: false }
      } }
      await drain(fork)
      expect(compact).toBe(false)
    } finally {
      clearSessionContextWindowOverride('gpt-5.6-sol')
      if (previousCap !== undefined) setSessionContextWindowOverride('gpt-5.6-sol', previousCap)
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('fresh default forks retain the configured alias without overriding explicit children', async () => {
    const requests: string[] = []
    const params = makeAliasParent(async function* ({ options }) {
      requests.push(options.requestModel ?? options.model)
      yield createAssistantMessage({ content: 'done' })
    })
    // Retain the earlier regression: fork before any parent dispatch, so there
    // is no saved request. Fresh REPL and SDK contexts have this same shape.
    await drain({ ...params, toolUseContext: createSubagentContext(params.toolUseContext) })
    expect(requests).toEqual(['codexplan'])
    expect(gatewayEffort(requests[0]!)).toBe('high')

    const explicit = createSubagentContext(params.toolUseContext, {
      options: { ...params.toolUseContext.options },
    })
    // An explicit child can itself fork before dispatch. Its choice must not
    // be reconstructed from the root's codexplan setting.
    await drain({ ...params, toolUseContext: createSubagentContext(explicit) })
    await drain({ ...params, toolUseContext: explicit })
    expect(requests).toEqual(['codexplan', 'gpt-5.6-sol', 'gpt-5.6-sol'])
    expect(gatewayEffort(requests[1]!)).toBeUndefined()

    // A skill can replace options after the fork has inherited a selection.
    // The query must invalidate that request even for the same concrete model.
    const skill = createSubagentContext(params.toolUseContext)
    skill.options = { ...skill.options, mainLoopModel: 'gpt-5.6-sol' }
    await drain({ ...params, toolUseContext: skill })
    expect(requests.at(-1)).toBe('gpt-5.6-sol')
  })

  test('agent hook cannot overwrite the saved parent selection', async () => {
    const queryModule = await import('../query.js')
    const { execAgentHook } = await import('../utils/hooks/execAgentHook.js')
    const originalQuery = queryModule.query
    const savedBefore = getLastCacheSafeParams()
    const requests: string[] = []
    const params = makeAliasParent(async function* ({ options }) {
      requests.push(options.requestModel ?? options.model)
      yield createAssistantMessage({ content: options.querySource === 'hook_agent'
        ? [{ type: 'tool_use', id: 'toolu_hook_selection', name: 'StructuredOutput', input: { ok: true } }]
        : 'done' })
    })
    params.querySource = 'sdk'
    const hookQuery = spyOn(queryModule, 'query').mockImplementation(input => originalQuery({ ...input, deps: params.deps }))
    try {
      await drain(params)
      const parent = getLastCacheSafeParams()!.toolUseContext
      const hookResult = await execAgentHook(
        { type: 'agent', prompt: 'verify', model: 'gpt-4o', timeout: 2 },
        'Stop:0', 'Stop', '{}', parent.abortController.signal, parent, undefined, params.messages,
      )
      expect(hookResult.message?.type).toBe('attachment')
      if (hookResult.message?.type === 'attachment') {
        expect(hookResult.message.attachment.type).toBe('hook_success')
      }
      await drain({ ...params, toolUseContext: createSubagentContext(parent), querySource: 'side_question' })
      expect(requests).toEqual(['codexplan', 'gpt-4o', 'codexplan'])
      expect(gatewayEffort(requests[2]!)).toBe('high')
    } finally {
      hookQuery.mockRestore()
      saveCacheSafeParams(savedBefore)
    }
  })

  test('SDK fallback side question retains the configured request before a snapshot exists', async () => {
    const queryModule = await import('../query.js')
    const originalQuery = queryModule.query
    const { buildSideQuestionFallbackParams } = await import('../utils/queryContext.js')
    const { runSideQuestion } = await import('../utils/sideQuestion.js')
    const originalOverride = getMainLoopModelOverride()
    const allowlist = spyOn(modelAllowlist, 'isModelAllowed').mockReturnValue(true)
    const requests: string[] = []
    const params = makeAliasParent(async function* ({ options }) {
      requests.push(options.requestModel ?? options.model)
      yield createAssistantMessage({ content: 'done' })
    })
    const sideQuery = spyOn(queryModule, 'query').mockImplementation(input => originalQuery({ ...input, deps: params.deps }))
    try {
      setMainLoopModelOverride('codexplan')
      const cacheSafeParams = await buildSideQuestionFallbackParams({
        tools: [], commands: [], mcpClients: [], messages: params.messages,
        readFileState: params.toolUseContext.readFileState,
        getAppState: params.toolUseContext.getAppState, setAppState: () => {},
        customSystemPrompt: 'test system', appendSystemPrompt: undefined,
        thinkingConfig: { type: 'disabled' }, agents: [],
      })
      await runSideQuestion({ question: 'what happened?', cacheSafeParams })
      expect(requests).toEqual(['codexplan'])
      expect(gatewayEffort(requests[0]!)).toBe('high')
    } finally {
      sideQuery.mockRestore()
      allowlist.mockRestore()
      setMainLoopModelOverride(originalOverride)
    }
  })

  test.each([
    { selected: 'codexplan', route: undefined, current: 'codexplan', request: 'codexplan', effort: 'high' },
    { selected: 'codexplan', route: 'gpt-5.6-sol', current: 'codexplan', request: 'gpt-5.6-sol', effort: undefined },
    { selected: 'codexplan', route: 'gpt-5.6-sol?reasoning=low', current: 'codexplan', request: 'gpt-5.6-sol?reasoning=low', effort: 'low' },
    { selected: 'codexplan', route: 'gpt-4o', current: 'codexplan', request: 'gpt-4o', effort: undefined },
    { selected: 'codexplan', route: undefined, current: 'gpt-5.6-sol', request: 'gpt-5.6-sol', effort: undefined },
    { selected: 'gpt-5.6-sol', route: undefined, current: 'codexplan', request: 'codexplan', effort: 'high' },
    { selected: 'codexplan', route: 'provider-a-only', current: 'codexplan', request: 'codexplan', effort: 'high', switchProvider: true },
    { selected: 'codexplan', route: 'provider-a-only', current: 'codexplan', request: 'codexplan', effort: 'high', switchProvider: true, sdk: true },
    { selected: 'codexplan', route: 'gpt-5.6-sol?reasoning=low', current: 'codexplan', request: 'gpt-5.6-sol?reasoning=low', effort: 'low', sdk: true },
  ].map(entry => ({ switchProvider: false, sdk: false, ...entry })))('side question selection: $selected / $route -> $current; switch=$switchProvider SDK=$sdk', async ({ selected, route, current, request, effort, switchProvider, sdk }) => {
    let providerId = 'provider-a'
    const activeProvider = spyOn(providerProfiles, 'getActiveProviderProfile').mockImplementation(
      () => ({ id: providerId }) as ReturnType<typeof providerProfiles.getActiveProviderProfile>,
    )
    const queryModule = await import('../query.js')
    const sideQuestion = await import('../utils/sideQuestion.js')
    const config = await import('../utils/config.js')
    const { call } = await import('../commands/btw/btw.js')
    const { createRoot } = await import('../ink.js')
    const { AppStateProvider } = await import('../state/AppState.js')
    const originalQuery = queryModule.query
    const originalSideQuestion = sideQuestion.runSideQuestion
    const savedBefore = getLastCacheSafeParams()
    const requests: string[] = []
    const params = makeAliasParent(async function* ({ options }) {
      requests.push(options.requestModel ?? options.model)
      yield createAssistantMessage({ content: 'done' })
    })
    const state = params.toolUseContext.getAppState()
    params.toolUseContext.getAppState = () => ({
      ...state, mainLoopModel: selected,
      settings: providerId === 'provider-a' && route ? { smartRouting: { enabled: true, simpleModel: route, strongModel: route } } : {},
    })
    const allowlist = spyOn(modelAllowlist, 'isModelAllowed').mockReturnValue(true)
    clearSmartRoutingSessionDisable(getSessionId())
    resetRoutingTally()
    const completion = Promise.withResolvers<void>()
    const runtimeModels: string[] = []
    const sideQuery = spyOn(queryModule, 'query').mockImplementation(input => {
      if (input.querySource === 'side_question') runtimeModels.push(input.toolUseContext.options.mainLoopModel)
      return originalQuery({ ...input, deps: params.deps })
    })
    const runSideQuestion = spyOn(sideQuestion, 'runSideQuestion').mockImplementation(async input => {
      try {
        const result = await originalSideQuestion(input)
        completion.resolve()
        return result
      } catch (error) {
        completion.reject(error)
        throw error
      }
    })
    const saveConfig = spyOn(config, 'saveGlobalConfig').mockImplementation(() => {})
    const stdout = new PassThrough()
    stdout.resume()
    let root: Awaited<ReturnType<typeof createRoot>> | undefined
    const deadline = setTimeout(() => completion.reject(new Error('/btw did not finish')), 2000)
    try {
      root = await createRoot({ stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
      params.querySource = 'repl_main_thread'
      await drain(params)
      if (switchProvider) providerId = 'provider-b'
      // Commands get a fresh root context rather than the saved query object.
      const commandContext = makeAliasParent(async function* () {}).toolUseContext
      commandContext.getAppState = () => ({ ...state, mainLoopModel: current })
      if (sdk) {
        const saved = getLastCacheSafeParams()!
        await originalSideQuestion({ question: 'what happened?', cacheSafeParams: {
          ...saved, toolUseContext: { ...saved.toolUseContext, abortController: new AbortController() },
        } })
      } else {
        root.render(createElement(AppStateProvider, null, await call(
          () => {}, commandContext as Parameters<typeof call>[1], 'what happened?',
        )))
        await completion.promise
      }
      expect(requests).toEqual([route ?? selected, request])
      expect(gatewayEffort(requests[1]!)).toBe(effort)
      expect(runtimeModels).toEqual([request === 'codexplan' ? 'gpt-5.6-sol' : request])
    } finally {
      activeProvider.mockRestore()
      clearTimeout(deadline)
      root?.unmount()
      stdout.end()
      saveConfig.mockRestore()
      runSideQuestion.mockRestore()
      sideQuery.mockRestore()
      saveCacheSafeParams(savedBefore)
      allowlist.mockRestore()
      resetRoutingTally()
      clearSmartRoutingSessionDisable(getSessionId())
    }
  })
})

describe('agent step limits', () => {
  test.each([
    { route: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol', effort: undefined },
    { route: 'gpt-5.6-sol?reasoning=low', requestModel: 'gpt-5.6-sol?reasoning=low', effort: 'low' },
    { route: undefined, requestModel: 'codexplan', effort: 'high' },
  ])('cache-sharing forks preserve parent request selection: $requestModel', async ({ route, requestModel, effort }) => {
    const allowlist = spyOn(modelAllowlist, 'isModelAllowed').mockReturnValue(true)
    clearSmartRoutingSessionDisable(getSessionId())
    resetRoutingTally()
    try {
      const requests: Array<{ model: string; requestModel?: string; effort?: string }> = []
      const params = makeParams(async function* ({ options }) {
        const resolved = resolveProviderRequest({
          model: options.requestModel ?? options.model,
          processEnv: {
            CLAUDE_CODE_USE_OPENAI: '1',
            OPENAI_BASE_URL: 'https://gateway.example/v1',
            OPENAI_API_KEY: 'test-key',
          },
        })
        requests.push({ model: options.model, requestModel: options.requestModel, effort: resolved.reasoning?.effort })
        yield createAssistantMessage({
          content: requests.length === 1
            ? [{ type: 'tool_use', id: 'toolu_selection', name: 'Echo', input: { text: 'inspect' } }]
            : 'done',
        })
      }, [echoTool])
      delete params.toolUseContext.agentId
      const appState = params.toolUseContext.getAppState()
      params.toolUseContext.getAppState = () => ({
        ...appState,
        mainLoopModel: 'codexplan',
        settings: route ? {
          smartRouting: { enabled: true, simpleModel: route, strongModel: route },
        } : {},
      })
      params.toolUseContext.options.mainLoopModel = 'gpt-5.6-sol'
      params.toolUseContext.readFileState = createFileStateCacheWithSizeLimit(10)
      const expected = { model: route ?? 'gpt-5.6-sol', requestModel, effort }

      // Execute the parent: a resolved model name alone cannot prove which
      // request selection it used. Retain the original context across query's clones.
      await drain(params)
      expect(requests).toEqual([expected, expected])
      const parentOptions = params.toolUseContext.options
      let fork = params.toolUseContext
      for (let depth = 0; depth < 2; depth++) {
        fork = createSubagentContext(fork)
        requests.length = 0
        await drain({ ...params, toolUseContext: fork })
        expect(requests).toEqual([expected, expected])
      }
      expect(parentOptions.mainLoopModel).toBe(route ?? 'gpt-5.6-sol')
      expect(getRoutingTally().simple + getRoutingTally().strong).toBe(route ? 1 : 0)

      // Explicit agent options and a skill's spread-context override must win,
      // even when the requested runtime model equals the parent's resolved alias.
      for (const kind of ['agent', 'skill', 'in-place'] as const) {
        const options = { ...parentOptions, mainLoopModel: 'gpt-5.6-sol' }
        const source = kind === 'skill'
          ? { ...params.toolUseContext, options }
          : params.toolUseContext
        if (kind === 'in-place') source.options.mainLoopModel = 'gpt-4o'
        const overridden = createSubagentContext(source, kind === 'agent' ? { options } : undefined)
        requests.length = 0
        await drain({ ...params, toolUseContext: overridden })
        const model = kind === 'in-place' ? 'gpt-4o' : 'gpt-5.6-sol'
        expect(requests).toEqual([
          { model, requestModel: model, effort: undefined },
          { model, requestModel: model, effort: undefined },
        ])
      }
    } finally {
      allowlist.mockRestore()
      resetRoutingTally()
      clearSmartRoutingSessionDisable(getSessionId())
      echoCalls.length = 0
    }
  })

  test('smart routing preserves the sub-agent model through query and tool continuations', async () => {
    const allowlist = spyOn(modelAllowlist, 'isModelAllowed').mockReturnValue(true)
    clearSmartRoutingSessionDisable(getSessionId())
    resetRoutingTally()
    try {
      // The main-thread control proves routing is enabled in this fixture.
      for (const isSubagent of [false, true]) {
        const requests: Array<{ model: string; requestModel?: string }> = []
        const params = makeParams(async function* ({ options }) {
          requests.push({ model: options.model, requestModel: options.requestModel })
          yield createAssistantMessage({
            content: requests.length === 1
              ? [{ type: 'tool_use', id: 'toolu_routing', name: 'Echo', input: { text: 'inspect' } }]
              : 'done',
          })
        }, [echoTool])
        if (!isSubagent) delete params.toolUseContext.agentId
        const appState = params.toolUseContext.getAppState()
        params.toolUseContext.getAppState = () => ({
          ...appState,
          settings: {
            smartRouting: { enabled: true, simpleModel: 'gpt-5-mini', strongModel: 'gpt-5' },
          },
        })

        await drain(params)

        const expectedModel = isSubagent ? 'gpt-4o' : 'gpt-5'
        expect(requests).toEqual([
          { model: expectedModel, requestModel: expectedModel },
          { model: expectedModel, requestModel: expectedModel },
        ])
        expect(params.toolUseContext.options.mainLoopModel).toBe(expectedModel)

        if (!isSubagent) {
          // Cache-sharing forks inherit the routed turn model in options,
          // while the parent's app state still holds the session default.
          params.toolUseContext.readFileState = createFileStateCacheWithSizeLimit(10)
          const forkContext = createSubagentContext(params.toolUseContext)
          expect(forkContext.agentId).toBeTruthy()
          expect(forkContext.getAppState().mainLoopModel).toBe('gpt-4o')
          expect(forkContext.options.mainLoopModel).toBe('gpt-5')
          requests.length = 0
          await drain({ ...params, toolUseContext: forkContext })
          expect(requests).toEqual([
            { model: 'gpt-5', requestModel: 'gpt-5' },
            { model: 'gpt-5', requestModel: 'gpt-5' },
          ])
        }
      }
      // Only the main-thread turn contributes a routing decision.
      expect(getRoutingTally()).toMatchObject({ simple: 0, strong: 1 })
    } finally {
      allowlist.mockRestore()
      resetRoutingTally()
      clearSmartRoutingSessionDisable(getSessionId())
      echoCalls.length = 0
    }
  })

  test('shares one turn budget across query calls for the same prompt', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'done' })
    }

    await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    const { yielded, returned } = await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
    expect(returned).toEqual({ reason: 'max_turns', turnCount: 2 })
    expect(
      yielded.some(
        message =>
          message.type === 'attachment' &&
          message.attachment.type === 'max_turns_reached' &&
          message.attachment.turnCount === 2,
      ),
    ).toBe(true)
  })

  test('provider fallback retries do not consume another shared turn', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const params = makeParams(async function* () {
      modelCalls++
      if (modelCalls === 1) {
        throw new FallbackTriggeredError('primary-model', 'fallback-model')
      }
      yield createAssistantMessage({ content: 'completed on fallback' })
    })
    params.fallbackModel = 'fallback-model'

    const first = await drain({ ...params, turnBudget })
    const second = await drain({
      ...makeParams(async function* () {
        modelCalls++
        yield createAssistantMessage({ content: 'must not run' })
      }),
      turnBudget,
    })

    expect(first.returned).toEqual({ reason: 'completed' })
    expect(second.returned).toEqual({ reason: 'max_turns', turnCount: 2 })
    expect(modelCalls).toBe(2)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('a retry cannot dispatch after foreground ownership is aborted', async () => {
    let providerCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const params = makeParams(async function* () {})
    const abortController = params.toolUseContext.abortController
    params.deps!.callModel = async function* ({ options }) {
      if (options.onProviderRequestStart?.() === false) return
      providerCalls++

      // Simulate an abort during asynchronous retry preparation. The second
      // ownership check must reject even though this turn is already reserved.
      abortController.abort('background')
      if (options.onProviderRequestStart?.() === false) return
      providerCalls++
      yield createAssistantMessage({ content: 'stale retry' })
    }

    const result = await drain({ ...params, turnBudget })

    expect(result.returned).toEqual({ reason: 'aborted_streaming' })
    expect(providerCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('concurrent query calls cannot claim the same shared turn', async () => {
    let modelCalls = 0
    let preparationArrivals = 0
    let releasePreparation!: () => void
    const preparationBarrier = new Promise<void>(resolve => {
      releasePreparation = resolve
    })
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'one claimant' })
    }
    const makeConcurrentParams = (): QueryParams => {
      const params = makeParams(callModel)
      params.deps!.autocompact = async () => {
        preparationArrivals++
        if (preparationArrivals === 2) releasePreparation()
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            preparationBarrier,
            new Promise<void>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('preparation barrier timed out')),
                5_000,
              )
              timeout.unref?.()
            }),
          ])
        } finally {
          if (timeout !== undefined) clearTimeout(timeout)
        }
        return {
          wasCompacted: false,
          compactionResult: undefined,
          consecutiveFailures: undefined,
        }
      }
      return { ...params, turnBudget }
    }

    const results = await Promise.all([
      drain(makeConcurrentParams()),
      drain(makeConcurrentParams()),
    ])

    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
    expect(results.map(result => result.returned.reason).sort()).toEqual([
      'aborted_streaming',
      'completed',
    ])
  })

  test('does not charge a handoff aborted before its first request', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'continued in background' })
    }
    const foregroundParams = makeParams(callModel)
    foregroundParams.toolUseContext.abortController.abort('background')

    const foreground = await drain({
      ...foregroundParams,
      turnBudget,
    })
    const background = await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    expect(foreground.returned).toEqual({ reason: 'aborted_streaming' })
    expect(background.returned).toEqual({ reason: 'completed' })
    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('does not charge a handoff aborted while preparing its first request', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'continued in background' })
    }
    const foregroundParams = makeParams(callModel)
    const foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    foregroundParams.deps!.autocompact = async () => {
      foregroundAbortController.abort('background')
      return {
        wasCompacted: false,
        compactionResult: undefined,
        consecutiveFailures: undefined,
      }
    }

    const foreground = await drain({
      ...foregroundParams,
      turnBudget,
    })
    const background = await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    expect(foreground.returned).toEqual({ reason: 'aborted_streaming' })
    expect(background.returned).toEqual({ reason: 'completed' })
    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('does not charge a handoff aborted during provider preparation', async () => {
    let providerCalls = 0
    let releaseProviderPreparation!: () => void
    let providerPreparationStarted!: () => void
    const providerPreparation = new Promise<void>(resolve => {
      releaseProviderPreparation = resolve
    })
    const providerPreparationEntry = new Promise<void>(resolve => {
      providerPreparationStarted = resolve
    })
    const turnBudget = createQueryTurnBudget(1)
    const foregroundParams = makeParams(async function* () {})
    const foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    foregroundParams.deps!.callModel = async function* (input) {
      providerPreparationStarted()
      await providerPreparation
      if (input.options.onProviderRequestStart?.() === false) return
      providerCalls++
      yield createAssistantMessage({ content: 'stale foreground request' })
    }

    const foregroundPromise = drain({
      ...foregroundParams,
      turnBudget,
    })
    await providerPreparationEntry
    foregroundAbortController.abort('background')
    releaseProviderPreparation()
    const foreground = await foregroundPromise
    const background = await drain({
      ...makeParams(async function* () {
        providerCalls++
        yield createAssistantMessage({ content: 'continued in background' })
      }),
      turnBudget,
    })

    expect(foreground.returned).toEqual({ reason: 'aborted_streaming' })
    expect(background.returned).toEqual({ reason: 'completed' })
    expect(providerCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('background handoff emits the final-turn cap only once', async () => {
    let modelCalls = 0
    let foregroundAbortController: AbortController
    const backgroundingTool = buildTool({
      name: 'Background',
      inputSchema: z.object({}),
      maxResultSizeChars: Infinity,
      async description() {
        return 'Background the query'
      },
      async prompt() {
        return ''
      },
      async call() {
        foregroundAbortController.abort('background')
        return { data: 'backgrounded' }
      },
      mapToolResultToToolResultBlockParam(content, toolUseID) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content: String(content),
        }
      },
      renderToolUseMessage() {
        return null
      },
      renderToolResultMessage() {
        return null
      },
    })
    const foregroundParams = makeParams(
      async function* () {
        modelCalls++
        yield createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_background_1',
              name: 'Background',
              input: {},
            },
          ],
        })
      },
      [backgroundingTool],
    )
    foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    const turnBudget = createQueryTurnBudget(1)

    const foreground = await drain({
      ...foregroundParams,
      turnBudget,
    })
    const background = await drain({
      ...makeParams(async function* () {
        modelCalls++
        yield createAssistantMessage({ content: 'must not run' })
      }),
      turnBudget,
    })
    const capAttachments = [...foreground.yielded, ...background.yielded].filter(
      message =>
        message.type === 'attachment' &&
        message.attachment.type === 'max_turns_reached',
    )

    expect(foreground.returned).toEqual({ reason: 'aborted_tools' })
    expect(background.returned).toEqual({
      reason: 'max_turns',
      turnCount: 2,
    })
    expect(modelCalls).toBe(1)
    expect(capAttachments).toHaveLength(1)
    expect(background.yielded).toContain(capAttachments[0])
  })

  test('late background handoff after attachments still emits one final-turn cap', async () => {
    dequeueAll()
    let foregroundAbortController: AbortController
    const queueingTool = buildTool({
      name: 'QueuePrompt',
      inputSchema: z.object({}),
      maxResultSizeChars: Infinity,
      async description() {
        return 'Queue a prompt during tool execution'
      },
      async prompt() {
        return ''
      },
      async call() {
        enqueue({ value: 'queued during tool execution', mode: 'prompt' })
        return { data: 'queued' }
      },
      mapToolResultToToolResultBlockParam(content, toolUseID) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content: String(content),
        }
      },
      renderToolUseMessage() {
        return null
      },
      renderToolResultMessage() {
        return null
      },
    })
    const foregroundParams = makeParams(
      async function* () {
        yield createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_queue_prompt_1',
              name: 'QueuePrompt',
              input: {},
            },
          ],
        })
      },
      [queueingTool],
    )
    foregroundParams.querySource = 'repl_main_thread'
    foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    const turnBudget = createQueryTurnBudget(1)
    const foregroundGenerator = query({ ...foregroundParams, turnBudget })
    type ForegroundNext = Awaited<
      ReturnType<typeof foregroundGenerator.next>
    >
    type ForegroundYield = ForegroundNext extends IteratorResult<infer Y, unknown>
      ? Y
      : never
    const foregroundYielded: ForegroundYield[] = []

    try {
      let foregroundReturned: Terminal | undefined
      while (true) {
        const next = await foregroundGenerator.next()
        if (next.done) {
          foregroundReturned = next.value
          break
        }
        foregroundYielded.push(next.value)
        if (
          next.value.type === 'attachment' &&
          next.value.attachment.type === 'queued_command'
        ) {
          // This yield is after the post-tool abort check and immediately
          // before the terminal max-turn check that used to double-emit.
          foregroundAbortController.abort('background')
        }
      }

      const background = await drain({
        ...makeParams(async function* () {
          yield createAssistantMessage({ content: 'must not run' })
        }),
        turnBudget,
      })
      const capAttachments = [
        ...foregroundYielded,
        ...background.yielded,
      ].filter(
        message =>
          message.type === 'attachment' &&
          message.attachment.type === 'max_turns_reached',
      )

      expect(foregroundReturned).toEqual({ reason: 'aborted_tools' })
      expect(background.returned).toEqual({
        reason: 'max_turns',
        turnCount: 2,
      })
      expect(capAttachments).toHaveLength(1)
      expect(background.yielded).toContain(capAttachments[0])
    } finally {
      dequeueAll()
    }
  })

  test('without a configured limit, tool use behavior is unchanged', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { yielded, returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'first' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_echo_2',
                  name: 'Echo',
                  input: { text: 'second' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({ content: 'done' })
        },
        [echoTool],
      ),
    )

    expect(returned.reason).toBe('completed')
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['first', 'second'])
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          message?.isMeta &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('configured step limit'),
      ),
    ).toBe(false)
  })

  test('invalid configured limit is ignored safely', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'first' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_echo_2',
                  name: 'Echo',
                  input: { text: 'second' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({ content: 'done' })
        },
        [echoTool],
        { maxSteps: 0, agentType: 'general-purpose' },
      ),
    )

    expect(returned.reason).toBe('completed')
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['first', 'second'])
  })

  test('configured limit stops further tool calls and requests a no-tools summary', async () => {
    echoCalls.length = 0
    let modelCalls = 0
    const requestToolCounts: number[] = []
    const requestMessageNormalizationToolCounts: number[] = []
    const requestMessages: any[][] = []

    const { yielded, returned } = await drain(
      makeParams(
        async function* ({ messages, options, tools }) {
          modelCalls++
          requestToolCounts.push(tools.length)
          requestMessageNormalizationToolCounts.push(
            options.messageNormalizationTools?.length ?? 0,
          )
          requestMessages.push(messages)
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_echo_2',
                  name: 'Echo',
                  input: { text: 'blocked' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content:
              'Completed: checked the allowed step. Findings: limit reached. Remaining tasks: continue later. Another run needed: yes.',
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(requestToolCounts).toEqual([1, 0])
    expect(requestMessageNormalizationToolCounts).toEqual([0, 1])
    expect(echoCalls).toEqual(['allowed'])
    expect(countToolUses(yielded)).toBe(1)
    expect(
      yielded.some(
        message =>
          message?.type === 'assistant' &&
          message.message.content.some(
            part =>
              part.type === 'text' &&
              part.text.includes('Completed: checked the allowed step') &&
              part.text.includes('Another run needed: yes'),
          ),
      ),
    ).toBe(true)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part: any) =>
              part.type === 'tool_result' &&
              part.tool_use_id === 'toolu_echo_2' &&
              part.is_error === true &&
              String(part.content).includes('Agent step limit reached'),
          ),
      ),
    ).toBe(true)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          message?.isMeta &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('completed work') &&
          message.message.content.includes('remaining tasks') &&
          message.message.content.includes('another run is needed'),
      ),
    ).toBe(true)
    expect(
      requestMessages[1]?.some(
        message =>
          message.type === 'user' &&
          message.isMeta &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('configured step limit'),
      ),
    ).toBe(true)

    const normalizedSecondRequest = normalizeMessagesForAPI(
      requestMessages[1] as any,
      [echoTool],
    )
    const summaryUser = normalizedSecondRequest.find(
      message =>
        message.type === 'user' &&
        Array.isArray(message.message.content) &&
        message.message.content.some(
          part =>
            part.type === 'text' &&
            part.text.includes('completed work') &&
            part.text.includes('another run is needed'),
        ),
    )
    expect(summaryUser).toBeDefined()
    if (
      summaryUser?.type === 'user' &&
      Array.isArray(summaryUser.message.content)
    ) {
      const toolResultText = summaryUser.message.content
        .filter(part => part.type === 'tool_result')
        .map(part => String(part.content))
        .join('\n')
      expect(toolResultText).not.toContain('completed work')
    }
  })

  test('step count accumulates across turns before later tool calls are blocked', async () => {
    echoCalls.length = 0
    let modelCalls = 0
    const requestToolCounts: number[] = []
    const requestMessageNormalizationToolCounts: number[] = []

    const { yielded, returned } = await drain(
      makeParams(
        async function* ({ options, tools }) {
          modelCalls++
          requestToolCounts.push(tools.length)
          requestMessageNormalizationToolCounts.push(
            options.messageNormalizationTools?.length ?? 0,
          )
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_turn_1',
                  name: 'Echo',
                  input: { text: 'first' },
                },
              ],
            })
            return
          }
          if (modelCalls === 2) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_turn_2_allowed',
                  name: 'Echo',
                  input: { text: 'second' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_turn_2_blocked',
                  name: 'Echo',
                  input: { text: 'third' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content:
              'Completed work: handled two allowed steps. Findings: a later step was blocked. Remaining tasks: continue later. Another run needed: yes.',
          })
        },
        [echoTool],
        { maxSteps: 2, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 3,
      stepsUsed: 2,
      maxSteps: 2,
    })
    expect(modelCalls).toBe(3)
    expect(requestToolCounts).toEqual([1, 1, 0])
    expect(requestMessageNormalizationToolCounts).toEqual([0, 0, 1])
    expect(echoCalls).toEqual(['first', 'second'])
    expect(countToolUses(yielded)).toBe(2)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part: any) =>
              part.type === 'tool_result' &&
              part.tool_use_id === 'toolu_turn_2_blocked' &&
              part.is_error === true &&
              String(part.content).includes('Agent step limit reached'),
          ),
      ),
    ).toBe(true)
    expect(
      yielded.some(
        message =>
          message?.type === 'assistant' &&
          message.message.content.some(
            part =>
              part.type === 'text' &&
              part.text.includes('Completed work: handled two allowed steps') &&
              part.text.includes('Another run needed: yes'),
          ),
      ),
    ).toBe(true)
  })

  test('multiple over-limit tool calls do not trip the failure-loop guard', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_allowed',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
                ...[1, 2, 3, 4].map(i => ({
                  type: 'tool_use' as const,
                  id: `toolu_echo_blocked_${i}`,
                  name: 'Echo',
                  input: { text: `blocked-${i}` },
                })),
              ],
            })
            return
          }
          yield createAssistantMessage({
            content:
              'Completed work: one allowed step. Findings: extra calls were blocked. Remaining tasks: continue later. Another run needed: yes.',
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['allowed'])
  })

  test('forced summary turn cannot execute more tools', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { yielded, returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content: [
              {
                type: 'text',
                text: 'I should inspect one more thing first.',
                citations: null,
              },
              {
                type: 'tool_use',
                id: 'toolu_echo_summary',
                name: 'Echo',
                input: { text: 'must-not-run' },
              },
            ],
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['allowed'])
    expect(countToolUses(yielded)).toBe(1)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part: any) =>
              part.type === 'tool_result' &&
              part.tool_use_id === 'toolu_echo_summary' &&
              part.is_error === true &&
              String(part.content).includes('Agent step limit reached'),
          ),
      ),
    ).toBe(true)

    const finalAssistantMessage = yielded
      .filter(message => message?.type === 'assistant')
      .at(-1)
    expect(
      finalAssistantMessage?.message.content.some(
        part =>
          part.type === 'text' &&
          part.text.includes('Completed work: Agent') &&
          part.text.includes(
            'Findings: 1 additional tool call was blocked',
          ) &&
          part.text.includes('Another run needed: yes'),
      ),
    ).toBe(true)
  })

  test('forced summary turn does not add a duplicate synthetic summary after a valid model summary', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { yielded, returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content: [
              {
                type: 'text',
                text: 'Completed work: one step.',
                citations: null,
              },
              {
                type: 'text',
                text: 'Findings: the limit was reached.',
                citations: null,
              },
              {
                type: 'text',
                text: 'Remaining tasks: continue later.',
                citations: null,
              },
              {
                type: 'text',
                text: 'Another run needed: yes.',
                citations: null,
              },
              {
                type: 'tool_use',
                id: 'toolu_echo_summary',
                name: 'Echo',
                input: { text: 'must-not-run' },
              },
            ],
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['allowed'])
    expect(countToolUses(yielded)).toBe(1)

    const assistantMessages = yielded.filter(
      message => message?.type === 'assistant',
    )
    expect(assistantMessages).toHaveLength(2)
    const finalAssistantText = assistantMessages
      .at(-1)
      ?.message.content.filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
    expect(finalAssistantText).toContain('Completed work: one step')
    expect(finalAssistantText).toContain('Another run needed: yes')
    expect(
      assistantMessages.some(message =>
        message.message.content.some(
          part =>
            part.type === 'text' &&
            part.text.includes("Agent 'general-purpose' reached"),
        ),
      ),
    ).toBe(false)
  })

  test('real tool output with the readable limit prefix still counts as a tool use', () => {
    const messages = [
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_real_output',
            name: 'Echo',
            input: { text: 'prefix-collision' },
          },
        ],
      }),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_real_output',
            content: `${AGENT_STEP_LIMIT_TOOL_RESULT_PREFIX}: this is real tool output, not synthetic`,
          },
        ],
      }),
    ]

    expect(countToolUses(messages)).toBe(1)
  })
})
