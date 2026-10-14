/**
 * Input validation for gRPC `ChatRequest` fields.
 *
 * `ChatRequest` carries a client-controlled `message`, `working_directory`, and
 * `session_id`. The server uses `working_directory` as the agent's cwd and
 * `session_id` as a global session-store key, so both are security-relevant:
 * an unbounded or malformed value can be used for resource exhaustion or to
 * probe the session namespace. Validate at the boundary and reject before the
 * agent loop starts.
 */

export const MAX_MESSAGE_LENGTH = 100_000
export const MAX_PATH_LENGTH = 4096
export const MAX_SESSION_ID_LENGTH = 128

/** Session ids are opaque keys; restrict them to a safe character set. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/

export type ChatRequestInput = {
  message: string
  workingDirectory?: string
  sessionId?: string
  model?: string
}

export type ValidationResult =
  | { ok: true; value: ChatRequestInput }
  | { ok: false; error: string }

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Validate and normalise the fields of a `ChatRequest`. Returns a structured
 * error string (safe to return to the client) instead of throwing so the
 * handler can emit a clean error frame.
 */
export function validateChatRequest(raw: {
  message?: unknown
  working_directory?: unknown
  session_id?: unknown
  model?: unknown
}): ValidationResult {
  const message = asString(raw.message)
  if (message === undefined || message.length === 0) {
    return { ok: false, error: 'message is required' }
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `message exceeds maximum length of ${MAX_MESSAGE_LENGTH}`,
    }
  }
  if (message.includes('\u0000')) {
    return { ok: false, error: 'message contains a null byte' }
  }

  const workingDirectory = asString(raw.working_directory)
  if (workingDirectory !== undefined && workingDirectory.length > 0) {
    if (workingDirectory.length > MAX_PATH_LENGTH) {
      return {
        ok: false,
        error: `working_directory exceeds maximum length of ${MAX_PATH_LENGTH}`,
      }
    }
    if (workingDirectory.includes('\u0000')) {
      return { ok: false, error: 'working_directory contains a null byte' }
    }
  }

  const sessionId = asString(raw.session_id)
  if (sessionId !== undefined && sessionId.length > 0) {
    if (sessionId.length > MAX_SESSION_ID_LENGTH) {
      return {
        ok: false,
        error: `session_id exceeds maximum length of ${MAX_SESSION_ID_LENGTH}`,
      }
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, error: 'session_id contains invalid characters' }
    }
  }

  const model = asString(raw.model)

  return {
    ok: true,
    value: {
      message,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(model ? { model } : {}),
    },
  }
}
