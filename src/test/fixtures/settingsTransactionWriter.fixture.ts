import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  getFsImplementation,
  setFsImplementation,
} from '../../utils/fsOperations.js'

const fixtureArgs = process.argv.slice(2)
const [
  role,
  target,
  key,
  value,
  enteredMarker,
  completedMarker,
  readMarker,
  releaseMarker,
] = fixtureArgs

const supportedRoles: ReadonlySet<string> = new Set([
  'normal',
  'hold-lock',
  'hold-path-for',
  'pause-after-read',
  'pause-before-lock-owner',
])

if (!role || !supportedRoles.has(role)) {
  throw new Error(`Invalid settings transaction fixture role: ${role}`)
}

if (
  !target ||
  !key ||
  !value ||
  !enteredMarker ||
  !completedMarker
) {
  throw new Error('Missing settings transaction fixture arguments')
}

const expectedArgumentCount =
  role === 'hold-lock' ||
  role === 'pause-after-read' ||
  role === 'pause-before-lock-owner'
    ? 8
    : 6
if (fixtureArgs.length !== expectedArgumentCount) {
  throw new Error(
    `Invalid argument count for ${role}: expected ${expectedArgumentCount}, received ${fixtureArgs.length}`,
  )
}

if (role === 'hold-lock' && !releaseMarker) {
  throw new Error('Hold-lock fixture requires a release marker')
}

if (role === 'pause-after-read' && (!readMarker || !releaseMarker)) {
  throw new Error('Pause-after-read fixture requires read and release markers')
}

if (role === 'pause-before-lock-owner' && (!readMarker || !releaseMarker)) {
  throw new Error(
    'Pause-before-lock-owner fixture requires pause and release markers',
  )
}

const holdMs = role === 'hold-path-for' ? Number(value) : undefined
if (
  role === 'hold-path-for' &&
  (!Number.isFinite(holdMs) || (holdMs ?? -1) < 0)
) {
  throw new Error(`Invalid hold duration: ${value}`)
}

if (role !== 'hold-path-for') {
  process.env.OPENCLAUDE_CONFIG_DIR = target
}
const settingsPath =
  role === 'hold-path-for'
    ? resolve(target)
    : resolve(target, 'settings.json')
const settingsParentPath = dirname(settingsPath)
const settingsReadPath = existsSync(settingsPath)
  ? realpathSync(settingsPath)
  : existsSync(settingsParentPath)
    ? join(realpathSync(settingsParentPath), basename(settingsPath))
    : settingsPath
const waitBuffer = new Int32Array(new SharedArrayBuffer(4))

function waitForMarker(marker: string): void {
  const deadline = performance.now() + 15_000
  while (!existsSync(marker)) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for fixture marker: ${marker}`)
    }
    Atomics.wait(waitBuffer, 0, 0, 10)
  }
}

if (role === 'pause-after-read') {
  const originalFs = getFsImplementation()
  let paused = false
  setFsImplementation({
    ...originalFs,
    readFileSync(path, options) {
      const content = originalFs.readFileSync(path, options)
      if (!paused && resolve(path) === settingsReadPath) {
        paused = true
        writeFileSync(readMarker, '')
        waitForMarker(releaseMarker)
      }
      return content
    },
  })
}

if (role === 'pause-before-lock-owner') {
  const originalFs = getFsImplementation()
  let paused = false
  setFsImplementation({
    ...originalFs,
    readlinkSync(path) {
      const ownerPath = resolve(path)
      const lockPath = `${settingsReadPath}.lock`
      const ownerDirectory = dirname(ownerPath)
      if (
        !paused &&
        basename(ownerPath) === 'owner.json' &&
        (ownerDirectory === lockPath ||
          ownerDirectory.startsWith(`${lockPath}.pending.`))
      ) {
        paused = true
        writeFileSync(readMarker, '')
        waitForMarker(releaseMarker)
      }
      return originalFs.readlinkSync(path)
    },
  })
}

if (role === 'hold-lock' || role === 'hold-path-for') {
  const { withSettingsFileTransactionSync } = await import(
    '../../utils/settings/settingsFileTransaction.js'
  )
  withSettingsFileTransactionSync(settingsPath, () => {
    writeFileSync(enteredMarker, '')
    if (role === 'hold-path-for') {
      Atomics.wait(waitBuffer, 0, 0, holdMs!)
    } else {
      waitForMarker(releaseMarker)
    }
  })
  writeFileSync(completedMarker, '')
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`)
} else {
  const { updateSettingsForSource } = await import(
    '../../utils/settings/settings.js'
  )
  writeFileSync(enteredMarker, '')
  const result = updateSettingsForSource('userSettings', {
    env: { [key]: value },
  })
  writeFileSync(completedMarker, '')
  process.stdout.write(
    `${JSON.stringify({
      ok: result.error === null,
      error: result.error?.message,
    })}\n`,
  )
}
