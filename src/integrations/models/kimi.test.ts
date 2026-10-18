import { expect, test } from 'bun:test'

import { getModel, getModelsForBrand } from '../index.js'

test('K3 belongs to the Kimi brand', () => {
  expect(getModel('k3')?.brandId).toBe('kimi')
  expect(getModelsForBrand('kimi').map(model => model.id)).toContain('k3')
})
