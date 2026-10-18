import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createElement, useLayoutEffect } from 'react'

import { EventEmitter } from '../events/emitter.js'
import { InputEvent } from '../events/input-event.js'
import StdinContext, { type Props } from '../components/StdinContext.js'
import { createRoot, type Root } from '../root.js'
import useInput from './use-input.js'

// The hook reads its stdin handle from StdinContext, so we inject a fake
// context value instead of mocking the module. A module-level mock.module()
// would leak into every subsequent test file in the same `bun test` process
// (use-stdin would stay replaced), silently breaking input handling in
// unrelated component tests — so we deliberately avoid it here.
function createStdinContextValue(setRawMode: (value: boolean) => void): Props {
  return {
    stdin: process.stdin,
    setRawMode,
    isRawModeSupported: true,
    internal_exitOnCtrlC: false,
    internal_eventEmitter: new EventEmitter(),
    internal_querier: null,
  }
}

function createTestStdout(): NodeJS.WriteStream {
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  return stdout as unknown as NodeJS.WriteStream
}

// A probe that mounts the hook under test, with isActive driven by props so we
// can exercise the mount / re-render / unmount transitions.
function Probe({ isActive }: { isActive?: boolean }): null {
  useInput(() => {}, { isActive })
  return null
}

// Renders the probe inside an injected StdinContext so the hook's setRawMode
// calls land on our spy. The deferred raw-mode reset uses a real setTimeout(0),
// so tests await `tick()` to let it fire rather than using fake timers.
async function renderProbe(
  setRawMode: (value: boolean) => void,
  initial: { isActive?: boolean } = {},
): Promise<{
  rerender: (props: { isActive?: boolean }) => void
  unmount: () => void
}> {
  const stdout = createTestStdout()
  const root: Root = await createRoot({ stdout, patchConsole: false })
  const contextValue = createStdinContextValue(setRawMode)

  const draw = (props: { isActive?: boolean }) =>
    root.render(
      createElement(
        StdinContext.Provider,
        { value: contextValue },
        createElement(Probe, props),
      ),
    )

  draw(initial)

  return {
    rerender: draw,
    unmount: () => root.unmount(),
  }
}

function tick(): Promise<void> {
  return Bun.sleep(5)
}

test('input callbacks and active state are current during the committed layout', async () => {
  const contextValue = createStdinContextValue(() => {})
  const root = await createRoot({ stdout: createTestStdout(), patchConsole: false })
  const received: string[] = []
  /** Build a fresh printable key event for each committed render. */
  const event = () => new InputEvent({
    kind: 'key', raw: 'x', isPasted: false,
    name: 'x', sequence: 'x', ctrl: false, meta: false, shift: false,
    option: false, fn: false, super: false,
  })
  /** Dispatch input during layout to verify the current handler and active state. */
  function InputProbe({ label, active }: { label: string; active: boolean }) {
    useInput(() => received.push(label), { isActive: active })
    useLayoutEffect(() => {
      contextValue.internal_eventEmitter.emit('input', event())
    }, [label, active])
    return null
  }
  /** Commit the probe with the requested handler label and activation state. */
  const draw = (label: string, active: boolean) => root.render(
    createElement(StdinContext.Provider, { value: contextValue },
      createElement(InputProbe, { label, active })),
  )
  try {
    draw('first', true)
    draw('inactive', false)
    draw('latest', true)
    expect(received).toEqual(['first', 'latest'])
  } finally {
    root.unmount()
  }
})

describe('useInput — raw mode lifecycle', () => {
  let setRawMode: ReturnType<typeof mock>

  beforeEach(() => {
    setRawMode = mock((_value: boolean) => {})
  })

  afterEach(() => {
    mock.restore()
  })

  test('enables raw mode on mount when isActive is true (default)', async () => {
    const probe = await renderProbe(setRawMode)
    try {
      expect(setRawMode).toHaveBeenCalledWith(true)
    } finally {
      probe.unmount()
    }
  })

  test('does NOT enable raw mode when isActive is false', async () => {
    const probe = await renderProbe(setRawMode, { isActive: false })
    try {
      expect(setRawMode).not.toHaveBeenCalled()
    } finally {
      probe.unmount()
    }
  })

  test('defers setRawMode(false) on unmount — fires after one tick', async () => {
    const probe = await renderProbe(setRawMode)

    probe.unmount()

    // Immediately after unmount, setRawMode(false) has NOT yet fired.
    expect(setRawMode).toHaveBeenCalledTimes(1) // only the initial true
    expect(setRawMode).toHaveBeenCalledWith(true)

    // Let the deferred reset fire.
    await tick()

    expect(setRawMode).toHaveBeenCalledTimes(2)
    expect(setRawMode).toHaveBeenLastCalledWith(false)
  })

  test('cancels deferred reset on isActive false→true transition (MCP re-render churn)', async () => {
    const probe = await renderProbe(setRawMode, { isActive: true })

    expect(setRawMode).toHaveBeenCalledTimes(1)
    expect(setRawMode).toHaveBeenCalledWith(true)

    // Toggle to inactive — effect cleanup schedules the deferred reset.
    probe.rerender({ isActive: false })

    // Cleanup ran: timer scheduled but hasn't fired yet.
    expect(setRawMode).toHaveBeenCalledTimes(1)

    // Toggle back to active before the timer fires — setup cancels the pending
    // reset and does NOT call setRawMode(true) again, because the counter was
    // never decremented by the deferred reset.
    probe.rerender({ isActive: true })

    expect(setRawMode).toHaveBeenCalledTimes(1)
    expect(setRawMode).toHaveBeenLastCalledWith(true)

    // The cancelled reset must not fire.
    await tick()
    expect(setRawMode).toHaveBeenCalledTimes(1)

    // Final unmount fires the deferred reset.
    probe.unmount()
    await tick()

    expect(setRawMode).toHaveBeenCalledTimes(2)
    expect(setRawMode).toHaveBeenLastCalledWith(false)
  })

  test('handles isActive true → false transition: disables raw mode', async () => {
    const probe = await renderProbe(setRawMode, { isActive: true })

    expect(setRawMode).toHaveBeenCalledWith(true)

    // Transition to inactive — the cleanup from the isActive=true run schedules
    // a deferred reset.
    probe.rerender({ isActive: false })
    await tick()

    expect(setRawMode).toHaveBeenLastCalledWith(false)

    probe.unmount()
  })
})
