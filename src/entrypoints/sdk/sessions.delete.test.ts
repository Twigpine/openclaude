import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { deleteSession } from './sessions.js'

let configDir = ''

beforeEach(async () => {
  await acquireSharedMutationLock('entrypoints/sdk/sessions.delete.test.ts')
  configDir = await mkdtemp(join(tmpdir(), 'openclaude-sessions-delete-'))
  setClaudeConfigHomeDirForTesting(configDir)
})

afterEach(async () => {
  try {
    setClaudeConfigHomeDirForTesting(undefined)
    if (configDir) await rm(configDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

async function seedSessionFile(
  sessionId: string,
  projectPath: string,
): Promise<string> {
  const dir = getProjectDir(projectPath)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${sessionId}.jsonl`)
  await writeFile(
    filePath,
    `{"type":"user","uuid":"${sessionId}","sessionId":"${sessionId}"}\n`,
  )
  return filePath
}

describe('deleteSession', () => {
  test('rejects invalid session ids without touching disk', async () => {
    await expect(deleteSession('not-a-uuid')).rejects.toThrow(
      'Invalid session ID',
    )
    await expect(deleteSession('../../etc/passwd')).rejects.toThrow(
      'Invalid session ID',
    )
  })

  test('throws Session not found for a missing id', async () => {
    const missing = randomUUID()
    await expect(deleteSession(missing)).rejects.toThrow(
      `Session not found: ${missing}`,
    )
  })

  test('unlinks the JSONL file resolved via global search', async () => {
    const sessionId = randomUUID()
    const filePath = await seedSessionFile(sessionId, 'C:\\work\\proj')
    expect(existsSync(filePath)).toBe(true)
    await deleteSession(sessionId)
    expect(existsSync(filePath)).toBe(false)
  })

  test('unlinks via an explicit project dir', async () => {
    const sessionId = randomUUID()
    const projectPath = 'C:\\work\\proj'
    const filePath = await seedSessionFile(sessionId, projectPath)
    await deleteSession(sessionId, { dir: projectPath })
    expect(existsSync(filePath)).toBe(false)
  })

  test('second delete reports Session not found (raced-delete contract)', async () => {
    const sessionId = randomUUID()
    await seedSessionFile(sessionId, 'C:\\work\\proj')
    await deleteSession(sessionId)
    await expect(deleteSession(sessionId)).rejects.toThrow(
      'Session not found',
    )
  })
})
