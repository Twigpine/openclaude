/**
 * Authentication for the headless gRPC AgentService.
 *
 * The AgentService exposes the full agent loop (Bash/Write/Edit/Read tools plus
 * tool-approval). Binding it without authentication let any client that could
 * reach the port drive the agent and approve its own commands. This module adds
 * a bearer-token check and a loopback-only default.
 */
import { timingSafeEqual } from 'crypto'

/** Default bind host: loopback only. */
export const DEFAULT_GRPC_HOST = '127.0.0.1'

/** Env var the server reads for the required bearer token. */
export const GRPC_AUTH_TOKEN_ENV = 'GRPC_AUTH_TOKEN'

/** Hosts that are unambiguously local-only bind addresses. */
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
  'ip6-localhost',
])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

/**
 * Constant-time comparison of two tokens. Returns false when either side is
 * missing so an empty configured token can never authenticate a client.
 */
export function tokenMatches(expected: string | undefined, provided: string): boolean {
  if (!expected) {
    return false
  }
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * Extract a bearer token from gRPC metadata. Accepts an `authorization: Bearer
 * <token>` header (preferred) and falls back to a bare `authorization` or
 * `x-api-key` value.
 */
export function extractBearerToken(metadata: {
  get(key: string): { toString(): string }[]
}): string {
  const authValues = metadata.get('authorization')
  if (authValues.length > 0) {
    const raw = authValues[0].toString().trim()
    const match = /^Bearer\s+(.+)$/i.exec(raw)
    return match ? match[1].trim() : raw
  }
  const apiKeyValues = metadata.get('x-api-key')
  if (apiKeyValues.length > 0) {
    return apiKeyValues[0].toString().trim()
  }
  return ''
}

export type GrpcBindResolution =
  | { ok: true; host: string }
  | { ok: false; reason: string }

/**
 * Resolve the bind address, refusing non-loopback binds unless an auth token is
 * configured. This makes the "0.0.0.0 for convenience" footgun fail loudly
 * instead of silently exposing an unauthenticated command-execution surface.
 */
export function resolveGrpcBind(
  host: string | undefined,
  authToken: string | undefined,
): GrpcBindResolution {
  const resolved = (host?.trim() || DEFAULT_GRPC_HOST)
  if (isLoopbackHost(resolved) || authToken) {
    return { ok: true, host: resolved }
  }
  return {
    ok: false,
    reason:
      `Refusing to bind the gRPC server to non-loopback host "${resolved}" ` +
      `without authentication. Set ${GRPC_AUTH_TOKEN_ENV} to a secret value or ` +
      `bind to ${DEFAULT_GRPC_HOST}.`,
  }
}
