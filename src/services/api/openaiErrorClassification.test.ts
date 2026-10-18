import { expect, test } from 'bun:test'

import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
  extractOpenAICategoryHost,
  extractOpenAICategoryMarker,
  formatOpenAICategoryMarker,
  isLocalhostLikeHost,
  isRetryableOpenAICompatibilityFailureCategory,
} from './openaiErrorClassification.js'

test('classifies localhost ECONNREFUSED as connection_refused', () => {
  const error = Object.assign(new TypeError('fetch failed'), {
    code: 'ECONNREFUSED',
  })

  const failure = classifyOpenAINetworkFailure(error, {
    url: 'http://localhost:11434/v1/chat/completions',
  })

  expect(failure.category).toBe('connection_refused')
  expect(failure.retryable).toBe(true)
  expect(failure.code).toBe('ECONNREFUSED')
  expect(failure.hint).toContain('local server is running')
})

test('classifies localhost ENOTFOUND as localhost_resolution_failed', () => {
  const error = Object.assign(new TypeError('getaddrinfo ENOTFOUND localhost'), {
    code: 'ENOTFOUND',
  })

  const failure = classifyOpenAINetworkFailure(error, {
    url: 'http://localhost:11434/v1/chat/completions',
  })

  expect(failure.category).toBe('localhost_resolution_failed')
  expect(failure.retryable).toBe(true)
  expect(failure.code).toBe('ENOTFOUND')
  expect(failure.hint).toContain('127.0.0.1')
})

test('classifies model-not-found 404 responses', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 404,
    body: 'The model qwen2.5-coder:7b was not found',
  })

  expect(failure.category).toBe('model_not_found')
  expect(failure.retryable).toBe(false)
})

test('classifies generic 404 responses as endpoint_not_found', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 404,
    body: 'Not Found',
  })

  expect(failure.category).toBe('endpoint_not_found')
  expect(failure.hint).toContain('/v1')
})

test('classifies 404 with images as vision_not_supported', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 404,
    body: 'Not Found',
    hasImages: true,
  })

  expect(failure.category).toBe('vision_not_supported')
  expect(failure.retryable).toBe(false)
  expect(failure.hint).toContain('image')
})

test('classifies 400 with "text is not set" + images as vision_not_supported (issue #1421)', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: '{"error":{"code":"400","message":"Param Incorrect","param":"`text` is not set","type":""}}',
    hasImages: true,
  })

  expect(failure.category).toBe('vision_not_supported')
  expect(failure.retryable).toBe(false)
  expect(failure.hint).toContain('image')
})

test('classifies 400 with "text is required" + images as vision_not_supported (issue #1421)', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: '{"error":{"message":"text parameter is required"}}',
    hasImages: true,
  })

  expect(failure.category).toBe('vision_not_supported')
})

test('does not classify 400 with "text is not set" when request has no images', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: '{"error":{"message":"text is not set"}}',
    hasImages: false,
  })

  // Without images, "text is not set" is unrelated to vision capability.
  expect(failure.category).not.toBe('vision_not_supported')
})

test('classifies context-overflow responses', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 500,
    body: 'request too large: maximum context length exceeded',
  })

  expect(failure.category).toBe('context_overflow')
  expect(failure.retryable).toBe(false)
})

test('401 "token expired" surfaces a re-auth hint, not the generic API-key hint (issue #1042)', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 401,
    body: 'IDE token expired: unauthorized: token expired',
  })

  expect(failure.category).toBe('auth_invalid')
  expect(failure.hint).toContain('/onboard-github')
  expect(failure.hint).toContain('/login')
  expect(failure.hint).not.toContain('API key')
})

test('401 without expired-token signal keeps the generic API-key hint', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 401,
    body: 'invalid_api_key: incorrect API key provided',
  })

  expect(failure.category).toBe('auth_invalid')
  expect(failure.hint).toContain('API key')
  expect(failure.hint).not.toContain('/onboard-github')
})

test('classifies tool compatibility failures', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'tool_calls are not supported by this model',
  })

  expect(failure.category).toBe('tool_call_incompatible')
})

test('classifies tool_stream rejection as tool_stream_unsupported (#1950)', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Validation: Unsupported parameter(s): `tool_stream`',
  })

  expect(failure.category).toBe('tool_stream_unsupported')
  expect(failure.retryable).toBe(false)
})

test.each([
  'Unsupported parameter: stream_options',
  'Unrecognized request argument supplied: stream_options',
  'Parameter stream_options is not supported',
  'stream_options is not supported by this API',
  '{"error":{"message":"Unknown parameter","param":"stream_options"}}',
  '{"error":{"message":"Unknown parameter","param":"`stream_options`"}}',
  '{"error":{"message":"Invalid parameter: stream_options","type":"invalid_request_error","param":"stream_options"}}',
  '{"detail":[{"type":"extra_forbidden","loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}]}',
  '{"detail":[{"type":"extra_forbidden","loc":["stream_options"],"msg":"Extra inputs are not permitted"}]}',
])('classifies top-level stream_options rejections: %s', body => {
  const failure = classifyOpenAIHttpFailure({ status: 400, body })

  expect(failure.category).toBe('stream_options_unsupported')
  expect(failure.retryable).toBe(false)
})

test('classifies a FastAPI stream_options rejection at status 422', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 422,
    body: '{"detail":[{"type":"value_error.extra","loc":["body","stream_options"],"msg":"extra fields not permitted"}]}',
  })

  expect(failure.category).toBe('stream_options_unsupported')
})

test.each([
  'Invalid request for model local-model; received stream_options in the request body',
  'Unsupported parameter: stream_options.include_usage',
  'Unknown parameter: stream_options[include_usage]',
  'Invalid parameter: stream_options/include_usage must be a boolean',
  '{"error":{"message":"Invalid parameter: stream_options.include_usage must be a boolean","param":"stream_options.include_usage"}}',
  '{"error":{"message":"stream_options.include_usage must be a boolean","param":"stream_options.include_usage"}}',
  '{"detail":[{"type":"bool_type","loc":["body","stream_options","include_usage"],"msg":"Input should be a valid boolean"}]}',
  '{"detail":[{"type":"dict_type","loc":["body","stream_options"],"msg":"Input should be an object"},{"type":"bool_type","loc":["body","stream_options","include_usage"],"msg":"Input should be a valid boolean"}]}',
])('does not classify unrelated or nested stream_options validation failures: %s', body => {
  const failure = classifyOpenAIHttpFailure({ status: 400, body })

  expect(failure.category).not.toBe('stream_options_unsupported')
})

test('prioritizes tool_stream rejection over accompanying tool-call wording', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Invalid parameter tool_stream; tool_calls are not supported by this model',
  })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test('classifies OpenAI-style unrecognized tool_stream arguments', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Unrecognized request argument supplied: tool_stream',
  })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test('classifies a tool_stream parameter rejection that is conditional on function calls', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Invalid parameter tool_stream in function calls',
  })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test('classifies a top-level tool_stream rejection that explains function parameters', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Unsupported parameter tool_stream in function parameters',
  })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test.each([
  "Unknown parameter: 'tool_stream'",
  'Invalid parameter: "tool_stream"',
  "Parameter 'tool_stream' is not supported",
  'Unsupported parameters: tool_stream',
  'Unsupported parameter(s): ["tool_stream"]',
  'Unsupported parameter: (tool_stream)',
  'Unknown parameters: [tool_stream]',
  "Parameter 'tool_stream' is unknown",
  "'tool_stream' is an unknown parameter",
  'Invalid "tool_stream" parameter',
  'tool_stream is unsupported',
  'Unsupported parameter(s): tool_stream. Tools are available only in non-streaming mode.',
  '{"error":{"message":"tool_stream is unsupported"}}',
  '{"error":{"message":"tool_stream is not supported"}}',
  '{"error":{"message":"Unknown parameter","param":"tool_stream"}}',
  '{"error":{"message":"Invalid parameter","param":"tool_stream"}}',
  '{"detail":[{"type":"extra_forbidden","loc":["body","tool_stream"],"msg":"Extra inputs are not permitted","input":true}]}',
  '{"detail":[{"type":"value_error.extra","loc":["body","tool_stream"],"msg":"extra fields not permitted"}]}',
  'Additional properties are not allowed ("tool_stream" was unexpected)',
])('classifies quoted tool_stream parameter rejections: %s', body => {
  const failure = classifyOpenAIHttpFailure({ status: 400, body })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test('classifies a FastAPI validation rejection at its normal 422 status', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 422,
    body: '{"detail":[{"type":"extra_forbidden","loc":["body","tool_stream"],"msg":"Extra inputs are not permitted","input":true}]}',
  })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test('classifies a root structured tool_stream unsupported message', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 422,
    body: JSON.stringify({
      detail: [{
        type: 'value_error',
        loc: ['body', 'tool_stream'],
        msg: 'tool_stream is unsupported',
      }],
    }),
  })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test('classifies a root tool_stream extra-field rejection alongside tool validation details', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 422,
    body: JSON.stringify({
      detail: [
        {
          type: 'extra_forbidden',
          loc: ['body', 'tool_stream'],
          msg: 'Extra inputs are not permitted',
        },
        {
          type: 'missing',
          loc: ['body', 'tools'],
          msg: 'Field required',
        },
      ],
    }),
  })

  expect(failure.category).toBe('tool_stream_unsupported')
})

test('does not classify a generic 400 as tool_stream_unsupported', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Invalid request: missing required field `messages`',
  })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test.each([
  'Tool "tool_stream" is unsupported',
  "Function 'tool_stream' is invalid",
  'Tool: tool_stream is unsupported',
  'Function: tool_stream is invalid',
  'tool_stream is unsupported as a function',
  'tool_stream is unsupported as a tool',
  'Additional properties are not allowed in function tool_stream',
  'The tool named "tool_stream" is unsupported',
  'Function name tool_stream is invalid',
])('does not classify a tool name error as a tool_stream parameter rejection: %s', body => {
  const failure = classifyOpenAIHttpFailure({ status: 400, body })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test('does not classify an invalid schema for a tool named tool_stream as a parameter rejection', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: "Invalid schema for function 'tool_stream': properties must be an object",
  })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test('does not classify a raw tool-schema property error as a parameter rejection', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: "Invalid schema for function 'Bash': Additional properties are not allowed ('tool_stream' was unexpected)",
  })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test('does not classify a tool-schema error whose location follows the parameter name', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Additional properties are not allowed (tool_stream was unexpected) at body.tools.0.function.parameters.properties',
  })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test.each([
  'Invalid schema: param=tool_stream',
  'Malformed tool schema: unexpected property tool_stream',
  'Additional properties are not allowed: tool_stream in tool definition',
  'Invalid parameter tool_stream in function definition',
  'Additional properties are not allowed (tool_stream was unexpected) in the function parameters',
  'Invalid parameter tool_stream in function Bash',
  'Invalid parameter tool_stream in the function Bash',
  'Invalid parameter tool_stream for tool Bash',
  'At body.tools[0].function.parameters: Extra inputs are not permitted: tool_stream',
  'Unexpected field tool_stream in tool schema',
  'Extra inputs are not permitted: tool_stream in function parameters',
  'tool_stream unexpected field in tool schema',
])('does not classify a generic schema diagnostic as a parameter rejection: %s', body => {
  const failure = classifyOpenAIHttpFailure({ status: 400, body })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test('does not classify a structured validation error that merely references tool_stream', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: '{"error":{"message":"Parameter is required","param":"tool_stream"}}',
  })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test.each([
  '{"detail":[{"type":"missing","loc":["body","tool_stream"],"msg":"Field required"}]}',
  '{"detail":[{"type":"string_type","loc":["body","tool_stream"],"msg":"Input should be a valid string"}]}',
  '{"detail":[{"type":"extra_forbidden","loc":["body","tool_stream","mode"],"msg":"Extra inputs are not permitted"}]}',
])('does not classify a structured validation error for a supported tool_stream field: %s', body => {
  const failure = classifyOpenAIHttpFailure({ status: 400, body })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test('does not classify a structured validation error for a tool named tool_stream', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: '{"detail":[{"type":"extra_forbidden","loc":["body","tools",0,"function","name"],"msg":"Extra inputs are not permitted","input":"tool_stream"}]}',
  })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test('does not classify a structured validation error for a tool-schema property named tool_stream', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: '{"detail":[{"type":"extra_forbidden","loc":["body","tools",0,"function","parameters","properties","tool_stream"],"msg":"Extra inputs are not permitted","input":{}}]}',
  })

  expect(failure.category).not.toBe('tool_stream_unsupported')
})

test('embeds and extracts category markers in formatted messages', () => {
  const marker = formatOpenAICategoryMarker('endpoint_not_found')
  expect(marker).toBe('[openai_category=endpoint_not_found]')

  const formatted = buildOpenAICompatibilityErrorMessage('OpenAI API error 404: Not Found', {
    category: 'endpoint_not_found',
    hint: 'Confirm OPENAI_BASE_URL includes /v1.',
  })

  expect(formatted).toContain('[openai_category=endpoint_not_found]')
  expect(formatted).toContain('Hint: Confirm OPENAI_BASE_URL includes /v1.')
  expect(extractOpenAICategoryMarker(formatted)).toBe('endpoint_not_found')
})

test('ignores unknown category markers during extraction', () => {
  const malformed = 'OpenAI API error 500 [openai_category=totally_fake_category]'
  expect(extractOpenAICategoryMarker(malformed)).toBeUndefined()
})

test('endpoint_not_found 404 from a remote host gets a host-aware hint (issue #926)', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 404,
    body: 'Not Found',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
  })

  expect(failure.category).toBe('endpoint_not_found')
  expect(failure.requestUrl).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
  expect(failure.hint).toContain('integrate.api.nvidia.com')
  expect(failure.hint).not.toContain('local providers')
})

test('endpoint_not_found 404 from localhost keeps the Ollama-flavored hint', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 404,
    body: 'Not Found',
    url: 'http://127.0.0.1:11434/v1/chat/completions',
  })

  expect(failure.category).toBe('endpoint_not_found')
  expect(failure.hint).toContain('local providers')
})

test('marker round-trip preserves host segment', () => {
  const formatted = buildOpenAICompatibilityErrorMessage(
    'OpenAI API error 404: Not Found',
    {
      category: 'endpoint_not_found',
      hint: 'Endpoint at integrate.api.nvidia.com returned 404.',
      requestUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    },
  )

  expect(formatted).toContain('[openai_category=endpoint_not_found,host=integrate.api.nvidia.com]')
  expect(extractOpenAICategoryMarker(formatted)).toBe('endpoint_not_found')
  expect(extractOpenAICategoryHost(formatted)).toBe('integrate.api.nvidia.com')
})

test('marker without host stays backward-compatible', () => {
  const marker = formatOpenAICategoryMarker('endpoint_not_found')
  expect(marker).toBe('[openai_category=endpoint_not_found]')
  expect(extractOpenAICategoryMarker(marker)).toBe('endpoint_not_found')
  expect(extractOpenAICategoryHost(marker)).toBeUndefined()
})

test('reports retryability for extracted category markers', () => {
  expect(isRetryableOpenAICompatibilityFailureCategory('auth_invalid')).toBe(false)
  expect(isRetryableOpenAICompatibilityFailureCategory('model_not_found')).toBe(false)
  expect(isRetryableOpenAICompatibilityFailureCategory('context_overflow')).toBe(false)
  expect(isRetryableOpenAICompatibilityFailureCategory('rate_limited')).toBe(true)
  expect(isRetryableOpenAICompatibilityFailureCategory('provider_unavailable')).toBe(true)
  expect(isRetryableOpenAICompatibilityFailureCategory('network_error')).toBe(true)
})

test('classifies 5xx with HTML body as provider_unavailable, not malformed_provider_response', () => {
  // Regression: gateways return HTML 502/504 pages during overload. The old
  // ordering matched isMalformedProviderResponse first, marking the error
  // non-retryable and surfacing "Provider returned a malformed response"
  // even though a manual retry would succeed.
  const failure = classifyOpenAIHttpFailure({
    status: 502,
    body: '<!doctype html><html><body>Bad Gateway</body></html>',
  })

  expect(failure.category).toBe('provider_unavailable')
  expect(failure.retryable).toBe(true)
})

test('classifies 504 gateway timeout HTML as provider_unavailable', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 504,
    body: '<html><head><title>504 Gateway Time-out</title></head></html>',
  })

  expect(failure.category).toBe('provider_unavailable')
  expect(failure.retryable).toBe(true)
})

test('classifies 4xx with HTML body as malformed_provider_response (unchanged)', () => {
  // Non-5xx HTML bodies are still genuine malformed responses — the provider
  // returned something we can't parse when it should have returned JSON.
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: '<!doctype html><html><body>Bad Request</body></html>',
  })

  expect(failure.category).toBe('malformed_provider_response')
  expect(failure.retryable).toBe(false)
})

test('isLocalhostLikeHost matches loopback variants', () => {
  expect(isLocalhostLikeHost('localhost')).toBe(true)
  expect(isLocalhostLikeHost('127.0.0.1')).toBe(true)
  expect(isLocalhostLikeHost('127.0.0.5')).toBe(true)
  expect(isLocalhostLikeHost('::1')).toBe(true)
  expect(isLocalhostLikeHost('integrate.api.nvidia.com')).toBe(false)
  expect(isLocalhostLikeHost(undefined)).toBe(false)
})

test('classifies 402 Payment Required as quota_exhausted', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 402,
    body: 'Billing limit reached',
  })

  expect(failure.category).toBe('quota_exhausted')
  expect(failure.retryable).toBe(false)
  expect(failure.hint).toContain('quota or usage allotment')
})

test('classifies 429 with credit messages as quota_exhausted', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 429,
    body: 'You exceeded your current quota, please check your plan and billing details.',
  })

  expect(failure.category).toBe('quota_exhausted')
  expect(failure.retryable).toBe(false)
})

test('classifies 403 with allotment messages as quota_exhausted', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 403,
    body: 'OpenCode Go usage allotment has run out.',
  })

  expect(failure.category).toBe('quota_exhausted')
  expect(failure.retryable).toBe(false)
})

test('does not classify generic billing 400 errors as quota_exhausted', () => {
  const failure = classifyOpenAIHttpFailure({
    status: 400,
    body: 'Invalid billing header: x-anthropic-billing-header is malformed',
  })

  expect(failure.category).toBe('malformed_provider_response')
  expect(failure.retryable).toBe(false)
})
