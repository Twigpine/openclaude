import { createHash } from 'node:crypto'
import { mkdir, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createBackgroundSession,
  recordBackgroundSessionNaturalTerminationSync,
} from '../cli/bgRegistry.js'
import { killHandler } from '../cli/bg.js'
import { enableConfigs } from './config.js'
import { eagerLoadSettingsFromArgs } from './settings/flagSettings.js'
import {
  cleanupBackgroundSessionsAfterFinalization,
  cleanupBackgroundSessionsInBackground,
  cleanupOldMessageFilesInBackground,
  runBackgroundSessionRetention,
} from './cleanup.js'

try {
  const mode = process.env.OPENCLAUDE_CLEANUP_FIXTURE_MODE
  if (mode === 'pass-outcome') {
    enableConfigs()
    const settingsPath = join(
      process.env.OPENCLAUDE_CONFIG_DIR!,
      'settings.json',
    )
    const settingsResult = eagerLoadSettingsFromArgs([
      '--settings',
      settingsPath,
    ])
    if (!settingsResult.ok) throw new Error(settingsResult.message)
    const trigger =
      process.env.OPENCLAUDE_CLEANUP_TRIGGER === 'periodic-retention'
        ? 'periodic-retention'
        : 'periodic-recovery'
    const afterLock = async () => {
      if (process.env.OPENCLAUDE_CLEANUP_REJECT_AFTER_LOCK === '1') {
        await Bun.write(
          settingsPath,
          JSON.stringify({ cleanupPeriodDays: 'invalid' }),
        )
      }
    }
    const result = await runBackgroundSessionRetention(
      trigger === 'periodic-recovery'
        ? { trigger, _afterThrottleLockForTesting: afterLock }
        : {
            trigger,
            _afterThrottleLockForTesting: afterLock,
            _afterJournalSnapshotForTesting: async () => {
              if (
                process.env.OPENCLAUDE_CLEANUP_APPEND_AFTER_SNAPSHOT !== '1'
              )
                return
              const session = await createBackgroundSession({
                id: 'bg-snapshot-appended',
                pid: process.pid,
                cwd: process.cwd(),
                command: ['openclaude', '--print', 'fixture'],
                sessionId: 'snapshot-appended-conversation',
              })
              recordBackgroundSessionNaturalTerminationSync(
                session.id,
                { exitCode: 0 },
                {
                  ownerPid: process.pid,
                  expectedSession: session,
                },
              )
              if (
                process.env.OPENCLAUDE_CLEANUP_THROW_AFTER_SNAPSHOT === '1'
              ) {
                throw new Error('intentional full-sweep interruption')
              }
            },
          },
    )
    process.stdout.write(`${JSON.stringify({ result })}\n`)
  } else if (
    mode === 'periodic-retention' ||
    mode === 'periodic-retention-policy-recheck'
  ) {
    enableConfigs()
    const settingsResult = eagerLoadSettingsFromArgs([
      '--settings',
      join(process.env.OPENCLAUDE_CONFIG_DIR!, 'settings.json'),
    ])
    if (!settingsResult.ok) throw new Error(settingsResult.message)
    const { cleanupBackgroundSessionRetentionInBackground } =
      await import('./cleanup.js')
    process.stdout.write(
      `${JSON.stringify({
        result:
          mode === 'periodic-retention'
            ? await cleanupBackgroundSessionRetentionInBackground()
            : await runBackgroundSessionRetention({
                trigger: 'periodic-retention',
                _afterThrottleLockForTesting: async () => {
                  await Bun.write(
                    join(process.cwd(), '.mcp.json'),
                    '{invalid',
                  )
                },
              }),
      })}\n`,
    )
  } else if (
    mode === 'periodic-recovery' ||
    mode === 'periodic-recovery-bounded'
  ) {
    enableConfigs()
    const settingsResult = eagerLoadSettingsFromArgs([
      '--settings',
      join(process.env.OPENCLAUDE_CONFIG_DIR!, 'settings.json'),
    ])
    if (!settingsResult.ok) throw new Error(settingsResult.message)
    process.stdout.write(
      `${JSON.stringify({
        result:
          mode === 'periodic-recovery'
            ? await cleanupBackgroundSessionsInBackground()
            : await runBackgroundSessionRetention({
                trigger: 'periodic-recovery',
                _recoveryBatchLimitForTesting: (() => {
                  const limit = Number(
                    process.env.OPENCLAUDE_CLEANUP_RECOVERY_LIMIT,
                  )
                  if (!Number.isSafeInteger(limit) || limit < 1) {
                    throw new Error(
                      'OPENCLAUDE_CLEANUP_RECOVERY_LIMIT must be a positive safe integer',
                    )
                  }
                  return limit
                })(),
              }),
      })}\n`,
    )
  } else if (mode === 'periodic-policy-recheck') {
    enableConfigs()
    const settingsPath = join(
      process.env.OPENCLAUDE_CONFIG_DIR!,
      'settings.json',
    )
    const settingsResult = eagerLoadSettingsFromArgs([
      '--settings',
      settingsPath,
    ])
    if (!settingsResult.ok) throw new Error(settingsResult.message)
    const session = await createBackgroundSession({
      id: 'bg-periodic-policy-recheck',
      pid: process.pid,
      cwd: process.cwd(),
      command: ['openclaude', '--print', 'fixture'],
      sessionId: 'bg-periodic-policy-recheck-conversation',
    })
    recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 0 },
      {
        ownerPid: process.pid,
        expectedSession: session,
        now: new Date(Date.now() - 1_000),
      },
    )
    const result = await runBackgroundSessionRetention({
      trigger: 'periodic-recovery',
      _afterThrottleLockForTesting: async () => {
        await Bun.write(
          settingsPath,
          JSON.stringify({ cleanupPeriodDays: 30 }),
        )
      },
    })
    process.stdout.write(
      `${JSON.stringify({
        result,
        metadataPresent: await Bun.file(
          join(
            dirname(dirname(session.stdoutLogPath)),
            'sessions',
            `${session.id}.json`,
          ),
        ).exists(),
      })}\n`,
    )
  } else if (mode === 'marker-failure') {
    enableConfigs()
    const settingsPath = join(
      process.env.OPENCLAUDE_CONFIG_DIR!,
      'settings.json',
    )
    const settingsResult = eagerLoadSettingsFromArgs([
      '--settings',
      settingsPath,
    ])
    if (!settingsResult.ok) throw new Error(settingsResult.message)
    const plansDir = join(process.env.OPENCLAUDE_CONFIG_DIR!, 'plans')
    const planPath = join(plansDir, 'old-plan.md')
    await mkdir(plansDir, { recursive: true })
    await Bun.write(planPath, 'old plan')
    const old = new Date('2000-01-01T00:00:00.000Z')
    await utimes(planPath, old, old)
    await Bun.write(
      join(process.env.OPENCLAUDE_CONFIG_DIR!, 'bg-sessions'),
      'not a directory',
    )
    await cleanupOldMessageFilesInBackground()
    process.stdout.write(
      `${JSON.stringify({
        completed: true,
        planPresent: await Bun.file(planPath).exists(),
      })}\n`,
    )
  } else if (mode === 'post-finalization-policy-recheck') {
    const session = await createBackgroundSession({
      id: 'bg-post-finalization-policy-recheck',
      pid: process.pid,
      cwd: process.cwd(),
      command: ['openclaude', '--print', 'fixture'],
      sessionId: 'bg-post-finalization-policy-recheck-conversation',
    })
    recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 0 },
      {
        ownerPid: process.pid,
        expectedSession: session,
        now: new Date(Date.now() - 1_000),
      },
    )
    const settingsPath = join(
      process.env.OPENCLAUDE_CONFIG_DIR!,
      'settings.json',
    )
    let waits = 0
    let reloads = 0
    const result = await cleanupBackgroundSessionsAfterFinalization(
      session.id,
      async () => {
        waits++
        await Bun.write(
          settingsPath,
          JSON.stringify({ cleanupPeriodDays: 30 }),
        )
        return true
      },
      () => {
        reloads++
        return eagerLoadSettingsFromArgs(['--settings', settingsPath]).ok
      },
    )
    process.stdout.write(
      `${JSON.stringify({
        result,
        waits,
        reloads,
        metadataPresent: await Bun.file(
          join(
            dirname(dirname(session.stdoutLogPath)),
            'sessions',
            `${session.id}.json`,
          ),
        ).exists(),
      })}\n`,
    )
  } else if (mode === 'post-finalization-gate') {
    let waits = 0
    await cleanupBackgroundSessionsAfterFinalization(
      'bg-post-finalization-gate',
      async () => {
        waits++
        return true
      },
    )
    process.stdout.write(`${JSON.stringify({ waits })}\n`)
  } else if (
    mode === 'post-finalization-exact-cutoff' ||
    mode === 'post-finalization-timeout'
  ) {
    const exactNow = Date.now()
    const processMarker = 'd'.repeat(64)
    const session = await createBackgroundSession({
      id: 'bg-post-finalization-exact',
      name: 'post-finalization-exact',
      pid: process.pid,
      cwd: process.cwd(),
      command: [
        'openclaude',
        `--openclaude-bg-session-marker=${processMarker}`,
        '--print',
        'fixture',
      ],
      sessionId: 'bg-post-finalization-exact-conversation',
      processMarker,
      now: new Date(exactNow - 1_000),
    })
    const root = dirname(dirname(session.stdoutLogPath))
    const metadataPath = join(root, 'sessions', `${session.id}.json`)
    const reservationPath = join(
      root,
      'names',
      `${createHash('sha256').update(session.name!).digest('hex')}.json`,
    )
    recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 0 },
      {
        ownerPid: process.pid,
        expectedSession: session,
        now: new Date(exactNow),
      },
    )
    const originalDateNow = Date.now
    let waits = 0
    try {
      Date.now = () => exactNow
      await cleanupBackgroundSessionsAfterFinalization(
        session.id,
        async () => {
          waits++
          return mode === 'post-finalization-exact-cutoff'
        },
      )
    } finally {
      Date.now = originalDateNow
    }
    process.stdout.write(
      `${JSON.stringify({
        waits,
        metadataPresent: await Bun.file(metadataPath).exists(),
        reservationPresent: await Bun.file(reservationPath).exists(),
        stdoutPresent: await Bun.file(session.stdoutLogPath).exists(),
        stderrPresent: await Bun.file(session.stderrLogPath).exists(),
      })}\n`,
    )
  } else if (mode === 'explicit-kill') {
    const session = await createBackgroundSession({
      id: 'bg-explicit-kill-cleanup',
      pid: process.pid,
      cwd: process.cwd(),
      command: ['openclaude', '--print', 'fixture'],
      sessionId: 'bg-explicit-kill-cleanup-conversation',
    })
    recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 0 },
      {
        ownerPid: process.pid,
        expectedSession: session,
        now: new Date(Date.now() - 1_000),
      },
    )
    const originalConsoleLog = console.log
    try {
      console.log = () => {}
      await killHandler([session.id])
    } finally {
      console.log = originalConsoleLog
    }
    const root = dirname(dirname(session.stdoutLogPath))
    process.stdout.write(
      `${JSON.stringify({
        metadataPresent: await Bun.file(
          join(root, 'sessions', `${session.id}.json`),
        ).exists(),
        stdoutPresent: await Bun.file(session.stdoutLogPath).exists(),
        stderrPresent: await Bun.file(session.stderrLogPath).exists(),
      })}\n`,
    )
  } else {
    await cleanupOldMessageFilesInBackground()
    process.stdout.write(`${JSON.stringify({ completed: true })}\n`)
  }
} catch (error) {
  process.stderr.write(
    `background cleanup fixture failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  )
  process.exitCode = 1
}
