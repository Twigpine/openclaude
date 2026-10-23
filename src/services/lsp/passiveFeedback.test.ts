import { describe, expect, test } from 'bun:test'
import type { Diagnostic } from 'vscode-languageserver-protocol'
import { formatDiagnosticsForAttachment } from './passiveFeedback.js'

describe('formatDiagnosticsForAttachment', () => {
  test.each([
    ['plain text', 'Missing import'],
    ['markdown', { kind: 'markdown', value: '**Missing import**' }],
    ['plaintext markup', { kind: 'plaintext', value: 'Missing import' }],
  ] satisfies [string, Diagnostic['message']][])(
    'preserves diagnostic text and metadata for %s messages',
    (_label, message) => {
      const range = {
        start: { line: 2, character: 3 },
        end: { line: 2, character: 9 },
      }

      expect(formatDiagnosticsForAttachment({
        uri: 'file:///workspace/example.ts',
        diagnostics: [{ message, range, severity: 2, source: 'typescript', code: 2304 }],
      })).toEqual([{
        uri: '/workspace/example.ts',
        diagnostics: [{
          message: typeof message === 'string' ? message : message.value,
          range,
          severity: 'Warning',
          source: 'typescript',
          code: '2304',
        }],
      }])
    },
  )
})
