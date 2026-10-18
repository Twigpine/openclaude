import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as actualExecaModule from 'execa'
import * as actualExecFileModule from './execFileNoThrow.js'
import * as actualImageResizerModule from './imageResizer.js'

type ImagePasteModule = typeof import('./imagePaste.js')
type ExecaCall = [string, ...unknown[]]

const originalExecFileExports = { ...actualExecFileModule }
const originalExecaExports = { ...actualExecaModule }
const originalImageResizerExports = { ...actualImageResizerModule }
const originalPlatform = process.platform
const originalTemp = process.env.TEMP
const originalClaudeCodeTmpdir = process.env.CLAUDE_CODE_TMPDIR

let tempDirs: string[] = []

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
  })
}

function restoreMocks(): void {
  mock.module('./execFileNoThrow.js', () => originalExecFileExports)
  mock.module('execa', () => originalExecaExports)
  mock.module('./imageResizer.js', () => originalImageResizerExports)
}

async function importImagePaste(): Promise<ImagePasteModule> {
  return import(`./imagePaste.js?win32=${Date.now()}-${Math.random()}`)
}

afterEach(async () => {
  setPlatform(originalPlatform)
  if (originalTemp === undefined) {
    delete process.env.TEMP
  } else {
    process.env.TEMP = originalTemp
  }
  if (originalClaudeCodeTmpdir === undefined) {
    delete process.env.CLAUDE_CODE_TMPDIR
  } else {
    process.env.CLAUDE_CODE_TMPDIR = originalClaudeCodeTmpdir
  }
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true })
  }
  tempDirs = []
  await restoreMocks()
  mock.restore()
})

describe('Windows clipboard image handling', () => {
  test('hasImageInClipboard maps PowerShell True and False stdout', async () => {
    setPlatform('win32')
    const execFileNoThrowWithCwd = mock(async () => ({
      code: 0,
      stdout: 'True\r\n',
      stderr: '',
    }))
    mock.module('./execFileNoThrow.js', () => ({
      ...actualExecFileModule,
      execFileNoThrowWithCwd,
    }))

    let imagePaste = await importImagePaste()
    expect(await imagePaste.hasImageInClipboard()).toBe(true)
    expect(execFileNoThrowWithCwd).toHaveBeenCalledWith('powershell', [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::ContainsImage()',
    ])

    execFileNoThrowWithCwd.mockResolvedValueOnce({
      code: 0,
      stdout: 'False\r\n',
      stderr: '',
    })
    imagePaste = await importImagePaste()
    expect(await imagePaste.hasImageInClipboard()).toBe(false)
  })

  test('getImageFromClipboard tries GetImage when Windows reports no image', async () => {
    setPlatform('win32')
    const execa = mock(async () => ({
      exitCode: 0,
      stdout: 'False\r\n',
      stderr: '',
    }))
    mock.module('execa', () => ({ ...actualExecaModule, execa }))

    const { getImageFromClipboard } = await importImagePaste()

    expect(await getImageFromClipboard()).toBeNull()
    expect(execa).toHaveBeenCalledTimes(3)
    const checkCall = execa.mock.calls[0] as unknown as ExecaCall | undefined
    expect(checkCall?.[0]).toContain('powershell -NoProfile -Command')
    expect(checkCall?.[0]).toContain('Clipboard]::ContainsImage()')
    const deleteCall = execa.mock.calls[2] as unknown as ExecaCall | undefined
    expect(deleteCall?.[0]).toContain('del /f')
  })

  test('getImageFromClipboard keeps Windows backslashes and escapes apostrophes in the save path', async () => {
    setPlatform('win32')
    process.env.TEMP = "C:\\Temp\\O'Brien"
    const execa = mock(async () => ({
      exitCode: 0,
      stdout: 'True\r\n',
      stderr: '',
    }))
    execa.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'True\r\n',
      stderr: '',
    })
    execa.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: '',
    })
    mock.module('execa', () => ({ ...actualExecaModule, execa }))

    const { getImageFromClipboard } = await importImagePaste()

    expect(await getImageFromClipboard()).toBeNull()
    const saveCall = execa.mock.calls[1] as unknown as ExecaCall | undefined
    const saveCommand = String(saveCall?.[0] ?? '')
    expect(saveCommand).toContain("C:\\Temp\\O''Brien")
    expect(saveCommand).not.toContain('C:\\\\Temp')
    expect(saveCommand).toContain('powershell -NoProfile -Command')
    expect(saveCommand).toContain(
      '[System.Windows.Forms.Clipboard]::GetImage()',
    )
    expect(saveCommand).toContain('if (-not $img) { exit 1 }')
  })

  test('getImageFromClipboard saves a raw Windows bitmap when ContainsImage reports False', async () => {
    setPlatform('win32')
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-image-paste-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CODE_TMPDIR = tempDir
    const screenshotPath = join(tempDir, 'claude_cli_latest_screenshot.png')
    const imageBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const execa = mock(async (command: string) => {
      if (command.includes('Clipboard]::GetImage()')) {
        writeFileSync(screenshotPath, imageBuffer)
      }
      return {
        exitCode: 0,
        stdout: 'False\r\n',
        stderr: '',
      }
    })

    const maybeResizeAndDownsampleImageBuffer = mock(async () => ({
      buffer: imageBuffer,
      mediaType: 'png',
      dimensions: {
        originalWidth: 1,
        originalHeight: 1,
        displayWidth: 1,
        displayHeight: 1,
      },
    }))
    mock.module('execa', () => ({ ...actualExecaModule, execa }))
    mock.module('./imageResizer.js', () => ({
      ...actualImageResizerModule,
      maybeResizeAndDownsampleImageBuffer,
    }))

    const { getImageFromClipboard } = await importImagePaste()

    const image = await getImageFromClipboard()
    expect(image?.base64).toEqual(expect.any(String))
    expect(image?.mediaType).toBe('image/png')
    expect(image?.dimensions).toEqual({
      originalWidth: 1,
      originalHeight: 1,
      displayWidth: 1,
      displayHeight: 1,
    })
    expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledWith(
      imageBuffer,
      imageBuffer.length,
      'png',
    )
    expect(image?.base64.length).toBeGreaterThan(0)
    expect(execa).toHaveBeenCalledTimes(3)
    const checkCall = execa.mock.calls[0] as unknown as ExecaCall | undefined
    expect(String(checkCall?.[0] ?? '')).toContain(
      'Clipboard]::ContainsImage()',
    )
    const saveCall = execa.mock.calls[1] as unknown as ExecaCall | undefined
    expect(String(saveCall?.[0] ?? '')).toContain(screenshotPath)
    const deleteCall = execa.mock.calls[2] as unknown as ExecaCall | undefined
    expect(deleteCall?.[0]).toContain('del /f')
  })

  test('getImageFromClipboard does not hide ImageResizeError as a missing clipboard image', async () => {
    setPlatform('win32')
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-image-paste-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CODE_TMPDIR = tempDir
    const screenshotPath = join(tempDir, 'claude_cli_latest_screenshot.png')
    const imageBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const execa = mock(async (command: string) => {
      if (command.includes('Clipboard]::GetImage()')) {
        writeFileSync(screenshotPath, imageBuffer)
      }
      return {
        exitCode: 0,
        stdout: 'False\r\n',
        stderr: '',
      }
    })

    const ImageResizeError = actualImageResizerModule.ImageResizeError
    const maybeResizeAndDownsampleImageBuffer = mock(async () => {
      throw new ImageResizeError(
        'Unable to resize image — dimensions exceed the 8000x8000px API limit and image processing failed. Please resize the image to reduce its pixel dimensions.',
      )
    })
    mock.module('execa', () => ({ ...actualExecaModule, execa }))
    mock.module('./imageResizer.js', () => ({
      ...actualImageResizerModule,
      maybeResizeAndDownsampleImageBuffer,
    }))

    const { getImageFromClipboard } = await importImagePaste()
    await expect(getImageFromClipboard()).rejects.toBeInstanceOf(
      ImageResizeError,
    )
    expect(execa).toHaveBeenCalledTimes(3)
    const deleteCall = execa.mock.calls[2] as unknown as ExecaCall | undefined
    expect(deleteCall?.[0]).toContain('del /f')
  })
})
