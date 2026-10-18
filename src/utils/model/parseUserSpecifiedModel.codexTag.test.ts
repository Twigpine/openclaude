import { describe, expect, test } from 'bun:test'
import { has1mContext } from '../context.js'
import {
  getProviderRequestModel,
  parseUserSpecifiedModel,
  renderModelSetting,
} from './model.js'

// Regression: the Codex aliases (codexplan/codexspark) dropped the `[1m]`
// (1M-context) tag while every Claude alias (opus/sonnet/haiku/best) preserved
// it. The `[1m]` suffix is an explicit client-side opt-in to the 1M context
// window (see has1mContext), so dropping it silently shrinks a
// `codexplan[1m]`/`codexspark[1m]` session back to the model default. The base
// mapping (no tag) must stay unchanged. Assertions are relational so they don't
// pin a specific gpt model id.
describe('parseUserSpecifiedModel — codex alias 1M tag', () => {
  test('codexplan[1m] keeps the [1m] tag on top of the base mapping', () => {
    const base = parseUserSpecifiedModel('codexplan')
    const tagged = parseUserSpecifiedModel('codexplan[1m]')

    expect(tagged).toBe(`${base}[1m]`)
    expect(has1mContext(tagged)).toBe(true)
  })

  test('codexspark[1m] keeps the [1m] tag on top of the base mapping', () => {
    const base = parseUserSpecifiedModel('codexspark')
    const tagged = parseUserSpecifiedModel('codexspark[1m]')

    expect(tagged).toBe(`${base}[1m]`)
    expect(has1mContext(tagged)).toBe(true)
  })

  test('the bare codex aliases resolve and carry no 1M tag', () => {
    expect(parseUserSpecifiedModel('codexplan')).toBe('gpt-5.6-sol')
    expect(parseUserSpecifiedModel('codexspark')).toBe('gpt-5.3-codex-spark')
    expect(has1mContext(parseUserSpecifiedModel('codexplan'))).toBe(false)
    expect(has1mContext(parseUserSpecifiedModel('codexspark'))).toBe(false)
  })

  test('codexplan reasoning queries stay symbolic for Codex routing', () => {
    expect(parseUserSpecifiedModel('codexplan?reasoning=medium')).toBe(
      'codexplan?reasoning=medium',
    )
  })

  test('the tag is case-insensitive and not duplicated', () => {
    const tagged = parseUserSpecifiedModel('codexplan[1m]')
    expect(parseUserSpecifiedModel('CODEXPLAN[1M]')).toBe(tagged)
    expect(tagged.match(/\[1m]/gi)?.length).toBe(1)
  })

  test('codexplan display identifies the Sol model', () => {
    expect(renderModelSetting('codexplan')).toBe('codexplan (gpt-5.6-sol)')
  })

  test('keeps codexplan as the provider request selection after runtime resolution', () => {
    expect(getProviderRequestModel('codexplan', 'gpt-5.6-sol')).toBe(
      'codexplan',
    )
    expect(getProviderRequestModel('gpt-5.6-sol', 'gpt-5.6-sol')).toBe(
      'gpt-5.6-sol',
    )
    expect(getProviderRequestModel('codexplan', 'gpt-5.6-terra')).toBe(
      'gpt-5.6-terra',
    )
    expect(
      getProviderRequestModel('codexplan?reasoning=medium', 'gpt-5.6-sol'),
    ).toBe('codexplan?reasoning=medium')
    expect(
      getProviderRequestModel(
        'codexplan?reasoning=medium',
        'gpt-5.6-sol?reasoning=medium',
      ),
    ).toBe('codexplan?reasoning=medium')
  })
})

// Bare gpt-5.6 resolves to the flagship tier (Sol) at parse time — not just in
// the request-time alias map — so context sizing and display use the tier id
// that has real descriptor metadata. Tier ids pass through unchanged.
describe('parseUserSpecifiedModel — bare gpt-5.6 resolves to Sol', () => {
  test('gpt-5.6 maps to gpt-5.6-sol and preserves the [1m] tag', () => {
    expect(parseUserSpecifiedModel('gpt-5.6')).toBe('gpt-5.6-sol')
    expect(parseUserSpecifiedModel('gpt-5.6[1m]')).toBe('gpt-5.6-sol[1m]')
  })

  test('explicit tier ids pass through unchanged', () => {
    expect(parseUserSpecifiedModel('gpt-5.5')).toBe('gpt-5.5')
    expect(parseUserSpecifiedModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(parseUserSpecifiedModel('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(parseUserSpecifiedModel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
  })

  test('a ?reasoning= query suffix does not defeat the rewrite', () => {
    // Without base-name matching the suffixed form passed through unresolved
    // and context sizing fell back to the 128k OpenAI default while the
    // request itself still ran on Sol via the request-time alias map.
    expect(parseUserSpecifiedModel('gpt-5.6?reasoning=medium')).toBe(
      'gpt-5.6-sol?reasoning=medium',
    )
    expect(parseUserSpecifiedModel('gpt-5.6?thinking=enabled')).toBe(
      'gpt-5.6-sol?thinking=enabled',
    )
  })

  test('combined query + [1m] tag keeps the tag trailing after the query', () => {
    // The tag must stay at the very end (mirroring the input form): placed
    // between the id and the query it would corrupt the base-model split,
    // and folded into the query it would corrupt the reasoning value.
    // parseModelDescriptor strips the trailing tag at request time.
    expect(parseUserSpecifiedModel('gpt-5.6?reasoning=medium[1m]')).toBe(
      'gpt-5.6-sol?reasoning=medium[1m]',
    )
  })
})
