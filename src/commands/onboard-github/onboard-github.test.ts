import { describe, expect, test } from 'bun:test'

import {
  activateGithubOnboardingMode,
  applyGithubOnboardingProcessEnv,
  buildGithubOnboardingSettingsEnv,
  getExistingGithubEnterpriseUrl,
  hasExistingGithubModelsLoginToken,
  normalizeGithubEnterpriseInputUrl,
  shouldForceGithubRelogin,
} from './onboard-github.js'

describe('shouldForceGithubRelogin', () => {
  test.each(['force', '--force', 'relogin', '--relogin', 'reauth', '--reauth'])(
    'treats %s as force re-login',
    arg => {
      expect(shouldForceGithubRelogin(arg)).toBe(true)
    },
  )

  test('returns false for empty or unknown args', () => {
    expect(shouldForceGithubRelogin('')).toBe(false)
    expect(shouldForceGithubRelogin(undefined)).toBe(false)
    expect(shouldForceGithubRelogin('something-else')).toBe(false)
  })

  test('treats force flags as present in multi-word args', () => {
    expect(shouldForceGithubRelogin('--force extra')).toBe(true)
    expect(shouldForceGithubRelogin('foo --relogin bar')).toBe(true)
    expect(shouldForceGithubRelogin('abc reauth xyz')).toBe(true)
  })
})

describe('hasExistingGithubModelsLoginToken', () => {
  test('returns true when GITHUB_TOKEN is present', () => {
    expect(
      hasExistingGithubModelsLoginToken({ GITHUB_TOKEN: 'token' }, ''),
    ).toBe(true)
  })

  test('returns true when GH_TOKEN is present', () => {
    expect(
      hasExistingGithubModelsLoginToken({ GH_TOKEN: 'token' }, ''),
    ).toBe(true)
  })

  test('returns true when stored token exists', () => {
    expect(hasExistingGithubModelsLoginToken({}, 'stored-token')).toBe(true)
  })

  test('returns false when both env and stored token are missing', () => {
    expect(hasExistingGithubModelsLoginToken({}, '')).toBe(false)
  })
})

describe('onboarding auth precedence cleanup', () => {
  test('normalizes Enterprise input URL to the instance origin', () => {
    expect(
      normalizeGithubEnterpriseInputUrl(
        'https://github.mycompany.com/api/copilot/',
      ),
    ).toBe('https://github.mycompany.com')
  })

  test('rejects invalid Enterprise input URL', () => {
    expect(() => normalizeGithubEnterpriseInputUrl('not-a-url')).toThrow()
  })

  test('reads existing Enterprise URL from env or user settings', () => {
    expect(
      getExistingGithubEnterpriseUrl(
        { GITHUB_ENTERPRISE_URL: ' https://github.env.example.com/path ' },
        { GITHUB_ENTERPRISE_URL: 'https://github.settings.example.com' },
      ),
    ).toBe('https://github.env.example.com')

    expect(
      getExistingGithubEnterpriseUrl(
        { GITHUB_ENTERPRISE_URL: 'undefined' },
        { GITHUB_ENTERPRISE_URL: 'https://github.settings.example.com/api' },
      ),
    ).toBe('https://github.settings.example.com')
  })

  test('clears preexisting OpenAI auth when switching to GitHub', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEYS: 'sk-stale-pool-a,sk-stale-pool-b',
      OPENAI_API_KEY: 'sk-stale-openai-key',
      OPENAI_ORG: 'org-old',
      OPENAI_PROJECT: 'project-old',
      OPENAI_ORGANIZATION: 'org-legacy',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_BASE: 'https://api.openai.com/v1',
      GITHUB_COPILOT_KEY: 'stale-copilot-key',
      GITHUB_ENTERPRISE_URL: 'https://github.old.example.com',
      CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: '1',
      CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: 'profile_old',
      CLAUDE_CODE_USE_GEMINI_VERTEX: '1',
    }

    applyGithubOnboardingProcessEnv('github:copilot', undefined, env)

    expect(env.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(env.OPENAI_MODEL).toBe('github:copilot')

    expect(env.OPENAI_API_KEYS).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OPENAI_ORG).toBeUndefined()
    expect(env.OPENAI_PROJECT).toBeUndefined()
    expect(env.OPENAI_ORGANIZATION).toBeUndefined()
    expect(env.OPENAI_BASE_URL).toBeUndefined()
    expect(env.OPENAI_API_BASE).toBeUndefined()
    expect(env.GITHUB_COPILOT_KEY).toBeUndefined()
    expect(env.GITHUB_ENTERPRISE_URL).toBeUndefined()

    expect(env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    // The fast path must clear Gemini Vertex routing too, like the
    // device-flow finalize path (PROVIDER_SPECIFIC_KEYS).
    expect(env.CLAUDE_CODE_USE_GEMINI_VERTEX).toBeUndefined()
    expect(env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED).toBeUndefined()
    expect(env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBeUndefined()

    const settingsEnv = buildGithubOnboardingSettingsEnv('github:copilot')
    expect(settingsEnv.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(settingsEnv.OPENAI_MODEL).toBe('github:copilot')
    expect(settingsEnv.OPENAI_API_KEYS).toBeUndefined()
    expect(settingsEnv.OPENAI_API_KEY).toBeUndefined()
    expect(settingsEnv.OPENAI_ORG).toBeUndefined()
    expect(settingsEnv.OPENAI_PROJECT).toBeUndefined()
    expect(settingsEnv.OPENAI_ORGANIZATION).toBeUndefined()
    expect(settingsEnv.GITHUB_ENTERPRISE_URL).toBeUndefined()
    expect(settingsEnv.CLAUDE_CODE_USE_GEMINI_VERTEX).toBeUndefined()
  })

  test('persists Enterprise URL when switching to GitHub Enterprise', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      GITHUB_ENTERPRISE_URL: 'https://github.old.example.com',
    }

    applyGithubOnboardingProcessEnv(
      'github:copilot',
      'https://github.mycompany.com',
      env,
    )

    expect(env.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(env.GITHUB_ENTERPRISE_URL).toBe('https://github.mycompany.com')

    const settingsEnv = buildGithubOnboardingSettingsEnv(
      'github:copilot',
      'https://github.mycompany.com',
    )
    expect(settingsEnv.GITHUB_ENTERPRISE_URL).toBe(
      'https://github.mycompany.com',
    )
  })
})

describe('activateGithubOnboardingMode', () => {
  test('activates settings/env/hydration in order when merge succeeds', () => {
    const calls: string[] = []

    const result = activateGithubOnboardingMode('  github:copilot  ', {
      gheUrl: 'https://github.mycompany.com',
      mergeSettingsEnv: (model, gheUrl) => {
        calls.push(`merge:${model}:${gheUrl}`)
        return { ok: true }
      },
      applyProcessEnv: (model, gheUrl) => {
        calls.push(`apply:${model}:${gheUrl}`)
      },
      hydrateToken: () => {
        calls.push('hydrate')
      },
      onChangeAPIKey: () => {
        calls.push('onChangeAPIKey')
      },
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([
      'merge:github:copilot:https://github.mycompany.com',
      'apply:github:copilot:https://github.mycompany.com',
      'hydrate',
      'onChangeAPIKey',
    ])
  })

  test('stops activation when settings merge fails', () => {
    const calls: string[] = []

    const result = activateGithubOnboardingMode(DEFAULT_MODEL_FOR_TESTS, {
      mergeSettingsEnv: () => {
        calls.push('merge')
        return { ok: false, detail: 'settings write failed' }
      },
      applyProcessEnv: () => {
        calls.push('apply')
      },
      hydrateToken: () => {
        calls.push('hydrate')
      },
      onChangeAPIKey: () => {
        calls.push('onChangeAPIKey')
      },
    })

    expect(result).toEqual({ ok: false, detail: 'settings write failed' })
    expect(calls).toEqual(['merge'])
  })
})

const DEFAULT_MODEL_FOR_TESTS = 'github:copilot'
