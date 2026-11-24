import { describe, expect, test } from 'bun:test'
import { getToolSearchOrReadInfo } from './collapseReadSearch.js'

describe('collapseReadSearch REPL handling', () => {
  test('keeps the outer REPL row visible instead of absorbing it silently', () => {
    const info = getToolSearchOrReadInfo('REPL', { code: 'return 1' }, [])
    expect(info.isCollapsible).toBe(false)
    expect(info.isAbsorbedSilently).toBe(false)
  })
})
