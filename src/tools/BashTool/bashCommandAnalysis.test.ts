import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { parseForSecurityFromAst } from '../../utils/bash/ast.js'
import { getParserModule } from '../../utils/bash/bashParser.js'
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

test('security analysis uses the AST path when the tree-sitter flag is enabled', async () => {
  const analysis = await analyzeBashCommand('echo hello | grep hell')

  if (feature('TREE_SITTER_BASH')) {
    expect(analysis.astResult.kind).toBe('simple')
    expect(analysis.legacyParse.kind).toBe('not-run')
  } else {
    expect(analysis.astResult).toEqual({ kind: 'parse-unavailable' })
    expect(analysis.legacyParse.kind).toBe('ok')
  }
})

test('the open build enables the tree-sitter flag', async () => {
  const buildSource = await Bun.file(
    `${import.meta.dir}/../../../scripts/build.ts`,
  ).text()
  expect(buildSource).toContain('TREE_SITTER_BASH: true')
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

function astResultFor(command: string) {
  // Infinity: disable the 50ms parse timeout (correctness tests per
  // bashParser.ts guidance; avoids spurious nulls on slow CI).
  const root = getParserModule()?.parse(command, Infinity)
  if (!root) throw new Error('pure-TS bash parser unavailable')
  return parseForSecurityFromAst(command, root)
}

test('a skipped && RHS assignment does not become the expanded value', () => {
  // bash short-circuits `false && SUB=status`, keeps SUB=push, and runs
  // `git push`. Leaking the RHS assignment would analyze `git status`
  // instead and a `Bash(git push:*)` deny would miss the command bash
  // actually runs.
  const result = astResultFor('SUB=push; false && SUB=status; git "$SUB"')
  expect(result.kind).toBe('too-complex')
})

test('an executed && RHS assignment still does not resolve as a literal', () => {
  // Mirror of the skip case: bash does run SUB=push here, but the analyzer
  // cannot prove the && LHS succeeds, so the value is runtime-conditional
  // and must not silently resolve to `git status` either.
  const result = astResultFor('SUB=status; true && SUB=push; git "$SUB"')
  expect(result.kind).toBe('too-complex')
})

test('a conditional && RHS write cannot overwrite a tracked literal', () => {
  // Either '../../etc/passwd' (skipped) or 'x' (ran) is possible; marking
  // the var unknown would hide the literal from path validation.
  const result = astResultFor(
    'VAR=../../etc/passwd; false && VAR=x; cat "/tmp/$VAR"',
  )
  expect(result.kind).toBe('too-complex')
})

test('&& RHS still reads variables assigned by its own LHS', () => {
  const result = astResultFor('VAR=x && cmd $VAR')
  expect(result.kind).toBe('simple')
  if (result.kind !== 'simple') throw new Error('expected simple')
  expect(result.commands.map(c => c.argv)).toEqual([['cmd', 'x']])
})

test('unconditional ; assignments still resolve as literals', () => {
  const result = astResultFor('VAR=x; cmd $VAR')
  expect(result.kind).toBe('simple')
  if (result.kind !== 'simple') throw new Error('expected simple')
  expect(result.commands.map(c => c.argv)).toEqual([['cmd', 'x']])
})

test('a var added by a && RHS holding a placeholder stays unknown', () => {
  // `$(...)` output is runtime-unknown, so the merge keeps the placeholder:
  // bash ran V=$(printf x) or skipped it, and either way the analyzer
  // cannot name a literal. `printf x` is extracted and checked as a command.
  const result = astResultFor('true && V=$(printf x); echo "got $V"')
  expect(result.kind).toBe('simple')
  if (result.kind !== 'simple') throw new Error('expected simple')
  expect(result.commands.map(c => c.argv)).toEqual([
    ['true'],
    ['printf', 'x'],
    ['echo', 'got __TRACKED_VAR__'],
  ])
})

test('a var introduced by a && RHS with a literal value fails closed', () => {
  // Storing VAR_PLACEHOLDER for V here would let `"./$V"` keep its `./`
  // prefix and validate as workspace-relative `./__TRACKED_VAR__` while
  // bash expands the real literal `../../etc/passwd`.
  const result = astResultFor('true && V=../../etc/passwd; cat "./$V"')
  expect(result.kind).toBe('too-complex')
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
