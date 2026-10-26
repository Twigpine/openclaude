import type { ToolUseContext } from './Tool.js'
﻿import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chdir } from 'node:process'

import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from './bootstrap/state.js'
import type { CommandBase, PromptCommand } from './types/command.js'
import { runWithCwdOverride } from './utils/cwd.js'
import {
  builtInCommandNames,
  clearCommandMemoizationCaches,
  formatDescriptionWithSource,
  getCommands,
  INTERNAL_ONLY_COMMANDS,
} from './commands.js'
import { registerBatchSkill } from './skills/bundled/batch.js'
import { registerDebugSkill } from './skills/bundled/debug.js'
import { registerLoopSkill } from './skills/bundled/loop.js'
import { registerSimplifySkill } from './skills/bundled/simplify.js'
import { registerUpdateConfigSkill } from './skills/bundled/updateConfig.js'
import {
  clearBundledSkills,
  getBundledSkills,
  registerBundledSkill,
} from './skills/bundledSkills.js'
import { isCommand } from './types/command.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from './utils/settings/settingsCache.js'

function useLanguage(language?: string): void {
  setSessionSettingsCache({
    settings: language ? { language } : {},
    errors: [],
  })
}

afterEach(() => {
  resetSettingsCache()
  clearBundledSkills()
  clearCommandMemoizationCaches()
})

// Narrows the Command union to the prompt variant so getPromptForCommand is
// callable; bughunter commands are always registered as prompt commands.
function findPromptCommand(cmds: ReturnType<typeof getCommands> extends Promise<infer T> ? T : never, name: string): CommandBase & PromptCommand {
  const cmd = cmds.find(c => c.name === name)
  if (!cmd || cmd.type !== 'prompt') {
    throw new Error(`expected /${name} to be registered as a prompt command`)
  }
  return cmd
}

describe('builtInCommandNames', () => {
  test('includes the LSP command', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-lsp-'))
    try {
      const cmds = await getCommands(cwd)
      expect(cmds.map(c => c.name)).toContain('lsp')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('project skills take precedence over bundled skills with the same name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-skill-precedence-'))
    const originalSources = getAllowedSettingSources()
    setAllowedSettingSources([
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ])
    registerBundledSkill({
      name: 'debug',
      description: 'Bundled debug skill',
      async getPromptForCommand() {
        return [{ type: 'text', text: 'bundled debug' }]
      },
    })
    try {
      const skillDir = join(cwd, '.openclaude', 'skills', 'debug')
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\ndescription: Project debug skill\n---\n# Debug\n`,
        'utf8',
      )
      clearCommandMemoizationCaches()

      const cmds = await getCommands(cwd)
      const debugCommands = cmds.filter(
        (cmd): cmd is CommandBase & PromptCommand =>
          cmd.type === 'prompt' && cmd.name === 'debug',
      )

      expect(debugCommands.length).toBeGreaterThanOrEqual(2)
      expect(debugCommands[0].description).toBe('Project debug skill')
      expect(debugCommands[0].source).toBe('projectSettings')
      expect(debugCommands[1].description).toBe('Bundled debug skill')
      expect(debugCommands[1].source).toBe('bundled')
    } finally {
      setAllowedSettingSources(originalSources)
      await rm(cwd, { recursive: true, force: true })
      clearCommandMemoizationCaches()
    }
  })

  test('getCommands() includes bughunter for normal users (USER_TYPE unset)', async () => {
    // Regression: bughunter previously lived in INTERNAL_ONLY_COMMANDS and was
    // never available to non-ant users. Ensure it stays in the public COMMANDS list.
    const originalUserType = process.env['USER_TYPE']
    const originalIsDemo = process.env['IS_DEMO']
    delete process.env['USER_TYPE']
    delete process.env['IS_DEMO']
    // Clear ALL command caches — including the zero-arg COMMANDS() memoize that
    // captures USER_TYPE at first call and never re-evaluates it. Without this,
    // a prior test that ran with USER_TYPE=ant would pollute the COMMANDS cache
    // and make bughunter appear gated even in a "normal user" run.
    clearCommandMemoizationCaches()
    // Use a unique tmp dir to avoid the loadAllCommands memoize cache
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-bughunter-'))
    try {
      const cmds = await getCommands(cwd)
      expect(cmds.map(c => c.name)).toContain('bughunter')
      expect(INTERNAL_ONLY_COMMANDS.map(c => c.name)).not.toContain('bughunter')
    } finally {
      await rm(cwd, { recursive: true, force: true })
      // Restore env vars to avoid test isolation issues
      if (originalUserType !== undefined) {
        process.env['USER_TYPE'] = originalUserType
      } else {
        delete process.env['USER_TYPE']
      }
      if (originalIsDemo !== undefined) {
        process.env['IS_DEMO'] = originalIsDemo
      } else {
        delete process.env['IS_DEMO']
      }
      clearCommandMemoizationCaches()
    }
  })

  test('getCommands() includes bughunter-security and bughunter-perf for normal users', async () => {
    // Sibling subcommands of /bughunter — must stay in the public COMMANDS list,
    // not in INTERNAL_ONLY_COMMANDS, so normal users can invoke them.
    const originalUserType = process.env['USER_TYPE']
    const originalIsDemo = process.env['IS_DEMO']
    delete process.env['USER_TYPE']
    delete process.env['IS_DEMO']
    clearCommandMemoizationCaches()
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-bughunter-sibs-'))
    try {
      const cmds = await getCommands(cwd)
      const names = cmds.map(c => c.name)
      expect(names).toContain('bughunter-security')
      expect(names).toContain('bughunter-perf')
      const internalNames = INTERNAL_ONLY_COMMANDS.map(c => c.name)
      expect(internalNames).not.toContain('bughunter-security')
      expect(internalNames).not.toContain('bughunter-perf')
    } finally {
      await rm(cwd, { recursive: true, force: true })
      // Restore env vars to avoid test isolation issues
      if (originalUserType !== undefined) {
        process.env['USER_TYPE'] = originalUserType
      } else {
        delete process.env['USER_TYPE']
      }
      if (originalIsDemo !== undefined) {
        process.env['IS_DEMO'] = originalIsDemo
      } else {
        delete process.env['IS_DEMO']
      }
      clearCommandMemoizationCaches()
    }
  })

  const FULL_GIT_COMMANDS = [
    'git status',
    'git diff --name-only --diff-filter=AM',
    'git diff --cached --name-only --diff-filter=AM',
    'git log -10 --pretty=format: --name-only --diff-filter=AM',
    'git ls-files',
    'git diff HEAD -- .',
    'git rev-parse --git-dir',
    'git rev-parse --git-dir 2>&1',
    'git diff HEAD -- . 2> /dev/null',
    'git status 2>/dev/null',
    'git diff --name-only --diff-filter=AM 2>/dev/null',
    'git diff --cached --name-only --diff-filter=AM 2>/dev/null',
    'git log -10 --pretty=format: --name-only --diff-filter=AM 2>/dev/null',
    'git diff HEAD -- . 2>/dev/null',
  ]

  const createMockToolContext = (cwd: string, commands: string[]) =>
    ({
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: commands },
          alwaysDenyRules: {},
          alwaysAskRules: {},
          mode: 'default' as const,
          additionalWorkingDirectories: new Map([[cwd, true]]),
          isBypassPermissionsModeAvailable: false,
        },
      }),
      abortController: new AbortController(),
      options: {
        debug: false,
        mainLoopModel: '',
        tools: {},
        verbose: false,
        thinkingConfig: {},
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: {},
      },
    } as unknown as ToolUseContext)

  /** Retry rm on EBUSY (Windows: dir held by spawned shell handle). */
  async function rmRetry(dir: string, retries = 5, delay = 200): Promise<void> {
    const originalCwd = process.cwd()
    try {
      // Move to a stable dir so the temp dir is no longer anyone's cwd.
      chdir(tmpdir())
      for (let i = 0; i < retries; i++) {
        try {
          await rm(dir, { recursive: true, force: true })
          return
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === 'EBUSY' && i < retries - 1) {
            await new Promise(r => setTimeout(r, delay))
            continue
          }
          throw e
        }
      }
    } finally {
      chdir(originalCwd)
    }
  }

  test('bughunter prompt generation works in non-git directory', async () => {
    const originalUserType = process.env['USER_TYPE']
    const originalIsDemo = process.env['IS_DEMO']
    delete process.env['USER_TYPE']
    delete process.env['IS_DEMO']
    clearCommandMemoizationCaches()
    // Create a temp dir WITHOUT .git
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-bughunter-nogit-'))
    try {
      const cmds = await getCommands(cwd)
      const bughunterCmd = findPromptCommand(cmds, 'bughunter')
      // Generate the prompt - should not throw and should contain fallback text
      const mockContext = createMockToolContext(cwd, FULL_GIT_COMMANDS)
      // Run with cwd override so git commands execute in the temp dir (non-git)
      const promptBlocks = await runWithCwdOverride(cwd, async () => {
        return bughunterCmd.getPromptForCommand('', mockContext)
      })
      expect(promptBlocks).toBeDefined()
      expect(promptBlocks.length).toBeGreaterThan(0)
      const promptText = promptBlocks[0].type === 'text' ? promptBlocks[0].text : ''
      // Verify git fallback text appears (not blank) - now in template as static text
      // Shell tool outputs "(Bash completed with no output)" for empty results, which is valid
      const checkEmptyIndicator = (text: string, expected: string) => {
        expect(text).toMatch(new RegExp(`(${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Bash completed with no output)`))
      }
      checkEmptyIndicator(promptText, '(If empty: not a git repository or git unavailable)')
      checkEmptyIndicator(promptText, '(If empty: no unstaged changes or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no staged changes or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no git history or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no diff available or not a git repo)')
    } finally {
      try {
        await rmRetry(cwd)
      } finally {
        if (originalUserType !== undefined) {
          process.env['USER_TYPE'] = originalUserType
        } else {
          delete process.env['USER_TYPE']
        }
        if (originalIsDemo !== undefined) {
          process.env['IS_DEMO'] = originalIsDemo
        } else {
          delete process.env['IS_DEMO']
        }
        clearCommandMemoizationCaches()
      }
    }
  })

  // All three bughunter commands share the same git-context block template
  // and the same lineLimits call, so we parameterize the regression tests
  // over the sibling names. A regression in any one of them (e.g. losing
  // the HEAD~10 → git log swap, or dropping the 400-line cap) would fail
  // here even if a sibling's prompt was edited in isolation.
  const BUGHUNTER_SIBLINGS = [
    'bughunter',
    'bughunter-security',
    'bughunter-perf',
  ] as const

  for (const cmdName of BUGHUNTER_SIBLINGS) {
    test(`${cmdName} keeps git context populated in a fresh single-commit repo`, async () => {
      // Regression: in a one-commit repo, the prior `git diff --name-only
      // HEAD~10..HEAD` snippet exited 128, which the outer catch converted to
      // stripping every snippet. Switched to `git log -10` so all the other
      // git-context blocks (status, staged, diff) still populate even when
      // the repo is too shallow for HEAD~10 to resolve.
      const originalUserType = process.env['USER_TYPE']
      const originalIsDemo = process.env['IS_DEMO']
      delete process.env['USER_TYPE']
      delete process.env['IS_DEMO']
      clearCommandMemoizationCaches()
      const cwd = await mkdtemp(
        join(tmpdir(), `oc-test-bughunter-fresh-${cmdName}-`),
      )
      try {
        // Build a real one-commit repo with an unstaged change
        const { spawnSync } = await import('node:child_process')
        const run = (args: string[]) =>
          spawnSync('git', args, { cwd, encoding: 'utf8' })
        run(['init', '-q'])
        run(['config', 'user.email', 't@t'])
        run(['config', 'user.name', 't'])
        run(['config', 'commit.gpgsign', 'false'])
        await Bun.write(join(cwd, 'a.txt'), 'a\n')
        run(['add', 'a.txt'])
        run(['commit', '-q', '-m', 'init'])
        await Bun.write(join(cwd, 'b.txt'), 'b\n') // untracked / unstaged

        const cmds = await getCommands(cwd)
        const cmd = findPromptCommand(cmds, cmdName)
        const mockContext = createMockToolContext(cwd, FULL_GIT_COMMANDS)
        const promptBlocks = await runWithCwdOverride(cwd, async () => {
          return cmd.getPromptForCommand('', mockContext)
        })
        const promptText =
          promptBlocks[0].type === 'text' ? promptBlocks[0].text : ''
        // git status should mention the new untracked b.txt (not "(Bash completed
        // with no output)" — that would mean the catch-all stripped it).
        expect(promptText).toContain('b.txt')
        // The diff block should at least mention the file or the diff marker —
        // and crucially must not be the "head -10 revision" error.
        expect(promptText).not.toMatch(/unknown revision|HEAD~10/)
      } finally {
        try {
          await rmRetry(cwd)
        } finally {
          if (originalUserType !== undefined) {
            process.env['USER_TYPE'] = originalUserType
          } else {
            delete process.env['USER_TYPE']
          }
          if (originalIsDemo !== undefined) {
            process.env['IS_DEMO'] = originalIsDemo
          } else {
            delete process.env['IS_DEMO']
          }
          clearCommandMemoizationCaches()
        }
      }
    })
  }

  for (const cmdName of BUGHUNTER_SIBLINGS) {
    test(`${cmdName} diff block is bounded to 400 lines`, async () => {
      // Regression: the prompt label advertises "first 400 lines" but commit
      // 73d0bcb dropped the `| head -400` cap. Reproduce with a 1000-line diff
      // and assert the diff code block in the rendered prompt has ≤ 400 lines.
      const originalUserType = process.env['USER_TYPE']
      const originalIsDemo = process.env['IS_DEMO']
      delete process.env['USER_TYPE']
      delete process.env['IS_DEMO']
      clearCommandMemoizationCaches()
      const cwd = await mkdtemp(
        join(tmpdir(), `oc-test-bughunter-cap-${cmdName}-`),
      )
      try {
        const { spawnSync } = await import('node:child_process')
        const run = (args: string[]) =>
          spawnSync('git', args, { cwd, encoding: 'utf8' })
        run(['init', '-q'])
        run(['config', 'user.email', 't@t'])
        run(['config', 'user.name', 't'])
        run(['config', 'commit.gpgsign', 'false'])
        // Commit a baseline file with 1000 lines
        const baseline =
          Array.from({ length: 1000 }, (_, i) => `line${i + 1}`).join('\n') +
          '\n'
        await Bun.write(join(cwd, 'big.txt'), baseline)
        run(['add', 'big.txt'])
        run(['commit', '-q', '-m', 'baseline'])
        // Modify every line to force a 1000+-line diff
        const modified =
          Array.from({ length: 1000 }, (_, i) => `+line${i + 1}`).join('\n') +
          '\n'
        await Bun.write(join(cwd, 'big.txt'), modified)

        const cmds = await getCommands(cwd)
        const cmd = findPromptCommand(cmds, cmdName)
        const mockContext = createMockToolContext(cwd, FULL_GIT_COMMANDS)
        const promptBlocks = await runWithCwdOverride(cwd, async () => {
          return cmd.getPromptForCommand('', mockContext)
        })
        const promptText =
          promptBlocks[0].type === 'text' ? promptBlocks[0].text : ''
        // Locate the DIFF code block and count its lines
        const diffMatch = promptText.match(
          /DIFF OF UNSTAGED \+ STAGED CHANGES[\s\S]*?```\n([\s\S]*?)\n```/,
        )
        expect(diffMatch).not.toBeNull()
        const diffBody = diffMatch![1]
        const diffLineCount = diffBody.split('\n').length
        expect(diffLineCount).toBeLessThanOrEqual(400)
        // And the line cap is actually being applied, not just truncating by
        // chance: the diff body should have hundreds of lines truncated.
        expect(diffLineCount).toBeGreaterThan(100)
      } finally {
        try {
          await rmRetry(cwd)
        } finally {
          if (originalUserType !== undefined) {
            process.env['USER_TYPE'] = originalUserType
          } else {
            delete process.env['USER_TYPE']
          }
          if (originalIsDemo !== undefined) {
            process.env['IS_DEMO'] = originalIsDemo
          } else {
            delete process.env['IS_DEMO']
          }
          clearCommandMemoizationCaches()
        }
      }
    })
  }

  test('bughunter does not execute shell snippets in user-provided args', async () => {
    const originalUserType = process.env['USER_TYPE']
    const originalIsDemo = process.env['IS_DEMO']
    delete process.env['USER_TYPE']
    delete process.env['IS_DEMO']
    clearCommandMemoizationCaches()
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-bughunter-inject-'))
    try {
      const cmds = await getCommands(cwd)
      const bughunterCmd = findPromptCommand(cmds, 'bughunter')
      const mockContext = createMockToolContext(cwd, [
        'git status', 'git diff --name-only --diff-filter=AM',
        'git diff --cached --name-only --diff-filter=AM',
        'git log -10 --pretty=format: --name-only --diff-filter=AM',
        'git ls-files', 'git diff HEAD -- .', 'head -400', 'head -50',
      ])
      // Pass args containing shell-like syntax - it must appear verbatim, not executed
      const maliciousScope = 'src/auth !`echo pwned`'
      const promptBlocks = await runWithCwdOverride(cwd, async () => {
        return bughunterCmd.getPromptForCommand(maliciousScope, mockContext)
      })
      const promptText = promptBlocks[0].type === 'text' ? promptBlocks[0].text : ''
      // The shell snippet should appear VERBATIM (injection prevented)
      expect(promptText).toContain(maliciousScope)
      // The git context shell blocks should have been executed (showing fallback text)
      // Accept either bash output or the static echo fallback text (for Windows/no-bash)
      expect(promptText).toMatch(/(If empty:|bash completed with no output)/i)
    } finally {
      try {
        await rmRetry(cwd)
      } finally {
        if (originalUserType !== undefined) {
          process.env['USER_TYPE'] = originalUserType
        } else {
          delete process.env['USER_TYPE']
        }
        if (originalIsDemo !== undefined) {
          process.env['IS_DEMO'] = originalIsDemo
        } else {
          delete process.env['IS_DEMO']
        }
        clearCommandMemoizationCaches()
      }
    }
  })

  test('bughunter-security prompt generation works in non-git directory', async () => {
    const originalUserType = process.env['USER_TYPE']
    const originalIsDemo = process.env['IS_DEMO']
    delete process.env['USER_TYPE']
    delete process.env['IS_DEMO']
    clearCommandMemoizationCaches()
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-bughunter-sec-nogit-'))
    try {
      const cmds = await getCommands(cwd)
      const cmd = findPromptCommand(cmds, 'bughunter-security')
      const mockContext = createMockToolContext(cwd, FULL_GIT_COMMANDS)
      // Run with cwd override so git commands execute in the temp dir (non-git)
      const promptBlocks = await runWithCwdOverride(cwd, async () => {
        return cmd.getPromptForCommand('', mockContext)
      })
      const promptText = promptBlocks[0].type === 'text' ? promptBlocks[0].text : ''
      // Shell tool outputs "(Bash completed with no output)" for empty results, which is valid
      const checkEmptyIndicator = (text: string, expected: string) => {
        expect(text).toMatch(new RegExp(`(${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Bash completed with no output)`))
      }
      checkEmptyIndicator(promptText, '(If empty: not a git repository or git unavailable)')
      checkEmptyIndicator(promptText, '(If empty: no unstaged changes or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no staged changes or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no git history or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no diff available or not a git repo)')
    } finally {
      try {
        await rmRetry(cwd)
      } finally {
        if (originalUserType !== undefined) {
          process.env['USER_TYPE'] = originalUserType
        } else {
          delete process.env['USER_TYPE']
        }
        if (originalIsDemo !== undefined) {
          process.env['IS_DEMO'] = originalIsDemo
        } else {
          delete process.env['IS_DEMO']
        }
        clearCommandMemoizationCaches()
      }
    }
  })

  test('bughunter-perf prompt generation works in non-git directory', async () => {
    const originalUserType = process.env['USER_TYPE']
    const originalIsDemo = process.env['IS_DEMO']
    delete process.env['USER_TYPE']
    delete process.env['IS_DEMO']
    clearCommandMemoizationCaches()
    const cwd = await mkdtemp(join(tmpdir(), 'oc-test-bughunter-perf-nogit-'))
    try {
      const cmds = await getCommands(cwd)
      const cmd = findPromptCommand(cmds, 'bughunter-perf')
      const mockContext = createMockToolContext(cwd, FULL_GIT_COMMANDS)
      // Run with cwd override so git commands execute in the temp dir (non-git)
      const promptBlocks = await runWithCwdOverride(cwd, async () => {
        return cmd.getPromptForCommand('', mockContext)
      })
      const promptText = promptBlocks[0].type === 'text' ? promptBlocks[0].text : ''
      // Shell tool outputs "(Bash completed with no output)" for empty results, which is valid
      const checkEmptyIndicator = (text: string, expected: string) => {
        expect(text).toMatch(new RegExp(`(${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Bash completed with no output)`))
      }
      checkEmptyIndicator(promptText, '(If empty: not a git repository or git unavailable)')
      checkEmptyIndicator(promptText, '(If empty: no unstaged changes or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no staged changes or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no git history or not a git repo)')
      checkEmptyIndicator(promptText, '(If empty: no diff available or not a git repo)')
    } finally {
      try {
        await rmRetry(cwd)
      } finally {
        if (originalUserType !== undefined) {
          process.env['USER_TYPE'] = originalUserType
        } else {
          delete process.env['USER_TYPE']
        }
        if (originalIsDemo !== undefined) {
          process.env['IS_DEMO'] = originalIsDemo
        } else {
          delete process.env['IS_DEMO']
        }
        clearCommandMemoizationCaches()
      }
    }
  })

  test('includes the request-size diagnostic command', () => {
    expect(builtInCommandNames()).toContain('request-size')
  })

  test('includes the /dream command', () => {
    expect(builtInCommandNames()).toContain('dream')
  })
})

describe('isCommand', () => {
  test('rejects generated missing-module noop stubs', () => {
    function noop19() {
      return null
    }

    expect(isCommand(noop19)).toBe(false)
    expect(isCommand({ isHidden: true, name: 'stub' })).toBe(false)
  })

  test('accepts real command objects', () => {
    expect(
      isCommand({
        type: 'local',
        name: 'example',
        description: 'example command',
        supportsNonInteractive: false,
        load: async () => ({
          call: async () => ({ type: 'skip' }),
        }),
      }),
    ).toBe(true)
  })
})

describe('formatDescriptionWithSource', () => {
  test('returns empty text for prompt commands missing a description', () => {
    const command = {
      name: 'example',
      type: 'prompt',
      source: 'builtin',
      description: undefined,
    } as unknown as import('./commands.js').Command

    expect(formatDescriptionWithSource(command)).toBe('')
  })

  test('formats plugin commands with missing description safely', () => {
    const command = {
      name: 'example',
      type: 'prompt',
      source: 'plugin',
      description: undefined,
      pluginInfo: {
        pluginManifest: {
          name: 'MyPlugin',
        },
      },
    } as unknown as import('./commands.js').Command

    expect(formatDescriptionWithSource(command)).toBe('(MyPlugin) ')
  })

  test('translates prompt built-in descriptions using the current language', () => {
    const command = {
      name: 'review',
      type: 'prompt',
      source: 'builtin',
      description: 'Review a pull request',
      localizationKey: 'commands.review.description',
    } as unknown as import('./commands.js').Command

    useLanguage('english')
    expect(formatDescriptionWithSource(command)).toBe('Review a pull request')

    useLanguage('vietnamese')
    expect(formatDescriptionWithSource(command)).toBe('Đánh giá pull request')
  })

  test('falls back to English when an OpenClaude localization key is missing', () => {
    const command = {
      name: 'example',
      type: 'prompt',
      source: 'builtin',
      description: 'English fallback description',
      localizationKey: 'commands.example.missing.description',
    } as unknown as import('./commands.js').Command

    useLanguage('vietnamese')
    expect(formatDescriptionWithSource(command)).toBe(
      'English fallback description',
    )
  })

  test('does not translate project, policy, workflow, or user-authored descriptions', () => {
    const description = 'Review a pull request'
    const promptCommand = (source: string) =>
      ({
        name: 'external-review',
        type: 'prompt',
        source,
        description,
      } as import("./commands.js").Command)

    useLanguage('vietnamese')

    expect(formatDescriptionWithSource(promptCommand('projectSettings'))).toBe(
      'Review a pull request (project)',
    )
    expect(formatDescriptionWithSource(promptCommand('userSettings'))).toBe(
      'Review a pull request (user)',
    )
    expect(formatDescriptionWithSource(promptCommand('policySettings'))).toBe(
      'Review a pull request (managed)',
    )
    expect(formatDescriptionWithSource(promptCommand('localSettings'))).toBe(
      'Review a pull request (project, gitignored)',
    )
    expect(formatDescriptionWithSource(promptCommand('flagSettings'))).toBe(
      'Review a pull request (cli flag)',
    )
    expect(
      formatDescriptionWithSource({
        ...promptCommand('projectSettings'),
        kind: 'workflow',
      }),
    ).toBe('Review a pull request (workflow)')
  })

  test('does not translate plugin descriptions that match built-in English text', () => {
    const command = {
      name: 'external-review',
      type: 'prompt',
      source: 'plugin',
      description: 'Review a pull request',
      pluginInfo: {
        pluginManifest: {
          name: 'MyPlugin',
        },
      },
    } as unknown as import('./commands.js').Command

    useLanguage('vietnamese')

    expect(formatDescriptionWithSource(command)).toBe(
      '(MyPlugin) Review a pull request',
    )
  })

  test('does not translate non-prompt local descriptions without a localization key', () => {
    const command = {
      name: 'external-review',
      type: 'local',
      description: 'Review a pull request',
    } as unknown as import('./commands.js').Command

    useLanguage('vietnamese')

    expect(formatDescriptionWithSource(command)).toBe('Review a pull request')
  })

  test('translates non-prompt local descriptions only with an explicit localization key', () => {
    const command = {
      name: 'copy',
      type: 'local',
      description:
        "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
      localizationKey: 'commands.copy.description',
    } as unknown as import('./commands.js').Command

    useLanguage('vietnamese')
    expect(formatDescriptionWithSource(command)).toBe(
      'Sao chép phản hồi gần nhất của Claude vào clipboard (hoặc /copy N cho phản hồi thứ N gần nhất)',
    )

    useLanguage('english')
    expect(formatDescriptionWithSource(command)).toBe(
      "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
    )
  })
})

describe('bundled skill localization', () => {
  test('resolves descriptions from the current language at read time', () => {
    resetSettingsCache()
    clearBundledSkills()
    registerBatchSkill()
    registerDebugSkill()
    registerLoopSkill()
    registerSimplifySkill()
    registerUpdateConfigSkill()
    const batch = getBundledSkills().find(command => command.name === 'batch')
    const debug = getBundledSkills().find(command => command.name === 'debug')
    const loop = getBundledSkills().find(command => command.name === 'loop')
    const simplify = getBundledSkills().find(
      command => command.name === 'simplify',
    )
    const updateConfig = getBundledSkills().find(
      command => command.name === 'update-config',
    )
    const expectedDebugEnglish =
      process.env.USER_TYPE === 'ant'
        ? 'Debug your current Claude Code session by reading the session debug log. Includes all event logging'
        : 'Enable debug logging for this session and help diagnose issues'
    const expectedDebugVietnamese =
      process.env.USER_TYPE === 'ant'
        ? 'Debug phiên Claude Code hiện tại bằng cách đọc debug log của phiên. Bao gồm toàn bộ event logging'
        : 'Bật debug logging cho phiên này và hỗ trợ chẩn đoán sự cố'

    expect(batch).toBeDefined()
    expect(debug).toBeDefined()
    expect(loop).toBeDefined()
    expect(simplify).toBeDefined()
    expect(updateConfig).toBeDefined()
    expect(batch!.localizationKey).toBe('skills.batch.description')
    expect(loop!.localizationKey).toBe('skills.loop.description')
    expect(loop!.whenToUseLocalizationKey).toBe('skills.loop.whenToUse')

    useLanguage('english')
    expect(batch!.description).toBe(
      'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.',
    )
    expect(debug!.description).toBe(expectedDebugEnglish)
    expect(loop!.description).toBe(
      'Run a prompt on a fixed interval or dynamically reschedule it, including bare maintenance-mode loops.',
    )
    expect(loop!.whenToUse).toBe(
      'When the user wants to poll for status, babysit a workflow, run recurring maintenance, or keep re-running a prompt within the current session.',
    )
    expect(simplify!.description).toBe(
      'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
    )
    expect(updateConfig!.description).toStartWith(
      'Use this skill to configure the Claude Code harness via settings.json.',
    )

    useLanguage('vietnamese')
    expect(batch!.description).toBe(
      'Nghiên cứu và lập kế hoạch cho một thay đổi quy mô lớn, rồi thực thi song song trên 5–30 agent worktree cô lập, mỗi agent mở một PR.',
    )
    expect(debug!.description).toBe(expectedDebugVietnamese)
    expect(loop!.description).toBe(
      'Chạy một prompt theo khoảng thời gian cố định hoặc lên lịch lại động, bao gồm cả chế độ bảo trì lặp lại.',
    )
    expect(loop!.whenToUse).toBe(
      'Khi người dùng muốn kiểm tra trạng thái, giám sát quy trình, chạy bảo trì định kỳ, hoặc chạy lại một prompt trong phiên hiện tại.',
    )
    expect(simplify!.description).toBe(
      'Đánh giá code đã thay đổi về mặt tái sử dụng, chất lượng và hiệu suất, sau đó sửa các vấn đề tìm được.',
    )
    expect(updateConfig!.description).toStartWith(
      'Sử dụng skill này để cấu hình Claude Code qua settings.json.',
    )

    useLanguage('english')
    expect(loop!.description).toBe(
      'Run a prompt on a fixed interval or dynamically reschedule it, including bare maintenance-mode loops.',
    )
    expect(updateConfig!.description).toStartWith(
      'Use this skill to configure the Claude Code harness via settings.json.',
    )
  })

  test('falls back to bundled skill English text when a localization key is missing', () => {
    registerBundledSkill({
      name: 'fallback-skill',
      description: 'English-only bundled skill description',
      descriptionKey: 'skills.fallback-skill.missing.description',
      getPromptForCommand: async () => [],
    })

    const skill = getBundledSkills().find(
      command => command.name === 'fallback-skill',
    )

    expect(skill).toBeDefined()

    useLanguage('vietnamese')
    expect(skill!.description).toBe('English-only bundled skill description')
    expect(formatDescriptionWithSource(skill!)).toBe(
      'English-only bundled skill description (bundled)',
    )
  })
})
