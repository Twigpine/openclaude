import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import { AppStateProvider } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { REPLTool } from '../../tools/REPLTool/REPLTool.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import {
  formatReplPermissionPreview,
  REPLPermissionRequest,
} from './REPLPermissionRequest.js'


const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

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
  return stripAnsi(lastFrame ?? output)
}

describe('formatReplPermissionPreview', () => {
  test('bounds large scripts while preserving head and tail evidence', () => {
    const code = `HEAD_START\n${'middle-'.repeat(3_000)}\nTAIL_END`
    const preview = formatReplPermissionPreview(code)

    expect(preview.omittedCharacters).toBeGreaterThan(0)
    expect(preview.text.length).toBeLessThan(8_200)
    expect(preview.text).toStartWith('HEAD_START')
    expect(preview.text).toEndWith('TAIL_END')
    expect(preview.text).toContain('omitted')
    expect(preview.characterCount).toBe(code.length)
  })

  test('fullText retains the complete sanitized script while the truncated preview omits middle content', () => {
    const middleMarker = 'CONST_MIDDLE_PAYLOAD = 42'
    const code = `${'a'.repeat(7_000)}\n${middleMarker}\n${'b'.repeat(3_000)}`
    const preview = formatReplPermissionPreview(code)

    expect(preview.omittedCharacters).toBeGreaterThan(0)
    expect(preview.text).not.toContain(middleMarker)
    expect(preview.text).toContain('[omitted')
    expect(preview.fullText).toBe(code)
    expect(preview.fullText).toContain(middleMarker)
    expect(preview.fullText).not.toContain('[omitted')
  })

  test('fullText equals the preview text when the script fits the budget', () => {
    const preview = formatReplPermissionPreview('return 1 + 1')

    expect(preview.omittedCharacters).toBe(0)
    expect(preview.fullText).toBe(preview.text)
  })

  test('strips terminal control sequences and unsafe control characters', () => {
    const preview = formatReplPermissionPreview('\u001b[31mred\u001b[0m\u0007 plain')

    expect(preview.text).toContain('red')
    expect(preview.text).toContain(' plain')
    expect(preview.text).not.toContain('\u001b')
    expect(preview.text).not.toContain('\u0007')
  })

  test('fullText preserves the sanitized script including control character replacement', () => {
    const preview = formatReplPermissionPreview('\u0007hidden\u0007plain')

    expect(preview.fullText).toContain('plain')
    expect(preview.fullText).not.toContain('\u0007')
  })
})

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
  getFrame: () => string
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

  return {
    stdout,
    stdin,
    getOutput: () => output,
    getFrame: () => extractLastFrame(output),
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for REPL permission test condition')
}

function flattenOutput(raw: string): string {
  return stripAnsi(raw).replace(/\s+/g, '')
}

function createToolUseConfirm(
  overrides: Partial<ToolUseConfirm> = {},
): ToolUseConfirm {
  return {
    assistantMessage: {
      type: 'assistant',
      uuid: 'assistant-uuid',
      message: {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'test-model',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    } as unknown as ToolUseConfirm['assistantMessage'],
    tool: REPLTool as unknown as ToolUseConfirm['tool'],
    description: 'run a script',
    input: {
      code: 'return 1',
    },
    toolUseContext: {} as ToolUseConfirm['toolUseContext'],
    toolUseID: 'toolu_repl',
    permissionResult: {
      behavior: 'ask',
      message: 'Permission required',
    },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: mock(() => {}),
    onAbort: mock(() => {}),
    onAllow: mock(() => {}),
    onReject: mock(() => {}),
    recheckPermission: mock(async () => {}),
    ...overrides,
  } as ToolUseConfirm
}

async function renderReplPermission(
  toolUseConfirm: ToolUseConfirm,
  callbacks: {
    onDone?: () => void
    onReject?: () => void
  } = {},
): Promise<{
  stdin: ReturnType<typeof createTestStreams>['stdin']
  getOutput: () => string
  getFrame: () => string
  cleanup: () => void
}> {
  const { stdout, stdin, getOutput, getFrame } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  const baseState = getDefaultAppState()
  const initialState = {
    ...baseState,
    toolPermissionContext: {
      ...baseState.toolPermissionContext,
      isBypassPermissionsModeAvailable: false,
    },
  }

  root.render(
    React.createElement(AppStateProvider, {
      initialState,
      children: React.createElement(REPLPermissionRequest, {
        toolUseConfirm,
        toolUseContext: toolUseConfirm.toolUseContext,
        onDone: callbacks.onDone ?? (() => {}),
        onReject: callbacks.onReject ?? (() => {}),
        verbose: false,
        workerBadge: undefined,
      }),
    }),
  )

  await waitFor(() =>
    stripAnsi(getOutput()).includes('Do you want to proceed?'),
  )

  return {
    stdin,
    getOutput,
    getFrame,
    cleanup: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

describe('REPLPermissionRequest', () => {
  test('persistent approval option says it covers all future REPL scripts', async () => {
    const toolUseConfirm = createToolUseConfirm()
    const mounted = await renderReplPermission(toolUseConfirm)

    try {
      const flat = flattenOutput(mounted.getOutput())

      expect(flat).toContain('allfutureREPLscripts')
    } finally {
      mounted.cleanup()
    }
  })

  test('show full script toggle reveals omitted middle content without deciding the permission', async () => {
    const middleMarker = 'MIDDLE_SECRET_MARKER'
    const code = `${'a'.repeat(7_000)}\n${middleMarker}\n${'b'.repeat(3_000)}`
    const onDone = mock(() => {})
    const onReject = mock(() => {})
    const toolUseConfirm = createToolUseConfirm({ input: { code } })
    const mounted = await renderReplPermission(toolUseConfirm, {
      onDone,
      onReject,
    })

    try {
      expect(flattenOutput(mounted.getOutput())).not.toContain(middleMarker)
      expect(flattenOutput(mounted.getOutput())).toContain('Showfullscript')

      mounted.stdin.write('4')

      await waitFor(() =>
        flattenOutput(mounted.getOutput()).includes(middleMarker),
      )

      expect(onDone).not.toHaveBeenCalled()
      expect(onReject).not.toHaveBeenCalled()
      expect(toolUseConfirm.onAllow).not.toHaveBeenCalled()
      expect(toolUseConfirm.onReject).not.toHaveBeenCalled()
      expect(flattenOutput(mounted.getOutput())).toContain(
        'Showtruncatedpreview',
      )
    } finally {
      mounted.cleanup()
    }
  })

  test('toggling back hides the omitted middle content again without deciding the permission', async () => {
    const middleMarker = 'MIDDLE_SECRET_MARKER'
    const code = `${'a'.repeat(7_000)}\n${middleMarker}\n${'b'.repeat(3_000)}`
    const onDone = mock(() => {})
    const toolUseConfirm = createToolUseConfirm({ input: { code } })
    const mounted = await renderReplPermission(toolUseConfirm, { onDone })

    try {
      mounted.stdin.write('4')
      await waitFor(() =>
        flattenOutput(mounted.getOutput()).includes(middleMarker),
      )

      mounted.stdin.write('4')
      await waitFor(() =>
        !flattenOutput(mounted.getFrame()).includes(middleMarker) &&
        flattenOutput(mounted.getFrame()).includes('Showfullscript'),
      )

      expect(flattenOutput(mounted.getFrame())).not.toContain(middleMarker)
      expect(onDone).not.toHaveBeenCalled()
      expect(toolUseConfirm.onAllow).not.toHaveBeenCalled()
      expect(toolUseConfirm.onReject).not.toHaveBeenCalled()
    } finally {
      mounted.cleanup()
    }
  })
})
