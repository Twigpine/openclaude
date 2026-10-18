import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

const facadePath = fileURLToPath(new URL('./openaiShim.ts', import.meta.url))
const moduleDirectory = fileURLToPath(new URL('./openaiShim/', import.meta.url))

const extractionDeltas = [
  ['streamControl.ts', 169],
  ['providerCompatibility.ts', 115],
  ['ollamaAdapter.ts', 387],
  ['messageConversion.ts', 474],
  ['rawToolCallParsing.ts', 291],
  ['xmlToolCallParsing.ts', 356],
  ['streamConversion.ts', 1_072],
  ['clientDispatch.ts', 182],
  ['requestPlanner.ts', 304],
  ['requestExecutor.ts', 704],
  ['transport.ts', 361],
  ['responseAdapters.ts', 189],
  ['requestPreparation.ts', 247],
  ['codexDispatch.ts', 109],
] as const

const upstreamExtractionCount = 11

describe('openaiShim facade architecture', () => {
  test('does not regain logic removed by the independent extractions', () => {
    for (const [moduleName] of extractionDeltas.slice(0, upstreamExtractionCount)) {
      expect(existsSync(join(moduleDirectory, moduleName))).toBe(true)
    }
    const activeReduction = extractionDeltas
      .filter(([moduleName]) => existsSync(join(moduleDirectory, moduleName)))
      .reduce(
        (total, [, reduction]) => total + reduction,
        0,
      )
    const facadeLines = readFileSync(facadePath, 'utf8').trimEnd().split('\n').length
    expect(facadeLines).toBeLessThanOrEqual(5_636 - activeReduction)
  })

  test('keeps every extracted production module paired with its own test', () => {
    const files = readdirSync(moduleDirectory)
    const productionModules = files.filter(file =>
      file.endsWith('.ts') && !file.endsWith('.test.ts'),
    )
    for (const moduleName of productionModules) {
      expect(files).toContain(moduleName.replace(/\.ts$/, '.test.ts'))
    }
  })
})
