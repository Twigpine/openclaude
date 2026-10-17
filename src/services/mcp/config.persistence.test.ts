import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../../../', import.meta.url))
const configImports = `
  import { enableConfigs, getGlobalConfig, getCurrentProjectConfig, saveGlobalConfig } from './src/utils/config.ts'
  enableConfigs()
`
const mcpImports = `
  import { isMcpServerDisabled, setMcpServerEnabled } from './src/services/mcp/config.ts'
`

test.each([
  { cached: ['a'], written: ['a', 'b'], name: 'a', enabled: true,
    project: ['b'], global: ['a', 'b'] },
  { cached: ['a'], written: ['a', 'b'], name: 'c', enabled: false,
    project: ['a', 'b', 'c'], global: ['a', 'b', 'c'] },
  // Disk already matches the toggle, but this process still sees the opposite.
  { cached: ['a'], written: ['a', 'b'], name: 'b', enabled: false,
    project: ['a', 'b'], global: ['a', 'b'] },
  { cached: ['a', 'b'], written: ['a'], name: 'b', enabled: true,
    project: ['a'], global: ['a'] },
  // A peer already enabled the target by creating an explicit project list.
  { cached: ['a', 'b'], written: ['a', 'b'], name: 'a', enabled: true,
    peerEnable: true, project: ['b'], global: ['a', 'b'] },
  // Coherent no-ops must keep inheriting rather than pinning a project list.
  { cached: ['a', 'b'], written: ['a', 'b'], name: 'b', enabled: false,
    project: null, global: ['a', 'b'] },
  { cached: ['a'], written: ['a'], name: 'b', enabled: true,
    project: null, global: ['a'] },
])('first inherited toggle preserves immediate and restarted state: %j', scenario => {
  const configDir = mkdtempSync(join(tmpdir(), 'mcp-persistence-'))
  const env = { ...process.env, NODE_ENV: 'production', OPENCLAUDE_CONFIG_DIR: configDir }
  const run = (script: string) => {
    const result = spawnSync(process.execPath, ['--eval', script], {
      cwd, env, encoding: 'utf8', timeout: 15_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  try {
    const writer = `${configImports}${mcpImports}
      saveGlobalConfig(c => ({ ...c, disabledMcpServers: ${JSON.stringify(scenario.written)} }))
      ${'peerEnable' in scenario ? "setMcpServerEnabled('a', true)" : ''}
    `
    const toggled = run(`${configImports}${mcpImports}
      import { spawnSync } from 'node:child_process'
      // Start the production watcher before seeding the write-through cache.
      getGlobalConfig()
      saveGlobalConfig(c => ({ ...c, disabledMcpServers: ${JSON.stringify(scenario.cached)} }))
      // Block the watcher while another process commits through the real lock.
      const writer = spawnSync(process.execPath, ['--eval', ${JSON.stringify(writer)}], {
        env: process.env, encoding: 'utf8', timeout: 15_000,
      })
      if (writer.error || writer.status !== 0) throw new Error(writer.stderr || String(writer.error))
      const cached = getGlobalConfig().disabledMcpServers
      setMcpServerEnabled(${JSON.stringify(scenario.name)}, ${scenario.enabled})
      console.log(JSON.stringify({ cached,
        targetDisabled: isMcpServerDisabled(${JSON.stringify(scenario.name)}),
        project: getCurrentProjectConfig().disabledMcpServers ?? null,
      }))
    `)
    expect(toggled.cached).toEqual(scenario.cached)
    expect(toggled.targetDisabled).toBe(!scenario.enabled)
    expect(toggled.project).toEqual(scenario.project)

    const restarted = run(`${configImports}${mcpImports}
      console.log(JSON.stringify({
        global: getGlobalConfig().disabledMcpServers,
        project: getCurrentProjectConfig().disabledMcpServers ?? null,
        siblingDisabled: isMcpServerDisabled(${JSON.stringify(scenario.name === 'a' ? 'b' : 'a')}),
        targetDisabled: isMcpServerDisabled(${JSON.stringify(scenario.name)}),
      }))
    `)
    expect(restarted).toEqual({
      global: scenario.global, project: scenario.project,
      siblingDisabled: true, targetDisabled: !scenario.enabled,
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 45_000)
