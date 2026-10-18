import { afterEach, describe, expect, mock, test } from 'bun:test'
import { randomBytes } from 'crypto'

// Mutable controls for the mocked image processor (image_processor_napi / sharp).
let mockMetadata: unknown = { width: 10, height: 10, format: 'png' }
let throwOnSharpConstruction = false
const defaultBuffer = Buffer.from('rendered')

type MockImageProcessor = {
  metadata: () => Promise<unknown>
  resize: (...args: unknown[]) => MockImageProcessor
  jpeg: (options?: { quality?: number }) => MockImageProcessor
  png: (...args: unknown[]) => MockImageProcessor
  webp: (...args: unknown[]) => MockImageProcessor
  toBuffer: () => Promise<Buffer>
}

function makeSharpInstance(): MockImageProcessor {
  const chain: MockImageProcessor = {
    metadata: () => Promise.resolve(mockMetadata),
    resize: () => chain,
    jpeg: () => chain,
    png: () => chain,
    webp: () => chain,
    toBuffer: () => Promise.resolve(defaultBuffer),
  }
  return chain
}

function sharpFactory(input: Buffer): MockImageProcessor {
  if (throwOnSharpConstruction) {
    throw new Error('image_processor_napi crashed')
  }
  return makeSharpInstance()
}

// Map module paths used by imageResizer.ts.
const imageProcessorPath = '../tools/FileReadTool/imageProcessor.js'
const imageResizerPath = './imageResizer.js'

async function loadResizerModule() {
  return import(`${imageResizerPath}?t=${Date.now()}-${Math.random()}`)
}

const actualImageProcessor = await import(imageProcessorPath)
const originalImageProcessorExports = { ...actualImageProcessor }

afterEach(() => {
  mockMetadata = { width: 10, height: 10, format: 'png' }
  throwOnSharpConstruction = false
  mock.module(imageProcessorPath, () => originalImageProcessorExports)
  mock.restore()
})

// A minimal valid PNG with a 1920x1080 IHDR so the >1568px "overDim" check
// in the catch block reads true. Only the first 24 bytes matter for detection.
function makePngBuffer(width = 1920, height = 1080): Buffer {
  const buf = Buffer.alloc(64)
  buf[0] = 0x89
  buf[1] = 0x50
  buf[2] = 0x4e
  buf[3] = 0x47
  buf[4] = 0x0d
  buf[5] = 0x0a
  buf[6] = 0x1a
  buf[7] = 0x0a
  // IHDR width (bytes 16-19) and height (bytes 20-23)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

// JPEG with legal marker-fill 0xFF bytes and a standalone TEM (FF01) before SOF.
function makeJpegBufferWithFillAndTem(width = 1500, height = 1000): Buffer {
  // SOI, 0xFF fill bytes, standalone TEM (FF01), then SOF0 with dimensions.
  const buf = Buffer.alloc(40)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  buf[3] = 0xff // fill
  buf[4] = 0xff // fill
  buf[5] = 0x01 // TEM
  buf[6] = 0xff
  buf[7] = 0xc0
  buf.writeUInt16BE(17, 8)
  buf[10] = 8
  buf.writeUInt16BE(height, 11)
  buf.writeUInt16BE(width, 13)
  return buf
}

function installBrandCheckingDocument(dataUrl: string): { restore: () => void } {
  const g = globalThis as Record<string, unknown>
  const hadDocument = Object.prototype.hasOwnProperty.call(g, 'document')
  const savedDocument = g.document
  const hadImage = Object.prototype.hasOwnProperty.call(g, 'Image')
  const savedImage = g.Image
  const hadCreateImageBitmap = Object.prototype.hasOwnProperty.call(
    g,
    'createImageBitmap',
  )
  const savedCreateImageBitmap = g.createImageBitmap
  const canvas = {
    width: 0,
    height: 0,
    getContext(this: unknown) {
      if (this !== canvas) {
        throw new TypeError('Illegal invocation')
      }
      return { drawImage() {} }
    },
    toDataURL(this: unknown) {
      if (this !== canvas) {
        throw new TypeError('Illegal invocation')
      }
      return dataUrl
    },
  }
  const documentObj = {
    createElement(this: unknown, _tag: string) {
      if (this !== documentObj) {
        throw new TypeError('Illegal invocation')
      }
      return canvas
    },
    Image: class {
      onload: (() => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      set src(_v: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  }
  // Production prefers globalThis.Image, then document.Image, and
  // createImageBitmap over Image. Clear host globals so this mock is the
  // decoder that actually runs.
  delete g.Image
  delete g.createImageBitmap
  g.document = documentObj
  return {
    restore() {
      if (hadDocument) {
        g.document = savedDocument
      } else {
        delete g.document
      }
      if (hadImage) {
        g.Image = savedImage
      } else {
        delete g.Image
      }
      if (hadCreateImageBitmap) {
        g.createImageBitmap = savedCreateImageBitmap
      } else {
        delete g.createImageBitmap
      }
    },
  }
}

function makeJpegBuffer(width = 3840, height = 2160): Buffer {
  const buf = Buffer.alloc(32)
  buf[0] = 0xff
  buf[1] = 0xd8 // SOI
  // SOF2 (progressive): marker, length(2), precision(1), height(2), width(2)...
  buf[2] = 0xff
  buf[3] = 0xc2
  buf.writeUInt16BE(17, 4) // segment length
  buf[6] = 8 // precision
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  return buf
}

// GIF logical screen descriptor: width (LE at 6-7), height (LE at 8-9).
function makeGifBuffer(width = 3000, height = 2500): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0x47 // G
  buf[1] = 0x49 // I
  buf[2] = 0x46 // F
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

// WebP lossy (VP8) keyframe matching the parser. The VP8 chunk starts at
// byte 12; its 4-byte size field is at 16-19; the VP8 bitstream (3-byte
// start code 0x9D 0x01 0x2A) begins at byte 23; the 14-bit width is at
// bytes 26-27 and the 14-bit height at bytes 28-29 — stored directly, no
// -1 bias (RFC 6386; only VP8L uses minus-one encoding).
function makeWebpLossyBuffer(width = 3800, height = 2100): Buffer {
  const buf = Buffer.alloc(32)
  buf.write('RIFF', 0, 'ascii')
  // File size = total - 8 (RIFF header). Leave the WEBP/VP8 container intact.
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8 ', 12, 'ascii')
  // VP8 chunk size = bytes from the bitstream onward.
  buf.writeUInt32LE(buf.length - 20, 16)
  // Start code at byte 23-25.
  buf[23] = 0x9d
  buf[24] = 0x01
  buf[25] = 0x2a
  buf.writeUInt16LE(width & 0x3fff, 26)
  buf.writeUInt16LE(height & 0x3fff, 28)
  return buf
}

// WebP extended (VP8X) header: canvas dimensions live in the VP8X chunk
// itself (bytes 24-26 width-1, 27-29 height-1, 24-bit LE), not in a VP8/VP8L
// content chunk.
function makeWebpExtendedBuffer(width = 3800, height = 2100): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  buf.writeUInt32LE(10, 16) // VP8X chunk payload size
  // byte 20: flags, bytes 21-23: reserved
  buf.writeUIntLE((width - 1) & 0xffffff, 24, 3)
  buf.writeUIntLE((height - 1) & 0xffffff, 27, 3)
  return buf
}

// WebP lossless (VP8L) buffer: 1-byte 0x2F signature at byte 20, then the
// 32-bit transform header at byte 21 (bits [0..13] = width-1, [14..27] =
// height-1). Source: RFC 6386. Verified against sharp-encoded output.
function makeWebpLosslessBuffer(width = 2500, height = 1800): Buffer {
  const buf = Buffer.alloc(32)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8L', 12, 'ascii')
  buf.writeUInt32LE(buf.length - 20, 16)
  buf[20] = 0x2f
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  buf.writeUInt32LE(bits >>> 0, 21)
  return buf
}

describe('maybeResizeAndDownsampleImageBuffer — #1964 fixes', () => {
  test('does not throw and returns a buffer when metadata is undefined', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(sharpFactory),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    mockMetadata = undefined
    const imageBuffer = makePngBuffer(10, 10)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.mediaType).toBe('png')
    // dimensions are intentionally omitted when metadata is unavailable
    expect(result.dimensions).toBeUndefined()
  })

  test('metadata-less + compact many-image-oversized PNG: allowed through without Canvas', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(sharpFactory),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    mockMetadata = undefined
    // Compact in bytes but 3840x2160 pixels. Without Canvas, the Windows CLI
    // must still attach this screenshot rather than recreating #1964.
    const imageBuffer = makePngBuffer(3840, 2160)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )
    expect(result.buffer.equals(imageBuffer)).toBe(true)
    expect(result.mediaType).toBe('png')
  })

  test('metadata-less + compact many-image-oversized PNG: downsampled via Canvas when available', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(sharpFactory),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    mockMetadata = undefined

    const downsampledBytes = Buffer.from('downsampled-pixels')
    const dataUrl = `data:image/png;base64,${downsampledBytes.toString('base64')}`
    const canvas = installBrandCheckingDocument(dataUrl)

    const imageBuffer = makePngBuffer(3840, 2160)
    try {
      const result = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      )
      expect(result.buffer.equals(downsampledBytes)).toBe(true)
    } finally {
      canvas.restore()
    }
  })

  test('metadata-less + oversized: falls to lower JPEG quality until it fits', async () => {
    // Simulate a noisy image that only fits the raw target at quality <= 60.
    let lastQuality: number | undefined
    const sharpWithQuality = (input: Buffer): MockImageProcessor => {
      const chain: MockImageProcessor = {
        metadata: () => Promise.resolve(undefined),
        resize: () => chain,
        jpeg: opts => {
          lastQuality = opts?.quality
          // quality 80 still oversized; 60 and below fit (<= 3.75MB).
          chain.toBuffer = () =>
            Promise.resolve(
              Buffer.alloc(lastQuality && lastQuality <= 60 ? 1000 : 4_000_000),
            )
          return chain
        },
        png: () => chain,
        webp: () => chain,
        toBuffer: () => Promise.resolve(Buffer.alloc(1000)),
      }
      return chain
    }
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(sharpWithQuality),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    // Real screenshot bytes are always parseable, so give this a valid PNG
    // header with in-many-image-limit dimensions (unlike pure random bytes,
    // which the many-image guard now fails closed on).
    const imageBuffer = Buffer.concat([
      makePngBuffer(800, 600),
      randomBytes(4_000_000 - 64),
    ])
    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.mediaType).toBe('jpeg')
    // Stopped at a quality that produces an in-budget buffer, not returning
    // the oversized quality-80 output.
    expect(result.buffer.length).toBeLessThanOrEqual(1_000_000)
    expect(lastQuality).toBe(60)
  })

  test('metadata-less + oversized: throws user-facing limit error when no quality fits', async () => {
    const sharpAlwaysTooBig = (input: Buffer): MockImageProcessor => {
      const chain: MockImageProcessor = {
        metadata: () => Promise.resolve(undefined),
        resize: () => chain,
        jpeg: () => {
          chain.toBuffer = () => Promise.resolve(Buffer.alloc(4_000_000))
          return chain
        },
        png: () => chain,
        webp: () => chain,
        toBuffer: () => Promise.resolve(Buffer.alloc(4_000_000)),
      }
      return chain
    }
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(sharpAlwaysTooBig),
    }))
    const { maybeResizeAndDownsampleImageBuffer, ImageResizeError } =
      await loadResizerModule()

    const imageBuffer = randomBytes(4_000_000)
    await expect(
      maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      ),
    ).rejects.toBeInstanceOf(ImageResizeError)
  })

  test('catch block: large (overDim) but <=5MB image is allowed through, not thrown', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      // getImageProcessor resolves, but sharp construction crashes (simulates
      // the native connector failing on Windows) -> function lands in catch.
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    // 1920x1080 PNG, small byte size -> base64 well under 5MB.
    const imageBuffer = makePngBuffer(1920, 1080)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    // Regression: previously this threw ImageResizeError because overDim was
    // required to be false. Now it passes through because the API resizes
    // large dimensions server-side.
    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.mediaType).toBe('png')
  })

  test('catch block: image over 5MB and 1568px reports the payload limit', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    // A large buffer: base64 size = ceil(len*4/3) must exceed 5MB.
    const imageBuffer = Buffer.concat([
      makePngBuffer(1920, 1080),
      randomBytes(5 * 1024 * 1024), // ~5MB raw -> >5MB base64
    ])

    await expect(
      maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      ),
    ).rejects.toThrow('5MB API limit')
  })

  test('catch block: image over 2000px is allowed through when downsample unavailable', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    // 3840x2160 PNG, small byte size -> base64 well under 5MB. The many-image
    // 2000px bound is not a clipboard admission limit on the no-Canvas path.
    const imageBuffer = makePngBuffer(3840, 2160)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )
    expect(result.buffer.equals(imageBuffer)).toBe(true)
    expect(result.mediaType).toBe('png')
  })

  test('catch block: image at 8000px API edge is allowed through when downsample unavailable', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()
    const imageBuffer = makePngBuffer(8000, 100)
    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )
    expect(result.buffer.equals(imageBuffer)).toBe(true)
    expect(result.mediaType).toBe('png')
  })

  test('catch block: image over the 8000px API edge is rejected when downsample unavailable', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer, ImageResizeError } =
      await loadResizerModule()
    const imageBuffer = makePngBuffer(8001, 100)
    await expect(
      maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      ),
    ).rejects.toBeInstanceOf(ImageResizeError)
  })

  test('catch block: image over both payload and API edge reports the 8000px hard limit', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()
    const imageBuffer = Buffer.concat([
      makePngBuffer(8001, 100),
      randomBytes(5 * 1024 * 1024),
    ])

    await expect(
      maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      ),
    ).rejects.toThrow('8000x8000px API limit')
  })

  test('catch block: image over 2000px is downsampled via Canvas fallback when available', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    const downsampledBytes = Buffer.from('downsampled-pixels')
    const dataUrl = `data:image/png;base64,${downsampledBytes.toString('base64')}`
    const canvas = installBrandCheckingDocument(dataUrl)

    const imageBuffer = makePngBuffer(3840, 2160)
    try {
      const result = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      )
      expect(result.buffer).toBeInstanceOf(Buffer)
      expect(result.buffer.equals(imageBuffer)).toBe(false)
      expect(result.buffer.equals(downsampledBytes)).toBe(true)
      expect(result.mediaType).toBe('png')
    } finally {
      canvas.restore()
    }
  })

  test('catch block: JPEG over the API edge recovers through Canvas with the jpeg subtype', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    const downsampledBytes = Buffer.from('downsampled-jpeg')
    const dataUrl = `data:image/jpeg;base64,${downsampledBytes.toString('base64')}`
    const canvas = installBrandCheckingDocument(dataUrl)

    const imageBuffer = makeJpegBuffer(8001, 2160)
    try {
      const result = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'jpeg',
      )
      expect(result.buffer.equals(downsampledBytes)).toBe(true)
      expect(result.mediaType).toBe('jpeg')
    } finally {
      canvas.restore()
    }
  })

  test('catch block: createImageBitmap without fetch still downsamples via Image', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    const downsampledBytes = Buffer.from('downsampled-via-image')
    const dataUrl = `data:image/png;base64,${downsampledBytes.toString('base64')}`
    const g = globalThis as Record<string, unknown>
    const hadFetch = Object.prototype.hasOwnProperty.call(g, 'fetch')
    const savedFetch = g.fetch
    const canvas = installBrandCheckingDocument(dataUrl)
    g.createImageBitmap = async () => {
      throw new Error('bitmap should not run without fetch')
    }
    delete g.fetch
    const imageBuffer = makePngBuffer(3840, 2160)
    try {
      const result = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      )
      expect(result.buffer.equals(downsampledBytes)).toBe(true)
      expect(result.mediaType).toBe('png')
    } finally {
      canvas.restore()
      if (hadFetch) {
        g.fetch = savedFetch
      } else {
        delete g.fetch
      }
    }
  })

  test('catch block: createImageBitmap/fetch failure falls through to Image downsample', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    const downsampledBytes = Buffer.from('downsampled-after-bitmap-fail')
    const dataUrl = `data:image/png;base64,${downsampledBytes.toString('base64')}`
    const g = globalThis as Record<string, unknown>
    const hadFetch = Object.prototype.hasOwnProperty.call(g, 'fetch')
    const savedFetch = g.fetch
    const canvas = installBrandCheckingDocument(dataUrl)
    g.createImageBitmap = async () => {
      throw new Error('bitmap failed')
    }
    g.fetch = async () => {
      throw new Error('fetch failed')
    }
    const imageBuffer = makePngBuffer(3840, 2160)
    try {
      const result = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        'png',
      )
      expect(result.buffer.equals(downsampledBytes)).toBe(true)
      expect(result.mediaType).toBe('png')
    } finally {
      canvas.restore()
      if (hadFetch) {
        g.fetch = savedFetch
      } else {
        delete g.fetch
      }
    }
  })

  test('catch block: oversized non-PNG (WEBP/JPEG/GIF) is allowed through when downsample unavailable', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    const fixtures: Array<[Buffer, string]> = [
      [makeJpegBuffer(3840, 2160), 'jpeg'],
      [makeWebpLossyBuffer(3800, 2100), 'webp'],
      [makeGifBuffer(3000, 2500), 'gif'],
    ]
    for (const [imageBuffer, ext] of fixtures) {
      const result = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        ext,
      )
      expect(result.buffer.equals(imageBuffer)).toBe(true)
      expect(result.mediaType).toBe(ext)
    }
  })

  test('readImageDimensions: parses real WebP VP8/VP8L byte offsets', async () => {
    const { readImageDimensions } = await loadResizerModule()
    // Parsed dimensions for oversized and in-limit WebP fixtures.
    expect(readImageDimensions(makeWebpLossyBuffer(3800, 2100))).toEqual({
      width: 3800,
      height: 2100,
    })
    expect(readImageDimensions(makeWebpLosslessBuffer(2500, 1800))).toEqual({
      width: 2500,
      height: 1800,
    })
    // ...and an in-limit WebP is accepted (parsed exactly).
    expect(readImageDimensions(makeWebpLossyBuffer(1500, 1200))).toEqual({
      width: 1500,
      height: 1200,
    })
  })

  test('readImageDimensions: rejects WebP payloads with invalid VP8 signatures', async () => {
    const { readImageDimensions } = await loadResizerModule()
    const invalidLossless = makeWebpLosslessBuffer(1000, 800)
    invalidLossless[20] = 0
    const invalidLossy = makeWebpLossyBuffer(1000, 800)
    invalidLossy[23] = 0

    expect(readImageDimensions(invalidLossless)).toBeNull()
    expect(readImageDimensions(invalidLossy)).toBeNull()
  })

  test('readImageDimensions: VP8 lossy at exactly the 2000px boundary parses exact dimensions', async () => {
    const { readImageDimensions } = await loadResizerModule()
    expect(readImageDimensions(makeWebpLossyBuffer(2000, 2000))).toEqual({
      width: 2000,
      height: 2000,
    })
  })

  test('catch block: VP8 lossy at exactly the 2000px boundary is allowed through unchanged', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()
    const imageBuffer = makeWebpLossyBuffer(2000, 2000)
    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'webp',
    )
    expect(result.buffer.equals(imageBuffer)).toBe(true)
  })

  test('readImageDimensions: parses VP8X extended WebP dimensions exactly', async () => {
    const { readImageDimensions } = await loadResizerModule()
    expect(readImageDimensions(makeWebpExtendedBuffer(1500, 1200))).toEqual({
      width: 1500,
      height: 1200,
    })
  })

  test('catch block: in-limit VP8X extended WebP is allowed through unchanged', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()
    const imageBuffer = makeWebpExtendedBuffer(1500, 1200)
    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'webp',
    )
    expect(result.buffer.equals(imageBuffer)).toBe(true)
  })

  test('catch block: oversized VP8X extended WebP is allowed through when downsample unavailable', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()
    const imageBuffer = makeWebpExtendedBuffer(3840, 2160)
    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'webp',
    )
    expect(result.buffer.equals(imageBuffer)).toBe(true)
  })

  test('catch block: in-limit WEBP (<=2000px) is allowed through unchanged', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()
    // 1500x1200 WebP, small byte size -> base64 well under 5MB.
    const imageBuffer = makeWebpLossyBuffer(1500, 1200)
    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'webp',
    )
    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.buffer.equals(imageBuffer)).toBe(true)
  })

  test('readImageDimensions: JPEG fill bytes and TEM markers do not hide SOF', async () => {
    const { readImageDimensions } = await loadResizerModule()
    expect(readImageDimensions(makeJpegBufferWithFillAndTem(1500, 1000))).toEqual(
      {
        width: 1500,
        height: 1000,
      },
    )
    expect(readImageDimensions(makeJpegBufferWithFillAndTem(3840, 2160))).toEqual(
      {
        width: 3840,
        height: 2160,
      },
    )
  })

  test('catch block: in-limit JPEG with fill/TEM padding is allowed through', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(() => {
        throw new Error('image_processor_napi crashed')
      }),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()
    const imageBuffer = makeJpegBufferWithFillAndTem(1500, 1000)
    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'jpeg',
    )
    expect(result.buffer.equals(imageBuffer)).toBe(true)
    expect(result.mediaType).toBe('jpeg')
  })

  test('happy path: small in-limit PNG returns dimensions', async () => {
    mock.module(imageProcessorPath, () => ({
      ...actualImageProcessor,
      getImageProcessor: () => Promise.resolve(sharpFactory),
    }))
    const { maybeResizeAndDownsampleImageBuffer } = await loadResizerModule()

    mockMetadata = { width: 100, height: 50, format: 'png' }
    const imageBuffer = makePngBuffer(100, 50)

    const result = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )

    expect(result.mediaType).toBe('png')
    expect(result.dimensions).toEqual({
      originalWidth: 100,
      originalHeight: 50,
      displayWidth: 100,
      displayHeight: 50,
    })
  })
})
