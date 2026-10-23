import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { snapshotEnv } from '../test/envSnapshot.js'
import type { ToolUseContext, Tools } from '../Tool.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import type { DiagnosticFile } from '../services/diagnosticTracking.js'
import type { Attachment } from './attachments.js'

const debugMessages: string[] = []
const realDebugModule = {
  ...await import(`./debug.js?real=${Date.now()}-${Math.random()}`),
}
const realLSPRegistry = {
  ...await import(`../services/lsp/LSPDiagnosticRegistry.js?real=${Date.now()}-${Math.random()}`),
}

afterAll(() => {
  mock.module('./debug.js', () => realDebugModule)
  mock.module('../services/lsp/LSPDiagnosticRegistry.js', () => realLSPRegistry)
})

let diagnosticSets: Array<{ serverName: string; files: DiagnosticFile[] }> = []
let nextDeliveryDelay: number | null = null
const checkForLSPDiagnosticsOptions: unknown[] = []
const getNextLSPDiagnosticDeliveryDelayCalls: Array<number | undefined> = []
const { DIAGNOSTIC_DELIVERY_DEBOUNCE_MS } = realLSPRegistry

const checkForLSPDiagnosticsMock = mock((options?: unknown) => {
  checkForLSPDiagnosticsOptions.push(options)
  return diagnosticSets
})
const clearAllLSPDiagnosticsMock = mock(() => {
  diagnosticSets = []
})
const getNextLSPDiagnosticDeliveryDelayMock = mock((now?: number) => {
  getNextLSPDiagnosticDeliveryDelayCalls.push(now)
  return nextDeliveryDelay
})

mock.module('./debug.js', () => ({
  ...realDebugModule,
  logForDebugging: mock((message: string) => {
    debugMessages.push(message)
  }),
}))

mock.module('../services/lsp/LSPDiagnosticRegistry.js', () => ({
  ...realLSPRegistry,
  checkForLSPDiagnostics: checkForLSPDiagnosticsMock,
  clearAllLSPDiagnostics: clearAllLSPDiagnosticsMock,
  getNextLSPDiagnosticDeliveryDelay: getNextLSPDiagnosticDeliveryDelayMock,
}))

const { getAttachmentMessages, __test } = await import(
  `./attachments.ts?test=${Date.now()}-${Math.random()}`
)

let restoreEnv: () => void

type DiagnosticsAttachment = Extract<Attachment, { type: 'diagnostics' }>

function lspDiagnosticFile(message = 'stable diagnostic'): DiagnosticFile {
  return {
    uri: '/repo/a.ts',
    diagnostics: [
      {
        message,
        severity: 'Error',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        source: 'typescript',
        code: 'TS1000',
      },
    ],
  }
}

function makeToolUseContext(): ToolUseContext {
  let inProgressToolUseIDs = new Set<string>()

  return {
    abortController: new AbortController(),
    readFileState: {} as ToolUseContext['readFileState'],
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: {}, clients: [] },
      toolPermissionContext: { mode: 'default' },
      sessionHooks: new Map(),
      mainLoopModel: 'gpt-4o',
      effortValue: undefined,
      advisorModel: undefined,
    }),
    setAppState: () => {},
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools: [{ name: BASH_TOOL_NAME } as Tools[number]],
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      mainLoopModel: 'gpt-4o',
    },
    nestedMemoryAttachmentTriggers: new Set(),
    loadedNestedMemoryPaths: new Set(),
    dynamicSkillDirTriggers: new Set(),
    discoveredSkillNames: new Set(),
    setInProgressToolUseIDs: updater => {
      inProgressToolUseIDs = updater(inProgressToolUseIDs)
    },
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

async function collectLSPDiagnosticAttachments(): Promise<
  DiagnosticsAttachment[]
> {
  const diagnosticsAttachments: DiagnosticsAttachment[] = []

  for await (const message of getAttachmentMessages(
    null,
    makeToolUseContext(),
    null,
    [],
    [],
    'compact',
    { skipSkillDiscovery: true },
  )) {
    if (message.attachment.type === 'diagnostics') {
      diagnosticsAttachments.push(message.attachment)
    }
  }

  return diagnosticsAttachments
}

describe('LSP diagnostic attachment filtering', () => {
  beforeEach(() => {
    restoreEnv = snapshotEnv(
      ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_ATTACHMENTS'],
      { clear: true },
    )
    diagnosticSets = []
    nextDeliveryDelay = null
    checkForLSPDiagnosticsOptions.length = 0
    getNextLSPDiagnosticDeliveryDelayCalls.length = 0
    debugMessages.length = 0
    checkForLSPDiagnosticsMock.mockClear()
    clearAllLSPDiagnosticsMock.mockClear()
    getNextLSPDiagnosticDeliveryDelayMock.mockClear()
  })

  afterEach(() => {
    restoreEnv()
  })

  test('does not return a diagnostics attachment for an empty final LSP payload', async () => {
    diagnosticSets = [
      {
        serverName: 'typescript',
        files: [{ uri: '/repo/src/clean.ts', diagnostics: [] }],
      },
    ]

    const attachments = await collectLSPDiagnosticAttachments()

    expect(attachments).toEqual([])
    expect(clearAllLSPDiagnosticsMock).not.toHaveBeenCalled()
    expect(debugMessages).toContain(
      'LSP Diagnostics: No diagnostic attachments to return after filtering empty diagnostic payloads',
    )
  })

  test('returns a diagnostics attachment for a compact storm summary-only payload', async () => {
    const summaryFile: DiagnosticFile = {
      uri: 'lsp://diagnostic-storm/typescript',
      diagnostics: [
        {
          message:
            'LSP diagnostic storm: server=typescript raw=210 duplicates=210 dropped=0 delivered=0 topFiles=[noisy.ts:210]',
          severity: 'Info',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          source: 'openclaude-lsp',
          code: 'diagnostic-storm',
        },
      ],
    }
    diagnosticSets = [{ serverName: 'typescript', files: [summaryFile] }]

    const attachments = await collectLSPDiagnosticAttachments()

    expect(attachments).toEqual([
      { type: 'diagnostics', files: [summaryFile], isNew: true },
    ])
    expect(clearAllLSPDiagnosticsMock).not.toHaveBeenCalled()
    expect(debugMessages).toContain(
      'LSP Diagnostics: Returning 1 diagnostic attachment(s)',
    )
  })

  test('waits once for debounced diagnostics at the query boundary', async () => {
    const file = lspDiagnosticFile()
    let now = 100
    const waits: number[] = []
    nextDeliveryDelay = 150

    const attachments = await __test.getLSPDiagnosticAttachments(
      makeToolUseContext(),
      {
        now: () => now,
        wait: async ms => {
          waits.push(ms)
          now += ms
          diagnosticSets = [{ serverName: 'typescript', files: [file] }]
        },
      },
    )

    expect(checkForLSPDiagnosticsOptions).toEqual([
      { respectDebounce: true, now: 100 },
      { respectDebounce: true, now: 250 },
    ])
    expect(getNextLSPDiagnosticDeliveryDelayCalls).toEqual([100])
    expect(waits).toEqual([150])
    expect(attachments).toEqual([
      {
        type: 'diagnostics',
        files: [file],
        isNew: true,
      },
    ])
  })

  test('caps the query-boundary wait when the next ready delay is longer', async () => {
    let now = 0
    const waits: number[] = []
    nextDeliveryDelay = DIAGNOSTIC_DELIVERY_DEBOUNCE_MS + 250

    const attachments = await __test.getLSPDiagnosticAttachments(
      makeToolUseContext(),
      {
        now: () => now,
        wait: async ms => {
          waits.push(ms)
          now += ms
        },
      },
    )

    expect(checkForLSPDiagnosticsOptions).toEqual([
      { respectDebounce: true, now: 0 },
      { respectDebounce: true, now: DIAGNOSTIC_DELIVERY_DEBOUNCE_MS },
    ])
    expect(getNextLSPDiagnosticDeliveryDelayCalls).toEqual([0])
    expect(waits).toEqual([DIAGNOSTIC_DELIVERY_DEBOUNCE_MS])
    expect(attachments).toEqual([])
  })
})
