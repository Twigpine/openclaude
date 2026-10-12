import { describe, expect, test } from 'bun:test'

import { getDeleteBlockReason } from './resumeDeleteGuards.js'

const active = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const bgRunning = '33333333-3333-4333-8333-333333333333'

describe('getDeleteBlockReason', () => {
  test('blocks entries without a resolvable session id', () => {
    expect(getDeleteBlockReason(undefined, active, new Set())).toBe(
      'Cannot determine the session id for this entry.',
    )
  })

  test('never allows deleting the active session file', () => {
    expect(getDeleteBlockReason(active, active, new Set())).toBe(
      'Cannot delete the active session.',
    )
  })

  test('blocks sessions with a live background process', () => {
    expect(
      getDeleteBlockReason(bgRunning, active, new Set([bgRunning])),
    ).toBe('Stop the background session first before deleting.')
  })

  test('allows deleting an idle, non-active session', () => {
    expect(getDeleteBlockReason(other, active, new Set([bgRunning]))).toBeNull()
  })
})
