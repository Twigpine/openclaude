import { afterEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import {
  createStreamlinedTransformer,
  resolveStreamlinedTransformer,
} from './streamlinedTransform.js'

const SAVED = process.env.CLAUDE_CODE_STREAMLINED_OUTPUT

afterEach(() => {
  if (SAVED === undefined) {
    delete process.env.CLAUDE_CODE_STREAMLINED_OUTPUT
  } else {
    process.env.CLAUDE_CODE_STREAMLINED_OUTPUT = SAVED
  }
})

describe('resolveStreamlinedTransformer', () => {
  test('returns a transformer for stream-json with the env opt-in only when the flag is on', () => {
    process.env.CLAUDE_CODE_STREAMLINED_OUTPUT = 'true'

    const transformer = resolveStreamlinedTransformer('stream-json')
    if (feature('STREAMLINED_OUTPUT')) {
      expect(transformer).not.toBeNull()
    } else {
      expect(transformer).toBeNull()
    }
  })

  test('returns null without the env opt-in even when the flag is on', () => {
    delete process.env.CLAUDE_CODE_STREAMLINED_OUTPUT

    expect(resolveStreamlinedTransformer('stream-json')).toBeNull()
  })

  test('returns null for other output formats even with the env opt-in', () => {
    process.env.CLAUDE_CODE_STREAMLINED_OUTPUT = 'true'

    expect(resolveStreamlinedTransformer('json')).toBeNull()
    expect(resolveStreamlinedTransformer('text')).toBeNull()
  })
})

describe('createStreamlinedTransformer', () => {
  test('passes control-protocol messages through unchanged', () => {
    const transform = createStreamlinedTransformer()

    const initResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { commands: [], output_styles: [] },
      },
    }
    const permissionRequest = {
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'can_use_tool', tool_name: 'Bash' },
    }
    const cancel = { type: 'control_cancel_request', request_id: 'req-2' }

    for (const message of [initResponse, permissionRequest, cancel]) {
      expect(transform(message)).toBe(message)
    }
  })
})
