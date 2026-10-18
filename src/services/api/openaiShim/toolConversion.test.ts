import { expect, test } from 'bun:test'
import { convertTools, normalizeSchemaForOpenAI } from './toolConversion.js'

test('preserves Grep tool pattern field in OpenAI-compatible schemas', () => {
  const tools = convertTools([{
    name: 'Grep',
    description: 'Search file contents',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  }], {
    isGemini: false,
    disableStrictTools: false,
  })
  const parameters = tools[0]?.function.parameters
  const properties = parameters?.properties as Record<string, unknown>

  expect(Object.keys(properties)).toContain('pattern')
  expect(parameters?.required).toContain('pattern')
})

test('sanitizes malformed MCP tool schemas before sending them to OpenAI', () => {
  const parameters = normalizeSchemaForOpenAI({
    type: 'object',
    properties: {
      priority: {
        type: 'integer',
        description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
        default: true,
        enum: [false, 0, 1, 2, 3],
      },
    },
  })
  const properties = parameters.properties as Record<
    string,
    { default?: unknown; enum?: unknown[]; type?: string }
  >

  expect(parameters.additionalProperties).toBe(false)
  expect(parameters.required).toEqual([])
  expect(properties.priority?.type).toBe('integer')
  expect(properties.priority?.enum).toEqual([0, 1, 2, 3])
  expect(properties.priority).not.toHaveProperty('default')
})

test('optional tool properties are not added to required[] — fixes Groq/Azure 400 tool_use_failed', () => {
  const parameters = normalizeSchemaForOpenAI({
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to file' },
      offset: { type: 'number', description: 'Line to start from' },
      limit: { type: 'number', description: 'Max lines to read' },
      pages: { type: 'string', description: 'Page range for PDFs' },
    },
    required: ['file_path'],
  })
  const required = parameters.required as string[]

  expect(required).toEqual(['file_path'])
  expect(required).not.toContain('offset')
  expect(required).not.toContain('limit')
  expect(required).not.toContain('pages')
  expect(parameters.additionalProperties).toBe(false)
})

test('omits deferred tool search and promotes known Agent fields', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      message: { type: 'string' },
      subagent_type: { type: 'string' },
      optional: { type: 'string' },
    },
    required: ['optional'],
  }
  const tools = convertTools([
    { name: 'ToolSearchTool' },
    {
      name: 'Agent',
      input_schema: inputSchema,
    },
  ], {
    isGemini: false,
    disableStrictTools: false,
  })

  expect(tools).toHaveLength(1)
  expect(tools[0]?.function.name).toBe('Agent')
  expect(tools[0]?.function.parameters.required).toEqual([
    'optional',
    'message',
    'subagent_type',
  ])
  expect(inputSchema.required).toEqual(['optional'])
})

test('Gemini mode omits strict schema fields', () => {
  const tools = convertTools([{
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
  }], {
    isGemini: true,
    disableStrictTools: false,
  })

  expect(tools[0]?.function.parameters.additionalProperties).toBeUndefined()
})
