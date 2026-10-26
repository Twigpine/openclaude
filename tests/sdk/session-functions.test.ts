import type { JsonlEntry } from '../../src/entrypoints/sdk/shared.js'
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  tagSession,
  deleteSession,
  forkSession,
} from '../../src/entrypoints/sdk/index.js'
import { readJSONLFile } from '../../src/utils/json.js'
import { getProjectDir } from '../../src/utils/sessionStoragePortable.js'

describe('SDK session functions', () => {
  test('listSessions returns array', async () => {
    const sessions = await listSessions()
    expect(Array.isArray(sessions)).toBe(true)
  })

  test('listSessions with dir returns array', async () => {
    const sessions = await listSessions({ dir: process.cwd() })
    expect(Array.isArray(sessions)).toBe(true)
  })

  test('getSessionInfo returns undefined for non-existent session', async () => {
    const info = await getSessionInfo('00000000-0000-0000-0000-000000000000')
    expect(info).toBeUndefined()
  })

  test('getSessionMessages returns empty array for non-existent session', async () => {
    const messages = await getSessionMessages('00000000-0000-0000-0000-000000000000')
    expect(messages).toEqual([])
  })

  test('renameSession throws for non-existent session', async () => {
    await expect(renameSession('00000000-0000-0000-0000-000000000000', 'test'))
      .rejects.toThrow('Session not found')
  })

  test('forkSession throws for non-existent session', async () => {
    await expect(forkSession('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow('Session not found')
  })

  test('session ID validation rejects invalid UUID', async () => {
    await expect(getSessionInfo('not-a-uuid'))
      .rejects.toThrow('Invalid session ID')
  })
})

describe('forkSession metadata preservation (COR-2)', () => {
  const testProjectDir = join(tmpdir(), 'fork-metadata-test-' + process.pid)
  let sessionDir: string

  beforeEach(() => {
    sessionDir = getProjectDir(testProjectDir)
    mkdirSync(sessionDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  test('forked session preserves title and tag metadata', async () => {
    const sourceId = randomUUID()
    const sourcePath = join(sessionDir, `${sourceId}.jsonl`)
    const userUuid = randomUUID()
    const assistantUuid = randomUUID()

    const entries = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        uuid: userUuid,
        parentUuid: null,
        sessionId: sourceId,
        isSidechain: false,
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        uuid: assistantUuid,
        parentUuid: userUuid,
        sessionId: sourceId,
        isSidechain: false,
      }),
      JSON.stringify({
        type: 'custom-title',
        customTitle: 'My Test Session',
        sessionId: sourceId,
      }),
      JSON.stringify({
        type: 'tag',
        tag: 'important',
        sessionId: sourceId,
      }),
    ]
    writeFileSync(sourcePath, entries.join('\n') + '\n', { encoding: 'utf8' })

    const result = await forkSession(sourceId, { dir: testProjectDir })

    expect(result.sessionId).toBeDefined()
    expect(result.sessionId).not.toBe(sourceId)

    const forkedPath = join(sessionDir, `${result.sessionId}.jsonl`)
    const forkedEntries = await readJSONLFile<JsonlEntry>(forkedPath)

    const titleEntry = forkedEntries.find(e => e.type === 'custom-title')
    const tagEntry = forkedEntries.find(e => e.type === 'tag')

    expect(titleEntry).toBeDefined()
    expect(titleEntry!.customTitle).toBe('My Test Session')
    expect(titleEntry!.sessionId).toBe(result.sessionId)

    expect(tagEntry).toBeDefined()
    expect(tagEntry!.tag).toBe('important')
    expect(tagEntry!.sessionId).toBe(result.sessionId)
  })
})

describe('renameSession', () => {
  const testProjectDir = join(tmpdir(), 'rename-test-' + process.pid)
  let sessionDir: string

  beforeEach(() => {
    sessionDir = getProjectDir(testProjectDir)
    mkdirSync(sessionDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  test('appends custom-title entry to existing session', async () => {
    const sid = randomUUID()
    const filePath = join(sessionDir, `${sid}.jsonl`)
    writeFileSync(filePath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sid,
      isSidechain: false,
    }) + '\n', { encoding: 'utf8' })

    await renameSession(sid, 'My Renamed Session', { dir: testProjectDir })

    const entries = await readJSONLFile<JsonlEntry>(filePath)
    const titleEntry = entries.find(e => e.type === 'custom-title')
    expect(titleEntry).toBeDefined()
    expect(titleEntry!.customTitle).toBe('My Renamed Session')
    expect(titleEntry!.sessionId).toBe(sid)
  })

  test('throws for non-existent session', async () => {
    await expect(
      renameSession('00000000-0000-0000-0000-000000000000', 'test', { dir: testProjectDir }),
    ).rejects.toThrow('Session not found')
  })

  test('throws for invalid session ID', async () => {
    await expect(
      renameSession('not-a-uuid', 'test'),
    ).rejects.toThrow('Invalid session ID')
  })
})

describe('tagSession', () => {
  const testProjectDir = join(tmpdir(), 'tag-test-' + process.pid)
  let sessionDir: string

  beforeEach(() => {
    sessionDir = getProjectDir(testProjectDir)
    mkdirSync(sessionDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  test('appends tag entry to existing session', async () => {
    const sid = randomUUID()
    const filePath = join(sessionDir, `${sid}.jsonl`)
    writeFileSync(filePath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sid,
      isSidechain: false,
    }) + '\n', { encoding: 'utf8' })

    await tagSession(sid, 'important', { dir: testProjectDir })

    const entries = await readJSONLFile<JsonlEntry>(filePath)
    const tagEntry = entries.find(e => e.type === 'tag')
    expect(tagEntry).toBeDefined()
    expect(tagEntry!.tag).toBe('important')
    expect(tagEntry!.sessionId).toBe(sid)
  })

  test('clears tag when null is passed', async () => {
    const sid = randomUUID()
    const filePath = join(sessionDir, `${sid}.jsonl`)
    writeFileSync(filePath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sid,
      isSidechain: false,
    }) + '\n', { encoding: 'utf8' })

    await tagSession(sid, null, { dir: testProjectDir })

    const entries = await readJSONLFile<JsonlEntry>(filePath)
    const tagEntry = entries.find(e => e.type === 'tag')
    expect(tagEntry).toBeDefined()
    expect(tagEntry!.tag).toBe('')
  })

  test('throws for invalid session ID', async () => {
    await expect(
      tagSession('not-a-uuid', 'tag'),
    ).rejects.toThrow('Invalid session ID')
  })
})

describe('deleteSession', () => {
  const testProjectDir = join(tmpdir(), 'delete-test-' + process.pid)
  let sessionDir: string

  beforeEach(() => {
    sessionDir = getProjectDir(testProjectDir)
    mkdirSync(sessionDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  test('deletes existing session file', async () => {
    const sid = randomUUID()
    const filePath = join(sessionDir, `${sid}.jsonl`)
    writeFileSync(filePath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sid,
      isSidechain: false,
    }) + '\n', { encoding: 'utf8' })

    // Verify file exists before deletion
    const { statSync } = await import('fs')
    expect(() => statSync(filePath)).not.toThrow()

    await deleteSession(sid, { dir: testProjectDir })

    // File should no longer exist
    expect(() => statSync(filePath)).toThrow()
  })

  test('deleted session is no longer found by getSessionInfo', async () => {
    const sid = randomUUID()
    const filePath = join(sessionDir, `${sid}.jsonl`)
    writeFileSync(filePath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sid,
      isSidechain: false,
    }) + '\n', { encoding: 'utf8' })

    await deleteSession(sid, { dir: testProjectDir })

    const info = await getSessionInfo(sid, { dir: testProjectDir })
    expect(info).toBeUndefined()
  })

  test('throws for non-existent session', async () => {
    await expect(
      deleteSession('00000000-0000-0000-0000-000000000000', { dir: testProjectDir }),
    ).rejects.toThrow('Session not found')
  })

  test('throws for invalid session ID', async () => {
    await expect(
      deleteSession('not-a-uuid'),
    ).rejects.toThrow('Invalid session ID')
  })
})

describe('E2E: session lifecycle — create → read → mutate → fork → delete', () => {
  const testProjectDir = join(tmpdir(), 'e2e-lifecycle-' + process.pid)
  let sessionDir: string

  beforeEach(() => {
    sessionDir = getProjectDir(testProjectDir)
    mkdirSync(sessionDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  test('full lifecycle preserves data at every step', async () => {
    const sid = randomUUID()
    const filePath = join(sessionDir, `${sid}.jsonl`)

    // Step 1: Create session with conversation
    const userUuid = randomUUID()
    const assistantUuid = randomUUID()
    writeFileSync(filePath, [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello from e2e' },
        uuid: userUuid,
        parentUuid: null,
        sessionId: sid,
        isSidechain: false,
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi from assistant' }] },
        uuid: assistantUuid,
        parentUuid: userUuid,
        sessionId: sid,
        isSidechain: false,
      }),
    ].join('\n') + '\n', { encoding: 'utf8' })

    // Step 2: Read messages — should find 2
    const messages = await getSessionMessages(sid, { dir: testProjectDir })
    expect(messages.length).toBeGreaterThanOrEqual(2)

    // Step 3: Rename — should append title entry
    await renameSession(sid, 'E2E Test Session', { dir: testProjectDir })
    const entriesAfterRename = await readJSONLFile<JsonlEntry>(filePath)
    const titleEntry = entriesAfterRename.find(e => e.type === 'custom-title')
    expect(titleEntry!.customTitle).toBe('E2E Test Session')

    // Step 4: Tag — should append tag entry
    await tagSession(sid, 'e2e-tag', { dir: testProjectDir })
    const entriesAfterTag = await readJSONLFile<JsonlEntry>(filePath)
    const tagEntry = entriesAfterTag.find(e => e.type === 'tag')
    expect(tagEntry!.tag).toBe('e2e-tag')

    // Step 5: Fork — should create new session with remapped UUIDs
    const forked = await forkSession(sid, { dir: testProjectDir, title: 'Forked Copy' })
    expect(forked.sessionId).not.toBe(sid)
    const forkedPath = join(sessionDir, `${forked.sessionId}.jsonl`)
    const forkedEntries = await readJSONLFile<JsonlEntry>(forkedPath)

    // Forked session should have remapped UUIDs (different from originals)
    const forkedUser = forkedEntries.find(e => e.type === 'user')
    expect(forkedUser!.uuid).not.toBe(userUuid)
    // But same content
    expect(forkedUser!.message!.content).toBe('hello from e2e')
    // Forked from reference should exist
    expect(forkedUser!.forkedFrom).toBeDefined()
    expect((forkedUser!.forkedFrom as { sessionId: string; messageUuid: string }).sessionId).toBe(sid)

    // Forked title should be set (appended after metadata copy, so last custom-title wins)
    const forkedTitles = forkedEntries.filter(e => e.type === 'custom-title')
    expect(forkedTitles.length).toBeGreaterThanOrEqual(1)
    // The last custom-title entry should be the one set by fork options
    const forkedTitle = forkedTitles[forkedTitles.length - 1]
    expect(forkedTitle.customTitle).toBe('Forked Copy')

    // Step 6: Delete original — forked should still exist
    await deleteSession(sid, { dir: testProjectDir })
    const deletedInfo = await getSessionInfo(sid, { dir: testProjectDir })
    expect(deletedInfo).toBeUndefined()

    // Forked session should still be readable
    const forkedMessages = await getSessionMessages(forked.sessionId, { dir: testProjectDir })
    expect(forkedMessages.length).toBeGreaterThanOrEqual(2)
  })
})
