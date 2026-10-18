import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createElement, useLayoutEffect } from 'react'
import { createRoot } from '../../ink/root.js'
import { useSelectNavigation } from './use-select-navigation.js'

test('publishes the committed focus before subsequent layout actions', async () => {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  stdout.columns = 80
  const root = await createRoot({ stdout, patchConsole: false })
  let published: string | undefined
  const observed: Array<[string | undefined, string | undefined]> = []
  /** Observe focus state and its published callback value in the same layout commit. */
  function Probe({ value }: { value: string }) {
    const navigation = useSelectNavigation({
      options: [{ value, label: value }],
      onFocus: focus => { published = focus },
    })
    useLayoutEffect(() => {
      observed.push([navigation.focusedValue, published])
    }, [navigation.focusedValue])
    return null
  }
  try {
    root.render(createElement(Probe, { value: 'alpha' }))
    root.render(createElement(Probe, { value: 'beta' }))
    expect(observed).toEqual([['alpha', 'alpha'], ['beta', 'beta']])
  } finally {
    root.unmount()
  }
})
