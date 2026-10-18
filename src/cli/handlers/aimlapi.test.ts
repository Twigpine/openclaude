import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  AimlapiApiError,
  type AimlapiClient,
} from '../../integrations/aimlapi/client.js'
import { setAimlapiTopupTestDoubles } from '../../integrations/aimlapi/topup.js'
import { aimlapiTopup } from './aimlapi.js'

// An OpenAI-style key that redactSensitiveInfo replaces with a marker.
const SECRET = 'sk-abcdef0123456789abcdef0123'

const originalExit = process.exit
const originalError = console.error
const originalInferenceUrl = process.env.AIMLAPI_INFERENCE_URL
const tempDirs: string[] = []

afterEach(() => {
  setAimlapiTopupTestDoubles(undefined)
  setClaudeConfigHomeDirForTesting(undefined)
  process.exit = originalExit
  console.error = originalError
  if (originalInferenceUrl === undefined) delete process.env.AIMLAPI_INFERENCE_URL
  else process.env.AIMLAPI_INFERENCE_URL = originalInferenceUrl
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

// Drive the handler until it fails on the injected client error, capturing every
// console.error line and short-circuiting the process.exit(1) it ends with.
async function runHandlerWithError(clientError: unknown): Promise<string> {
  // Default (canonical) inference endpoint so guided provisioning is not refused
  // before it reaches the account lookup.
  delete process.env.AIMLAPI_INFERENCE_URL
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-handler-'))
  tempDirs.push(dir)
  setClaudeConfigHomeDirForTesting(dir)
  setAimlapiTopupTestDoubles({
    createClient: () =>
      ({
        checkAccount: async () => {
          throw clientError
        },
      }) as unknown as AimlapiClient,
    writeProfile: () => 'profile.json',
    promptText: async () => '',
    promptHidden: async () => '',
  })

  const lines: string[] = []
  console.error = ((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }) as typeof console.error
  process.exit = ((): never => {
    throw new Error('__exit__')
  }) as typeof process.exit

  await expect(
    aimlapiTopup({ email: 'user@example.com', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow('__exit__')
  return lines.join('\n')
}

test('redacts credentials in an AimlapiApiError message and body before exit', async () => {
  const output = await runHandlerWithError(
    new AimlapiApiError(`auth failed ${SECRET}`, 401, `body leak ${SECRET}`),
  )
  expect(output).not.toContain(SECRET)
  expect(output).toContain('[REDACTED_OPENAI_KEY]')
})

test('redacts credentials in a generic error before exit', async () => {
  const output = await runHandlerWithError(new Error(`unexpected failure ${SECRET}`))
  expect(output).not.toContain(SECRET)
  expect(output).toContain('[REDACTED_OPENAI_KEY]')
})

test('redacts credentials in a thrown non-Error value before exit', async () => {
  const output = await runHandlerWithError(`unexpected failure ${SECRET}`)
  expect(output).not.toContain(SECRET)
  expect(output).toContain('[REDACTED_OPENAI_KEY]')
})
