export type ObservedBackgroundSessionSignal =
  | 'SIGINT'
  | 'SIGTERM'
  | 'SIGHUP'

let tracking = false
let observedSignal: ObservedBackgroundSessionSignal | undefined

/**
 * Start process-local signal tracking only after a detached CLI has proven
 * exact registry ownership. The returned reader keeps the finalizer decoupled
 * from the signal handlers that initiate graceful shutdown.
 */
export function beginBackgroundSessionSignalTracking(): () =>
  | ObservedBackgroundSessionSignal
  | undefined {
  tracking = true
  observedSignal = undefined
  return () => observedSignal
}

/** Record the first termination signal actually handled by this process. */
export function noteBackgroundSessionTerminationSignal(
  signal: ObservedBackgroundSessionSignal,
): void {
  if (tracking && observedSignal === undefined) observedSignal = signal
}
