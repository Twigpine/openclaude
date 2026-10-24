import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildNeedleToolPayload,
  DEFAULT_NEEDLE_TIMEOUT_MS,
  getNeedlePythonCommand,
  getNeedleTimeoutMs,
  NEEDLE_WORKER_MODEL,
} from './needleClient.js'

describe('Needle client configuration', () => {
  test('uses the dedicated worker model identifier', () => {
    expect(NEEDLE_WORKER_MODEL).toBe('needle-worker')
  })

  test('uses platform-appropriate Python launchers', () => {
    const previous = process.env.OPENCLAUDE_NEEDLE_PYTHON
    delete process.env.OPENCLAUDE_NEEDLE_PYTHON
    try {
      expect(getNeedlePythonCommand('linux')).toEqual({ command: 'python3', args: [] })
      expect(getNeedlePythonCommand('darwin')).toEqual({ command: 'python3', args: [] })
      expect(getNeedlePythonCommand('win32')).toEqual({ command: 'py', args: ['-3'] })
    } finally {
      if (previous === undefined) delete process.env.OPENCLAUDE_NEEDLE_PYTHON
      else process.env.OPENCLAUDE_NEEDLE_PYTHON = previous
    }
  })

  test('converts Anthropic-style tool schemas to Needle payloads', () => {
    expect(buildNeedleToolPayload([
      { name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
    ])).toEqual([
      { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    ])
  })

  test.skipIf(process.platform === 'win32')('restarts the worker after a child exit before serving later requests', async () => {
    const previous = process.env.OPENCLAUDE_NEEDLE_PYTHON
    process.env.OPENCLAUDE_NEEDLE_PYTHON = '/bin/false'
    const client = new (await import('./needleClient.js')).NeedleClient(100)
    try {
      await expect(client.complete({ prompt: 'first', tools: [] })).rejects.toThrow('exited with code 1')
      await expect(client.complete({ prompt: 'second', tools: [] })).rejects.toThrow('exited with code 1')
    } finally {
      client.close()
      if (previous === undefined) delete process.env.OPENCLAUDE_NEEDLE_PYTHON
      else process.env.OPENCLAUDE_NEEDLE_PYTHON = previous
    }
  })

  test.skipIf(process.platform === 'win32')('restarts the worker after a zero child exit before serving later requests', async () => {
    const previous = process.env.OPENCLAUDE_NEEDLE_PYTHON
    process.env.OPENCLAUDE_NEEDLE_PYTHON = '/bin/true'
    const client = new (await import('./needleClient.js')).NeedleClient(100)
    try {
      await expect(client.complete({ prompt: 'first', tools: [] })).rejects.toThrow('exited with code 0')
      await expect(client.complete({ prompt: 'second', tools: [] })).rejects.toThrow('exited with code 0')
    } finally {
      client.close()
      if (previous === undefined) delete process.env.OPENCLAUDE_NEEDLE_PYTHON
      else process.env.OPENCLAUDE_NEEDLE_PYTHON = previous
    }
  })

  test.skipIf(process.platform === 'win32')('rejects malformed matching responses instead of leaving requests pending', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'needle-runtime-'))
    const runtime = join(directory, 'runtime.py')
    const command = join(directory, 'python')
    writeFileSync(runtime, `import json, sys\nfor line in sys.stdin:\n    request = json.loads(line)\n    print(json.dumps({"id": request["id"]}), flush=True)\n`)
    writeFileSync(command, `#!/bin/sh\nexec python3 /${runtime.replace(/^\//, '')}\n`)
    chmodSync(command, 0o755)
    const previous = process.env.OPENCLAUDE_NEEDLE_PYTHON
    process.env.OPENCLAUDE_NEEDLE_PYTHON = command
    const client = new (await import('./needleClient.js')).NeedleClient(1_000)
    try {
      await expect(client.complete({ prompt: 'malformed', tools: [] })).rejects.toThrow('Needle worker returned no result')
    } finally {
      client.close()
      if (previous === undefined) delete process.env.OPENCLAUDE_NEEDLE_PYTHON
      else process.env.OPENCLAUDE_NEEDLE_PYTHON = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('restarts the worker after a timeout before serving later requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'needle-runtime-'))
    const runtime = join(directory, 'runtime.py')
    const command = join(directory, 'python')
    writeFileSync(runtime, `import json, sys, time\nfor line in sys.stdin:\n    request = json.loads(line)\n    if request["prompt"] == "delay": time.sleep(0.2)\n    print(json.dumps({"id": request["id"], "result": {"function_calls": [{"name": "read", "arguments": {"prompt": request["prompt"]}}]}}), flush=True)\n`)
    writeFileSync(command, `#!/bin/sh\nexec python3 /${runtime.replace(/^\//, '')}\n`)
    chmodSync(command, 0o755)
    const previous = process.env.OPENCLAUDE_NEEDLE_PYTHON
    process.env.OPENCLAUDE_NEEDLE_PYTHON = command
    const client = new (await import('./needleClient.js')).NeedleClient(30)
    try {
      await expect(client.complete({ prompt: 'delay', tools: [] })).rejects.toThrow('timed out')
      const response = await client.complete({ prompt: 'fresh', tools: [] })
      expect(response.functionCalls[0]?.arguments.prompt).toBe('fresh')
    } finally {
      client.close()
      if (previous === undefined) delete process.env.OPENCLAUDE_NEEDLE_PYTHON
      else process.env.OPENCLAUDE_NEEDLE_PYTHON = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
