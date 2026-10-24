import type { ZodError } from 'zod/v4'
import { isAbortError, ShellError } from './errors.js'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from './messages.js'

export function formatError(error: unknown): string {
  if (isAbortError(error)) {
    return error instanceof Error && error.message
      ? error.message
      : INTERRUPT_MESSAGE_FOR_TOOL_USE
  }
  if (!(error instanceof Error)) {
    return String(error)
  }
  const parts = getErrorParts(error)
  const fullMessage =
    parts.filter(Boolean).join('\n').trim() || 'Command failed with no output'
  // 40KB limit — enough for most command error logs (systemctl, apt, python, etc.)
  const maxErrorLength = 40000
  if (fullMessage.length <= maxErrorLength) {
    return fullMessage
  }
  const halfLength = Math.floor(maxErrorLength / 2)
  const start = fullMessage.slice(0, halfLength)
  const end = fullMessage.slice(-halfLength)
  return `${start}\n\n... [${fullMessage.length - maxErrorLength} characters truncated] ...\n\n${end}`
}

export function getErrorParts(error: Error): string[] {
  if (error instanceof ShellError) {
    return [
      `Exit code ${error.code}`,
      error.interrupted
        ? error.abortMessage ?? INTERRUPT_MESSAGE_FOR_TOOL_USE
        : '',
      error.stderr,
      error.stdout,
    ]
  }
  const parts = [error.message]
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }
  return parts
}

/**
 * Formats a Zod validation path into a readable string
 * e.g., ['todos', 0, 'activeForm'] => 'todos[0].activeForm'
 */
function formatValidationPath(path: PropertyKey[]): string {
  if (path.length === 0) return ''

  return path.reduce((acc, segment, index) => {
    const segmentStr = String(segment)
    if (typeof segment === 'number') {
      return `${String(acc)}[${segmentStr}]`
    }
    return index === 0 ? segmentStr : `${String(acc)}.${segmentStr}`
  }, '') as string
}

/**
 * Converts Zod validation errors into a human-readable and LLM friendly error message
 *
 * @param toolName The name of the tool that failed validation
 * @param error The Zod error object
 * @returns A formatted error message string
 */
export function formatZodValidationError(
  toolName: string,
  error: ZodError,
): string {
  const missingParams = error.issues
    .filter(
      err =>
        err.code === 'invalid_type' &&
        err.message.includes('received undefined'),
    )
    .map(err => formatValidationPath(err.path))

  const unexpectedParams = error.issues
    .filter(err => err.code === 'unrecognized_keys')
    .flatMap(err => err.keys)

  const typeMismatchParams = error.issues
    .filter(
      err =>
        err.code === 'invalid_type' &&
        !err.message.includes('received undefined'),
    )
    .map(err => {
      const typeErr = err as { expected: string }
      const receivedMatch = err.message.match(/received (\w+)/)
      const received = receivedMatch ? receivedMatch[1] : 'unknown'
      return {
        param: formatValidationPath(err.path),
        expected: typeErr.expected,
        received,
      }
    })

  // Default to original error message if we can't create a better one
  let errorContent = error.message

  // Build a human-readable error message
  const errorParts: string[] = []

  if (missingParams.length > 0) {
    const missingParamErrors = missingParams.map(
      param => `The required parameter \`${param}\` is missing`,
    )
    errorParts.push(...missingParamErrors)
  }

  if (unexpectedParams.length > 0) {
    const unexpectedParamErrors = unexpectedParams.map(
      param => `An unexpected parameter \`${param}\` was provided`,
    )
    errorParts.push(...unexpectedParamErrors)
  }

  if (typeMismatchParams.length > 0) {
    const typeErrors = typeMismatchParams.map(
      ({ param, expected, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    )
    errorParts.push(...typeErrors)
  }

  if (errorParts.length > 0) {
    errorContent = `${toolName} failed due to the following ${errorParts.length > 1 ? 'issues' : 'issue'}:\n${errorParts.join('\n')}`
  }

  return errorContent
}

export function formatMcpValidationError(name: string, error: ZodError): string {
  return `Tool ${name} input is invalid:\n${error.issues.map(issue => `- ${issue.path.join('.')}: ${issue.message}`).join('\n')}`
}
