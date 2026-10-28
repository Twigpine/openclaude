import { expect, test } from 'bun:test'
import { generateSettingsJSONSchema } from './schemaOutput.js'

test('settings JSON export preserves the anyOf union contract', () => {
  const output = generateSettingsJSONSchema()
  const schema = JSON.parse(output)

  expect(schema.type).toBe('object')
  expect(schema.properties).toHaveProperty('model')
  expect(output).toContain('"anyOf"')
  expect(output.match(/"oneOf"\s*:/g)).toBeNull()
})
