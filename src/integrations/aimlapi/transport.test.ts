import { expect, test } from 'bun:test'

import { AimlapiApiError } from './client.js'
import { isAmbiguousTransportApiError } from './transport.js'

test('isAmbiguousTransportApiError treats every 2xx status as ambiguous, not a definite failure', () => {
  // A 2xx proves the server received and processed the request — client.request
  // throwing anyway (empty/non-JSON/oversized/malformed body) means the
  // confirmation was lost, not that a non-idempotent mutation never happened.
  for (const status of [200, 201, 204, 299]) {
    expect(isAmbiguousTransportApiError(new AimlapiApiError('msg', status, ''))).toBe(true)
  }
})

test('isAmbiguousTransportApiError still treats network/timeout/rate-limit/5xx as ambiguous', () => {
  for (const status of [0, 408, 429, 500, 503]) {
    expect(isAmbiguousTransportApiError(new AimlapiApiError('msg', status, ''))).toBe(true)
  }
})

test('isAmbiguousTransportApiError treats a definite 4xx rejection (other than 408/429) as not ambiguous', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    expect(isAmbiguousTransportApiError(new AimlapiApiError('msg', status, ''))).toBe(false)
  }
})

test('isAmbiguousTransportApiError is false for a non-AimlapiApiError', () => {
  expect(isAmbiguousTransportApiError(new Error('plain error'))).toBe(false)
  expect(isAmbiguousTransportApiError(undefined)).toBe(false)
})
