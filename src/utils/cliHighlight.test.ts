import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { stripVTControlCharacters } from 'node:util'
import baseline from '../test/fixtures/cliHighlight.baseline.json'
import { getCliHighlightPromise, getLanguageName, type CliHighlight } from './cliHighlight.js'
import { applyMarkdown } from './markdown.js'

let previousLevel: typeof chalk.level
let highlighter: CliHighlight

beforeEach(async () => {
  previousLevel = chalk.level
  chalk.level = 1
  const loaded = await getCliHighlightPromise()
  expect(loaded).not.toBeNull()
  highlighter = loaded!
})

afterEach(() => { chalk.level = previousLevel })

// Captured from the previous renderer at color level 1. Compare ANSI bytes,
// including nested color restoration, rather than only the visible text.
describe('terminal syntax output compatibility', () => {
  for (const fixture of baseline) {
    test(fixture.name, () => {
      expect(highlighter.highlight(fixture.code, { language: fixture.language }))
        .toBe(fixture.output)
    })
  }

  test('disabled colors preserve visible output', () => {
    chalk.level = 0
    for (const fixture of baseline) {
      expect(highlighter.highlight(fixture.code, { language: fixture.language }))
        .toBe(stripVTControlCharacters(fixture.output))
    }
  })

  test('aliases and telemetry use the shared language registry', async () => {
    expect(getCliHighlightPromise()).toBe(getCliHighlightPromise())
    expect(highlighter.supportsLanguage('ts')).toBe(true)
    expect(highlighter.supportsLanguage('unsupported-language')).toBe(false)
    expect(await getLanguageName('example.ts')).toBe('TypeScript')
    expect(await getLanguageName('example.unsupported-language')).toBe('unknown')
    expect(await getLanguageName('README')).toBe('unknown')
  })

  test('Markdown keeps the syntax palette in dark and light themes', () => {
    const fixture = baseline.find(item => item.name === 'json')!
    for (const theme of ['dark', 'light'] as const) {
      expect(applyMarkdown('```json\n' + fixture.code + '\n```', theme, highlighter))
        .toBe(fixture.output)
    }
  })

  test('unknown and missing fenced languages fall back to plaintext', () => {
    const code = 'const value = "<&>"; // keep plain'
    for (const language of ['unsupported-language', '']) {
      expect(applyMarkdown('```' + language + '\n' + code + '\n```', 'dark', highlighter))
        .toBe(code)
    }
  })
})
