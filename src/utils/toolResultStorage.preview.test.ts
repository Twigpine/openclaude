import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getOriginalCwd,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  getProjectRoot,
  switchSession,
} from '../bootstrap/state.ts'
import type { SessionId } from '../types/ids.ts'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.ts'
import { formatFileSize } from './format.ts'
import {
  getLargeOutputInstructions,
  getLargeOutputPersistenceFailureInstructions,
} from './mcpOutputStorage.ts'
import { createUserMessage } from './messages.ts'
import { jsonStringify } from './slowOperations.ts'
import {
  applyToolResultReplacementsToMessages,
  buildLargeToolResultMessage,
  formatOmissionMarker,
  generateFilePreview,
  generatePreview,
  isPersistError,
  persistToolResult,
  PREVIEW_SIZE_BYTES,
  reconstructContentReplacementState,
} from './toolResultStorage.ts'

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

function expectWithinBudget(value: string, maxBytes: number): void {
  expect(byteLength(value)).toBeLessThanOrEqual(maxBytes)
  expect(value).not.toContain('\uFFFD')
}

function expectExactOmittedByteCount(
  content: string,
  preview: string,
): void {
  const matches = [...preview.matchAll(/… (\d+) bytes omitted …/g)]
  const match = matches.find(candidate => {
    const retainedBytes = byteLength(preview) - byteLength(candidate[0])
    return Number(candidate[1]) === byteLength(content) - retainedBytes
  })
  expect(match).toBeDefined()
  const marker = match![0]
  const retainedBytes = byteLength(preview) - byteLength(marker)
  expect(Number(match![1])).toBe(byteLength(content) - retainedBytes)
}

describe('generatePreview UTF-8 byte accounting', () => {
  test.each([
    ['just below', 'a'.repeat(63)],
    ['exactly at', 'a'.repeat(64)],
  ])('returns ASCII %s the limit unchanged', (_label, content) => {
    expect(generatePreview(content, 64)).toEqual({
      preview: content,
      hasMore: false,
      strategy: 'complete',
    })
  })

  test('truncates ASCII just above the limit within the byte budget', () => {
    const content = 'a'.repeat(65)
    const result = generatePreview(content, 64)

    expect(result.hasMore).toBe(true)
    expect(result.strategy).toBe('head-tail')
    expectWithinBudget(result.preview, 64)
    expectExactOmittedByteCount(content, result.preview)
  })

  test('uses UTF-8 bytes when CJK is under the UTF-16 count but over the limit', () => {
    const content = '界'.repeat(30)
    expect(content.length).toBeLessThan(80)
    expect(byteLength(content)).toBeGreaterThan(80)

    const result = generatePreview(content, 80)

    expect(result.hasMore).toBe(true)
    expectWithinBudget(result.preview, 80)
    expectExactOmittedByteCount(content, result.preview)
  })

  test('does not corrupt emoji or combining sequences at byte boundaries', () => {
    const content = '🙂e\u0301'.repeat(80)
    const result = generatePreview(content, 97)

    expect(result.hasMore).toBe(true)
    expectWithinBudget(result.preview, 97)
    expectExactOmittedByteCount(content, result.preview)
  })

  test('returns empty content unchanged', () => {
    expect(generatePreview('', 32)).toEqual({
      preview: '',
      hasMore: false,
      strategy: 'complete',
    })
  })
})

describe('generatePreview head and tail selection', () => {
  test('keeps command context and the only failure root while omitting the middle', () => {
    const content = [
      '$ bun run build',
      'Compiling packages...',
      ...Array.from({ length: 200 }, (_, index) => `routine output ${index}`),
      'Error: build failed',
      'at decisiveStackRoot (/workspace/src/index.ts:42:7)',
    ].join('\n')

    const result = generatePreview(content, 240)

    expect(result.preview).toStartWith('$ bun run build\n')
    expect(result.preview).toContain('Error: build failed')
    expect(result.preview).toContain(
      'at decisiveStackRoot (/workspace/src/index.ts:42:7)',
    )
    expect(result.preview).not.toContain('routine output 100')
    expectWithinBudget(result.preview, 240)
    expectExactOmittedByteCount(content, result.preview)
  })

  test('uses complete-line boundaries for CRLF input', () => {
    const content = [
      'COMMAND context',
      ...Array.from({ length: 80 }, (_, index) => `middle-${index}`),
      'FAILURE summary',
      '',
    ].join('\r\n')

    const result = generatePreview(content, 120)
    const markerIndex = result.preview.indexOf('… ')
    const afterMarker = result.preview.indexOf(' …') + ' …'.length

    expect(result.preview.slice(0, markerIndex)).toEndWith('\r\n')
    expect(result.preview.slice(afterMarker)).toStartWith('\r\n')
    expect(result.preview).toContain('FAILURE summary\r\n')
    expectWithinBudget(result.preview, 120)
  })

  test('falls back to UTF-8-safe hard cuts for one giant line', () => {
    const content = `HEAD-${'界🙂'.repeat(100)}-TAIL`
    const result = generatePreview(content, 96)

    expect(result.preview).toStartWith('HEAD-')
    expect(result.preview).toEndWith('-TAIL')
    expectWithinBudget(result.preview, 96)
    expectExactOmittedByteCount(content, result.preview)
  })

  test('uses newlines that fall exactly near the allocation targets', () => {
    // With this content size and budget, 28 bytes go to the head and 19 to
    // the tail. Put line breaks exactly at those selection boundaries.
    const headLine = `${'H'.repeat(27)}\n`
    const content = `${headLine}${'m'.repeat(300)}\nTAIL-LINE`
    const result = generatePreview(content, 72)
    const marker = result.preview.match(/… \d+ bytes omitted …/)![0]
    const [head, tail] = result.preview.split(marker)

    expect(head).toBe(headLine)
    expect(tail).toBe('\nTAIL-LINE')
    expectWithinBudget(result.preview, 72)
  })

  test('can spend a tiny budget entirely on the omission marker', () => {
    const content = 'x'.repeat(100)
    const marker = '… 100 bytes omitted …'
    const result = generatePreview(content, byteLength(marker))

    expect(result.preview).toBe(marker)
    expect(result.hasMore).toBe(true)
    expect(result.strategy).toBe('head-tail')
  })

  test('falls back to a bounded head-only preview when the marker cannot fit', () => {
    const content = 'x'.repeat(100)
    const result = generatePreview(content, 1)

    expect(result.preview).toBe('x')
    expect(result.hasMore).toBe(true)
    expect(result.strategy).toBe('head-only')
    expectWithinBudget(result.preview, 1)
  })

  test('does not duplicate content when the potential head and tail are close', () => {
    const content = '0123456789'.repeat(5)
    const result = generatePreview(content, 49)
    const match = result.preview.match(/… (\d+) bytes omitted …/)

    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThan(0)
    expectWithinBudget(result.preview, 49)
    expectExactOmittedByteCount(content, result.preview)
  })

  test('preserves a trailing newline in the retained tail', () => {
    const content = `head\n${'middle\n'.repeat(80)}failure summary\n`
    const result = generatePreview(content, 96)

    expect(result.preview).toEndWith('failure summary\n')
    expectWithinBudget(result.preview, 96)
  })

  test('reads a UTF-8-safe head and tail preview from a persisted file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-file-preview-'))
    const filepath = join(dir, 'large-output.txt')
    const content = `COMMAND CONTEXT\n${'routine 界 output\n'.repeat(300)}FAILURE ROOT: src/index.ts:42\n`
    await writeFile(filepath, content, 'utf8')

    try {
      const result = await generateFilePreview(
        filepath,
        200,
      )

      expect(result.strategy).toBe('head-tail')
      expect(result.preview).toStartWith('COMMAND CONTEXT\n')
      expect(result.preview).toContain('FAILURE ROOT: src/index.ts:42')
      expectWithinBudget(result.preview, 200)
      expectExactOmittedByteCount(content, result.preview)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['raw bytes over the limit', 3_000],
    ['raw bytes under the limit that expand when decoded', 1_000],
  ])('bounds malformed UTF-8 after decoding: %s', async (_label, size) => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-file-preview-invalid-utf8-'))
    const filepath = join(dir, 'invalid-output.bin')
    await writeFile(filepath, Buffer.alloc(size, 0xff))

    try {
      const result = await generateFilePreview(filepath, 2_000)
      const marker = result.preview.match(/… (\d+) bytes omitted …/)
      const retainedSourceBytes = [...result.preview].filter(
        character => character === '\uFFFD',
      ).length

      expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(
        2_000,
      )
      expect(result.hasMore).toBe(true)
      expect(result.strategy).toBe('head-tail')
      expect(result.retainedBytesValidUtf8).toBe(false)
      expect(marker).not.toBeNull()
      expect(Number(marker![1])).toBe(size - retainedSourceBytes)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('derives the preview size from the opened file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-file-preview-size-'))
    const filepath = join(dir, 'large-output.txt')
    const content = `COMMAND CONTEXT\n${'routine output\n'.repeat(80)}FAILURE ROOT\n`
    await writeFile(filepath, content, 'utf8')

    try {
      const result = await generateFilePreview(filepath, 96)

      expect(result.strategy).toBe('head-tail')
      expect(result.preview).toStartWith('COMMAND CONTEXT\n')
      expect(result.preview).toContain('FAILURE ROOT')
      expectWithinBudget(result.preview, 96)
      expectExactOmittedByteCount(content, result.preview)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reports actual omitted bytes for a short file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-file-preview-stale-size-'))
    const filepath = join(dir, 'large-output.txt')
    const content = `HEAD\n${'middle\n'.repeat(30)}REAL TAIL\n`
    await writeFile(filepath, content, 'utf8')

    try {
      const result = await generateFilePreview(filepath, 96)

      expect(result.preview).toContain('REAL TAIL')
      expectWithinBudget(result.preview, 96)
      expectExactOmittedByteCount(content, result.preview)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('distinguishes a generated omission marker from marker-like output', () => {
    const content = [
      'COMMAND: printf "… 1 bytes omitted …"',
      ...Array.from({ length: 100 }, (_, index) => `middle-${index}`),
      'REAL TAIL',
    ].join('\n')
    const result = generatePreview(content, 120)

    expect(result.preview).toContain('… 1 bytes omitted …')
    expect(result.preview).toContain('REAL TAIL')
    expectExactOmittedByteCount(content, result.preview)
    expect(result.omittedBytes).toBeDefined()
    expect(result.markerStart).toBeDefined()
    const generatedMarker = formatOmissionMarker(result.omittedBytes!)
    expect(
      result.preview.slice(
        result.markerStart!,
        result.markerStart! + generatedMarker.length,
      ),
    ).toBe(generatedMarker)
  })
})

describe('generatePreview serialized JSON policy', () => {
  test('returns small JSON unchanged', () => {
    const content = '{"ok":"界"}'
    expect(generatePreview(content, 64, 'json')).toEqual({
      preview: content,
      hasMore: false,
      strategy: 'complete',
    })
  })

  test('uses an explicitly head-only partial fragment for large JSON', () => {
    const content = jsonStringify(
      {
        beginning: 'JSON_BEGIN',
        middle: '界'.repeat(200),
        ending: 'JSON_TAIL_MUST_NOT_APPEAR',
      },
      null,
      2,
    )

    const result = generatePreview(content, 96, 'json')

    expect(result.strategy).toBe('head-only')
    expect(result.hasMore).toBe(true)
    expect(result.preview).toContain('JSON_BEGIN')
    expect(result.preview).not.toContain('JSON_TAIL_MUST_NOT_APPEAR')
    expectWithinBudget(result.preview, 96)
  })
})

test('supports an honest head-only strategy when only an initial output chunk is available', () => {
  const content = `CAPTURED_HEAD\n${'middle\n'.repeat(80)}CAPTURED_CHUNK_TAIL`
  const result = generatePreview(content, 96, 'head-only')

  expect(result.strategy).toBe('head-only')
  expect(result.preview).toContain('CAPTURED_HEAD')
  expect(result.preview).not.toContain('CAPTURED_CHUNK_TAIL')
  expectWithinBudget(result.preview, 96)
})

describe('persisted tool-result preview integration', () => {
  let tempConfigDir: string
  let previousConfigDir: string | undefined
  let previousCwd: string
let previousProjectRoot: string
  let previousSessionId: SessionId

  beforeAll(async () => {
    tempConfigDir = await mkdtemp(join(tmpdir(), 'tool-preview-'))
    previousConfigDir = getClaudeConfigHomeDirOverrideForTesting()
    previousCwd = getOriginalCwd()
    previousProjectRoot = getProjectRoot()
    previousSessionId = getSessionId()
    setClaudeConfigHomeDirForTesting(tempConfigDir)
    setOriginalCwd(join(tempConfigDir, 'workspace'))
    setProjectRoot(join(tempConfigDir, 'workspace'))
    switchSession('tool-preview-session' as SessionId)
  })

  afterAll(async () => {
    switchSession(previousSessionId)
    setOriginalCwd(previousCwd)
    setProjectRoot(previousProjectRoot)
    setClaudeConfigHomeDirForTesting(previousConfigDir)
    await rm(tempConfigDir, { recursive: true, force: true })
  })

  test('keeps the full plain-text spill, reports UTF-8 bytes, and replays EEXIST deterministically', async () => {
    const content = `COMMAND: bun test\n${'routine 界 output\n'.repeat(300)}FAILURE ROOT: src/index.ts:42\n`
    const first = await persistToolResult(content, 'plain-text-preview')
    expect(isPersistError(first)).toBe(false)
    if (isPersistError(first)) throw new Error(first.error)

    expect(await readFile(first.filepath, 'utf8')).toBe(content)
    expect(first.originalSize).toBe(byteLength(content))
    expect(first.hasMore).toBe(true)
    expect(first.strategy).toBe('head-tail')
    expect(first.preview).toContain('COMMAND: bun test')
    expect(first.preview).toContain('FAILURE ROOT: src/index.ts:42')
    expectWithinBudget(first.preview, PREVIEW_SIZE_BYTES)

    const replay = await persistToolResult(content, 'plain-text-preview')
    expect(isPersistError(replay)).toBe(false)
    if (isPersistError(replay)) throw new Error(replay.error)
    expect(replay).toEqual(first)
    expect(await readFile(first.filepath, 'utf8')).toBe(content)
  })

  test('keeps serialized text blocks complete while exposing an honest JSON preview', async () => {
    const blocks = [
      {
        type: 'text' as const,
        text: `JSON_HEAD\n${'🙂 structured output\n'.repeat(200)}JSON_TAIL`,
      },
    ]
    const serialized = jsonStringify(blocks, null, 2)
    const result = await persistToolResult(blocks, 'json-preview')
    expect(isPersistError(result)).toBe(false)
    if (isPersistError(result)) throw new Error(result.error)

    expect(await readFile(result.filepath, 'utf8')).toBe(serialized)
    expect(result.originalSize).toBe(byteLength(serialized))
    expect(result.isJson).toBe(true)
    expect(result.strategy).toBe('head-only')
    expect(result.preview).not.toContain('JSON_TAIL')
    expectWithinBudget(result.preview, PREVIEW_SIZE_BYTES)

    const message = buildLargeToolResultMessage(result)
    expect(message).toContain(
      `Output size: ${result.originalSize.toLocaleString('en-US')} bytes (${formatFileSize(result.originalSize)})`,
    )
    expect(message).toContain(`Full output saved to: ${result.filepath}`)
    expect(message).toContain(
      'UTF-8-safe head-only partial serialized JSON fragment',
    )
    expect(message).toContain('may not be valid JSON')
    expect(message).toContain('2,000-byte total budget')
    expect(message).not.toContain('Preview (first')
  })

  test('replays a stored replacement record byte-identically without recomputing it', () => {
    const legacyReplacement =
      '<persisted-output>\nLegacy Preview (first 1.9KB)\n界🙂\n</persisted-output>'
    const message = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'stored-tool-result',
          content: 'original content that must not trigger a new preview',
          is_error: false,
        },
      ],
    })
    const state = reconstructContentReplacementState([message], [
      {
        kind: 'tool-result',
        toolUseId: 'stored-tool-result',
        replacement: legacyReplacement,
      },
    ])

    const hydrated = applyToolResultReplacementsToMessages(
      [message],
      state.replacements,
    )

    expect(
      (hydrated[0]!.message.content as Array<{ content: string }>)[0]!.content,
    ).toBe(legacyReplacement)
  })
})

test('MCP saved-output instructions label the persisted UTF-8 size as bytes', () => {
  const message = getLargeOutputInstructions(
    '/tmp/tool-results/mcp-result.txt',
    12_345,
    'Plain text',
  )

  expect(message).toContain('result (12,345 bytes)')
  expect(message).not.toContain('12,345 characters')
})

test('MCP persistence-failure instructions also use UTF-8 bytes', () => {
  const message = getLargeOutputPersistenceFailureInstructions(
    '界🙂',
    'disk unavailable',
  )

  expect(message).toContain('result (7 bytes)')
  expect(message).not.toContain('2 characters')
  expect(message).toContain('disk unavailable')
})
