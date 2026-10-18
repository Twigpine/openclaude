import { createChildAbortController } from '../../utils/abortController.js'
import { requestAbort } from '../../utils/interruptionTrace.js'
import { sleep } from '../../utils/sleep.js'

export function createForegroundAgentAbortController(
  parent: AbortController,
): AbortController {
  const foreground = createChildAbortController(parent, undefined, {
    subsystem: 'agent_tool',
    controllerRole: 'child',
  })
  foreground.signal.addEventListener(
    'abort',
    () => {
      if (foreground.signal.reason === 'background' || parent.signal.aborted) {
        return
      }
      requestAbort(parent, foreground.signal.reason, {
        source: 'foreground_agent_abort',
        subsystem: 'agent_tool',
        controllerRole: 'query-root',
      })
    },
    { once: true },
  )
  return foreground
}

export async function closeForegroundAgentForBackground(
  abortController: AbortController,
  closeIterator: () => Promise<unknown>,
): Promise<void> {
  requestAbort(abortController, 'background', {
    source: 'agent_background_transition',
    subsystem: 'agent_tool',
    controllerRole: 'child',
  })
  await Promise.race([closeIterator().catch(() => {}), sleep(1000)])
}
