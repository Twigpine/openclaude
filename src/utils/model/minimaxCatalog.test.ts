import { expect, test } from 'bun:test'
import { getCatalogEntriesForRoute, getModel } from '../../integrations/index.js'
import { isCurrentMiniMaxModelOption } from './minimaxCatalog.js'
import { buildRouteCatalogModelOptions, mergeRouteCatalogEntries } from './routeCatalogOptions.js'

for (const model of ['MiniMax-M2', 'MiniMax-M2.7-highspeed', 'minimax/minimax-m2.5:free', 'MiniMaxAI/MiniMax-M1', 'minimax-text-01', 'abab6.5-chat', 'minimax-m3-free', 'minimax-m3.1-flash-free']) {
  test(`retired text suggestion is filtered: ${model}`, () => {
    expect(isCurrentMiniMaxModelOption(model)).toBe(false)
  })
}

for (const model of ['MiniMax-M3.1-Flash', 'minimax/minimax-m3.1-flash:free', 'minimaxai/minimax-m3', 'minimax/minimax-m3:free', 'MiniMax-Vision-01', 'speech-02-hd', 'music-2.6', 'image-01', 'MiniMax-Hailuo-2.3', 'gpt-4o', 'my-custom-model']) {
  test(`current, custom, or nontext suggestion is preserved: ${model}`, () => {
    expect(isCurrentMiniMaxModelOption(model)).toBe(true)
  })
}

test('Zen catalogs retain available gateway models but exclude obsolete free suggestions', () => {
  const entries = mergeRouteCatalogEntries(getCatalogEntriesForRoute('opencode'), [
    { id: 'minimax/minimax-m2.7', apiName: 'minimax/minimax-m2.7' },
    { id: 'minimax-m3-free', apiName: 'minimax-m3-free' },
    { id: 'minimax-m3.1-flash-free', apiName: 'minimax-m3.1-flash-free' },
    { id: 'minimax/minimax-m3.1-flash:free', apiName: 'minimax/minimax-m3.1-flash:free' },
  ])
  const values = buildRouteCatalogModelOptions('Gateway', entries, undefined, 'opencode').map(option => option.value)
  expect(values).not.toContain('minimax-m3.1-flash-free')
  expect(values).not.toContain('minimax-m3-free')
  expect(values).toContain('minimax-m3')
  expect(values).toContain('minimax/minimax-m3.1-flash:free')
  expect(values).toContain('minimax-m2.5')
  expect(values).toContain('minimax-m2.7')
  expect(values).toContain('minimax/minimax-m2.7')
  // Filtering suggestions must not delete metadata used by explicit requests.
  expect(getModel('minimax-m2.7')?.capabilities.supportsVision).toBe(false)
  expect(getCatalogEntriesForRoute('opencode').some(entry => entry.apiName === 'minimax-m2.7')).toBe(true)
  expect(getCatalogEntriesForRoute('opencode').some(entry => entry.apiName === 'minimax-m3.1-flash-free')).toBe(true)
  expect(getModel('opencode-minimax-m3.1-flash-free')?.defaultModel).toBe('minimax-m3.1-flash-free')
})

test.each(['openrouter', 'opencode-go', 'custom'])('%s discovery owns its MiniMax availability', routeId => {
  const models = ['minimax-m2.5', 'minimax/minimax-m2.7']
  expect(buildRouteCatalogModelOptions(
    'Gateway', models.map(apiName => ({ id: apiName, apiName })), undefined, routeId,
  ).map(option => option.value)).toEqual(models)
})

test.each(['ollama', 'lmstudio', 'atomic-chat'])('%s catalog options retain provider-owned MiniMax model identities', routeId => {
  const models = ['minimax-m3.1-flash:cloud', 'minimax-m3:cloud', 'minimax-m2.7:cloud', 'minimaxai/minimax-m2.7', 'minimax-m3.1-flash-q4_k_m']
  const options = buildRouteCatalogModelOptions(
    'Custom display label',
    models.map(apiName => ({ id: apiName, apiName })),
    undefined,
    routeId,
  )
  expect(options.map(option => option.value)).toEqual(models)
})
