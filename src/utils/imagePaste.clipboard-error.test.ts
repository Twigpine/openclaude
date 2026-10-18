import { afterEach, describe, expect, mock, test } from 'bun:test'
import { IMAGE_TARGET_RAW_SIZE } from '../constants/apiLimits.js'
import * as actualImageResizerModule from './imageResizer.js'
import * as actualLogModule from './log.js'

type ImagePasteModule = typeof import('./imagePaste.js')

const originalImageResizerExports = { ...actualImageResizerModule }
const originalLogExports = { ...actualLogModule }
const { ImageResizeError } = originalImageResizerExports

function restoreMocks(): void {
  mock.module('./imageResizer.js', () => originalImageResizerExports)
  mock.module('./log.js', () => originalLogExports)
}

async function importImagePaste(): Promise<ImagePasteModule> {
  return import(`./imagePaste.js?clipboard-error=${Date.now()}-${Math.random()}`)
}

afterEach(async () => {
  await restoreMocks()
  mock.restore()
})

describe('clipboard image paste error contract', () => {
  test('formatClipboardImagePasteError keeps ImageResizeError messages', async () => {
    const { formatClipboardImagePasteError, CLIPBOARD_IMAGE_PASTE_GENERIC_ERROR } =
      await importImagePaste()
    const err = new ImageResizeError(
      'Unable to resize image — dimensions exceed the 8000x8000px API limit and image processing failed. Please resize the image to reduce its pixel dimensions.',
    )
    expect(formatClipboardImagePasteError(err)).toBe(err.message)
    expect(formatClipboardImagePasteError(new Error('boom'))).toBe(
      CLIPBOARD_IMAGE_PASTE_GENERIC_ERROR,
    )
    expect(formatClipboardImagePasteError('string-throw')).toBe(
      CLIPBOARD_IMAGE_PASTE_GENERIC_ERROR,
    )
  })

  test('rethrowIfClipboardResizeError does not let ImageResizeError become a missing-reader fallback', async () => {
    const { rethrowIfClipboardResizeError } = await importImagePaste()
    const err = new ImageResizeError('too large')
    expect(() => rethrowIfClipboardResizeError(err)).toThrow(err)
    expect(() => rethrowIfClipboardResizeError(new Error('napi missing'))).not.toThrow()
  })

  test('logClipboardImagePasteRejection reports the rejection through logError', async () => {
    const logError = mock(() => {})
    mock.module('./log.js', () => ({
      ...actualLogModule,
      logError,
    }))
    const { logClipboardImagePasteRejection } = await importImagePaste()
    const err = new ImageResizeError('too large')
    logClipboardImagePasteRejection(err)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(err)
  })

  test('native clipboard resize failure rejects instead of returning a fallback image', async () => {
    const ImageResizeErrorCtor = actualImageResizerModule.ImageResizeError
    const maybeResizeAndDownsampleImageBuffer = mock(async () => {
      throw new ImageResizeErrorCtor(
        'Unable to resize image — the image exceeds the size limit even after compression and image processing failed to read its dimensions. Please use a smaller or lower-resolution image.',
      )
    })
    mock.module('./imageResizer.js', () => ({
      ...actualImageResizerModule,
      maybeResizeAndDownsampleImageBuffer,
    }))
    const { clipboardImageFromNativePng } = await importImagePaste()
    const native = {
      png: Buffer.alloc(IMAGE_TARGET_RAW_SIZE + 1),
      originalWidth: 2000,
      originalHeight: 2000,
      width: 1568,
      height: 1568,
    }
    await expect(clipboardImageFromNativePng(native)).rejects.toBeInstanceOf(
      ImageResizeErrorCtor,
    )
    expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledTimes(1)
  })
})
