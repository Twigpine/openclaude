import { describe, expect, test } from 'bun:test'

import {
  BashCommandHook,
  HookCommandSchema,
  HooksSchema,
} from './hooks.js'
import { PluginHooksSchema } from '../utils/plugins/schemas.js'
import { SettingsSchema } from '../utils/settings/types.js'

const validCommandHook = {
  type: 'command',
  command: "sh -c 'printf HANDLER_RAN; cat'",
  timeout: 30,
} as const

/** Command hooks do not support a separate `args` field (gh-2304). */
describe('command hook schema rejects a supplied args field', () => {
  test('rejects an args array instead of silently stripping it', () => {
    const result = HookCommandSchema().safeParse({
      type: 'command',
      command: 'sh',
      args: ['-c', 'printf HANDLER_RAN; cat'],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find(i => i.path.includes('args'))
      expect(issue).toBeDefined()
      // The error must be actionable: it names the unsupported field and
      // says where the complete invocation belongs.
      expect(issue?.message).toContain('args')
      expect(issue?.message).toContain('command')
    }
  })

  test('rejects every JSON-expressible non-undefined args value', () => {
    const supplied: unknown[] = [
      null,
      [],
      ['--flag'],
      '',
      'value',
      0,
      false,
      {},
    ]
    for (const args of supplied) {
      const result = HookCommandSchema().safeParse({
        type: 'command',
        command: 'sh',
        args,
      })
      expect(result.success).toBe(false)
    }
  })

  test('accepts an absent args key and an explicit undefined args', () => {
    // JSON cannot express undefined: an absent key (or an explicit undefined
    // in programmatically constructed objects) means the field was not
    // supplied and must keep parsing.
    const absent = HookCommandSchema().safeParse({
      type: 'command',
      command: 'sh -c "cat"',
    })
    expect(absent.success).toBe(true)

    const explicitUndefined = HookCommandSchema().safeParse({
      type: 'command',
      command: 'sh -c "cat"',
      args: undefined,
    })
    expect(explicitUndefined.success).toBe(true)
  })

  test('valid command hooks parse unchanged, including optional fields', () => {
    const result = HookCommandSchema().safeParse(validCommandHook)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(validCommandHook)
    }
  })

  test('unknown fields other than args are still tolerated for compatibility', () => {
    const result = HookCommandSchema().safeParse({
      type: 'command',
      command: 'echo ok',
      description: 'author-facing note, not executed',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).description).toBeUndefined()
      expect((result.data as BashCommandHook).command).toBe('echo ok')
    }
  })

  test('non-command hook types keep parsing via the discriminated union', () => {
    const prompt = HookCommandSchema().safeParse({
      type: 'prompt',
      prompt: 'Summarize: $ARGUMENTS',
    })
    expect(prompt.success).toBe(true)

    // prompt hooks have no execution-affecting args contract either; a
    // supplied args on them is not execution-relevant and stays out of scope.
    const http = HookCommandSchema().safeParse({
      type: 'http',
      url: 'https://example.invalid/hook',
    })
    expect(http.success).toBe(true)
  })
})

describe('args rejection propagates through every hook entry point', () => {
  test('HooksSchema (settings and frontmatter) rejects the hook', () => {
    const result = HooksSchema().safeParse({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'sh',
              args: ['-c', 'cat'],
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('SettingsSchema reports the hook so the settings file fails visibly', () => {
    const result = SettingsSchema().safeParse({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'sh',
                args: ['-c', 'cat'],
              },
            ],
          },
        ],
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join(' ')
      expect(messages).toContain('args')
    }

    // The same file without args still parses and keeps the hook.
    const ok = SettingsSchema().safeParse({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'cat', timeout: 5 }],
          },
        ],
      },
    })
    expect(ok.success).toBe(true)
  })

  test('PluginHooksSchema rejects the hook and keeps valid plugin hooks', () => {
    const bad = PluginHooksSchema().safeParse({
      description: 'probe plugin',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'sh',
                args: ['-c', 'printf HANDLER_RAN; cat'],
              },
            ],
          },
        ],
      },
    })
    expect(bad.success).toBe(false)

    const good = PluginHooksSchema().safeParse({
      description: 'probe plugin',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [validCommandHook],
          },
        ],
      },
    })
    expect(good.success).toBe(true)
    if (good.success) {
      expect(good.data.hooks.UserPromptSubmit?.[0]?.hooks[0]).toEqual({
        ...validCommandHook,
      })
    }
  })
})
