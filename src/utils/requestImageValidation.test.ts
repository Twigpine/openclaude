import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { BetaImageBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import * as logModule from './log.js'
import * as resizer from './imageResizer.js'
import {
  prepareImagesForAnthropicRequest,
  RequestImageDimensionsError,
  usesAnthropicImageLimits,
} from './requestImageValidation.js'

const originalExports = { ...resizer }
const originalLogExports = { ...logModule }
afterEach(() => {
  mock.module('./imageResizer.js', () => originalExports)
  mock.module('./log.js', () => originalLogExports)
  mock.restore()
})

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  buffer.write('89504e470d0a1a0a', 'hex')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}
function image(width = 3840, height = 2160): BetaImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(width, height).toString('base64') } }
}
function messages(count: number): BetaMessageParam[] {
  return [{ role: 'user', content: Array.from({ length: count }, () => image()) }]
}
function mockResize(implementation: typeof resizer.maybeResizeAndDownsampleImageBuffer) {
  const resize = mock(implementation)
  mock.module('./imageResizer.js', () => ({ ...originalExports, maybeResizeAndDownsampleImageBuffer: resize }))
  return resize
}

const document = {
  type: 'document' as const,
  source: { type: 'text' as const, media_type: 'text/plain' as const, data: 'Reference document' },
}

describe('final Anthropic request image limits', () => {
  test.each([false, true])('mixed-media threshold uses countDocuments=%s', async countDocuments => {
    const resize = mockResize(async () => ({ buffer: png(1568, 882), mediaType: 'png' }))
    const input = messages(20)
    input.push({ role: 'user', content: [document] })
    const result = await prepareImagesForAnthropicRequest(input, { countDocuments })
    expect(resize).toHaveBeenCalledTimes(countDocuments ? 20 : 0)
    expect(result[1]).toEqual(input[1])
    if (!countDocuments) expect(result).toBe(input)
  })

  test('19 images and one document preserve the partner 20-block fast path', async () => {
    const resize = mockResize(async () => { throw new Error('unavailable') })
    const input = messages(19)
    input.push({ role: 'user', content: [document] })
    expect(await prepareImagesForAnthropicRequest(input, { countDocuments: true })).toBe(input)
    expect(resize).not.toHaveBeenCalled()
  })

  test('counts restored nested documents without transforming them or mutating history', async () => {
    const resize = mockResize(async () => ({ buffer: png(1568, 882), mediaType: 'png' }))
    const input = structuredClone(messages(20))
    input.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'document-reader', content: [document] }] })
    const before = structuredClone(input)
    const result = await prepareImagesForAnthropicRequest(input, { countDocuments: true })
    expect(resize).toHaveBeenCalledTimes(20)
    expect(input).toEqual(before)
    expect(result[1]).toEqual(before[1])
    expect(result[0]!.content).toHaveLength(20)
    expect(JSON.stringify(result[0])).toContain(png(1568, 882).toString('base64'))
  })

  test.each(['throw', 'passthrough'] as const)('mixed-media %s failure explains the combined threshold', async mode => {
    mockResize(async buffer => {
      if (mode === 'throw') throw new Error('unavailable')
      return { buffer, mediaType: 'png' }
    })
    const input = messages(20)
    input.push({ role: 'user', content: [document] })
    const before = structuredClone(input)
    await expect(prepareImagesForAnthropicRequest(input, { countDocuments: true })).rejects.toThrow('20 images and documents combined')
    expect(input).toEqual(before)
  })

  test('documents alone are counted but are never image processing targets', async () => {
    const resize = mockResize(async () => { throw new Error('must not resize documents') })
    const input: BetaMessageParam[] = [{ role: 'user', content: Array.from({ length: 21 }, () => document) }]
    expect(await prepareImagesForAnthropicRequest(input, { countDocuments: true })).toEqual(input)
    expect(resize).not.toHaveBeenCalled()
  })

  test('20 compact 4K PNGs remain unchanged without processing', async () => {
    const resize = mockResize(async () => { throw new Error('unavailable') })
    const input = messages(20)
    expect(await prepareImagesForAnthropicRequest(input)).toBe(input)
    expect(resize).not.toHaveBeenCalled()
  })

  test('21 images are resized without mutating retained history', async () => {
    const resize = mockResize(async () => ({ buffer: png(1568, 882), mediaType: 'png' }))
    // JSON roundtrip models persisted/restored history: no dimensions annotations.
    const input = JSON.parse(JSON.stringify(messages(21))) as BetaMessageParam[]
    const before = JSON.stringify(input)
    const result = await prepareImagesForAnthropicRequest(input)
    expect(resize).toHaveBeenCalledTimes(21)
    expect(result[0]!.content).toHaveLength(21)
    expect(JSON.stringify(input)).toBe(before)
    expect(JSON.stringify(result)).toContain(png(1568, 882).toString('base64'))
  })

  test('counts nested tool-result images together with top-level history', async () => {
    const resize = mockResize(async () => ({ buffer: png(2000, 1125), mediaType: 'png' }))
    const input = messages(20)
    input.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'restored', content: [image()] }] })
    const result = await prepareImagesForAnthropicRequest(input)
    expect(resize).toHaveBeenCalledTimes(21)
    expect(JSON.stringify(result[1])).toContain(png(2000, 1125).toString('base64'))
  })

  test('allows 2000px edges but processes a 2001px edge', async () => {
    const resize = mockResize(async () => ({ buffer: png(2000, 2000), mediaType: 'png' }))
    const input: BetaMessageParam[] = [{ role: 'user', content: [...Array.from({ length: 20 }, () => image(2000, 2000)), image(1, 2001)] }]
    await prepareImagesForAnthropicRequest(input)
    expect(resize).toHaveBeenCalledTimes(1)
  })

  test.each(['throw', 'passthrough'] as const)('rejects %s fallback with actionable awaited error', async mode => {
    mockResize(async buffer => {
      if (mode === 'throw') throw new Error('processor unavailable')
      return { buffer, mediaType: 'png', dimensions: { displayWidth: 1568, displayHeight: 882 } }
    })
    await expect(prepareImagesForAnthropicRequest(messages(21))).rejects.toThrow('Resize the image before sending')
  })

  test('logs the processing failure and attaches it as the wrapper cause', async () => {
    const logError = mock(() => {})
    mock.module('./log.js', () => ({ ...originalLogExports, logError }))
    const resizeFailure = new resizer.ImageResizeError(
      'Unable to resize image — dimensions exceed the many-image limit and image processing failed.',
    )
    mockResize(async () => {
      throw resizeFailure
    })
    const thrown: unknown = await prepareImagesForAnthropicRequest(messages(21)).catch(error => error)
    expect(thrown).toBeInstanceOf(RequestImageDimensionsError)
    const wrapper = thrown as RequestImageDimensionsError
    expect(wrapper.cause).toBe(resizeFailure)
    expect(wrapper.message).toContain('Resize the image before sending')
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(resizeFailure)
  })

  test('rethrows its own validation error unchanged without logging', async () => {
    const logError = mock(() => {})
    mock.module('./log.js', () => ({ ...originalLogExports, logError }))
    // Processing succeeds, but the output still violates the dimension limit.
    mockResize(async () => ({ buffer: png(3840, 2160), mediaType: 'png' }))
    const thrown: unknown = await prepareImagesForAnthropicRequest(messages(21)).catch(error => error)
    expect(thrown).toBeInstanceOf(RequestImageDimensionsError)
    expect((thrown as RequestImageDimensionsError).cause).toBeUndefined()
    expect(logError).not.toHaveBeenCalled()
  })

  test.each([
    ['firstParty', true],
    ['bedrock', true],
    ['bedrock', false],
    ['vertex', true],
    ['vertex', false],
    ['foundry', true],
    ['foundry', false],
  ] as const)('applies to %s Anthropic transport (first-party endpoint: %s)', (apiProvider, isFirstPartyBaseUrl) => {
    expect(usesAnthropicImageLimits({ apiProvider, isFirstPartyBaseUrl, isGithubNativeAnthropic: false, hasProviderOverride: false })).toBe(true)
  })
  test('excludes shims, custom endpoints, and agent overrides', () => {
    const route = { apiProvider: 'openai', isFirstPartyBaseUrl: false, isGithubNativeAnthropic: false, hasProviderOverride: false }
    expect(usesAnthropicImageLimits(route)).toBe(false)
    expect(usesAnthropicImageLimits({ ...route, apiProvider: 'firstParty' })).toBe(false)
    expect(usesAnthropicImageLimits({ ...route, isGithubNativeAnthropic: true })).toBe(true)
    expect(usesAnthropicImageLimits({ ...route, isGithubNativeAnthropic: true, hasProviderOverride: true })).toBe(false)
  })
})
