import { writeFile } from 'node:fs/promises'
import { handleBgFlag } from './bg.js'
import * as backgroundFinalizer from './bgFinalizer.js'
import { noteBackgroundSessionTerminationSignal } from '../utils/backgroundSessionTermination.js'

const invocation = process.argv.slice(2)
const cleanupWorkerEnv = 'OPENCLAUDE_INTERNAL_BACKGROUND_CLEANUP_WORKER'
if (process.env[cleanupWorkerEnv] === '1') {
  const runCleanupWorker = (
    backgroundFinalizer as typeof backgroundFinalizer & {
      runBackgroundSessionCleanupWorker?: () => Promise<void>
    }
  ).runBackgroundSessionCleanupWorker
  if (!runCleanupWorker) {
    throw new Error('background cleanup worker is unavailable')
  }
  await runCleanupWorker()
} else if (invocation[0] === 'launcher') {
  const name = invocation[2]
  const originalLog = console.log
  if (
    process.env.OPENCLAUDE_BG_FINALIZER_FIXTURE_OUTPUT === 'omit-logs'
  ) {
    console.log = (...args: unknown[]) => {
      if (String(args[0]).startsWith('Logs:')) return
      originalLog(...args)
    }
  }
  try {
    await handleBgFlag([
      '--bg',
      ...(name ? ['--name', name] : []),
      invocation[1] ?? 'success',
    ])
  } finally {
    console.log = originalLog
  }
} else {
  const mode = invocation.at(-1)
  await backgroundFinalizer.prepareBackgroundSessionFinalizer()

  if (mode === 'throw') {
    throw new Error('intentional background finalizer fixture failure')
  }
  if (mode === 'fail') {
    process.exitCode = 23
  }
  if (mode === 'sigint') {
    process.once('SIGINT', () => {
      noteBackgroundSessionTerminationSignal('SIGINT')
      process.exit(0)
    })
  }
  if (mode === 'sigterm') {
    process.once('SIGTERM', () => {
      noteBackgroundSessionTerminationSignal('SIGTERM')
      process.exit(143)
    })
  }
  const readyPath = process.env.OPENCLAUDE_BG_FINALIZER_FIXTURE_READY
  if (mode === 'handled-throw') {
    const releasePath = process.env.OPENCLAUDE_BG_FINALIZER_FIXTURE_RELEASE
    if (!readyPath || !releasePath) {
      throw new Error('handled-throw fixture routing is missing')
    }
    process.once('uncaughtException', async () => {
      await writeFile(readyPath, 'ready')
      const deadline = Date.now() + 5_000
      while (!(await Bun.file(releasePath).exists())) {
        if (Date.now() >= deadline) {
          process.exit(24)
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      process.exit(23)
    })
    queueMicrotask(() => {
      throw new Error('intentional handled fixture failure')
    })
  } else if (
    readyPath &&
    process.env.OPENCLAUDE_BG_FINALIZER_FIXTURE_SKIP_READY !== '1'
  ) {
    await writeFile(readyPath, 'ready')
  }
  if (mode === 'controlled' || mode === 'controlled-exit') {
    const releasePath = process.env.OPENCLAUDE_BG_FINALIZER_FIXTURE_RELEASE
    if (!releasePath) {
      throw new Error('controlled fixture release path is missing')
    }
    const deadline = Date.now() + 5_000
    while (!(await Bun.file(releasePath).exists())) {
      if (Date.now() >= deadline) {
        throw new Error('controlled fixture release timed out')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (mode === 'controlled-exit') process.exit(0)
  }
  if (mode === 'wait' || mode === 'sigint' || mode === 'sigterm') {
    setInterval(() => {}, 1_000)
  }
}
