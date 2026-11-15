import { describe, expect, test } from 'bun:test'

/**
 * Settings shapes that must keep parsing successfully as the schema evolves.
 * When adding new fields, add a representative config here (see the
 * BACKWARD COMPATIBILITY NOTICE in types.ts).
 */
const BACKWARD_COMPATIBILITY_CONFIGS: { name: string; config: unknown }[] = [
  {
    name: 'statusLine with refreshInterval',
    config: {
      statusLine: { type: 'command', command: 'echo hi', refreshInterval: 5 },
    },
  },
  {
    name: 'statusLine without refreshInterval',
    config: {
      statusLine: { type: 'command', command: 'echo hi' },
    },
  },
]

describe('SettingsSchema backward compatibility', () => {
  test.each(BACKWARD_COMPATIBILITY_CONFIGS)(
    'parses $name',
    async ({ config }) => {
      const { SettingsSchema } = await import('./types.js')

      const result = SettingsSchema().safeParse(config)

      expect(result.success).toBe(true)
    },
  )

  test('keeps a valid statusLine.refreshInterval', async () => {
    const { SettingsSchema } = await import('./types.js')

    const result = SettingsSchema().safeParse({
      statusLine: { type: 'command', command: 'echo hi', refreshInterval: 5 },
    })

    expect(result.success).toBe(true)
    expect(result.data?.statusLine?.refreshInterval).toBe(5)
  })

  test('absent statusLine.refreshInterval stays undefined', async () => {
    const { SettingsSchema } = await import('./types.js')

    const result = SettingsSchema().safeParse({
      statusLine: { type: 'command', command: 'echo hi' },
    })

    expect(result.success).toBe(true)
    expect(result.data?.statusLine?.refreshInterval).toBeUndefined()
  })

  test.each([0, 61, 2.5, '5'])(
    'ignores invalid statusLine.refreshInterval %p without failing the file',
    async value => {
      const { SettingsSchema } = await import('./types.js')

      const result = SettingsSchema().safeParse({
        statusLine: {
          type: 'command',
          command: 'echo hi',
          refreshInterval: value,
        },
      })

      expect(result.success).toBe(true)
      expect(result.data?.statusLine?.refreshInterval).toBeUndefined()
    },
  )
})
