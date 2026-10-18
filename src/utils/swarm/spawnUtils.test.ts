import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { buildInheritedCliFlags, buildInheritedEnvVars } from './spawnUtils.js'

const ORIGINAL_ENV = { ...process.env }

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/spawnUtils.test.ts')
  for (const key of Object.keys(process.env)) {
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, ORIGINAL_ENV)
  } finally {
    releaseSharedMutationLock()
  }
})

test('buildInheritedEnvVars marks spawned teammates as host-managed for provider routing', () => {
  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1')
})

test('buildInheritedEnvVars forwards pooled OpenAI credentials', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).toContain('OPENAI_API_KEYS=key-a\\,key-b')
})

test('buildInheritedEnvVars forwards the supported OpenAI base URL alias', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE = 'https://api.commandcode.ai/provider/v1'
  process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash'
  process.env.CMD_API_KEY = 'cmd-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('OPENAI_API_BASE=')
  expect(envVars).toContain('api.commandcode.ai/provider/v1')
  expect(envVars).toContain('CMD_API_KEY=cmd-key')
  expect(envVars).toContain('OPENAI_MODEL=deepseek/deepseek-v4-flash')
})

test('buildInheritedEnvVars forwards an LLMTR credential without inventing route state', () => {
  process.env.LLMTR_API_KEY = 'llmtr-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('LLMTR_API_KEY=llmtr-key')
  expect(envVars).not.toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).not.toContain('OPENAI_BASE_URL=')
})

test('buildInheritedEnvVars forwards a GMI Cloud credential without inventing route state', () => {
  process.env.GMI_API_KEY = 'gmi-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('GMI_API_KEY=gmi-key')
  expect(envVars).not.toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).not.toContain('OPENAI_BASE_URL=')
})

test('buildInheritedEnvVars forwards a Command Code credential without inventing route state', () => {
  process.env.CMD_API_KEY = 'cmd-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('CMD_API_KEY=cmd-key')
  expect(envVars).not.toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).not.toContain('OPENAI_BASE_URL=')
})

test('buildInheritedEnvVars forwards the official Command Code credential alias', () => {
  process.env.COMMAND_CODE_API_KEY = 'official-key'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('COMMAND_CODE_API_KEY=official-key')
  expect(envVars).not.toContain('CLAUDE_CODE_USE_OPENAI=1')
  expect(envVars).not.toContain('OPENAI_BASE_URL=')
})

test('buildInheritedEnvVars forwards PATH for source-built teammate tool lookups', () => {
  process.env.PATH = '/custom/bin:/usr/bin'

  const envVars = buildInheritedEnvVars()

  expect(envVars).toContain('PATH=')
  expect(envVars).toContain('/custom/bin\\:/usr/bin')
})

test('buildInheritedCliFlags preserves fullAccess mode for spawned teammates', () => {
  process.env.NODE_ENV = 'test'
  const flags = buildInheritedCliFlags({ permissionMode: 'fullAccess' })

  expect(flags).toContain('--permission-mode fullAccess')
  expect(flags).not.toContain('--dangerously-skip-permissions')
})
