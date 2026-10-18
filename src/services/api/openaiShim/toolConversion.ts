import { sanitizeSchemaForOpenAICompat } from '../../../utils/schemaSanitizer.js'

export type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export function normalizeSchemaForOpenAI(
  schema: Record<string, unknown>,
  strict = true,
): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAICompat(schema)

  if (record.type === 'object' && record.properties) {
    const properties = record.properties as Record<
      string,
      Record<string, unknown>
    >
    const existingRequired = Array.isArray(record.required)
      ? record.required as string[]
      : []
    const normalizedProperties: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(properties)) {
      normalizedProperties[key] = normalizeSchemaForOpenAI(value, strict)
    }

    record.properties = normalizedProperties
    record.required = existingRequired.filter(key => key in normalizedProperties)
    if (strict) record.additionalProperties = false
  }

  if ('items' in record) {
    record.items = Array.isArray(record.items)
      ? (record.items as unknown[]).map(item =>
          normalizeSchemaForOpenAI(item as Record<string, unknown>, strict),
        )
      : normalizeSchemaForOpenAI(
          record.items as Record<string, unknown>,
          strict,
        )
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(record[key])) {
      record[key] = record[key].map(item =>
        normalizeSchemaForOpenAI(item as Record<string, unknown>, strict),
      )
    }
  }

  return record
}

export function convertTools(
  tools: Array<{
    name: string
    description?: string
    input_schema?: Record<string, unknown>
  }>,
  options: {
    isGemini: boolean
    disableStrictTools: boolean
    skipStrict?: boolean
    normalizeSchema?: typeof normalizeSchemaForOpenAI
  },
): OpenAITool[] {
  const strict =
    !options.isGemini &&
    !options.disableStrictTools &&
    !options.skipStrict

  return tools
    .filter(tool => tool.name !== 'ToolSearchTool')
    .map(tool => {
      const schema = {
        ...(tool.input_schema ?? { type: 'object', properties: {} }),
      } as Record<string, unknown>

      if (tool.name === 'Agent' && schema.properties) {
        const properties = schema.properties as Record<string, unknown>
        schema.required = Array.isArray(schema.required) ? [...schema.required] : []
        const required = schema.required as string[]
        for (const key of ['message', 'subagent_type']) {
          if (key in properties && !required.includes(key)) required.push(key)
        }
      }

      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: (options.normalizeSchema ?? normalizeSchemaForOpenAI)(
            schema,
            strict,
          ),
        },
      }
    })
}
