import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  getGeminiProjectIdHint,
  getGeminiVertexLocation,
  getGeminiVertexModel,
  getGeminiVertexProjectId,
  mayHaveGeminiAdcCredentials,
  resolveGeminiCredential,
  resolveGeminiVertexAuthMode,
} from './geminiAuth.ts'

const existingFilePath = import.meta.path

const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GEMINI_ACCESS_TOKEN: process.env.GEMINI_ACCESS_TOKEN,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
  GOOGLE_PROJECT_ID: process.env.GOOGLE_PROJECT_ID,
  APPDATA: process.env.APPDATA,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/geminiAuth.test.ts')
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  delete process.env.GEMINI_ACCESS_TOKEN
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS
  delete process.env.GOOGLE_CLOUD_PROJECT
  delete process.env.GCLOUD_PROJECT
  delete process.env.GOOGLE_PROJECT_ID
})

afterEach(() => {
  try {
    restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
    restoreEnv('GOOGLE_API_KEY', originalEnv.GOOGLE_API_KEY)
    restoreEnv('GEMINI_ACCESS_TOKEN', originalEnv.GEMINI_ACCESS_TOKEN)
    restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
    restoreEnv(
      'GOOGLE_APPLICATION_CREDENTIALS',
      originalEnv.GOOGLE_APPLICATION_CREDENTIALS,
    )
    restoreEnv('GOOGLE_CLOUD_PROJECT', originalEnv.GOOGLE_CLOUD_PROJECT)
    restoreEnv('GCLOUD_PROJECT', originalEnv.GCLOUD_PROJECT)
    restoreEnv('GOOGLE_PROJECT_ID', originalEnv.GOOGLE_PROJECT_ID)
    restoreEnv('APPDATA', originalEnv.APPDATA)
  } finally {
    releaseSharedMutationLock()
  }
})

describe('resolveGeminiCredential', () => {
  test('prefers GEMINI_API_KEY over other Gemini auth inputs', async () => {
    process.env.GEMINI_API_KEY = 'gem-key'
    process.env.GOOGLE_API_KEY = 'google-key'
    process.env.GEMINI_ACCESS_TOKEN = 'token-123'

    await expect(resolveGeminiCredential(process.env)).resolves.toEqual({
      kind: 'api-key',
      credential: 'gem-key',
    })
  })

  test('uses GEMINI_ACCESS_TOKEN when no API key is configured', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    process.env.GEMINI_AUTH_MODE = 'access-token'
    process.env.GEMINI_ACCESS_TOKEN = 'token-123'
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project'

    await expect(resolveGeminiCredential(process.env)).resolves.toEqual({
      kind: 'access-token',
      credential: 'token-123',
      projectId: 'test-project',
    })
  })

  test('falls back to ADC when available', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    delete process.env.GEMINI_ACCESS_TOKEN
    process.env.GEMINI_AUTH_MODE = 'adc'
    process.env.GOOGLE_APPLICATION_CREDENTIALS = existingFilePath

    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
      async getProjectId() {
        return 'adc-project'
      },
    }

    await expect(
      resolveGeminiCredential(process.env, {
        createGoogleAuth: async () => fakeAuth,
      }),
    ).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
    })
  })

  test('returns none when no Gemini auth source is configured', async () => {
    const spy = spyOn(fs, 'existsSync').mockReturnValue(false)
    try {
      delete process.env.GEMINI_API_KEY
      delete process.env.GOOGLE_API_KEY
      delete process.env.GEMINI_ACCESS_TOKEN
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS

      await expect(
        resolveGeminiCredential(process.env, {
          createGoogleAuth: async () => {
            throw new Error('unexpected ADC lookup')
          },
        }),
      ).resolves.toEqual({
        kind: 'none',
      })
    } finally {
      spy.mockRestore()
    }
  })

  test('access-token mode does not silently fall back to ADC', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    delete process.env.GEMINI_ACCESS_TOKEN
    process.env.GEMINI_AUTH_MODE = 'access-token'
    process.env.GOOGLE_APPLICATION_CREDENTIALS = existingFilePath

    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
    }

    await expect(
      resolveGeminiCredential(process.env, {
        createGoogleAuth: async () => fakeAuth,
      }),
    ).resolves.toEqual({
      kind: 'none',
    })
  })

  test('adc mode ignores GEMINI_ACCESS_TOKEN and uses ADC credentials', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    process.env.GEMINI_AUTH_MODE = 'adc'
    process.env.GEMINI_ACCESS_TOKEN = 'token-123'
    process.env.GOOGLE_APPLICATION_CREDENTIALS = existingFilePath

    const fakeAuth = {
      async getClient() {
        return {
          async getAccessToken() {
            return { token: 'adc-token' }
          },
        }
      },
      async getProjectId() {
        return 'adc-project'
      },
    }

    await expect(
      resolveGeminiCredential(process.env, {
        createGoogleAuth: async () => fakeAuth,
      }),
    ).resolves.toEqual({
      kind: 'adc',
      credential: 'adc-token',
      projectId: 'adc-project',
    })
  })
})

describe('Gemini auth helpers', () => {
  test('defaults Vertex to global endpoint and current flash model', () => {
    expect(getGeminiVertexLocation({})).toBe('global')
    expect(getGeminiVertexModel({})).toBe('gemini-2.5-flash')
  })

  test('explicit GEMINI_VERTEX_* overrides win over defaults and Google fallbacks', () => {
    // Location and model: explicit override beats the default.
    expect(
      getGeminiVertexLocation({ GEMINI_VERTEX_LOCATION: 'europe-west4' }),
    ).toBe('europe-west4')
    expect(
      getGeminiVertexModel({ GEMINI_VERTEX_MODEL: 'gemini-2.5-pro' }),
    ).toBe('gemini-2.5-pro')

    // Project precedence: GEMINI_VERTEX_PROJECT > GOOGLE_CLOUD_PROJECT >
    // GCLOUD_PROJECT > GOOGLE_PROJECT_ID.
    expect(
      getGeminiVertexProjectId({
        GEMINI_VERTEX_PROJECT: 'vertex-project',
        GOOGLE_CLOUD_PROJECT: 'gcp-project',
        GCLOUD_PROJECT: 'gcloud-project',
        GOOGLE_PROJECT_ID: 'legacy-project',
      }),
    ).toBe('vertex-project')
    expect(
      getGeminiVertexProjectId({
        GOOGLE_CLOUD_PROJECT: 'gcp-project',
        GCLOUD_PROJECT: 'gcloud-project',
      }),
    ).toBe('gcp-project')
    expect(getGeminiVertexProjectId({ GCLOUD_PROJECT: 'gcloud-project' })).toBe(
      'gcloud-project',
    )

    // Leading/trailing whitespace is trimmed from real values.
    expect(
      getGeminiVertexLocation({ GEMINI_VERTEX_LOCATION: '  europe-west4  ' }),
    ).toBe('europe-west4')
    expect(
      getGeminiVertexProjectId({ GEMINI_VERTEX_PROJECT: '  vertex-project  ' }),
    ).toBe('vertex-project')

    // Blank / whitespace-only values are treated as unset, not as overrides.
    expect(getGeminiVertexLocation({ GEMINI_VERTEX_LOCATION: '  ' })).toBe('global')
    expect(
      getGeminiVertexProjectId({
        GEMINI_VERTEX_PROJECT: '',
        GOOGLE_PROJECT_ID: 'legacy-project',
      }),
    ).toBe('legacy-project')
  })

  test('detects explicit project id hints', () => {
    process.env.GOOGLE_PROJECT_ID = 'project-a'
    expect(getGeminiProjectIdHint(process.env)).toBe('project-a')
  })

  test('only treats existing ADC paths as valid hints', () => {
    const spy = spyOn(fs, 'existsSync').mockImplementation(
      (path: fs.PathLike) => {
        return path === existingFilePath
      },
    )

    try {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = existingFilePath
      expect(mayHaveGeminiAdcCredentials(process.env)).toBe(true)

      process.env.GOOGLE_APPLICATION_CREDENTIALS = `${existingFilePath}.missing`
      delete process.env.APPDATA
      expect(mayHaveGeminiAdcCredentials(process.env)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveGeminiVertexAuthMode', () => {
  test('honours an explicit (case/space-normalized) GEMINI_VERTEX_AUTH_MODE', () => {
    expect(
      resolveGeminiVertexAuthMode({ GEMINI_VERTEX_AUTH_MODE: '  Access-Token ' } as NodeJS.ProcessEnv),
    ).toBe('access-token')
    expect(
      resolveGeminiVertexAuthMode({ GEMINI_VERTEX_AUTH_MODE: 'adc' } as NodeJS.ProcessEnv),
    ).toBe('adc')
  })

  test('infers access-token from a present token when the mode is unset', () => {
    expect(
      resolveGeminiVertexAuthMode({ GEMINI_ACCESS_TOKEN: 'ya29.tok' } as NodeJS.ProcessEnv),
    ).toBe('access-token')
  })

  test('defaults to adc for empty/whitespace token or invalid mode', () => {
    expect(resolveGeminiVertexAuthMode({} as NodeJS.ProcessEnv)).toBe('adc')
    expect(
      resolveGeminiVertexAuthMode({ GEMINI_ACCESS_TOKEN: '   ' } as NodeJS.ProcessEnv),
    ).toBe('adc')
    expect(
      resolveGeminiVertexAuthMode({ GEMINI_VERTEX_AUTH_MODE: 'bogus' } as NodeJS.ProcessEnv),
    ).toBe('adc')
  })
})
