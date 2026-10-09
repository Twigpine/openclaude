import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { logError } from './log.js'
import { forgetDeletedSession, restoreSessionWrites } from './sessionStorage.js'
import { validateUuid } from './uuid.js'

export type DeleteSessionResult =
  | { ok: true; removed: string[] }
  | { ok: false; reason: string }

/**
 * Deletes a saved conversation from disk: the transcript
 * (`<projectDir>/<sessionId>.jsonl`) plus its sidecars, the same set
 * `cleanupOldSessionFiles` removes (`.cast`, `.replay.json` and the
 * `<sessionId>/` dir holding tool-results and subagent transcripts).
 *
 * Refuses the active session: its transcript is still being appended to, and
 * removing it under a live REPL breaks later writes.
 */
export async function deleteSessionFiles({
  sessionId,
  transcriptPath,
  currentSessionId,
}: {
  sessionId: string
  transcriptPath: string
  currentSessionId: string
}): Promise<DeleteSessionResult> {
  const id = validateUuid(sessionId)
  if (!id) {
    return { ok: false, reason: `Invalid session id: ${sessionId}` }
  }
  if (id === currentSessionId) {
    return { ok: false, reason: 'The current session cannot be deleted.' }
  }
  // Only ever touch files named after the validated id, next to the transcript.
  if (basename(transcriptPath) !== `${id}.jsonl`) {
    return {
      ok: false,
      reason: `Transcript path does not match session ${id}.`,
    }
  }

  // Block later writes first, or a pending AI title/summary/metadata append
  // recreates the transcript and the session comes back.
  try {
    await forgetDeletedSession(id, transcriptPath)
  } catch (error) {
    // Nothing was removed (a pending write failed while settling): undo the
    // mark so the still-present transcript keeps receiving writes.
    restoreSessionWrites(transcriptPath)
    throw error
  }

  const projectDir = dirname(transcriptPath)
  const targets = [
    transcriptPath,
    join(projectDir, `${id}.cast`),
    join(projectDir, `${id}.replay.json`),
    join(projectDir, id),
  ]
  // force: sidecars are optional, so a missing one is not an error.
  // allSettled: decide on the transcript only after every removal finished,
  // or a fast sidecar failure would restore writes mid-removal.
  const results = await Promise.allSettled(
    targets.map(target => rm(target, { recursive: true, force: true })),
  )
  const failures = results.flatMap(result =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length > 0 && existsSync(transcriptPath)) {
    // The transcript survived (e.g. EBUSY on Windows): stop dropping writes
    // to it, or disk and this process disagree until restart.
    restoreSessionWrites(transcriptPath)
    throw failures[0]
  }
  // The transcript is gone, so the conversation is deleted; a sidecar that
  // could not be removed is only an orphan, like any missing one.
  for (const failure of failures) logError(failure)
  return {
    ok: true,
    removed: targets.filter((_, i) => results[i]!.status === 'fulfilled'),
  }
}
