import { getFsImplementation, setFsImplementation } from '../../utils/fsOperations.js'
import { gracefulShutdown, resetShutdownState } from '../../utils/gracefulShutdown.js'
import {
  __resetInterruptionTraceForTests,
  requestAbort,
  traceInterruptionEvent,
} from '../../utils/interruptionTrace.js'

process.env.NODE_ENV = 'test'
process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/virtual/trace.jsonl'

const originalFs = getFsImplementation()
const originalExit = process.exit
let writeSettled = false
let exitObservedSettledWrite = false
let exitCalled = false

setFsImplementation({
  ...originalFs,
  mkdirSync: () => {},
  appendRegularFile: async () => {
    if (process.env.TRACE_SHUTDOWN_BLOCK_WRITE === '1') {
      await new Promise<void>(() => {})
    }
    await Bun.sleep(50)
    writeSettled = true
  },
})
process.exit = ((_code?: number) => {
  exitCalled = true
  exitObservedSettledWrite = writeSettled
  throw new Error('mocked process exit')
}) as typeof process.exit

try {
  const controller = new AbortController()
  if (process.env.TRACE_SHUTDOWN_PENDING_ONLY === '1') {
    controller.abort('interrupt')
    traceInterruptionEvent('shutdown.pending')
  } else {
    requestAbort(controller, 'interrupt', {
      source: 'print_sigint',
      controllerRole: 'query-root',
    })
  }
  await gracefulShutdown(0).catch(() => {})
  console.log(
    `TRACE_SHUTDOWN_RESULT ${JSON.stringify({
      aborted: controller.signal.aborted,
      exitCalled,
      writeSettled,
      exitObservedSettledWrite,
    })}`,
  )
} finally {
  process.exit = originalExit
  setFsImplementation(originalFs)
  resetShutdownState()
  __resetInterruptionTraceForTests()
}
