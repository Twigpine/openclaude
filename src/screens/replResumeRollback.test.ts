/**
 * Regression tests for resume transactional consistency in REPL.tsx.
 *
 * CodeRabbit finding on PR #2573: in the resume flow, switchSession and
 * setMessages publish the resumed session before later fallible work (worktree
 * restore, dynamic compact-prompt import). withCodeModeResumeActivation rolls
 * back only the conversation mode on failure, so a failure after publication
 * left the target session id and transcript installed under the prior mode.
 * Session id, messages, and mode must describe one conversation after any
 * failed resume.
 *
 * REPL.tsx cannot be imported in the test environment (feature() from
 * bun:bundle only compiles under the bundler), so the wiring is verified by
 * source scan, the same approach as REPL.queryLifecycle.test.ts and
 * replStreamingTextClear.test.ts. The rollback mechanism itself is exercised
 * behaviorally against the real bootstrap session state.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'

const source = readFileSync(join(import.meta.dirname, 'REPL.tsx'), 'utf8')

function getResumeBody(): string {
  const start = source.indexOf('const resume = useCallback(async (sessionId: UUID')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('}, [resetLoadingState, resetAutoCompactTracking, setAppState])', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function getResumeCatchBody(): string {
  const body = getResumeBody()
  const catchStart = body.indexOf('} catch (error) {')
  expect(catchStart).toBeGreaterThan(-1)
  return body.slice(catchStart)
}

describe('REPL resume rollback wiring', () => {
  test('captures the prior session identity and messages before the fallible resume work', () => {
    const body = getResumeBody()
    const activationIndex = body.indexOf('await withCodeModeResumeActivation(')
    expect(activationIndex).toBeGreaterThan(-1)
    const snapshotIndex = body.indexOf('getSessionProjectDir()')
    expect(snapshotIndex).toBeGreaterThan(-1)
    expect(snapshotIndex).toBeLessThan(activationIndex)
    const messagesSnapshotIndex = body.indexOf('messagesRef.current')
    expect(messagesSnapshotIndex).toBeGreaterThan(-1)
    expect(messagesSnapshotIndex).toBeLessThan(activationIndex)
  })

  test('restores the prior session identity in the failure path', () => {
    const catchBody = getResumeCatchBody()
    // The rollback must switch back to the session snapshot captured before
    // publication, carrying the prior project directory with it so the id and
    // transcript path never drift apart.
    expect(catchBody).toMatch(/switchSession\(\s*preResumeSessionId,\s*preResumeSessionProjectDir\s*\)/)
  })

  test('restores the prior messages in the failure path', () => {
    const catchBody = getResumeCatchBody()
    expect(catchBody).toContain('setMessages(() => preResumeMessages)')
  })

  test('resets the transcript file pointer when rolling the session back', () => {
    const catchBody = getResumeCatchBody()
    // The forward flow adopts the target session's file before the fallible
    // compact-prompt import. Without a reset, post-rollback writes would
    // append the prior conversation's records to the target's transcript.
    const switchBackIndex = catchBody.indexOf('switchSession(preResumeSessionId, preResumeSessionProjectDir)')
    const resetIndex = catchBody.indexOf('resetSessionFilePointer()')
    expect(switchBackIndex).toBeGreaterThan(-1)
    expect(resetIndex).toBeGreaterThan(switchBackIndex)
  })

  test('does not clear the prior session metadata cache when rolling back', () => {
    const catchBody = getResumeCatchBody()
    // Metadata is keyed by session identity. After switchSession returns to
    // the prior session, clearSessionMetadata() would delete the prior
    // session's own cache, not the target's. The target cache cannot leak
    // across that key boundary, so rollback must leave both caches alone.
    expect(catchBody).not.toContain('clearSessionMetadata()')
  })

  test('captures and restores the prior agent publication on failure', () => {
    const body = getResumeBody()
    const activationIndex = body.indexOf('await withCodeModeResumeActivation(')
    expect(body.indexOf('preResumeMainThreadAgentDefinition')).toBeGreaterThan(-1)
    expect(body.indexOf('preResumeMainThreadAgentDefinition')).toBeLessThan(activationIndex)
    expect(body.indexOf('preResumeStandaloneAgentContext')).toBeGreaterThan(-1)
    expect(body.indexOf('preResumeStandaloneAgentContext')).toBeLessThan(activationIndex)

    const catchBody = getResumeCatchBody()
    const agentRestoreIndex = catchBody.indexOf('setMainThreadAgentDefinition(preResumeMainThreadAgentDefinition)')
    const messageRestoreIndex = catchBody.indexOf('setMessages(() => preResumeMessages)')
    const throwIndex = catchBody.indexOf('throw error')
    expect(agentRestoreIndex).toBeGreaterThan(-1)
    expect(agentRestoreIndex).toBeLessThan(messageRestoreIndex)
    expect(agentRestoreIndex).toBeLessThan(throwIndex)
    expect(catchBody).toContain('agent: preResumeAgentState')
    expect(catchBody).toContain('standaloneAgentContext: preResumeStandaloneAgentContext')
  })

  test('restores prior messages unconditionally because React updates may still be queued', () => {
    const catchBody = getResumeCatchBody()
    expect(catchBody).toContain('setMessages(() => preResumeMessages)')
    expect(catchBody).not.toContain('if (messagesRef.current !== preResumeMessages)')
  })

  test('rolls back before rethrowing so observers never see the mixed state', () => {
    const catchBody = getResumeCatchBody()
    const rollbackIndex = catchBody.indexOf('setMessages(() => preResumeMessages)')
    const throwIndex = catchBody.indexOf('throw error')
    expect(rollbackIndex).toBeGreaterThan(-1)
    expect(throwIndex).toBeGreaterThan(-1)
    expect(rollbackIndex).toBeLessThan(throwIndex)
  })

  test('keeps the mode rollback inside withCodeModeResumeActivation', () => {
    const body = getResumeBody()
    // The compatibility validation and mode snapshot/restore are owned by the
    // helper; the catch must not bypass or reimplement them.
    expect(body).toContain('await withCodeModeResumeActivation(log.codeMode')
    const catchBody = getResumeCatchBody()
    expect(catchBody).not.toContain('setReplModeForConversation')
  })
})

describe('session identity rollback mechanism', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()

  afterEach(() => {
    switchSession(originalSessionId, originalProjectDir)
  })

  test('switchSession can restore a prior session id and project dir together', () => {
    const priorSessionId = getSessionId()
    const priorProjectDir = getSessionProjectDir()

    // Mirror the publication order of the resume flow: the target session is
    // installed, then a failure requires returning to the prior conversation.
    const targetSessionId = asSessionId('00000000-0000-4000-8000-000000009999')
    switchSession(targetSessionId, '/tmp/some-other-project')
    expect(getSessionId()).toBe(targetSessionId)

    switchSession(priorSessionId, priorProjectDir)
    expect(getSessionId()).toBe(priorSessionId)
    expect(getSessionProjectDir()).toBe(priorProjectDir)
  })
})
