import { PassThrough } from 'node:stream'

import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { createRoot } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import type { ExportFormat } from '../utils/exportFormats.js'

const setClipboard = mock(async (_content: string) => '')

mock.module('../ink/termio/osc.js', () => ({
  setClipboard,
}))

async function importExportDialog(): Promise<typeof import('./ExportDialog.js')> {
  return import(`./ExportDialog.js?dialog-test-${Date.now()}-${Math.random()}`) as Promise<
    typeof import('./ExportDialog.js')
  >
}

function createTestStreams() {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, getOutput: () => stripAnsi(output) }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for ExportDialog test state')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  setClipboard.mockClear()
})

afterAll(() => {
  mock.restore()
})

test('shows export format choices before export method choices', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async () => 'content'}
            onDone={() => {}}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    const output = getOutput()
    expect(output).toContain('Select export format:')
    expect(output).toContain('Plain Text (.txt)')
    expect(output).toContain('Markdown (.md)')
    expect(output).toContain('JSON (.json)')
    expect(output).not.toContain('Copy to clipboard')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('copies the selected format to the clipboard', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async format => {
              requestedFormats.push(format)
              return `${format} content`
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('JSON (.json)'))
    stdin.write('3')
    await waitForCondition(() => getOutput().includes('Copy to clipboard'))
    stdin.write('1')
    await waitForCondition(() => doneMessages.length === 1)

    expect(requestedFormats).toEqual(['json'])
    expect(setClipboard).toHaveBeenCalledWith('json content')
    expect(doneMessages[0]).toBe('Conversation copied to clipboard')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('uses the default format when confirming the format step', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="json"
            getContent={async format => {
              requestedFormats.push(format)
              return `${format} content`
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('JSON (.json)'))
    stdin.write('\r')
    await waitForCondition(() => getOutput().includes('Copy to clipboard'))
    stdin.write('1')
    await waitForCondition(() => doneMessages.length === 1)

    expect(requestedFormats).toEqual(['json'])
    expect(setClipboard).toHaveBeenCalledWith('json content')
    expect(doneMessages[0]).toBe('Conversation copied to clipboard')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('reports clipboard export failures through onDone', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async () => {
              throw new Error('render failed')
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    stdin.write('1')
    await waitForCondition(() => getOutput().includes('Copy to clipboard'))
    stdin.write('1')
    await waitForCondition(() => doneMessages.length === 1)

    expect(doneMessages[0]).toBe('Failed to copy conversation: render failed')
    expect(setClipboard).not.toHaveBeenCalled()
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('ignores repeated clipboard export input while content is rendering', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const content = deferred<string>()
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async format => {
              requestedFormats.push(format)
              return content.promise
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    stdin.write('1')
    await waitForCondition(() => getOutput().includes('Copy to clipboard'))
    stdin.write('1')
    await Bun.sleep(10)
    stdin.write('1')
    await waitForCondition(() => requestedFormats.length === 1)
    content.resolve('text content')
    await waitForCondition(() => doneMessages.length === 1)

    expect(requestedFormats).toEqual(['text'])
    expect(setClipboard).toHaveBeenCalledTimes(1)
    expect(doneMessages).toEqual(['Conversation copied to clipboard'])
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('saves the selected format to a normalized file path', async () => {
  const { ExportDialog } = await importExportDialog()
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-export-dialog-test-'))
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename={join(dir, 'conversation.txt')}
            defaultFormat="text"
            getContent={async format => {
              requestedFormats.push(format)
              return `${format} content`
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Markdown (.md)'))
    stdin.write('2')
    await waitForCondition(() => getOutput().includes('Save to file'))
    stdin.write('2')
    await waitForCondition(() => getOutput().includes('Enter filename:'))
    stdin.write('\r')
    await waitForCondition(() => doneMessages.length === 1)

    const outputPath = join(dir, 'conversation.md')
    expect(requestedFormats).toEqual(['markdown'])
    expect(await readFile(outputPath, 'utf8')).toBe('markdown content')
    expect(doneMessages[0]).toBe(`Conversation exported to: ${outputPath}`)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await rm(dir, { recursive: true, force: true })
    await Bun.sleep(0)
  }
})

test('uses the default format extension when saving to a file', async () => {
  const { ExportDialog } = await importExportDialog()
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-export-dialog-test-'))
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename={join(dir, 'conversation.txt')}
            defaultFormat="json"
            getContent={async format => {
              requestedFormats.push(format)
              return `${format} content`
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('JSON (.json)'))
    stdin.write('\r')
    await waitForCondition(() => getOutput().includes('Save to file'))
    stdin.write('2')
    await waitForCondition(() => getOutput().includes('Enter filename:'))
    stdin.write('\r')
    await waitForCondition(() => doneMessages.length === 1)

    const outputPath = join(dir, 'conversation.json')
    expect(requestedFormats).toEqual(['json'])
    expect(await readFile(outputPath, 'utf8')).toBe('json content')
    expect(doneMessages[0]).toBe(`Conversation exported to: ${outputPath}`)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await rm(dir, { recursive: true, force: true })
    await Bun.sleep(0)
  }
})

test('preserves .markdown filename extension when saving Markdown from the dialog', async () => {
  const { ExportDialog } = await importExportDialog()
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-export-dialog-test-'))
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename={join(dir, 'conversation.markdown')}
            defaultFormat="markdown"
            getContent={async () => 'markdown content'}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Markdown (.md)'))
    stdin.write('\r')
    await waitForCondition(() => getOutput().includes('Save to file'))
    stdin.write('2')
    await waitForCondition(() => getOutput().includes('Enter filename:'))
    stdin.write('\r')
    await waitForCondition(() => doneMessages.length === 1)

    const outputPath = join(dir, 'conversation.markdown')
    expect(await readFile(outputPath, 'utf8')).toBe('markdown content')
    expect(doneMessages[0]).toBe(`Conversation exported to: ${outputPath}`)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await rm(dir, { recursive: true, force: true })
    await Bun.sleep(0)
  }
})

test('ignores repeated file export submit while content is rendering', async () => {
  const { ExportDialog } = await importExportDialog()
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-export-dialog-test-'))
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const content = deferred<string>()
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename={join(dir, 'conversation.txt')}
            defaultFormat="text"
            getContent={async format => {
              requestedFormats.push(format)
              return content.promise
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    stdin.write('1')
    await waitForCondition(() => getOutput().includes('Save to file'))
    stdin.write('2')
    await waitForCondition(() => getOutput().includes('Enter filename:'))
    stdin.write('\r')
    await Bun.sleep(10)
    stdin.write('\r')
    await waitForCondition(() => requestedFormats.length === 1)
    content.resolve('text content')
    await waitForCondition(() => doneMessages.length === 1)

    const outputPath = join(dir, 'conversation.txt')
    expect(requestedFormats).toEqual(['text'])
    expect(await readFile(outputPath, 'utf8')).toBe('text content')
    expect(doneMessages).toEqual([`Conversation exported to: ${outputPath}`])
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await rm(dir, { recursive: true, force: true })
    await Bun.sleep(0)
  }
})

test('reports file export failures through onDone', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async () => {
              throw new Error('render failed')
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    stdin.write('1')
    await waitForCondition(() => getOutput().includes('Save to file'))
    stdin.write('2')
    await waitForCondition(() => getOutput().includes('Enter filename:'))
    stdin.write('\r')
    await waitForCondition(() => doneMessages.length === 1)

    expect(doneMessages[0]).toBe('Failed to export conversation: render failed')
    expect(setClipboard).not.toHaveBeenCalled()
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('Escape goes back from filename to method before exporting', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async format => {
              requestedFormats.push(format)
              return 'text content'
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    stdin.write('1')
    await waitForCondition(() => getOutput().includes('Save to file'))
    stdin.write('2')
    await waitForCondition(() => getOutput().includes('Enter filename:'))
    const beforeBack = getOutput().length
    stdin.write('\u001B')
    await waitForCondition(() => getOutput().slice(beforeBack).includes('Select export method:'))
    stdin.write('1')
    await waitForCondition(() => doneMessages.length === 1)

    expect(requestedFormats).toEqual(['text'])
    expect(doneMessages).toEqual(['Conversation copied to clipboard'])
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('Escape goes back from method to format before exporting', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const requestedFormats: ExportFormat[] = []
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async format => {
              requestedFormats.push(format)
              return `${format} content`
            }}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    stdin.write('1')
    await waitForCondition(() => getOutput().includes('Copy to clipboard'))
    const beforeBack = getOutput().length
    stdin.write('\u001B')
    await waitForCondition(() => getOutput().slice(beforeBack).includes('Select export format:'))
    const beforeFormat = getOutput().length
    stdin.write('3')
    await waitForCondition(() => getOutput().slice(beforeFormat).includes('Select export method:'))
    stdin.write('1')
    await waitForCondition(() => doneMessages.length === 1)

    expect(requestedFormats).toEqual(['json'])
    expect(doneMessages).toEqual(['Conversation copied to clipboard'])
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test('Escape at the format step cancels export once', async () => {
  const { ExportDialog } = await importExportDialog()
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const doneMessages: string[] = []

  try {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <ExportDialog
            defaultFilename="conversation.txt"
            defaultFormat="text"
            getContent={async () => 'content'}
            onDone={result => {
              doneMessages.push(result.message)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )

    await waitForCondition(() => getOutput().includes('Plain Text (.txt)'))
    stdin.write('\u001B')
    stdin.write('\u001B')
    await waitForCondition(() => doneMessages.length === 1)

    expect(doneMessages).toEqual(['Export cancelled'])
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})
