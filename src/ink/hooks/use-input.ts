import { useCallback, useLayoutEffect, useRef } from 'react'
import type { InputEvent, Key } from '../events/input-event.js'
import useStdin from './use-stdin.js'

type Handler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  /**
   * Enable or disable capturing of user input.
   * Useful when there are multiple useInput hooks used at once to avoid handling the same input several times.
   *
   * @default true
   */
  isActive?: boolean
}

/**
 * This hook is used for handling user input.
 * It's a more convenient alternative to using `StdinContext` and listening to `data` events.
 * The callback you pass to `useInput` is called for each character when user enters any input.
 * However, if user pastes text and it's more than one character, the callback will be called only once and the whole string will be passed as `input`.
 *
 * ```
 * import {useInput} from 'ink';
 *
 * const UserInput = () => {
 *   useInput((input, key) => {
 *     if (input === 'q') {
 *       // Exit program
 *     }
 *
 *     if (key.leftArrow) {
 *       // Left arrow key pressed
 *     }
 *   });
 *
 *   return …
 * };
 * ```
 */
const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()
  const handlerRef = useRef({ inputHandler, isActive: options.isActive, internal_exitOnCtrlC })
  // Isomorphic browser hooks use passive effects in Node. Input must see the
  // committed handler before another terminal event can arrive.
  useLayoutEffect(() => {
    handlerRef.current = { inputHandler, isActive: options.isActive, internal_exitOnCtrlC }
  }, [inputHandler, options.isActive, internal_exitOnCtrlC])

  // Timer handle for the deferred raw-mode reset. Persists across renders
  // so the setup phase of a remount can cancel a pending reset from cleanup.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // useLayoutEffect (not useEffect) so that raw mode is enabled synchronously
  // during React's commit phase, before render() returns. With useEffect, raw
  // mode setup is deferred to the next event loop tick via React's scheduler,
  // leaving the terminal in cooked mode — keystrokes echo and the cursor is
  // visible until the effect fires.
  useLayoutEffect(() => {
    if (options.isActive === false) {
      return
    }

    // If a prior cleanup scheduled a deferred reset (MCP re-render churn),
    // cancel it and skip setRawMode(true). The counter was never decremented
    // — the reset was deferred via setTimeout and aborted before it fired —
    // so calling setRawMode(true) again would over-increment the counter
    // and leak raw mode on final unmount.
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    } else {
      setRawMode(true)
    }

    return () => {
      // Defer the raw-mode reset by one macrotask instead of calling it
      // synchronously. During MCP async re-render churn the component
      // unmounts and remounts within a single React commit — the remount's
      // setup clears this timer before it fires, so raw mode is never
      // actually disabled and the stdin listener stays registered.
      //
      // For a genuine unmount (navigation, isActive→false, process exit)
      // no remount cancels the timer, so it fires on the next tick and
      // properly restores cooked mode.
      resetTimerRef.current = setTimeout(() => {
        setRawMode(false)
        resetTimerRef.current = null
      }, 0)
    }
  }, [options.isActive, setRawMode])

  // Register the listener once on mount so its slot in the EventEmitter's
  // listener array is stable. If isActive were in the effect's deps, the
  // listener would re-append on false→true, moving it behind listeners
  // that registered while it was inactive — breaking
  // stopImmediatePropagation() ordering. The stable callback reads the handler
  // and active state published by the layout effect above.
  //
  // Use useLayoutEffect (not useEffect) so the handler is registered
  // synchronously during the commit phase, before any stdin data can be
  // processed. In data mode, stdin.write() fires handleDataChunk
  // synchronously, which calls processInput → discreteUpdates → emit('input').
  // If the handler were in useEffect (passive effect, fires asynchronously
  // after the scheduler flushes), there's a window where stdin has a
  // listener but the EventEmitter has no handlers — keys are silently
  // dropped. This is safe because EventEmitter listener registration is
  // synchronous, lightweight, and has no visual side effects.
  const handleData = useCallback((event: InputEvent) => {
    const latest = handlerRef.current
    if (latest.isActive === false) {
      return
    }
    const { input, key } = event

    // If app is not supposed to exit on Ctrl+C, then let input listener handle it
    // Note: discreteUpdates is called at the App level when emitting events,
    // so all listeners are already within a high-priority update context.
    if (!(input === 'c' && key.ctrl) || !latest.internal_exitOnCtrlC) {
      latest.inputHandler(input, key, event)
    }
  }, [])

  useLayoutEffect(() => {
    internal_eventEmitter?.on('input', handleData)

    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])
}

export default useInput

