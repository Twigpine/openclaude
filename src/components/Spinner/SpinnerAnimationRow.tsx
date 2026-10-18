import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useMemo, useRef } from 'react';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, Text, useAnimationFrame, useTheme } from '../../ink.js';
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js';
import { formatDuration, formatNumber } from '../../utils/format.js';
import { toInkColor } from '../../utils/ink.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { Byline } from '../design-system/Byline.js';
import FullWidthRow from '../design-system/FullWidthRow.js';
import { GlimmerMessage } from './GlimmerMessage.js';
import { SpinnerGlyph } from './SpinnerGlyph.js';
import type { SpinnerMode } from './types.js';
import { useStalledAnimation } from './useStalledAnimation.js';
import { interpolateColor, parseRGB, toRGBColor } from './utils.js';
const SEP_WIDTH = stringWidth(' · ');
const THINKING_BARE_WIDTH = stringWidth('thinking');
// Show the elapsed-time counter after a short delay so long tool calls still
// provide reassurance even when no tokens stream.
const SHOW_TIMER_AFTER_MS = 5_000;

// Thinking shimmer constants. Previously lived in a separate ThinkingShimmerText
// component with its own useAnimationFrame(50) — inlined here to reuse our
// existing 50ms clock and eliminate the redundant subscriber.
const THINKING_INACTIVE = {
  r: 153,
  g: 153,
  b: 153
};
const THINKING_INACTIVE_SHIMMER = {
  r: 185,
  g: 185,
  b: 185
};
// Ultracode thinking shimmer (blue/cyan) — distinct from the gray thinking
// shimmer. Endpoints are normally derived from the `ultracode`/`ultracodeShimmer`
// theme tokens so the spinner, border, and shimmer share one source of truth.
// These constants are the fallback for ANSI/daltonized themes where the token
// is a named ANSI color that parseRGB can't interpolate.
const ULTRACODE_INACTIVE_FALLBACK = {
  r: 0,
  g: 155,
  b: 196
};
const ULTRACODE_SHIMMER_FALLBACK = {
  r: 44,
  g: 200,
  b: 237
};
const THINKING_DELAY_MS = 3000;
const THINKING_GLOW_PERIOD_S = 2;

// Exported for tests: renderToString strips ANSI color, so the shimmer color
// selection (theme-token interpolation vs ANSI-theme fallback) is only
// observable through this helper.
export function getThinkingShimmerColor(theme: Pick<Theme, 'ultracode' | 'ultracodeShimmer'>, isUltracodeOverride: boolean, thinkingOpacity: number) {
  return isUltracodeOverride ? toRGBColor(interpolateColor(parseRGB(theme.ultracode) ?? ULTRACODE_INACTIVE_FALLBACK, parseRGB(theme.ultracodeShimmer) ?? ULTRACODE_SHIMMER_FALLBACK, thinkingOpacity)) : toRGBColor(interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, thinkingOpacity));
}

export function getCurrentResponseTokenCount(responseLength: number): number {
  return Math.round(responseLength / 4);
}

export type SpinnerAnimationRowProps = {
  // Animation inputs
  mode: SpinnerMode;
  reducedMotion: boolean;
  hasActiveTools: boolean;
  responseLengthRef: React.RefObject<number>;
  /** Throttled live response length for reduced-motion rendering. */
  responseLength?: number;

  // Message (stable within a turn)
  message: string;
  messageColor: keyof Theme;
  shimmerColor: keyof Theme;
  overrideColor?: keyof Theme | null;

  // Timer refs (stable references)
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;

  // Display flags
  spinnerSuffix?: string | null;
  verbose: boolean;
  columns: number;

  // Teammate-derived (computed by parent from tasks)
  hasRunningTeammates: boolean;
  teammateTokens: number;
  foregroundedTeammate: InProcessTeammateTaskState | undefined;
  /** Leader's turn has completed. Suppresses stall-red since responseLengthRef/hasActiveTools track leader state only. */
  leaderIsIdle?: boolean;

  // Thinking (state owned by parent, mode-dependent)
  thinkingStatus: 'thinking' | number | null;
  effortSuffix: string;
};

/**
 * The 50ms-animated portion of SpinnerWithVerb. Owns useAnimationFrame(50)
 * and all values derived from the animation clock (frame, glimmer,
 * elapsed-time, stalled intensity, thinking shimmer).
 *
 * The parent SpinnerWithVerb is freed from the 50ms render loop and only
 * re-renders when its props/app state change (~25x/turn instead of ~383x).
 * That keeps the outer Box shells, useAppState selectors, task filtering,
 * and tip/tree subtrees out of the hot animation path.
 */
export function SpinnerAnimationRow({
  mode,
  reducedMotion,
  hasActiveTools,
  responseLengthRef,
  responseLength,
  message,
  messageColor,
  shimmerColor,
  overrideColor,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerSuffix,
  verbose,
  columns,
  hasRunningTeammates,
  teammateTokens,
  foregroundedTeammate,
  leaderIsIdle = false,
  thinkingStatus,
  effortSuffix
}: SpinnerAnimationRowProps): React.ReactNode {
  const [viewportRef, time] = useAnimationFrame(reducedMotion ? null : 50);
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  // === Elapsed time (wall-clock, derived from refs each frame) ===
  const now = Date.now();
  const elapsedTimeMs = pauseStartTimeRef.current !== null ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current : now - loadingStartTimeRef.current - totalPausedMsRef.current;

  // Track wall-clock turn start for teammates. While a swarm is running the
  // leader's elapsedTimeMs may jump around (new API calls reset
  // loadingStartTimeRef; pauses freeze it), so we anchor to the earliest
  // derived start seen so far. When no teammates are running this just tracks
  // derivedStart every frame, effectively resetting for the next swarm.
  const derivedStart = now - elapsedTimeMs;
  const turnStartRef = useRef(derivedStart);
  if (!hasRunningTeammates || derivedStart < turnStartRef.current) {
    turnStartRef.current = derivedStart;
  }

  // === Animation derivations from `time` ===
  const currentResponseLength = responseLength ?? responseLengthRef.current;

  // Suppress stall detection when leader is idle — responseLengthRef and
  // hasActiveTools both track leader state. When viewing an active teammate
  // while leader is idle, they'd otherwise flag a false stall after 3s.
  // Treating leaderIsIdle like hasActiveTools resets the stall timer.
  const {
    isStalled,
    stalledIntensity
  } = useStalledAnimation(time, currentResponseLength, hasActiveTools || leaderIsIdle, reducedMotion);
  const frame = reducedMotion ? 0 : Math.floor(time / 120);
  const glimmerSpeed = mode === 'requesting' ? 50 : 200;
  // message is stable within a turn; stringWidth is expensive enough (Bun native
  // call per code point) to memoize explicitly across the 50ms loop.
  const glimmerMessageWidth = useMemo(() => stringWidth(message), [message]);
  const cycleLength = glimmerMessageWidth + 20;
  const cyclePosition = Math.floor(time / glimmerSpeed);
  const glimmerIndex = reducedMotion ? -100 : isStalled ? -100 : mode === 'requesting' ? cyclePosition % cycleLength - 10 : glimmerMessageWidth + 10 - cyclePosition % cycleLength;
  const flashOpacity = reducedMotion ? 0 : mode === 'tool-use' ? (Math.sin(time / 1000 * Math.PI) + 1) / 2 : 0;

  // Display the latest observed response length without smoothing so the token
  // count is current as soon as the model starts streaming.
  const leaderTokens = getCurrentResponseTokenCount(currentResponseLength);
  const effectiveElapsedMs = hasRunningTeammates ? Math.max(elapsedTimeMs, now - turnStartRef.current) : elapsedTimeMs;
  const timerText = formatDuration(effectiveElapsedMs);
  const timerWidth = stringWidth(timerText);

  // === Token count (leader + teammates, or foregrounded teammate) ===
  const totalTokens = foregroundedTeammate && !foregroundedTeammate.isIdle ? foregroundedTeammate.progress?.tokenCount ?? 0 : leaderTokens + teammateTokens;
  const hasTokenContent = foregroundedTeammate && !foregroundedTeammate.isIdle ? totalTokens > 0 : currentResponseLength > 0 || teammateTokens > 0;
  const tokenCount = formatNumber(totalTokens);
  const tokensText = `${tokenCount} tokens`;
  const tokensWidth = stringWidth(tokensText);

  // === Thinking text (may shrink to fit) ===
  let thinkingText = thinkingStatus === 'thinking' ? `thinking${effortSuffix}` : typeof thinkingStatus === 'number' ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s` : null;
  let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0;

  // === Progressive width gating ===
  // messageWidth = glimmer text + spinner glyph (width: 2).
  // Base parens chrome is 4: glimmer trailing space + "(" + ")" + safety.
  // Leader spins may also reserve mode glyph (width 2) + separator.
  // Physical bare chrome (no safety) is 3 — used for exact-fit recovery so
  // higher-value status (tokens/thinking) appears as soon as it actually fits.
  const messageWidth = glimmerMessageWidth + 2;
  const sep = SEP_WIDTH;
  const MODE_GLYPH_RESERVE = 2 + SEP_WIDTH;
  const BASE_PARENS_WIDTH = 4;
  const PHYSICAL_BARE_PARENS = 3;
  // Full glyph+thinking chrome budget includes +1 safety vs physical Ink width.
  const leaderThinkingOnlyChrome = 2 + 2 + SEP_WIDTH + 1;
  const suffixTextWidth = spinnerSuffix ? stringWidth(spinnerSuffix) : 0;
  const suffixWidth = spinnerSuffix ? suffixTextWidth + sep : 0;
  const wantsThinking = thinkingStatus !== null;
  const wantsTimer = verbose || hasRunningTeammates || effectiveElapsedMs > SHOW_TIMER_AFTER_MS;
  const wantsTokens = true;
  const fullThinkingText = thinkingText;
  const fullThinkingWidth = thinkingWidthValue;
  // Prefer layout with the mode glyph when it fits alongside other status.
  let reserveModeGlyph = !hasRunningTeammates;
  let showSuffix = Boolean(spinnerSuffix);
  let effectiveSuffixWidth = showSuffix ? suffixWidth : 0;
  let parensWidth = BASE_PARENS_WIDTH + (reserveModeGlyph ? MODE_GLYPH_RESERVE : 0);
  let availableSpace = columns - messageWidth - parensWidth;
  // Try full effort text against the looser leader glyph chrome before shrinking,
  // so "(↓ · thinking with high effort)" wins when it physically fits.
  let showThinking = wantsThinking && availableSpace > effectiveSuffixWidth + thinkingWidthValue;
  if (!showThinking && wantsThinking && thinkingStatus === 'thinking' && !hasRunningTeammates && !showSuffix && reserveModeGlyph) {
    const leaderThinkingAvailable = columns - messageWidth - leaderThinkingOnlyChrome;
    if (leaderThinkingAvailable >= fullThinkingWidth) {
      showThinking = true;
    }
  }
  if (!showThinking && wantsThinking && thinkingStatus === 'thinking' && effortSuffix) {
    if (availableSpace > effectiveSuffixWidth + THINKING_BARE_WIDTH) {
      thinkingText = 'thinking';
      thinkingWidthValue = THINKING_BARE_WIDTH;
      showThinking = true;
    }
  }
  let usedAfterThinking = effectiveSuffixWidth + (showThinking ? thinkingWidthValue + sep : 0);
  let showTimer = wantsTimer && availableSpace > usedAfterThinking + timerWidth;
  let usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + sep : 0);
  let showTokens = wantsTokens && hasTokenContent && availableSpace > usedAfterTimer + tokensWidth;
  // Re-check without the glyph. Keep it when it fits alongside the same
  // content, but prefer higher-value status when reserving the glyph hides it.
  // Use physical bare chrome for recovery so exact-fit columns are not rejected
  // by the +1 safety margin that primary gating already applied.
  if (reserveModeGlyph) {
    const bareAvailableSpace = columns - messageWidth - PHYSICAL_BARE_PARENS;
    let bareThinkingText = fullThinkingText;
    let bareThinkingWidth = fullThinkingWidth;
    // Thinking/timer keep `>` so they leave one safety column; token checks use
    // `>=` so live token counts may consume the exact physical bare budget.
    let bareShowThinking = wantsThinking && bareAvailableSpace > effectiveSuffixWidth + bareThinkingWidth;
    if (!bareShowThinking && wantsThinking && thinkingStatus === 'thinking' && effortSuffix) {
      if (bareAvailableSpace > effectiveSuffixWidth + THINKING_BARE_WIDTH) {
        bareThinkingText = 'thinking';
        bareThinkingWidth = THINKING_BARE_WIDTH;
        bareShowThinking = true;
      }
    }
    const bareUsedAfterThinking = effectiveSuffixWidth + (bareShowThinking ? bareThinkingWidth + sep : 0);
    const bareShowTimer = wantsTimer && bareAvailableSpace > bareUsedAfterThinking + timerWidth;
    const bareUsedAfterTimer = bareUsedAfterThinking + (bareShowTimer ? timerWidth + sep : 0);
    const bareShowTokens = wantsTokens && hasTokenContent && bareAvailableSpace >= bareUsedAfterTimer + tokensWidth;
    const tokensFitBareAlone = wantsTokens && hasTokenContent && bareAvailableSpace >= tokensWidth;
    const timerAndTokensFitBare = wantsTimer && hasTokenContent && bareAvailableSpace >= timerWidth + sep + tokensWidth;
    // Thinking-only recovery stays in the dedicated second-chance block below
    // so full "(↓ · thinking)" chrome still wins when it fits.
    const glyphHidesThinking = bareShowThinking && !showThinking;
    const glyphHidesTimer = bareShowTimer && !showTimer;
    const glyphHidesTokens = bareShowTokens && !showTokens;
    // Timer under glyph with no tokens and thinking not already visible: prefer
    // tokens alone (or timer+tokens) over timer-only / glyph+timer chrome.
    // Do not enter this shortcut when thinking is already on-screen — the else
    // bare layout can keep thinking+timer+tokens together when they fit.
    const preferTokensOverTimerOnly = Boolean(showTimer && !showTokens && !showThinking && tokensFitBareAlone);
    // Active thinking hidden behind glyph+timer: prefer thinking (drop timer if needed).
    const preferThinkingOverTimerOnly = Boolean(showTimer && !showThinking && bareShowThinking && thinkingStatus === 'thinking');
    // Do not swap already-visible tokens for a timer that only fits without the glyph,
    // unless we are explicitly choosing tokens-over-timer-only below.
    const glyphRecoveryLosesTokens = showTokens && !bareShowTokens && !preferTokensOverTimerOnly;
    if ((glyphHidesThinking || glyphHidesTimer || glyphHidesTokens || preferTokensOverTimerOnly || preferThinkingOverTimerOnly) && !glyphRecoveryLosesTokens) {
      reserveModeGlyph = false;
      parensWidth = BASE_PARENS_WIDTH;
      availableSpace = columns - messageWidth - BASE_PARENS_WIDTH;
      if (preferTokensOverTimerOnly) {
        // Tie-break: when tokens and thinking both unlock by dropping the glyph
        // (preferTokensOverTimerOnly && preferThinkingOverTimerOnly), tokens win.
        // Keep tokens; include timer only when both fit without the glyph.
        // If a suffix is still reserved and cannot share the row with tokens
        // (and timer when both fit), drop it — otherwise Ink wraps/truncates.
        const timerTokensWidth = timerAndTokensFitBare ? timerWidth + sep + tokensWidth : tokensWidth;
        if (showSuffix && bareAvailableSpace < effectiveSuffixWidth + timerTokensWidth) {
          showSuffix = false;
          effectiveSuffixWidth = 0;
        }
        showThinking = false;
        showTimer = Boolean(wantsTimer && (showSuffix ? bareAvailableSpace >= effectiveSuffixWidth + timerWidth + sep + tokensWidth : timerAndTokensFitBare));
        showTokens = true;
        thinkingText = fullThinkingText;
        thinkingWidthValue = fullThinkingWidth;
        usedAfterThinking = effectiveSuffixWidth;
        usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + sep : 0);
      } else if (preferThinkingOverTimerOnly && !bareShowTimer) {
        // Thinking fits bare; timer does not fit alongside — drop timer.
        thinkingText = bareThinkingText ?? fullThinkingText;
        thinkingWidthValue = bareThinkingWidth;
        showThinking = true;
        showTimer = false;
        showTokens = false;
        usedAfterThinking = effectiveSuffixWidth + thinkingWidthValue + sep;
        usedAfterTimer = usedAfterThinking;
      } else {
        thinkingText = bareThinkingText ?? fullThinkingText;
        thinkingWidthValue = bareThinkingWidth;
        showThinking = bareShowThinking;
        usedAfterThinking = bareUsedAfterThinking;
        showTimer = bareShowTimer;
        usedAfterTimer = bareUsedAfterTimer;
        showTokens = bareShowTokens;
      }
    }
  }
  // Drop an overflowing spinner suffix before other recovery so mid-narrow rows
  // can keep tokens/thinking instead of wrapping glyph+suffix-only chrome.
  // Budget must include mode-glyph chrome when reserved — comparing suffix text
  // alone against bare parens leaves glyph+suffix rows that Ink truncates mid-string.
  // Prefer dropping the glyph to keep a suffix that still fits under bare parens.
  const physicalBareBudget = columns - messageWidth - PHYSICAL_BARE_PARENS;
  if (showSuffix) {
    const suffixFitsBare = physicalBareBudget >= suffixTextWidth;
    const suffixFitsWithGlyph = reserveModeGlyph ? physicalBareBudget - MODE_GLYPH_RESERVE >= suffixTextWidth : suffixFitsBare;
    if (!suffixFitsWithGlyph) {
      if (reserveModeGlyph && suffixFitsBare) {
        reserveModeGlyph = false;
        parensWidth = BASE_PARENS_WIDTH;
        availableSpace = columns - messageWidth - BASE_PARENS_WIDTH;
      } else {
        showSuffix = false;
        effectiveSuffixWidth = 0;
      }
    }
  }
  // Prefer live streaming tokens (and active thinking) over a bare-fitting
  // suffix when both cannot share the row. Avoids non-monotonic cliffs where
  // widening from overflow-drop to exact suffix-fit swaps higher-value status
  // for suffix-only chrome.
  if (showSuffix) {
    // Budget companions at the widths actually rendered (or about to be).
    let thinkingWidthForSuffix = 0;
    if (showThinking || wantsThinking) {
      if (typeof thinkingStatus === 'number') {
        thinkingWidthForSuffix = fullThinkingWidth;
      } else if (thinkingStatus === 'thinking') {
        // Effort text may be restored after this pass — budget full width so
        // suffix is not kept when only bare "thinking" fit in the estimate.
        thinkingWidthForSuffix = effortSuffix
          ? Math.max(thinkingWidthValue, fullThinkingWidth)
          : thinkingWidthValue;
      }
    }
    const timerWantedVisible = showTimer || wantsTimer;
    let suffixWithAllVisibleFit = suffixTextWidth;
    if (timerWantedVisible) suffixWithAllVisibleFit += sep + timerWidth;
    if (hasTokenContent) suffixWithAllVisibleFit += sep + tokensWidth;
    if (wantsThinking && (showThinking || thinkingWidthForSuffix > 0)) {
      suffixWithAllVisibleFit += sep + thinkingWidthForSuffix;
    }
    // Use `>` (not `>=`) so exact-fit suffix+thinking does not keep the suffix
    // while glyph chrome still cannot show thinking — avoids a one-column cliff.
    const thinkingWithSuffixFit =
      !wantsThinking ||
      physicalBareBudget > suffixTextWidth + sep + thinkingWidthForSuffix;
    const suffixWithTimerAndThinkingFit =
      !(timerWantedVisible && wantsThinking) ||
      physicalBareBudget >
        suffixTextWidth + sep + timerWidth + sep + thinkingWidthForSuffix;
    if (hasTokenContent && physicalBareBudget >= tokensWidth && physicalBareBudget < suffixWithAllVisibleFit) {
      showSuffix = false;
      effectiveSuffixWidth = 0;
    } else if (
      timerWantedVisible &&
      wantsThinking &&
      physicalBareBudget >= timerWidth + sep + thinkingWidthForSuffix &&
      !suffixWithTimerAndThinkingFit
    ) {
      // Timer+thinking fit without suffix; keep them and drop suffix until all three fit.
      showSuffix = false;
      effectiveSuffixWidth = 0;
    } else if (
      !hasTokenContent &&
      wantsThinking &&
      physicalBareBudget >= thinkingWidthForSuffix &&
      !thinkingWithSuffixFit
    ) {
      showSuffix = false;
      effectiveSuffixWidth = 0;
    }
  }
  // After dropping a crowding suffix (or preferring tokens/thinking over it),
  // recover status primary gating hid while suffix width was reserved.
  // Parts order is timer · tokens · thinking — any co-restore must budget all
  // already-visible parts or Ink wraps on wide timers / early token counts.
  if (!showSuffix) {
    const tokensFitBareAlone = wantsTokens && hasTokenContent && physicalBareBudget >= tokensWidth;
    const timerFitBareAlone = wantsTimer && physicalBareBudget > timerWidth;
    const timerAndTokensFitBare = wantsTimer && hasTokenContent && physicalBareBudget >= timerWidth + sep + tokensWidth;
    const withGlyphSpace = columns - messageWidth - BASE_PARENS_WIDTH - MODE_GLYPH_RESERVE;

    if (!showTokens && !showTimer && !showThinking) {
      if (tokensFitBareAlone) {
        showTokens = true;
        showTimer = Boolean(timerAndTokensFitBare);
        usedAfterThinking = 0;
        usedAfterTimer = showTimer ? timerWidth + sep : 0;
        const recoveredWidth = usedAfterTimer + tokensWidth;
        if (reserveModeGlyph && !(withGlyphSpace > recoveredWidth)) {
          reserveModeGlyph = false;
        }
      } else if (!wantsThinking && timerFitBareAlone) {
        showTimer = true;
        usedAfterThinking = 0;
        usedAfterTimer = timerWidth + sep;
        if (reserveModeGlyph && !(withGlyphSpace > timerWidth)) {
          reserveModeGlyph = false;
        }
      }
    } else if (showTimer && !showTokens && tokensFitBareAlone) {
      // Suffix drop freed budget that primary spent on suffix+timer only.
      const thinkingAndTokensFit =
        showThinking && physicalBareBudget >= thinkingWidthValue + sep + tokensWidth;
      const timerThinkingTokensFit =
        showThinking &&
        physicalBareBudget >= timerWidth + sep + thinkingWidthValue + sep + tokensWidth;
      if (showThinking && timerThinkingTokensFit) {
        showTokens = true;
        usedAfterTimer = timerWidth + sep + tokensWidth;
      } else if (thinkingAndTokensFit) {
        // Prefer tokens + thinking over timer + thinking when timer crowds tokens.
        showTimer = false;
        showTokens = true;
        usedAfterThinking = thinkingWidthValue + sep;
        usedAfterTimer = 0;
      } else if (
        timerAndTokensFitBare &&
        physicalBareBudget >= timerWidth + sep + tokensWidth + (showThinking ? sep + thinkingWidthValue : 0)
      ) {
        showTokens = true;
        usedAfterTimer = timerWidth + sep + tokensWidth;
      } else if (!showThinking) {
        // Prefer tokens over timer-only when both cannot share the row.
        showTimer = false;
        showTokens = true;
        usedAfterThinking = 0;
        usedAfterTimer = 0;
      }
    } else if (showThinking && !showTokens && tokensFitBareAlone) {
      // Thinking recovered after suffix drop — co-restore tokens when they fit.
      let total = thinkingWidthValue + sep + tokensWidth;
      if (showTimer) total += timerWidth + sep;
      if (physicalBareBudget >= total) {
        showTokens = true;
        if (reserveModeGlyph && !(withGlyphSpace > total)) {
          reserveModeGlyph = false;
        }
      }
    } else if (showTokens && !showTimer && wantsTimer) {
      let total = timerWidth + sep + tokensWidth;
      if (showThinking) total += sep + thinkingWidthValue;
      if (physicalBareBudget >= total) {
        if (reserveModeGlyph && !(withGlyphSpace > total)) {
          reserveModeGlyph = false;
        }
        showTimer = true;
        usedAfterThinking = showThinking ? thinkingWidthValue + sep : 0;
        usedAfterTimer = timerWidth + sep + tokensWidth;
      }
    }
  }
  // Prefer live streaming tokens over numeric post-thinking duration when both
  // cannot fit (including when primary already chose duration under the glyph,
  // or when a dropped/crowding suffix hid both). Keep suffix only when it still
  // fits beside tokens.
  let suppressModeGlyphForBareThinking = false;
  if (typeof thinkingStatus === 'number' && hasTokenContent && !showTokens) {
    const tokensFitBareAlone = physicalBareBudget >= tokensWidth;
    const thinkingAndTokensFit = physicalBareBudget >= fullThinkingWidth + sep + tokensWidth;
    const durationShowingWithoutTokens = showThinking && !thinkingAndTokensFit;
    const nothingVisibleYet = !showThinking && !showTimer;
    if (tokensFitBareAlone && !thinkingAndTokensFit && (durationShowingWithoutTokens || nothingVisibleYet)) {
      showThinking = false;
      showTokens = true;
      showTimer = false;
      // reserveModeGlyph=false is enough to keep canShowModeGlyph false.
      reserveModeGlyph = false;
      if (showSuffix && physicalBareBudget < suffixWidth + tokensWidth) {
        showSuffix = false;
        effectiveSuffixWidth = 0;
      }
      usedAfterThinking = effectiveSuffixWidth;
      usedAfterTimer = usedAfterThinking;
    }
  }
  // Thinking-only prefers the mode glyph inside outer parens for leaders
  // ("(↓ · thinking)") when both fit. When full chrome does not fit, fall
  // back to bare "(thinking)" without the glyph (same band as pre-glyph
  // layout) rather than empty glyph-only status. Teammates skip glyph chrome
  // and recover nested "(thinking)" here after suffix overflow drop so
  // stop-hook/tool suffixes do not permanently hide thinking.
  // Allow replacing timer-only chrome when thinking fits (alone or with timer).
  if (!showThinking && wantsThinking && !showSuffix && !showTokens) {
    let recoveredThinking = false;
    if (reserveModeGlyph && !hasRunningTeammates) {
      const leaderThinkingAvailable = columns - messageWidth - leaderThinkingOnlyChrome;
      if (leaderThinkingAvailable >= fullThinkingWidth) {
        thinkingText = fullThinkingText;
        thinkingWidthValue = fullThinkingWidth;
        showThinking = true;
        recoveredThinking = true;
      } else if (thinkingStatus === 'thinking' && effortSuffix && leaderThinkingAvailable >= THINKING_BARE_WIDTH) {
        thinkingText = 'thinking';
        thinkingWidthValue = THINKING_BARE_WIDTH;
        showThinking = true;
        recoveredThinking = true;
      }
    }
    if (!showThinking) {
      // Bare chrome: glimmer trailing space + "(" + ")" (matches physical row).
      // Teammates nest these parens on the thinking word via bareThinkingOnly.
      const bareAvailable = physicalBareBudget;
      const tokensFitBareAlone = wantsTokens && hasTokenContent && bareAvailable >= tokensWidth;
      const thinkingAndTokensFitBare = bareAvailable >= fullThinkingWidth + sep + tokensWidth;
      if (typeof thinkingStatus === 'number' && tokensFitBareAlone && !thinkingAndTokensFitBare && !showTokens) {
        showTokens = true;
        showTimer = false;
        reserveModeGlyph = false;
      } else if (bareAvailable >= fullThinkingWidth) {
        thinkingText = fullThinkingText;
        thinkingWidthValue = fullThinkingWidth;
        showThinking = true;
        suppressModeGlyphForBareThinking = true;
        reserveModeGlyph = false;
        recoveredThinking = true;
      } else if (thinkingStatus === 'thinking' && effortSuffix && bareAvailable >= THINKING_BARE_WIDTH) {
        thinkingText = 'thinking';
        thinkingWidthValue = THINKING_BARE_WIDTH;
        showThinking = true;
        suppressModeGlyphForBareThinking = true;
        reserveModeGlyph = false;
        recoveredThinking = true;
      }
    }
    // If thinking recovered onto a timer-only row, keep timer only when both fit.
    if (recoveredThinking && showTimer) {
      const need = timerWidth + sep + thinkingWidthValue;
      if (physicalBareBudget < need) {
        showTimer = false;
      }
    }
  }
  // After thinking recovery from a dropped suffix, co-restore a fitting timer
  // only when current glyph chrome (or bare, if glyph already dropped) has room —
  // matching the primary `availableSpace > … + timerWidth` gate so we do not
  // strip an already-correct glyph+thinking row or wrap wide timers onto tokens.
  if (!showSuffix && showThinking && !showTimer && wantsTimer) {
    const space = columns - messageWidth - BASE_PARENS_WIDTH - (reserveModeGlyph ? MODE_GLYPH_RESERVE : 0);
    const usedBeforeTimer = (showTokens ? tokensWidth + sep : 0) + thinkingWidthValue + sep;
    if (space > usedBeforeTimer + timerWidth) {
      showTimer = true;
      usedAfterThinking = thinkingWidthValue + sep;
      usedAfterTimer = timerWidth + sep + (showTokens ? tokensWidth : 0);
    }
  }
  // Prefer live tokens over active thinking when both cannot share bare chrome
  // (same tie-break as preferTokensOverTimerOnly). Prevents a widen cliff where
  // tokens visible at cols 25–26 disappear once leader thinking unlocks at 27.
  if (showThinking && !showTokens && thinkingStatus === 'thinking' && hasTokenContent && physicalBareBudget >= tokensWidth) {
    const thinkingAndTokensFit = physicalBareBudget >= thinkingWidthValue + sep + tokensWidth;
    if (!thinkingAndTokensFit) {
      showThinking = false;
      showTokens = true;
      showTimer = Boolean(wantsTimer && physicalBareBudget >= timerWidth + sep + tokensWidth);
      suppressModeGlyphForBareThinking = false;
      reserveModeGlyph = false;
      usedAfterThinking = 0;
      usedAfterTimer = showTimer ? timerWidth + sep : 0;
    }
  }
  // If thinking could not claim an empty post-suffix row, recover timer-only
  // rather than leaving blank / empty glyph-only chrome.
  if (!showSuffix && !showThinking && !showTimer && !showTokens && wantsTimer && physicalBareBudget > timerWidth) {
    showTimer = true;
    const withGlyphSpace = columns - messageWidth - BASE_PARENS_WIDTH - MODE_GLYPH_RESERVE;
    if (reserveModeGlyph && !(withGlyphSpace > timerWidth)) {
      reserveModeGlyph = false;
    }
  }
  // Token recovery can restore content using bare chrome, so a glyph reserved
  // earlier may no longer fit once tokens are visible. Thinking-only layouts
  // have their own looser dedicated chrome budget above.
  const modeGlyphAvailableSpace = columns - messageWidth - BASE_PARENS_WIDTH - MODE_GLYPH_RESERVE;
  let modeGlyphContentWidth = 0;
  if (showTimer) modeGlyphContentWidth += timerWidth;
  if (showTokens) modeGlyphContentWidth += (modeGlyphContentWidth > 0 ? sep : 0) + tokensWidth;
  if (showThinking) modeGlyphContentWidth += (modeGlyphContentWidth > 0 ? sep : 0) + thinkingWidthValue;
  if (reserveModeGlyph && showTokens && !(modeGlyphAvailableSpace > modeGlyphContentWidth)) {
    reserveModeGlyph = false;
  }
  // Restore mode glyph whenever leader content fits under glyph chrome —
  // covers suffix-keep cascades and bare recovery that cleared the glyph.
  if (!showSuffix && !hasRunningTeammates && !suppressModeGlyphForBareThinking && !reserveModeGlyph && (showTokens || showTimer || showThinking)) {
    if (modeGlyphAvailableSpace > modeGlyphContentWidth) {
      reserveModeGlyph = true;
    }
  }
  // Nested "(thinking)" is reserved for teammate spins that skip the mode glyph
  // and therefore have no outer status parens. Leader bare fallback still uses
  // outer parens with just the thinking word: "(thinking)".
  const isThinkingOnlyStatus = showThinking && thinkingStatus === 'thinking' && !showSuffix && !showTimer && !showTokens;
  const bareThinkingOnly = isThinkingOnlyStatus && hasRunningTeammates;
  // Minimum residual for leader status chrome after the glimmer trailing space:
  // " " + "(" + glyph Box(width=2) + ")". Below this, omit the glyph rather
  // than overflow. Also omit when content recovery or bare-thinking fallback
  // dropped the glyph so higher-value status can show.
  const residualForStatus = columns - messageWidth;
  const hasVisibleStatusContent = Boolean(showSuffix) || showTimer || showTokens || showThinking;
  // Requesting and active "thinking" may show glyph-only chrome; completed-thought
  // duration and other states must not render an empty "(↓ )" row.
  const allowGlyphOnlyStatus = (mode === 'requesting' || thinkingStatus === 'thinking') && typeof thinkingStatus !== 'number';
  const canShowModeGlyph = reserveModeGlyph && !suppressModeGlyphForBareThinking && residualForStatus >= 5 && (hasVisibleStatusContent || allowGlyphOnlyStatus);

  // === Thinking shimmer color (formerly ThinkingShimmerText's own timer) ===
  // Same sine-wave opacity, but derived from our shared `time` instead of a
  // second useAnimationFrame(50) subscription.
  const thinkingElapsedSec = (time - THINKING_DELAY_MS) / 1000;
  const thinkingOpacity = time < THINKING_DELAY_MS ? 0 : (Math.sin(thinkingElapsedSec * Math.PI * 2 / THINKING_GLOW_PERIOD_S) + 1) / 2;
  const isUltracodeOverride = overrideColor === 'ultracode';
  const thinkingShimmerColor = getThinkingShimmerColor(theme, isUltracodeOverride, thinkingOpacity);

  // === Build status parts ===
  // bareThinkingOnly nests parens on the thinking word (no outer status parens).
  // Apply in both shimmer and reduced-motion arms so teammate bare status is
  // always "(thinking)", not a bare word jammed after the verb.
  const thinkingDisplay = thinkingText ? bareThinkingOnly ? `(${thinkingText})` : thinkingText : null;
  const parts = [...(showSuffix && spinnerSuffix ? [<Text dimColor key="suffix">
            {spinnerSuffix}
          </Text>] : []), ...(showTimer ? [<Text dimColor key="elapsedTime">
            {timerText}
          </Text>] : []), ...(showTokens ? [<Text dimColor key="tokens">
            {tokensText}
          </Text>] : []), ...(showThinking && thinkingDisplay ? [thinkingStatus === 'thinking' && !reducedMotion ? <Text key="thinking" color={thinkingShimmerColor}>
              {thinkingDisplay}
            </Text> : <Text dimColor key="thinking">
              {thinkingDisplay}
            </Text>] : [])];
  // Lead the status with the request-direction glyph (↑ requesting /
  // ↓ streaming) inside the status parens when residual width allows and the
  // glyph did not force higher-value status (tokens/timer/thinking) off the
  // row. Teammate spins skip it (the teammate tree carries its own cue).
  if (canShowModeGlyph) {
    parts.unshift(<Box flexDirection="row" key="mode">
            <SpinnerModeGlyph mode={mode} />
          </Box>);
  }
  const status = foregroundedTeammate && !foregroundedTeammate.isIdle ? <>
        <Text dimColor>(esc to interrupt </Text>
        <Text color={toInkColor(foregroundedTeammate.identity.color)}>
          {foregroundedTeammate.identity.agentName}
        </Text>
        <Text dimColor>)</Text>
      </> : !foregroundedTeammate && parts.length > 0 ? bareThinkingOnly ? <Byline>{parts}</Byline> : <>
          <Text dimColor>(</Text>
          <Byline>{parts}</Byline>
          <Text dimColor>)</Text>
        </> : null;
  return <FullWidthRow>
      <Box ref={viewportRef} flexDirection="row" flexWrap="nowrap" marginTop={1}>
        <SpinnerGlyph frame={frame} messageColor={messageColor} stalledIntensity={overrideColor ? 0 : stalledIntensity} reducedMotion={reducedMotion} time={time} />
        <GlimmerMessage message={message} mode={mode} messageColor={messageColor} glimmerIndex={glimmerIndex} flashOpacity={flashOpacity} shimmerColor={shimmerColor} stalledIntensity={overrideColor ? 0 : stalledIntensity} />
        {status}
      </Box>
    </FullWidthRow>;
}
function SpinnerModeGlyph(t0) {
  const $ = _c(2);
  const {
    mode
  } = t0;
  switch (mode) {
    case "requesting":
      {
        let t1;
        if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <Box width={2}><Text dimColor={true}>{figures.arrowUp}</Text></Box>;
          $[1] = t1;
        } else {
          t1 = $[1];
        }
        return t1;
      }
    case "tool-input":
    case "tool-use":
    case "responding":
    case "thinking":
    default:
      {
        // Default to down-arrow for known streaming modes and any open-union
        // SpinnerMode string so unmapped modes never unshift an empty child.
        let t1;
        if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <Box width={2}><Text dimColor={true}>{figures.arrowDown}</Text></Box>;
          $[0] = t1;
        } else {
          t1 = $[0];
        }
        return t1;
      }
  }
}
