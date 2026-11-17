import { Buffer } from 'buffer'
import { isInBundledMode } from '../../utils/bundledMode.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (
  input: Buffer,
  options?: { raw: { width: number; height: number; channels: 3 | 4 } },
) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

/**
 * Error thrown when no image processor is available (e.g., in the open build
 * where sharp and image-processor-napi are stubbed out).
 */
export class ImageProcessorUnavailableError extends Error {
  constructor() {
    super(
      'Image support is not installed. Install `sharp` (add `-g` if you installed the CLI globally) to enable reading and processing images.',
    )
    this.name = 'ImageProcessorUnavailableError'
  }
}

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (isInBundledMode()) {
    // Try to load the native image processor first
    try {
      // Use the native image processor module
      const imageProcessor = await import('image-processor-napi')
      if ((imageProcessor as { __stub?: boolean }).__stub) {
        throw new ImageProcessorUnavailableError()
      }
      const sharp = imageProcessor.sharp || imageProcessor.default
      imageProcessorModule = { default: sharp }
      return sharp
    } catch (e) {
      if (e instanceof ImageProcessorUnavailableError) throw e
      // Fall back to sharp if native module is not available
      // biome-ignore lint/suspicious/noConsole: intentional warning
      console.warn(
        'Native image processor not available, falling back to sharp',
      )
    }
  }

  // Use sharp for non-bundled builds or as fallback.
  // Single structural cast: our SharpFunction is a subset of sharp's actual type surface.
  try {
    const imported = (await import(
      'sharp'
    )) as unknown as MaybeDefault<SharpFunction> & { __stub?: boolean }
    if (imported && (imported as { __stub?: boolean }).__stub) {
      throw new ImageProcessorUnavailableError()
    }
    const sharp = unwrapDefault(imported as MaybeDefault<SharpFunction>)
    imageProcessorModule = { default: sharp }
    return sharp
  } catch (e) {
    if (e instanceof ImageProcessorUnavailableError) throw e
    throw new ImageProcessorUnavailableError()
  }
}

/**
 * Sharp does not decode BMP. Adapt common Windows screenshot layouts to raw
 * pixels before encoding, keeping the processor an explicit opt-in dependency.
 * Validate the complete pixel range before allocating or reading any pixels.
 */
export async function convertBmpToPng(input: Buffer): Promise<Buffer> {
  const sharp = await getImageProcessor()
  if (input.length < 54 || input.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Invalid BMP image header')
  }
  const offset = input.readUInt32LE(10)
  const headerSize = input.readUInt32LE(14)
  const width = input.readInt32LE(18)
  const signedHeight = input.readInt32LE(22)
  const height = Math.abs(signedHeight)
  const bits = input.readUInt16LE(28)
  const compression = input.readUInt32LE(30)
  if (
    ![40, 52, 56, 108, 124].includes(headerSize) ||
    offset < 14 + headerSize || offset > input.length ||
    width <= 0 || height === 0 || input.readUInt16LE(26) !== 1 ||
    (bits !== 24 && bits !== 32) ||
    (compression !== 0 && !(compression === 3 && bits === 32))
  ) {
    throw new Error('Unsupported BMP image layout; use a PNG screenshot')
  }
  let channels: 3 | 4 = 3
  if (compression === 3) {
    // BI_BITFIELDS uses masks in the extended header, or immediately after
    // a 40-byte header. Only the canonical BGR(A) byte layout is accepted.
    if (
      offset < 66 ||
      input.readUInt32LE(54) !== 0xff0000 ||
      input.readUInt32LE(58) !== 0xff00 ||
      input.readUInt32LE(62) !== 0xff
    ) {
      throw new Error('Unsupported BMP color masks; use a PNG screenshot')
    }
    if (headerSize >= 56) {
      const alpha = input.readUInt32LE(66)
      if (alpha !== 0 && alpha !== 0xff000000) {
        throw new Error('Unsupported BMP alpha mask; use a PNG screenshot')
      }
      if (alpha !== 0) channels = 4
    }
  }
  const stride = Math.ceil(width * bits / 32) * 4
  const pixelBytes = stride * height
  if (!Number.isSafeInteger(pixelBytes) || pixelBytes > input.length - offset) {
    throw new Error('Truncated BMP image pixels')
  }
  // For these uncompressed layouts the output is no larger than the encoded
  // pixel payload, so tiny hostile headers cannot cause an oversized allocation.
  const pixels = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++) {
    const row = offset + (signedHeight < 0 ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const src = row + x * (bits / 8)
      const dst = (y * width + x) * channels
      pixels[dst] = input[src + 2]!
      pixels[dst + 1] = input[src + 1]!
      pixels[dst + 2] = input[src]!
      if (channels === 4) pixels[dst + 3] = input[src + 3]!
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer()
}

/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  const imported = (await import(
    'sharp'
  )) as unknown as MaybeDefault<SharpCreator>
  const sharp = unwrapDefault(imported)
  imageCreatorModule = { default: sharp }
  return sharp
}

// Dynamic import shape varies by module interop mode — ESM yields { default: fn }, CJS yields fn directly.
type MaybeDefault<T> = T | { default: T }

function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}
