import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { memoizeWithTTLAsync } from './memoize.js'
import { redactSecretValueForDisplay } from './providerSecrets.js'
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
  // Native Vertex promises the full ADC chain; direct Gemini keeps its
  // existing file-presence policy to avoid ambient discovery during inference.
  allowAmbientAdc?: boolean
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

// These values are URI components, not endpoint overrides. Keep project
// numbers and legacy domain:project IDs, and bare/versioned model IDs, while
// preventing a field from changing the authenticated host or resource path.
export function getGeminiVertexEndpointError(options: {
  project?: string
  location?: string
  model?: string
}): string | null {
  if (options.location !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.location)) {
    return 'Invalid GEMINI_VERTEX_LOCATION: use global or a Google Cloud region name, not an endpoint URL.'
  }
  if (options.project !== undefined && !/^[a-z0-9][a-z0-9.:-]*$/i.test(options.project)) {
    return 'Invalid GEMINI_VERTEX_PROJECT: use a project ID, number or domain-scoped ID without URL delimiters.'
  }
  if (options.model !== undefined && !/^[a-z0-9][a-z0-9._:@+-]*$/i.test(options.model)) {
    return 'Invalid GEMINI_VERTEX_MODEL: use a bare model ID without URL path, query or fragment syntax.'
  }
  return null
}

// Models Vertex only serves from the global endpoint. Pairing one with a
// regional GEMINI_VERTEX_LOCATION would build a regional URL the model is not
// available on, so the client validates this before issuing the request. The
// catalog (integrations/vendors/gemini-vertex.ts) documents which models are
// global-only; keep the two in sync.
const GLOBAL_ONLY_VERTEX_MODELS = new Set(['gemini-3.5-flash'])

export function isGlobalOnlyVertexModel(model: string | undefined): boolean {
  return model !== undefined && GLOBAL_ONLY_VERTEX_MODELS.has(model.trim())
}

/**
 * The native client and startup validator share this rule. A
 * global-only model on a regional location builds a URL Vertex will not serve.
 * Returns the same message the client throws, or null when the pair is valid.
 * Location defaults the same way as getGeminiVertexLocation (`global`).
 */
export function getGeminiVertexGlobalEndpointError(
  model: string | undefined,
  location: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const resolvedLocation = sanitizeCredential(location) ?? DEFAULT_GEMINI_VERTEX_LOCATION
  const resolvedModel = sanitizeCredential(model)
  if (resolvedLocation === 'global' || !isGlobalOnlyVertexModel(resolvedModel)) {
    return null
  }
  // All consumers publish this message (startup validation and client
  // errors). Redact the display value here, after comparing the raw location.
  const displayLocation = redactSecretValueForDisplay(resolvedLocation, env)
  return `Gemini Vertex model "${resolvedModel}" is only available on the global endpoint; set GEMINI_VERTEX_LOCATION=global (currently "${displayLocation}") to use it.`
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
 * credentials (client and validator) must use this so a
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

/**
 * True when an ADC credential will let the native client derive the Vertex
 * project at runtime (getAnthropicClient falls back to credential.projectId for
 * ADC only), so an explicit project alias is not required. Only the *effective*
 * auth mode counts: a GEMINI_ACCESS_TOKEN makes the runtime resolve
 * access-token even when GOOGLE_APPLICATION_CREDENTIALS is also set, and that
 * path still needs a project. An explicitly configured model also selects ADC
 * with project discovery from ambient credentials. A bare flag without a model
 * or credential source remains incomplete. Single source of truth so the
 * completeness gate and startup/summary placeholders cannot drift apart.
 */
export function geminiVertexAdcWillResolveProject(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (sanitizeCredential(env.GEMINI_VERTEX_AUTH_MODE)?.toLowerCase() === 'adc') {
    return true
  }
  return (
    resolveGeminiVertexAuthMode(env) === 'adc' &&
    (sanitizeCredential(env.GOOGLE_APPLICATION_CREDENTIALS) !== undefined ||
      sanitizeCredential(env.GEMINI_VERTEX_MODEL) !== undefined)
  )
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
  if (!deps.allowAmbientAdc && !mayHaveGeminiAdcCredentials(env)) {
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
    allowAmbientAdc: boolean,
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
      { allowAmbientAdc },
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
    deps.allowAmbientAdc ?? false,
  )
}
