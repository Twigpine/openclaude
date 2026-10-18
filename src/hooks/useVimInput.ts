import { stripVTControlCharacters as stripAnsi } from 'node:util'
import React, { useCallback, useState } from 'react'
import { isInputModeCharacter } from '../components/PromptInput/inputModes.js'
import type { Key } from '../ink.js'
import type { VimInputState, VimMode } from '../types/textInputTypes.js'
import { Cursor } from '../utils/Cursor.js'
import { lastGrapheme } from '../utils/intl.js'
import {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeX,
  type OperatorContext,
} from '../vim/operators.js'
import { type TransitionContext, transition } from '../vim/transitions.js'
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type RecordedChange,
  type VimState,
} from '../vim/types.js'
import {
  applyCoalescedDelInput,
  applyPrintableInput,
  prepareTextInputEvent,
  type UseTextInputProps,
  useTextInput,
} from './useTextInput.js'

type UseVimInputProps = Omit<UseTextInputProps, 'inputFilter'> & {
  onModeChange?: (mode: VimMode) => void
  onUndo?: () => void
  inputFilter?: UseTextInputProps['inputFilter']
}

export function useVimInput(props: UseVimInputProps): VimInputState {
  const vimStateRef = React.useRef<VimState>(createInitialVimState())
  const [mode, setMode] = useState<VimMode>('INSERT')

  const persistentRef = React.useRef<PersistentState>(
    createInitialPersistentState(),
  )

  // inputFilter is applied once at the top of handleVimInput (not here) so
  // vim-handled paths that return without calling textInput.onInput still
  // run the filter — otherwise a stateful filter (e.g. lazy-space-after-
  // pill) stays armed across an Escape → NORMAL → INSERT round-trip.
  const textInput = useTextInput({ ...props, inputFilter: undefined })
  const { onModeChange, inputFilter } = props

  const switchToInsertMode = useCallback(
    (offset?: number): void => {
      if (offset !== undefined) {
        textInput.setOffset(offset)
      }
      vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      setMode('INSERT')
      onModeChange?.('INSERT')
    },
    [textInput, onModeChange],
  )

  const switchToNormalMode = useCallback((): void => {
    const current = vimStateRef.current
    if (current.mode === 'INSERT' && current.insertedText) {
      persistentRef.current.lastChange = {
        type: 'insert',
        text: current.insertedText,
      }
    }

    // Vim behavior: move cursor left by 1 when exiting insert mode
    // (unless at beginning of line or at offset 0)
    const cursor = textInput.getCursor()
    if (cursor.offset > 0 && cursor.text[cursor.offset - 1] !== '\n') {
      textInput.setOffset(cursor.offset - 1)
    }

    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    onModeChange?.('NORMAL')
  }, [onModeChange, textInput])

  function createOperatorContext(
    cursor: Cursor,
    isReplay: boolean = false,
  ): OperatorContext {
    return {
      cursor,
      text: cursor.text,
      setText: (newText: string) => textInput.setValue(newText),
      setOffset: (offset: number) => textInput.setOffset(offset),
      enterInsert: (offset: number) => switchToInsertMode(offset),
      getRegister: () => persistentRef.current.register,
      setRegister: (content: string, linewise: boolean) => {
        persistentRef.current.register = content
        persistentRef.current.registerIsLinewise = linewise
      },
      getLastFind: () => persistentRef.current.lastFind,
      setLastFind: (type, char) => {
        persistentRef.current.lastFind = { type, char }
      },
      recordChange: isReplay
        ? () => {}
        : (change: RecordedChange) => {
            persistentRef.current.lastChange = change
          },
    }
  }

  function replayLastChange(): void {
    const change = persistentRef.current.lastChange
    if (!change) return

    const cursor = textInput.getCursor()
    const ctx = createOperatorContext(cursor, true)

    switch (change.type) {
      case 'insert':
        if (change.text) {
          const newCursor = cursor.insert(change.text)
          textInput.setValue(newCursor.text, newCursor.offset)
        }
        break

      case 'x':
        executeX(change.count, ctx)
        break

      case 'replace':
        executeReplace(change.char, change.count, ctx)
        break

      case 'toggleCase':
        executeToggleCase(change.count, ctx)
        break

      case 'indent':
        executeIndent(change.dir, change.count, ctx)
        break

      case 'join':
        executeJoin(change.count, ctx)
        break

      case 'openLine':
        executeOpenLine(change.direction, ctx)
        break

      case 'operator':
        executeOperatorMotion(change.op, change.motion, change.count, ctx)
        break

      case 'operatorFind':
        executeOperatorFind(
          change.op,
          change.find,
          change.char,
          change.count,
          ctx,
        )
        break

      case 'operatorTextObj':
        executeOperatorTextObj(
          change.op,
          change.scope,
          change.objType,
          change.count,
          ctx,
        )
        break
    }
  }

  function handleVimInput(rawInput: string, key: Key): void {
    const state = vimStateRef.current
    // Run inputFilter in all modes so stateful filters disarm on any key,
    // but only apply the transformed input in INSERT — NORMAL-mode command
    // lookups expect single chars and a prepended space would break them.
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
    const input = state.mode === 'INSERT' ? filtered : rawInput
    const cursor = textInput.getCursor()

    if (key.ctrl) {
      textInput.onInput(input, key)
      return
    }

    // NOTE(keybindings): This escape handler is intentionally NOT migrated to the keybindings system.
    // It's vim's standard INSERT->NORMAL mode switch - a vim-specific behavior that should not be
    // configurable via keybindings. Vim users expect Esc to always exit INSERT mode.
    if (key.escape && state.mode === 'INSERT') {
      switchToNormalMode()
      return
    }

    // Escape in NORMAL mode cancels any pending command (replace, operator, etc.)
    if (key.escape && state.mode === 'NORMAL') {
      vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      return
    }

    // Pass Enter to base handler regardless of mode (allows submission from NORMAL)
    if (key.return) {
      textInput.onInput(input, key)
      return
    }

    if (state.mode === 'INSERT') {
      // Track inserted text for dot-repeat
      if (key.backspace || key.delete) {
        if (state.insertedText.length > 0) {
          vimStateRef.current = {
            mode: 'INSERT',
            insertedText: state.insertedText.slice(
              0,
              -(lastGrapheme(state.insertedText).length || 1),
            ),
          }
        }
      } else if (input.includes('\x7f')) {
        const preparedInput = prepareTextInputEvent(input)
        let insertedTextCursor = Cursor.fromText(
          state.insertedText,
          props.columns,
          state.insertedText.length,
        )
        let recordedModeEntry = false
        applyCoalescedDelInput(
          cursor,
          preparedInput.input,
          (visibleCursor, text) => {
            const visibleResult = applyPrintableInput(visibleCursor, text, {
              modeCharacterIsText: preparedInput.shouldSubmit,
            })
            if (
              visibleResult &&
              visibleResult.text !== visibleCursor.text
            ) {
              const modeCharacter = visibleResult.text[0]
              const isModeEntry =
                !recordedModeEntry &&
                visibleCursor.text.length === 0 &&
                visibleCursor.isAtStart() &&
                modeCharacter !== undefined &&
                isInputModeCharacter(modeCharacter)
              recordedModeEntry ||= isModeEntry
              const recordedText = isModeEntry
                ? visibleResult.text.slice(modeCharacter.length)
                : text
              insertedTextCursor =
                applyPrintableInput(insertedTextCursor, recordedText, {
                  modeCharacterIsText: true,
                }) ?? insertedTextCursor
            }
            return visibleResult
          },
          count => {
            insertedTextCursor = insertedTextCursor.deleteManyBefore(count)
          },
        )
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: insertedTextCursor.text,
        }
      } else {
        const visibleInput = stripAnsi(input)
        const modeCharacter = visibleInput[0]
        const recordedInput =
          cursor.text.length === 0 &&
          cursor.isAtStart() &&
          modeCharacter !== undefined &&
          isInputModeCharacter(modeCharacter)
            ? visibleInput.slice(modeCharacter.length)
            : input
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: state.insertedText + recordedInput,
        }
      }
      textInput.onInput(input, key)
      return
    }

    if (state.mode !== 'NORMAL') {
      return
    }

    // In idle state, delegate arrow keys to base handler for cursor movement
    // and history fallback (upOrHistoryUp / downOrHistoryDown)
    if (
      state.command.type === 'idle' &&
      (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
    ) {
      textInput.onInput(input, key)
      return
    }

    const ctx: TransitionContext = {
      ...createOperatorContext(cursor, false),
      onUndo: props.onUndo,
      onDotRepeat: replayLastChange,
    }

    // Backspace/Delete are only mapped in motion-expecting states. In
    // literal-char states (replace, find, operatorFind), mapping would turn
    // r+Backspace into "replace with h" and df+Delete into "delete to next x".
    // Delete additionally skips count state: in vim, N<Del> removes a count
    // digit rather than executing Nx; we don't implement digit removal but
    // should at least not turn a cancel into a destructive Nx.
    const expectsMotion =
      state.command.type === 'idle' ||
      state.command.type === 'count' ||
      state.command.type === 'operator' ||
      state.command.type === 'operatorCount'

    // Map arrow keys to vim motions in NORMAL mode
    let vimInput = input
    if (key.leftArrow) vimInput = 'h'
    else if (key.rightArrow) vimInput = 'l'
    else if (key.upArrow) vimInput = 'k'
    else if (key.downArrow) vimInput = 'j'
    else if (expectsMotion && key.backspace) vimInput = 'h'
    else if (expectsMotion && state.command.type !== 'count' && key.delete)
      vimInput = 'x'

    const result = transition(state.command, vimInput, ctx)

    if (result.execute) {
      result.execute()
    }

    // Update command state (only if execute didn't switch to INSERT)
    if (vimStateRef.current.mode === 'NORMAL') {
      if (result.next) {
        vimStateRef.current = { mode: 'NORMAL', command: result.next }
      } else if (result.execute) {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
    }

    if (
      input === '?' &&
      state.mode === 'NORMAL' &&
      state.command.type === 'idle'
    ) {
      props.onChange('?')
    }
  }

  const setModeExternal = useCallback(
    (newMode: VimMode) => {
      if (newMode === 'INSERT') {
        vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      } else {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
      setMode(newMode)
      onModeChange?.(newMode)
    },
    [onModeChange],
  )

  return {
    ...textInput,
    onInput: handleVimInput,
    mode,
    setMode: setModeExternal,
  }
}
