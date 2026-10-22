import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { PermissionRule } from '../../utils/permissions/PermissionRule.js'
import * as settingsModule from '../../utils/settings/settings.js'
import * as permissionsLoader from '../../utils/permissions/permissionsLoader.js'
import type { SettingsJson } from '../../utils/settings/types.js'

const REAL_canonicalPath = settingsModule.getRelativeSettingsFilePathForSource

// TrustDialog/utils.ts emits file-path strings shown to users in the trust
// dialog. These MUST come from getRelativeSettingsFilePathForSource — the
// single source of truth — not hardcoded literals. The previous code hardcoded
// '.claude/...' and drifted from the canonical '.openclaude/...'.
//
// This is a TRUE contract test with TWO independent assertions:
//   1. The real getRelativeSettingsFilePathForSource returns the EXPECTED
//      literal '.openclaude/...' (catches a settings.ts regression).
//   2. utils.ts getters return the same value as the real function (catches
//      a utils.ts hardcoding regression).
// The EXPECTED literal is hardcoded HERE and only here — if settings.ts drifts
// away from it, assertion (1) fails; if utils.ts stops using the function,
// assertion (2) fails. No self-reference.

await acquireSharedMutationLock('components/TrustDialog/utils.test.ts')

// The fork's canonical project settings paths. Hardcoded expected values —
// independent of the implementation under test.
const EXPECTED = {
  projectSettings: '.openclaude/settings.json',
  localSettings: '.openclaude/settings.local.json',
} as const

// Contract assertion (1): the real source-of-truth function must return these.
// Wrapped in a named test so a settings.ts regression shows up as a clear
// test failure in CI rather than a module-load error.
test('getRelativeSettingsFilePathForSource returns the canonical .openclaude/ paths', () => {
  expect(REAL_canonicalPath('projectSettings')).toBe(EXPECTED.projectSettings)
  expect(REAL_canonicalPath('localSettings')).toBe(EXPECTED.localSettings)
})

const settingsState: {
  projectSettings: SettingsJson | null
  localSettings: SettingsJson | null
} = {
  projectSettings: null,
  localSettings: null,
}

const permissionRulesState: {
  projectSettings: PermissionRule[]
  localSettings: PermissionRule[]
} = {
  projectSettings: [],
  localSettings: [],
}

const settingsSpy = spyOn(settingsModule, 'getSettingsForSource').mockImplementation(
  source => settingsState[source as keyof typeof settingsState],
)
const permissionRulesSpy = spyOn(permissionsLoader, 'getPermissionRulesForSource').mockImplementation(
  source => permissionRulesState[source as keyof typeof permissionRulesState],
)

afterAll(() => {
  try {
    settingsSpy.mockRestore()
    permissionRulesSpy.mockRestore()
  } finally {
    releaseSharedMutationLock()
  }
})

beforeEach(() => {
  settingsState.projectSettings = null
  settingsState.localSettings = null
  permissionRulesState.projectSettings = []
  permissionRulesState.localSettings = []
})

async function freshUtils() {
  const stamp = `${Date.now()}-${Math.random()}`
  return import(`./utils.ts?ts=${stamp}`)
}

const bashAllow = (
  source: PermissionRule['source'],
  toolName: string = BASH_TOOL_NAME,
): PermissionRule => ({
  source,
  ruleBehavior: 'allow',
  ruleValue: { toolName },
})

// Helper: build a SettingsJson with only the fields we care about.
const settings = (overrides: Partial<SettingsJson>): SettingsJson =>
  ({ ...overrides }) as unknown as SettingsJson

describe('TrustDialog utils — canonical paths from source-of-truth', () => {
  describe('getHooksSources', () => {
    test('reports canonical paths when hooks present in both sources', async () => {
      settingsState.projectSettings = settings({
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] }],
        },
      })
      settingsState.localSettings = settings({
        statusLine: { type: 'command', command: 'echo hi' },
      })

      const { getHooksSources } = await freshUtils()
      expect(getHooksSources().sort()).toEqual([
        EXPECTED.projectSettings,
        EXPECTED.localSettings,
      ])
    })

    test('reports only project when local has no hooks', async () => {
      settingsState.projectSettings = settings({
        hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'true' }] }] },
      })
      settingsState.localSettings = settings({})

      const { getHooksSources } = await freshUtils()
      expect(getHooksSources()).toEqual([EXPECTED.projectSettings])
    })

    test('empty hooks object does not count as having hooks', async () => {
      settingsState.projectSettings = settings({ hooks: {} })
      const { getHooksSources } = await freshUtils()
      expect(getHooksSources()).toEqual([])
    })

    test('hooks with empty matcher arrays do not count', async () => {
      settingsState.projectSettings = settings({
        hooks: { PreToolUse: [] },
      })
      const { getHooksSources } = await freshUtils()
      expect(getHooksSources()).toEqual([])
    })

    test('fileSuggestion alone counts as a hook source', async () => {
      settingsState.projectSettings = settings({
        fileSuggestion: { enabled: true } as unknown as SettingsJson['fileSuggestion'],
      })
      const { getHooksSources } = await freshUtils()
      expect(getHooksSources()).toEqual([EXPECTED.projectSettings])
    })

    test('disableAllHooks suppresses even when hooks are configured', async () => {
      settingsState.projectSettings = settings({
        disableAllHooks: true,
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] }],
        },
        statusLine: { type: 'command', command: 'echo hi' },
      })
      const { getHooksSources } = await freshUtils()
      expect(getHooksSources()).toEqual([])
    })

    test('null settings produce no sources', async () => {
      const { getHooksSources } = await freshUtils()
      expect(getHooksSources()).toEqual([])
    })

    test('non-null settings with no hooks/statusLine/fileSuggestion produce no sources', async () => {
      // Covers the `if (!settings.hooks) return false` branch — distinct from
      // the null-settings branch above. Settings exist but have nothing that
      // counts as a hook source.
      settingsState.projectSettings = settings({ model: 'claude-3' })
      const { getHooksSources } = await freshUtils()
      expect(getHooksSources()).toEqual([])
    })
  })

  describe('getBashPermissionSources', () => {
    test('reports canonical paths when bash allow rules in both sources', async () => {
      permissionRulesState.projectSettings = [bashAllow('projectSettings')]
      permissionRulesState.localSettings = [
        bashAllow('localSettings', `${BASH_TOOL_NAME}(npm test)`),
      ]

      const { getBashPermissionSources } = await freshUtils()
      expect(getBashPermissionSources().sort()).toEqual([
        EXPECTED.projectSettings,
        EXPECTED.localSettings,
      ])
    })

    test('toolName prefix match (Bash(...)) counts as bash permission', async () => {
      permissionRulesState.localSettings = [
        bashAllow('localSettings', `${BASH_TOOL_NAME}(rm -rf /)`),
      ]
      const { getBashPermissionSources } = await freshUtils()
      expect(getBashPermissionSources()).toEqual([EXPECTED.localSettings])
    })

    test('non-Bash tool allow rule does NOT count', async () => {
      permissionRulesState.projectSettings = [bashAllow('projectSettings', 'Read')]
      const { getBashPermissionSources } = await freshUtils()
      expect(getBashPermissionSources()).toEqual([])
    })

    test('deny behavior does NOT count even for Bash', async () => {
      permissionRulesState.projectSettings = [
        { ...bashAllow('projectSettings'), ruleBehavior: 'deny' },
      ]
      const { getBashPermissionSources } = await freshUtils()
      expect(getBashPermissionSources()).toEqual([])
    })

    test('empty rules produce no sources', async () => {
      const { getBashPermissionSources } = await freshUtils()
      expect(getBashPermissionSources()).toEqual([])
    })
  })

  // Cover the remaining getters — each should emit canonical paths when its
  // trigger field is present, and nothing otherwise.
  describe('remaining getters — canonical path coverage', () => {
    test('getOtelHeadersHelperSources', async () => {
      const { getOtelHeadersHelperSources } = await freshUtils()
      expect(getOtelHeadersHelperSources()).toEqual([])

      settingsState.projectSettings = settings({
        otelHeadersHelper: 'cat /tmp/headers',
      } as Partial<SettingsJson>)
      expect(getOtelHeadersHelperSources()).toEqual([EXPECTED.projectSettings])
    })

    test('getApiKeyHelperSources', async () => {
      const { getApiKeyHelperSources } = await freshUtils()
      expect(getApiKeyHelperSources()).toEqual([])

      settingsState.localSettings = settings({
        apiKeyHelper: '/usr/local/bin/token-helper',
      } as Partial<SettingsJson>)
      expect(getApiKeyHelperSources()).toEqual([EXPECTED.localSettings])
    })

    test('getAwsCommandsSources', async () => {
      const { getAwsCommandsSources } = await freshUtils()
      expect(getAwsCommandsSources()).toEqual([])

      settingsState.projectSettings = settings({
        awsAuthRefresh: 'aws sso login',
      } as Partial<SettingsJson>)
      expect(getAwsCommandsSources()).toEqual([EXPECTED.projectSettings])
    })

    test('getAwsCommandsSources — awsCredentialExport alone also triggers', async () => {
      // hasAwsCommands is an OR of awsAuthRefresh || awsCredentialExport.
      // Cover the second operand so a regression that drops it is caught.
      settingsState.localSettings = settings({
        awsCredentialExport: 'export AWS_CREDENTIALS=$CREDS',
      } as unknown as Partial<SettingsJson>)
      const { getAwsCommandsSources } = await freshUtils()
      expect(getAwsCommandsSources()).toEqual([EXPECTED.localSettings])
    })

    test('getGcpCommandsSources', async () => {
      const { getGcpCommandsSources } = await freshUtils()
      expect(getGcpCommandsSources()).toEqual([])

      settingsState.localSettings = settings({
        gcpAuthRefresh: 'gcloud auth print-access-token',
      } as Partial<SettingsJson>)
      expect(getGcpCommandsSources()).toEqual([EXPECTED.localSettings])
    })

    test('getDangerousEnvVarsSources — dangerous var present', async () => {
      const { getDangerousEnvVarsSources } = await freshUtils()
      expect(getDangerousEnvVarsSources()).toEqual([])

      // Most env vars are unsafe by design; pick one not in SAFE_ENV_VARS.
      settingsState.projectSettings = settings({ env: { SUPER_SECRET_TOKEN: 'x' } })
      expect(getDangerousEnvVarsSources()).toEqual([EXPECTED.projectSettings])
    })

    test('getDangerousEnvVarsSources — only safe vars produces nothing', async () => {
      // AWS_REGION is in SAFE_ENV_VARS; must not trigger the warning.
      settingsState.projectSettings = settings({ env: { AWS_REGION: 'us-east-1' } })
      const { getDangerousEnvVarsSources } = await freshUtils()
      expect(getDangerousEnvVarsSources()).toEqual([])
    })
  })
})
