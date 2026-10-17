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
  { name: 'a', enabled: true, project: ['b'], global: ['a', 'b'] },
  { name: 'c', enabled: false, project: ['a', 'b', 'c'], global: ['a', 'b', 'c'] },
])('first project toggle preserves concurrent global disables: %j', scenario => {
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
    const writer = `${configImports}
      saveGlobalConfig(c => ({ ...c, disabledMcpServers: ['a', 'b'] }))
    `
    const toggled = run(`${configImports}${mcpImports}
      import { spawnSync } from 'node:child_process'
      saveGlobalConfig(c => ({ ...c, disabledMcpServers: ['a'] }))
      getGlobalConfig()
      // Block the watcher while another process commits through the real lock.
      const writer = spawnSync(process.execPath, ['--eval', ${JSON.stringify(writer)}], {
        env: process.env, encoding: 'utf8', timeout: 15_000,
      })
      if (writer.error || writer.status !== 0) throw new Error(writer.stderr || String(writer.error))
      const cached = getGlobalConfig().disabledMcpServers
      setMcpServerEnabled(${JSON.stringify(scenario.name)}, ${scenario.enabled})
      console.log(JSON.stringify({ cached, project: getCurrentProjectConfig().disabledMcpServers }))
    `)
    expect(toggled.cached).toEqual(['a'])
    expect(toggled.project).toEqual(scenario.project)

    const restarted = run(`${configImports}${mcpImports}
      console.log(JSON.stringify({
        global: getGlobalConfig().disabledMcpServers,
        project: getCurrentProjectConfig().disabledMcpServers,
        siblingDisabled: isMcpServerDisabled('b'),
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
