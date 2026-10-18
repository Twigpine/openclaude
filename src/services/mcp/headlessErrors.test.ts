import { expect, test } from 'bun:test'

import type { PluginError } from '../../types/plugin.js'
import { getHeadlessMcpConfigWarnings } from './headlessErrors.js'

const managedError: PluginError = {
  type: 'generic-error',
  source: '/managed/managed-mcp.json',
  error: 'Managed MCP config is invalid (mcpServers.__proto__): reserved name',
}

test('emits a warning line per error in a headless session', () => {
  const lines = getHeadlessMcpConfigWarnings(true, [managedError])
  expect(lines).toEqual([
    'Warning: Managed MCP config is invalid (mcpServers.__proto__): reserved name',
  ])
})

test('stays silent in an interactive session (MCP UI surfaces errors there)', () => {
  expect(getHeadlessMcpConfigWarnings(false, [managedError])).toEqual([])
})

test('emits nothing when there are no errors', () => {
  expect(getHeadlessMcpConfigWarnings(true, [])).toEqual([])
})
