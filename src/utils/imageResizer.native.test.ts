import { expect, test } from 'bun:test'

// A fresh process keeps the real native addon independent of shared-process
// image-processor mocks, and keeps the missing-sharp simulation local.
function runImageCheck(source: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', source], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
  expect(result.stderr.toString()).not.toContain('AssertionError')
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('image check passed')
}

// Leave time beyond the child deadline for failure reporting and cleanup.
test('native sharp creates, resizes and decodes images and rejects invalid input', () => {
  runImageCheck(`
    import assert from 'node:assert/strict'
    import { getImageCreator, getImageProcessor } from '../tools/FileReadTool/imageProcessor.ts'
    import { maybeResizeAndDownsampleImageBuffer } from './imageResizer.ts'

    const create = await getImageCreator()
    const processImage = await getImageProcessor()
    for (const format of ['png', 'jpeg', 'webp']) {
      const input = await create({ create: {
        width: 2400, height: 1200, channels: 3,
        background: { r: 30, g: 100, b: 180 },
      } })[format]().toBuffer()
      const result = await maybeResizeAndDownsampleImageBuffer(input, input.length, format)
      const metadata = await processImage(result.buffer).metadata()
      assert.equal(result.mediaType, format)
      assert.equal(metadata.format, format)
      assert.equal(metadata.width, 1568)
      assert.equal(metadata.height, 784)
      assert.equal(result.dimensions.originalWidth, 2400)
      assert.equal(result.dimensions.originalHeight, 1200)
      assert.equal(result.dimensions.displayWidth, metadata.width)
      assert.equal(result.dimensions.displayHeight, metadata.height)
    }
    await assert.rejects(processImage(Buffer.from('invalid image')).metadata())
    await assert.rejects(maybeResizeAndDownsampleImageBuffer(Buffer.alloc(0), 0, 'png'), /empty/)
    console.log('image check passed')
  `)
}, 20_000)

test('missing sharp preserves the in-budget image fallback', () => {
  runImageCheck(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    mock.module('sharp', () => ({ __stub: true }))
    const { getImageProcessor, ImageProcessorUnavailableError } = await import('../tools/FileReadTool/imageProcessor.ts')
    const { maybeResizeAndDownsampleImageBuffer } = await import('./imageResizer.ts')
    await assert.rejects(getImageProcessor(), ImageProcessorUnavailableError)
    const input = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const result = await maybeResizeAndDownsampleImageBuffer(input, input.length, 'png')
    assert.deepEqual(result.buffer, input)
    assert.equal(result.mediaType, 'png')
    console.log('image check passed')
  `)
}, 20_000)
