import { setMaxListeners } from 'events'
import {
  getInterruptionSignalAbortEventId,
  getInterruptionSignalId,
  registerInterruptionController,
  requestAbort,
  type InterruptionTraceFields,
} from './interruptionTrace.js'

/**
 * Default max listeners for standard operations
 */
const DEFAULT_MAX_LISTENERS = 50

/**
 * Creates an AbortController with proper event listener limits set.
 * This prevents MaxListenersExceededWarning when multiple listeners
 * are attached to the abort signal.
 *
 * @param maxListeners - Maximum number of listeners (default: 50)
 * @returns AbortController with configured listener limit
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * Propagates abort from a parent to a weakly-referenced child controller.
 * Both parent and child are weakly held — neither direction creates a
 * strong reference that could prevent GC.
 * Module-scope function avoids per-call closure allocation.
 */
function propagateAbort(
  this: WeakRef<AbortController>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref()
  const child = weakChild.deref()
  if (!child) return
  requestAbort(child, parent?.signal.reason, {
    source: 'parent_signal',
    subsystem: 'abort_controller',
    controllerRole: 'child',
    ...(parent && {
      causalEventId: getInterruptionSignalAbortEventId(parent.signal),
    }),
    ...(parent && {
      parentControllerIds: [getInterruptionSignalId(parent.signal) ?? 'unregistered-parent'],
    }),
  })
}

/**
 * Removes an abort handler from a weakly-referenced parent signal.
 * Both parent and handler are weakly held — if either has been GC'd
 * or the parent already aborted ({once: true}), this is a no-op.
 * Module-scope function avoids per-call closure allocation.
 */
function removeAbortHandler(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener('abort', handler)
  }
}

/**
 * Creates a child AbortController that aborts when its parent aborts.
 * Aborting the child does NOT affect the parent.
 *
 * Memory-safe: Uses WeakRef so the parent doesn't retain abandoned children.
 * If the child is dropped without being aborted, it can still be GC'd.
 * When the child IS aborted, the parent listener is removed to prevent
 * accumulation of dead handlers.
 *
 * @param parent - The parent AbortController
 * @param maxListeners - Maximum number of listeners (default: 50)
 * @param traceFields - Owning lifecycle identity for interruption diagnostics
 * @returns Child AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
  traceFields: InterruptionTraceFields = {},
): AbortController {
  const child = createAbortController(maxListeners)
  const parentId = registerInterruptionController(parent, {
    subsystem: 'abort_controller',
    controllerRole: 'parent',
  }, { provisionalRole: true })
  const hasOwningRole = traceFields.controllerRole !== undefined
  registerInterruptionController(
    child,
    {
      subsystem: 'abort_controller',
      controllerRole: 'child',
      ...traceFields,
      ...(parentId && { parentControllerIds: [parentId] }),
    },
    { provisionalRole: !hasOwningRole },
  )

  // Fast path: parent already aborted, no listener setup needed
  if (parent.signal.aborted) {
    requestAbort(child, parent.signal.reason, {
      source: 'already_aborted_parent',
      subsystem: 'abort_controller',
      controllerRole: 'child',
      causalEventId: getInterruptionSignalAbortEventId(parent.signal),
      ...(parentId && { parentControllerIds: [parentId] }),
    })
    return child
  }

  // WeakRef prevents the parent from keeping an abandoned child alive.
  // If all strong references to child are dropped without aborting it,
  // the child can still be GC'd — the parent only holds a dead WeakRef.
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)

  parent.signal.addEventListener('abort', handler, { once: true })

  // Auto-cleanup: remove parent listener when child is aborted (from any source).
  // Both parent and handler are weakly held — if either has been GC'd or the
  // parent already aborted ({once: true}), the cleanup is a harmless no-op.
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}
