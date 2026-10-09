import type { UUID } from 'crypto'
import * as React from 'react'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
  ResumeEntrypoint,
} from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import { formatLogMetadata } from '../../utils/format.js'
import { getWorktreePaths } from '../../utils/getWorktreePaths.js'
import { getLogDisplayTitle, logError } from '../../utils/log.js'
import { deleteSessionFiles } from '../../utils/sessionDeletion.js'
import {
  getSessionIdFromLog,
  getTranscriptPathForSession,
  isLiteLog,
  loadFullLog,
  loadSameRepoMessageLogs,
} from '../../utils/sessionStorage.js'
import { validateUuid } from '../../utils/uuid.js'
import { filterResumableSessions } from '../resume/resume.js'

type View =
  | { kind: 'list' }
  | { kind: 'actions'; log: LogOption; focus?: 'resume' | 'delete' | 'back' }
  | { kind: 'confirm-delete'; log: LogOption }

type Notice = { text: string; error?: boolean }

type OnResume = (
  sessionId: UUID,
  log: LogOption,
  entrypoint: ResumeEntrypoint,
) => Promise<void>

const SESSIONS_LIST_HINT =
  '↑/↓ navigate · Enter options · d d delete · Esc close'

/** Stable React key and focus id for a saved conversation row. */
function sessionKey(log: LogOption): string {
  return getSessionIdFromLog(log) ?? log.fullPath ?? String(log.value)
}

/**
 * `/sessions`: list this repo's saved conversations, open one to resume or
 * delete it, and go back without leaving the command. `d` pressed twice on
 * a row deletes it directly (#2223); Ctrl+D stays the global exit key.
 */
function SessionsManager({
  onDone,
  onResume,
}: {
  onDone: LocalJSXCommandOnDone
  onResume: OnResume
}): React.ReactNode {
  const [logs, setLogs] = React.useState<LogOption[] | null>(null)
  const [view, setView] = React.useState<View>({ kind: 'list' })
  const [focusedKey, setFocusedKey] = React.useState<string | undefined>()
  const [pendingDeleteKey, setPendingDeleteKey] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [busy, setBusy] = React.useState(false)
  // Remounts the list so it picks up a new default focus after a reload.
  const [listVersion, setListVersion] = React.useState(0)

  const loadLogs = React.useCallback(async (): Promise<LogOption[]> => {
    const paths = await getWorktreePaths(getOriginalCwd())
    const all = await loadSameRepoMessageLogs(paths)
    return filterResumableSessions(all, getSessionId())
  }, [])

  React.useEffect(() => {
    loadLogs()
      .then(loaded => {
        if (loaded.length === 0) {
          onDone('No saved conversations in this project.', { display: 'system' })
          return
        }
        setLogs(loaded)
        setFocusedKey(sessionKey(loaded[0]!))
      })
      .catch((error: unknown) => {
        logError(error as Error)
        onDone('Failed to load conversations', { display: 'system' })
      })
  }, [loadLogs, onDone])

  const close = React.useCallback(() => {
    onDone(undefined, { display: 'skip' })
  }, [onDone])

  const backToList = (log?: LogOption) => {
    if (log) setFocusedKey(sessionKey(log))
    setView({ kind: 'list' })
    setListVersion(v => v + 1)
  }

  const deleteLog = async (log: LogOption) => {
    if (!logs) return
    setPendingDeleteKey(null)
    setBusy(true)
    const index = logs.findIndex(l => sessionKey(l) === sessionKey(log))
    const sessionId = getSessionIdFromLog(log) ?? ''
    const title = getLogDisplayTitle(log)
    try {
      const result = await deleteSessionFiles({
        sessionId,
        transcriptPath: log.fullPath ?? getTranscriptPathForSession(sessionId),
        currentSessionId: getSessionId(),
      })
      if (!result.ok) {
        setNotice({ text: result.reason, error: true })
        backToList(log)
        return
      }
      const remaining = await loadLogs()
      if (remaining.length === 0) {
        onDone(`Deleted "${title}". No saved conversations left.`, { display: 'system' })
        return
      }
      setLogs(remaining)
      // Keep focus on the same row position rather than jumping elsewhere.
      setFocusedKey(sessionKey(remaining[Math.min(Math.max(index, 0), remaining.length - 1)]!))
      setNotice({ text: `Deleted "${title}".` })
      setView({ kind: 'list' })
      setListVersion(v => v + 1)
    } catch (error) {
      logError(error as Error)
      setNotice({ text: `Failed to delete "${title}": ${(error as Error).message}`, error: true })
      backToList(log)
    } finally {
      setBusy(false)
    }
  }

  const resumeLog = async (log: LogOption) => {
    const sessionId = validateUuid(getSessionIdFromLog(log))
    if (!sessionId) {
      setNotice({ text: 'Failed to resume conversation', error: true })
      return
    }
    setBusy(true)
    const fullLog = isLiteLog(log) ? await loadFullLog(log) : log
    await onResume(sessionId, fullLog, 'slash_command_picker')
  }

  useInput(
    (input, key) => {
      if (!logs || key.ctrl || key.meta) return
      const focused = logs.find(l => sessionKey(l) === focusedKey)
      if (input === 'd' && focused) {
        if (pendingDeleteKey === sessionKey(focused)) {
          void deleteLog(focused)
        } else {
          setPendingDeleteKey(sessionKey(focused))
          setNotice({ text: `Press d again to delete "${getLogDisplayTitle(focused)}".` })
        }
        return
      }
      if (pendingDeleteKey) {
        setPendingDeleteKey(null)
        setNotice(null)
      }
    },
    { isActive: view.kind === 'list' && !busy && logs !== null },
  )

  if (!logs) {
    return <Text dimColor>Loading conversations…</Text>
  }

  const noticeLine = notice ? (
    <Text color={notice.error ? 'error' : 'warning'}>{notice.text}</Text>
  ) : null

  if (view.kind === 'confirm-delete') {
    const { log } = view
    return (
      <Dialog
        title={`Delete "${getLogDisplayTitle(log)}"?`}
        subtitle={`${formatLogMetadata(log)} · This cannot be undone.`}
        color="error"
        onCancel={() => setView({ kind: 'actions', log, focus: 'delete' })}
      >
        <Select
          options={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Delete', value: 'delete', color: 'error' },
          ]}
          isDisabled={busy}
          onChange={value => {
            if (value === 'delete') void deleteLog(log)
            else setView({ kind: 'actions', log, focus: 'delete' })
          }}
          onCancel={() => setView({ kind: 'actions', log, focus: 'delete' })}
        />
      </Dialog>
    )
  }

  if (view.kind === 'actions') {
    const { log } = view
    return (
      <Dialog
        title={getLogDisplayTitle(log)}
        subtitle={formatLogMetadata(log)}
        onCancel={() => backToList(log)}
      >
        <Box flexDirection="column">
          {noticeLine}
          <Select
            options={[
              { label: 'Resume', value: 'resume', description: 'Continue this conversation' },
              { label: 'Delete', value: 'delete', description: 'Remove it from disk' },
              { label: 'Back', value: 'back', description: 'Return to the list' },
            ]}
            defaultFocusValue={view.focus}
            isDisabled={busy}
            onChange={value => {
              setNotice(null)
              if (value === 'resume') void resumeLog(log)
              else if (value === 'delete') setView({ kind: 'confirm-delete', log })
              else backToList(log)
            }}
            onCancel={() => backToList(log)}
          />
        </Box>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={`Sessions (${logs.length})`}
      subtitle={SESSIONS_LIST_HINT}
      onCancel={close}
    >
      <Box flexDirection="column">
        {noticeLine}
        <Select
          key={listVersion}
          options={logs.map(log => ({
            label: getLogDisplayTitle(log),
            value: sessionKey(log),
            description: formatLogMetadata(log),
            color: pendingDeleteKey === sessionKey(log) ? 'error' : undefined,
          }))}
          defaultFocusValue={focusedKey}
          isDisabled={busy}
          onFocus={setFocusedKey}
          onChange={value => {
            const log = logs.find(l => sessionKey(l) === value)
            if (!log) return
            setNotice(null)
            setPendingDeleteKey(null)
            setView({ kind: 'actions', log })
          }}
          onCancel={close}
        />
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const onResume: OnResume = async (sessionId, log, entrypoint) => {
    try {
      await context.resume?.(sessionId, log, entrypoint)
      onDone(undefined, { display: 'skip' })
    } catch (error) {
      logError(error as Error)
      onDone(`Failed to resume: ${(error as Error).message}`)
    }
  }
  return <SessionsManager onDone={onDone} onResume={onResume} />
}
