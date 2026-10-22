// Direct unit tests for the NVIDIA NIM gateway's `catalog.discovery.mapModel`
// filter. The generic discoveryService flow is covered by the
// `mapmodel-test` case in discoveryService.test.ts; this file pins the
// NVIDIA-specific exclusion regex against representative model ids the live
// `https://integrate.api.nvidia.com/v1/models` endpoint returns, so the
// filter doesn't silently start admitting embedding / ASR / safety / image
// models into the /model picker as NVIDIA's catalog grows.

import { describe, expect, test } from 'bun:test'
import nvidiaNim from './nvidia-nim.js'
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

const mapModel = nvidiaNim.catalog?.discovery?.mapModel

function shape(id: string, extras: Record<string, unknown> = {}) {
  return { id, ...extras }
}

describe('nvidia-nim gateway mapModel filter', () => {
  describe.each([
    {
      routeId: 'nvidia-nim',
      expected: {
        catalogSource: 'hybrid',
        discoveryRefreshMode: 'background-if-stale',
        allowManualRefresh: true,
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
      expect(nvidiaNim.catalog?.discoveryCacheTtl).toBeDefined()
    })
  })

  test('keeps chat / instruct / reasoning / code models', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const keep = [
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'meta/llama-3.3-70b-instruct',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'deepseek-ai/deepseek-v4-pro',
      'mistralai/mixtral-8x22b-instruct-v0.1',
      'microsoft/phi-4-mini-instruct',
      'google/gemma-3-27b-it',
      'moonshotai/kimi-k2.6',
      'meta/llama-3.2-90b-vision-instruct',
      'qwen/qwq-32b',
    ]
    for (const id of keep) {
      expect(mapModel(shape(id))).toEqual({
        id,
        apiName: id,
        label: id,
      })
    }
  })

  test('drops embedding / retriever / reranker models', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const drop = [
      'nvidia/embed-qa-4',
      'nvidia/nv-embedqa-mistral-7b-v2',
      'nvidia/nemoretriever-parse-1b',
      'nvidia/nv-rerank-qa-mistral-4b-v3',
    ]
    for (const id of drop) {
      expect(mapModel(shape(id))).toBeNull()
    }
  })

  test('drops ASR / TTS / voice models', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const drop = [
      'openai/whisper-large-v3',
      'nvidia/parakeet-rnnt-1.1b',
      'nvidia/canary-1b',
      'nvidia/riva-asr',
      'nvidia/nemo-tts',
    ]
    for (const id of drop) {
      expect(mapModel(shape(id))).toBeNull()
    }
  })

  test('drops non-chat live-catalog entries that have no chat marker', () => {
    if (!mapModel) throw new Error('mapModel missing')
    // Reviewer-named bad ids the live NVIDIA endpoint currently returns. The
    // previous exclusion regex admitted them silently; the allowlist drops
    // them because none carry an instruct/chat/reasoning/code marker.
    const drop = [
      'baai/bge-m3',
      'google/deplot',
      'nvidia/ai-synthetic-video-detector',
      'nvidia/gliner-pii',
      'nvidia/ising-calibration-llama-3-8b',
    ]
    for (const id of drop) {
      expect(mapModel(shape(id))).toBeNull()
    }
  })

  test('drops image-gen / vision-only embedding models', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const drop = [
      'stabilityai/sdxl-turbo',
      'black-forest-labs/flux.1-dev',
      'stabilityai/stable-diffusion-3-medium',
      'microsoft/kosmos-2',
      'microsoft/florence-2',
      'nvidia/nvclip',
    ]
    for (const id of drop) {
      expect(mapModel(shape(id))).toBeNull()
    }
  })

  test('drops safety / guard / reward models', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const drop = [
      'meta/llama-guard-3-8b',
      'nvidia/llama-3.1-nemoguard-8b-content-safety',
      'nvidia/nemotron-content-safety',
      'nvidia/nemotron-3-reward-340b',
    ]
    for (const id of drop) {
      expect(mapModel(shape(id))).toBeNull()
    }
  })

  test('drops inactive entries regardless of id', () => {
    if (!mapModel) throw new Error('mapModel missing')
    expect(
      mapModel(shape('meta/llama-3.3-70b-instruct', { active: false })),
    ).toBeNull()
  })

  test('drops entries without id', () => {
    if (!mapModel) throw new Error('mapModel missing')
    expect(mapModel({})).toBeNull()
    expect(mapModel({ id: '' })).toBeNull()
  })

  test('forwards context_window when present', () => {
    if (!mapModel) throw new Error('mapModel missing')
    expect(
      mapModel(
        shape('meta/llama-3.3-70b-instruct', { context_window: 131072 }),
      ),
    ).toEqual({
      id: 'meta/llama-3.3-70b-instruct',
      apiName: 'meta/llama-3.3-70b-instruct',
      label: 'meta/llama-3.3-70b-instruct',
      contextWindow: 131072,
    })
  })
})
