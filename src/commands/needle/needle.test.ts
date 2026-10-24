import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { call as needleCall } from './needle.js'
import * as needleClient from '../../services/needle/needleClient.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

describe('needle command', () => {
  let configDir: string
  beforeEach(async () => {
    await acquireSharedMutationLock('commands/needle.test.ts')
    configDir = mkdtempSync(join(tmpdir(), 'openclaude-needle-command-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    setClaudeConfigHomeDirForTesting(configDir)
  })
  afterEach(() => {
    saveGlobalConfig(current => ({ ...current, needleEnabled: false, needleMode: 'worker' }))
    setClaudeConfigHomeDirForTesting(undefined)
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
    releaseSharedMutationLock()
  })

  it('refuses enablement when Needle is unavailable', async () => {
    const previous = process.env.OPENCLAUDE_NEEDLE_PYTHON
    process.env.OPENCLAUDE_NEEDLE_PYTHON = process.platform === 'win32' ? 'missing-needle-python.exe' : '/bin/false'
    const context = {} as unknown as LocalJSXCommandContext
    try {
      const result = await needleCall('enable', context)
      expect(getGlobalConfig().needleEnabled).toBe(false)
      expect(result.type).toBe('text')
      if (result.type === 'text') expect(result.value).toContain('was not enabled')
    } finally {
      if (previous === undefined) delete process.env.OPENCLAUDE_NEEDLE_PYTHON
      else process.env.OPENCLAUDE_NEEDLE_PYTHON = previous
    }
  })

  it('toggles the worker and persists its mode', async () => {
    const availability = spyOn(needleClient, 'checkNeedleAvailability').mockResolvedValue({ available: true })
    const context = {} as unknown as LocalJSXCommandContext
    try {
      await needleCall('enable', context)
      expect(getGlobalConfig().needleEnabled).toBe(true)
      expect(getGlobalConfig().needleMode).toBe('worker')

      await needleCall('mode main', context)
      expect(getGlobalConfig().needleMode).toBe('main')

      const status = await needleCall('status', context)
      expect(status.type).toBe('text')
      if (status.type === 'text') expect(status.value).toContain('main')
    } finally {
      availability.mockRestore()
    }
  })
})
