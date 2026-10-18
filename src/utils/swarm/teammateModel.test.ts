import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

beforeEach(async () => {
  await acquireSharedMutationLock('utils/swarm/teammateModel.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshTeammateModelModule(provider = 'mistral') {
  mock.module('../model/providers.js', () => ({
    getAPIProvider: () => provider,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./teammateModel.js?ts=${nonce}`)
}

test('getHardcodedTeammateModelFallback returns a Mistral fallback in mistral mode', async () => {
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule()

  expect(getHardcodedTeammateModelFallback()).toBe('devstral-latest')
})

test('getHardcodedTeammateModelFallback returns the current default Opus (4.8) for first party', async () => {
  // Regression for #1769: the fallback hardcoded Opus 4.6 while the default Opus
  // is now 4.8, so new teammates spawned on an older model.
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('firstParty')

  expect(getHardcodedTeammateModelFallback()).toBe('claude-opus-4-8')
})

test('getHardcodedTeammateModelFallback is provider-aware (Bedrock gets the Opus 4.8 Bedrock id)', async () => {
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('bedrock')

  expect(getHardcodedTeammateModelFallback()).toBe(
    'us.anthropic.claude-opus-4-8-v1',
  )
})

test('getHardcodedTeammateModelFallback returns the Codex default (GPT-5.6 Sol) for codex', async () => {
  const { getHardcodedTeammateModelFallback } =
    await importFreshTeammateModelModule('codex')

  expect(getHardcodedTeammateModelFallback()).toBe('gpt-5.6-sol')
})
