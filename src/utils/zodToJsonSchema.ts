/**
 * Converts Zod v4 schemas to JSON Schema using native toJSONSchema.
 */

import { toJSONSchema, type core } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() runs this for every tool on every API request (~60-250
// times/turn). Tool schemas are wrapped with lazySchema() which guarantees the
// same schema reference per session, so we can cache by identity.
const cache = new WeakMap<core.$ZodType, JsonSchema7Type>()

/**
 * Converts a Zod v4 schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: core.$ZodType): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const converted = toJSONSchema(schema, {
    override: ({ zodSchema, jsonSchema }) => {
      // Discriminator values are disjoint, so either keyword describes the
      // same accepted values. Preserve the established wire representation.
      if (zodSchema._zod.def.type === 'union' && 'discriminator' in zodSchema._zod.def && jsonSchema.oneOf) {
        jsonSchema.anyOf = jsonSchema.oneOf
        delete jsonSchema.oneOf
      }
    },
  })
  // Native conversion also attaches non-enumerable runtime metadata. Return
  // plain JSON as before, and expand compact type unions to the existing form.
  const result: JsonSchema7Type = structuredClone(converted)
  expandTypeUnions(result)
  cache.set(schema, result)
  return result
}

function expandTypeUnions(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const schema = value as JsonSchema7Type
  if (Array.isArray(schema.type)) {
    schema.anyOf = schema.type.map(type => ({ type }))
    delete schema.type
  }
  // Visit only schema-valued keywords: defaults, enum members and examples
  // are user data, even when they look like JSON schemas themselves.
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    const children = schema[keyword]
    if (children && typeof children === 'object') {
      for (const child of Object.values(children)) expandTypeUnions(child)
    }
  }
  for (const keyword of [
    'anyOf', 'oneOf', 'allOf', 'prefixItems', 'items', 'additionalProperties',
    'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames',
  ]) {
    const children = schema[keyword]
    if (Array.isArray(children)) children.forEach(expandTypeUnions)
    else expandTypeUnions(children)
  }
}
