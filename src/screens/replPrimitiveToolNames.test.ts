/**
 * Regression tests for computeReplPrimitiveToolNames in REPL.tsx.
 *
 * CodeRabbit finding on PR #2573: the CLAUDE_CODE_SIMPLE early return filtered
 * primitives to Bash/Read/Edit but bypassed resolveAgentTools, so a main-thread
 * agent with disallowedTools (for example a wildcard agent with
 * disallowedTools: ['Edit']) had its restrictions reintroduced into the inner
 * REPL inventory in simple mode.
 *
 * REPL.tsx cannot be imported in the test environment (feature() from
 * bun:bundle only compiles under the bundler), so the tests extract the
 * computeReplPrimitiveToolNames declaration from the component source and
 * evaluate it with controlled dependencies. This executes the real wiring
 * rather than a copy: if the source stops consulting resolveAgentTools in
 * simple mode, the behavioral tests fail.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, 'REPL.tsx'), 'utf8')

function extractComputeReplPrimitiveToolNames(): string {
  const start = source.indexOf('const computeReplPrimitiveToolNames = () => {')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n    };', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + '\n    };'.length)
}

type FakeTool = { name: string }

function makeComputer(options: {
  simpleMode: boolean
  agentDefinition?: {
    tools?: string[]
    disallowedTools?: string[]
    source: string
    permissionMode?: string
  }
  primitiveNames?: string[]
  extraToolNames?: string[]
  resolveAgentToolsImpl?: (
    agentDefinition: unknown,
    availableTools: FakeTool[],
    isAsync: boolean,
    isMainThread: boolean,
  ) => { resolvedTools: FakeTool[] }
}): () => string[] {
  const body = extractComputeReplPrimitiveToolNames()
  const factory = new Function(
    'getReplPrimitiveTools',
    'isEnvTruthy',
    'process',
    'mainThreadAgentDefinition',
    'resolveAgentTools',
    'computeTools',
    `${body}\nreturn computeReplPrimitiveToolNames;`,
  ) as (
    getReplPrimitiveTools: () => FakeTool[],
    isEnvTruthy: (v: string | undefined) => boolean,
    proc: { env: Record<string, string | undefined> },
    agentDefinition: unknown,
    resolveAgentTools: unknown,
    computeTools: () => FakeTool[],
  ) => () => string[]

  const primitiveNames = options.primitiveNames ?? ['Bash', 'Read', 'Edit', 'Write']
  const primitives = primitiveNames.map(name => ({ name }))
  const extraTools = (options.extraToolNames ?? []).map(name => ({ name }))

  // Faithful stand-in for the real resolveAgentTools contract the wiring
  // relies on: wildcard agents get every available tool minus their
  // disallowedTools; the wiring under test decides whether this resolver is
  // consulted at all and which tools it is offered.
  const defaultResolver = (
    agentDefinition: { disallowedTools?: string[] },
    availableTools: FakeTool[],
  ) => {
    const disallowed = new Set(agentDefinition.disallowedTools ?? [])
    return { resolvedTools: availableTools.filter(tool => !disallowed.has(tool.name)) }
  }

  return factory(
    () => [...primitives],
    v => v === '1',
    { env: { CLAUDE_CODE_SIMPLE: options.simpleMode ? '1' : undefined } },
    options.agentDefinition,
    options.resolveAgentToolsImpl ?? defaultResolver,
    () => [...extraTools],
  )
}

describe('computeReplPrimitiveToolNames simple mode', () => {
  test('applies main-thread agent disallowedTools in simple mode', () => {
    const compute = makeComputer({
      simpleMode: true,
      agentDefinition: {
        tools: undefined,
        disallowedTools: ['Edit'],
        source: 'user',
      },
    })
    const names = compute()
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
    expect(names).not.toContain('Edit')
  })

  test('consults resolveAgentTools in simple mode', () => {
    let consulted = false
    const compute = makeComputer({
      simpleMode: true,
      agentDefinition: { tools: undefined, disallowedTools: ['Edit'], source: 'user' },
      resolveAgentToolsImpl: (agentDefinition, availableTools) => {
        consulted = true
        const disallowed = new Set(
          (agentDefinition as { disallowedTools?: string[] }).disallowedTools ?? [],
        )
        return { resolvedTools: availableTools.filter(tool => !disallowed.has(tool.name)) }
      },
    })
    compute()
    expect(consulted).toBe(true)
  })

  test('keeps simple-mode primitives when the agent has no restrictions', () => {
    const compute = makeComputer({
      simpleMode: true,
      agentDefinition: { tools: undefined, disallowedTools: undefined, source: 'user' },
    })
    expect(compute()).toEqual(['Bash', 'Read', 'Edit'])
  })

  test('simple mode without an agent definition still limits to simple primitives', () => {
    const compute = makeComputer({ simpleMode: true, agentDefinition: undefined })
    expect(compute()).toEqual(['Bash', 'Read', 'Edit'])
  })

  test('non-primitive tools never leak into simple-mode names even when the agent allows them', () => {
    const compute = makeComputer({
      simpleMode: true,
      agentDefinition: { tools: undefined, disallowedTools: undefined, source: 'user' },
      extraToolNames: ['Write', 'mcp__server__tool'],
    })
    const names = compute()
    expect(names).not.toContain('Write')
    expect(names).not.toContain('mcp__server__tool')
  })
})

describe('computeReplPrimitiveToolNames direct mode', () => {
  test('non-simple mode still applies disallowedTools across all primitives', () => {
    const compute = makeComputer({
      simpleMode: false,
      agentDefinition: { tools: undefined, disallowedTools: ['Write'], source: 'user' },
    })
    const names = compute()
    expect(names).toContain('Bash')
    expect(names).toContain('Edit')
    expect(names).not.toContain('Write')
  })
})
