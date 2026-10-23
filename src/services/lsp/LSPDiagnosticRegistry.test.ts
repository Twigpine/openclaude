import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Diagnostic, DiagnosticFile } from '../diagnosticTracking.js'

const debugMessages: string[] = []

const realDebugModule = {
  ...await import(`../../utils/debug.js?real=${Date.now()}-${Math.random()}`),
}
const realSlowOperations = {
  ...await import(`../../utils/slowOperations.js?real=${Date.now()}-${Math.random()}`),
}

afterAll(() => {
  mock.module('../../utils/debug.js', () => realDebugModule)
  mock.module('../../utils/slowOperations.js', () => realSlowOperations)
})

mock.module('../../utils/debug.js', () => ({
  ...realDebugModule,
  logForDebugging: mock((message: string) => {
    debugMessages.push(message)
  }),
}))
// Other tests mock slowOperations process-wide; restore the real serializer so
// diagnostic keys keep message/range/code entropy under full-suite ordering.
mock.module('../../utils/slowOperations.js', () => ({
  ...realSlowOperations,
  jsonStringify: JSON.stringify,
}))

const registry = await import(
  `./LSPDiagnosticRegistry.ts?test=${Date.now()}-${Math.random()}`
)

function diagnostic(message: string, line = 0): Diagnostic {
  return {
    message,
    severity: 'Error',
    range: {
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
    source: 'typescript',
    code: `TS${line}`,
  }
}

function diagnosticFile(uri: string, messages: string[]): DiagnosticFile {
  return {
    uri,
    diagnostics: messages.map((message, index) => diagnostic(message, index)),
  }
}

function diagnosticCount(files: DiagnosticFile[]): number {
  return files.reduce((sum, file) => sum + file.diagnostics.length, 0)
}

function checkWithDebounce(now: number) {
  return registry.checkForLSPDiagnostics({ now, respectDebounce: true })
}

function deliveryLogs(): string[] {
  return debugMessages.filter(message =>
    message.startsWith('LSP Diagnostics: Delivering '),
  )
}

function expectNoZeroDiagnosticDeliveryLog(): void {
  expect(
    deliveryLogs().some(message => message.includes(' with 0 diagnostic(s) ')),
  ).toBe(false)
}

describe('LSPDiagnosticRegistry storm control', () => {
  beforeEach(() => {
    registry.resetAllLSPDiagnosticState()
    debugMessages.length = 0
  })

  test('dedupes repeated identical diagnostics before delivery', () => {
    const repeated = diagnostic('same missing import')
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [{ uri: '/repo/a.ts', diagnostics: [repeated, repeated] }],
    })

    const diagnosticSets = registry.checkForLSPDiagnostics()

    expect(diagnosticSets).toHaveLength(1)
    expect(diagnosticSets[0]?.files).toEqual([
      { uri: '/repo/a.ts', diagnostics: [repeated] },
    ])
  })

  test('coalesces repeated same-file burst snapshots into one stable delivery', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/a.ts', ['stale diagnostic'])],
      timestamp: 1_000,
    })
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/a.ts', ['final diagnostic'])],
      timestamp: 1_100,
    })

    expect(checkWithDebounce(1_150)).toEqual([])

    const diagnosticSets = checkWithDebounce(1_400)

    expect(diagnosticSets).toHaveLength(1)
    expect(diagnosticSets[0]?.files).toEqual([
      diagnosticFile('/repo/a.ts', ['final diagnostic']),
    ])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('coalesces several files into a bounded deterministic stable delivery', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        ...Array.from({ length: 32 }, (_, index) =>
          diagnosticFile(`/repo/file-${index}.ts`, [`initial ${index}`]),
        ),
      ],
      timestamp: 2_000,
    })
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/file-1.ts', ['latest file 1'])],
      timestamp: 2_100,
    })

    const files = checkWithDebounce(2_400)[0]?.files ?? []

    expect(diagnosticCount(files)).toBe(30)
    expect(files.map(file => file.uri)).toEqual([
      '/repo/file-0.ts',
      '/repo/file-1.ts',
      '/repo/file-2.ts',
      '/repo/file-3.ts',
      '/repo/file-4.ts',
      '/repo/file-5.ts',
      '/repo/file-6.ts',
      '/repo/file-7.ts',
      '/repo/file-8.ts',
      '/repo/file-9.ts',
      '/repo/file-10.ts',
      '/repo/file-11.ts',
      '/repo/file-12.ts',
      '/repo/file-13.ts',
      '/repo/file-14.ts',
      '/repo/file-15.ts',
      '/repo/file-16.ts',
      '/repo/file-17.ts',
      '/repo/file-18.ts',
      '/repo/file-19.ts',
      '/repo/file-20.ts',
      '/repo/file-21.ts',
      '/repo/file-22.ts',
      '/repo/file-23.ts',
      '/repo/file-24.ts',
      '/repo/file-25.ts',
      '/repo/file-26.ts',
      '/repo/file-27.ts',
      '/repo/file-28.ts',
      '/repo/file-29.ts',
    ])
    expect(files[1]?.diagnostics[0]?.message).toBe('latest file 1')
  })

  test('delivers new diagnostics after the debounce window', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/a.ts', ['first diagnostic'])],
      timestamp: 3_000,
    })

    expect(checkWithDebounce(3_100)).toEqual([])

    const firstDelivery = checkWithDebounce(3_300)
    expect(firstDelivery[0]?.files).toEqual([
      diagnosticFile('/repo/a.ts', ['first diagnostic']),
    ])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/a.ts', ['second diagnostic'])],
      timestamp: 3_650,
    })

    expect(checkWithDebounce(3_700)).toEqual([])
    const secondDelivery = checkWithDebounce(3_950)

    expect(secondDelivery[0]?.files).toEqual([
      diagnosticFile('/repo/a.ts', ['second diagnostic']),
    ])
  })

  test('flushes active bursts after the max coalescing delay', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/a.ts', ['first diagnostic'])],
      timestamp: 4_000,
    })
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/a.ts', ['latest diagnostic'])],
      timestamp: 5_900,
    })

    const diagnosticSets = checkWithDebounce(6_100)

    expect(diagnosticSets[0]?.files).toEqual([
      diagnosticFile('/repo/a.ts', ['latest diagnostic']),
    ])
  })

  test('reports the next stable delivery delay for pending diagnostics', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [diagnosticFile('/repo/a.ts', ['first diagnostic'])],
      timestamp: 15_000,
    })

    expect(registry.getNextLSPDiagnosticDeliveryDelay(15_100)).toBe(150)

    const diagnosticSets = checkWithDebounce(15_250)
    expect(diagnosticSets[0]?.files).toEqual([
      diagnosticFile('/repo/a.ts', ['first diagnostic']),
    ])
    expect(registry.getNextLSPDiagnosticDeliveryDelay(15_260)).toBeNull()
  })

  test('clearing diagnostics updates state without producing attachments', () => {
    const file = diagnosticFile('/repo/a.ts', ['transient diagnostic'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
      timestamp: 7_000,
    })
    expect(checkWithDebounce(7_300)).toHaveLength(1)

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [{ uri: '/repo/a.ts', diagnostics: [] }],
      timestamp: 7_600,
    })

    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
    expect(checkWithDebounce(7_900)).toEqual([])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
      timestamp: 8_200,
    })

    expect(checkWithDebounce(8_500)[0]?.files).toEqual([
      file,
    ])
  })

  test('does not dedupe identical diagnostics across different servers', () => {
    const sharedFile = diagnosticFile('/repo/a.ts', ['same text and range'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [sharedFile],
      timestamp: 9_000,
    })
    expect(checkWithDebounce(9_300)[0]?.files).toEqual([
      sharedFile,
    ])

    registry.registerPendingLSPDiagnostic({
      serverName: 'eslint',
      files: [sharedFile],
      timestamp: 9_600,
    })

    expect(checkWithDebounce(9_900)[0]?.files).toEqual([
      sharedFile,
    ])
  })

  test('does not let one active server burst block stable diagnostics from another server', () => {
    const stableFile = diagnosticFile('/repo/stable.ts', ['stable diagnostic'])
    const activeFile = diagnosticFile('/repo/active.ts', ['active diagnostic'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [stableFile],
      timestamp: 10_000,
    })
    registry.registerPendingLSPDiagnostic({
      serverName: 'eslint',
      files: [activeFile],
      timestamp: 10_390,
    })

    const firstDelivery = checkWithDebounce(10_400)

    expect(firstDelivery[0]?.serverName).toBe('typescript')
    expect(firstDelivery[0]?.files).toEqual([stableFile])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(1)

    const secondDelivery = checkWithDebounce(10_700)

    expect(secondDelivery[0]?.serverName).toBe('eslint')
    expect(secondDelivery[0]?.files).toEqual([activeFile])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('does not let one same-server file hitting max delay flush a fresh file', () => {
    const oldFile = diagnosticFile('/repo/old.ts', ['old diagnostic'])
    const freshFile = diagnosticFile('/repo/fresh.ts', ['fresh diagnostic'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [oldFile],
      timestamp: 11_000,
    })
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [freshFile],
      timestamp: 12_990,
    })

    const firstDelivery = checkWithDebounce(13_001)

    expect(firstDelivery[0]?.serverName).toBe('typescript')
    expect(firstDelivery[0]?.files).toEqual([oldFile])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(1)

    expect(checkWithDebounce(13_100)).toEqual([])

    const secondDelivery = checkWithDebounce(13_250)

    expect(secondDelivery[0]?.files).toEqual([freshFile])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('does not reattach unchanged diagnostics across turns', () => {
    const file = diagnosticFile('/repo/a.ts', ['same missing import'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })
    const firstDiagnosticSets = registry.checkForLSPDiagnostics()
    expect(firstDiagnosticSets).toHaveLength(1)
    expect(diagnosticCount(firstDiagnosticSets[0]!.files)).toBe(1)

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })

    expect(registry.checkForLSPDiagnostics()).toEqual([])
    expectNoZeroDiagnosticDeliveryLog()
  })

  test('returns no diagnostic set for raw empty diagnostic files', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [{ uri: '/repo/cleared.ts', diagnostics: [] }],
    })

    expect(registry.checkForLSPDiagnostics()).toEqual([])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
    expect(deliveryLogs()).toEqual([])
  })

  test('clock injection does not enable debounce unless requested', () => {
    const file = diagnosticFile('/repo/a.ts', ['clock-only diagnostic'])
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
      timestamp: 14_000,
    })

    expect(registry.checkForLSPDiagnostics({ now: 14_001 })[0]?.files).toEqual([
      file,
    ])
  })

  test('snapshots pending diagnostics without consuming delivery', () => {
    const file = diagnosticFile('/repo/a.ts', ['same missing import'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })

    const snapshot = registry.getPendingLSPDiagnosticsSnapshot()

    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.files).toEqual([file])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(1)

    const delivered = registry.checkForLSPDiagnostics()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.files).toEqual([file])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('returned pending snapshot is detached from registry state', () => {
    const file = diagnosticFile('/repo/a.ts', ['same missing import'])
    const expected = diagnosticFile('/repo/a.ts', ['same missing import'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })

    const snapshot = registry.getPendingLSPDiagnosticsSnapshot()
    snapshot[0]!.files[0]!.diagnostics[0]!.message = 'mutated by caller'
    snapshot[0]!.files[0]!.diagnostics.push(diagnostic('extra mutation', 99))
    snapshot[0]!.files.push(diagnosticFile('/repo/extra.ts', ['extra file']))

    expect(registry.getPendingLSPDiagnosticCount()).toBe(1)
    const delivered = registry.checkForLSPDiagnostics()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.files).toEqual([expected])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('snapshots pending diagnostics even when delivery would filter unchanged diagnostics', () => {
    const file = diagnosticFile('/repo/a.ts', ['same missing import'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })
    expect(registry.checkForLSPDiagnostics()).toHaveLength(1)

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })

    const snapshot = registry.getPendingLSPDiagnosticsSnapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.files).toEqual([file])

    expect(registry.checkForLSPDiagnostics()).toEqual([])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('snapshots pending diagnostics grouped by server without consuming delivery', () => {
    const typescriptFile = diagnosticFile('/repo/a.ts', ['typescript error'])
    const eslintFile = diagnosticFile('/repo/b.ts', ['eslint error'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [typescriptFile],
    })
    registry.registerPendingLSPDiagnostic({
      serverName: 'eslint',
      files: [eslintFile],
    })

    const snapshot = registry.getPendingLSPDiagnosticsSnapshot()

    expect(snapshot).toEqual([
      { serverName: 'typescript', files: [typescriptFile] },
      { serverName: 'eslint', files: [eslintFile] },
    ])
    expect(registry.getPendingLSPDiagnosticCount()).toBe(2)

    const delivered = registry.checkForLSPDiagnostics()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.files).toHaveLength(2)
    expect(delivered[0]?.files).toEqual(
      expect.arrayContaining([typescriptFile, eslintFile]),
    )
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('allows edited files to resend diagnostics when cleared by file URI', () => {
    const file = diagnosticFile('/repo/a.ts', ['same missing import'])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })
    const firstDiagnosticSets = registry.checkForLSPDiagnostics()
    expect(firstDiagnosticSets).toHaveLength(1)
    expect(diagnosticCount(firstDiagnosticSets[0]!.files)).toBe(1)

    // Intentionally clear by file:// URI while diagnostics use a plain path;
    // both forms must normalize to the same delivered-diagnostic key.
    registry.clearDeliveredDiagnosticsForFile('file:///repo/a.ts')
    expect(registry.checkForLSPDiagnostics()).toEqual([])

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [file],
    })

    const secondDiagnosticSets = registry.checkForLSPDiagnostics()
    expect(secondDiagnosticSets).toHaveLength(1)
    expect(diagnosticCount(secondDiagnosticSets[0]!.files)).toBe(1)
  })

  test('enforces per-file and per-turn diagnostic caps', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        diagnosticFile(
          '/repo/crowded.ts',
          Array.from({ length: 12 }, (_, index) => `crowded ${index}`),
        ),
        ...Array.from({ length: 25 }, (_, index) =>
          diagnosticFile(`/repo/file-${index}.ts`, [`other ${index}`]),
        ),
      ],
    })

    const files = registry.checkForLSPDiagnostics()[0]?.files ?? []

    expect(diagnosticCount(files)).toBe(30)
    expect(
      files.find(file => file.uri === '/repo/crowded.ts')?.diagnostics.length,
    ).toBe(10)
  })

  test('preserves recently active file diagnostics when total turn cap is exceeded', () => {
    registry.recordLSPDiagnosticFileActivity('/repo/recent.ts')
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        ...Array.from({ length: 30 }, (_, index) =>
          diagnosticFile(`/repo/old-${index}.ts`, [`old ${index}`]),
        ),
        diagnosticFile('/repo/recent.ts', ['recent file should survive']),
      ],
    })

    const files = registry.checkForLSPDiagnostics()[0]?.files ?? []

    expect(diagnosticCount(files)).toBe(30)
    expect(files.some(file => file.uri === '/repo/recent.ts')).toBe(true)
  })

  test('emits one compact storm summary with rolling top files and no diagnostic text', () => {
    const firstStormFile = diagnosticFile(
      '/home/alice/project/src/noisy-a.ts',
      Array.from(
        { length: 120 },
        (_, index) => `do not leak raw diagnostic text A ${index}`,
      ),
    )
    const secondStormFile = diagnosticFile(
      '/home/alice/project/src/noisy-b.ts',
      Array.from(
        { length: 90 },
        (_, index) => `do not leak raw diagnostic text B ${index}`,
      ),
    )

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [firstStormFile, secondStormFile],
    })

    const files = registry.checkForLSPDiagnostics()[0]?.files ?? []
    const stormSummary = files.find(file =>
      file.uri.startsWith('lsp://diagnostic-storm/typescript'),
    )
    const stormLogs = debugMessages.filter(message =>
      message.startsWith('LSP diagnostic storm: server=typescript'),
    )

    expect(diagnosticCount(files)).toBeLessThanOrEqual(30)
    expect(stormSummary?.diagnostics).toHaveLength(1)
    expect(stormSummary?.diagnostics[0]?.message).toContain('raw=210')
    expect(stormSummary?.diagnostics[0]?.message).toContain('dropped=')
    expect(stormSummary?.diagnostics[0]?.message).toContain('delivered=')
    expect(stormSummary?.diagnostics[0]?.message).toContain(
      'topFiles=[noisy-a.ts:120, noisy-b.ts:90]',
    )
    expect(stormSummary?.diagnostics[0]?.message).not.toContain(
      'do not leak raw diagnostic text',
    )
    expect(stormLogs).toHaveLength(1)
  })

  test('does not trickle capped storm diagnostics into later turns', () => {
    const stormFile = diagnosticFile(
      '/repo/noisy.ts',
      Array.from({ length: 210 }, (_, index) => `storm diagnostic ${index}`),
    )

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [stormFile],
    })
    const firstFiles = registry.checkForLSPDiagnostics()[0]?.files ?? []
    const firstRegularFile = firstFiles.find(file => file.uri === stormFile.uri)

    expect(firstRegularFile?.diagnostics.map(diag => diag.code)).toEqual(
      Array.from({ length: 10 }, (_, index) => `TS${index}`),
    )

    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [stormFile],
    })
    const secondFiles = registry.checkForLSPDiagnostics()[0]?.files ?? []

    expect(secondFiles.map(file => file.uri)).toEqual([
      'lsp://diagnostic-storm/typescript',
    ])
    expect(diagnosticCount(secondFiles)).toBe(1)
    expectNoZeroDiagnosticDeliveryLog()
  })

  test('returns compact storm summaries when volume limiting leaves only reserved summaries', () => {
    for (let index = 0; index < 30; index++) {
      registry.registerPendingLSPDiagnostic({
        serverName: `server-${index}`,
        files: [
          diagnosticFile(
            `/repo/storm-${index}.ts`,
            Array.from(
              { length: 201 },
              (_, diagnosticIndex) =>
                `storm ${index} diagnostic ${diagnosticIndex}`,
            ),
          ),
        ],
      })
    }

    const files = registry.checkForLSPDiagnostics()[0]?.files ?? []

    expect(files).toHaveLength(30)
    expect(files.every(file => file.uri.startsWith('lsp://diagnostic-storm/')))
      .toBe(true)
    expect(diagnosticCount(files)).toBe(30)
    expect(registry.getPendingLSPDiagnosticCount()).toBe(0)
    expectNoZeroDiagnosticDeliveryLog()
  })

  test('reserves compact summaries for multiple storming servers before full diagnostics', () => {
    registry.registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: Array.from({ length: 220 }, (_, index) =>
        diagnosticFile(`/repo/typescript-${index}.ts`, [
          `typescript storm ${index}`,
        ]),
      ),
    })
    registry.registerPendingLSPDiagnostic({
      serverName: 'eslint',
      files: [
        diagnosticFile(
          '/repo/eslint.ts',
          Array.from({ length: 220 }, (_, index) => `eslint storm ${index}`),
        ),
      ],
    })

    const files = registry.checkForLSPDiagnostics()[0]?.files ?? []
    const summaryUris = files
      .filter(file => file.uri.startsWith('lsp://diagnostic-storm/'))
      .map(file => file.uri)

    expect(diagnosticCount(files)).toBeLessThanOrEqual(30)
    expect(summaryUris).toContain('lsp://diagnostic-storm/typescript')
    expect(summaryUris).toContain('lsp://diagnostic-storm/eslint')
  })
})
