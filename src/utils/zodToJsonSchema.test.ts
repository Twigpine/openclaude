import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'
import { semanticBoolean } from './semanticBoolean.js'
import { semanticNumber } from './semanticNumber.js'
import { formatMcpValidationError, formatZodValidationError } from './toolErrors.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

describe('schema compatibility', () => {
  test('preserves generated and advertised JSON schemas for every exported input and output', () => {
    // Hash entire JSON documents, including descriptions, without duplicating
    // prompts and examples in a large snapshot. The fixture also includes
    // conditional schemas that registry filters would otherwise hide.
    const child = Bun.spawnSync([
      process.execPath,
      fileURLToPath(new URL('../test/toolSchemas.fixture.ts', import.meta.url)),
    ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 20_000 })
    expect(child.stderr.toString()).toBe('')
    expect(child.exitCode).toBe(0)
    const schemas = JSON.parse(child.stdout.toString())
    expect(schemas.length).toBeGreaterThan(40)
    expect(schemas).toMatchSnapshot()

    // Simulate Windows glob paths and reverse discovery order in a fresh child
    // so separator normalization, sorting, imports and id hashes are all covered.
    const windowsChild = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
        const scanSync = Bun.Glob.prototype.scanSync
        Bun.Glob.prototype.scanSync = function* (...args) {
          yield* [...scanSync.apply(this, args)]
            .map(file => file.replaceAll('/', '\\\\'))
            .reverse()
        }
        await import(${JSON.stringify(new URL('../test/toolSchemas.fixture.ts', import.meta.url).href)})
      `,
    ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 20_000 })
    expect(windowsChild.stderr.toString()).toBe('')
    expect(windowsChild.exitCode).toBe(0)
    expect(JSON.parse(windowsChild.stdout.toString())).toEqual(schemas)
  }, 45_000) // Allow both children their 20-second deadlines plus assertion time.

  test('preserves defaults, optional and nullable fields, records and unknown-key policy', () => {
    const schema = z.strictObject({
      count: semanticNumber(z.number().default(3)),
      enabled: semanticBoolean(z.boolean().optional()),
      note: z.string().nullable().optional(),
      entries: z.record(z.string(), z.unknown()),
    })
    expect(schema.parse({ entries: {} })).toEqual({ count: 3, entries: {} })
    expect(schema.parse({ count: '2', enabled: 'false', note: null, entries: { extra: 1 } }))
      .toEqual({ count: 2, enabled: false, note: null, entries: { extra: 1 } })
    for (const invalid of [{ extra: 1 }, { count: null }, { enabled: null }]) {
      expect(schema.safeParse({ entries: {}, ...invalid }).success).toBe(false)
    }
    expect(JSON.parse(JSON.stringify(zodToJsonSchema(schema)))).toMatchSnapshot()
    expect(zodToJsonSchema(schema)).toBe(zodToJsonSchema(schema))
  })

  test('preserves strip and passthrough policies and optional inner defaults', () => {
    expect(z.object({ value: z.string() }).parse({ value: 'ok', extra: 1 }))
      .toEqual({ value: 'ok' })
    expect(z.looseObject({ value: z.string() }).parse({ value: 'ok', extra: 1 }))
      .toEqual({ value: 'ok', extra: 1 })
    expect(z.object({ value: z.boolean().default(false).optional() }).parse({}))
      .toEqual({ value: false })
  })

  test('preserves readable missing, unknown and wrong-type errors', () => {
    const schema = z.strictObject({ items: z.array(z.object({ value: z.string() })) })
    const result = schema.safeParse({ items: [{}, { value: 3 }], extra: true })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(formatZodValidationError('Input', result.error)).toBe(
        'Input failed due to the following issues:\n' +
        'The required parameter `items[0].value` is missing\n' +
        'An unexpected parameter `extra` was provided\n' +
        'The parameter `items[1].value` type is expected as `string` but provided as `number`',
      )
    }
  })

  test('formats server errors through v4 issues, including custom messages', () => {
    const schema = z.strictObject({ values: z.array(z.string().min(1, { error: 'Value cannot be empty' })) })
    const result = schema.safeParse({ values: [''] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError)
      expect(formatMcpValidationError('Input', result.error)).toBe(
        'Tool Input input is invalid:\n- values.0: Value cannot be empty',
      )
    }
  })

  test('preserves discriminated unions and nullable wire schemas without rewriting default data', () => {
    const data = { type: ['string', 'null'], anyOf: [{ type: ['number', 'null'] }] }
    const schema = z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('a'), value: z.string().nullable(), data: z.unknown().default(data) }),
      z.strictObject({ kind: z.literal('b'), value: z.number() }),
    ])
    expect(schema.parse({ kind: 'a', value: null })).toEqual({ kind: 'a', value: null, data })
    expect(schema.safeParse({ kind: 'a', value: 1 }).success).toBe(false)
    expect(schema.safeParse({ kind: 'c', value: null }).success).toBe(false)
    const json = zodToJsonSchema(schema)
    expect(json.oneOf).toBeUndefined()
    const branches = json.anyOf as { properties: Record<string, Record<string, unknown>> }[]
    expect(branches[0]!.properties.value).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(branches[0]!.properties.data!.default).toEqual(data)
    expect(Reflect.ownKeys(json)).not.toContain('~standard')
  })

  test('distinguishes output defaults from pre-parse defaults around transforms', () => {
    const schema = z.string().trim().transform(value => value.length)
    expect(schema.default(9).parse(undefined)).toBe(9)
    expect(schema.prefault('  ok  ').parse(undefined)).toBe(2)
    expect(schema.parse('  ok  ')).toBe(2)
  })
})
