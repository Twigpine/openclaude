import { describe, expect, test } from 'bun:test'

import { formatReplPermissionPreview } from './REPLPermissionRequest.js'

describe('formatReplPermissionPreview', () => {
  test('bounds large scripts while preserving head and tail evidence', () => {
    const code = `HEAD_START\n${'middle-'.repeat(3_000)}\nTAIL_END`
    const preview = formatReplPermissionPreview(code)

    expect(preview.omittedCharacters).toBeGreaterThan(0)
    expect(preview.text.length).toBeLessThan(8_200)
    expect(preview.text).toStartWith('HEAD_START')
    expect(preview.text).toEndWith('TAIL_END')
    expect(preview.text).toContain('omitted')
    expect(preview.characterCount).toBe(code.length)
  })

  test('strips terminal control sequences and unsafe control characters', () => {
    const preview = formatReplPermissionPreview('\u001b[31mred\u001b[0m\u0007 plain')

    expect(preview.text).toContain('red')
    expect(preview.text).toContain(' plain')
    expect(preview.text).not.toContain('\u001b')
    expect(preview.text).not.toContain('\u0007')
  })
})
