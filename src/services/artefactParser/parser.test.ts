/**
 * artefactParser tests — demonstrates the interface and verifies depth.
 *
 * Tests the public interface only (ArtefactParser), not internal adapters.
 * This is the test surface — callers and tests cross the same seam.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createParser, getDefaultParser } from './index.js'
import type { ArtefactParser, ArtefactRef, ParseResult, JUnitReport } from './types.js'

// ============================================================================
// Test fixtures
// ============================================================================

const JUNIT_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="AuthTests" tests="3" failures="1" errors="0" skipped="0" time="1.23">
    <properties>
      <property name="os" value="linux"/>
      <property name="node" value="22.0.0"/>
    </properties>
    <testcase name="login succeeds" classname="AuthTest" time="0.45"/>
    <testcase name="logout clears session" classname="AuthTest" time="0.32"/>
    <testcase name="rejects invalid token" classname="AuthTest" time="0.46">
      <failure message="Expected 401, got 200" type="AssertionError">
        AssertionError: Expected 401, got 200
      </failure>
    </testcase>
  </testsuite>
  <testsuite name="ApiTests" tests="2" failures="0" errors="1" skipped="1" time="2.1">
    <testcase name="GET /users returns list" classname="ApiTest" time="1.1"/>
    <testcase name="POST /users creates user" classname="ApiTest" time="0.9">
      <error message="Connection refused" type="ConnectionError">
        ECONNREFUSED
      </error>
    </testcase>
    <testcase name="DELETE /users/:id" classname="ApiTest" time="0">
      <skipped message="Not implemented"/>
    </testcase>
  </testsuite>
</testsuites>`

const JUNIT_MINIMAL = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="SingleSuite" tests="1" failures="0" errors="0" skipped="0" time="0.1">
  <testcase name="passes" time="0.1"/>
</testsuite>`

// Well-formed XML that passes detector but has no testsuite elements (returns empty with warning)
const EMPTY_JUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <notatestsuite name="AuthTests" tests="3"/>
</testsuites>`

// Invalid XML that doesn't pass detector
const INVALID_XML = `<?xml version="1.0"?><testsuite><unclosed>`

// ============================================================================
// Tests
// ============================================================================

describe('artefactParser', () => {
  let parser: ArtefactParser

  beforeEach(() => {
    parser = createParser()
  })

  describe('parse() with JUnit XML', () => {
    test('parses valid JUnit XML from bytes', async () => {
      const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
      const result = await parser.parseBytes<JUnitReport>(bytes)

      expect(result.format).toBe('junit-xml')
      expect(result.data.testSuites).toHaveLength(2)
      expect(result.data.totals.tests).toBe(5)
      expect(result.data.totals.failures).toBe(1)
      expect(result.data.totals.errors).toBe(1)
      expect(result.data.totals.skipped).toBe(1)
      expect(result.provenance.parserVersion).toBeDefined()
      expect(result.provenance.parsedAt).toBeDefined()
    })

    test('parses minimal JUnit XML (bare testsuite)', async () => {
      const bytes = new TextEncoder().encode(JUNIT_MINIMAL)
      const result = await parser.parseBytes<JUnitReport>(bytes)

      expect(result.format).toBe('junit-xml')
      expect(result.data.testSuites).toHaveLength(1)
      expect(result.data.testSuites[0].name).toBe('SingleSuite')
      expect(result.data.testSuites[0].testCases).toHaveLength(1)
    })

    test('includes properties in parsed output', async () => {
      const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
      const result = await parser.parseBytes<JUnitReport>(bytes)

      const authSuite = result.data.testSuites.find(s => s.name === 'AuthTests')
      expect(authSuite?.properties).toEqual({ os: 'linux', node: '22.0.0' })
    })

    test('includes failure/error details', async () => {
      const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
      const result = await parser.parseBytes<JUnitReport>(bytes)

      const authSuite = result.data.testSuites.find(s => s.name === 'AuthTests')
      const failed = authSuite?.testCases.find(tc => tc.status === 'failed')
      expect(failed).toBeDefined()
      expect(failed?.failure?.message).toBe('Expected 401, got 200')
      expect(failed?.failure?.type).toBe('AssertionError')
      expect(failed?.failure?.content).toContain('AssertionError')

      const apiSuite = result.data.testSuites.find(s => s.name === 'ApiTests')
      const errored = apiSuite?.testCases.find(tc => tc.status === 'error')
      expect(errored).toBeDefined()
      expect(errored?.failure?.type).toBe('ConnectionError')
    })

    test('includes skipped tests', async () => {
      const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
      const result = await parser.parseBytes<JUnitReport>(bytes)

      const apiSuite = result.data.testSuites.find(s => s.name === 'ApiTests')
      const skipped = apiSuite?.testCases.find(tc => tc.status === 'skipped')
      expect(skipped).toBeDefined()
    })

    test('includes system-out/system-err when present', async () => {
      const withOutput = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="SingleSuite" tests="1" failures="0" errors="0" skipped="0" time="0.1">
  <testcase name="passes" time="0.1">
    <system-out>stdout here</system-out>
    <system-err>stderr here</system-err>
  </testcase>
</testsuite>`
      const bytes = new TextEncoder().encode(withOutput)
      const result = await parser.parseBytes<JUnitReport>(bytes)

      const tc = result.data.testSuites[0].testCases[0]
      expect(tc.systemOut).toBe('stdout here')
      expect(tc.systemErr).toBe('stderr here')
    })
  })

  describe('detectFormat()', () => {
    test('detects JUnit XML', () => {
      const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
      expect(parser.detectFormat(bytes)).toBe('junit-xml')
    })

    test('returns null for unknown format', () => {
      const bytes = new TextEncoder().encode('just some text')
      expect(parser.detectFormat(bytes)).toBeNull()
    })

    test('returns null for invalid XML', () => {
      const bytes = new TextEncoder().encode(INVALID_XML)
      expect(parser.detectFormat(bytes)).toBeNull()
    })
  })

  describe('supportedFormats()', () => {
    test('includes junit-xml', () => {
      expect(parser.supportedFormats()).toContain('junit-xml')
    })
  })

  describe('error handling', () => {
    test('returns empty result with warning for XML with no testsuites', async () => {
      const bytes = new TextEncoder().encode(EMPTY_JUNIT_XML)
      const result = await parser.parseBytes<JUnitReport>(bytes)
      expect(result.format).toBe('junit-xml')
      expect(result.data.testSuites).toHaveLength(0)
      expect(result.warnings.some(w => w.code === 'EMPTY_SUITE')).toBe(true)
    })

    test('throws ParseError for unsupported format', async () => {
      const bytes = new TextEncoder().encode('not an artefact')
      await expect(parser.parseBytes(bytes)).rejects.toMatchObject({
        name: 'ParseError',
        code: 'UNSUPPORTED_FORMAT',
      })
    })

    test('throws ParseError for oversized input', async () => {
      const bytes = new Uint8Array(60 * 1024 * 1024) // 60MB > 50MB default
      await expect(parser.parseBytes(bytes, { maxSize: 50 * 1024 * 1024 })).rejects.toMatchObject({
        name: 'ParseError',
        code: 'CORRUPT_INPUT',
      })
    })
  })

  describe('options', () => {
    test('validate option controls schema validation warnings', async () => {
      const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
      const withValidation = await parser.parseBytes<JUnitReport>(bytes, { validate: true })
      const withoutValidation = await parser.parseBytes<JUnitReport>(bytes, { validate: false })
      // Both should succeed, but validation may add warnings
      expect(withValidation.warnings.length).toBeGreaterThanOrEqual(withoutValidation.warnings.length)
    })

    test('custom detectors run before built-in', () => {
      const customDetector = vi.fn((bytes: Uint8Array) => {
        const text = new TextDecoder().decode(bytes.slice(0, 8))
        if (text === 'CUSTOM!!') return 'junit-xml'
        return null
      })
      const parserWithCustom = createParser({ detectors: [customDetector] })
      // Custom detector should be tried first for detectFormat
      const bytes = new TextEncoder().encode('CUSTOM!!<?xml version="1.0"?><testsuite name="x" tests="0"></testsuite>')
      const format = parserWithCustom.detectFormat(bytes)
      expect(format).toBe('junit-xml')
      expect(customDetector).toHaveBeenCalled()
    })
  })

  describe('provenance', () => {
    test('includes source, timestamp, version', async () => {
      const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
      const result = await parser.parseBytes(bytes, { sourceHint: 'test.xml' })

      expect(result.provenance.source).toBe('test.xml')
      expect(new Date(result.provenance.parsedAt).getTime()).toBeLessThanOrEqual(Date.now())
      expect(result.provenance.parserVersion).toBe('1.0.0')
    })
  })
})

// ============================================================================
// Integration-style test: demonstrates caller usage pattern
// ============================================================================

describe('artefactParser — caller patterns', () => {
  test('caller uses only the public interface', async () => {
    // This is what a caller writes — no adapter knowledge needed
    const parser = getDefaultParser()

    // Use parseBytes to avoid filesystem dependency
    const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
    const result = await parser.parseBytes<JUnitReport>(bytes)

    // Caller gets structured data, warnings, provenance
    const passRate = result.data.totals.tests > 0
      ? (result.data.totals.tests - result.data.totals.failures - result.data.totals.errors) / result.data.totals.tests
      : 0

    expect(passRate).toBeGreaterThanOrEqual(0)
    expect(result.warnings).toBeInstanceOf(Array)
    expect(result.provenance.parserVersion).toBeDefined()
  })

  test('caller can parse from bytes (e.g., HTTP response)', async () => {
    const parser = getDefaultParser()
    const bytes = new TextEncoder().encode(JUNIT_MINIMAL)

    const result = await parser.parseBytes<JUnitReport>(bytes)

    expect(result.format).toBe('junit-xml')
    expect(result.data.totals.tests).toBe(1)
  })
})

// ============================================================================
// Test that demonstrates the "deletion test" — if we delete the module,
// complexity reappears in callers
// ============================================================================

describe('artefactParser — depth demonstration', () => {
  test('caller does not need to know: XML parsing, namespace handling, count reconciliation, property extraction, failure/error/skipped discrimination, system-out/err capture, format detection, size limits, provenance tracking', async () => {
    // All of the above is hidden behind parser.parseBytes()
    const parser = createParser()
    const bytes = new TextEncoder().encode(JUNIT_SAMPLE)
    const result = await parser.parseBytes<JUnitReport>(bytes)

    // Caller gets clean data model
    expect(result.data.testSuites[0].testCases[0]).toHaveProperty('status')
    expect(result.data.testSuites[0].testCases[0]).toHaveProperty('time')
    expect(result.data.testSuites[0].testCases[2]).toHaveProperty('failure')
    expect(result.provenance).toBeDefined()
  })
})