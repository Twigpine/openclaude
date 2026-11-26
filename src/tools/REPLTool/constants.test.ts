import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getGlobalConfig,
  hasAcknowledgedCodeMode,
  markCodeModeAcknowledged,
  saveGlobalConfig,
} from '../../utils/config.js'
import {
  CODE_MODE_ENV_VAR,
  CODE_MODE_STARTUP_NOTICE,
  isReplModeEnabled,
  resolveCodeModeActivationAfterConsent,
  resolveCodeModeEnablement,
  setReplModeEnabledForSession,
  shouldShowCodeModeConsent,
} from './constants.js'

beforeEach(async () => {
  await acquireSharedMutationLock('tools/REPLTool/constants.test.ts')
})

afterEach(() => {
  try {
    setReplModeEnabledForSession(false)
    delete process.env[CODE_MODE_ENV_VAR]
  } finally {
    releaseSharedMutationLock()
  }
})

function resolveCli(originalProcessEnv: Record<string, string | undefined> = {}, userSettingsEnv: Record<string, string | undefined> = {}): boolean {
  return resolveCodeModeEnablement({
    originalProcessEnv,
    userSettingsEnv,
    isInteractive: true,
    entrypoint: 'cli',
  })
}

describe('Code Mode source-aware enablement', () => {
  test('is off by default for interactive CLI sessions', () => {
    expect(resolveCli()).toBe(false)
    expect(isReplModeEnabled()).toBe(false)
  })

  test('startup notice discloses experimental status and the resume constraint', () => {
    expect(CODE_MODE_STARTUP_NOTICE).toContain('Experimental Code Mode is active')
    expect(CODE_MODE_STARTUP_NOTICE).toContain('resumed only')
    expect(CODE_MODE_STARTUP_NOTICE).toContain(CODE_MODE_ENV_VAR)
  })

  test('original process env truthy activates the interactive CLI', () => {
    expect(resolveCli({ [CODE_MODE_ENV_VAR]: '1' })).toBe(true)
    expect(resolveCli({ [CODE_MODE_ENV_VAR]: 'true' })).toBe(true)
  })

  test('trusted user settings env truthy activates the interactive CLI', () => {
    expect(resolveCli({}, { [CODE_MODE_ENV_VAR]: '1' })).toBe(true)
  })

  test('explicit falsy in either accepted source wins over truthy elsewhere', () => {
    expect(resolveCli(
      { [CODE_MODE_ENV_VAR]: '1' },
      { [CODE_MODE_ENV_VAR]: '0' },
    )).toBe(false)
    expect(resolveCli(
      { [CODE_MODE_ENV_VAR]: 'false' },
      { [CODE_MODE_ENV_VAR]: '1' },
    )).toBe(false)
  })

  test('print, SDK, MCP, and non-interactive entrypoints remain direct-tool sessions', () => {
    for (const entrypoint of ['sdk-cli', 'sdk-ts', 'sdk-py', 'mcp']) {
      expect(resolveCodeModeEnablement({
        originalProcessEnv: { [CODE_MODE_ENV_VAR]: '1' },
        userSettingsEnv: {},
        isInteractive: false,
        entrypoint,
      })).toBe(false)
    }
    expect(resolveCodeModeEnablement({
      originalProcessEnv: { [CODE_MODE_ENV_VAR]: '1' },
      userSettingsEnv: {},
      isInteractive: false,
      entrypoint: 'cli',
    })).toBe(false)
  })

  test('non-CLI entrypoints stay inactive even when they allocate a TTY', () => {
    for (const entrypoint of [
      'sdk-typescript',
      'sdk-python',
      'sdk-cli',
      'claude-vscode',
      'claude-desktop',
      'local-agent',
      'remote',
      'mcp',
    ]) {
      expect(resolveCodeModeEnablement({
        originalProcessEnv: { [CODE_MODE_ENV_VAR]: '1' },
        userSettingsEnv: {},
        isInteractive: true,
        entrypoint,
      })).toBe(false)
    }
  })

  test('legacy REPL variables and USER_TYPE=ant do not enable Code Mode', () => {
    expect(resolveCli({
      CLAUDE_CODE_REPL: '1',
      CLAUDE_REPL_MODE: '1',
      USER_TYPE: 'ant',
    })).toBe(false)
    expect(resolveCli({
      [CODE_MODE_ENV_VAR]: '1',
      CLAUDE_CODE_REPL: '0',
      CLAUDE_REPL_MODE: '0',
      USER_TYPE: 'ant',
    })).toBe(true)
  })

  test('later process.env mutation does not toggle the resolved session mode', () => {
    setReplModeEnabledForSession(true)
    process.env[CODE_MODE_ENV_VAR] = '0'
    expect(isReplModeEnabled()).toBe(true)

    setReplModeEnabledForSession(false)
    process.env[CODE_MODE_ENV_VAR] = '1'
    expect(isReplModeEnabled()).toBe(false)
  })

  test('refusal leaves Code Mode inactive and unacknowledged', () => {
    const enabled = resolveCli({ [CODE_MODE_ENV_VAR]: '1' })
    expect(shouldShowCodeModeConsent(enabled, false)).toBe(true)
    expect(resolveCodeModeActivationAfterConsent({
      enablement: enabled,
      hasAcknowledged: false,
      consentAccepted: false,
    })).toBe(false)
  })

  test('accepted acknowledgement activates only for the affirmative consent outcome', () => {
    expect(resolveCodeModeActivationAfterConsent({
      enablement: true,
      hasAcknowledged: false,
      consentAccepted: true,
    })).toBe(true)
    expect(resolveCodeModeActivationAfterConsent({
      enablement: true,
      hasAcknowledged: false,
    })).toBe(false)
    expect(shouldShowCodeModeConsent(true, true)).toBe(false)
    expect(resolveCodeModeActivationAfterConsent({
      enablement: true,
      hasAcknowledged: true,
    })).toBe(true)
  })
})

describe('Code Mode first-use acknowledgement config', () => {
  test('persists acknowledgement in global config', () => {
    const original = getGlobalConfig().hasAcknowledgedCodeMode
    try {
      saveGlobalConfig(current => ({
        ...current,
        hasAcknowledgedCodeMode: undefined,
      }))
      expect(hasAcknowledgedCodeMode()).toBe(false)

      markCodeModeAcknowledged()

      expect(getGlobalConfig().hasAcknowledgedCodeMode).toBe(true)
      expect(hasAcknowledgedCodeMode()).toBe(true)
    } finally {
      saveGlobalConfig(current => ({
        ...current,
        hasAcknowledgedCodeMode: original,
      }))
    }
  })
})
