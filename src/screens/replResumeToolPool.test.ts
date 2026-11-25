/**
 * Regression tests for the tool pool used after an in-place resume changes
 * Code Mode.
 *
 * REPL.tsx cannot be imported in the test environment (feature() from
 * bun:bundle only compiles under the bundler), so the tests extract the real
 * computeTools declaration from the component source and evaluate it with
 * controlled dependencies. The merge stand-in preserves the behavior that
 * mattered for the bug: initial entries are included before freshly assembled
 * entries and are not filtered by conversation mode.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, 'REPL.tsx'), 'utf8')

function extractComputeTools(): string {
  const start = source.indexOf('const computeTools = () => {')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n    };', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + '\n    };'.length)
}

type FakeTool = { name: string }
type FakePermissionContext = { mode: 'default' }

function computePoolAfterResume(options: {
  previousBuiltInNames: string[]
  currentBuiltInNames: string[]
}): {
  names: string[]
  permissionContext: FakePermissionContext
  assembledPermissionContext: unknown
  mergePermissionMode: unknown
} {
  const body = extractComputeTools()
  const factory = new Function(
    'store',
    'assembleToolPool',
    'mergeAndFilterTools',
    'combinedInitialTools',
    'initialTools',
    'mainThreadAgentDefinition',
    'resolveAgentTools',
    `${body}\nreturn computeTools;`,
  ) as (
    store: unknown,
    assembleToolPool: unknown,
    mergeAndFilterTools: unknown,
    combinedInitialTools: unknown,
    initialTools: unknown,
    mainThreadAgentDefinition: unknown,
    resolveAgentTools: unknown,
  ) => () => FakeTool[]

  const permissionContext: FakePermissionContext = { mode: 'default' }
  const startupTools: FakeTool[] = [{ name: 'mcp__server__startup' }]
  const previousCombinedTools: FakeTool[] = [
    ...options.previousBuiltInNames.map(name => ({ name })),
    ...startupTools,
  ]
  const currentBuiltIns: FakeTool[] = options.currentBuiltInNames.map(name => ({ name }))
  let assembledPermissionContext: unknown
  let mergePermissionMode: unknown

  const computeTools = factory(
    {
      getState: () => ({
        toolPermissionContext: permissionContext,
        mcp: { tools: [] },
      }),
    },
    (context: unknown, _mcpTools: unknown) => {
      assembledPermissionContext = context
      return [...currentBuiltIns]
    },
    (initial: FakeTool[], assembled: FakeTool[], mode: unknown) => {
      mergePermissionMode = mode
      const byName = new Map<string, FakeTool>()
      for (const tool of [...initial, ...assembled]) {
        if (!byName.has(tool.name)) byName.set(tool.name, tool)
      }
      return [...byName.values()]
    },
    previousCombinedTools,
    startupTools,
    undefined,
    () => {
      throw new Error('resolveAgentTools must not run without an agent definition')
    },
  )

  const names = computeTools().map(tool => tool.name)
  return {
    names,
    permissionContext,
    assembledPermissionContext,
    mergePermissionMode,
  }
}

describe('computeTools after an in-place Code Mode resume', () => {
  test('direct to Code Mode drops previous direct primitives without changing permission state', () => {
    const result = computePoolAfterResume({
      previousBuiltInNames: ['Read', 'Bash'],
      currentBuiltInNames: ['REPL'],
    })

    expect(result.names).toContain('REPL')
    expect(result.names).toContain('mcp__server__startup')
    expect(result.names).not.toContain('Read')
    expect(result.names).not.toContain('Bash')
    expect(result.assembledPermissionContext).toBe(result.permissionContext)
    expect(result.mergePermissionMode).toBe('default')
  })

  test('Code Mode to direct drops the previous REPL tool without changing permission state', () => {
    const result = computePoolAfterResume({
      previousBuiltInNames: ['REPL'],
      currentBuiltInNames: ['Read', 'Bash'],
    })

    expect(result.names).toContain('Read')
    expect(result.names).toContain('Bash')
    expect(result.names).toContain('mcp__server__startup')
    expect(result.names).not.toContain('REPL')
    expect(result.assembledPermissionContext).toBe(result.permissionContext)
    expect(result.mergePermissionMode).toBe('default')
  })
})
