import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  setAllowedSettingSources,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setGovernancePolicySettingsForSourceForTesting } from '../../utils/governancePolicy.js'
import { SETTING_SOURCES } from '../../utils/settings/constants.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { isUnsafeDotGitWritePathForPowerShell } from './powershellPermissions.js'

type CheckPowerShellCommitMessagePolicy =
  typeof import('./PowerShellTool.js')['checkPowerShellCommitMessagePolicy']
type PowerShellCommitPolicyResult =
  ReturnType<CheckPowerShellCommitMessagePolicy>

function expectPowerShellAskMessage(
  result: PowerShellCommitPolicyResult,
  text: string,
): void {
  expect(result?.behavior).toBe('ask')
  if (!result || result.behavior !== 'ask') {
    throw new Error(`Expected ask result, got ${result?.behavior ?? 'null'}`)
  }
  expect(result.message).toContain(text)
}

function permissionContext(mode: ToolPermissionContext['mode']) {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable:
      mode === 'bypassPermissions' || mode === 'fullAccess',
  } satisfies ToolPermissionContext
}

describe('PowerShell .git write safety', () => {
  let originalCwd: string
  let projectDir: string

  beforeEach(async () => {
    originalCwd = getOriginalCwd()
    projectDir = await mkdtemp(join(tmpdir(), 'openclaude-ps-perms-'))
    await mkdir(join(projectDir, '.git'))
    setOriginalCwd(projectDir)
    setCwdState(projectDir)
  })

  afterEach(async () => {
    setOriginalCwd(originalCwd)
    setCwdState(originalCwd)
    await rm(projectDir, { recursive: true, force: true })
  })

  test('does not force a .git safety prompt for the commit message temp file in bypass mode', () => {
    expect(
      isUnsafeDotGitWritePathForPowerShell(
        '.git/OPENCLAUDE_COMMIT_MSG',
        permissionContext('bypassPermissions'),
      ),
    ).toBe(false)
  })

  test('does not force a .git safety prompt for the commit message temp file in full access mode', () => {
    expect(
      isUnsafeDotGitWritePathForPowerShell(
        '.git/OPENCLAUDE_COMMIT_MSG',
        permissionContext('fullAccess'),
      ),
    ).toBe(false)
  })

  test('still prompts for the commit message temp file outside dangerous modes', () => {
    expect(
      isUnsafeDotGitWritePathForPowerShell(
        '.git/OPENCLAUDE_COMMIT_MSG',
        permissionContext('default'),
      ),
    ).toBe(true)
  })

  test('still prompts for other .git writes in bypass mode', () => {
    expect(
      isUnsafeDotGitWritePathForPowerShell(
        '.git/config',
        permissionContext('bypassPermissions'),
      ),
    ).toBe(true)
  })
})

describe('PowerShell git commit governance policy', () => {
  async function withProjectSettings(
    settings: Record<string, unknown>,
    fn: (checkPowerShellCommitMessagePolicy: CheckPowerShellCommitMessagePolicy) => void,
  ): Promise<void> {
    await acquireSharedMutationLock('PowerShell git commit governance policy')
    try {
      setAllowedSettingSources([...SETTING_SOURCES])
      setGovernancePolicySettingsForSourceForTesting(
        source => (source === 'localSettings' ? settings as SettingsJson : null),
      )
      resetSettingsCache()
      const { checkPowerShellCommitMessagePolicy } = await import(
        `./PowerShellTool.js?psPolicyTest=${Date.now()}-${Math.random()}`
      )
      fn(checkPowerShellCommitMessagePolicy)
    } finally {
      setAllowedSettingSources([...SETTING_SOURCES])
      setGovernancePolicySettingsForSourceForTesting(null)
      resetSettingsCache()
      releaseSharedMutationLock()
    }
  }

  test('returns a bypass-immune safety check for forbidden commit messages', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const result = checkPowerShellCommitMessagePolicy(
          'git -C ./repo commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )

        expect(result?.behavior).toBe('ask')
        expect(result?.decisionReason).toMatchObject({
          type: 'safetyCheck',
          reason:
            'Git commit message contains forbidden pattern: Generated with',
        })
      },
    )
  })

  test('checks call-operator git commits', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const result = checkPowerShellCommitMessagePolicy(
          '& git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )

        expectPowerShellAskMessage(result, 'Generated with')
      },
    )
  })

  test('checks quoted and exe PowerShell git invocations', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const quoted = checkPowerShellCommitMessagePolicy(
          '& "git" commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const exe = checkPowerShellCommitMessagePolicy(
          'git.exe commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const quotedExe = checkPowerShellCommitMessagePolicy(
          '& "git.exe" commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )
        const singleQuotedExe = checkPowerShellCommitMessagePolicy(
          "& 'git.exe' commit -m \"fix: policy\n\nGenerated with OpenClaude\"",
        )

        expect(quoted?.behavior).toBe('ask')
        expect(exe?.behavior).toBe('ask')
        expect(quotedExe?.behavior).toBe('ask')
        expect(singleQuotedExe?.behavior).toBe('ask')
      },
    )
  })

  test('checks git commits after earlier statements', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const result = checkPowerShellCommitMessagePolicy(
          'Set-Location repo; git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )

        expectPowerShellAskMessage(result, 'Generated with')
      },
    )
  })

  test('checks git commits after PowerShell chain operators', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const result = checkPowerShellCommitMessagePolicy(
          'Write-Output ok && git commit -m "fix: policy\n\nGenerated with OpenClaude"',
        )

        expectPowerShellAskMessage(result, 'Generated with')
      },
    )
  })

  test('checks git commits after pipeline segments', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const result = checkPowerShellCommitMessagePolicy(
          'Get-Content .git/OPENCLAUDE_COMMIT_MSG | git commit --file=-',
        )

        expectPowerShellAskMessage(result, 'loaded from a file')
      },
    )
  })

  test('checks commit messages passed with long message options', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated'] } },
      checkPowerShellCommitMessagePolicy => {
        const spaced = checkPowerShellCommitMessagePolicy(
          'git commit --message "fix: policy\n\nGenerated with OpenClaude"',
        )
        const equals = checkPowerShellCommitMessagePolicy(
          'git commit --message="fix: policy\n\nGenerated with OpenClaude"',
        )
        const unquoted = checkPowerShellCommitMessagePolicy(
          'git commit --message=Generated',
        )

        expect(spaced?.behavior).toBe('ask')
        expect(equals?.behavior).toBe('ask')
        expect(unquoted?.behavior).toBe('ask')
      },
    )
  })

  test('asks for file-backed commit messages when commit-message policy is active', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const result = checkPowerShellCommitMessagePolicy(
          'git commit --file=.git/OPENCLAUDE_COMMIT_MSG',
        )

        expectPowerShellAskMessage(result, 'loaded from a file')
      },
    )
  })

  test('asks for uninspectable commit message sources when commit-message policy is active', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const editorDefault = checkPowerShellCommitMessagePolicy('git commit')
        const reuseShort = checkPowerShellCommitMessagePolicy(
          'git commit -C HEAD',
        )
        const reuseLong = checkPowerShellCommitMessagePolicy(
          'git commit --reuse-message=HEAD',
        )
        const reeditShort = checkPowerShellCommitMessagePolicy(
          'git commit -c HEAD',
        )
        const reeditLong = checkPowerShellCommitMessagePolicy(
          'git commit --reedit-message HEAD',
        )
        const editor = checkPowerShellCommitMessagePolicy(
          'git commit --amend',
        )

        expectPowerShellAskMessage(editorDefault, 'cannot be checked')
        expectPowerShellAskMessage(reuseShort, 'cannot be checked')
        expectPowerShellAskMessage(reuseLong, 'cannot be checked')
        expectPowerShellAskMessage(reeditShort, 'cannot be checked')
        expectPowerShellAskMessage(reeditLong, 'cannot be checked')
        expectPowerShellAskMessage(editor, 'cannot be checked')
      },
    )
  })

  test('asks for expandable commit messages when commit-message policy is active', async () => {
    await withProjectSettings(
      { git: { forbiddenCommitMessagePatterns: ['Generated with'] } },
      checkPowerShellCommitMessagePolicy => {
        const variable = checkPowerShellCommitMessagePolicy(
          'git commit -m "$msg"',
        )
        const subexpression = checkPowerShellCommitMessagePolicy(
          'git commit --message="$(Get-Content .git/OPENCLAUDE_COMMIT_MSG)"',
        )
        const expandableHereString = checkPowerShellCommitMessagePolicy(
          'git commit -m @"\n$msg\n"@',
        )
        const unquotedVariable = checkPowerShellCommitMessagePolicy(
          'git commit -m $msg',
        )
        const literalHereString = checkPowerShellCommitMessagePolicy(
          "git commit -m @'\nsafe literal\n'@",
        )

        expectPowerShellAskMessage(variable, 'cannot be checked')
        expectPowerShellAskMessage(subexpression, 'cannot be checked')
        expectPowerShellAskMessage(expandableHereString, 'cannot be checked')
        expectPowerShellAskMessage(unquotedVariable, 'cannot be checked')
        expect(literalHereString).toBeNull()
      },
    )
  })

  test('uses the commit-specific attribution blocker', async () => {
    await withProjectSettings(
      { git: { addGeneratedWithFooter: false } },
      checkPowerShellCommitMessagePolicy => {
        const result = checkPowerShellCommitMessagePolicy(
          'git commit -m "fix: policy\n\nCo-Authored-By: OpenClaude <openclaude@gitlawb.com>"',
        )

        expect(result).toBeNull()
      },
    )
  })
})
