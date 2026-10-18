import { describe, expect, it } from 'bun:test'
import figures from 'figures'
import { renderToString } from '../../utils/staticRender.js'
import {
  getCurrentResponseTokenCount,
  getThinkingShimmerColor,
  SpinnerAnimationRow,
  type SpinnerAnimationRowProps,
} from './SpinnerAnimationRow.js'

/** Match Spinner.tsx production message shape: verb + ellipsis. */
const PROD_MESSAGE = 'Thinking…'
const PROD_MESSAGE_RE = PROD_MESSAGE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * SpinnerModeGlyph wraps the arrow in a Box of width 2, so a single-width
 * arrow always renders with one trailing pad space inside status parens.
 */
function paddedModeGlyph(arrow: string): string {
  return `${arrow} `
}

function frozenElapsedRefs(elapsedMs: number): Pick<
  SpinnerAnimationRowProps,
  'loadingStartTimeRef' | 'totalPausedMsRef' | 'pauseStartTimeRef'
> {
  const start = 1_000_000
  return {
    loadingStartTimeRef: { current: start },
    totalPausedMsRef: { current: 0 },
    pauseStartTimeRef: { current: start + elapsedMs },
  }
}

function baseProps(
  overrides: Partial<SpinnerAnimationRowProps> = {},
): SpinnerAnimationRowProps {
  return {
    mode: 'responding',
    reducedMotion: true,
    hasActiveTools: false,
    responseLengthRef: { current: 0 },
    message: PROD_MESSAGE,
    messageColor: 'text',
    shimmerColor: 'text',
    ...frozenElapsedRefs(0),
    verbose: false,
    columns: 120,
    hasRunningTeammates: false,
    teammateTokens: 0,
    foregroundedTeammate: undefined,
    thinkingStatus: null,
    effortSuffix: '',
    ...overrides,
  }
}

/** Non-empty rows from a static Ink render (`renderToString` strips ANSI). */
function visibleRows(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/u, ''))
    .filter(line => line.trim().length > 0)
}

describe('SpinnerAnimationRow', () => {
  it('uses the current response length without smoothing', () => {
    expect(getCurrentResponseTokenCount(4_000)).toBe(1_000)
  })

  it('shows the current token count immediately when streaming begins', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow {...baseProps({ responseLength: 4_000 })} />,
      120,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · 1.0k tokens)`,
    ])
  })

  it('prefers token count over glyph-only status on mid-narrow terminals', async () => {
    // Full glyph+tokens chrome fails primary gate around cols 27–31 for
    // production "Thinking…" (messageWidth 11); content recovery drops the
    // glyph so tokens show. Breakpoints are message-relative — longer verbs
    // shift the band (see long-verb recovery test).
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLength: 4_000,
          columns: 29,
        })}
      />,
      29,
    )

    const rows = visibleRows(output)
    expect(rows).toEqual([`● ${PROD_MESSAGE} (1.0k tokens)`])
    expect(rows[0]).not.toContain(figures.arrowDown)
  })

  it('recovers tokens for long production verbs at their shifted column band', async () => {
    // Spinner.tsx uses effectiveVerb + '…'; Flibbertigibbeting… is messageWidth 21,
    // so tokens need columns >= 35 (21 + bare parens 3 + "1.0k tokens" 11).
    const longMessage = 'Flibbertigibbeting…'
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          message: longMessage,
          responseLength: 4_000,
          columns: 35,
        })}
      />,
      35,
    )

    const rows = visibleRows(output)
    expect(rows).toEqual([`● ${longMessage} (1.0k tokens)`])
    expect(rows[0]).not.toContain(figures.arrowDown)
  })

  it('drops an overflowing spinner suffix to keep streaming tokens', async () => {
    // Stop-hook suffix (~23 cols) cannot fit under bare chrome at cols 31 with
    // Thinking…; drop it and prefer live tokens over post-thinking duration.
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'responding',
          thinkingStatus: 3_000,
          responseLength: 4_000,
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 31,
        })}
      />,
      31,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (1.0k tokens)`])
  })

  it('recovers streaming tokens after suffix drop when thinkingStatus is null', async () => {
    // Production responding + stop-hook/tool suffix often has thinkingStatus null.
    // Suffix drop must re-gate tokens — not only the numeric-thinkingStatus path.
    // Cols 30–31: glyph+tokens do not fit under bare recovery (same as no-suffix).
    // Cols 35: glyph+tokens fit, so keep the mode arrow after recovery.
    for (const columns of [30, 31]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            thinkingStatus: null,
            responseLength: 4_000,
            spinnerSuffix: 'running stop hooks… 1/1',
            columns,
          })}
        />,
        columns,
      )

      expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (1.0k tokens)`])
    }

    const wide = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          thinkingStatus: null,
          responseLength: 4_000,
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 35,
        })}
      />,
      35,
    )
    expect(visibleRows(wide)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · 1.0k tokens)`,
    ])
  })

  it('drops glyph to keep an untruncated suffix when bare chrome still fits', async () => {
    // Glyph+suffix overflows cols 39 for Thinking… + production stop-hook text,
    // but bare suffix fits — drop the glyph rather than truncating mid-suffix.
    // No streaming tokens: tokens-over-suffix preference must not fire.
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLengthRef: { current: 0 },
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 39,
        })}
      />,
      39,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (running stop hooks… 1/1)`,
    ])
  })

  it('prefers streaming tokens over a bare-fitting suffix that cannot share the row', async () => {
    // At cols 37, suffix exactly fits bare chrome but tokens+suffix do not —
    // prefer live tokens (same priority as tokens-over-duration).
    for (const columns of [36, 37, 39]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            responseLength: 4_000,
            spinnerSuffix: 'running stop hooks… 1/1',
            columns,
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('1.0k tokens')
      expect(rows[0]).not.toContain('running stop hooks')
    }
  })

  it('recovers teammate timer after dropping an overflowing suffix', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          hasRunningTeammates: true,
          thinkingStatus: null,
          responseLengthRef: { current: 0 },
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 30,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      30,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (6s)`])
  })

  it('recovers timer with tokens after dropping an overflowing suffix', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          hasRunningTeammates: true,
          thinkingStatus: null,
          responseLength: 4_000,
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 35,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      35,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (6s · 1.0k tokens)`])
  })

  it('recovers requesting timer instead of empty glyph after suffix drop', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'requesting',
          verbose: true,
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 27,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      27,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowUp)} · 6s)`,
    ])
  })

  it('does not wrap when preferTokens would stack suffix with timer and tokens', async () => {
    for (const columns of [49, 52, 54]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            responseLength: 4_000,
            spinnerSuffix: 'running stop hooks… 1/1',
            columns,
            ...frozenElapsedRefs(6_000),
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('1.0k tokens')
      expect(rows[0]).not.toMatch(/1\.0k token$/)
      expect(rows[0]).toContain('6s')
    }
  })

  it('keeps already-visible thinking when tokens unlock under glyph', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          responseLength: 4_000,
          verbose: true,
          columns: 41,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      41,
    )

    const rows = visibleRows(output)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('thinking')
    expect(rows[0]).toContain('1.0k tokens')
    expect(rows[0]).toContain('6s')
  })

  it('recovers tokens onto timer-only rows after preferring tokens over suffix', async () => {
    for (const columns of [44, 46, 48]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            responseLength: 4_000,
            spinnerSuffix: 'running stop hooks… 1/1',
            columns,
            ...frozenElapsedRefs(6_000),
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('1.0k tokens')
      expect(rows[0]).toContain('6s')
      expect(rows[0]).toContain(figures.arrowDown)
      expect(rows[0]).not.toContain('running stop hooks')
    }
  })

  it('keeps streaming tokens when leader thinking unlocks on mid-narrow rows', async () => {
    for (const columns of [26, 27, 30]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            mode: 'thinking',
            thinkingStatus: 'thinking',
            responseLength: 4_000,
            verbose: true,
            columns,
            ...frozenElapsedRefs(6_000),
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('1.0k tokens')
      expect(rows[0]).not.toContain('thinking')
    }
  })

  it('does not wrap wide timers onto thinking and early token counts', async () => {
    for (const columns of [34, 40]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            mode: 'thinking',
            thinkingStatus: 'thinking',
            responseLength: 1,
            verbose: true,
            columns,
            ...frozenElapsedRefs(36_000_000),
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('thinking')
      expect(rows[0]).toContain('0 tokens')
      expect(rows[0]).not.toMatch(/Thinkin[^g]/)
    }
  })

  it('prefers leader thinking over a bare-fitting suffix that crowds it out', async () => {
    for (const columns of [37, 40]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            mode: 'thinking',
            thinkingStatus: 'thinking',
            spinnerSuffix: 'running stop hooks… 1/1',
            columns,
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('thinking')
      expect(rows[0]).not.toContain('running stop hooks')
    }
  })

  it('keeps mode glyph across the suffix-to-tokens bare-fit boundary', async () => {
    for (const columns of [36, 37, 42]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            responseLength: 4_000,
            spinnerSuffix: 'running stop hooks… 1/1',
            columns,
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toEqual([
        `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · 1.0k tokens)`,
      ])
    }
  })

  it('drops an overflowing spinner suffix to keep leader thinking', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 27,
        })}
      />,
      27,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · thinking)`,
    ])
  })

  it('recovers teammate nested thinking after dropping an overflowing suffix', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          hasRunningTeammates: true,
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 27,
        })}
      />,
      27,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (thinking)`])
  })

  it('drops the glyph when it would hide tokens behind a visible timer', async () => {
    for (const columns of [31, 32]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            responseLength: 4_000,
            verbose: true,
            ...frozenElapsedRefs(6_000),
            columns,
          })}
        />,
        columns,
      )

      expect(visibleRows(output)).toEqual([
        `● ${PROD_MESSAGE} (6s · 1.0k tokens)`,
      ])
    }
  })

  it('keeps tokens when the elapsed timer becomes eligible on mid-narrow rows', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLength: 4_000,
          columns: 29,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      29,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (1.0k tokens)`])
  })

  it('keeps timer and tokens when timer text widens on mid-narrow rows', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLength: 4_000,
          verbose: true,
          columns: 31,
          ...frozenElapsedRefs(10_000),
        })}
      />,
      31,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (10s · 1.0k tokens)`,
    ])
  })

  it('shows zero tokens as soon as the first response character arrives', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow {...baseProps({ responseLength: 1 })} />,
      120,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · 0 tokens)`,
    ])
  })

  it('does not overflow a narrow row when a spinner suffix is present', async () => {
    // At cols 46, suffix fits bare but cannot share with streaming tokens —
    // tokens-over-suffix preference keeps a single-line token status.
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLengthRef: { current: 4_000 },
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 46,
        })}
      />,
      46,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · 1.0k tokens)`,
    ])
  })

  it('keeps suffix with mode glyph when tokens are absent and bare chrome fits', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLengthRef: { current: 0 },
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 46,
        })}
      />,
      46,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · running stop hooks… 1/1)`,
    ])
  })

  it('shows the requesting mode glyph inside parens before other status parts qualify', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow {...baseProps({ mode: 'requesting' })} />,
      120,
    )

    // paddedModeGlyph encodes the Box(width=2) trailing space after ↑.
    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowUp)})`,
    ])
  })

  it('shows the thinking mode glyph inside parens for thinking-only status', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
        })}
      />,
      120,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · thinking)`,
    ])
  })

  it('keeps thinking text with the mode glyph on moderately narrow terminals', async () => {
    // Primary gate with full parensWidth rejects ~cols 26–28 for production
    // "Thinking…"; the leader thinking-only second chance must still fit
    // "(↓ · thinking)" so the thinking word is not dropped.
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          columns: 27,
        })}
      />,
      27,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · thinking)`,
    ])
  })

  it('falls back to bare thinking without glyph when full chrome does not fit', async () => {
    // Cols 22–26: glyph+thinking chrome does not fit, but bare "(thinking)" does.
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          columns: 24,
        })}
      />,
      24,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (thinking)`])
  })

  it('does not enable bare thinking one column short of physical fit', async () => {
    // bareAvailable = columns - messageWidth - 3; for "Thinking…" that is
    // columns - 14. At columns=21, bareAvailable=7 < 8, so bare must not show.
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          columns: 21,
        })}
      />,
      21,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)})`,
    ])
  })

  it('omits the mode glyph when residual width cannot fit status chrome', async () => {
    // messageWidth("Thinking…")+2 = 11; residual at columns=15 is 4 (< 5).
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'requesting',
          columns: 15,
        })}
      />,
      15,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE}`])
  })

  it('omits the mode glyph when teammates are running', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'responding',
          responseLength: 4_000,
          hasRunningTeammates: true,
          ...frozenElapsedRefs(0),
        })}
      />,
      120,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (0s · 1.0k tokens)`,
    ])
  })

  it('nests (thinking) for teammate bare status under reduced motion', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          hasRunningTeammates: true,
          reducedMotion: true,
          columns: 27,
        })}
      />,
      27,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (thinking)`])
  })

  it('nests (thinking) for teammate bare status under shimmer', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          hasRunningTeammates: true,
          reducedMotion: false,
          columns: 27,
        })}
      />,
      27,
    )

    // Spinner glyph frame varies under motion; lock nested teammate thinking.
    const rows = visibleRows(output)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(new RegExp(`^\\S ${PROD_MESSAGE_RE} \\(thinking\\)$`))
  })

  it('omits empty glyph chrome when post-thinking duration does not fit', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'responding',
          thinkingStatus: 3_000,
          columns: 25,
        })}
      />,
      25,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE}`])
  })

  it('omits empty glyph chrome for requesting spins with numeric thinkingStatus', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'requesting',
          thinkingStatus: 3_000,
          columns: 17,
        })}
      />,
      17,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE}`])
  })

  it('shows post-thinking duration without glyph when bare chrome fits', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'responding',
          thinkingStatus: 3_000,
          columns: 28,
        })}
      />,
      28,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (thought for 3s)`,
    ])
  })

  it('prefers streaming tokens over post-thinking duration on mid-narrow terminals', async () => {
    for (const columns of [30, 31]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            mode: 'responding',
            thinkingStatus: 3_000,
            responseLength: 4_000,
            columns,
          })}
        />,
        columns,
      )

      expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (1.0k tokens)`])
    }

    // At cols 35 glyph+tokens fit — restore the mode arrow after duration→tokens.
    const wide = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'responding',
          thinkingStatus: 3_000,
          responseLength: 4_000,
          columns: 35,
        })}
      />,
      35,
    )
    expect(visibleRows(wide)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · 1.0k tokens)`,
    ])
  })

  it('recovers tokens at the exact-fit column boundary', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLength: 4_000,
          columns: 25,
        })}
      />,
      25,
    )

    expect(visibleRows(output)).toEqual([`● ${PROD_MESSAGE} (1.0k tokens)`])
  })

  it('keeps full effort text when it fits with the mode glyph', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          effortSuffix: ' with high effort',
          columns: 44,
        })}
      />,
      44,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · thinking with high effort)`,
    ])
  })

  it('prefers active thinking over timer-only status on mid-narrow rows', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          verbose: true,
          columns: 27,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      27,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · thinking)`,
    ])
  })

  it('prefers tokens over thinking when both unlock by dropping the glyph', async () => {
    // Col 26 + verbose timer: glyph layout keeps timer only (leader thinking
    // chrome does not fit); bare unlocks both tokens and thinking.
    // preferTokensOverTimerOnly wins that tie-break.
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          responseLength: 4_000,
          verbose: true,
          columns: 26,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      26,
    )

    const rows = visibleRows(output)
    expect(rows).toEqual([`● ${PROD_MESSAGE} (1.0k tokens)`])
    expect(rows[0]).not.toContain('thinking')
    expect(rows[0]).not.toContain(figures.arrowDown)
  })

  it('keeps zero tokens when glyph recovery would swap them for timer only', async () => {
    const tenHoursMs = 10 * 60 * 60 * 1_000
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          responseLength: 1,
          verbose: true,
          ...frozenElapsedRefs(tenHoursMs),
          columns: 29,
        })}
      />,
      29,
    )

    const rows = visibleRows(output)
    expect(rows).toEqual([
      `● ${PROD_MESSAGE} (${paddedModeGlyph(figures.arrowDown)} · 0 tokens)`,
    ])
    expect(rows[0]).not.toMatch(/\dh\b/)
  })

  it('keeps leader thinking glyph path under reducedMotion false', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          reducedMotion: false,
        })}
      />,
      120,
    )

    // Spinner glyph frame varies under motion; lock the status chrome shape.
    const rows = visibleRows(output)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(
      new RegExp(
        `^\\S ${PROD_MESSAGE_RE} \\(${figures.arrowDown}  · thinking\\)$`,
      ),
    )
  })

  it('keeps elapsed timer monotonic when suffix starts fitting beside thinking', async () => {
    const suffix = 'running stop hooks… 1/1'
    for (const columns of [48, 49, 50, 51, 52, 53, 54]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            mode: 'thinking',
            thinkingStatus: 'thinking',
            verbose: true,
            spinnerSuffix: suffix,
            columns,
            ...frozenElapsedRefs(6_000),
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('6s')
      expect(rows[0]).toContain('thinking')
      if (columns < 54) {
        expect(rows[0]).not.toContain('running stop hooks')
      } else {
        expect(rows[0]).toContain('running stop hooks')
      }
    }
  })

  it('keeps teammate streaming tokens monotonic across the mid-width band', async () => {
    for (const columns of [35, 36, 37, 38, 39, 40, 41]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            mode: 'thinking',
            thinkingStatus: 'thinking',
            hasRunningTeammates: true,
            responseLength: 4_000,
            columns,
            ...frozenElapsedRefs(0),
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('1.0k tokens')
    }
  })

  it('keeps streaming tokens when effort suffix and spinner suffix widen', async () => {
    const suffix = 'running stop hooks… 1/1'
    for (const columns of [55, 60, 65, 70, 75]) {
      const output = await renderToString(
        <SpinnerAnimationRow
          {...baseProps({
            mode: 'thinking',
            thinkingStatus: 'thinking',
            effortSuffix: ' with high effort',
            responseLength: 4_000,
            spinnerSuffix: suffix,
            verbose: true,
            columns,
            ...frozenElapsedRefs(6_000),
          })}
        />,
        columns,
      )

      const rows = visibleRows(output)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain('1.0k tokens')
      expect(rows[0]).toContain('6s')
      if (columns >= 75) {
        expect(rows[0]).toContain('thinking with high effort')
      }
    }
  })

  it('recovers thinking plus tokens without glyph overflow after suffix drop', async () => {
    const output = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          responseLength: 4_000,
          spinnerSuffix: 'running stop hooks… 1/1',
          columns: 36,
          verbose: true,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      36,
    )

    expect(visibleRows(output)).toEqual([
      `● ${PROD_MESSAGE} (6s · 1.0k tokens)`,
    ])
    expect(visibleRows(output)[0]).not.toContain(figures.arrowDown)
  })

  it('drops a retained glyph when bare recovery adds tokens beside thinking', async () => {
    const numericOutput = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 3_000,
          responseLength: 4_000,
          columns: 42,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      42,
    )

    const numericRows = visibleRows(numericOutput)
    expect(numericRows).toHaveLength(1)
    expect(numericRows[0]).toContain('1.0k tokens')
    expect(numericRows[0]).toContain('thought for 3s')
    expect(numericRows[0]).not.toContain(figures.arrowDown)

    const activeOutput = await renderToString(
      <SpinnerAnimationRow
        {...baseProps({
          mode: 'thinking',
          thinkingStatus: 'thinking',
          effortSuffix: ' with high effort',
          responseLength: 4_000,
          verbose: true,
          columns: 53,
          ...frozenElapsedRefs(6_000),
        })}
      />,
      53,
    )

    const activeRows = visibleRows(activeOutput)
    expect(activeRows).toHaveLength(1)
    expect(activeRows[0]).toContain('1.0k tokens')
    expect(activeRows[0]).toContain('thinking with high effort')
    expect(activeRows[0]).not.toContain(figures.arrowDown)
  })
})

describe('getThinkingShimmerColor', () => {
  // Mirrors the default palette's rgb() tokens (theme values are always
  // rgb() strings there, never hex).
  const rgbTheme = {
    ultracode: 'rgb(0,180,216)',
    ultracodeShimmer: 'rgb(77,215,255)',
  }
  // Mirrors ANSI/daltonized palettes, whose tokens parseRGB can't interpolate.
  const ansiTheme = {
    ultracode: 'ansi:cyanBright',
    ultracodeShimmer: 'ansi:cyanBright',
  }

  it('interpolates ultracode shimmer between the theme rgb() tokens', () => {
    expect(getThinkingShimmerColor(rgbTheme, true, 0)).toBe('rgb(0,180,216)')
    expect(getThinkingShimmerColor(rgbTheme, true, 1)).toBe('rgb(77,215,255)')
    expect(getThinkingShimmerColor(rgbTheme, true, 0.5)).toBe('rgb(39,198,236)')
  })

  it('falls back to the ultracode RGB constants for ansi:* theme tokens', () => {
    expect(getThinkingShimmerColor(ansiTheme, true, 0)).toBe('rgb(0,155,196)')
    expect(getThinkingShimmerColor(ansiTheme, true, 1)).toBe('rgb(44,200,237)')
  })

  it('interpolates the gray thinking shimmer when ultracode is not active', () => {
    for (const theme of [rgbTheme, ansiTheme]) {
      expect(getThinkingShimmerColor(theme, false, 0)).toBe('rgb(153,153,153)')
      expect(getThinkingShimmerColor(theme, false, 1)).toBe('rgb(185,185,185)')
      expect(getThinkingShimmerColor(theme, false, 0.5)).toBe('rgb(169,169,169)')
    }
  })
})
