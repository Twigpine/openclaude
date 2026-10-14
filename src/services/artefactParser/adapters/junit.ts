/**
 * JUnit XML adapter for artefactParser.
 *
 * Registers itself on import via the parser's registerAdapter.
 */

import { getDefaultParser } from '../parser.js'
import { DOMParser } from '@xmldom/xmldom'
import type { Document as XDocument, Element as XElement, Node as XNode } from '@xmldom/xmldom'
import type {
  FormatAdapter,
  ParseOptions,
  ParseWarning,
  JUnitReport,
  JUnitTestSuite,
  JUnitTestCase,
} from '../types.js'

// ============================================================================
// Adapter implementation
// ============================================================================

class JUnitXmlAdapter implements FormatAdapter<JUnitReport> {
  readonly format = 'junit-xml' as const
  readonly mediaTypes = ['application/xml', 'text/xml'] as const
  readonly extensions = ['xml'] as const

  canParse(bytes: Uint8Array): boolean {
    const text = new TextDecoder().decode(bytes.slice(0, 4096))
    return text.trimStart().startsWith('<?xml')
      && (text.includes('<testsuite') || text.includes('<testsuites'))
      && (text.includes('</testsuite>') || text.includes('</testsuites>'))
  }

  async parse(bytes: Uint8Array, options: ParseOptions): Promise<{ data: JUnitReport; warnings: ParseWarning[] }> {
    const text = new TextDecoder().decode(bytes)
    const warnings: ParseWarning[] = []

    let doc: XDocument
    try {
      const parser = new DOMParser()
      doc = parser.parseFromString(text, 'application/xml')
    } catch (err) {
      throw new ParseError('CORRUPT_INPUT', `Invalid XML: ${err}`)
    }

    // Check for XML parse errors (xmldom puts them in a parsererror element)
    const parserErrors = doc.getElementsByTagName('parsererror')
    if (parserErrors.length > 0) {
      throw new ParseError('CORRUPT_INPUT', parserErrors[0].textContent ?? 'XML parse error')
    }

    const testSuites: JUnitTestSuite[] = []
    let totals = { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 }

    // Handle both <testsuites> wrapper and bare <testsuite>
    const suiteElements = Array.from(doc.getElementsByTagName('testsuite'))
    if (suiteElements.length === 0) {
      const root = doc.documentElement
      if (root && root.tagName === 'testsuite') suiteElements.push(root)
    }

    for (const suiteEl of suiteElements) {
      const suite = parseTestSuite(suiteEl, warnings)
      testSuites.push(suite)
      totals.tests += suite.tests
      totals.failures += suite.failures
      totals.errors += suite.errors
      totals.skipped += suite.skipped
      totals.time += suite.time
    }

    if (testSuites.length === 0) {
      warnings.push({ code: 'EMPTY_SUITE', message: 'No test suites found in JUnit XML' })
    }

    return { data: { testSuites, totals }, warnings }
  }

  validate(data: JUnitReport): ParseWarning[] {
    const warnings: ParseWarning[] = []
    if (data.totals.tests === 0) {
      warnings.push({ code: 'NO_TESTS', message: 'Report contains zero tests' })
    }
    if (data.totals.time === 0 && data.totals.tests > 0) {
      warnings.push({ code: 'ZERO_DURATION', message: 'All tests report zero duration' })
    }
    return warnings
  }
}

// ============================================================================
// XML parsing helpers (using xmldom API - no querySelector)
// ============================================================================

function getChildElements(parent: XElement, tagName: string): XElement[] {
  const nodes = parent.getElementsByTagName(tagName)
  const result: XElement[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.parentElement === parent) result.push(node)
  }
  return result
}

function getFirstChildElement(parent: XElement, tagName: string): XElement | null {
  const nodes = parent.getElementsByTagName(tagName)
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].parentElement === parent) return nodes[i]
  }
  return null
}

// xmldom doesn't support querySelector, so we need to handle tag names with hyphens
function getFirstChildElementNS(parent: XElement, localName: string): XElement | null {
  const allChildren = parent.childNodes
  for (let i = 0; i < allChildren.length; i++) {
    const node = allChildren[i]
    if (node.nodeType === 1 && (node as XElement).localName === localName) {
      return node as XElement
    }
  }
  return null
}

function getAttr(el: XElement, name: string, def = ''): string {
  return el.getAttribute(name) ?? def
}

function getAttrNum(el: XElement, name: string, def = 0): number {
  return Number(getAttr(el, name)) || def
}

function parseTestSuite(el: XElement, warnings: ParseWarning[]): JUnitTestSuite {
  const name = getAttr(el, 'name', 'unnamed')
  const tests = getAttrNum(el, 'tests')
  const failures = getAttrNum(el, 'failures')
  const errors = getAttrNum(el, 'errors')
  const skipped = getAttrNum(el, 'skipped')
  const time = getAttrNum(el, 'time')

  const properties: Record<string, string> = {}
  const propsEl = getFirstChildElement(el, 'properties')
  if (propsEl) {
    for (const prop of Array.from(propsEl.getElementsByTagName('property'))) {
      if (prop.parentElement === propsEl) {
        properties[getAttr(prop, 'name', '')] = getAttr(prop, 'value', '')
      }
    }
  }

  const testCases: JUnitTestCase[] = []
  for (const tcEl of getChildElements(el, 'testcase')) {
    testCases.push(parseTestCase(tcEl, warnings))
  }

  // Warn if counts don't match actual testcases
  if (tests !== testCases.length) {
    warnings.push({
      code: 'COUNT_MISMATCH',
      message: `testsuite "${name}" declares ${tests} tests but contains ${testCases.length} testcase elements`,
    })
  }

  return { name, tests, failures, errors, skipped, time, testCases, properties }
}

function parseTestCase(el: XElement, warnings: ParseWarning[]): JUnitTestCase {
  const name = getAttr(el, 'name', 'unnamed')
  const className = getAttr(el, 'classname') || undefined
  const time = getAttrNum(el, 'time')

  let status: JUnitTestCase['status'] = 'passed'
  let failure: JUnitTestCase['failure']

  const failureEl = getFirstChildElement(el, 'failure')
  const errorEl = getFirstChildElement(el, 'error')
  const skippedEl = getFirstChildElement(el, 'skipped')

  if (failureEl) {
    status = 'failed'
    failure = {
      message: getAttr(failureEl, 'message', ''),
      type: getAttr(failureEl, 'type', 'AssertionError'),
      content: failureEl.textContent ?? '',
    }
  } else if (errorEl) {
    status = 'error'
    failure = {
      message: getAttr(errorEl, 'message', ''),
      type: getAttr(errorEl, 'type', 'Error'),
      content: errorEl.textContent ?? '',
    }
  } else if (skippedEl) {
    status = 'skipped'
  }

  const systemOutEl = getFirstChildElementNS(el, 'system-out')
  const systemErrEl = getFirstChildElementNS(el, 'system-err')

  return {
    name,
    className,
    time,
    status,
    failure,
    systemOut: systemOutEl?.textContent ?? undefined,
    systemErr: systemErrEl?.textContent ?? undefined,
  }
}

// ============================================================================
// Error class (matches parser's expectation)
// ============================================================================

class ParseError extends Error {
  code: 'CORRUPT_INPUT' | 'SCHEMA_VIOLATION'
  constructor(code: 'CORRUPT_INPUT' | 'SCHEMA_VIOLATION', message: string) {
    super(message)
    this.name = 'ParseError'
    this.code = code
  }
}

// ============================================================================
// Auto-registration on import
// ============================================================================

getDefaultParser().registerAdapter(new JUnitXmlAdapter())