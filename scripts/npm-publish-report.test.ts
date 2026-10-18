import { expect, test } from 'bun:test'

import { buildPublishReport } from './npm-publish-report.js'

// Shapes taken from the registry's per-version documents.

test('reports a trusted-publisher publish with provenance', () => {
  const report = buildPublishReport('@twigpine/openclaude', '0.33.0', {
    _npmUser: { trustedPublisher: { id: 'github' } },
    dist: { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } },
  })

  expect(report.hasProvenance).toBe(true)
  expect(report.lines).toEqual([
    '- `@twigpine/openclaude@0.33.0` provenance: yes',
    '- `@twigpine/openclaude@0.33.0` npm auth: trusted publisher (OIDC, no token)',
  ])
})

// A publish by a person or a token records no trusted publisher.
test('reports a publish that did not go through a trusted publisher', () => {
  const report = buildPublishReport('@twigpine/openclaude', '0.32.0', {
    _npmUser: {},
    dist: { attestations: { provenance: {} } },
  })

  expect(report.hasProvenance).toBe(true)
  expect(report.lines[1]).toBe(
    '- `@twigpine/openclaude@0.32.0` npm auth: NOT a trusted publisher',
  )
})

test('flags a publish that carries no provenance', () => {
  const report = buildPublishReport('@twigpine/openclaude', '0.32.0', {})

  expect(report.hasProvenance).toBe(false)
  expect(report.lines[0]).toBe('- `@twigpine/openclaude@0.32.0` provenance: MISSING')
})
