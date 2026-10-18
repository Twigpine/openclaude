/**
 * Tests for Web Search Provider result count configurations.
 */

import { describe, test, expect } from 'bun:test'
import { resolve } from 'path'

const SRC = resolve(import.meta.dir, '..', 'tools', 'WebSearchTool', 'providers')
const file = (name: string) => Bun.file(resolve(SRC, name))

describe('Provider result counts', () => {
  const providers = [
    'bing.ts',
    'tavily.ts',
    'exa.ts',
    'firecrawl.ts',
    'mojeek.ts',
    'you.ts',
    'jina.ts',
    'duckduckgo.ts',
    'ollama.ts',
    // linkup.ts excluded — uses depth param, not a result count field
  ]

  for (const name of providers) {
    test(`${name} exists and is readable`, async () => {
      const f = file(name)
      expect(await f.exists()).toBe(true)
      const content = await f.text()
      expect(content.length).toBeGreaterThan(100)
    })
  }

  test('No provider hardcodes a limit below 10', async () => {
    const suspiciousPatterns = [
      /count['":\s]*['"]([1-9])['"]/i,
      /limit['":\s]*([1-9])\b/,
      /max_results['":\s]*([1-9])\b/,
      /numResults['":\s]*([1-9])\b/,
    ]

    for (const name of providers) {
      const content = await file(name).text()
      for (const pattern of suspiciousPatterns) {
        const match = content.match(pattern)
        if (match) {
          const num = parseInt(match[1], 10)
          expect(
            num,
            `${name} has suspiciously low result count: ${match[0]}`,
          ).toBeGreaterThanOrEqual(10)
        }
      }
    }
  })
})
