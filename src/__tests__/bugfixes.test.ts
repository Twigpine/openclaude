/**
 * Tests for Bug Fixes applied to openclaude.
 *
 * Covers:
 * 1. Gemini `store: false` rejection fix
 * 2. Session timeout / 500 error fix (stream idle timeout)
 * 3. Agent loop continuation nudge
 * 4. Web search result count improvements
 */

import { afterEach, describe, test, expect, mock } from 'bun:test'
import { resolve } from 'path'
import {
  clearRegisteredHooks,
  registerHookCallbacks,
} from '../bootstrap/state.js'
import { getMatchingHooks } from '../utils/hooks.js'
import type { PluginHookMatcher } from '../utils/settings/types.js'

const SRC = resolve(import.meta.dir, '..')

// Real channelAllowlist module — captured before mocking so describe-block
// afterEach can re-register it. Must be at module scope so describe() is
// synchronous (Bun registers tests synchronously from describe callbacks).
const _realChannelAllowlist = await import(
  `../services/mcp/channelAllowlist.js?real=${Date.now()}-${Math.random()}`
)
const file = (relative: string) => Bun.file(resolve(SRC, relative))

// ---------------------------------------------------------------------------
// Fix 1: Gemini `store: false` rejection
// ---------------------------------------------------------------------------
describe('Gemini store field fix', () => {
  test('descriptor-backed shim config strips store for Gemini and Mistral routes', async () => {
    const runtimeMetadata = await file('integrations/runtimeMetadata.ts').text()
    const geminiDescriptor = await file('integrations/vendors/gemini.ts').text()
    const mistralDescriptor = await file('integrations/gateways/mistral.ts').text()

    expect(runtimeMetadata).toContain('removeBodyFields')
    expect(geminiDescriptor).toContain("removeBodyFields: ['store']")
    expect(mistralDescriptor).toContain("removeBodyFields: ['store']")
  })

  test('openaiShim does not keep a hardcoded descriptor route fallback list', async () => {
    const content = await file('services/api/openaiShim.ts').text()

    expect(content).not.toContain(
      "['mistral', 'gemini', 'moonshot', 'deepseek', 'zai', 'kimi-code']",
    )
  })
})

// ---------------------------------------------------------------------------
// Fix 2: Session timeout — stream idle timeout
// ---------------------------------------------------------------------------
describe('Session timeout fix', () => {
  test('openaiShim stream control has idle timeout for SSE streams', async () => {
    const content = await file('services/api/openaiShim/streamControl.ts').text()

    expect(content).toContain('STREAM_IDLE_TIMEOUT_MS')
  })

  test('codexShim has idle timeout for SSE streams', async () => {
    const content = await file('services/api/codexShim.ts').text()

    expect(content).toContain('STREAM_IDLE_TIMEOUT_MS')
    expect(content).toContain('readWithTimeout')
    expect(content).toMatch(/readWithTimeout\(\)/)
  })

  test('idle timeout is set to a reasonable value (>= 60s)', async () => {
    const content = await file('services/api/openaiShim/streamControl.ts').text()

    // Extract the timeout value (supports numeric separators like 120_000)
    const match = content.match(/STREAM_IDLE_TIMEOUT_MS\s*=\s*([\d_]+)/)
    expect(match).not.toBeNull()
    const timeoutMs = parseInt(match![1].replace(/_/g, ''), 10)
    expect(timeoutMs).toBeGreaterThanOrEqual(60_000)
  })
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
describe('Agent loop continuation nudge', () => {
  test('continuation logic has been moved to utility', async () => {
    const content = await file('query.ts').text()
    // query.ts should now call the utility
    expect(content).toContain('analyzeContinuationIntent')
  })

  test('continuation.ts has robust patterns', async () => {
    const content = await file('utils/continuation.ts').text()

    expect(content).toContain('CONTINUATION_SIGNALS')
    expect(content).toContain('COMPLETION_MARKERS')
    // Should detect tightened patterns requiring explicit action verbs
    expect(content).toMatch(/so now \(i\|let me\|we\)/)
  })

  test('analyzeContinuationIntent behavior follows project standards', async () => {
    const { analyzeContinuationIntent } = await import('../utils/continuation.js')

    // Transition intent detected (requires explicit action verb or transition phrase)
    expect(analyzeContinuationIntent("So now I will start task 2").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("I will now do the following").shouldNudge).toBe(true)
    
    // Completion marker suppresses nudge
    expect(analyzeContinuationIntent("Task finished").shouldNudge).toBe(false)
    
    // Punctuation-less completion suppresses nudge (Reviewer Feedback)
    expect(analyzeContinuationIntent("The analysis is complete and no code changes are needed here").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("I changed package.json and src/query.ts and added tests").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("Updated src/query.ts and added coverage in bugfixes.test.ts").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("This should be ready after the latest test updates").shouldNudge).toBe(false)

    // Mixed Intent: Late continuation survives earlier completion (Reviewer Feedback)
    expect(analyzeContinuationIntent("Task 1 is done. Let me update the status.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Task 1 finished. I will now run tests.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Analysis complete. Now I will edit src/query.ts").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("No issues in the first file. I will now inspect the next one.").shouldNudge).toBe(true)

    // Structural truncation survives earlier completion (Reviewer Feedback)
    expect(analyzeContinuationIntent("Setup is complete. Here is the code:\n```typescript\nfunction run() {").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Task complete. Please inspect (src/query.ts").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("The analysis is done and now I am editing files and").shouldNudge).toBe(true)

    // Structural truncation detection (Supreme Logic)
    expect(analyzeContinuationIntent("I am currently updating the following files and").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Please check the results in (src/query.ts").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("The plan is as follows:").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Here is the code:\n```typescript\nfunction test() {").shouldNudge).toBe(true)
  })

  test('nudge creates a meta user message to continue', async () => {
    const content = await file('query.ts').text()

    expect(content).toContain(
      'Continue with the task. If you were interrupted, resume your thought. Otherwise, use the appropriate tools to proceed to the next step.',
    )
  })
})

// ---------------------------------------------------------------------------
// Fix 3b: Expanded continuation coverage (PR #1713 review feedback)
// ---------------------------------------------------------------------------
describe('Expanded continuation coverage', () => {
  test('newly added verbs trigger continuation', async () => {
    const { analyzeContinuationIntent } = await import('../utils/continuation.js')

    // Verbs added in the PR: process, download, compile, train, evaluate, etc.
    expect(analyzeContinuationIntent("Now I will process the data").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Let me download the file").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Time to compile the source").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("I need to train the model").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("So now I will evaluate the results").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now I'll test the endpoint").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Let me extract the archive").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("I will merge the changes").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Time to deploy to production").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now I will install the package").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("I need to configure the server").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Let me refactor this component").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Time to optimize the query").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now I will upload the artifact").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("I need to convert the format").shouldNudge).toBe(true)
  })

  test('imperative / declarative patterns trigger continuation', async () => {
    const { analyzeContinuationIntent } = await import('../utils/continuation.js')

    // "Need to ..." pattern
    expect(analyzeContinuationIntent("Need to update the config").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Need to process these files").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Need to deploy the changes").shouldNudge).toBe(true)

    // "Now ..." pattern (without subject)
    expect(analyzeContinuationIntent("Now create the component").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now run the tests").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now compile everything").shouldNudge).toBe(true)

    // "Now ..." should NOT match "Now you ..." (excluded by negative lookahead)
    expect(analyzeContinuationIntent("Now you can run the app").shouldNudge).toBe(false)

    // "Next I/We ..." pattern
    expect(analyzeContinuationIntent("Next I will fix the bug").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Next we need to add tests").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Next I should deploy").shouldNudge).toBe(true)

    // Punctuated variants should also signal intent (Reviewer Feedback)
    expect(analyzeContinuationIntent("Need to process the files.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Need to deploy the changes.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now create the component.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now run the tests.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Next I will fix the bug.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Next we need to add tests.").shouldNudge).toBe(true)

    // "Need to ..." should NOT match subject-led advice ("You need to...", "We need to...")
    // ("I need to..." is correctly caught by strongIntent as agent's own intent)
    expect(analyzeContinuationIntent("You need to update the config.").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("You need to process these files.").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("You need to update the config").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("We need to deploy the changes.").shouldNudge).toBe(false)
  })

  test('present-progressive fallback triggers continuation', async () => {
    const { analyzeContinuationIntent } = await import('../utils/continuation.js')

    // "now processing", "now compiling", "now deploying" with restricted verb list
    expect(analyzeContinuationIntent("Task done. Now processing the next batch.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Finished step 1. Now compiling the assets.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Complete. Now deploying to staging.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("All set. Now testing the endpoint.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Done. Now installing dependencies.").shouldNudge).toBe(true)

    // Should NOT match passive/non-action ing-words (regression guard for review feedback)
    expect(analyzeContinuationIntent("Now being processed by the system").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("Now waiting for user input").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("Now having some issues").shouldNudge).toBe(false)
  })

  test('completion marker correctly suppressed by nearby continuation signal', async () => {
    const { analyzeContinuationIntent } = await import('../utils/continuation.js')

    // "complete" appears mid-sentence before continuation signal — should nudge
    expect(analyzeContinuationIntent("The download is complete. Now processing the files.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("The analysis is done. Let me update the report.").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Compilation finished. Now deploying the build.").shouldNudge).toBe(true)

    // "done" at the very end without continuation signal — no nudge
    expect(analyzeContinuationIntent("All tests pass. Task done.").shouldNudge).toBe(false)
    expect(analyzeContinuationIntent("The implementation is complete.").shouldNudge).toBe(false)
  })

  test('shared verb list in continuation.ts avoids duplication', async () => {
    const content = await file('utils/continuation.ts').text()

    // Should have ACTION_VERBS array and build regexes from it
    expect(content).toContain('ACTION_VERBS')
    expect(content).toContain('buildContinuationSignals')
    expect(content).toContain('VERB_ALT')
    expect(content).toContain('VERB_ING')

    // The verb list should appear only once as an array definition,
    // not repeated across multiple inline regexes
    const verbDeclarations = content.match(/ACTION_VERBS\s*=\s*\[/g)
    expect(verbDeclarations).toHaveLength(1)
  })
})

describe('MAX_CONTINUATION_NUDGES limit', () => {
  test('MAX_CONTINUATION_NUDGES is set to 20', async () => {
    const content = await file('query.ts').text()

    const match = content.match(/MAX_CONTINUATION_NUDGES\s*=\s*(\d+)/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBe(20)
  })

  test('nudge count is compared to MAX_CONTINUATION_NUDGES', async () => {
    const content = await file('query.ts').text()

    // The guard must exist: continuationNudgeCount < MAX_CONTINUATION_NUDGES
    expect(content).toContain('continuationNudgeCount < MAX_CONTINUATION_NUDGES')
  })
})

// ---------------------------------------------------------------------------
// Fix 4: Web search result count improvements
// ---------------------------------------------------------------------------
describe('Web search result count improvements', () => {
  test('Bing provider requests at least 15 results', async () => {
    const content = await file(
      'tools/WebSearchTool/providers/bing.ts',
    ).text()

    expect(content).toMatch(/count.*['"]15['"]/)
  })

  test('Tavily provider requests at least 15 results', async () => {
    const content = await file(
      'tools/WebSearchTool/providers/tavily.ts',
    ).text()

    expect(content).toMatch(/max_results:\s*15/)
  })

  test('Exa provider requests at least 15 results', async () => {
    const content = await file(
      'tools/WebSearchTool/providers/exa.ts',
    ).text()

    expect(content).toMatch(/DEFAULT_EXA_NUM_RESULTS\s*=\s*15/)
  })

  test('Firecrawl provider requests at least 15 results', async () => {
    const content = await file(
      'tools/WebSearchTool/providers/firecrawl.ts',
    ).text()

    expect(content).toMatch(/limit:\s*15/)
  })

  test('Mojeek provider requests at least 10 results', async () => {
    const content = await file(
      'tools/WebSearchTool/providers/mojeek.ts',
    ).text()

    // Mojeek uses 't' param for result count — verify it's set to 10
    expect(content).toMatch(/searchParams\.set\('t',\s*'10'\)/)
  })

  test('You.com provider requests at least 10 results', async () => {
    const content = await file(
      'tools/WebSearchTool/providers/you.ts',
    ).text()

    expect(content).toMatch(/num_web_results.*['"]10['"]/)
  })

  test('Jina provider requests at least 10 results', async () => {
    const content = await file(
      'tools/WebSearchTool/providers/jina.ts',
    ).text()

    expect(content).toMatch(/count.*['"]10['"]/)
  })

  test('Native Anthropic web search max_uses increased to 15', async () => {
    const content = await file(
      'tools/WebSearchTool/WebSearchTool.ts',
    ).text()

    expect(content).toMatch(/max_uses:\s*15/)
  })

  test('codex web search path guarantees a non-empty result body', async () => {
    const content = await file(
      'tools/WebSearchTool/WebSearchTool.ts',
    ).text()

    expect(content).toContain("results.push('No results found.')")
  })
})

// ---------------------------------------------------------------------------
// Fix 5: MCP tool timeout fix
// ---------------------------------------------------------------------------
describe('MCP tool timeout fix', () => {
  test('default MCP tool timeout is reasonable (not 27 hours)', async () => {
    const content = await file('services/mcp/client.ts').text()

    // Should NOT have the old ~27.8 hour default
    expect(content).not.toContain('100_000_000')
    // Should have a reasonable timeout (5 minutes = 300_000ms)
    expect(content).toMatch(/DEFAULT_MCP_TOOL_TIMEOUT_MS\s*=\s*300_000/)
  })

  test('MCP tools/list has retry logic', async () => {
    const content = await file('services/mcp/client.ts').text()

    expect(content).toContain('tools/list failed (attempt')
    expect(content).toContain('Retrying...')
  })

  test('MCP URL elicitation checks abort signal', async () => {
    const content = await file('services/mcp/client.ts').text()

    expect(content).toContain('signal.aborted')
    expect(content).toContain('Tool call aborted during URL elicitation')
  })

  test('MCP tool error messages include server and tool name in telemetry', async () => {
    const content = await file('services/mcp/client.ts').text()

    // Telemetry message should include context like "MCP tool [serverName] toolName: error"
    // The human-readable message stays unchanged to avoid breaking error consumers
    expect(content).toContain('MCP tool [${name}] ${tool}:')
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: verify no regressions
// ---------------------------------------------------------------------------
describe('Regression checks', () => {
  test('duplicate plugin hooks are deduplicated before execution', async () => {
    clearRegisteredHooks()

    const hookA: PluginHookMatcher = {
      pluginId: 'claude-mem@thedotmack',
      pluginName: 'claude-mem',
      pluginRoot: '/plugins/claude-mem-a',
      matcher: 'startup',
      hooks: [
        {
          async: true,
          command: 'node hook.js',
          statusMessage: 'warming cache',
          type: 'command',
        },
      ],
    }
    const hookB: PluginHookMatcher = {
      pluginId: 'claude-mem@thedotmack',
      pluginName: 'claude-mem',
      pluginRoot: '/plugins/claude-mem-a',
      matcher: 'startup',
      hooks: [
        {
          command: 'node hook.js',
          type: 'command',
          statusMessage: 'warming cache',
          async: true,
        },
      ],
    }
    const hookDifferentRoot: PluginHookMatcher = {
      ...hookA,
      pluginRoot: '/plugins/claude-mem-b',
    }

    try {
      registerHookCallbacks({
        SessionStart: [hookA, hookB, hookDifferentRoot],
      })

      const matched = await getMatchingHooks(
        undefined,
        'test-session',
        'SessionStart',
        {
          hook_event_name: 'SessionStart',
          source: 'startup',
        } as never,
      )

      expect(matched).toHaveLength(2)
      expect(matched.map(hook => hook.pluginRoot)).toEqual([
        '/plugins/claude-mem-a',
        '/plugins/claude-mem-b',
      ])
    } finally {
      clearRegisteredHooks()
    }
  })

})

// ---------------------------------------------------------------------------
// Fix 6: SendMessageTool race condition guard
// ---------------------------------------------------------------------------
describe('SendMessageTool race condition fix', () => {
  test('SendMessageTool has double-check for concurrent resume', async () => {
    const content = await file('tools/SendMessageTool/SendMessageTool.ts').text()

    // Should have a second status check before resuming to prevent race
    expect(content).toContain('was concurrently resumed')
    // The freshTask check should re-read from getAppState
    expect(content).toMatch(/const freshTask = context\.getAppState\(\)\.tasks\[agentId\]/)
  })
})

// ---------------------------------------------------------------------------
// Fix 7: AgentTool dump state cleanup
// ---------------------------------------------------------------------------
describe('AgentTool cleanup fix', () => {
  test('backgrounded agent always cleans up dump state', async () => {
    const content = await file('tools/AgentTool/AgentTool.tsx').text()

    // The backgrounded agent's finally block should clean up regardless
    // of whether the agent crashed or completed normally
    expect(content).toContain('Defensive cleanup: wrap each call so one failure')
    // Verify cleanup is wrapped in try/catch for defensive execution
    expect(content).toMatch(/try\s*\{\s*clearInvokedSkillsForAgent/)
    expect(content).toMatch(/try\s*\{\s*clearDumpState/)
  })
})

// ---------------------------------------------------------------------------
// Fix 8: Context overflow 500 error handling
// ---------------------------------------------------------------------------
describe('Context overflow 500 fix', () => {
  test('errors.ts has handler for context overflow 500 errors', async () => {
    const content = await file('services/api/errors.ts').text()

    expect(content).toContain('500 errors caused by context overflow')
    expect(content).toContain('too many tokens')
    expect(content).toContain('The conversation has grown too large')
  })

  test('query.ts has circuit breaker safety net for oversized context', async () => {
    const content = await file('query.ts').text()

    expect(content).toContain('Safety net: when auto-compact')
    expect(content).toContain('circuit breaker has tripped')
    expect(content).toContain('automatic compaction has failed')
  })
})

// ---------------------------------------------------------------------------
// Fix N: Project-scope MCP servers from .mcp.json not detected for 3P providers (issue #696)
// ---------------------------------------------------------------------------
describe('Project-scope MCP approval — third-party providers (issue #696)', () => {
  test('handleMcpjsonServerApprovals is NOT gated behind usesAnthropicSetup', async () => {
    const content = await file('interactiveHelpers.tsx').text()

    // The call site for handleMcpjsonServerApprovals must not sit inside an
    // `if (usesAnthropicSetup) { ... }` block, or third-party providers will
    // never get the dialog and project-scope .mcp.json servers will be silently
    // dropped from /mcp listings (issue #696).
    const approvalCallIdx = content.indexOf('await handleMcpjsonServerApprovals(root)')
    expect(approvalCallIdx).toBeGreaterThan(-1)

    // Look at the 800 chars BEFORE the call site for any `if (usesAnthropicSetup)`
    // block that would still be open. Pick a window that's definitely inside the
    // showSetupScreens function but not in earlier dialogs.
    const before = content.slice(Math.max(0, approvalCallIdx - 800), approvalCallIdx)
    expect(before).not.toMatch(/if\s*\(\s*usesAnthropicSetup\s*\)\s*{[^}]*$/)
  })

  test('issue #696 is referenced from the comment so future readers can find context', async () => {
    const content = await file('interactiveHelpers.tsx').text()
    expect(content).toContain('#696')
  })
})

// ---------------------------------------------------------------------------
// Fix N: --dangerously-load-development-channels dialog coverage (PR review)
// ---------------------------------------------------------------------------
describe('Dev-channels dialog coverage', () => {
  // Source structure check: verify the branching logic exists in the code
  test('showSetupScreens guards dev-channels dialog behind isChannelsEnabled', async () => {
    const content = await file('interactiveHelpers.tsx').text()

    // The dev-channels section at interactiveHelpers.tsx:~263 must branch on
    // isChannelsEnabled(): true → show dialog, false → register directly.
    expect(content).toContain('if (!isChannelsEnabled())')
    expect(content).toContain('DevChannelsDialog')

    // Verify that registerDevChannels is called in exactly two sites.
    // This count is a SEMANTIC requirement, not a style preference.
    // interactiveHelpers.tsx has exactly two sites that register
    // dev entries:
    //   1. The `!isChannelsEnabled()` branch (~line 286): entries
    //      are registered directly without user interaction.
    //   2. The DevChannelsDialog `onAccept` handler (~line 303):
    //      entries are registered after the user confirms.
    // Both sites delegate to registerDevChannels() which sets
    // `dev: true` per-entry so the allowlist bypass (granted by the
    // dev flag in `gateChannelServer`) cannot leak to production
    // `--channels` entries. If a refactor adds or removes a site,
    // update this count AND verify the security invariant still
    // holds: a dev entry is never confused with a production entry
    // in the allowlist check.
    const regCalls = content.match(/registerDevChannels\(devChannels\)/g)
    expect(regCalls).not.toBeNull()
    expect(regCalls!.length).toBe(2)
  })

  // The function that materialises dev: true per-entry lives in the
  // importable seam, not in showSetupScreens inline.
  test('registerDevChannels definition sets dev: true', async () => {
    const content = await file('utils/devChannelRegistration.ts').text()
    expect(content).toContain('dev: true')
  })

  // Runtime tests: exercise the same behavior paths that showSetupScreens
  // uses when --dangerously-load-development-channels is passed.
  //
  // NOTE: We cannot import showSetupScreens() directly in tests.  The
  // module chain (interactiveHelpers.tsx → main.js → main.tsx) triggers
  // Bun's compile-time `feature()` macro checker at main.tsx lines ~1494
  // and ~1516, which require `feature()` to appear directly in an
  // `if`/ternary — the object-literal usage there fails at parse time
  // before mock.module can intercept resolution.  The tests below
  // exercise the identical state-mutation patterns through the directly
  // importable registerDevChannels seam and DevChannelsDialog component.
  describe('isChannelsEnabled branching', () => {
    // afterEach re-registers the real module so neighboring test files
    // (e.g. channelNotification.test.ts) don't fail with "Export named
    // 'getChannelAllowlist' not found". mock.restore() does NOT clear
    // module-level mock.module() overrides in bun (registry is
    // process-global), so we must re-register from the cache-busted
    // reference captured at module scope.
    afterEach(() => {
      mock.restore()
      mock.module(
        '../services/mcp/channelAllowlist.js',
        () => _realChannelAllowlist,
      )
      // Reset shared bootstrap state so failures don't leak into later tests.
      const {
        setAllowedChannels: resetAllowed,
        setHasDevChannels: resetHasDev,
      } = require('../bootstrap/state.js')
      resetAllowed([])
      resetHasDev(false)
    })

    const devChannels = [
      { kind: 'server' as const, name: 'dev-server' },
    ]

    test(
      'isChannelsEnabled=true: DevChannelsDialog onAccept calls registerDevChannels',
      async () => {
        mock.module('../services/mcp/channelAllowlist.js', () => ({
          isChannelsEnabled: () => true,
        }))

        const { registerDevChannels } = await import(
          '../utils/devChannelRegistration.js'
        )
        const { DevChannelsDialog } = await import(
          '../components/DevChannelsDialog.js'
        )
        const React = await import('react')
        const { getAllowedChannels, getHasDevChannels } = await import(
          '../bootstrap/state.js'
        )

        let onAcceptCalled = false
        const element = React.createElement(DevChannelsDialog, {
          channels: devChannels,
          onAccept: () => {
            registerDevChannels(devChannels)
            onAcceptCalled = true
          },
        })

        element.props.onAccept()
        expect(onAcceptCalled).toBe(true)

        const all = getAllowedChannels()
        expect(all.length).toBe(1)
        expect(all[0]).toMatchObject({ name: 'dev-server', dev: true })
        expect(getHasDevChannels()).toBe(true)
      },
    )

    test(
      'isChannelsEnabled=false: registerDevChannels called directly without dialog',
      async () => {
        mock.module('../services/mcp/channelAllowlist.js', () => ({
          isChannelsEnabled: () => false,
        }))

        const { registerDevChannels } = await import(
          '../utils/devChannelRegistration.js'
        )
        const { getAllowedChannels, getHasDevChannels } = await import(
          '../bootstrap/state.js'
        )

        registerDevChannels(devChannels)

        const all = getAllowedChannels()
        expect(all.length).toBe(1)
        expect(all[0]).toMatchObject({ name: 'dev-server', dev: true })
        expect(getHasDevChannels()).toBe(true)
      },
    )
  })
})

// ---------------------------------------------------------------------------
// Fix: onboarding + trust dialog skipped entirely for third-party providers
// ---------------------------------------------------------------------------
// Behavioral coverage lives in src/utils/setupScreenGates.test.ts — the
// gating decisions were extracted into that provider-free seam because this
// module's import chain cannot be loaded under bun test (compile-time
// feature() macro checker, same constraint as the dev-channels tests above).
// These wiring checks assert showSetupScreens actually consults the seam and
// that no provider gate was re-introduced around the dialogs.
describe('Onboarding and trust dialog — third-party providers', () => {
  test('showSetupScreens routes both dialogs through the provider-free seam', async () => {
    const content = await file('interactiveHelpers.tsx').text()

    expect(content).toContain('getRequiredSetupScreens({')
    expect(content).toContain('if (setupScreens.onboarding)')
    expect(content).toContain('if (setupScreens.trustDialog)')
  })

  test('the env-config option never renders the raw endpoint', async () => {
    // OPENAI_BASE_URL/OPENAI_API_BASE can carry credentials (userinfo or
    // token query params) and everything rendered lands in terminal
    // scrollback. Redaction behavior is tested in envProviderOption.test.ts;
    // this guards the wiring — the raw `envBaseUrl` may only reach profile
    // persistence (addProviderProfile/getProviderProfiles/label), never a
    // rendered label or status message.
    const content = await file('components/ConsoleOAuthFlow.tsx').text()

    expect(content).toContain('getEnvProviderOption()')
    // Rendered sites use the redacted value.
    expect(content).toMatch(/\{envBaseUrlVarName\}=\{envBaseUrlForDisplay\}/)
    expect(content).toMatch(/\$\{envBaseUrlForDisplay\}\) as your active provider/)
    // No rendered site interpolates the raw endpoint.
    expect(content).not.toMatch(/\{envBaseUrl\}/)
    expect(content).not.toMatch(/\$\{envBaseUrl\}/)
  })

  test('no dialog is gated behind usesAnthropicSetup', async () => {
    const content = await file('interactiveHelpers.tsx').text()

    // Theme choice + security notes are universal, and workspace trust is
    // orthogonal to the API provider: an untrusted repo is exactly as
    // dangerous over a local model as over Anthropic. The seam takes no
    // provider input, so the only way to regress is to add a gate at the
    // call sites — which this guards against.
    expect(content).not.toMatch(/usesAnthropicSetup\s*&&\s*\(?\s*setupScreens/)
    expect(content).not.toMatch(/usesAnthropicSetup\s*&&\s*\(\s*!config\.theme/)
    expect(content).not.toMatch(
      /usesAnthropicSetup\s*&&\s*!checkHasTrustDialogAccepted/,
    )
  })
})
