import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Tool } from '../Tool.js'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'

// A fresh process avoids shared mocks and registry filters hiding schemas.
const toolsDir = new URL('../tools/', import.meta.url)
const files = [...new Bun.Glob('**/*Tool.{ts,tsx}').scanSync(fileURLToPath(toolsDir))]
  .map(file => file.replaceAll('\\', '/'))
  .sort()
const schemas: { id: string; input: unknown; advertised: unknown; output: unknown }[] = []
for (const file of files) {
  const exports = await import(new URL(file, toolsDir).href)
  const seen = new Set<object>()
  for (const [name, value] of Object.entries(exports).sort(([a], [b]) => a.localeCompare(b))) {
    if (!value || typeof value !== 'object' || !('inputSchema' in value) || seen.has(value)) continue
    seen.add(value)
    const tool = value as Tool
    const input = zodToJsonSchema(tool.inputSchema)
    schemas.push({
      id: `${file}:${name}`,
      input,
      advertised: tool.inputJSONSchema ?? input,
      output: tool.outputSchema ? zodToJsonSchema(tool.outputSchema) : null,
    })
  }
}
const output = process.argv.includes('--full') ? schemas : schemas.map(schema => ({
  id: fingerprint(schema.id),
  input: fingerprint(schema.input),
  advertised: fingerprint(schema.advertised),
  output: schema.output ? fingerprint(schema.output) : null,
}))
await Bun.write(Bun.stdout, JSON.stringify(output))

function fingerprint(schema: unknown): string {
  // Sort keys recursively so snapshots measure schema content, not key order.
  return createHash('sha256').update(JSON.stringify(schema, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )).digest('hex')
}
