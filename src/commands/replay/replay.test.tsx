import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import type { UUID } from 'crypto'
import React from 'react'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { createRoot, Text } from '../../ink.js'
import { AppStateProvider } from '../../state/AppState.js'
import type { LogOption, ReplayIndex } from '../../types/logs.js'
import { renderToString } from '../../utils/staticRender.js'
import * as realBootstrapState from '../../bootstrap/state.js'

const nonce = `${Date.now()}-${Math.random()}`
const realGetWorktreePaths = {
  ...await import(`../../utils/getWorktreePaths.js?real=${nonce}`),
}
const realSessionStorage = {
  ...await import(`../../utils/sessionStorage.js?real=${nonce}`),
}
const realReplayIndex = {
  ...await import(`../../utils/replayIndex.js?real=${nonce}`),
}
const realUseTerminalSize = {
  ...await import(`../../hooks/useTerminalSize.js?real=${nonce}`),
}
const realModalContext = {
  ...await import(`../../context/modalContext.js?real=${nonce}`),
}
const realLogSelector = {
  ...await import(`../../components/LogSelector.js?real=${nonce}`),
}
const realReplayTimeline = {
  ...await import(`./ReplayTimeline.js?real=${nonce}`),
}

type LogSelectorProps = {
  logs: LogOption[]
  onCancel: () => void
  onSelect: (log: LogOption) => void | Promise<void>
}

let loadSameRepoMessageLogsMock: ReturnType<typeof mock>
let loadFullLogMock: ReturnType<typeof mock>
let loadReplayIndexMock: ReturnType<typeof mock>
let lastLogSelectorProps: LogSelectorProps | null

const currentSessionId = realBootstrapState.getSessionId() as UUID
const replaySessionId = '00000000-0000-4000-8000-000000000002' as UUID
const liteSessionId = '00000000-0000-4000-8000-000000000003' as UUID

const replayIndex: ReplayIndex = {
  sessionId: replaySessionId,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  summary: {
    totalSteps: 1,
    toolBreakdown: { Read: 1 },
    filesModified: [],
    durationMs: 500,
    startTimestamp: '2026-01-01T00:00:00.000Z',
    endTimestamp: '2026-01-01T00:00:00.500Z',
    userRequests: 1,
    retryAttempts: 0,
    repeatedAttempts: 0,
  },
  steps: [],
}

function makeLog(
  sessionId: string,
  overrides: Partial<LogOption> = {},
): LogOption {
  return {
    sessionId,
    date: '2026-01-01',
    messages: [],
    value: 0,
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date('2026-01-01T00:00:00.000Z'),
    firstPrompt: 'build replay',
    customTitle: 'Replay Session',
    messageCount: 1,
    isSidechain: false,
    fullPath: `${sessionId}.jsonl`,
    ...overrides,
  } as LogOption
}

async function importFreshReplayModule(): Promise<typeof import('./replay.js')> {
  const unique = `${Date.now()}-${Math.random()}`
  return import(`./replay.js?${unique}`) as Promise<typeof import('./replay.js')>
}

function createTestStreams() {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  ;(stdout as unknown as { columns: number }).columns = 80

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

  return { stdout, stdin, getOutput: () => stripAnsi(output) }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for condition')
}

describe('/replay command', () => {
  beforeEach(() => {
    lastLogSelectorProps = null
    loadSameRepoMessageLogsMock = mock(() => Promise.resolve([]))
    loadFullLogMock = mock((log: LogOption) => Promise.resolve(log))
    loadReplayIndexMock = mock(() => Promise.resolve(null))

    mock.module('../../utils/getWorktreePaths.js', () => ({
      getWorktreePaths: () => Promise.resolve([]),
    }))
    mock.module('../../utils/sessionStorage.js', () => ({
      getSessionIdFromLog: (log: { sessionId?: string }) => log.sessionId,
      getTranscriptPathForSession: (sessionId: string) => `${sessionId}.jsonl`,
      isLiteLog: (log: { isLite?: boolean }) => log.isLite === true,
      loadFullLog: loadFullLogMock,
      loadSameRepoMessageLogs: loadSameRepoMessageLogsMock,
    }))
    mock.module('../../utils/replayIndex.js', () => ({
      ...realReplayIndex,
      loadReplayIndex: loadReplayIndexMock,
    }))
    mock.module('../../hooks/useTerminalSize.js', () => ({
      useTerminalSize: () => ({ columns: 80, rows: 24 }),
    }))
    mock.module('../../context/modalContext.js', () => ({
      useIsInsideModal: () => false,
    }))
    mock.module('../../components/LogSelector.js', () => ({
      ...realLogSelector,
      LogSelector: (props: LogSelectorProps) => {
        lastLogSelectorProps = props
        return <Text>{`LogSelector:${props.logs.length}`}</Text>
      },
    }))
    mock.module('./ReplayTimeline.js', () => ({
      ReplayTimeline: ({ index }: { index: ReplayIndex }) => (
        <Text>{`ReplayTimeline:${index.sessionId}`}</Text>
      ),
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../utils/getWorktreePaths.js', () => realGetWorktreePaths)
      mock.module('../../utils/sessionStorage.js', () => realSessionStorage)
      mock.module('../../utils/replayIndex.js', () => realReplayIndex)
      mock.module('../../hooks/useTerminalSize.js', () => realUseTerminalSize)
      mock.module('../../context/modalContext.js', () => realModalContext)
      mock.module('../../components/LogSelector.js', () => realLogSelector)
      mock.module('./ReplayTimeline.js', () => realReplayTimeline)
    } finally {
      lastLogSelectorProps = null
    }
  })

  test('renders replay data for a direct session id argument', async () => {
    loadSameRepoMessageLogsMock.mockImplementation(() =>
      Promise.resolve([makeLog(replaySessionId)]),
    )
    loadReplayIndexMock.mockImplementation(() => Promise.resolve(replayIndex))
    const { call } = await importFreshReplayModule()

    const element = await call(mock(() => {}), {} as never, replaySessionId)
    const output = await renderToString(<>{element}</>, 80)

    expect(output).toContain(`ReplayTimeline:${replaySessionId}`)
    expect(loadReplayIndexMock).toHaveBeenCalledWith(
      replaySessionId,
      `${replaySessionId}.jsonl`,
    )
  })

  test('reports missing replay data for a direct session id argument', async () => {
    loadSameRepoMessageLogsMock.mockImplementation(() =>
      Promise.resolve([makeLog(replaySessionId)]),
    )
    const { call } = await importFreshReplayModule()

    const element = await call(mock(() => {}), {} as never, replaySessionId)
    const output = await renderToString(<>{element}</>, 80)

    expect(output).toContain('No replay data found for session')
    expect(output).toContain(replaySessionId)
  })

  test('searches title and prompt arguments before reporting no match', async () => {
    loadSameRepoMessageLogsMock.mockImplementation(() =>
      Promise.resolve([makeLog(replaySessionId, { firstPrompt: 'ship replay' })]),
    )
    loadReplayIndexMock.mockImplementation(() => Promise.resolve(replayIndex))
    const { call } = await importFreshReplayModule()

    const match = await call(mock(() => {}), {} as never, 'ship')
    const matchOutput = await renderToString(<>{match}</>, 80)
    expect(matchOutput).toContain(`ReplayTimeline:${replaySessionId}`)

    loadReplayIndexMock.mockClear()
    const miss = await call(mock(() => {}), {} as never, 'missing')
    const missOutput = await renderToString(<>{miss}</>, 80)
    expect(missOutput).toContain('No session found matching "missing"')
    expect(loadReplayIndexMock).not.toHaveBeenCalled()
  })

  test('picker filters sidechains and current session before selection', async () => {
    const replayableLog = makeLog(liteSessionId, { isLite: true } as never)
    loadSameRepoMessageLogsMock.mockImplementation(() =>
      Promise.resolve([
        makeLog(currentSessionId),
        makeLog('00000000-0000-4000-8000-000000000004', {
          isSidechain: true,
        }),
        replayableLog,
      ]),
    )
    loadFullLogMock.mockImplementation(() =>
      Promise.resolve(makeLog(liteSessionId, { fullPath: 'full.jsonl' })),
    )
    loadReplayIndexMock.mockImplementation(() => Promise.resolve(replayIndex))
    const { call } = await importFreshReplayModule()
    const onDone = mock(() => {})
    const { stdin, stdout } = createTestStreams()
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    try {
      root.render(
        <AppStateProvider>
          {(await call(onDone, {} as never, '')) as React.ReactElement}
        </AppStateProvider>,
      )
      await waitFor(() => lastLogSelectorProps !== null)

      expect(lastLogSelectorProps?.logs).toEqual([replayableLog])
      await lastLogSelectorProps!.onSelect(replayableLog)

      expect(loadFullLogMock).toHaveBeenCalledWith(replayableLog)
      expect(loadReplayIndexMock).toHaveBeenCalledWith(liteSessionId, 'full.jsonl')
      await Bun.sleep(0)
      expect(onDone).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    }
  })

  test('picker reports empty, load, cancel, and invalid-selection outcomes', async () => {
    const { call } = await importFreshReplayModule()
    const onDone = mock(() => {})
    const emptyElement = await call(onDone, {} as never, '')
    const { stdin, stdout } = createTestStreams()
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    try {
      root.render(
        <AppStateProvider>{emptyElement as React.ReactElement}</AppStateProvider>,
      )
      await waitFor(() => onDone.mock.calls.length === 1)
      expect(onDone).toHaveBeenLastCalledWith('No sessions found to replay')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    }

    loadSameRepoMessageLogsMock.mockImplementationOnce(() =>
      Promise.reject(new Error('boom')),
    )
    const loadDone = mock(() => {})
    const loadRootStreams = createTestStreams()
    const loadRoot = await createRoot({
      stdin: loadRootStreams.stdin as unknown as NodeJS.ReadStream,
      stdout: loadRootStreams.stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    try {
      loadRoot.render(
        <AppStateProvider>
          {(await call(loadDone, {} as never, '')) as React.ReactElement}
        </AppStateProvider>,
      )
      await waitFor(() => loadDone.mock.calls.length === 1)
      expect(loadDone).toHaveBeenLastCalledWith('Failed to load sessions')
    } finally {
      loadRoot.unmount()
      loadRootStreams.stdin.end()
      loadRootStreams.stdout.end()
      await Bun.sleep(0)
    }

    loadSameRepoMessageLogsMock.mockImplementation(() =>
      Promise.resolve([makeLog(replaySessionId)]),
    )
    lastLogSelectorProps = null
    const selectDone = mock(() => {})
    const selectStreams = createTestStreams()
    const selectRoot = await createRoot({
      stdin: selectStreams.stdin as unknown as NodeJS.ReadStream,
      stdout: selectStreams.stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    try {
      selectRoot.render(
        <AppStateProvider>
          {(await call(selectDone, {} as never, '')) as React.ReactElement}
        </AppStateProvider>,
      )
      await waitFor(() => lastLogSelectorProps !== null)
      lastLogSelectorProps!.onCancel()
      await waitFor(() => selectDone.mock.calls.length === 1)
      expect(selectDone).toHaveBeenLastCalledWith('Replay cancelled')

      await lastLogSelectorProps!.onSelect(makeLog('not-a-uuid'))
      await waitFor(() => selectDone.mock.calls.length === 2)
      expect(selectDone).toHaveBeenLastCalledWith('Failed to load session')
    } finally {
      selectRoot.unmount()
      selectStreams.stdin.end()
      selectStreams.stdout.end()
      await Bun.sleep(0)
    }
  })

  test('picker reports failure when lite log expansion fails', async () => {
    const liteLog = makeLog(liteSessionId, { isLite: true } as never)
    loadSameRepoMessageLogsMock.mockImplementation(() =>
      Promise.resolve([liteLog]),
    )
    loadFullLogMock.mockImplementation(() => Promise.reject(new Error('boom')))
    const { call } = await importFreshReplayModule()
    const onDone = mock(() => {})
    const { stdin, stdout } = createTestStreams()
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    try {
      root.render(
        <AppStateProvider>
          {(await call(onDone, {} as never, '')) as React.ReactElement}
        </AppStateProvider>,
      )
      await waitFor(() => lastLogSelectorProps !== null)
      await lastLogSelectorProps!.onSelect(liteLog)
      await waitFor(() => onDone.mock.calls.length === 1)
      expect(onDone).toHaveBeenLastCalledWith('Failed to load log file')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    }
  })
})
