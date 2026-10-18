import { expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'

import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { filterSwarmFieldsFromSchema } from './api.js'

const schema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    team_name: { type: 'string' },
    mode: { type: 'string' },
    prompt: { type: 'string' },
  },
  required: ['name', 'prompt'],
}

// `filterSwarmFieldsFromSchema` looks the tool name up in a plain-object map.
// A name that collides with an Object.prototype member (`constructor`,
// `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`) resolves the
// inherited function — truthy with `.length === 1` — which slips past the
// `!fieldsToRemove || length === 0` guard and then throws in the `for...of`.
for (const name of [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
]) {
  test(`prototype-named tool "${name}" is treated as unmapped, not crashed`, () => {
    expect(() => filterSwarmFieldsFromSchema(name, schema)).not.toThrow()
    // Unmapped tool → schema returned unchanged (same reference).
    expect(filterSwarmFieldsFromSchema(name, schema)).toBe(schema)
  })
}

test('a genuinely mapped tool still has its swarm fields removed', () => {
  const filtered = filterSwarmFieldsFromSchema(AGENT_TOOL_NAME, schema)
  expect(Object.keys(filtered.properties ?? {})).toEqual(['prompt'])
  expect(filtered.required).toEqual(['prompt'])
})

test('an ordinary unmapped tool is returned unchanged', () => {
  expect(filterSwarmFieldsFromSchema('mcp__server__do_thing', schema)).toBe(
    schema,
  )
})
