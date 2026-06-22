import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { memoizeWithTTLAsync } from './memoize.js'
import {
  importOptionalRuntimeModule,
  isOptionalRuntimeModuleUnavailableError,
} from './optionalRuntimeModule.js'

const GEMINI_ADC_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const GEMINI_ADC_CACHE_TTL_MS = 5 * 60 * 1000

export type GeminiAuthMode = 'api-key' | 'access-token' | 'adc'

type GoogleAccessTokenResult =
  | string
  | null
  | undefined
  | {
      token?: string | null
    }

type GoogleAuthClientLike = {
  getAccessToken(): Promise<GoogleAccessTokenResult> | GoogleAccessTokenResult
}

type GoogleAuthLike = {
  getClient(): Promise<GoogleAuthClientLike>
  getProjectId?(): Promise<string>
}

export type GeminiResolvedCredential =
  | {
      kind: 'api-key'
      credential: string
    }
  | {
      kind: 'access-token' | 'adc'
      credential: string
      projectId?: string
    }
  | {
      kind: 'none'
    }

type ResolveGeminiCredentialDeps = {
  createGoogleAuth?: () => Promise<GoogleAuthLike>
  importOptionalRuntimeModule?: typeof importOptionalRuntimeModule
}

function sanitizeCredential(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function getGeminiProjectIdHint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    sanitizeCredential(env.GOOGLE_CLOUD_PROJECT) ??
    sanitizeCredential(env.GCLOUD_PROJECT) ??
    sanitizeCredential(env.GOOGLE_PROJECT_ID)
  )
}

export function getGeminiVertexProjectId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    sanitizeCredential(env.GEMINI_VERTEX_PROJECT) ??
    getGeminiProjectIdHint(env)
  )
}

const DEFAULT_GEMINI_VERTEX_LOCATION = 'global'
export const DEFAULT_GEMINI_VERTEX_MODEL = 'gemini-2.5-flash'

export function getGeminiVertexLocation(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return sanitizeCredential(env.GEMINI_VERTEX_LOCATION) ?? DEFAULT_GEMINI_VERTEX_LOCATION
}

export function getGeminiVertexModel(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return sanitizeCredential(env.GEMINI_VERTEX_MODEL) ?? DEFAULT_GEMINI_VERTEX_MODEL
}

export function getGeminiAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): GeminiAuthMode | undefined {
  const normalized = sanitizeCredential(env.GEMINI_AUTH_MODE)?.toLowerCase()
  if (
    normalized === 'api-key' ||
    normalized === 'access-token' ||
    normalized === 'adc'
  ) {
    return normalized
  }
  return undefined
}

/**
 * Single source of truth for the Gemini Vertex auth mode. An explicit
 * (sanitized) GEMINI_VERTEX_AUTH_MODE wins; otherwise a present access token
 * implies access-token mode, falling back to ADC. Every site that shapes Vertex
 * credentials (client, validator, doctor, profile builders) must use this so a
 * token-only or whitespace-only configuration is classified identically.
 */
export function resolveGeminiVertexAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): 'access-token' | 'adc' {
  const explicit = sanitizeCredential(env.GEMINI_VERTEX_AUTH_MODE)?.toLowerCase()
  if (explicit === 'access-token' || explicit === 'adc') {
    return explicit
  }
  return sanitizeCredential(env.GEMINI_ACCESS_TOKEN) ? 'access-token' : 'adc'
}

export function getGeminiAdcCredentialPaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS)
  const paths = new Set<string>()

  if (explicit) {
    paths.add(explicit)
  }

  paths.add(join(homedir(), '.config', 'gcloud', 'application_default_credentials.json'))

  const appData = sanitizeCredential(env.APPDATA)
  if (appData) {
    paths.add(join(appData, 'gcloud', 'application_default_credentials.json'))
  }

  return [...paths]
}

export function mayHaveGeminiAdcCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getGeminiAdcCredentialPaths(env).some(path => existsSync(path))
}

function normalizeAccessToken(
  value: GoogleAccessTokenResult,
): string | undefined {
  if (typeof value === 'string') {
    return sanitizeCredential(value)
  }
  return sanitizeCredential(value?.token)
}

async function createDefaultGoogleAuth(
  optionalRuntimeImporter: typeof importOptionalRuntimeModule =
    importOptionalRuntimeModule,
): Promise<GoogleAuthLike> {
  const { GoogleAuth } = await optionalRuntimeImporter<
    typeof import('google-auth-library')
  >('google-auth-library', 'Gemini Application Default Credentials')
  return new GoogleAuth({
    scopes: [GEMINI_ADC_SCOPE],
  }) as GoogleAuthLike
}

async function resolveGeminiAdcCredentialUncached(
  env: NodeJS.ProcessEnv,
  deps: ResolveGeminiCredentialDeps,
): Promise<Exclude<GeminiResolvedCredential, { kind: 'none' | 'api-key' | 'access-token' }> | { kind: 'none' }> {
  if (!mayHaveGeminiAdcCredentials(env)) {
    return { kind: 'none' }
  }

  try {
    const createGoogleAuth =
      deps.createGoogleAuth ??
      (() => createDefaultGoogleAuth(deps.importOptionalRuntimeModule))
    const auth = await createGoogleAuth()
    const client = await auth.getClient()
    const accessToken = normalizeAccessToken(await client.getAccessToken())
    if (!accessToken) {
      return { kind: 'none' }
    }

    const hintedProjectId = getGeminiProjectIdHint(env)
    const resolvedProjectId =
      hintedProjectId ??
      (typeof auth.getProjectId === 'function'
        ? sanitizeCredential(await auth.getProjectId().catch(() => undefined))
        : undefined)

    return {
      kind: 'adc',
      credential: accessToken,
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    }
  } catch (error) {
    if (isOptionalRuntimeModuleUnavailableError(error)) {
      throw error
    }
    return { kind: 'none' }
  }
}

const resolveDefaultGeminiAdcCredential = memoizeWithTTLAsync(
  async (
    googleApplicationCredentials: string | undefined,
    appData: string | undefined,
    home: string,
    projectIdHint: string | undefined,
  ) =>
    resolveGeminiAdcCredentialUncached(
      {
        GOOGLE_APPLICATION_CREDENTIALS: googleApplicationCredentials,
        APPDATA: appData,
        GOOGLE_CLOUD_PROJECT: projectIdHint,
        GCLOUD_PROJECT: projectIdHint,
        GOOGLE_PROJECT_ID: projectIdHint,
        HOME: home,
      } as NodeJS.ProcessEnv,
      {},
    ),
  GEMINI_ADC_CACHE_TTL_MS,
)

export async function resolveGeminiCredential(
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveGeminiCredentialDeps = {},
): Promise<GeminiResolvedCredential> {
  const authMode = getGeminiAuthMode(env)
  const apiKey =
    authMode === 'access-token' || authMode === 'adc'
      ? undefined
      : sanitizeCredential(env.GEMINI_API_KEY) ??
        sanitizeCredential(env.GOOGLE_API_KEY)
  if (apiKey && (authMode === undefined || authMode === 'api-key')) {
    return {
      kind: 'api-key',
      credential: apiKey,
    }
  }

  const accessToken =
    authMode === 'api-key' || authMode === 'adc'
      ? undefined
      : sanitizeCredential(env.GEMINI_ACCESS_TOKEN)
  if (accessToken && (authMode === undefined || authMode === 'access-token')) {
    const projectId = getGeminiProjectIdHint(env)
    return {
      kind: 'access-token',
      credential: accessToken,
      ...(projectId ? { projectId } : {}),
    }
  }

  if (authMode === 'api-key' || authMode === 'access-token') {
    return { kind: 'none' }
  }

  if (deps.createGoogleAuth || deps.importOptionalRuntimeModule) {
    return resolveGeminiAdcCredentialUncached(env, deps)
  }

  return resolveDefaultGeminiAdcCredential(
    sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS),
    sanitizeCredential(env.APPDATA),
    homedir(),
    getGeminiProjectIdHint(env),
  )
}
