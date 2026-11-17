import { describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { renderToolUseMessage } from './UI.js'

const longValue = 'x'.repeat(200)

describe('renderToolUseMessage', () => {
  test('truncates long input values in non-verbose mode only when MCP_RICH_OUTPUT is on', () => {
    const rendered = renderToolUseMessage(
      { command: longValue },
      { verbose: false },
    ) as string

    if (feature('MCP_RICH_OUTPUT')) {
      expect(rendered.endsWith('…')).toBe(true)
      expect(rendered.length).toBeLessThan(`command: ${JSON.stringify(longValue)}`.length)
    } else {
      expect(rendered).toBe(`command: ${JSON.stringify(longValue)}`)
    }
  })

  test('never truncates input values in verbose mode', () => {
    const rendered = renderToolUseMessage(
      { command: longValue },
      { verbose: true },
    ) as string

    expect(rendered).toBe(`command: ${JSON.stringify(longValue)}`)
  })
})
