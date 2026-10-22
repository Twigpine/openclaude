// src/integrations/nearai.test.ts
//
// Regression coverage for the NearAI `anthropic/claude-opus-4-8` route.
// The vendor catalog exposes the model via a catalog entry whose
// modelDescriptorId must resolve to a registered model descriptor; this
// test exercises that exact provider/model path so the route can't silently
// break (e.g. a removed descriptor or a mismatched id) without failing here.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ensureIntegrationsLoaded } from './index.js'
import {
  _clearRegistryForTesting,
  getCatalogEntriesForRoute,
  getModelsForVendor,
} from './registry.js'
import {
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getRouteDescriptor,
  resolveRouteIdFromBaseUrl,
} from './routeMetadata.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const OPUS_48_ID = 'anthropic/claude-opus-4-8'

beforeEach(async () => {
  await acquireSharedMutationLock('integrations/nearai.test.ts')
  _clearRegistryForTesting()
  ensureIntegrationsLoaded()
})

afterEach(() => {
  releaseSharedMutationLock()
})

describe('NearAI Claude Opus 4.8 route', () => {
  test('resolves route defaults, credentials, and catalog descriptor links', () => {
    for (const { routeId, baseUrl, id } of [
      { routeId: 'nearai', baseUrl: 'https://cloud-api.near.ai/v1', id: OPUS_48_ID },
    ]) {
      expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe(routeId)
      expect(getRouteDefaultBaseUrl(routeId)).toBe(baseUrl)
      expect(getRouteDefaultModel(routeId)).toBe('anthropic/claude-sonnet-4-6')
      expect(getRouteDescriptor(routeId)?.setup.credentialEnvVars).toEqual([
        'NEARAI_API_KEY',
      ])
      const entry = getCatalogEntriesForRoute(routeId).find(e => e.id === id)
      expect(entry).toMatchObject({ apiName: id, modelDescriptorId: id })
      const model = getModelsForVendor(routeId).find(m => m.id === entry?.modelDescriptorId)
      expect(model).toMatchObject({
        id,
        vendorId: routeId,
        brandId: 'nearai',
        defaultModel: id,
        label: 'Claude Opus 4.8',
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        capabilities: {
          supportsVision: false,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
          supportsReasoning: false,
          supportsPreciseTokenCount: false,
        },
      })
    }
  })
})
