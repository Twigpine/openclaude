// External commands are intercepted; updater code and lock/permission filesystem
// operations run unchanged in the built CLI under Node.
import childProcess from 'node:child_process'
import fs from 'node:fs'
import promises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = process.env.UPDATER_TEST_ROOT
const owner = process.env.UPDATER_TEST_OWNER || 'npm'
const log = event => fs.appendFileSync(path.join(root, 'events'), JSON.stringify(event) + '\n')
os.homedir = () => path.join(root, 'home')
process.argv[1] = owner === 'bun'
  ? path.join(root, 'npm/bun/install/global/node_modules/@twigpine/openclaude/cli.mjs')
  : path.join(root, 'npm/node_modules/@twigpine/openclaude/cli.mjs')

// Exercise the real Windows parser even on POSIX; this preload is process-local.
let windowsParse
if (process.env.UPDATER_TEST_WINDOWS_WRAPPERS) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin/bun.exe'), '')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    windowsParse = createRequire(import.meta.url)('cross-spawn')._parse
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

// A missed command must fail the test instead of reaching a live registry.
http.request = https.request = () => { throw new Error('Unexpected updater HTTP request') }

const setTimeout = globalThis.setTimeout
let shortenInstallTimeout = false
globalThis.setTimeout = (callback, delay, ...args) => {
  if (shortenInstallTimeout && delay === 600_000) {
    shortenInstallTimeout = false
    return setTimeout(callback, 500, ...args)
  }
  return setTimeout(callback, delay, ...args)
}

const spawn = childProcess.spawn
childProcess.spawn = (file, args = [], options = {}) => {
  const availability = /which (npm|bun)$/.exec([file, ...args].join(' '))
  if (windowsParse && (file === 'npm' || file === 'bun')) {
    const pathExt = process.env.PATHEXT
    try {
      // Bun ships a native .exe, so its Windows route must stay shell-free.
      if (file === 'bun') process.env.PATHEXT = '.exe'
      const parsed = windowsParse(file, args, file === 'bun'
        ? { ...options, env: { ...process.env, PATH: path.join(root, 'bin') } }
        : options)
      log({ type: 'parsed-command', file: parsed.command, args: parsed.args, resolved: parsed.file })
      file = parsed.command
      args = parsed.args
      options = { ...parsed.options, env: options.env }
    } finally {
      if (pathExt === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = pathExt
    }
  } else if (windowsParse && availability) {
    file = 'cmd.exe'
    args = ['/d', '/s', '/c', `"where.exe ${availability[1]}"`]
  }
  log({ type: 'command', file, args })
  if (path.win32.basename(file).toLowerCase() === 'cmd.exe' && args.includes('/c')) {
    // Only fixture-owned, whitespace-free arguments are admitted below. Decode
    // cmd quoting/caret layers; do not execute or interpret arbitrary shell input.
    const words = args.at(-1).replace(/["^]/g, '').trim().split(/\s+/)
    if (['npm', 'bun', 'where.exe'].includes(words[0])) [file, ...args] = words
  }
  const command = [file, ...args].join(' ')
  let output = ''
  let code = 0
  let install = false
  if (/(?:which|where\.exe) (npm|bun)$/.test(command)) {
    output = path.join(root, 'bin', command.endsWith('bun') ? 'bun' : 'npm')
  } else if (file === 'npm' && args[0] === 'view') {
    output = process.env.UPDATER_TEST_VERSION || '0.34.0'
    log({ type: 'lookup', args })
  } else if (file === 'npm' && args.includes('prefix')) {
    output = path.join(root, 'npm-prefix')
  } else if (file === 'npm' && args[0] === 'root') {
    output = path.join(root, 'npm/node_modules')
  } else if (file === 'bun' && args[0] === 'pm') {
    output = path.join(root, 'npm/bun/bin')
  } else if ((file === 'npm' && args[0] === 'install') || (file === 'bun' && args[0] === 'add')) {
    install = true
    log({ type: 'install', file, args, pid: process.pid })
    code = Number(process.env.UPDATER_TEST_INSTALL_EXIT || 0)
    shortenInstallTimeout = process.env.UPDATER_TEST_UNCERTAIN?.startsWith('timeout')
  } else {
    code = 1 // Never run incidental diagnostics or completion commands on the host.
  }
  const mode = install
    ? process.env.UPDATER_TEST_UNCERTAIN?.replace('-kill-failure', '') || (process.env.UPDATER_TEST_HOLD ? 'hold' : 'result')
    : 'result'
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./updater-process.mjs', import.meta.url)), mode, String(code), output,
  ], { ...options, shell: false, windowsVerbatimArguments: false })
  if (install && mode.startsWith('SIG')) {
    // Signal only the manager after its independent lifecycle worker is active.
    child.stdout.once('data', () => child.kill(mode))
  }
  if (install && process.env.UPDATER_TEST_UNCERTAIN?.endsWith('-kill-failure')) {
    // Exercise Node's real synchronous kill-error event before the wrapper's
    // timeout/output-limit result settles, without signaling a foreign process.
    child._handle.kill = () => {
      log({ type: 'kill-error', args: [] })
      return process.binding('uv').UV_EPERM
    }
  }
  return child
}

const writeFile = promises.writeFile
let firstLockWrite = true
promises.writeFile = async (file, ...args) => {
  if (String(file).includes('.update.lock') && firstLockWrite) {
    firstLockWrite = false
    if (process.env.UPDATER_TEST_BARRIER) {
      fs.writeFileSync(path.join(root, `ready-${process.pid}`), '')
      const deadline = Date.now() + 8000
      while (fs.readdirSync(root).filter(name => name.startsWith('ready-')).length < 2) {
        if (Date.now() > deadline) throw new Error('Lock contenders did not reach the barrier')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    if (process.env.UPDATER_TEST_MISSING_DIRECTORY) {
      // The CLI normally initializes config before installation. Exercise the
      // installer's missing-directory retry without removing that configuration.
      throw Object.assign(new Error('Simulated missing config directory'), { code: 'ENOENT' })
    }
  }
  return writeFile(file, ...args)
}
syncBuiltinESMExports()
