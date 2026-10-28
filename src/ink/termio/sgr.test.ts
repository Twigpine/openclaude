import { expect, test } from 'bun:test'
import { applySGR } from './sgr.js'
import { defaultStyle } from './types.js'

test('flushes the final SGR parameter with or without trailing separators', () => {
  expect(applySGR('1;31', defaultStyle())).toMatchObject({
    bold: true,
    fg: { type: 'named', name: 'red' },
  })
  for (const params of ['', ';', '1;', '1;;']) {
    expect(applySGR(params, { ...defaultStyle(), bold: true })).toEqual(defaultStyle())
  }
})

test('retains the final extended-color and underline subparameters', () => {
  expect(applySGR('38;2;12;34;56', defaultStyle()).fg).toEqual({
    type: 'rgb', r: 12, g: 34, b: 56,
  })
  expect(applySGR('48:2::12:34:56', defaultStyle()).bg).toEqual({
    type: 'rgb', r: 12, g: 34, b: 56,
  })
  expect(applySGR('38:5:123', defaultStyle()).fg).toEqual({ type: 'indexed', index: 123 })
  expect(applySGR('4:3', defaultStyle()).underline).toBe('curly')
})
