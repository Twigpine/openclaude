import { PassThrough } from 'node:stream'

import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { getOriginalCwd } from '../bootstrap/state.js'
import { createRoot } from '../ink.js'
import instances from '../ink/instances.js'
import type { ParsedKey } from '../ink/parse-keypress.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { LogOption, SessionBranchEntry } from '../types/logs.js'
import {
  LogSelector,
  countVisibleResumeTreeRows,
  getResumeLogDisplayTitle,
  groupLogsByResumeBranch,
  logMatchesResumePickerSearch,
  shouldLoadMoreResumeLogs,
} from './LogSelector.js'

const ts = '2026-06-30T00:00:00.000Z'
const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function id(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function branchMeta(
  sessionId: UUID,
  parentSessionId: UUID,
  rootSessionId: UUID,
  branchName: string,
): SessionBranchEntry {
  return {
    type: 'session-branch',
    sessionId,
    parentSessionId,
    rootSessionId,
    branchedFromSessionId: parentSessionId,
    branchName,
    branchedAt: ts,
  }
}

function log(
  sessionId: UUID,
  title: string,
  modifiedOffset: number,
  options: Partial<LogOption> = {},
): LogOption {
  const modified = new Date(Date.parse(ts) + modifiedOffset)
  return {
    date: modified.toISOString(),
    messages: [],
    fullPath: `/tmp/${sessionId}.jsonl`,
    value: modifiedOffset,
    created: new Date(ts),
    modified,
    firstPrompt: title,
    messageCount: 1,
    isSidechain: false,
    sessionId,
    ...options,
  }
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return lastFrame ?? output
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
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
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, getOutput: () => output }
}

function dispatchKeyboard(
  stdout: PassThrough,
  key: Pick<ParsedKey, 'name' | 'sequence' | 'raw'>,
): void {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { dispatchKeyboardEvent: (parsedKey: ParsedKey) => void }
    | undefined
  if (!instance) {
    throw new Error('Ink instance not found')
  }
  instance.dispatchKeyboardEvent({
    kind: 'key',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    isPasted: false,
    ...key,
  })
}

async function waitForFrame(
  getOutput: () => string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const startedAt = Date.now()
  let frame = ''
  while (Date.now() - startedAt < 2500) {
    frame = stripAnsi(extractLastFrame(getOutput()))
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for LogSelector output:\n${frame}`)
}

test('groups root sessions with their branches without moving the group behind newer branches', () => {
  const rootId = id(1)
  const branchAId = id(2)
  const branchBId = id(3)
  const soloId = id(4)
  const root = log(rootId, 'Root planning session', 10, {
    customTitle: 'Root planning session',
  })
  const branchA = log(branchAId, 'Copied root prompt', 40, {
    sessionBranch: branchMeta(branchAId, rootId, rootId, 'Branch A'),
  })
  const branchB = log(branchBId, 'Copied root prompt', 100, {
    sessionBranch: branchMeta(branchBId, rootId, rootId, 'Branch B'),
  })
  const solo = log(soloId, 'Unrelated session', 80, {
    customTitle: 'Unrelated session',
  })

  const groups = groupLogsByResumeBranch([branchB, solo, root, branchA])

  expect(groups.map(group => group.headerLog.sessionId)).toEqual([
    rootId,
    soloId,
  ])
  expect(groups[0]?.childLogs.map(child => child.sessionId)).toEqual([
    branchBId,
    branchAId,
  ])
  expect(groups[0]?.firstIndex).toBe(0)
  expect(groups[1]?.childLogs).toEqual([])
})

test('shows branches with missing parents as standalone sessions', () => {
  const missingRootId = id(20)
  const missingParentId = id(21)
  const branchId = id(22)
  const branch = log(branchId, 'Copied missing parent prompt', 10, {
    sessionBranch: branchMeta(
      branchId,
      missingParentId,
      missingRootId,
      'Detached branch',
    ),
  })

  const groups = groupLogsByResumeBranch([branch])

  expect(groups).toHaveLength(1)
  expect(groups[0]?.headerLog.sessionId).toBe(branchId)
  expect(groups[0]?.childLogs).toEqual([])
})

test('search and display include branch names and session titles', () => {
  const rootId = id(30)
  const branchId = id(31)
  const root = log(rootId, 'Investigate OAuth callback', 10, {
    customTitle: 'OAuth callback fix',
  })
  const branch = log(branchId, 'Copied root prompt', 20, {
    sessionBranch: branchMeta(
      branchId,
      rootId,
      rootId,
      'Retry token exchange',
    ),
  })

  expect(getResumeLogDisplayTitle(branch)).toBe('Retry token exchange')
  expect(logMatchesResumePickerSearch(branch, 'token exchange')).toBe(true)
  expect(logMatchesResumePickerSearch(branch, 'copied root prompt')).toBe(true)
  expect(logMatchesResumePickerSearch(root, 'callback fix')).toBe(true)
})

test('requests more logs when grouped branch rows underfill the visible picker', () => {
  expect(
    shouldLoadMoreResumeLogs({
      displayedLogCount: 50,
      focusedIndex: 1,
      visibleCount: 10,
      visibleNodeCount: 1,
    }),
  ).toBe(true)
  expect(
    shouldLoadMoreResumeLogs({
      displayedLogCount: 50,
      focusedIndex: 1,
      visibleCount: 10,
      visibleNodeCount: 10,
    }),
  ).toBe(false)
  expect(
    shouldLoadMoreResumeLogs({
      displayedLogCount: 50,
      focusedIndex: 35,
      visibleCount: 10,
      visibleNodeCount: 10,
    }),
  ).toBe(true)
})

test('counts expanded branch rows before requesting more logs', () => {
  const rootId = id(50)
  const visibleCount = 5
  const treeNodes = [
    {
      id: `group:${rootId}`,
      value: null,
      label: 'Root implementation session',
      children: [1, 2, 3, 4].map(index => ({
        id: `log:${rootId}:${index}`,
        value: null,
        label: `Branch ${index}`,
        children:
          index === 4
            ? [
                {
                  id: `log:${rootId}:${index}:1`,
                  value: null,
                  label: `Nested branch ${index}`,
                },
              ]
            : undefined,
      })),
    },
  ]
  const collapsedCount = countVisibleResumeTreeRows(treeNodes, {
    expandedGroupSessionIds: new Set(),
    forceExpanded: false,
  })
  const manuallyExpandedCount = countVisibleResumeTreeRows(treeNodes, {
    expandedGroupSessionIds: new Set([rootId]),
    forceExpanded: false,
  })
  const forcedExpandedCount = countVisibleResumeTreeRows(treeNodes, {
    expandedGroupSessionIds: new Set(),
    forceExpanded: true,
  })

  expect(collapsedCount).toBe(1)
  expect(manuallyExpandedCount).toBe(visibleCount)
  expect(forcedExpandedCount).toBe(visibleCount + 1)
  expect(
    shouldLoadMoreResumeLogs({
      displayedLogCount: 50,
      focusedIndex: 0,
      visibleCount,
      visibleNodeCount: collapsedCount,
    }),
  ).toBe(true)
  expect(
    shouldLoadMoreResumeLogs({
      displayedLogCount: 50,
      focusedIndex: 0,
      visibleCount,
      visibleNodeCount: forcedExpandedCount,
    }),
  ).toBe(false)
})

test('rendered picker expands branch groups and selects child branch logs', async () => {
  await acquireSharedMutationLock(
    'components/LogSelector.resumeBranches.test.tsx',
  )
  let rootRenderer: Awaited<ReturnType<typeof createRoot>> | null = null
  const rootId = id(40)
  const branchId = id(41)
  const projectPath = getOriginalCwd()
  const root = log(rootId, 'Root implementation session', 10, {
    customTitle: 'Root implementation session',
    projectPath,
  })
  const branch = log(branchId, 'Branch copied prompt', 20, {
    projectPath,
    sessionBranch: branchMeta(
      branchId,
      rootId,
      rootId,
      'Branch implementation session',
    ),
  })
  const selected: LogOption[] = []
  const { stdout, stdin, getOutput } = createTestStreams()

  try {
    rootRenderer = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    rootRenderer.render(
      React.createElement(
        AppStateProvider,
        null,
        React.createElement(
          KeybindingSetup,
          null,
          React.createElement(LogSelector, {
            logs: [branch, root],
            maxHeight: 30,
            forceWidth: 100,
            onSelect: selectedLog => {
              selected.push(selectedLog)
            },
          }),
        ),
      ),
    )

    await waitForFrame(
      getOutput,
      frame =>
        frame.includes('Root implementation session') &&
        frame.includes('(+1 other session)') &&
        !frame.includes('Branch implementation session'),
    )
    await Bun.sleep(50)

    dispatchKeyboard(stdout, {
      name: 'right',
      sequence: '\x1B[C',
      raw: '\x1B[C',
    })
    await waitForFrame(
      getOutput,
      frame =>
        frame.includes('Root implementation session') &&
        frame.includes('Branch implementation session'),
    )

    dispatchKeyboard(stdout, {
      name: 'left',
      sequence: '\x1B[D',
      raw: '\x1B[D',
    })
    await waitForFrame(
      getOutput,
      frame =>
        frame.includes('Root implementation session') &&
        !frame.includes('Branch implementation session'),
    )

    dispatchKeyboard(stdout, {
      name: 'right',
      sequence: '\x1B[C',
      raw: '\x1B[C',
    })
    await waitForFrame(
      getOutput,
      frame =>
        frame.includes('Root implementation session') &&
        frame.includes('Branch implementation session'),
    )

    stdin.write('2')

    const startedAt = Date.now()
    while (Date.now() - startedAt < 2500 && selected.length === 0) {
      await Bun.sleep(10)
    }
    expect(selected.map(selectedLog => selectedLog.sessionId)).toEqual([
      branchId,
    ])
  } finally {
    rootRenderer?.unmount()
    stdin.end()
    releaseSharedMutationLock()
  }
})

test('deep search is offered only with a callback and runs from the keyboard', async () => {
  await acquireSharedMutationLock('components/LogSelector.resumeBranches.test.tsx')
  let renderer: Awaited<ReturnType<typeof createRoot>> | null = null
  const { stdout, stdin, getOutput } = createTestStreams()
  const logs = [log(id(60), 'Original history', 10, { projectPath: getOriginalCwd() })]
  const recovered = log(id(61), 'Recovered session', 20, { projectPath: getOriginalCwd() })
  const queries: string[] = []
  const onAgenticSearch = async (query: string, candidates: LogOption[], signal?: AbortSignal) => {
    queries.push(query)
    expect(candidates).toEqual(logs)
    expect(signal?.aborted).toBe(false)
    return [recovered]
  }
  const renderPicker = (enabled: boolean) => renderer!.render(
    React.createElement(AppStateProvider, null,
      React.createElement(KeybindingSetup, null,
        React.createElement(LogSelector, {
          logs, maxHeight: 30, forceWidth: 100, onSelect: () => {},
          onAgenticSearch: enabled ? onAgenticSearch : undefined,
        }))),
  )
  try {
    renderer = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    renderPicker(false)
    await waitForFrame(getOutput, frame => frame.includes('Original history'))
    stdin.write('z')
    const noCallback = await waitForFrame(getOutput, frame => frame.includes('⌕ z'))
    expect(noCallback).not.toContain('Search deeply using Claude')
    renderPicker(true)
    await waitForFrame(getOutput, frame => frame.includes('Search deeply using Claude'))
    stdin.write('\x1B[B')
    await waitForFrame(getOutput, frame => frame.includes('❯ Search deeply using Claude'))
    stdin.write('\r')
    await waitForFrame(getOutput, frame => frame.includes('Recovered session'))
    expect(queries).toEqual(['z'])
  } finally {
    renderer?.unmount()
    stdin.end()
    releaseSharedMutationLock()
  }
})
