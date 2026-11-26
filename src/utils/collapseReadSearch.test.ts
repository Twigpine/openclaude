import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { createToolFixture } from '../test/toolFixtures.js'
import { getToolSearchOrReadInfo } from './collapseReadSearch.js'

describe('collapseReadSearch REPL handling', () => {
  test('keeps the outer REPL row visible instead of absorbing it silently', () => {
    const replTool = createToolFixture(z.object({ code: z.string() }), {
      name: 'REPL',
      isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
    })
    const info = getToolSearchOrReadInfo('REPL', { code: 'return 1' }, [replTool])
    expect(info.isCollapsible).toBe(false)
    expect(info.isAbsorbedSilently).toBe(false)
  })

  test('uses primitive display metadata when execution tools are hidden', () => {
    const info = getToolSearchOrReadInfo('Read', { file_path: 'x' }, [])
    expect(info.isCollapsible).toBe(true)
    expect(info.isRead).toBe(true)
  })
})
