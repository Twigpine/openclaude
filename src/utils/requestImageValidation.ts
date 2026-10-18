import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MANY_IMAGE_MAX_HEIGHT,
  IMAGE_MANY_IMAGE_MAX_WIDTH,
} from '../constants/apiLimits.js'
import {
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
  readImageDimensions,
} from './imageResizer.js'
import { logError } from './log.js'

export class RequestImageDimensionsError extends ImageResizeError {
  constructor(options?: ErrorOptions & { countDocuments?: boolean }) {
    const countedMedia = options?.countDocuments ? 'images and documents combined' : 'images'
    const fewerMedia = options?.countDocuments ? 'images or documents' : 'images'
    super(
      `Requests with more than 20 ${countedMedia} require each image to be at most 2000×2000 pixels. ` +
      `Local image processing could not produce a compliant image. Resize the image before sending, or start a new conversation with fewer ${fewerMedia}.`,
      options,
    )
    this.name = 'RequestImageDimensionsError'
  }
}

export function usesAnthropicImageLimits(options: {
  apiProvider: string
  isFirstPartyBaseUrl: boolean
  isGithubNativeAnthropic: boolean
  hasProviderOverride: boolean
}): boolean {
  return !options.hasProviderOverride && (
    (options.apiProvider === 'firstParty' && options.isFirstPartyBaseUrl) ||
    options.apiProvider === 'bedrock' ||
    options.apiProvider === 'vertex' ||
    options.apiProvider === 'foundry' ||
    options.isGithubNativeAnthropic
  )
}

/** Validate the final, pruned request, including images restored from history. */
export async function prepareImagesForAnthropicRequest<
  T extends { content: unknown } | { message: { content: unknown } },
>(messages: T[], { countDocuments = false }: { countDocuments?: boolean } = {}): Promise<T[]> {
  let mediaCount = 0
  function countMedia(blocks: unknown): void {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block.type === 'image' || (countDocuments && block.type === 'document')) mediaCount++
      else if (block.type === 'tool_result') countMedia(block.content)
    }
  }
  for (const message of messages) {
    countMedia('message' in message ? message.message.content : message.content)
  }
  if (mediaCount <= 20) return messages

  const error = () => new RequestImageDimensionsError({ countDocuments })
  const withinLimits = (buffer: Buffer): boolean => {
    const dimensions = readImageDimensions(buffer)
    return dimensions !== null && dimensions.width > 0 && dimensions.height > 0 &&
      dimensions.width <= IMAGE_MANY_IMAGE_MAX_WIDTH &&
      dimensions.height <= IMAGE_MANY_IMAGE_MAX_HEIGHT
  }

  async function prepareBlocks<T>(blocks: T): Promise<T> {
    if (!Array.isArray(blocks)) return blocks
    const prepared: unknown[] = []
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        prepared.push({ ...block, content: await prepareBlocks(block.content) })
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        const buffer = Buffer.from(block.source.data, 'base64')
        if (withinLimits(buffer) && block.source.data.length <= API_IMAGE_MAX_BASE64_SIZE) {
          prepared.push(block)
          continue
        }
        try {
          const resized = await maybeResizeAndDownsampleImageBuffer(
            buffer, buffer.length, block.source.media_type.split('/')[1],
          )
          const data = resized.buffer.toString('base64')
          // The paste fallback intentionally permits compact 4K PNGs. Verify
          // actual output bytes here rather than trusting processor metadata.
          if (!withinLimits(resized.buffer) || data.length > API_IMAGE_MAX_BASE64_SIZE) throw error()
          prepared.push({
            ...block,
            source: { ...block.source, data, media_type: `image/${resized.mediaType}` },
          })
        } catch (cause) {
          // Keep our own validation error intact. Otherwise log the underlying
          // processing failure and attach it as the cause, so the actionable
          // wrapper message does not discard the original diagnostics.
          if (cause instanceof RequestImageDimensionsError) throw cause
          logError(cause)
          throw new RequestImageDimensionsError({ cause, countDocuments })
        }
      } else {
        prepared.push(block)
      }
    }
    return prepared as T
  }

  const prepared: T[] = []
  for (const message of messages) {
    if ('message' in message) {
      prepared.push({
        ...message,
        message: { ...message.message, content: await prepareBlocks(message.message.content) },
      })
    } else {
      prepared.push({ ...message, content: await prepareBlocks(message.content) })
    }
  }
  return prepared
}
