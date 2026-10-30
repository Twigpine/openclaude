import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('session discovers the enabled builtin before delayed pipe input arrives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-mcp-startup-'))
  const cli = resolve(import.meta.dir, '../../bin/openclaude')
  // Keep stdin open without sending text: discovery must finish before the
  // input await, and no setup, MCP connection or model request should start.
  const proc = Bun.spawn({
    cmd: ['node', cli, '--print', '--debug-to-stderr', '--settings', JSON.stringify({
      enabledPlugins: { 'aimlapi@builtin': true, 'karpathy-guidelines@builtin': false },
    })],
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      OPENCLAUDE_CONFIG_DIR: root,
      GIT_CEILING_DIRECTORIES: root,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
      OPENAI_API_KEY: 'unused-test-key',
      AIMLAPI_API_KEY: 'unused-aimlapi-test-key',
      OPENCLAUDE_DISABLE_EARLY_INPUT: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'pipe',
  })
  // Leave five seconds of the test timeout for assertions and child teardown.
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 10_000)
  let stderr = ''
  const reader = proc.stderr.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      stderr += decoder.decode(value, { stream: true })
      if (/Found \d+ plugins/.test(stderr)) break
    }
    expect(stderr).toContain('Found 2 plugins (1 enabled, 1 disabled)')
    expect(stderr).not.toContain('[STARTUP] Running setup()')
  } finally {
    clearTimeout(deadline)
    proc.kill('SIGKILL')
    await proc.exited
    await reader.cancel()
    reader.releaseLock()
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
