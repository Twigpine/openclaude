import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { deleteSessionFiles } from './sessionDeletion.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CURRENT = '33333333-3333-4333-8333-333333333333'

let projectDir: string

async function writeSession(id: string): Promise<string> {
  const transcript = join(projectDir, `${id}.jsonl`)
  await writeFile(transcript, '{}\n')
  await writeFile(join(projectDir, `${id}.cast`), '')
  await writeFile(join(projectDir, `${id}.replay.json`), '{}')
  await mkdir(join(projectDir, id, 'tool-results'), { recursive: true })
  await writeFile(join(projectDir, id, 'tool-results', 'out.txt'), 'x')
  return transcript
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'openclaude-session-delete-'))
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('deleteSessionFiles', () => {
  test('removes the transcript and every sidecar, leaving other sessions', async () => {
    const transcript = await writeSession(SESSION)
    const other = await writeSession(OTHER)

    const result = await deleteSessionFiles({
      sessionId: SESSION,
      transcriptPath: transcript,
      currentSessionId: CURRENT,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(transcript)).toBe(false)
    expect(existsSync(join(projectDir, `${SESSION}.cast`))).toBe(false)
    expect(existsSync(join(projectDir, `${SESSION}.replay.json`))).toBe(false)
    expect(existsSync(join(projectDir, SESSION))).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(join(projectDir, OTHER))).toBe(true)
  })

  test('succeeds when optional sidecars are missing', async () => {
    const transcript = join(projectDir, `${SESSION}.jsonl`)
    await writeFile(transcript, '{}\n')

    const result = await deleteSessionFiles({
      sessionId: SESSION,
      transcriptPath: transcript,
      currentSessionId: CURRENT,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(transcript)).toBe(false)
  })

  test('refuses to delete the current session', async () => {
    const transcript = await writeSession(CURRENT)

    const result = await deleteSessionFiles({
      sessionId: CURRENT,
      transcriptPath: transcript,
      currentSessionId: CURRENT,
    })

    expect(result).toEqual({
      ok: false,
      reason: 'The current session cannot be deleted.',
    })
    expect(existsSync(transcript)).toBe(true)
  })

  test('rejects ids that are not UUIDs, so paths cannot escape the project dir', async () => {
    const result = await deleteSessionFiles({
      sessionId: '../../etc',
      transcriptPath: join(projectDir, '../../etc.jsonl'),
      currentSessionId: CURRENT,
    })

    expect(result.ok).toBe(false)
  })

  test('rejects a transcript path that belongs to another session', async () => {
    const other = await writeSession(OTHER)

    const result = await deleteSessionFiles({
      sessionId: SESSION,
      transcriptPath: other,
      currentSessionId: CURRENT,
    })

    expect(result.ok).toBe(false)
    expect(existsSync(other)).toBe(true)
  })
})
