import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const originalSimpleEnv = process.env.CLAUDE_CODE_SIMPLE
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const hadOriginalMacro = Object.hasOwn(globalThis, 'MACRO')

let clearSystemPromptSections: typeof import('./systemPromptSections.js').clearSystemPromptSections
let getSystemPrompt: typeof import('./prompts.js').getSystemPrompt
let DEFAULT_AGENT_PROMPT: typeof import('./prompts.js').DEFAULT_AGENT_PROMPT
let CLI_SYSPROMPT_PREFIXES: typeof import('./system.js').CLI_SYSPROMPT_PREFIXES
let getCLISyspromptPrefix: typeof import('./system.js').getCLISyspromptPrefix
let CLAUDE_CODE_GUIDE_AGENT:
  typeof import('../tools/AgentTool/built-in/claudeCodeGuideAgent.js').CLAUDE_CODE_GUIDE_AGENT
let GENERAL_PURPOSE_AGENT:
  typeof import('../tools/AgentTool/built-in/generalPurposeAgent.js').GENERAL_PURPOSE_AGENT
let EXPLORE_AGENT:
  typeof import('../tools/AgentTool/built-in/exploreAgent.js').EXPLORE_AGENT
let PLAN_AGENT: typeof import('../tools/AgentTool/built-in/planAgent.js').PLAN_AGENT
let STATUSLINE_SETUP_AGENT:
  typeof import('../tools/AgentTool/built-in/statuslineSetup.js').STATUSLINE_SETUP_AGENT

beforeAll(async () => {
  await acquireSharedMutationLock('constants/promptIdentity.test.ts')

  // MACRO is replaced at build time by Bun.define but not in test mode.
  // Define it globally under the shared lock before importing modules that use it.
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: new Date().toISOString(),
    ISSUES_EXPLAINER:
      'report the issue at https://github.com/Twigpine/openclaude/issues',
    PACKAGE_URL: '@gitlawb/openclaude',
    NATIVE_PACKAGE_URL: undefined,
  }

  ;({ clearSystemPromptSections } = await import('./systemPromptSections.js'))
  ;({ getSystemPrompt, DEFAULT_AGENT_PROMPT } = await import('./prompts.js'))
  ;({ CLI_SYSPROMPT_PREFIXES, getCLISyspromptPrefix } = await import('./system.js'))
  ;({ CLAUDE_CODE_GUIDE_AGENT } = await import(
    '../tools/AgentTool/built-in/claudeCodeGuideAgent.js'
  ))
  ;({ GENERAL_PURPOSE_AGENT } = await import(
    '../tools/AgentTool/built-in/generalPurposeAgent.js'
  ))
  ;({ EXPLORE_AGENT } = await import(
    '../tools/AgentTool/built-in/exploreAgent.js'
  ))
  ;({ PLAN_AGENT } = await import('../tools/AgentTool/built-in/planAgent.js'))
  ;({ STATUSLINE_SETUP_AGENT } = await import(
    '../tools/AgentTool/built-in/statuslineSetup.js'
  ))
})

afterAll(() => {
  try {
    if (hadOriginalMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
  } finally {
    releaseSharedMutationLock()
  }
})

afterEach(() => {
  if (originalSimpleEnv === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = originalSimpleEnv
  }
  clearSystemPromptSections()
})

test('CLI identity prefixes describe OpenClaude instead of Claude Code', () => {
  expect(getCLISyspromptPrefix()).toContain('OpenClaude')
  expect(getCLISyspromptPrefix()).not.toContain('Claude Code')
  expect(getCLISyspromptPrefix()).not.toContain("Anthropic's official CLI for Claude")

  for (const prefix of CLI_SYSPROMPT_PREFIXES) {
    expect(prefix).toContain('OpenClaude')
    expect(prefix).not.toContain('Claude Code')
    expect(prefix).not.toContain("Anthropic's official CLI for Claude")
  }
})

test('simple mode identity describes OpenClaude instead of Claude Code', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'

  const prompt = await getSystemPrompt([], 'gpt-4o')

  expect(prompt[0]).toContain('OpenClaude')
  expect(prompt[0]).not.toContain('Claude Code')
  expect(prompt[0]).not.toContain("Anthropic's official CLI for Claude")
})

test('system prompt model identity updates when model changes mid-session', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  clearSystemPromptSections()

  const firstPrompt = await getSystemPrompt([], 'old-test-model')
  const secondPrompt = await getSystemPrompt([], 'new-test-model')

  const firstText = firstPrompt.join('\n')
  const secondText = secondPrompt.join('\n')

  expect(firstText).toContain('You are powered by the model old-test-model.')
  expect(secondText).toContain('You are powered by the model new-test-model.')
  expect(secondText).not.toContain('You are powered by the model old-test-model.')
})

test('system prompt includes immediate-tool-use directive in non-REPL mode', async () => {
  const originalReplMode = process.env.CLAUDE_REPL_MODE
  const originalCodeRepl = process.env.CLAUDE_CODE_REPL
  process.env.CLAUDE_CODE_REPL = '0'

  try {
    const prompt = await getSystemPrompt([], 'gpt-4o')
    const text = prompt.join('\n')
    expect(text).toContain('If you intend to use a tool to accomplish a task or analyze a file, use the tool IMMEDIATELY. Do not output a message explaining what you are going to do and then stop to wait for the user to prompt you again. Always call the tool in the same response.')
  } finally {
    if (originalReplMode === undefined) {
      delete process.env.CLAUDE_REPL_MODE
    } else {
      process.env.CLAUDE_REPL_MODE = originalReplMode
    }
    if (originalCodeRepl === undefined) {
      delete process.env.CLAUDE_CODE_REPL
    } else {
      process.env.CLAUDE_CODE_REPL = originalCodeRepl
    }
  }
})

test('system prompt includes immediate-tool-use directive in REPL mode', async () => {
  const originalReplMode = process.env.CLAUDE_REPL_MODE
  const originalCodeRepl = process.env.CLAUDE_CODE_REPL
  delete process.env.CLAUDE_CODE_REPL
  process.env.CLAUDE_REPL_MODE = '1'

  try {
    const prompt = await getSystemPrompt([], 'gpt-4o')
    const text = prompt.join('\n')
    expect(text).toContain('If you intend to use a tool to accomplish a task or analyze a file, use the tool IMMEDIATELY. Do not output a message explaining what you are going to do and then stop to wait for the user to prompt you again. Always call the tool in the same response.')
  } finally {
    if (originalReplMode === undefined) {
      delete process.env.CLAUDE_REPL_MODE
    } else {
      process.env.CLAUDE_REPL_MODE = originalReplMode
    }
    if (originalCodeRepl === undefined) {
      delete process.env.CLAUDE_CODE_REPL
    } else {
      process.env.CLAUDE_CODE_REPL = originalCodeRepl
    }
  }
})

test('built-in agent prompts describe OpenClaude instead of Claude Code', () => {
  expect(DEFAULT_AGENT_PROMPT).toContain('OpenClaude')
  expect(DEFAULT_AGENT_PROMPT).not.toContain('Claude Code')
  expect(DEFAULT_AGENT_PROMPT).not.toContain("Anthropic's official CLI for Claude")

  const generalPrompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(generalPrompt).toContain('OpenClaude')
  expect(generalPrompt).not.toContain('Claude Code')
  expect(generalPrompt).not.toContain("Anthropic's official CLI for Claude")

  const explorePrompt = EXPLORE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(explorePrompt).toContain('OpenClaude')
  expect(explorePrompt).not.toContain('Claude Code')
  expect(explorePrompt).not.toContain("Anthropic's official CLI for Claude")

  const planPrompt = PLAN_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(planPrompt).toContain('OpenClaude')
  expect(planPrompt).not.toContain('Claude Code')

  const statuslinePrompt = STATUSLINE_SETUP_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(statuslinePrompt).toContain('OpenClaude')
  expect(statuslinePrompt).not.toContain('Claude Code')

  const guidePrompt = CLAUDE_CODE_GUIDE_AGENT.getSystemPrompt({
    toolUseContext: {
      options: {
        commands: [],
        agentDefinitions: { activeAgents: [] },
        mcpClients: [],
      } as never,
    },
  })
  expect(guidePrompt).toContain('OpenClaude')
  expect(guidePrompt).toContain('You are the OpenClaude guide agent.')
  expect(guidePrompt).toContain('**OpenClaude** (the CLI tool)')
  expect(guidePrompt).not.toContain('You are the Claude guide agent.')
  expect(guidePrompt).not.toContain('**Claude Code** (the CLI tool)')
})
