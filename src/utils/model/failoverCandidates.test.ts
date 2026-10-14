import { describe, expect, test } from 'bun:test'
import {
  rankFailoverCandidates,
  type RankFailoverCandidatesOptions,
} from './failoverCandidates.js'
import type { ModelOption } from './modelOptions.js'
import type { ModelAvailability } from './modelAvailability.js'

function option(value: string, label?: string): ModelOption {
  return { value, label: label ?? value, description: value }
}

function verdict(
  state: ModelAvailability['state'],
): ModelAvailability {
  return { state, checkedAt: 0 }
}

function base(
  overrides?: Partial<RankFailoverCandidatesOptions>,
): RankFailoverCandidatesOptions {
  return {
    options: [
      option('model-a'),
      option('model-b'),
      option('model-c'),
    ],
    failingModel: 'model-a',
    ...overrides,
  }
}

describe('rankFailoverCandidates', () => {
  test('excludes the failing model and preserves catalog order', () => {
    expect(rankFailoverCandidates(base())).toEqual(['model-b', 'model-c'])
  })

  test('excludes already-tried models', () => {
    expect(
      rankFailoverCandidates(base({ alreadyTried: ['model-b'] })),
    ).toEqual(['model-c'])
  })

  test('dedupes repeated options', () => {
    const options = [option('model-a'), option('model-b'), option('model-b')]
    expect(rankFailoverCandidates(base({ options }))).toEqual(['model-b'])
  })

  test('drops models a verified-bad verdict marks unusable', () => {
    const availability = {
      'model-b': verdict('unavailable'),
      'model-c': verdict('available'),
    }
    expect(
      rankFailoverCandidates(base({ availability })),
    ).toEqual(['model-c'])
  })

  test('cold cache keeps catalog order', () => {
    expect(rankFailoverCandidates(base({ availability: {} }))).toEqual([
      'model-b',
      'model-c',
    ])
  })

  test('ranks unprobed models after verified ones on a partial cache', () => {
    const options = [
      option('model-a'),
      option('model-b'),
      option('model-c'),
      option('model-d'),
    ]
    const availability = {
      // model-c verified good; model-b never probed.
      'model-c': verdict('available'),
      'model-d': verdict('auth-failed'),
    }
    expect(
      rankFailoverCandidates(base({ options, availability })),
    ).toEqual(['model-c', 'model-b'])
  })

  test('matches verdicts by label when value is absent', () => {
    const options = [option('model-b', 'Pretty Name')]
    const availability = {
      'Pretty Name': verdict('unavailable'),
    }
    expect(
      rankFailoverCandidates(base({ options, availability })),
    ).toEqual([])
  })

  test('skips null-valued options', () => {
    const options = [
      { value: null, label: 'Default', description: '' },
      option('model-b'),
    ] as ModelOption[]
    expect(rankFailoverCandidates(base({ options }))).toEqual(['model-b'])
  })

  test('skips cross-profile switch options', () => {
    const options = [
      {
        value: '__switch_profile__:p1:model-x',
        label: 'model-x',
        description: '',
        switchToProfileId: 'p1',
      },
      option('model-b'),
    ]
    expect(rankFailoverCandidates(base({ options }))).toEqual(['model-b'])
  })

  test('decodes profile-prefixed values without a marker as the model', () => {
    const options = [option('__switch_profile__:p1:model-x'), option('model-b')]
    expect(rankFailoverCandidates(base({ options }))).toEqual([
      'model-x',
      'model-b',
    ])
  })
})
