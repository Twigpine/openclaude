import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BashCommandHook,
  HookCommandSchema,
  HooksSchema,
} from './hooks.js'
import { PluginHooksSchema } from '../utils/plugins/schemas.js'
import { SettingsSchema } from '../utils/settings/types.js'
import {
  clearMdmSettingsCache,
  parseCommandOutputAsSettings,
  setMdmSettingsCache,
} from '../utils/settings/mdm/settings.js'
import {
  getSettingsForSource,
  loadManagedFileSettings,
  parseSettingsFile,
} from '../utils/settings/settings.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { validateSettingsFileContent } from '../utils/settings/validation.js'

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

describe('settings diagnostics for unsupported command hook args', () => {
  const settingsContent = (hook: Record<string, unknown>) => JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [hook] }] },
  })

  test('settings loading skips the hook and keeps the explanation', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'hook-args-diagnostic-'))
    const settingsPath = join(fixtureDir, 'settings.json')
    try {
      writeFileSync(settingsPath, settingsContent({
        type: 'command', command: 'sh', args: ['-c', 'cat'],
      }))
      const result = parseSettingsFile(settingsPath)
      expect(result.settings).toEqual({})
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.path).toBe('hooks.UserPromptSubmit.0.hooks.0.args')
      expect(result.errors[0]?.message).toContain('Command hook was skipped')
      expect(result.errors[0]?.message).toContain('do not support an "args" field')
      expect(result.errors[0]?.message).toContain('complete invocation in "command"')
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('one hook with args does not discard the rest of the settings file', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'hook-args-isolation-'))
    const settingsPath = join(fixtureDir, 'settings.json')
    try {
      writeFileSync(settingsPath, JSON.stringify({
        permissions: { deny: ['Bash(rm -rf:*)'] },
        env: { OPENAI_MODEL: 'gpt-4o' },
        hooks: {
          PreToolUse: [{
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '~/bin/notify.sh', args: [] },
              validCommandHook,
            ],
          }],
          UserPromptSubmit: [{ hooks: [validCommandHook] }],
        },
      }))
      const result = parseSettingsFile(settingsPath)
      expect(result.settings?.permissions?.deny).toEqual(['Bash(rm -rf:*)'])
      expect(result.settings?.env).toEqual({ OPENAI_MODEL: 'gpt-4o' })
      expect(result.settings?.hooks?.PreToolUse?.[0]?.hooks).toEqual([validCommandHook])
      expect(result.settings?.hooks?.UserPromptSubmit?.[0]?.hooks).toEqual([validCommandHook])
      expect(result.errors.map(error => error.path)).toEqual([
        'hooks.PreToolUse.0.hooks.0.args',
      ])
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('managed settings from a command skip the hook and keep the rest', () => {
    const { settings, errors } = parseCommandOutputAsSettings(
      JSON.stringify({
        permissions: { deny: ['WebFetch'] },
        hooks: {
          UserPromptSubmit: [{
            hooks: [{ type: 'command', command: 'sh', args: ['-c', 'cat'] }],
          }],
        },
      }),
      'managed-settings',
    )
    expect(settings).toEqual({ permissions: { deny: ['WebFetch'] } })
    expect(errors.map(error => error.path)).toEqual([
      'hooks.UserPromptSubmit.0.hooks.0.args',
    ])
  })

  test('skipping a hook removes only the structures it empties', () => {
    const kept = { type: 'command' as const, command: 'echo kept' }
    const skipped = { type: 'command', command: 'sh', args: ['-c', 'cat'] }
    const { settings } = parseCommandOutputAsSettings(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [skipped] },
            { matcher: 'Edit', hooks: [skipped, kept] },
            { matcher: 'Read', hooks: [] },
          ],
          Stop: [{ hooks: [skipped] }],
        },
      }),
      'managed-settings',
    )
    expect(settings.hooks).toEqual({
      PreToolUse: [
        { matcher: 'Edit', hooks: [kept] },
        { matcher: 'Read', hooks: [] },
      ],
    })
  })

  test('a policy holding only a skipped hook does not outrank a lower-priority policy', () => {
    const mdm = parseCommandOutputAsSettings(
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'sh', args: ['-c', 'cat'] }],
          }],
        },
      }),
      'mdm',
    )
    expect(mdm.settings).toEqual({})

    const hkcu = parseCommandOutputAsSettings(
      JSON.stringify({ permissions: { deny: ['WebFetch'] } }),
      'hkcu',
    )
    try {
      setMdmSettingsCache(mdm, hkcu)
      resetSettingsCache()
      // A managed settings file outranks HKCU, so expect it when this machine
      // has one; either way the MDM source must not win.
      const managedFile = loadManagedFileSettings().settings
      expect(getSettingsForSource('policySettings')).toEqual(
        managedFile ?? hkcu.settings,
      )
    } finally {
      clearMdmSettingsCache()
      resetSettingsCache()
    }
  })

  test('settings edit validation explains every supplied JSON args value', () => {
    for (const args of [null, [], ['--flag'], '', 'value', 0, false, {}]) {
      const result = validateSettingsFileContent(settingsContent({
        type: 'command', command: 'sh', args,
      }))
      expect(result.isValid).toBe(false)
      if (!result.isValid) {
        expect(result.error).toContain('hooks.UserPromptSubmit.0.hooks.0.args')
        expect(result.error).toContain('do not support an "args" field')
        expect(result.error).toContain('complete invocation in "command"')
      }
    }
  })

  test('a complete command remains valid through both settings paths', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'hook-command-valid-'))
    const settingsPath = join(fixtureDir, 'settings.json')
    const content = settingsContent(validCommandHook)
    try {
      writeFileSync(settingsPath, content)
      const result = parseSettingsFile(settingsPath)
      expect(result.errors).toEqual([])
      expect(result.settings?.hooks?.UserPromptSubmit?.[0]?.hooks[0])
        .toEqual(validCommandHook)
      expect(validateSettingsFileContent(content)).toEqual({ isValid: true })
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
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
