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
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const execaModule = await import('execa')
    const dir = mkdtempSync(join(tmpdir(),'image-passthrough-'))
    const file = join(dir,'image.png')
    const screenshot = join(dir,'claude_cli_latest_screenshot.png')
    process.env.CLAUDE_CODE_TMPDIR = dir
    writeFileSync(file,input)
    mock.module('execa', () => ({ ...execaModule, execa: async command => {
      if (command.includes('TARGETS')) return {exitCode:0,stdout:'image/png'}
      if (command.startsWith('rm ')) rmSync(screenshot)
      else writeFileSync(screenshot,input)
      return {exitCode:0,stdout:''}
    } }))
    try {
      const {getImageFromClipboard,tryReadImageFromPath} = await import('./imagePaste.ts')
      const {readImageWithTokenBudget} = await import('../tools/FileReadTool/FileReadTool.ts')
      for (const image of [await getImageFromClipboard(),await tryReadImageFromPath(file)]) {
        assert.equal(image.base64,input.toString('base64'))
        assert.equal(image.mediaType,'image/png')
      }
      const read = await readImageWithTokenBudget(file)
      assert.equal(read.file.base64,input.toString('base64'))
      assert.equal(read.file.type,'image/png')
    } finally { rmSync(dir,{recursive:true,force:true}) }
    console.log('image check passed')
  `)
}, 20_000)

test('clipboard BMP screenshots convert with opt-in sharp and report invalid data safely', () => {
  runImageCheck(`
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import sharp from 'sharp'
    import * as execaModule from 'execa'
    const dir = mkdtempSync(join(tmpdir(), 'bmp-clipboard-'))
    process.env.CLAUDE_CODE_TMPDIR = dir
    const screenshot = join(dir, 'claude_cli_latest_screenshot.png')
    let input
    mock.module('execa', () => ({ ...execaModule, execa: async command => {
      if (command.includes('TARGETS')) return { exitCode: 0, stdout: 'image/bmp' }
      if (command.startsWith('rm ')) rmSync(screenshot)
      else writeFileSync(screenshot, input)
      return { exitCode: 0, stdout: '' }
    } }))
    const { getImageFromClipboard, formatClipboardImagePasteError,
      CLIPBOARD_IMAGE_PASTE_GENERIC_ERROR } = await import('./imagePaste.ts')
    try {
      for (const [bits, topDown, bitfields] of [[24,false,false], [32,false,false], [32,true,false], [32,true,true]]) {
        const width = 1, height = 2
        const stride = 4
        const offset = bitfields ? 70 : 54
        input = Buffer.alloc(offset + stride * height)
        input.write('BM'); input.writeUInt32LE(input.length,2)
        input.writeUInt32LE(offset,10); input.writeUInt32LE(bitfields ? 56 : 40,14)
        input.writeInt32LE(width,18); input.writeInt32LE(topDown ? -height : height,22)
        input.writeUInt16LE(1,26); input.writeUInt16LE(bits,28)
        if (bitfields) {
          input.writeUInt32LE(3,30)
          for (const [i,mask] of [0xff0000,0xff00,0xff,0xff000000].entries()) input.writeUInt32LE(mask,54+i*4)
        }
        // The high byte in BI_RGB is reserved, not alpha; zero must stay opaque.
        const rows = topDown ? [[0,0,255,128],[255,0,0,64]] : [[255,0,0,64],[0,0,255,128]]
        rows.forEach((row,y) => input.set(row.slice(0,bits/8),offset+y*stride))
        if (!bitfields && bits === 32) { input[offset+3]=0; input[offset+7]=0 }
        const image = await getImageFromClipboard()
        assert.ok(image, 'valid BMP must attach instead of returning empty clipboard')
        assert.equal(image.mediaType,'image/png')
        const pixels = await sharp(Buffer.from(image.base64,'base64')).ensureAlpha().raw().toBuffer()
        assert.deepEqual([...pixels], [255,0,0,bitfields?128:255, 0,0,255,bitfields?64:255])
      }
      const valid = Buffer.from(input)
      const invalid = [valid.subarray(0,20), valid.subarray(0,valid.length-1)]
      for (const [offset,value] of [[10,1],[18,0x7fffffff],[22,0x7fffffff],[30,1],[54,0xff]]) {
        const bad=Buffer.from(valid); bad.writeUInt32LE(value,offset); invalid.push(bad)
      }
      for (const bad of invalid) {
        input=bad
        await assert.rejects(getImageFromClipboard(), error => {
          assert.equal(formatClipboardImagePasteError(error),CLIPBOARD_IMAGE_PASTE_GENERIC_ERROR)
          return true
        })
      }
      console.log('image check passed')
    } finally { rmSync(dir,{recursive:true,force:true}) }
  `)
}, 20_000)
