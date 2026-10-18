import { describe, expect, it } from 'bun:test'
import {
  hasDangerousSkipFlag,
  isDangerousSkipFlag,
  stripDangerousSkipFlags,
} from './dangerousSkipFlags.js'

// Runtime coverage for the shared strip logic behind the direct-connect and
// ssh argv rewrites in main.tsx. The single-token removal these replaced let a
// second dangerous-skip token survive and silently re-enable bypass.
describe('dangerousSkipFlags', () => {
  it('recognizes both the canonical flag and the --yolo alias', () => {
    expect(isDangerousSkipFlag('--dangerously-skip-permissions')).toBe(true)
    expect(isDangerousSkipFlag('--yolo')).toBe(true)
    expect(isDangerousSkipFlag('--dangerously-skip')).toBe(false)
    expect(isDangerousSkipFlag('--yolo=true')).toBe(false)
    expect(isDangerousSkipFlag('-p')).toBe(false)
  })

  it('detects presence of either spelling', () => {
    expect(hasDangerousSkipFlag(['ssh', 'host', '--yolo'])).toBe(true)
    expect(
      hasDangerousSkipFlag(['ssh', 'host', '--dangerously-skip-permissions']),
    ).toBe(true)
    expect(hasDangerousSkipFlag(['ssh', 'host', '-p', 'hi'])).toBe(false)
  })

  it('strips every dangerous-skip token — both spellings and repeats', () => {
    expect(
      stripDangerousSkipFlags([
        'ssh',
        '--yolo',
        'host',
        '--dangerously-skip-permissions',
        '--yolo',
        '/tmp',
      ]),
    ).toEqual(['ssh', 'host', '/tmp'])
  })

  it('leaves argv untouched when no dangerous-skip token is present', () => {
    const argv = ['ssh', 'host', '--permission-mode', 'auto']
    expect(stripDangerousSkipFlags(argv)).toEqual(argv)
  })

  it('does not mutate the input array', () => {
    const argv = ['--yolo', 'x']
    stripDangerousSkipFlags(argv)
    expect(argv).toEqual(['--yolo', 'x'])
  })
})
