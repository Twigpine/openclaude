import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { parseForSecurityFromAst } from '../../utils/bash/ast.js'
import { PARSE_ABORTED } from '../../utils/bash/parser.js'
import { analyzeBashCommand } from './bashCommandAnalysis.js'

const nonce = `${Date.now()}-${Math.random()}`
const realDebug = {
  ...await import(`../../utils/debug.js?real=${nonce}`),
}

let importCounter = 0

beforeEach(async () => {
  await acquireSharedMutationLock('tools/BashTool/bashCommandAnalysis.test.ts')
})

async function importAnalysisWithDebugSpy(
  debugSpy: ReturnType<
    typeof mock<(message: string, options?: { level?: string }) => void>
  >,
) {
  mock.module('../../utils/debug.js', () => ({
    ...realDebug,
    logForDebugging: debugSpy,
  }))

  return import(`./bashCommandAnalysis.js?analysisTest=${importCounter++}`)
}

afterEach(() => {
  try {
    mock.restore()
    mock.module('../../utils/debug.js', () => realDebug)
  } finally {
    releaseSharedMutationLock()
  }
})

async function withLegacyParserFallback<T>(fn: () => Promise<T>): Promise<T> {
  const originalInjectionFlag =
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
  process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = '1'
  try {
    return await fn()
  } finally {
    if (originalInjectionFlag === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
    } else {
      process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK =
        originalInjectionFlag
    }
  }
}

test('records parser-unavailable fallback for valid expansions, pipelines, and redirects', async () => {
  const analysis = await withLegacyParserFallback(() =>
    analyzeBashCommand('printf "$VALUE" | cat > out.txt'),
  )

  expect(analysis.astResult).toEqual({ kind: 'parse-unavailable' })
  expect(analysis.legacyParse.kind).toBe('ok')
  if (analysis.legacyParse.kind !== 'ok') {
    throw new Error('expected legacy parse to succeed')
  }
  expect(analysis.legacyParse.tokens).toContain('$VALUE')
  expect(analysis.legacyParse.tokens).toContainEqual({ op: '|' })
  expect(analysis.legacyParse.tokens).toContainEqual({ op: '>' })
})

test('records quoted heredocs as legacy parser fallback input', async () => {
  const analysis = await withLegacyParserFallback(() =>
    analyzeBashCommand("cat <<'EOF'\nhello\nEOF"),
  )

  expect(analysis.astResult).toEqual({ kind: 'parse-unavailable' })
  expect(analysis.legacyParse.kind).toBe('ok')
  if (analysis.legacyParse.kind !== 'ok') {
    throw new Error('expected quoted heredoc to parse on the legacy path')
  }
  expect(analysis.legacyParse.tokens).toContain('hello')
})

test('classifies JavaScript template literal syntax as an expected legacy parser limitation', async () => {
  const analysis = await withLegacyParserFallback(() =>
    analyzeBashCommand('echo ${value + 1}'),
  )

  expect(analysis.legacyParse).toMatchObject({
    kind: 'failed',
    failureKind: 'expected-limitation',
    reasonCode: 'bad-substitution',
  })
})

test('keeps parser aborts fail-closed as too complex', () => {
  const result = parseForSecurityFromAst('echo hi', PARSE_ABORTED)

  expect(result.kind).toBe('too-complex')
  if (result.kind !== 'too-complex') {
    throw new Error(`expected too-complex, got ${result.kind}`)
  }
  expect(result.nodeType).toBe('PARSE_ABORT')
  expect(result.reason).toContain('Parser aborted')
})

test('logs one sanitized debug event for an expected legacy parser limitation', async () => {
  const originalInjectionFlag =
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
  process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = '1'
  try {
    const debugSpy = mock((_message: string, _options?: { level?: string }) => {})
    const { analyzeBashCommand, logLegacyParserLimitationOnce } =
      await importAnalysisWithDebugSpy(debugSpy)

    const analysis = await analyzeBashCommand('echo ${value + 1}')

    expect(analysis.legacyParse).toMatchObject({
      kind: 'failed',
      failureKind: 'expected-limitation',
      reasonCode: 'bad-substitution',
    })

    logLegacyParserLimitationOnce(analysis)
    logLegacyParserLimitationOnce(analysis)

    expect(debugSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy.mock.calls[0]?.[0]).toContain('reason=bad-substitution')
    expect(debugSpy.mock.calls[0]?.[0]).not.toContain('${value + 1}')
    expect(debugSpy.mock.calls[0]?.[1]).toEqual({ level: 'debug' })
  } finally {
    if (originalInjectionFlag === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
    } else {
      process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK =
        originalInjectionFlag
    }
  }
})
