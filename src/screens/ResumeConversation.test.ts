import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'

import type { LogOption } from '../types/logs.js'
import { filterResumeLogs } from './resumeFilters.js'

const ts = '2026-06-30T00:00:00.000Z'

function id(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function log(
  sessionId: UUID,
  options: Partial<LogOption> = {},
): LogOption {
  return {
    date: ts,
    messages: [],
    fullPath: `/tmp/${sessionId}.jsonl`,
    value: 0,
    created: new Date(ts),
    modified: new Date(ts),
    firstPrompt: 'session',
    messageCount: 1,
    isSidechain: false,
    sessionId,
    ...options,
  }
}

test('filterResumeLogs preserves PR filters before picker grouping', () => {
  const prLog = log(id(1), {
    prNumber: 42,
    prUrl: 'https://github.com/Twigpine/openclaude/pull/42',
    prRepository: 'Twigpine/openclaude',
  })
  const otherPrLog = log(id(2), { prNumber: 77 })
  const nonPrLog = log(id(3))
  const sidechainLog = log(id(4), { isSidechain: true, prNumber: 42 })

  expect(filterResumeLogs([prLog, nonPrLog, sidechainLog], undefined)).toEqual([
    prLog,
    nonPrLog,
  ])
  expect(filterResumeLogs([prLog, nonPrLog, sidechainLog], false)).toEqual([
    prLog,
    nonPrLog,
  ])
  expect(
    filterResumeLogs([prLog, nonPrLog, sidechainLog], 'not-a-pr'),
  ).toEqual([prLog, nonPrLog])
  expect(filterResumeLogs([prLog, otherPrLog, nonPrLog], true)).toEqual([
    prLog,
    otherPrLog,
  ])
  expect(filterResumeLogs([prLog, otherPrLog, nonPrLog], 42)).toEqual([prLog])
  expect(
    filterResumeLogs(
      [prLog, otherPrLog, nonPrLog],
      'https://github.com/Twigpine/openclaude/pull/42',
    ),
  ).toEqual([prLog])
  expect(filterResumeLogs([prLog, sidechainLog], 42)).toEqual([prLog])
})
