import type {
  Base64ImageSource,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_API_MAX_EDGE,
  IMAGE_MANY_IMAGE_MAX_HEIGHT,
  IMAGE_MANY_IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { logEvent } from '../services/analytics/index.js'
import {
  getImageProcessor,
  type SharpFunction,
  type SharpInstance,
} from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// Error type constants for analytics (numeric to comply with logEvent restrictions)
const ERROR_TYPE_MODULE_LOAD = 1
const ERROR_TYPE_PROCESSING = 2
const ERROR_TYPE_UNKNOWN = 3
const ERROR_TYPE_PIXEL_LIMIT = 4
const ERROR_TYPE_MEMORY = 5
const ERROR_TYPE_TIMEOUT = 6
const ERROR_TYPE_VIPS = 7
const ERROR_TYPE_PERMISSION = 8

/**
 * Error thrown when image resizing fails and the image exceeds the API limit.
 */
export class ImageResizeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageResizeError'
  }
}

/**
 * Classifies image processing errors for analytics.
 *
 * Uses error codes when available (Node.js module errors), falls back to
 * message matching for libraries like sharp that don't expose error codes.
 */
function classifyImageError(error: unknown): number {
  // Check for Node.js error codes first (more reliable than string matching)
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: string }
    if (
      errorWithCode.code === 'MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_DLOPEN_FAILED'
    ) {
      return ERROR_TYPE_MODULE_LOAD
    }
    if (errorWithCode.code === 'EACCES' || errorWithCode.code === 'EPERM') {
      return ERROR_TYPE_PERMISSION
    }
    if (errorWithCode.code === 'ENOMEM') {
      return ERROR_TYPE_MEMORY
    }
  }

  // Fall back to message matching for errors without codes
  // Note: sharp doesn't expose error codes, so we must match on messages
  const message = errorMessage(error)

  // Module loading errors from our native wrapper
  if (message.includes('Native image processor module not available')) {
    return ERROR_TYPE_MODULE_LOAD
  }

  // Sharp/vips processing errors (format detection, corrupt data, etc.)
  if (
    message.includes('unsupported image format') ||
    message.includes('Input buffer') ||
    message.includes('Input file is missing') ||
    message.includes('Input file has corrupt header') ||
    message.includes('corrupt header') ||
    message.includes('corrupt image') ||
    message.includes('premature end') ||
    message.includes('zlib: data error') ||
    message.includes('zero width') ||
    message.includes('zero height')
  ) {
    return ERROR_TYPE_PROCESSING
  }

  // Pixel/dimension limit errors from sharp/vips
  if (
    message.includes('pixel limit') ||
    message.includes('too many pixels') ||
    message.includes('exceeds pixel') ||
    message.includes('image dimensions')
  ) {
    return ERROR_TYPE_PIXEL_LIMIT
  }

  // Memory allocation failures
  if (
    message.includes('out of memory') ||
    message.includes('Cannot allocate') ||
    message.includes('memory allocation')
  ) {
    return ERROR_TYPE_MEMORY
  }

  // Timeout errors
  if (message.includes('timeout') || message.includes('timed out')) {
    return ERROR_TYPE_TIMEOUT
  }

  // Vips-specific errors (VipsJpeg, VipsPng, VipsWebp, etc.)
  if (message.includes('Vips')) {
    return ERROR_TYPE_VIPS
  }

  return ERROR_TYPE_UNKNOWN
}

/**
 * Computes a simple numeric hash of a string for analytics grouping.
 * Uses djb2 algorithm, returning a 32-bit unsigned integer.
 */
function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

export interface ResizeResult {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}

interface ImageCompressionContext {
  imageBuffer: Buffer
  metadata: { width?: number; height?: number; format?: string }
  format: string
  maxBytes: number
  originalSize: number
}

interface CompressedImageResult {
  base64: string
  mediaType: Base64ImageSource['media_type']
  originalSize: number
}

/**
 * Extracted from FileReadTool's readImage function
 * Resizes image buffer to meet size and dimension constraints
 */
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    // Empty buffer would fall through the catch block below (sharp throws
    // "Unable to determine image format"), and the fallback's size check
    // `0 ≤ 5MB` would pass it through, yielding an empty base64 string
    // that the API rejects with `image cannot be empty`.
    throw new ImageResizeError('Image file is empty (0 bytes)')
  }
  try {
    const sharp = await getImageProcessor()
    const image = sharp(imageBuffer)
    const metadata = await image.metadata()

    // Dimensions may be unavailable when the native image connector fails or
    // returns an undefined metadata object (e.g. image_processor_napi crashes
    // on Windows). Guard against undefined and skip the dimension logic — the
    // API resizes large images server-side, so the raw buffer can still be
    // passed through to keep paste working.
    if (!metadata?.width || !metadata.height) {
      // The native processor gave us no dimensions to check. If Canvas is
      // available, downsample images over the many-image 2000px bound so a
      // later multi-image request is less likely to 400. If Canvas is not
      // available (Windows Bun CLI), keep the in-budget buffer — a single
      // image is resized server-side, and rejecting it recreates #1964.
      // Detect format from magic bytes (not `ext`) since that's also what
      // the raw-return path below needs.
      const detected = detectImageFormatFromBuffer(imageBuffer)
      const limitResult = await enforceManyImageDimensionLimit(
        imageBuffer,
        detected,
        originalSize,
      )
      if (limitResult) {
        return limitResult
      }

      if (originalSize > IMAGE_TARGET_RAW_SIZE) {
        // No dimensions to drive a resize, so rely on compression alone. Use
        // progressively lower JPEG quality (matching the "dimensions OK but
        // too large" path below) and only return once the result fits the raw
        // target budget. Without this check a noisy image could still exceed
        // the 5MB base64 limit and be rejected by validateImagesForAPI,
        // reintroducing the upload failure this PR recovers from.
        for (const quality of [80, 60, 40, 20]) {
          const compressedBuffer = await sharp(imageBuffer)
            .jpeg({ quality })
            .toBuffer()
          if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
            return { buffer: compressedBuffer, mediaType: 'jpeg' }
          }
        }
        // Still too large after maximum compression and we have no dimensions
        // to fall back to a dimension resize, so fail via the user-facing
        // limit path instead of returning an oversized buffer that would be
        // rejected downstream.
        throw new ImageResizeError(
          `Unable to resize image — the image exceeds the size limit even after compression and image processing failed to read its dimensions. ` +
            `Please use a smaller or lower-resolution image.`,
        )
      }
      // No metadata: return the buffer without dimensions, using the format
      // already detected above from magic bytes instead of trusting `ext`.
      const detectedExt = detected.slice(6)
      const normalizedExt = detectedExt === 'jpg' ? 'jpeg' : detectedExt
      return { buffer: imageBuffer, mediaType: normalizedExt }
    }

    const mediaType = metadata.format ?? ext
    // Normalize "jpg" to "jpeg" for media type compatibility
    const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType

    // Store original dimensions (guaranteed to be defined here)
    const originalWidth = metadata.width
    const originalHeight = metadata.height

    // Calculate dimensions while maintaining aspect ratio
    let width = originalWidth
    let height = originalHeight

    // Check if the original file just works
    if (
      originalSize <= IMAGE_TARGET_RAW_SIZE &&
      width <= IMAGE_MAX_WIDTH &&
      height <= IMAGE_MAX_HEIGHT
    ) {
      return {
        buffer: imageBuffer,
        mediaType: normalizedMediaType,
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: width,
          displayHeight: height,
        },
      }
    }

    const needsDimensionResize =
      width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT
    const isPng = normalizedMediaType === 'png'

    // If dimensions are within limits but file is too large, try compression first
    // This preserves full resolution when possible
    if (!needsDimensionResize && originalSize > IMAGE_TARGET_RAW_SIZE) {
      // For PNGs, try PNG compression first to preserve transparency
      if (isPng) {
        // Create fresh sharp instance for each compression attempt
        const pngCompressed = await sharp(imageBuffer)
          .png({ compressionLevel: 9, palette: true })
          .toBuffer()
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // Try JPEG compression (lossy but much smaller)
      for (const quality of [80, 60, 40, 20]) {
        // Create fresh sharp instance for each attempt
        const compressedBuffer = await sharp(imageBuffer)
          .jpeg({ quality })
          .toBuffer()
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // Quality reduction alone wasn't enough, fall through to resize
    }

    // Constrain dimensions if needed
    if (width > IMAGE_MAX_WIDTH) {
      height = Math.round((height * IMAGE_MAX_WIDTH) / width)
      width = IMAGE_MAX_WIDTH
    }

    if (height > IMAGE_MAX_HEIGHT) {
      width = Math.round((width * IMAGE_MAX_HEIGHT) / height)
      height = IMAGE_MAX_HEIGHT
    }

    // IMPORTANT: Always create fresh sharp(imageBuffer) instances for each operation.
    // The native image-processor-napi module doesn't properly apply format conversions
    // when reusing a sharp instance after calling toBuffer(). This caused a bug where
    // all compression attempts (PNG, JPEG at various qualities) returned identical sizes.
    logForDebugging(`Resizing to ${width}x${height}`)
    const resizedImageBuffer = await sharp(imageBuffer)
      .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer()

    // If still too large after resize, try compression
    if (resizedImageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
      // For PNGs, try PNG compression first to preserve transparency
      if (isPng) {
        const pngCompressed = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png({ compressionLevel: 9, palette: true })
          .toBuffer()
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }

      // Try JPEG with progressively lower quality
      for (const quality of [80, 60, 40, 20]) {
        const compressedBuffer = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality })
          .toBuffer()
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // If still too large, resize smaller and compress aggressively
      const smallerWidth = Math.min(width, 1000)
      const smallerHeight = Math.round(
        (height * smallerWidth) / Math.max(width, 1),
      )
      logForDebugging('Still too large, compressing with JPEG')
      const compressedBuffer = await sharp(imageBuffer)
        .resize(smallerWidth, smallerHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 20 })
        .toBuffer()
      logForDebugging(`JPEG compressed buffer size: ${compressedBuffer.length}`)
      return {
        buffer: compressedBuffer,
        mediaType: 'jpeg',
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: smallerWidth,
          displayHeight: smallerHeight,
        },
      }
    }

    return {
      buffer: resizedImageBuffer,
      mediaType: normalizedMediaType,
      dimensions: {
        originalWidth,
        originalHeight,
        displayWidth: width,
        displayHeight: height,
      },
    }
  } catch (error) {
    // Intentional limit failures (empty file, over-budget compression, API
    // hard 8000px edge) must not be treated as a processor crash. The catch
    // path would otherwise log them as resize-failed and may passthrough.
    if (error instanceof ImageResizeError) {
      throw error
    }

    // Log the error and emit analytics event
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('tengu_image_resize_failed', {
      original_size_bytes: originalSize,
      error_type: errorType,
      error_message_hash: hashString(errorMsg),
    })

    // Detect actual format from magic bytes instead of trusting extension
    const detected = detectImageFormatFromBuffer(imageBuffer)
    const normalizedExt = detected.slice(6) // Remove 'image/' prefix

    // Calculate the base64 size (API limit is on base64-encoded length)
    const base64Size = Math.ceil((originalSize * 4) / 3)

    // The API only rejects images on the base64 byte-size limit; it resizes
    // oversized dimensions (> 1568px) server-side. So a dimensionally-large
    // but base64-small image is allowed through here rather than throwing.
    // Try Canvas before rejecting either the payload or the 8000px hard edge:
    // a large source can still produce an admissible replacement. The shared
    // helper validates the replacement payload, and if recovery is unavailable
    // it enforces the original hard edge before this route chooses a size error.
    const limitResult = await enforceManyImageDimensionLimit(
      imageBuffer,
      detected,
      originalSize,
      errorType,
    )
    if (limitResult) {
      return limitResult
    }

    // If original image's base64 encoding is within API limit, allow it through uncompressed
    if (base64Size <= API_IMAGE_MAX_BASE64_SIZE) {
      logEvent('tengu_image_resize_fallback', {
        original_size_bytes: originalSize,
        base64_size_bytes: base64Size,
        error_type: errorType,
      })
      return { buffer: imageBuffer, mediaType: normalizedExt }
    }

    // Image is too large and we failed to compress it - fail with user-friendly error
    throw new ImageResizeError(
      `Unable to resize image (${formatFileSize(originalSize)} raw, ${formatFileSize(base64Size)} base64). ` +
        `The image exceeds the 5MB API limit and compression failed. ` +
        `Please resize the image manually or use a smaller image.`,
    )
  }
}

export interface ImageBlockWithDimensions {
  block: ImageBlockParam
  dimensions?: ImageDimensions
}

/**
 * Resizes an image content block if needed
 * Takes an image ImageBlockParam and returns a resized version if necessary
 * Also returns dimension information for coordinate mapping
 */
export async function maybeResizeAndDownsampleImageBlock(
  imageBlock: ImageBlockParam,
): Promise<ImageBlockWithDimensions> {
  // Only process base64 images
  if (imageBlock.source.type !== 'base64') {
    return { block: imageBlock }
  }

  // Decode base64 to buffer
  const imageBuffer = Buffer.from(imageBlock.source.data, 'base64')
  const originalSize = imageBuffer.length

  // Extract extension from media type
  const mediaType = imageBlock.source.media_type
  const ext = mediaType?.split('/')[1] || 'png'

  // Resize if needed
  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    originalSize,
    ext,
  )

  // Return resized image block with dimension info
  return {
    block: {
      type: 'image',
      source: {
        type: 'base64',
        media_type:
          `image/${resized.mediaType}` as Base64ImageSource['media_type'],
        data: resized.buffer.toString('base64'),
      },
    },
    dimensions: resized.dimensions,
  }
}

/**
 * Compresses an image buffer to fit within a maximum byte size.
 *
 * Uses a multi-strategy fallback approach because simple compression often fails for
 * large screenshots, high-resolution photos, or images with complex gradients. Each
 * strategy is progressively more aggressive to handle edge cases where earlier
 * strategies produce files still exceeding the size limit.
 *
 * Strategy (from FileReadTool):
 * 1. Try to preserve original format (PNG, JPEG, WebP) with progressive resizing
 * 2. For PNG: Use palette optimization and color reduction if needed
 * 3. Last resort: Convert to JPEG with aggressive compression
 *
 * This ensures images fit within context windows while maintaining format when possible.
 */
export async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Extract format from originalMediaType if provided (e.g., "image/png" -> "png")
  const fallbackFormat = originalMediaType?.split('/')[1] || 'jpeg'
  const normalizedFallback = fallbackFormat === 'jpg' ? 'jpeg' : fallbackFormat

  try {
    const sharp = await getImageProcessor()
    const metadata = await sharp(imageBuffer).metadata()
    const format = metadata.format || normalizedFallback
    const originalSize = imageBuffer.length

    const context: ImageCompressionContext = {
      imageBuffer,
      metadata,
      format,
      maxBytes,
      originalSize,
    }

    // If image is already within size limit, return as-is without processing
    if (originalSize <= maxBytes) {
      return createCompressedImageResult(imageBuffer, format, originalSize)
    }

    // Try progressive resizing with format preservation
    const resizedResult = await tryProgressiveResizing(context, sharp)
    if (resizedResult) {
      return resizedResult
    }

    // For PNG, try palette optimization
    if (format === 'png') {
      const palettizedResult = await tryPalettePNG(context, sharp)
      if (palettizedResult) {
        return palettizedResult
      }
    }

    // Try JPEG conversion with moderate compression
    const jpegResult = await tryJPEGConversion(context, 50, sharp)
    if (jpegResult) {
      return jpegResult
    }

    // Last resort: ultra-compressed JPEG
    return await createUltraCompressedJPEG(context, sharp)
  } catch (error) {
    // Log the error and emit analytics event
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('tengu_image_compress_failed', {
      original_size_bytes: imageBuffer.length,
      max_bytes: maxBytes,
      error_type: errorType,
      error_message_hash: hashString(errorMsg),
    })

    // If original image is within the requested limit, allow it through
    if (imageBuffer.length <= maxBytes) {
      // Detect actual format from magic bytes instead of trusting the provided media type
      const detected = detectImageFormatFromBuffer(imageBuffer)
      return {
        base64: imageBuffer.toString('base64'),
        mediaType: detected,
        originalSize: imageBuffer.length,
      }
    }

    // Image is too large and compression failed - throw error
    throw new ImageResizeError(
      `Unable to compress image (${formatFileSize(imageBuffer.length)}) to fit within ${formatFileSize(maxBytes)}. ` +
        `Please use a smaller image.`,
    )
  }
}

/**
 * Compresses an image buffer to fit within a token limit.
 * Converts tokens to bytes using the formula: maxBytes = (maxTokens / 0.125) * 0.75
 */
export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Convert token limit to byte limit
  // base64 uses about 4/3 the original size, so we reverse this
  const maxBase64Chars = Math.floor(maxTokens / 0.125)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)

  return compressImageBuffer(imageBuffer, maxBytes, originalMediaType)
}

/**
 * Compresses an image block to fit within a maximum byte size.
 * Wrapper around compressImageBuffer for ImageBlockParam.
 */
export async function compressImageBlock(
  imageBlock: ImageBlockParam,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
): Promise<ImageBlockParam> {
  // Only process base64 images
  if (imageBlock.source.type !== 'base64') {
    return imageBlock
  }

  // Decode base64 to buffer
  const imageBuffer = Buffer.from(imageBlock.source.data, 'base64')

  // Check if already within size limit
  if (imageBuffer.length <= maxBytes) {
    return imageBlock
  }

  // Compress the image
  const compressed = await compressImageBuffer(imageBuffer, maxBytes)

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: compressed.mediaType,
      data: compressed.base64,
    },
  }
}

// Helper functions for compression pipeline

function createCompressedImageResult(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
): CompressedImageResult {
  const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType
  return {
    base64: buffer.toString('base64'),
    mediaType:
      `image/${normalizedMediaType}` as Base64ImageSource['media_type'],
    originalSize,
  }
}

async function tryProgressiveResizing(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const scalingFactors = [1.0, 0.75, 0.5, 0.25]

  for (const scalingFactor of scalingFactors) {
    const newWidth = Math.round(
      (context.metadata.width || 2000) * scalingFactor,
    )
    const newHeight = Math.round(
      (context.metadata.height || 2000) * scalingFactor,
    )

    let resizedImage = sharp(context.imageBuffer).resize(newWidth, newHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })

    // Apply format-specific optimizations
    resizedImage = applyFormatOptimizations(resizedImage, context.format)

    const resizedBuffer = await resizedImage.toBuffer()

    if (resizedBuffer.length <= context.maxBytes) {
      return createCompressedImageResult(
        resizedBuffer,
        context.format,
        context.originalSize,
      )
    }
  }

  return null
}

function applyFormatOptimizations(
  image: SharpInstance,
  format: string,
): SharpInstance {
  switch (format) {
    case 'png':
      return image.png({
        compressionLevel: 9,
        palette: true,
      })
    case 'jpeg':
    case 'jpg':
      return image.jpeg({ quality: 80 })
    case 'webp':
      return image.webp({ quality: 80 })
    default:
      return image
  }
}

async function tryPalettePNG(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const palettePng = await sharp(context.imageBuffer)
    .resize(800, 800, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({
      compressionLevel: 9,
      palette: true,
      colors: 64, // Reduce colors to 64 for better compression
    })
    .toBuffer()

  if (palettePng.length <= context.maxBytes) {
    return createCompressedImageResult(palettePng, 'png', context.originalSize)
  }

  return null
}

async function tryJPEGConversion(
  context: ImageCompressionContext,
  quality: number,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const jpegBuffer = await sharp(context.imageBuffer)
    .resize(600, 600, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer()

  if (jpegBuffer.length <= context.maxBytes) {
    return createCompressedImageResult(jpegBuffer, 'jpeg', context.originalSize)
  }

  return null
}

async function createUltraCompressedJPEG(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult> {
  const ultraCompressedBuffer = await sharp(context.imageBuffer)
    .resize(400, 400, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 20 })
    .toBuffer()

  return createCompressedImageResult(
    ultraCompressedBuffer,
    'jpeg',
    context.originalSize,
  )
}

/**
 * Detect image format from a buffer using magic bytes
 * @param buffer Buffer containing image data
 * @returns Media type string (e.g., 'image/png', 'image/jpeg') or 'image/png' as default
 */
export function detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType {
  if (buffer.length < 4) return 'image/png' // default

  // Check PNG signature
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }

  // Check JPEG signature (FFD8FF)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  // Check GIF signature (GIF87a or GIF89a)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif'
  }

  // Check WebP signature (RIFF....WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  ) {
    if (
      buffer.length >= 12 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp'
    }
  }

  // Default to PNG if unknown
  return 'image/png'
}

/**
 * Reads width/height from an encoded image buffer using magic-byte parsing,
 * without the native image processor. Used in the resize-failure fallback
 * where `image.metadata()` is unavailable.
 *
 * - PNG: IHDR width/height at bytes 16-23.
 * - JPEG: scans SOF0/SOF2/SOF3 markers for the frame height/width.
 * - WebP: VP8 (lossy) keyframe header / VP8L (lossless) transform header.
 * - GIF: logical screen descriptor at bytes 6-9.
 *
 * Returns null when the dimensions cannot be determined. Callers must fail
 * safe (assume "exceeds limit") on null rather than treating it as 0×0.
 */
export function readImageDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  if (buffer.length >= 24) {
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      }
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      // GIF logical screen descriptor: width at 6-7, height at 8-9.
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
      }
    }
  }
  const webp = readEncodedWebPDimensions(buffer)
  if (webp) return webp
  const jpeg = readJpegDimensions(buffer)
  if (jpeg) return jpeg
  return null
}

/**
 * Minimal parser for encoded (lossy/lossless) WebP dimension metadata.
 *
 * Lossless WebP stores width/height in the VP8L transform header. Lossy WebP
 * stores them in the VP8 keyframe header. Extended WebP (VP8X, used for
 * alpha/animation/metadata) stores canvas dimensions in the VP8X chunk
 * itself. The native image processor is unavailable in the fallback path, so
 * we read these directly rather than depending on `sharp`/`image-processor-napi`.
 *
 * Returns null when the format is unrecognized or the buffer is too small.
 */
function readEncodedWebPDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  try {
    if (buffer.length < 16) return null
    // RIFF....WEBP
    if (
      buffer[0] !== 0x52 ||
      buffer[1] !== 0x49 ||
      buffer[2] !== 0x46 ||
      buffer[3] !== 0x46 ||
      buffer[8] !== 0x57 ||
      buffer[9] !== 0x45 ||
      buffer[10] !== 0x42 ||
      buffer[11] !== 0x50
    ) {
      return null
    }
    const chunkFourCC = buffer.toString('ascii', 12, 16)
    if (chunkFourCC === 'VP8L') {
      // Lossless transform header starts at byte 20 (after 'VP8L' + 4-byte
      // size + 1-byte 0x2F signature). As a little-endian 32-bit word read
      // from byte 21, bits [0..13] = width-1 and bits [14..27] = height-1.
      // Verified against real sharp-encoded VP8L frames.
      if (buffer.length < 25 || buffer[20] !== 0x2f) return null
      const bits = buffer.readUInt32LE(21)
      const width = ((bits & 0x3fff) + 1) >>> 0
      const height = (((bits >>> 14) & 0x3fff) + 1) >>> 0
      return { width, height }
    }
    if (chunkFourCC === 'VP8 ') {
      // Lossy keyframe: 3-byte start code (0x9D 0x01 0x2A) is at bytes
      // 23-25; the 14-bit width spans bytes 26-27 and the 14-bit height
      // spans bytes 28-29, stored directly (no -1 bias; bits 14-15 are a
      // scale factor, masked off). Verified against real sharp-encoded VP8
      // frames.
      if (buffer.length < 30) return null
      if (
        buffer[23] !== 0x9d ||
        buffer[24] !== 0x01 ||
        buffer[25] !== 0x2a
      ) {
        return null
      }
      const width = buffer.readUInt16LE(26) & 0x3fff
      const height = buffer.readUInt16LE(28) & 0x3fff
      return { width, height }
    }
    if (chunkFourCC === 'VP8X') {
      // Extended WebP: chunk header at 12-19, flags byte at 20, 3 reserved
      // bytes at 21-23, then 24-bit LE canvas width-1 at 24 and height-1 at
      // 27 (unlike VP8/VP8L, VP8X canvas dimensions ARE stored minus one).
      if (buffer.length < 30) return null
      return {
        width: buffer.readUIntLE(24, 3) + 1,
        height: buffer.readUIntLE(27, 3) + 1,
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Scans JPEG SOF (Start-Of-Frame) markers for frame height/width without the
 * native image processor. Recognizes baseline (SOF0), progressive (SOF2), and
 * lossless (SOF3) — the common cases. Returns null if not found.
 */
function readJpegDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  try {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return null
    }
    let i = 2
    while (i + 1 < buffer.length) {
      if (buffer[i] !== 0xff) {
        i++
        continue
      }
      // Repeated 0xFF bytes are legal marker-fill padding, not a marker
      // whose next byte is a segment length.
      while (i + 1 < buffer.length && buffer[i + 1] === 0xff) {
        i++
      }
      if (i + 1 >= buffer.length) return null
      const marker = buffer[i + 1]
      // SOF markers: 0xC0-0xC3, 0xC5-0xC7, 0xC9-0xCB, 0xCD-0xCF (exclude
      // 0xC4/0xC8/0xCC which are DHT/DAC tables, not SOF).
      const isSof =
        (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 &&
          marker !== 0xc8 && marker !== 0xcc)
      if (isSof) {
        if (i + 9 >= buffer.length) return null
        const height = buffer.readUInt16BE(i + 5)
        const width = buffer.readUInt16BE(i + 7)
        if (width > 0 && height > 0) return { width, height }
        return null
      }
      // Standalone markers have no length field: TEM (0x01), RST0-RST7
      // (0xD0-0xD7), SOI (0xD8), EOI (0xD9).
      if (
        marker === 0x01 ||
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        i += 2
        continue
      }
      if (i + 3 >= buffer.length) return null
      const segLen = buffer.readUInt16BE(i + 2)
      if (segLen < 2) return null
      i += 2 + segLen
    }
  } catch {
    return null
  }
  return null
}

/**
 * Determines whether an image exceeds the API's stricter many-image dimension
 * limit (2000px per side). Used in the resize-failure fallback, where the
 * native processor is unavailable and we must avoid returning an oversized
 * image that would later break many-image requests.
 *
 * When dimensions cannot be read from the buffer (processor failed and the
 * bytes are unparseable for this format), we fail safe and report that the
 * limit is exceeded — an unknown image must not be allowed to pass through
 * unchanged.
 */
async function imageExceedsManyImageLimit(args: {
  buffer: Buffer
  detectedFormat: ImageMediaType
  rawWidth: number
  rawHeight: number
}): Promise<boolean> {
  const { buffer, rawWidth, rawHeight } = args
  // Prefer magic-byte dimensions (PNG IHDR / WebP / JPEG / GIF headers); fall
  // back to the caller-supplied raw dimensions when the buffer is unparseable.
  const dims = readImageDimensions(buffer)
  const width = dims?.width ?? (rawWidth || Infinity)
  const height = dims?.height ?? (rawHeight || Infinity)
  return (
    width > IMAGE_MANY_IMAGE_MAX_WIDTH ||
    height > IMAGE_MANY_IMAGE_MAX_HEIGHT
  )
}

/**
 * Best-effort downsample to bring an image under the many-image dimension
 * limit using platform Canvas APIs, when available (browser / Electron /
 * Node canvas global). Used only in the resize-failure fallback so we never
 * return an oversized image that would break many-image requests.
 *
 * Returns null when Canvas is unavailable or decoding/downsampling fails.
 */
async function tryDownsampleToManyImageLimit(
  buffer: Buffer,
  mediaType: string,
  rawWidth: number,
  rawHeight: number,
): Promise<Buffer | null> {
  const g = globalThis as Record<string, unknown>
  // In browsers/Electron the Canvas APIs live on `document`, not globalThis;
  // in some Node-canvas setups they are global. Resolve from either. Native
  // DOM methods are brand-checked: they must be invoked with their owners,
  // not extracted into unbound functions.
  type CanvasLike = {
    width: number
    height: number
    getContext: (type: string) => { drawImage: (...args: unknown[]) => void } | null
    toDataURL: (type?: string) => string
  }
  const doc = g.document as { createElement?: (tag: string) => CanvasLike } | undefined
  const documentCreateElement =
    doc && typeof doc.createElement === 'function' ? doc.createElement.bind(doc) : null
  const globalCreateElement =
    typeof g.createElement === 'function'
      ? (g.createElement as (tag: string, w?: number, h?: number) => CanvasLike)
      : null
  const ImageCtor =
    typeof g.Image === 'function'
      ? g.Image
      : (doc as Record<string, unknown> | undefined)?.Image
  const createImageBitmap = g.createImageBitmap
  // createImageBitmap needs a Blob from fetch(dataUrl). Require both APIs
  // before selecting that path; otherwise a missing fetch throws, the outer
  // catch returns null, and a working Image decoder never runs.
  const canUseBitmap =
    typeof createImageBitmap === 'function' && typeof g.fetch === 'function'
  if (
    (!documentCreateElement && !globalCreateElement) ||
    (!canUseBitmap && typeof ImageCtor !== 'function')
  ) {
    return null
  }

  try {
    const sourceWidth = Math.max(rawWidth, 1)
    const sourceHeight = Math.max(rawHeight, 1)
    const scale = Math.min(
      IMAGE_MANY_IMAGE_MAX_WIDTH / sourceWidth,
      IMAGE_MANY_IMAGE_MAX_HEIGHT / sourceHeight,
      1,
    )
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale))
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale))

    const canvas = documentCreateElement
      ? documentCreateElement('canvas')
      : globalCreateElement!('canvas', targetWidth, targetHeight)
    canvas.width = targetWidth
    canvas.height = targetHeight

    if (typeof canvas.getContext !== 'function') return null
    const ctx = canvas.getContext('2d')
    if (!ctx || typeof ctx.drawImage !== 'function') return null

    const dataUrl = `data:${mediaType};base64,${buffer.toString('base64')}`

    // Fully decode the source before drawing. A data-URL `Image` decodes
    // asynchronously, so drawing on the same tick would render a blank canvas;
    // prefer createImageBitmap (resolves already-decoded) and otherwise await
    // the Image `load` event.
    let drawable: unknown
    if (canUseBitmap) {
      try {
        const blob = await (
          g.fetch as (url: string) => Promise<{ blob(): Promise<unknown> }>
        )(dataUrl).then((r) => r.blob())
        drawable = await (
          createImageBitmap as (input: unknown) => Promise<unknown>
        )(blob)
      } catch {
        drawable = undefined
      }
    }
    if (drawable == null) {
      if (typeof ImageCtor !== 'function') return null
      drawable = await new Promise((resolve, reject) => {
        // The DOM `Image` constructor takes optional width/height, not a URL —
        // passing `dataUrl` as the first arg silently does nothing. Handlers
        // must be installed before `src` is assigned so a synchronously-cached
        // decode can't fire `onload` before we're listening.
        const img = new (ImageCtor as new () => Record<string, unknown> & {
          src: string
          onload: (() => void) | null
          onerror: ((e: unknown) => void) | null
        })()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('image decode failed'))
        img.src = dataUrl
      })
    }

    ctx.drawImage(drawable, 0, 0, targetWidth, targetHeight)

    // Canvas can only emit PNG or JPEG; never GIF/WebP. Default unknown input
    // to PNG.
    const outType = mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    if (typeof canvas.toDataURL !== 'function') return null
    const outDataUrl = canvas.toDataURL(outType)
    const commaIndex = outDataUrl.indexOf(',')
    if (commaIndex === -1) return null
    return Buffer.from(outDataUrl.slice(commaIndex + 1), 'base64')
  } catch {
    return null
  }
}

/**
 * Shared many-image dimension-limit helper for the resize-failure fallback
 * paths (native processor crashed, or returned no metadata). When Canvas is
 * available, downsample images over the 2000px many-image bound. When it is
 * not, return null so the caller can keep an in-budget single-image paste.
 */
async function enforceManyImageDimensionLimit(
  imageBuffer: Buffer,
  detectedFormat: ImageMediaType,
  originalSize: number,
  errorType?: number,
): Promise<{ buffer: Buffer; mediaType: string } | null> {
  const rawDims = readImageDimensions(imageBuffer)
  const exceedsManyImageLimit = await imageExceedsManyImageLimit({
    buffer: imageBuffer,
    detectedFormat,
    rawWidth: rawDims?.width ?? 0,
    rawHeight: rawDims?.height ?? 0,
  })
  if (!exceedsManyImageLimit) return null

  const downsampled = rawDims
    ? await tryDownsampleToManyImageLimit(
        imageBuffer,
        detectedFormat,
        rawDims.width,
        rawDims.height,
      )
    : null
  if (downsampled) {
    // The downsample may still exceed the 5MB base64 payload budget (e.g. a
    // high-entropy 2001x2001 image). Do not bypass the payload safeguard.
    const downsampledBase64Size = Math.ceil((downsampled.length * 4) / 3)
    if (downsampledBase64Size <= API_IMAGE_MAX_BASE64_SIZE) {
      logEvent('tengu_image_resize_fallback', {
        original_size_bytes: originalSize,
        base64_size_bytes: Math.ceil((originalSize * 4) / 3),
        error_type: errorType,
        canvas_downsample: true,
      })
      logForDebugging(
        '[imageResizer] image exceeded many-image limit; downsampled via canvas fallback',
        { level: 'warn' },
      )
      // Canvas can only emit PNG/JPEG; the result media type must match the
      // emitted bytes (not the original format). ResizeResult.mediaType is the
      // subtype (as everywhere else in this file), so return 'jpeg' or 'png',
      // not a full MIME type.
      const downsampledMediaType =
        detectedFormat === 'image/jpeg' ? 'jpeg' : 'png'
      return { buffer: downsampled, mediaType: downsampledMediaType }
    }
  }
  // The API hard-rejects any image whose long edge exceeds 8000px. That is
  // distinct from the 2000px many-image bound: a compact 4K screenshot
  // (3840px) must still passthrough when Canvas is unavailable (#1964).
  if (
    rawDims &&
    (rawDims.width > IMAGE_API_MAX_EDGE || rawDims.height > IMAGE_API_MAX_EDGE)
  ) {
    throw new ImageResizeError(
      `Unable to resize image — dimensions exceed the ${IMAGE_API_MAX_EDGE}x${IMAGE_API_MAX_EDGE}px API limit and image processing failed. ` +
        `Please resize the image to reduce its pixel dimensions.`,
    )
  }
  // No Canvas (or downsample still over the payload budget): do not reject
  // an in-budget single image under the API hard edge. Throwing the 2000px
  // many-image rule here is swallowed by getImageFromClipboard() as
  // "No image found".
  return null
}

/**
 * Detect image format from base64 data using magic bytes
 * @param base64Data Base64 encoded image data
 * @returns Media type string (e.g., 'image/png', 'image/jpeg') or 'image/png' as default
 */
export function detectImageFormatFromBase64(
  base64Data: string,
): ImageMediaType {
  try {
    const buffer = Buffer.from(base64Data, 'base64')
    return detectImageFormatFromBuffer(buffer)
  } catch {
    // Default to PNG on any error
    return 'image/png'
  }
}

/**
 * Creates a text description of image metadata including dimensions and source path.
 * Returns null if no useful metadata is available.
 */
export function createImageMetadataText(
  dims: ImageDimensions,
  sourcePath?: string,
): string | null {
  const { originalWidth, originalHeight, displayWidth, displayHeight } = dims
  // Skip if dimensions are not available or invalid
  // Note: checks for undefined/null and zero to prevent division by zero
  if (
    !originalWidth ||
    !originalHeight ||
    !displayWidth ||
    !displayHeight ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    // If we have a source path but no valid dimensions, still return source info
    if (sourcePath) {
      return `[Image source: ${sourcePath}]`
    }
    return null
  }
  // Check if image was resized
  const wasResized =
    originalWidth !== displayWidth || originalHeight !== displayHeight

  // Only include metadata if there's useful info (resized or has source path)
  if (!wasResized && !sourcePath) {
    return null
  }

  // Build metadata parts
  const parts: string[] = []

  if (sourcePath) {
    parts.push(`source: ${sourcePath}`)
  }

  if (wasResized) {
    const scaleFactor = originalWidth / displayWidth
    parts.push(
      `original ${originalWidth}x${originalHeight}, displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scaleFactor.toFixed(2)} to map to original image.`,
    )
  }

  return `[Image: ${parts.join(', ')}]`
}
