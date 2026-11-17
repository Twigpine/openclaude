import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getOriginalCwd,
  getProjectRoot,
  setAllowedSettingSources,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { SETTING_SOURCES } from '../../utils/settings/constants.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  bashCommandIsSafe_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from './bashSecurity.js'

async function withProjectSettings(
  settings: Record<string, unknown>,
  fn: () => void,
): Promise<void> {
  const originalCwd = getOriginalCwd()
  const originalProjectRoot = getProjectRoot()
  const projectDir = await mkdtemp(join(tmpdir(), 'openclaude-bash-security-'))

  try {
    setOriginalCwd(projectDir)
    setProjectRoot(projectDir)
    setAllowedSettingSources([...SETTING_SOURCES])
    await mkdir(join(projectDir, '.openclaude'), { recursive: true })
    await writeFile(
      join(projectDir, '.openclaude', 'settings.local.json'),
      JSON.stringify(settings),
    )
    resetSettingsCache()
    fn()
  } finally {
    setOriginalCwd(originalCwd)
    setProjectRoot(originalProjectRoot)
    setAllowedSettingSources([...SETTING_SOURCES])
    resetSettingsCache()
    await rm(projectDir, { recursive: true, force: true })
  }
}

function expectAskMessage(
  result: ReturnType<typeof bashCommandIsSafe_DEPRECATED>,
  text: string,
): void {
  expect(result.behavior).toBe('ask')
  if (result.behavior !== 'ask') {
    throw new Error(`Expected ask result, got ${result.behavior}`)
  }
  expect(result.message).toContain(text)
}

describe('stripSafeHeredocSubstitutions', () => {
  test('strips a single safe heredoc substitution', () => {
    const cmd = "git commit -m $(cat <<'EOF'\nfix: whatever\nEOF\n)"
    const result = stripSafeHeredocSubstitutions(cmd)
    expect(result).toBe('git commit -m ')
  })

  test('returns null for nested heredoc substitutions (stale-index regression)', () => {
    const cmd = "$(cat <<'OUTER'\n$(cat <<'INNER'\ndata\nINNER)\nOUTER)"
    const result = stripSafeHeredocSubstitutions(cmd)
    expect(result).toBeNull()
  })

  test('returns null when no heredoc substitution is present', () => {
    const result = stripSafeHeredocSubstitutions('echo hello world')
    expect(result).toBeNull()
  })

  test('strips multiple non-nested heredoc substitutions', () => {
    const cmd = "$(cat <<'A'\nfoo\nA) $(cat <<'B'\nbar\nB)"
    const result = stripSafeHeredocSubstitutions(cmd)
    expect(result).toBe(' ')
  })
})

describe('validateZshDangerousCommands: fc -e detection (#1051 BUG-01)', () => {
  // Regression: the previous regex `/\s-\S*e/` matched any flag whose body
  // contained an `e` anywhere, so legitimate fc invocations with unrelated
  // long-style flags like `-reset`, `-reverse`, or `-message` (real or not,
  // users do type them) tripped the dangerous-zsh check and surfaced an
  // interactive permission prompt to the user. The replacement caps the
  // short-flag bundle at 4 chars total and requires `e` to be the last
  // letter before whitespace or end-of-string.
  test('asks for `fc -e vim ls` (real `-e` editor flag)', () => {
    const result = bashCommandIsSafe_DEPRECATED('fc -e vim ls')
    expect(result.behavior).toBe('ask')
  })

  test('asks for bundled short flags ending in e (`fc -le ls`)', () => {
    const result = bashCommandIsSafe_DEPRECATED('fc -le ls')
    expect(result.behavior).toBe('ask')
  })

  test('asks for 3-char bundled short flags ending in e (`fc -lne ls`)', () => {
    const result = bashCommandIsSafe_DEPRECATED('fc -lne ls')
    expect(result.behavior).toBe('ask')
  })

  test('does not ask for `fc -reset` (false positive on `-reset`)', () => {
    const result = bashCommandIsSafe_DEPRECATED('fc -reset')
    expect(result.behavior).not.toBe('ask')
  })

  test('does not ask for `fc -reverse` (false positive on `-reverse`)', () => {
    const result = bashCommandIsSafe_DEPRECATED('fc -reverse')
    expect(result.behavior).not.toBe('ask')
  })

  test('does not ask for `fc -message` (false positive on `-message`)', () => {
    const result = bashCommandIsSafe_DEPRECATED('fc -message')
    expect(result.behavior).not.toBe('ask')
  })

  test('does not ask for `fc -l` (safe list flag)', () => {
    const result = bashCommandIsSafe_DEPRECATED('fc -l')
    expect(result.behavior).not.toBe('ask')
  })
})

describe('git commit governance policy (#1326)', () => {
  test('asks when a simple commit message contains a forbidden pattern', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Co-Authored-By:'] } },
      () => {
        const result = bashCommandIsSafe_DEPRECATED(
          'git commit -m "fix: policy\n\nCo-Authored-By: OpenClaude <openclaude@gitlawb.com>"',
        )

        expectAskMessage(result, 'Co-Authored-By:')
      },
    )
  })

  test('asks when a heredoc commit message contains disabled AI attribution', async () => {
    await withProjectSettings(
      { git: { addAICoAuthor: false } },
      () => {
        const result = bashCommandIsSafe_DEPRECATED(
          "git commit -m \"$(cat <<'EOF'\nfix: policy\n\nGenerated with OpenClaude\nEOF\n)\"",
        )

        expectAskMessage(result, 'AI attribution')
      },
    )
  })

  test('checks commit messages when git global options precede commit', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const result = bashCommandIsSafe_DEPRECATED(
          'git -C ./repo -c user.name=bot commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )

        expectAskMessage(result, 'Generated with')
      },
    )
  })

  test('checks commit messages when safe env assignments precede git', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const result = bashCommandIsSafe_DEPRECATED(
          'GIT_AUTHOR_NAME=bot git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )

        expectAskMessage(result, 'Generated with')
      },
    )
  })

  test('checks commit messages when git executable is quoted, git.exe, or wrapped with command', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const doubleQuoted = bashCommandIsSafe_DEPRECATED(
          '"git" commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const singleQuoted = bashCommandIsSafe_DEPRECATED(
          "'git' commit -m \"fix: policy\n\nGenerated with OpenClaude\"",
        )
        const gitExe = bashCommandIsSafe_DEPRECATED(
          'git.exe commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const commandWrapped = bashCommandIsSafe_DEPRECATED(
          'command git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const commandPathWrapped = bashCommandIsSafe_DEPRECATED(
          'command -p git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const commandEndOfOptionsWrapped = bashCommandIsSafe_DEPRECATED(
          'command -- git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )

        expect(doubleQuoted.behavior).toBe('ask')
        expect(singleQuoted.behavior).toBe('ask')
        expect(gitExe.behavior).toBe('ask')
        expect(commandWrapped.behavior).toBe('ask')
        expect(commandPathWrapped.behavior).toBe('ask')
        expect(commandEndOfOptionsWrapped.behavior).toBe('ask')
      },
    )
  })

  test('checks commit messages when env wraps git', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const envWrapped = bashCommandIsSafe_DEPRECATED(
          'env git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const envAssignmentWrapped = bashCommandIsSafe_DEPRECATED(
          'env GIT_AUTHOR_NAME=bot git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const envOptionWrapped = bashCommandIsSafe_DEPRECATED(
          'env -i -u GIT_CONFIG_GLOBAL git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const envSplitStringWrapped = bashCommandIsSafe_DEPRECATED(
          'env -S \'git commit -m "fix: policy\n\nGenerated with OpenClaude"\'',
        )
        const envInlineSplitStringWrapped = bashCommandIsSafe_DEPRECATED(
          'env --split-string="git commit -m \\"fix: policy\n\nGenerated with OpenClaude\\""',
        )
        const envSplitStringAssignmentWrapped = bashCommandIsSafe_DEPRECATED(
          'env -S \'GIT_AUTHOR_NAME=bot git commit -m "fix: policy\n\nGenerated with OpenClaude"\'',
        )
        const envSplitStringGlobalOptionWrapped = bashCommandIsSafe_DEPRECATED(
          'env -S \'git -c user.name=bot commit -m "fix: policy\n\nGenerated with OpenClaude"\'',
        )

        expect(envWrapped.behavior).toBe('ask')
        expect(envAssignmentWrapped.behavior).toBe('ask')
        expect(envOptionWrapped.behavior).toBe('ask')
        expect(envSplitStringWrapped.behavior).toBe('ask')
        expect(envInlineSplitStringWrapped.behavior).toBe('ask')
        expect(envSplitStringAssignmentWrapped.behavior).toBe('ask')
        expect(envSplitStringGlobalOptionWrapped.behavior).toBe('ask')
      },
    )
  })

  test('checks commit messages passed with long message options', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated'] } },
      () => {
        const spaced = bashCommandIsSafe_DEPRECATED(
          'git commit --message "fix: policy\n\nGenerated with OpenClaude"',
        )
        const equals = bashCommandIsSafe_DEPRECATED(
          'git commit --message="fix: policy\n\nGenerated with OpenClaude"',
        )
        const unquoted = bashCommandIsSafe_DEPRECATED(
          'git commit --message=Generated',
        )

        expect(spaced.behavior).toBe('ask')
        expect(equals.behavior).toBe('ask')
        expect(unquoted.behavior).toBe('ask')
      },
    )
  })

  test('asks for file-backed commit messages when commit-message policy is active', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const result = bashCommandIsSafe_DEPRECATED(
          'git commit -F .git/OPENCLAUDE_COMMIT_MSG',
        )

        expectAskMessage(result, 'loaded from a file')
      },
    )
  })

  test('asks for uninspectable commit message sources when commit-message policy is active', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const editorDefault = bashCommandIsSafe_DEPRECATED('git commit')
        const reuseShort = bashCommandIsSafe_DEPRECATED('git commit -C HEAD')
        const reuseLong = bashCommandIsSafe_DEPRECATED(
          'git commit --reuse-message=HEAD',
        )
        const reeditShort = bashCommandIsSafe_DEPRECATED('git commit -c HEAD')
        const reeditLong = bashCommandIsSafe_DEPRECATED(
          'git commit --reedit-message HEAD',
        )
        const editor = bashCommandIsSafe_DEPRECATED('git commit --amend')

        expectAskMessage(editorDefault, 'cannot be checked')
        expectAskMessage(reuseShort, 'cannot be checked')
        expectAskMessage(reuseLong, 'cannot be checked')
        expectAskMessage(reeditShort, 'cannot be checked')
        expectAskMessage(reeditLong, 'cannot be checked')
        expectAskMessage(editor, 'cannot be checked')
      },
    )
  })

  test('asks for expandable commit messages when commit-message policy is active', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const envVar = bashCommandIsSafe_DEPRECATED('git commit -m "$MSG"')
        const commandSubstitution = bashCommandIsSafe_DEPRECATED(
          'git commit --message="$(cat .git/OPENCLAUDE_COMMIT_MSG)"',
        )
        const backtick = bashCommandIsSafe_DEPRECATED(
          'git commit -m "`cat .git/OPENCLAUDE_COMMIT_MSG`"',
        )
        const unquoted = bashCommandIsSafe_DEPRECATED(
          'git commit -m fix$VAR',
        )
        const unquotedCommandSubstitution = bashCommandIsSafe_DEPRECATED(
          'git commit -m $(cat .git/OPENCLAUDE_COMMIT_MSG)',
        )

        expectAskMessage(envVar, 'cannot be checked')
        expectAskMessage(commandSubstitution, 'cannot be checked')
        expectAskMessage(backtick, 'cannot be checked')
        expectAskMessage(unquoted, 'cannot be checked')
        expectAskMessage(unquotedCommandSubstitution, 'cannot be checked')
      },
    )
  })

  test('asks for expandable heredoc commit messages when commit-message policy is active', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      () => {
        const unquotedHeredoc = bashCommandIsSafe_DEPRECATED(
          'git commit -m $(cat <<EOF\n$MSG\nEOF\n)',
        )
        const literalHeredocWithForbiddenText = bashCommandIsSafe_DEPRECATED(
          "git commit -m $(cat <<'EOF'\nGenerated with OpenClaude\nEOF\n)",
        )

        expectAskMessage(unquotedHeredoc, 'cannot be checked')
        expectAskMessage(literalHeredocWithForbiddenText, 'Generated with')
      },
    )
  })

  test('does not treat PR footer opt-out as a generated commit attribution block', async () => {
    await withProjectSettings(
      { git: { addGeneratedWithFooter: false } },
      () => {
        const result = bashCommandIsSafe_DEPRECATED(
          'git commit -m "fix: policy\n\nCo-Authored-By: OpenClaude <openclaude@gitlawb.com>"',
        )

        expect(result.behavior).toBe('passthrough')
      },
    )
  })
})
