/**
 * Coverage for the /ctx command surface added in PR #1610.
 *
 * Reviewer (P2) asked for tests that lock down:
 *   1. Command registration in the public COMMANDS list (i.e. it left
 *      INTERNAL_ONLY_COMMANDS and now resolves via getCommands()).
 *   2. Aliases are wired so /ctx, /ctx_viz, and /context-viz all resolve
 *      to the same command.
 *   3. The remote-mode and bridge allowlists accept /ctx, so it works
 *      in --remote and from the iOS/mobile client.
 *   4. supportsNonInteractive is true, so the headless -p path
 *      dispatches to ctx-noninteractive.ts.
 *   5. The non-interactive call() renders the report sections so a
 *      future refactor cannot silently drop a header or category row.
 *
 * The existing commands.test.ts file did not exercise any of this, so a
 * future refactor could silently demote /ctx back to internal-only or
 * drop the bridge/remote flags without any test failing.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  BRIDGE_SAFE_COMMANDS,
  clearCommandMemoizationCaches,
  findCommand,
  getCommand,
  getCommands,
  hasCommand,
  INTERNAL_ONLY_COMMANDS,
  isBridgeSafeCommand,
  REMOTE_SAFE_COMMANDS,
} from '../../commands.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import type { RenderInput } from './ctx-noninteractive.js'

function findCtx(commands: ReturnType<typeof getCommands> extends Promise<infer T> ? T : never) {
  return commands.find(c => c.name === 'ctx')
}

beforeEach(() => {
  delete process.env['USER_TYPE']
  delete process.env['IS_DEMO']
  clearCommandMemoizationCaches()
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
})

afterEach(() => {
  mock.restore()
  resetSettingsCache()
  clearCommandMemoizationCaches()
})

describe('/ctx command surface (PR #1610)', () => {
  test('is registered in the public COMMANDS list for normal users', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-ctx-pub-'))
    try {
      const cmds = await getCommands(cwd)
      expect(hasCommand('ctx', cmds)).toBe(true)
      const internalNames = INTERNAL_ONLY_COMMANDS.map(c => c.name)
      // /ctx was promoted out of INTERNAL_ONLY_COMMANDS in this PR — keep it out.
      expect(internalNames).not.toContain('ctx')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('exposes /ctx, /ctx_viz, and /context-viz as resolving to the same command', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-ctx-aliases-'))
    try {
      const cmds = await getCommands(cwd)
      const ctx = getCommand('ctx', cmds)
      expect(ctx.name).toBe('ctx')
      expect(ctx.aliases).toEqual(expect.arrayContaining(['ctx_viz', 'context-viz']))

      for (const alias of ['ctx_viz', 'context-viz']) {
        // findCommand + getCommand both resolve aliases back to /ctx.
        expect(findCommand(alias, cmds)?.name).toBe('ctx')
        expect(getCommand(alias, cmds).name).toBe('ctx')
        expect(hasCommand(alias, cmds)).toBe(true)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('is in REMOTE_SAFE_COMMANDS so it works under --remote', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-ctx-remote-'))
    try {
      const cmds = await getCommands(cwd)
      const ctx = findCtx(cmds)
      expect(ctx).toBeDefined()
      expect(REMOTE_SAFE_COMMANDS.has(ctx!)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('is in BRIDGE_SAFE_COMMANDS so it is reachable from the mobile/web bridge', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-ctx-bridge-'))
    try {
      const cmds = await getCommands(cwd)
      const ctx = findCtx(cmds)
      expect(ctx).toBeDefined()
      // isBridgeSafeCommand is the runtime gate in the bridge inbound path;
      // the allowlist membership is the source of truth.
      expect(BRIDGE_SAFE_COMMANDS.has(ctx!)).toBe(true)
      expect(isBridgeSafeCommand(ctx!)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('supports headless / non-interactive dispatch (supportsNonInteractive: true)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-ctx-nonint-'))
    try {
      const cmds = await getCommands(cwd)
      const ctx = findCtx(cmds)
      expect(ctx).toBeDefined()
      // Narrow from discriminated union so TS allows property access
      const cmd = ctx!
      if (cmd.type !== 'local') throw new Error('expected local command')
      // Drives the -p / piped-arg path into ctx-noninteractive.ts.
      expect(cmd.supportsNonInteractive).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('is a local command that lazy-loads ctx-noninteractive.ts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-ctx-load-'))
    try {
      const cmds = await getCommands(cwd)
      const ctx = findCtx(cmds)
      expect(ctx).toBeDefined()
      const cmd = ctx!
      if (cmd.type !== 'local') throw new Error('expected local command')
      // `load` returns a dynamic import. Call it and verify the
      // non-interactive module's `call` function is exported.
      const mod = await cmd.load()
      expect(typeof mod.call).toBe('function')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('call() renders the report sections and category bars', async () => {
    // Call renderCtxReport directly with a hand-crafted RenderInput so
    // the test needs zero mock.module() calls — avoiding process-global
    // mock pollution entirely.
    const mod = (await import(
      `./ctx-noninteractive.ts?render=${Date.now()}-${Math.random()}`
    )) as {
      renderCtxReport: (d: RenderInput) => string
    }

    const out = mod.renderCtxReport({
      contextData: {
        categories: [
          { name: 'System prompt', tokens: 7_800, color: 'claude' },
          { name: 'System tools', tokens: 15_500, color: 'promptBorder' },
          { name: 'Memory files', tokens: 956, color: 'inactive' },
          { name: 'Messages', tokens: 84, color: 'permission' },
          { name: 'Free space', tokens: 50_000, color: 'subtle' },
          { name: 'System tools (deferred)', tokens: 4_000, color: 'inactive', isDeferred: true },
        ],
        totalTokens: 74_340,
        maxTokens: 131_072,
        rawMaxTokens: 131_072,
        percentage: 57,
        gridRows: [],
        model: 'claude-sonnet-4',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        apiUsage: null,
        isAutoCompactEnabled: true,
        autoCompactThreshold: 167_000,
      },
      contextWindow: 200_000,
      contextWindowSource: 'default',
      effectiveContext: 180_000,
      autoCompactThreshold: 167_000,
      messageCountCompactAt: 200,
      messageCountHardCap: 1000,
      maxOutput: { default: 32_000, upperLimit: 64_000 },
      canonicalName: 'claude-sonnet-4',
      autoCompactEnabled: true,
      sessionInput: 0,
      sessionOutput: 0,
      sessionCacheRead: 0,
      sessionCacheCreation: 0,
      sessionCost: 0,
      sessionApiDuration: 0,
      sessionWallDuration: 0,
      linesAdded: 0,
      linesRemoved: 0,
      modelUsageMap: {},
    })

    // Header line — confirms the model name is rendered.
    expect(out).toContain('Context Window:')
    // Window Capacity block (4 bullets).
    expect(out).toContain('Window Capacity')
    expect(out).toContain('Context window:')
    expect(out).toContain('Effective context:')
    expect(out).toContain('Max output:')
    // Auto-compact line is rendered because the fixture sets
    // isAutoCompactEnabled: true.
    expect(out).toContain('Auto-compact at:')
    expect(out).toContain('Window source:      default')
    expect(out).not.toContain('Model limit unknown')
    expect(out).toMatch(/Message-count at: +\S*200\S* messages \(hard cap 1000\)/)
    // Current Context block + total.
    expect(out).toContain('Current Context (what the model sees)')
    expect(out).toContain('Total:')
    expect(out).toMatch(/used\)/)
    // Each non-zero category in the fixture appears in the output.
    for (const cat of [
      'System prompt',
      'System tools',
      'Memory files',
      'Messages',
    ]) {
      expect(out).toContain(cat)
    }
    // Bar characters — width 30, ratio = tokens / contextWindow (200k).
    // With the fixture:
    //   System tools  15.5k / 200k →  2 filled
    //   System prompt  7.8k  / 200k →  1 filled
    //   Memory files   956   / 200k →  0 filled
    //   Messages       84    / 200k →  0 filled
    expect(out).toContain('█'.repeat(2) + '░'.repeat(28))
    expect(out).toContain('█'.repeat(1) + '░'.repeat(29))
    expect(out).toMatch(/░{30}/)
    // Footer cross-references the sibling commands.
    expect(out).toContain('/context')
    expect(out).toContain('/cost')
    expect(out).toContain('/stats')
    // Capacity rows (Free space, Autocompact buffer, Compact buffer) should be filtered out.
    expect(out).not.toContain('Free space')
    // Deferred tool categories (MCP tools (deferred), System tools (deferred))
    // should be filtered out since they aren't in the model-visible context.
    expect(out).not.toContain('System tools (deferred)')
  })

  test('reports the context-window source and disabled compaction triggers', async () => {
    const mod = (await import(
      `./ctx-noninteractive.ts?render=${Date.now()}-${Math.random()}`
    )) as {
      renderCtxReport: (d: RenderInput) => string
    }
    const input = {
      contextData: {
        categories: [],
        totalTokens: 1_000,
        maxTokens: 128_000,
        rawMaxTokens: 128_000,
        percentage: 1,
        gridRows: [],
        model: 'custom-model',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        apiUsage: null,
        isAutoCompactEnabled: false,
        autoCompactThreshold: 95_000,
      },
      contextWindow: 128_000,
      effectiveContext: 108_000,
      autoCompactThreshold: 95_000,
      maxOutput: { default: 8_000, upperLimit: 8_000 },
      canonicalName: 'custom-model',
      autoCompactEnabled: false,
      sessionInput: 0,
      sessionOutput: 0,
      sessionCacheRead: 0,
      sessionCacheCreation: 0,
      sessionCost: 0,
      sessionApiDuration: 0,
      sessionWallDuration: 0,
      linesAdded: 0,
      linesRemoved: 0,
      modelUsageMap: {},
    } satisfies Omit<RenderInput, 'contextWindowSource' | 'messageCountCompactAt' | 'messageCountHardCap'>

    const fallback = mod.renderCtxReport({
      ...input,
      contextWindowSource: 'fallback',
      messageCountCompactAt: 1000,
      messageCountHardCap: 1000,
    })
    expect(fallback).toContain('Window source:      fallback for unknown model')
    expect(fallback).toContain('/set-context-window')
    expect(fallback).toMatch(/Auto-compact at: +\S*off/)
    expect(fallback).toMatch(/Message-count at: +\S*1000\S* messages \(hard cap\)/)

    const discovered = mod.renderCtxReport({
      ...input,
      contextWindowSource: 'discovery',
      messageCountCompactAt: 0,
      messageCountHardCap: 0,
    })
    expect(discovered).toContain('Window source:      provider model discovery')
    expect(discovered).not.toContain('Model limit unknown')
    expect(discovered).toMatch(/Message-count at: +\S*off/)
  })
})
