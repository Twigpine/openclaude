/**
 * duo — session persistence (save/load debates).
 *
 * Writes full debate state to JSON files in ~/.duo/sessions/ so debates can
 * be resumed across app restarts. The saved state includes:
 *   - all config (models, rounds, protocol, grounded, adversarial, etc.)
 *   - conversation history (builtin) or transcript (cli)
 *   - budget config and usage so far
 *   - session name for identification
 *
 * File format is versioned (v1) for future migrations.
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { DuoState, DuoResult, DuoStats, DuoSide } from './types.js'

export const PERSISTENCE_VERSION = 1
export const SESSION_DIR = join(homedir(), '.duo', 'sessions')

export type PersistedSession = {
  version: number
  savedAt: number
  name: string
  state: DuoState
  lastResult?: DuoResult
  lastStats?: DuoStats
}

function sessionPath(name: string): string {
  return join(SESSION_DIR, `${name}.json`)
}

/** Ensure the session directory exists. */
export async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(SESSION_DIR, { recursive: true })
}

/** List all saved sessions with basic metadata. */
export async function listSessions(): Promise<Array<{ name: string; savedAt: number; question: string; rounds: number }>> {
  await ensureSessionDir()
  const files = await fs.readdir(SESSION_DIR)
  const sessions: Array<{ name: string; savedAt: number; question: string; rounds: number }> = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const path = sessionPath(file.slice(0, -5))
      const data = JSON.parse(await fs.readFile(path, 'utf-8')) as PersistedSession
      sessions.push({
        name: data.name,
        savedAt: data.savedAt,
        question: data.state.history?.A?.[0]?.text ?? data.lastResult?.entries[0]?.text ?? '(unknown)',
        rounds: data.state.rounds,
      })
    } catch { /* skip corrupt files */ }
  }
  return sessions.sort((a, b) => b.savedAt - a.savedAt)
}

/** Save a session to disk. */
export async function saveSession(name: string, state: DuoState, result?: DuoResult, stats?: DuoStats): Promise<void> {
  await ensureSessionDir()
  const payload: PersistedSession = {
    version: PERSISTENCE_VERSION,
    savedAt: Date.now(),
    name,
    state: {
      ...state,
      sessionName: name,
    },
    lastResult: result,
    lastStats: stats,
  }
  await fs.writeFile(sessionPath(name), JSON.stringify(payload, null, 2))
}

/** Load a session from disk. Returns null if not found. */
export async function loadSession(name: string): Promise<PersistedSession | null> {
  try {
    const data = JSON.parse(await fs.readFile(sessionPath(name), 'utf-8')) as PersistedSession
    if (data.version !== PERSISTENCE_VERSION) {
      throw new Error(`session version ${data.version} not supported (current: ${PERSISTENCE_VERSION})`)
    }
    return data
  } catch {
    return null
  }
}

/** Delete a session. */
export async function deleteSession(name: string): Promise<boolean> {
  try {
    await fs.unlink(sessionPath(name))
    return true
  } catch {
    return false
  }
}