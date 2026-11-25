import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { buildReplToolInventory } from './toolWrappers.js'

describe('buildReplToolInventory', () => {
  test('includes hidden primitives even when absent from direct session tools', () => {
    const inventory = buildReplToolInventory({ sessionTools: [] })
    expect(inventory.map(tool => tool.name)).toContain('Read')
    expect(inventory.map(tool => tool.name)).toContain(BASH_TOOL_NAME)
  })

  test('excludes interactive and control-plane nonprimitive tools', () => {
    const excluded = createToolFixture(z.object({}), { name: 'TodoWrite' })
    const included = createToolFixture(z.object({}), { name: 'WebSearch' })
    const inventory = buildReplToolInventory({ sessionTools: [excluded, included] })
    expect(inventory.map(tool => tool.name)).toContain('WebSearch')
    expect(inventory.map(tool => tool.name)).not.toContain('TodoWrite')
  })

  test('keeps MCP tools under canonical names and separates illegal identifiers for generic access', () => {
    const mcp = createToolFixture(z.object({}), {
      name: 'mcp__server__not-legal',
      isMcp: true,
    })
    const inventory = buildReplToolInventory({ sessionTools: [mcp] })
    expect(inventory.map(tool => tool.name)).toContain('mcp__server__not-legal')
    expect(inventory.map(tool => tool.name)).toContain('Read')
  })

  test('applies deny filtering to primitives when permission context is supplied', () => {
    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { session: [BASH_TOOL_NAME] },
    }
    const inventory = buildReplToolInventory({ sessionTools: [], permissionContext: permissionContext as ToolPermissionContext })
    expect(inventory.map(tool => tool.name)).not.toContain(BASH_TOOL_NAME)
  })

  test('honors the session primitive contract when one is supplied', () => {
    const inventory = buildReplToolInventory({
      sessionTools: [],
      allowedPrimitiveNames: ['Read', 'Bash'],
    })
    expect(inventory.map(tool => tool.name)).toEqual(['Read', 'Bash'])
  })
})
