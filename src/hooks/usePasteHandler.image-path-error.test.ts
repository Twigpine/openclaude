import { PassThrough } from 'node:stream'
import { afterEach, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import {
  createRoot,
  type InputEvent,
  type Key,
} from '../ink.js'
import * as actualImagePasteModule from '../utils/imagePaste.js'

type PasteHandlerModule = typeof import('./usePasteHandler.js')
type PasteHandlerResult = ReturnType<PasteHandlerModule['usePasteHandler']>

const originalImagePasteExports = { ...actualImagePasteModule }

function restoreMocks(): void {
  mock.module('../utils/imagePaste.js', () => originalImagePasteExports)
}

async function importPasteHandler(): Promise<PasteHandlerModule> {
  return import(
    `./usePasteHandler.js?image-path-error=${Date.now()}-${Math.random()}`
  )
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2500,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('Timed out waiting for image-path paste state')
}

afterEach(async () => {
  await restoreMocks()
  mock.restore()
})

test('a rejected image-path read is consumed without dropping valid siblings', async () => {
  const readError = new Error('image resize failed')
  const tryReadImageFromPath = mock(async (imagePath: string) => {
    if (imagePath.endsWith('broken.png')) {
      throw readError
    }
    return {
      path: imagePath,
      base64: 'valid-image',
      mediaType: 'image/png',
    }
  })
  mock.module('../utils/imagePaste.js', () => ({
    ...actualImagePasteModule,
    tryReadImageFromPath,
  }))
  const { usePasteHandler } = await importPasteHandler()

  let handler: PasteHandlerResult | undefined
  const onImagePaste = mock(() => {})
  function Probe(): null {
    handler = usePasteHandler({
      onInput: () => {},
      onImagePaste,
    })
    return null
  }

  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })

  try {
    root.render(createElement(Probe))
    await waitFor(() => handler !== undefined)

    handler!.wrappedOnInput(
      '/tmp/broken.png /tmp/valid.png',
      {} as Key,
      { keypress: { isPasted: true } } as InputEvent,
    )

    await waitFor(() => handler?.isPasting === true)
    await waitFor(() => tryReadImageFromPath.mock.calls.length === 2)
    await waitFor(() => handler?.isPasting === false)
    expect(tryReadImageFromPath).toHaveBeenCalledWith('/tmp/broken.png')
    expect(tryReadImageFromPath).toHaveBeenCalledWith('/tmp/valid.png')
    expect(onImagePaste).toHaveBeenCalledWith(
      'valid-image',
      'image/png',
      'valid.png',
      undefined,
      '/tmp/valid.png',
    )
  } finally {
    root.unmount()
  }
})

test('a rejected sole image path is not inserted into the prompt as text', async () => {
  const tryReadImageFromPath = mock(async () => {
    throw new Error('image resize failed')
  })
  mock.module('../utils/imagePaste.js', () => ({
    ...actualImagePasteModule,
    tryReadImageFromPath,
  }))
  const { usePasteHandler } = await importPasteHandler()

  let handler: PasteHandlerResult | undefined
  const onPaste = mock(() => {})
  function Probe(): null {
    handler = usePasteHandler({
      onInput: () => {},
      onImagePaste: () => {},
      onPaste,
    })
    return null
  }

  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })

  try {
    root.render(createElement(Probe))
    await waitFor(() => handler !== undefined)

    handler!.wrappedOnInput(
      '/tmp/broken.png',
      {} as Key,
      { keypress: { isPasted: true } } as InputEvent,
    )

    await waitFor(() => handler?.isPasting === true)
    await waitFor(() => tryReadImageFromPath.mock.calls.length === 1)
    await waitFor(() => handler?.isPasting === false)
    expect(onPaste).not.toHaveBeenCalled()
  } finally {
    root.unmount()
  }
})
