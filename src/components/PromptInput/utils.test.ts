import { PassThrough } from 'node:stream'

import { expect, test } from 'bun:test'
import React from 'react'

import { createRoot, type Key } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { useSwarmBanner } from './useSwarmBanner.js'
import {
  canAcceptPromptSuggestion,
  isNonSpacePrintable,
  normalizePromptInputChunk,
  shouldShowStandaloneAgentBanner,
  resolvePromptBorderColor,
  resolveHelpToggleChange,
  resolveCoalescedModeSubmission,
} from './utils.js'

const unmodifiedKey = {} as Key

test('classifies ordinary non-space text as printable', () => {
  expect(isNonSpacePrintable('a', unmodifiedKey)).toBe(true)
})

test('does not classify leading whitespace as printable', () => {
  expect(isNonSpacePrintable(' a', unmodifiedKey)).toBe(false)
})

test('does not classify DEL-coalesced replacement text as printable', () => {
  expect(isNonSpacePrintable('\x7fă', unmodifiedKey)).toBe(false)
})

test('classifies printable text before a DEL byte as printable', () => {
  expect(isNonSpacePrintable('x\x7fy', unmodifiedKey)).toBe(true)
})

test('normalizes tabs before a DEL-coalesced chunk reaches cursor editing', () => {
  expect(normalizePromptInputChunk('\x7f\tfoo', unmodifiedKey, false)).toBe(
    '\x7f    foo',
  )
})

test('prepends a lazy image-pill space before printable text preceding DEL', () => {
  expect(normalizePromptInputChunk('x\x7fy', unmodifiedKey, true)).toBe(
    ' x\x7fy',
  )
})

test('does not prepend a lazy image-pill space when DEL comes first', () => {
  expect(normalizePromptInputChunk('\x7fy', unmodifiedKey, true)).toBe(
    '\x7fy',
  )
})

test('restores pre-character state and suppresses a coalesced help submission', () => {
  expect(
    resolveHelpToggleChange('?', {
      previousValue: '',
      cursorOffset: 0,
      willSubmit: true,
    }),
  ).toEqual({
    restore: { value: '', cursorOffset: 0 },
    suppressSubmit: true,
  })
})

test('ignores non-help input when resolving special input changes', () => {
  expect(resolveHelpToggleChange('x')).toBeNull()
})

test('does not classify End key input as printable', () => {
  expect(isNonSpacePrintable('a', { end: true } as Key)).toBe(false)
})

test('resolves a coalesced mode submission independently of stale rendered mode', () => {
  expect(
    resolveCoalescedModeSubmission('\tignored', 'prompt', {
      mode: 'bash',
      strippedValue: '\tfoo',
    }),
  ).toEqual({
    input: '    foo',
    mode: 'bash',
    inputModeOverride: 'bash',
  })
})

test('preserves input and rendered mode without a pending mode entry', () => {
  expect(resolveCoalescedModeSubmission('echo ok', 'bash', null)).toEqual({
    input: 'echo ok',
    mode: 'bash',
  })
})

test('does not create a banner for a color-only standalone context', () => {
  expect(shouldShowStandaloneAgentBanner(undefined)).toBe(false)
  expect(shouldShowStandaloneAgentBanner('')).toBe(false)
  expect(shouldShowStandaloneAgentBanner('   ')).toBe(false)
})

test('creates a banner when a standalone agent has a usable name', () => {
  expect(shouldShowStandaloneAgentBanner('renato')).toBe(true)
})

test.each([
  { name: '', teamName: undefined, expected: null },
  { name: '   ', teamName: undefined, expected: null },
  { name: 'saved-agent', teamName: 'active-team', expected: null },
  {
    name: 'saved-agent', teamName: undefined,
    expected: { text: 'saved-agent', bgColor: 'blue_FOR_SUBAGENTS_ONLY' },
  },
])('useSwarmBanner respects standalone and AppState team identity: %j', async ({ name, teamName, expected }) => {
  let observedBanner: ReturnType<typeof useSwarmBanner> | undefined
  let notifyRendered!: () => void
  const rendered = new Promise<void>(resolve => { notifyRendered = resolve })

  /** Observes the real hook after mounting its AppState provider. */
  function HookProbe() {
    observedBanner = useSwarmBanner()
    React.useEffect(() => { notifyRendered() }, [])
    return null
  }

  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const exited = root.waitUntilExit()

  try {
    root.render(
      React.createElement(AppStateProvider, {
        initialState: {
          ...getDefaultAppState(),
          standaloneAgentContext: { name, color: 'blue' },
          teamContext: teamName ? {
            teamName,
            teamFilePath: '/test/team.json',
            leadAgentId: 'team-lead',
            isLeader: true,
            selfAgentColor: 'red',
            teammates: {},
          } : undefined,
        },
        children: React.createElement(HookProbe),
      }),
    )

    await rendered
    expect(observedBanner).toEqual(expected)
  } finally {
    root.unmount()
    await exited
    stdout.destroy()
    stdin.destroy()
  }
})

test('standalone border color respects mode and team identity', () => {
  const standalone = {
    mode: 'prompt' as const,
    inProcessTeammate: false,
    standaloneColor: 'blue',
    ultracodeActive: false,
  }
  expect(resolvePromptBorderColor(standalone)).toBe('blue_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...standalone, mode: 'bash' })).toBe('bashBorder')
  expect(resolvePromptBorderColor({ ...standalone, inProcessTeammate: true })).toBe('promptBorder')
  expect(resolvePromptBorderColor({ ...standalone, teammateColor: 'red' })).toBe('red_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...standalone, teammateColor: 'invalid' })).toBe('blue_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...standalone, teamName: 'team', teammateColor: 'red' })).toBe('red_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...standalone, teamName: 'team' })).toBe('promptBorder')
  expect(resolvePromptBorderColor({ ...standalone, teamName: 'team', ultracodeActive: true })).toBe('ultracode')
  expect(resolvePromptBorderColor({ ...standalone, standaloneColor: 'invalid' })).toBe('promptBorder')
  expect(resolvePromptBorderColor({ ...standalone, standaloneColor: undefined, ultracodeActive: true })).toBe('ultracode')
  expect(resolvePromptBorderColor({ ...standalone, ultracodeActive: true })).toBe('blue_FOR_SUBAGENTS_ONLY')
})

test('border color reads production AppState member identity before dynamic fallback', () => {
  const leader = {
    name: 'team-lead', color: 'red', tmuxSessionName: '', tmuxPaneId: '',
    cwd: '/test', spawnedAt: 0,
  }
  const teamContext = {
    teamName: 'active-team', teamFilePath: '/test/team.json', leadAgentId: 'leader',
    teammates: { leader, member: { ...leader, name: 'member', color: 'green' } },
  }
  const input = {
    mode: 'prompt' as const, inProcessTeammate: false, teamContext,
    standaloneColor: 'blue', ultracodeActive: true,
  }
  // TeamCreateTool stores the leader color in teammates, without selfAgentColor.
  expect(resolvePromptBorderColor(input)).toBe('red_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...input, teammateColor: 'yellow' })).toBe('red_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...input, teamContext: { ...teamContext, selfAgentId: 'member' } })).toBe('green_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...input, teamContext: { ...teamContext, selfAgentColor: 'purple' } })).toBe('purple_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...input, teamContext: { ...teamContext, selfAgentId: 'missing' }, teammateColor: 'yellow' })).toBe('yellow_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...input, teamContext: { ...teamContext, teammates: {} } })).toBe('ultracode')
  expect(resolvePromptBorderColor({ ...input, teamContext: { ...teamContext, teammates: {}, selfAgentColor: 'invalid' }, teammateColor: 'yellow' })).toBe('yellow_FOR_SUBAGENTS_ONLY')
  expect(resolvePromptBorderColor({ ...input, mode: 'bash' })).toBe('bashBorder')
  expect(resolvePromptBorderColor({ ...input, inProcessTeammate: true })).toBe('promptBorder')
})

test('only prompt submissions can accept prompt suggestions', () => {
  expect(canAcceptPromptSuggestion('prompt')).toBe(true)
  expect(canAcceptPromptSuggestion('bash')).toBe(false)
})
