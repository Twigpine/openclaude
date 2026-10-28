import { describe, expect, test } from 'bun:test'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { parseWithCompat, toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { z as legacy } from 'zod/v3'
import { z } from 'zod/v4'

describe('dependency schema compatibility', () => {
  test('the structured output helper converts and validates v4 schemas', () => {
    const format = zodOutputFormat(z.strictObject({ value: z.string() }))
    expect(format.schema.type).toBe('object')
    expect(format.parse('{"value":"ok"}')).toEqual({ value: 'ok' })
    expect(() => format.parse('{"value":1}')).toThrow()
  })

  test('the protocol converter and parser support both packaged schema generations', () => {
    // Avoid finding a common type by comparing both versions' fluent builders.
    const schemas: AnySchema[] = [
      z.strictObject({ value: z.string() }),
      legacy.object({ value: legacy.string() }).strict(),
    ]
    for (const schema of schemas) {
      expect(toJsonSchemaCompat(schema).type).toBe('object')
      expect(parseWithCompat(schema, { value: 'ok' })).toEqual({ value: 'ok' })
      expect(() => parseWithCompat(schema, { value: 1 })).toThrow()
    }
  })

  test('the unmodified sandbox uses the v3 compatibility export supplied by the v4 package', () => {
    const config = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }
    expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true)
    expect(SandboxRuntimeConfigSchema.safeParse({}).success).toBe(false)
    expect(SandboxRuntimeConfigSchema.safeParse({ ...config, network: { allowedDomains: 3 } }).success).toBe(false)
  })
})
