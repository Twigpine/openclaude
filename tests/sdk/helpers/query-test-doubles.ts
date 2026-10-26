import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { getProjectDir } from '../../../src/utils/sessionStoragePortable.js'
import type { Query, SDKMessage } from '../../../src/entrypoints/sdk/index.js'

let tempDirLockPromise: Promise<void> | null = null

/**
 * Creates a temp directory and returns its path.
 * Caller is responsible for cleanup (use withTempDir for auto-cleanup).
 */
export function createTempDir(prefix: string = 'sdk-test'): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Creates a temp directory, runs the callback, then cleans up.
 * Returns the callback's result.
 */
export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
  prefix: string = 'sdk-test',
): Promise<T> {
  while (tempDirLockPromise) {
    await tempDirLockPromise
  }

  let releaseLock: (() => void) | undefined
  tempDirLockPromise = new Promise<void>(resolve => {
    releaseLock = resolve
  })

  const dir = createTempDir(prefix)
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousSimpleMode = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.CLAUDE_CODE_SIMPLE = '1'
  try {
    return await fn(dir)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    if (previousSimpleMode === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = previousSimpleMode
    }
    rmSync(dir, { recursive: true, force: true })
    tempDirLockPromise = null
    releaseLock?.()
  }
}

/**
 * Creates a fake session JSONL file in the correct project directory
 * for the given `cwd`. Returns the session directory path.
 *
 * The JSONL file is placed at `<projects-dir>/<sanitized-cwd>/<sessionId>.jsonl`.
 */
export function createSessionJsonl(
  cwd: string,
  sessionId: string,
  entries: Array<Record<string, unknown>>,
): string {
  const canonicalCwd = (() => {
    try {
      return realpathSync(cwd)
    } catch {
      return cwd
    }
  })()
  const sessionDir = getProjectDir(canonicalCwd)
  mkdirSync(sessionDir, { recursive: true })
  const filePath = join(sessionDir, `${sessionId}.jsonl`)
  const lines = entries.map(e => JSON.stringify(e))
  writeFileSync(filePath, lines.join('\n') + '\n', { encoding: 'utf8' })
  return sessionDir
}

/**
 * Generates a minimal conversation JSONL entry set: one user + one assistant message.
 * Returns entries with valid UUID chains.
 */
export function createMinimalConversation(sessionId: string): Array<Record<string, unknown>> {
  const userUuid = randomUUID()
  const assistantUuid = randomUUID()
  return [
    {
      type: 'user',
      message: { role: 'user', content: 'hello from test' },
      uuid: userUuid,
      parentUuid: null,
      sessionId,
      isSidechain: false,
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi from assistant' }] },
      uuid: assistantUuid,
      parentUuid: userUuid,
      sessionId,
      isSidechain: false,
    },
  ]
}

/**
 * Generates a multi-turn conversation with `turns` user/assistant pairs.
 * Each pair links via parentUuid chain.
 */
export function createMultiTurnConversation(
  sessionId: string,
  turns: number,
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = []
  let lastUuid: string | null = null

  for (let i = 0; i < turns; i++) {
    const userUuid = randomUUID()
    const assistantUuid = randomUUID()

    entries.push({
      type: 'user',
      message: { role: 'user', content: `turn ${i + 1}` },
      uuid: userUuid,
      parentUuid: lastUuid,
      sessionId,
      isSidechain: false,
    })

    entries.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `response ${i + 1}` }] },
      uuid: assistantUuid,
      parentUuid: userUuid,
      sessionId,
      isSidechain: false,
    })

    lastUuid = assistantUuid
  }

  return entries
}

/**
 * Safely drains a query's async iterator, catching only expected lifecycle
 * abort errors.
 * Returns all collected SDKMessages.
 */
export async function drainQuery(q: Query): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  try {
    for await (const msg of q) {
      messages.push(msg)
    }
  } catch (err) {
    if (!isExpectedDrainAbort(err)) {
      throw err
    }
  }
  return messages
}

export function isExpectedDrainAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const text = `${err.name}\n${err.message}`.toLowerCase()
  return (
    text.includes('abort') ||
    text.includes('interrupt') ||
    text.includes('cancel') ||
    text.includes('closed')
  )
}

/**
 * Collects all messages from a query without suppressing errors.
 * Use when you expect the query to complete normally.
 */
export async function collectMessages(q: Query): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  for await (const msg of q) {
    messages.push(msg)
  }
  return messages
}

/**
 * Creates a UUID regex pattern for validation.
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i


type EngineView = Omit<import('../../../src/QueryEngine.js').QueryEngine, 'config'>
  & { config: import('../../../src/QueryEngine.js').QueryEngineConfig }

/** Explicit test view for engine injection and private state assertions. */
export function queryInternals(query: Query) {
  return query as unknown as {
    engine: EngineView
    _engine: EngineView | null
    appStateStore: import('../../../src/state/store.js').Store<import('../../../src/state/AppStateStore.js').AppState>
    setEngine(engine: import('./mock-engine.js').MockQueryEngine): void
    registerPendingPermission(id: string): Promise<import('../../../src/entrypoints/sdk/permissions.js').PermissionResolveDecision>
  }
}

export function sessionInternals(session: import('../../../src/entrypoints/sdk/index.js').SDKSession) {
  return session as unknown as {
    _engine: EngineView | null
    setEngine(engine: import('./mock-engine.js').MockQueryEngine): void
  }
}

export function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return typeof block === 'object' && block !== null &&
    'type' in block && block.type === 'text' &&
    'text' in block && typeof block.text === 'string'
}
