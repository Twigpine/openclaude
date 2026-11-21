import {
  type AnsiCode,
  ansiCodesToString,
  type Char,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from '../ink/stringWidth.js'

// A code is an "end code" if its code equals its endCode (e.g., hyperlink close)
function isEndCode(code: AnsiCode): boolean {
  return code.code === code.endCode
}

// Filter to only include "start codes" (not end codes)
function filterStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter(c => !isEndCode(c))
}

export type SliceAnsiOptions = {
  /**
   * Guarantee the result covers at most `end - start` display cells.
   *
   * The default (`false`) keeps the partitioning contract: a wide glyph that
   * straddles `end` is included whole, so `slice(0, k) + slice(k)` reproduces
   * the original text. Callers that clip to a fixed cell budget (truncation,
   * viewport clipping, wrapping) must set `fitEnd`, because a two-cell glyph
   * starting on the last cell of the range would otherwise overflow it.
   */
  fitEnd?: boolean
}

/**
 * Display cells one token occupies. This is the single accounting rule shared
 * by slicing and measuring: the tokenizer's `fullWidth` flag wins over
 * `stringWidth`, because a grapheme carrying VS16 is two cells to the tokenizer
 * and may be one to `stringWidth`.
 */
function tokenCells(token: ReturnType<typeof tokenize>[number]): number {
  return token.type === 'ansi'
    ? 0
    : (token as Char).fullWidth
      ? 2
      : stringWidth((token as Char).value)
}

/**
 * Display cells a string occupies, using the same accounting as
 * `sliceAnsiCells`. Use this instead of `stringWidth` when the value decides
 * how a string is split into chunks, so measurement and slicing agree.
 */
export function displayCells(str: string): number {
  let cells = 0
  for (const token of tokenize(str)) {
    cells += tokenCells(token)
  }
  return cells
}

export type SliceAnsiCellsResult = {
  /** The sliced text, with the style runs it needs re-opened and closed. */
  text: string
  /**
   * Display cells consumed from the source starting at `start`.
   *
   * Callers that walk a string in fixed-width chunks must advance their cursor
   * by this value instead of measuring `text`. The slice counts cells with the
   * tokenizer's `fullWidth` flag (a grapheme carrying VS16 is two cells), while
   * `stringWidth` may disagree for the same cluster; mixing the two accounts
   * duplicates or drops a character at the chunk boundary.
   */
  width: number
}

/**
 * Slice a string containing ANSI escape codes, reporting the cells consumed.
 *
 * Unlike the slice-ansi package, this properly handles OSC 8 hyperlink
 * sequences because @alcalzone/ansi-tokenize tokenizes them correctly.
 */
export function sliceAnsiCells(
  str: string,
  start: number,
  end?: number,
  options?: SliceAnsiOptions,
): SliceAnsiCellsResult {
  const fitEnd = options?.fitEnd === true
  // Don't pass `end` to tokenize — it counts code units, not display cells,
  // so it drops tokens early for text with zero-width combining marks.
  const tokens = tokenize(str)
  let activeCodes: AnsiCode[] = []
  let position = 0
  let result = ''
  let include = false

  for (const token of tokens) {
    // Advance by display width, not code units. Combining marks (Devanagari
    // matras, virama, diacritics) are width 0 — counting them via .length
    // advanced position past `end` early and truncated the slice. Callers
    // pass start/end in display cells, so position must track the same units
    // `displayCells` reports.
    // Non-ansi tokens are treated as Char; tokenize doesn't emit ControlCode
    // for the strings we slice (pre-existing runtime assumption).
    const width = tokenCells(token)

    // Break AFTER trailing zero-width marks — a combining mark attaches to
    // the preceding base char, so "भा" (भ + ा, 1 display cell) sliced at
    // end=1 must include the ा. Breaking on position >= end BEFORE the
    // zero-width check would drop it and render भ bare. ANSI codes are
    // width 0 but must NOT be included past end (they open new style runs
    // that leak into the undo sequence), so gate on char type too. The
    // !include guard ensures empty slices (start===end) stay empty even
    // when the string starts with a zero-width char (BOM, ZWJ).
    if (end !== undefined && position >= end) {
      if (token.type === 'ansi' || width > 0 || !include) break
    }

    if (token.type === 'ansi') {
      activeCodes.push(token)
      if (include) {
        // Emit all ANSI codes during the slice
        result += token.code
      }
    } else {
      // With fitEnd, a printable char that would straddle `end` is dropped
      // instead of overflowing the requested cell range.
      if (fitEnd && end !== undefined && width > 0 && position + width > end) {
        break
      }

      if (!include && position >= start) {
        // Skip leading zero-width marks at the start boundary — they belong
        // to the preceding base char in the left half. Without this, the
        // mark appears in BOTH halves: left+right ≠ original. Only applies
        // when start > 0 (otherwise there's no preceding char to own it).
        if (start > 0 && width === 0) continue
        include = true
        // Reduce and filter to only active start codes
        activeCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
        result = ansiCodesToString(activeCodes)
      }

      if (include) {
        // Same Char assumption as the width computation above
        result += (token as Char).value
      }

      position += width
    }
  }

  const width = Math.max(0, position - start)

  // Empty or out-of-range slice: emit nothing. Running the undo sequence here
  // would leak a stray reset code for styles that were never opened in the
  // result (the codes were only collected, never emitted).
  if (!include) return { text: result, width }

  // Only undo start codes that are still active
  const activeStartCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
  result += ansiCodesToString(undoAnsiCodes(activeStartCodes))
  return { text: result, width }
}

/** Slice a string containing ANSI escape codes. */
export default function sliceAnsi(
  str: string,
  start: number,
  end?: number,
  options?: SliceAnsiOptions,
): string {
  return sliceAnsiCells(str, start, end, options).text
}
