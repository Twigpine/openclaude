// Package-manager stand-in. Lifecycle work deliberately outlives its manager.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, status, output] = process.argv.slice(2)
const root = process.env.UPDATER_TEST_ROOT
const released = () => fs.existsSync(path.join(root, 'release'))
// Cover startup too: cleanup can remove the heartbeat before we observe it.
// Do not keep completed result-mode commands alive just for this safety timer.
const deadline = setTimeout(() => { process.exit(124) }, 12_000).unref()

function hold(tick) {
  const timer = setInterval(() => {
    if (released()) {
      clearInterval(timer)
      clearTimeout(deadline)
      if (mode === 'lifecycle') fs.writeFileSync(path.join(root, 'lifecycle-exited'), '')
      process.exitCode = Number(status)
    } else {
      tick?.()
    }
  }, 10)
}

if (mode === 'result') {
  fs.writeSync(1, output)
  process.exitCode = Number(status)
} else if (mode === 'lifecycle') {
  fs.writeFileSync(path.join(root, 'lifecycle-ready'), '')
  hold(() => fs.appendFileSync(path.join(root, 'heartbeat'), 'x'))
} else {
  if (mode === 'timeout' || mode === 'output-limit' || mode.startsWith('SIG')) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'lifecycle', '0'], {
      stdio: 'ignore', env: process.env,
      // Avoid the manager's kill-on-exit job on Windows; retain POSIX grouping.
      detached: process.platform === 'win32',
    })
    while (!fs.existsSync(path.join(root, 'heartbeat'))) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    if (mode === 'output-limit') fs.writeSync(1, Buffer.alloc(1_100_000, 'x'))
    if (mode.startsWith('SIG')) fs.writeSync(1, 'lifecycle started\n')
  }
  hold()
}
