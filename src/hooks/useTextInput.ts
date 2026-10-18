import { useLayoutEffect, useRef, useState } from 'react'
import { isInputModeCharacter } from 'src/components/PromptInput/inputModes.js'
import { useNotifications } from 'src/context/notifications.js'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import { markBackslashReturnUsed } from '../commands/terminalSetup/terminalSetup.js'
import { addToHistory } from '../history.js'
import type { Key } from '../ink.js'
import type {
  InlineGhostText,
  TextInputChangeContext,
  TextInputState,
} from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import { isModifierPressed, prewarmModifiers } from '../utils/modifiers.js'
import { useDoublePress } from './useDoublePress.js'

type MaybeCursor = void | Cursor
type InputHandler = (input: string) => MaybeCursor
type InputMapper = (input: string) => MaybeCursor
const NOOP_HANDLER: InputHandler = () => {}
function mapInput(input_map: Array<[string, InputHandler]>): InputMapper {
  const map = new Map(input_map)
  return function (input: string): MaybeCursor {
    return (map.get(input) ?? NOOP_HANDLER)(input)
  }
}

// Any Unicode combining mark (general category M) — covers Vietnamese
// tone/breath marks plus marks outside the U+0300-U+036F block (Hebrew
// points, Devanagari matras, ...) when an IME emits NFD instead of
// precomposed forms.
const COMBINING_MARK_RE = /^\p{M}/u

export type ComposedTextEdit = {
  text: string
  offset: number
}

/**
 * Compose a standalone combining mark (NFD input) onto the character before
 * the cursor. Returns null when the input is not a combining mark or there
 * is nothing to compose with (#2018).
 */
export function composeCombiningMark(
  text: string,
  offset: number,
  input: string,
): ComposedTextEdit | null {
  if (!COMBINING_MARK_RE.test(input) || offset <= 0 || offset > text.length) {
    return null
  }
  const newBefore = (text.slice(0, offset) + input).normalize('NFC')
  return {
    text: newBefore + text.slice(offset),
    offset: newBefore.length,
  }
}

/**
 * Telex/VNI compose pattern: some IMEs/terminals deliver composition as a
 * backspace-flagged event carrying the precomposed replacement character.
 * Replace the previous character instead of treating the pair as delete
 * plus literal insert. Returns null when the input is not a printable
 * non-ASCII replacement (#2018).
 */
export function replacePreviousWithChar(
  text: string,
  offset: number,
  input: string,
): ComposedTextEdit | null {
  if (
    input.length !== 1 ||
    (input.codePointAt(0) ?? 0) <= 127 ||
    offset <= 0 ||
    offset > text.length
  ) {
    return null
  }
  const newBefore = text.slice(0, offset - 1) + input
  return {
    text: (newBefore + text.slice(offset)).normalize('NFC'),
    offset: newBefore.normalize('NFC').length,
  }
}

export function prepareTextInputEvent(input: string): {
  input: string
  shouldSubmit: boolean
} {
  // SSH-coalesced Enter: on slow links, "o" + Enter can arrive as one
  // chunk "o\r". Text with exactly one trailing \r is coalesced Enter;
  // lone \r is Alt+Enter (newline), embedded \r is multi-line paste, and
  // backslash+CR is a stale VS Code Shift+Enter binding.
  const visibleInput = stripAnsi(input)
  const shouldSubmit =
    input.endsWith('\r') &&
    visibleInput.length > 1 &&
    !visibleInput.slice(0, -1).includes('\r') &&
    visibleInput[visibleInput.length - 2] !== '\\'
  const shouldStripTrailingCr =
    visibleInput.endsWith('\r') &&
    visibleInput.length > 1 &&
    !['\\', '\r', '\n'].includes(visibleInput[visibleInput.length - 2]!)
  const editableInput = shouldStripTrailingCr
    ? input.endsWith('\r')
      ? input.slice(0, -1)
      : visibleInput.slice(0, -1)
    : input

  return {
    input: editableInput.replace(/\r/g, '\n'),
    shouldSubmit,
  }
}

type ApplyPrintableInputOptions = {
  modeCharacterIsText?: boolean
  onModeCharacter?: (text: string, context: TextInputChangeContext) => void
}

export function applyPrintableInput(
  cursor: Cursor,
  input: string,
  options: ApplyPrintableInputOptions = {},
): MaybeCursor {
  if (input === '\x1b[H' || input === '\x1b[1~') {
    return cursor.startOfLine()
  }
  if (input === '\x1b[F' || input === '\x1b[4~') {
    return cursor.endOfLine()
  }

  // Normalize to NFC so decomposed IME input composes into exactly what
  // the cursor's MeasuredText stores, keeping returned offsets aligned
  // when normalization shrinks code-unit length (#2018).
  const text = stripAnsi(input).normalize('NFC')
  if (
    !options.modeCharacterIsText &&
    cursor.text.length === 0 &&
    cursor.isAtStart() &&
    isInputModeCharacter(text)
  ) {
    options.onModeCharacter?.(text, {
      previousValue: cursor.text,
      cursorOffset: cursor.offset,
    })
    return undefined
  }

  return cursor.insert(text)
}

export function applyCoalescedDelInput(
  cursor: Cursor,
  input: string,
  insert: (cursor: Cursor, text: string) => MaybeCursor,
  onDelete?: (count: number, before: Cursor, after: Cursor) => void,
): { cursor: Cursor; shouldCommit: boolean } {
  let nextCursor = cursor
  let segmentStart = 0
  let shouldCommit = true

  for (let index = 0; index < input.length; index++) {
    // Both DEL bytes arrive from IMEs/terminals: \x7f is the common
    // backspace, \b (Ctrl-H) is emitted by some Vietnamese IME setups.
    if (input[index] !== '\x7f' && input[index] !== '\b') continue

    if (index > segmentStart) {
      const insertedCursor = insert(
        nextCursor,
        input.slice(segmentStart, index),
      )
      if (insertedCursor) {
        nextCursor = insertedCursor
        shouldCommit = true
      } else {
        shouldCommit = false
      }
    }

    let delEnd = index + 1
    while (
      delEnd < input.length &&
      (input[delEnd] === '\x7f' || input[delEnd] === '\b')
    ) {
      delEnd++
    }
    const delCount = delEnd - index
    const beforeDelete = nextCursor
    nextCursor = nextCursor.deleteManyBefore(delCount)
    onDelete?.(delCount, beforeDelete, nextCursor)
    shouldCommit = true
    segmentStart = delEnd
    index = delEnd - 1
  }

  if (segmentStart < input.length) {
    const insertedCursor = insert(nextCursor, input.slice(segmentStart))
    if (insertedCursor) {
      nextCursor = insertedCursor
      shouldCommit = true
    } else {
      shouldCommit = false
    }
  }

  return { cursor: nextCursor, shouldCommit }
}

export type UseTextInputProps = {
  value: string
  onChange: (value: string, context?: TextInputChangeContext) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  focus?: boolean
  mask?: string
  multiline?: boolean
  cursorChar: string
  highlightPastedText?: boolean
  invert: (text: string) => string
  themeText: (text: string) => string
  columns: number
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  maxVisibleLines?: number
  externalOffset: number
  onOffsetChange: (offset: number) => void
  inputFilter?: (input: string, key: Key) => string
  inlineGhostText?: InlineGhostText
  dim?: (text: string) => string
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  onClearInput,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  onImagePaste: _onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  disableEscapeDoublePress = false,
  maxVisibleLines,
  externalOffset,
  onOffsetChange,
  inputFilter,
  inlineGhostText,
  dim,
}: UseTextInputProps): TextInputState {
  // Pre-warm the modifiers module for Apple Terminal (has internal guard, safe to call multiple times)
  if (env.terminal === 'Apple_Terminal') {
    prewarmModifiers()
  }

  // Keep a local text/cursor mirror so consecutive keystrokes can advance
  // immediately even if the controlled parent value hasn't committed yet.
  const [renderState, setRenderState] = useState(() => ({
    value: originalValue,
    offset: externalOffset,
  }))
  const liveValueRef = useRef(originalValue)
  const liveOffsetRef = useRef(externalOffset)
  const lastSeenPropsRef = useRef({
    value: originalValue,
    offset: externalOffset,
  })
  const updateRenderedInput = (nextValue: string, nextOffset: number): void => {
    liveValueRef.current = nextValue
    liveOffsetRef.current = nextOffset
    setRenderState(prev =>
      prev.value === nextValue && prev.offset === nextOffset
        ? prev
        : { value: nextValue, offset: nextOffset },
    )
  }
  useLayoutEffect(() => {
    if (
      lastSeenPropsRef.current.value === originalValue &&
      lastSeenPropsRef.current.offset === externalOffset
    ) {
      return
    }

    lastSeenPropsRef.current = {
      value: originalValue,
      offset: externalOffset,
    }
    updateRenderedInput(originalValue, externalOffset)
  }, [originalValue, externalOffset])

  const value = renderState.value
  const offset = renderState.offset
  const getLiveValue = (): string => liveValueRef.current
  const getLiveCursor = (): Cursor =>
    Cursor.fromText(liveValueRef.current, columns, liveOffsetRef.current)
  const commitValue = (
    nextValue: string,
    nextOffset = liveOffsetRef.current,
    changeContext?: TextInputChangeContext,
  ): void => {
    const previousValue = liveValueRef.current
    const previousOffset = liveOffsetRef.current

    if (previousValue === nextValue && previousOffset === nextOffset) {
      return
    }

    updateRenderedInput(nextValue, nextOffset)

    if (previousOffset !== nextOffset) {
      onOffsetChange(nextOffset)
    }

    if (previousValue !== nextValue) {
      onChange(nextValue, changeContext)
    }
  }
  const setValue = (nextValue: string, nextOffset = liveOffsetRef.current): void => {
    commitValue(nextValue, nextOffset)
  }
  const setOffset = (nextOffset: number): void => {
    if (nextOffset === liveOffsetRef.current) {
      return
    }

    updateRenderedInput(liveValueRef.current, nextOffset)
    onOffsetChange(nextOffset)
  }
  const cursor = Cursor.fromText(value, columns, offset)
  const { addNotification, removeNotification } = useNotifications()

  const handleCtrlC = useDoublePress(
    show => {
      onExitMessage?.(show, 'Ctrl-C')
    },
    () => onExit?.(),
    () => {
      const currentValue = getLiveValue()
      if (currentValue) {
        updateRenderedInput('', 0)
        onChange('')
        onOffsetChange(0)
        onHistoryReset?.()
      }
    },
  )

  // NOTE(keybindings): This escape handler is intentionally NOT migrated to the keybindings system.
  // It's a text-level double-press escape for clearing input, not an action-level keybinding.
  // Double-press Esc clears the input and saves to history - this is text editing behavior,
  // not dialog dismissal, and needs the double-press safety mechanism.
  const handleEscape = useDoublePress(
    (show: boolean) => {
      const currentValue = getLiveValue()
      if (!currentValue || !show) {
        return
      }
      addNotification({
        key: 'escape-again-to-clear',
        text: 'Esc again to clear',
        priority: 'immediate',
        timeoutMs: 1000,
      })
    },
    () => {
      const currentValue = getLiveValue()
      // Remove the "Esc again to clear" notification immediately
      removeNotification('escape-again-to-clear')
      onClearInput?.()
      if (currentValue) {
        // Track double-escape usage for feature discovery
        // Save to history before clearing
        if (currentValue.trim() !== '') {
          addToHistory(currentValue)
        }
        updateRenderedInput('', 0)
        onChange('')
        onOffsetChange(0)
        onHistoryReset?.()
      }
    },
  )

  const handleEmptyCtrlD = useDoublePress(
    show => {
      if (getLiveValue() !== '') {
        return
      }
      onExitMessage?.(show, 'Ctrl-D')
    },
    () => {
      if (getLiveValue() !== '') {
        return
      }
      onExit?.()
    },
  )

  function handleCtrlD(): MaybeCursor {
    const cursor = getLiveCursor()
    if (cursor.text === '') {
      // When input is empty, handle double-press
      handleEmptyCtrlD()
      return cursor
    }
    // When input is not empty, delete forward like iPython
    return cursor.del()
  }

  function killToLineEnd(): Cursor {
    const cursor = getLiveCursor()
    const { cursor: newCursor, killed } = cursor.deleteToLineEnd()
    pushToKillRing(killed, 'append')
    return newCursor
  }

  function killToLineStart(): Cursor {
    const cursor = getLiveCursor()
    const { cursor: newCursor, killed } = cursor.deleteToLineStart()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function killWordBefore(): Cursor {
    const cursor = getLiveCursor()
    const { cursor: newCursor, killed } = cursor.deleteWordBefore()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function yank(): Cursor {
    const cursor = getLiveCursor()
    const text = getLastKill()
    if (text.length > 0) {
      const startOffset = cursor.offset
      const newCursor = cursor.insert(text)
      recordYank(startOffset, text.length)
      return newCursor
    }
    return cursor
  }

  function handleYankPop(): Cursor {
    const cursor = getLiveCursor()
    const popResult = yankPop()
    if (!popResult) {
      return cursor
    }
    const { text, start, length } = popResult
    // Replace the previously yanked text with the new one
    const before = cursor.text.slice(0, start)
    const after = cursor.text.slice(start + length)
    const newText = before + text + after
    const newOffset = start + text.length
    updateYankLength(text.length)
    return Cursor.fromText(newText, columns, newOffset)
  }

  const handleCtrl = mapInput([
    ['a', () => getLiveCursor().startOfLine()],
    ['b', () => getLiveCursor().left()],
    ['c', handleCtrlC],
    ['d', handleCtrlD],
    ['e', () => getLiveCursor().endOfLine()],
    ['f', () => getLiveCursor().right()],
    ['h', () => {
      const cursor = getLiveCursor()
      return cursor.deleteTokenBefore() ?? cursor.backspace()
    }],
    ['k', killToLineEnd],
    ['n', () => downOrHistoryDown()],
    ['p', () => upOrHistoryUp()],
    ['u', killToLineStart],
    ['w', killWordBefore],
    ['y', yank],
  ])

  const handleMeta = mapInput([
    ['b', () => getLiveCursor().prevWord()],
    ['f', () => getLiveCursor().nextWord()],
    ['d', () => getLiveCursor().deleteWordAfter()],
    ['y', handleYankPop],
  ])

  function handleEnter(key: Key) {
    const cursor = getLiveCursor()
    const currentValue = getLiveValue()
    if (
      multiline &&
      cursor.offset > 0 &&
      cursor.text[cursor.offset - 1] === '\\'
    ) {
      // Track that the user has used backslash+return
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    // Meta+Enter or Shift+Enter inserts a newline
    if (key.meta || key.shift) {
      return cursor.insert('\n')
    }
    // Apple Terminal doesn't support custom Shift+Enter keybindings,
    // so we use native macOS modifier detection to check if Shift is held
    if (env.terminal === 'Apple_Terminal' && isModifierPressed('shift')) {
      return cursor.insert('\n')
    }
    onSubmit?.(currentValue)
  }

  function upOrHistoryUp() {
    const cursor = getLiveCursor()
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.()
      return cursor
    }
    // Try to move by wrapped lines first
    const cursorUp = cursor.up()
    if (!cursorUp.equals(cursor)) {
      return cursorUp
    }

    // If we can't move by wrapped lines and this is multiline input,
    // try to move by logical lines (to handle paragraph boundaries)
    if (multiline) {
      const cursorUpLogical = cursor.upLogicalLine()
      if (!cursorUpLogical.equals(cursor)) {
        return cursorUpLogical
      }
    }

    // Can't move up at all - trigger history navigation
    onHistoryUp?.()
    return cursor
  }
  function downOrHistoryDown() {
    const cursor = getLiveCursor()
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.()
      return cursor
    }
    // Try to move by wrapped lines first
    const cursorDown = cursor.down()
    if (!cursorDown.equals(cursor)) {
      return cursorDown
    }

    // If we can't move by wrapped lines and this is multiline input,
    // try to move by logical lines (to handle paragraph boundaries)
    if (multiline) {
      const cursorDownLogical = cursor.downLogicalLine()
      if (!cursorDownLogical.equals(cursor)) {
        return cursorDownLogical
      }
    }

    // Can't move down at all - trigger history navigation
    onHistoryDown?.()
    return cursor
  }

  function mapKey(
    key: Key,
    cursor: Cursor,
    modeCharacterIsText = false,
  ): InputMapper {
    switch (true) {
      case key.escape:
        return () => {
          // Skip when a keybinding context (e.g. Autocomplete) owns escape.
          // useKeybindings can't shield us via stopImmediatePropagation —
          // BaseTextInput's useInput registers first (child effects fire
          // before parent effects), so this handler has already run by the
          // time the keybinding's handler stops propagation.
          if (disableEscapeDoublePress) return cursor
          handleEscape()
          // Return the current cursor unchanged - handleEscape manages state internally
          return cursor
        }
      case key.leftArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.prevWord()
      case key.rightArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.nextWord()
      case key.backspace:
        return key.meta || key.ctrl
          ? killWordBefore
          : () => cursor.deleteTokenBefore() ?? cursor.backspace()
      case key.delete:
        return key.meta ? killToLineEnd : () => cursor.del()
      case key.ctrl:
        return handleCtrl
      case key.home:
        return () => cursor.startOfLine()
      case key.end:
        return () => cursor.endOfLine()
      case key.pageDown:
        // In fullscreen mode, PgUp/PgDn scroll the message viewport instead
        // of moving the cursor — no-op here, ScrollKeybindingHandler handles it.
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.endOfLine()
      case key.pageUp:
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.startOfLine()
      case key.wheelUp:
      case key.wheelDown:
        // Mouse wheel events only exist when fullscreen mouse tracking is on.
        // ScrollKeybindingHandler handles them; no-op here to avoid inserting
        // the raw SGR sequence as text.
        return NOOP_HANDLER
      case key.return:
        // Must come before key.meta so Option+Return inserts newline
        return () => handleEnter(key)
      case key.meta:
        return handleMeta
      case key.tab:
        return () => cursor
      case key.upArrow && !key.shift:
        return upOrHistoryUp
      case key.downArrow && !key.shift:
        return downOrHistoryDown
      case key.leftArrow:
        return () => cursor.left()
      case key.rightArrow:
        return () => cursor.right()
      default:
        return input =>
          applyPrintableInput(cursor, input, {
            modeCharacterIsText,
            // Issue #1179: emit the mode character as a one-shot onChange
            // notification without inserting it into the local cursor. The
            // effective pre-insertion cursor lets controlled consumers make
            // the same decision after earlier edits in this raw event.
            onModeCharacter: (text, context) => onChange(text, context),
          })
    }
  }

  // Check if this is a kill command (Ctrl+K, Ctrl+U, Ctrl+W, or Meta+Backspace/Delete)
  function isKillKey(key: Key, input: string): boolean {
    if (key.ctrl && (input === 'k' || input === 'u' || input === 'w')) {
      return true
    }
    if (key.meta && (key.backspace || key.delete)) {
      return true
    }
    return false
  }

  // Check if this is a yank command (Ctrl+Y or Alt+Y)
  function isYankKey(key: Key, input: string): boolean {
    return (key.ctrl || key.meta) && input === 'y'
  }

  function onInput(input: string, key: Key): void {
    const currentCursor = getLiveCursor()
    // Note: Image paste shortcut (chat:imagePaste) is handled via useKeybindings in PromptInput

    // Apply filter if provided
    const filteredInput = inputFilter ? inputFilter(input, key) : input

    // If the input was filtered out, do nothing
    if (filteredInput === '' && input !== '') {
      return
    }

    // Vietnamese/CJK IME composition paths (#2018). Both bypass the \r /
    // coalesced-Enter handling in prepareTextInputEvent, so they only run
    // on inputs that carry no carriage returns.
    if (!filteredInput.includes('\r')) {
      // Telex/VNI backspace+replacement compose: a backspace-flagged event
      // carrying a printable non-ASCII character replaces the previous one
      // (a → ă) instead of deleting it.
      if (key.backspace && !key.ctrl && !key.meta) {
        const replaced = replacePreviousWithChar(
          currentCursor.text,
          currentCursor.offset,
          filteredInput,
        )
        if (replaced) {
          resetKillAccumulation()
          resetYankState()
          setValue(replaced.text, replaced.offset)
          return
        }
      }

      // Standalone combining mark (NFD input): compose onto the preceding
      // character rather than inserting a bare mark that later renders,
      // measures, and deletes as a separate unit.
      const markComposed = composeCombiningMark(
        currentCursor.text,
        currentCursor.offset,
        filteredInput,
      )
      if (markComposed) {
        resetKillAccumulation()
        resetYankState()
        setValue(markComposed.text, markComposed.offset)
        return
      }
    }

    const preparedInput = prepareTextInputEvent(filteredInput)

    // Fix Issue #1853: Filter DEL characters that interfere with backspace in SSH/tmux
    // In SSH/tmux environments, backspace generates both key events and raw DEL chars.
    // \b (Ctrl-H) is included because Vietnamese IME setups emit it as the
    // backside of their Telex/VNI backspace+replacement compose pattern (#2018).
    if (
      !key.backspace &&
      !key.delete &&
      /[\x7f\b]/.test(filteredInput)
    ) {
      let finalChangeContext: TextInputChangeContext | undefined
      let modeEntryChangeContext:
        | {
            context: TextInputChangeContext
            character: string
            representedInCursor: boolean
          }
        | undefined
      const result = applyCoalescedDelInput(
        currentCursor,
        preparedInput.input,
        (segmentCursor, segment) => {
          const nextCursor = mapKey(
            key,
            segmentCursor,
            preparedInput.shouldSubmit,
          )(segment)
          const visibleSegment = stripAnsi(segment)
          const firstVisibleCharacter = visibleSegment[0]
          if (
            !modeEntryChangeContext &&
            nextCursor &&
            segmentCursor.text.length === 0 &&
            segmentCursor.isAtStart() &&
            firstVisibleCharacter !== undefined &&
            isInputModeCharacter(firstVisibleCharacter)
          ) {
            modeEntryChangeContext = {
              context: {
                previousValue: segmentCursor.text,
                cursorOffset: segmentCursor.offset,
                willSubmit: preparedInput.shouldSubmit,
              },
              character: firstVisibleCharacter,
              representedInCursor: true,
            }
          }
          finalChangeContext =
            nextCursor && nextCursor.text !== segmentCursor.text
              ? {
                  previousValue: segmentCursor.text,
                  cursorOffset: segmentCursor.offset,
                  willSubmit: preparedInput.shouldSubmit,
                }
              : undefined
          return nextCursor
        },
        (_count, beforeDelete, afterDelete) => {
          finalChangeContext = undefined
          if (
            modeEntryChangeContext?.representedInCursor &&
            beforeDelete.text.startsWith(modeEntryChangeContext.character) &&
            !afterDelete.text.startsWith(modeEntryChangeContext.character)
          ) {
            modeEntryChangeContext.representedInCursor = false
          }
        },
      )

      // Update state once with the final result
      if (!currentCursor.equals(result.cursor)) {
        if (result.shouldCommit) {
          const changeContext = modeEntryChangeContext?.context ?? finalChangeContext
          const committedCursor =
            modeEntryChangeContext &&
            !modeEntryChangeContext.representedInCursor
              ? Cursor.fromText(
                  modeEntryChangeContext.character + result.cursor.text,
                  columns,
                  modeEntryChangeContext.character.length +
                    result.cursor.offset,
                  )
                : result.cursor
          const acceptedCursor =
            modeEntryChangeContext?.representedInCursor
              ? Cursor.fromText(
                  result.cursor.text.slice(
                    modeEntryChangeContext.character.length,
                  ),
                  columns,
                  Math.max(
                    0,
                    result.cursor.offset -
                      modeEntryChangeContext.character.length,
                  ),
                )
              : result.cursor
          commitValue(
            committedCursor.text,
            committedCursor.offset,
            changeContext,
          )
          if (modeEntryChangeContext) {
            // onChange consumes the mode sentinel. Keep the synchronous mirror
            // on that accepted value for later keys from the same stdin read.
            updateRenderedInput(acceptedCursor.text, acceptedCursor.offset)
          }
        } else {
          // A final mode-character notification owns the parent value update,
          // but preceding DELs must still advance the synchronous local mirror.
          const previousOffset = liveOffsetRef.current
          updateRenderedInput(result.cursor.text, result.cursor.offset)
          if (previousOffset !== result.cursor.offset) {
            onOffsetChange(result.cursor.offset)
          }
        }
      }
      resetKillAccumulation()
      resetYankState()
      if (result.shouldCommit && preparedInput.shouldSubmit) {
        // committedCursor may contain a synthetic mode sentinel used only to
        // notify onChange. Submit the actual final cursor; PromptInput carries
        // the detected mode separately through its pending submission state.
        onSubmit?.(result.cursor.text)
      }
      return
    }

    // Reset kill accumulation for non-kill keys
    if (!isKillKey(key, filteredInput)) {
      resetKillAccumulation()
    }

    // Reset yank state for non-yank keys (breaks yank-pop chain)
    if (!isYankKey(key, filteredInput)) {
      resetYankState()
    }

    const nextCursor = mapKey(
      key,
      currentCursor,
      preparedInput.shouldSubmit,
    )(preparedInput.input)
    if (nextCursor) {
      if (!currentCursor.equals(nextCursor)) {
        commitValue(
          nextCursor.text,
          nextCursor.offset,
          preparedInput.shouldSubmit
            ? {
                previousValue: currentCursor.text,
                cursorOffset: currentCursor.offset,
                willSubmit: true,
              }
            : undefined,
        )
      }
      if (preparedInput.shouldSubmit) {
        onSubmit?.(nextCursor.text)
      }
    }
  }

  // Prepare ghost text for rendering - validate insertPosition matches current
  // cursor offset to prevent stale ghost text from a previous keystroke causing
  // a one-frame jitter (ghost text state is updated via useEffect after render)
  const ghostTextForRender =
    inlineGhostText && dim && inlineGhostText.insertPosition === offset
      ? { text: inlineGhostText.text, dim }
      : undefined

  const cursorPos = cursor.getPosition()

  return {
    onInput,
    value,
    renderedValue: cursor.render(
      cursorChar,
      mask,
      invert,
      ghostTextForRender,
      maxVisibleLines,
    ),
    offset,
    setValue,
    setOffset,
    getCursor: getLiveCursor,
    cursorLine: cursorPos.line - cursor.getViewportStartLine(maxVisibleLines),
    cursorColumn: cursorPos.column,
    viewportCharOffset: cursor.getViewportCharOffset(maxVisibleLines),
    viewportCharEnd: cursor.getViewportCharEnd(maxVisibleLines),
  }
}
