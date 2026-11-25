import { expect, test } from 'bun:test'
import { isResultTruncated, renderToolResultMessage } from './UI.js'

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children)
  }
  return ''
}

test('strips terminal control characters from rendered script output', () => {
  const escape = String.fromCharCode(27)
  const rendered = renderToolResultMessage(
    {
      status: 'completed',
      result: `safe${escape}[2J${escape}[1;1H`,
      stdout: `out${escape}[31m`,
      stderr: `err${escape}]8;;https://example.com${escape}\\`,
      error: { name: `E${escape}[0m`, message: `bad${escape}[7m` },
    },
    [],
    { verbose: true, input: { code: `return 1${escape}[0m` } },
  )
  expect(textOf(rendered)).not.toContain(escape)
})

test('strips terminal control characters from compact result rendering', () => {
  const escape = String.fromCharCode(27)
  const rendered = renderToolResultMessage(
    { status: 'completed', result: `safe${escape}[2J` },
    [],
    { verbose: false },
  )
  expect(textOf(rendered)).not.toContain(escape)
})

test('renders residual inner work as a visible warning', () => {
  const output = {
    status: 'timeout' as const,
    residualInnerWork: {
      active: true,
      activeInvocationCount: 1,
      quiesceTimeoutMs: 30,
      warning: '1 inner tool invocation still running after REPL teardown. Side effects from this work may still complete.',
    },
  }
  const compact = renderToolResultMessage(output, [], { verbose: false })
  expect(textOf(compact)).toContain('inner work may still be running')

  const verbose = renderToolResultMessage(output, [], { verbose: true })
  expect(textOf(verbose)).toContain('may still complete')
})

test('renders persisted output artifact details in verbose mode', () => {
  const rendered = renderToolResultMessage(
    {
      status: 'completed',
      persistedOutputPath: '/tmp/session/tool-results/repl-output.txt',
      persistedOutputSize: 12345,
    },
    [],
    { verbose: true },
  )
  const text = textOf(rendered)
  expect(text).toContain('persisted output:')
  expect(text).toContain('/tmp/session/tool-results/repl-output.txt')
  expect(text).toContain('12345 bytes')
})


test('marks artifact-spilled output as expandable even without inline result text', () => {
  expect(isResultTruncated({
    status: 'completed',
    persistedOutputPath: '/tmp/session/tool-results/repl-output.txt',
  })).toBe(true)
})
