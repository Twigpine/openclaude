import { expect, mock, test } from 'bun:test'
import * as imagePaste from './imagePaste.js'
import * as imageResizer from './imageResizer.js'

const originalPasteExports = { ...imagePaste }
const originalResizerExports = { ...imageResizer }

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('production image modules remain active after mock-heavy suites', async () => {
  const mockedResize = mock(async () => { throw new Error('leaked resize mock') })
  try {
    mock.module('./imageResizer.js', () => ({
      ...originalResizerExports,
      maybeResizeAndDownsampleImageBuffer: mockedResize,
    }))
    const mocked = await import('./imageResizer.js')
    expect(mocked.maybeResizeAndDownsampleImageBuffer).toBe(mockedResize)
  } finally {
    mock.module('./imageResizer.js', () => originalResizerExports)
    mock.module('./imagePaste.js', () => originalPasteExports)
    mock.restore()
  }
  const { maybeResizeAndDownsampleImageBuffer, ImageResizeError } =
    await import('./imageResizer.js')
  const { tryReadImageFromPath, formatClipboardImagePasteError } =
    await import('./imagePaste.js')
  expect(maybeResizeAndDownsampleImageBuffer).not.toBe(mockedResize)
  const resized = await maybeResizeAndDownsampleImageBuffer(
    onePixelPng,
    onePixelPng.length,
    'png',
  )
  expect(resized.dimensions).toMatchObject({
    originalWidth: 1,
    originalHeight: 1,
  })

  expect(
    await tryReadImageFromPath(
      `${process.cwd()}/definitely-missing-image-mock-lifecycle.png`,
    ),
  ).toBeNull()

  const error = new ImageResizeError('canonical resize error')
  expect(formatClipboardImagePasteError(error)).toBe(error.message)
})
