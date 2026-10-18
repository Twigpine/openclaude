import { randomBytes } from 'node:crypto'

export const BACKGROUND_SESSION_ID_ENV =
  'OPENCLAUDE_INTERNAL_BACKGROUND_SESSION_ID'
export const BACKGROUND_SESSION_LAUNCHER_PID_ENV =
  'OPENCLAUDE_INTERNAL_BACKGROUND_LAUNCHER_PID'
export const BACKGROUND_SESSION_CLEANUP_WORKER_ENV =
  'OPENCLAUDE_INTERNAL_BACKGROUND_CLEANUP_WORKER'
export const BACKGROUND_SESSION_CLEANUP_OWNER_PID_ENV =
  'OPENCLAUDE_INTERNAL_BACKGROUND_CLEANUP_OWNER_PID'

export const BACKGROUND_PROCESS_MARKER_FLAG =
  '--openclaude-bg-session-marker'

const BACKGROUND_PROCESS_MARKER_BYTES = 32
const BACKGROUND_PROCESS_MARKER_RE = /^[a-f0-9]{64}$/

export function isValidBackgroundProcessMarker(value: unknown): value is string {
  return (
    typeof value === 'string' && BACKGROUND_PROCESS_MARKER_RE.test(value)
  )
}

export function generateBackgroundProcessMarker(
  getRandomBytes: (size: number) => Uint8Array = randomBytes,
): string {
  const bytes = getRandomBytes(BACKGROUND_PROCESS_MARKER_BYTES)
  if (bytes.byteLength !== BACKGROUND_PROCESS_MARKER_BYTES) {
    throw new Error(
      'Background process marker entropy source returned the wrong length',
    )
  }
  return Buffer.from(bytes).toString('hex')
}

export function backgroundProcessMarkerToken(marker: string): string {
  if (!isValidBackgroundProcessMarker(marker)) {
    throw new Error('Invalid background process marker')
  }
  return `${BACKGROUND_PROCESS_MARKER_FLAG}=${marker}`
}

export function stripBackgroundProcessMarkerArgs(args: string[]): string[] {
  const first = args[0]
  const inlinePrefix = `${BACKGROUND_PROCESS_MARKER_FLAG}=`
  if (
    first?.startsWith(inlinePrefix) &&
    isValidBackgroundProcessMarker(first.slice(inlinePrefix.length))
  ) {
    return args.slice(1)
  }
  if (
    first === BACKGROUND_PROCESS_MARKER_FLAG &&
    isValidBackgroundProcessMarker(args[1])
  ) {
    return args.slice(2)
  }
  return [...args]
}
