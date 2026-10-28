import { expect, spyOn, test } from 'bun:test'
import chalk from 'chalk'
import { PassThrough } from 'node:stream'
import React from 'react'
import { Ansi, createRoot } from '../../ink.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getCliHighlightPromise } from '../../utils/cliHighlight.js'
import { HighlightedCodeFallback } from './Fallback.js'

test('remounting with colors disabled does not reuse colored highlights', async () => {
  await acquireSharedMutationLock('HighlightedCode/Fallback.test.tsx')
  const previousLevel = chalk.level
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const code = 'const cachedColorLevel = 42;'
  const renderAnsi = Ansi.type
  // Inspect the highlighted string before Ink can strip ANSI colors itself.
  const ansi = spyOn(Ansi, 'type').mockImplementation(props => renderAnsi(props))
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    expect(await getCliHighlightPromise()).not.toBeNull()
    chalk.level = 1
    const highlighted = Promise.withResolvers<void>()
    ansi.mockImplementation(props => {
      if (props.children.includes('\x1b')) highlighted.resolve()
      return renderAnsi(props)
    })
    root.render(<HighlightedCodeFallback key="colored" code={code} filePath="cache.ts" />)
    await Promise.race([
      highlighted.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Highlighting did not complete')), 2500)
      }),
    ])
    expect(ansi.mock.calls.at(-1)![0].children).toContain('\x1b')

    chalk.level = 0
    ansi.mockClear()
    root.render(<HighlightedCodeFallback key="plain" code={code} filePath="cache.ts" />)
    const output = ansi.mock.calls.at(-1)![0].children
    expect(output).toBe(code)
    expect(output).not.toContain('\x1b')
  } finally {
    clearTimeout(timer)
    root.unmount()
    ansi.mockRestore()
    stdout.end()
    stdin.end()
    chalk.level = previousLevel
    releaseSharedMutationLock()
  }
})
