import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

const nonce = `${Date.now()}-${Math.random()}`
const actualExecFileNoThrow = {
  ...await import(`../../utils/execFileNoThrow.js?real=${nonce}`),
}

const originalEnv = { ...process.env }
const originalPlatform = process.platform
const mockedClipboardPath = join(process.cwd(), 'openclaude-clipboard.txt')

const generateTempFilePathMock = mock(() => mockedClipboardPath)

// Mirrors the execFileNoThrow/execFileNoThrowWithCwd signature so that
// recorded calls keep usable tuple types ([file, args, options]).
const execFileNoThrowMock = mock(
  async (
    _file: string,
    _args: string[],
    _options?: Record<string, unknown>,
  ) => ({ code: 0, stdout: '', stderr: '' }),
)

function installOscMocks(): void {
  mock.module('../../utils/execFileNoThrow.js', () => ({
    execFileNoThrow: execFileNoThrowMock,
    execFileNoThrowWithCwd: execFileNoThrowMock,
  }))

  mock.module('../../utils/tempfile.js', () => ({
    generateTempFilePath: generateTempFilePathMock,
  }))
}

async function importFreshOscModule() {
  return import(`./osc.ts?ts=${Date.now()}-${Math.random()}`)
}

async function flushClipboardCopy(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitForExecCall(
  command: string,
  attempts = 20,
): Promise<(typeof execFileNoThrowMock.mock.calls)[number] | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const call = execFileNoThrowMock.mock.calls.find(([cmd]) => cmd === command)
    if (call) {
      return call
    }
    await flushClipboardCopy()
  }

  return undefined
}

describe('Windows clipboard fallback', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('ink/termio/osc.test.ts')
    installOscMocks()
    execFileNoThrowMock.mockClear()
    generateTempFilePathMock.mockClear()
    process.env = { ...originalEnv }
    delete process.env['SSH_CONNECTION']
    delete process.env['TMUX']
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../utils/execFileNoThrow.js', () => actualExecFileNoThrow)
      process.env = { ...originalEnv }
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('uses PowerShell instead of clip.exe for local Windows copy', async () => {
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    const windowsCall = await waitForExecCall('powershell')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'clip')).toBe(
      false,
    )
    expect(windowsCall).toBeDefined()
  })

  test('passes Windows clipboard text through a UTF-8 temp file instead of stdin', async () => {
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    await flushClipboardCopy()

    const windowsCall = await waitForExecCall('powershell')

    expect(windowsCall?.[2]).toMatchObject({
      stdin: 'ignore',
    })
    expect(windowsCall?.[2]).not.toMatchObject({ input: 'Привет мир' })
    expect(windowsCall?.[2]).not.toMatchObject({
      env: expect.objectContaining({
        OPENCLAUDE_CLIPBOARD_TEXT_B64: expect.any(String),
      }),
    })
    expect(windowsCall?.[1]).toContain(
      `$text = [System.IO.File]::ReadAllText('${mockedClipboardPath.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8); Set-Clipboard -Value $text`,
    )
  })
})

describe('clipboard path behavior remains stable', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('ink/termio/osc.test.ts')
    installOscMocks()
    execFileNoThrowMock.mockClear()
    process.env = { ...originalEnv }
    delete process.env['SSH_CONNECTION']
    delete process.env['TMUX']
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../utils/execFileNoThrow.js', () => actualExecFileNoThrow)
      process.env = { ...originalEnv }
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('getClipboardPath stays native on local macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { getClipboardPath } = await importFreshOscModule()

    expect(getClipboardPath()).toBe('native')
  })

  test('getClipboardPath stays tmux-buffer when TMUX is set', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0'
    const { getClipboardPath } = await importFreshOscModule()

    expect(getClipboardPath()).toBe('tmux-buffer')
  })

  test('Windows clipboard fallback is skipped over SSH', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env['SSH_CONNECTION'] = '1 2 3 4'
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'powershell')).toBe(
      false,
    )
  })

  test('local macOS clipboard fallback still uses pbcopy', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('hello')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'pbcopy')).toBe(
      true,
    )
  })
})
