import { jsonStringify } from '../slowOperations.js'
import { zodToJsonSchema } from '../zodToJsonSchema.js'
import { SettingsSchema } from './types.js'

export function generateSettingsJSONSchema(): string {
  const jsonSchema = zodToJsonSchema(SettingsSchema())
  return jsonStringify(jsonSchema, null, 2)
}
