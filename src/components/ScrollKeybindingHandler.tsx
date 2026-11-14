import React, { type RefObject, useEffect, useRef } from 'react';
import { useNotifications } from '../context/notifications.js';
import { useCopyOnSelect, useSelectionBgColor } from '../hooks/useCopyOnSelect.js';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import { useSelection } from '../ink/hooks/use-selection.js';
import type { FocusMove, SelectionState } from '../ink/selection.js';
import { isXtermJs } from '../ink/terminal.js';
import { getClipboardPath } from '../ink/termio/osc.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- Esc needs conditional propagation based on selection state
import { type Key, useInput } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { getGlobalConfig } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
type Props = {
  scrollRef: RefObject<ScrollBoxHandle | null>;
  isActive: boolean;
  /** Called after every scroll action with the resulting sticky state and
   *  the handle (for reading scrollTop/scrollHeight post-scroll). */
  onScroll?: (sticky: boolean, handle: ScrollBoxHandle) => void;
  /** Enables modal pager keys (g/G, ctrl+u/d/b/f). Only safe when there
   *  is no text input competing for those characters — i.e. transcript
   *  mode. Defaults to false. When true, G works regardless of editorMode
   *  and sticky state; ctrl+u/d/b/f don't conflict with kill-line/exit/
   *  task:background/kill-agents (none are mounted, or they mount after
   *  this component so stopImmediatePropagation wins). */
  isModal?: boolean;
};

// Terminals send one SGR wheel event per intended row (verified in Ghostty
// src/Surface.zig: `for (0..@abs(y.delta)) |_| { mouseReport(.four, ...) }`).
// Ghostty already 3×'s discrete wheel ticks before that loop; trackpad
// precision scroll is pixels/cell_size. 1 event = 1 row intended — use it
// as the base, and ramp a multiplier when events arrive rapidly. The
// pendingScrollDelta accumulator + proportional drain in
// render-node-to-output handles smooth catch-up on big bursts.
//
// xterm.js (VS Code/Cursor/Windsurf integrated terminals) sends exactly 1
// event per wheel notch — no pre-amplification. A separate exponential
// decay curve (below) compensates for the lower event rate, with burst
// detection and gap-dependent caps tuned to VS Code's event patterns.

// Native terminals: hard-window linear ramp. Events closer than the window
// ramp the multiplier; idle gaps reset to `base` (default 1). Some emulators
// pre-multiply at their layer (ghostty discrete=3 sends 3 SGR events/notch;
// iTerm2 "faster scroll" similar) — base=1 is correct there. Others send 1
// event/notch — users on those can set CLAUDE_CODE_SCROLL_SPEED=3 to match
// vim/nvim/opencode app-side defaults. We can't detect which, so knob it.
const WHEEL_ACCEL_WINDOW_MS = 40;
const WHEEL_ACCEL_STEP = 0.3;
const WHEEL_ACCEL_MAX = 6;

// Encoder bounce debounce + wheel-mode decay curve. Worn/cheap optical
// encoders emit spurious reverse-direction ticks during fast spins — measured
// 28% of events on Boris's mouse (2026-03-17, iTerm2). Pattern is always
// flip-then-flip-back; trackpads produce ZERO flips (0/458 in same recording).
// A confirmed bounce proves a physical wheel is attached — engage the same
// exponential-decay curve the xterm.js path uses (it's already tuned), with
// a higher cap to compensate for the lower event rate (~9/sec vs VS Code's
// ~30/sec). Trackpad can't reach this path.
//
// The decay curve gives: 1st click after idle = 1 row (precision), 2nd = 10,
// 3rd = cap. Slowing down decays smoothly toward 1 — no separate idle
// threshold needed, large gaps just have m≈0 → mult→1. Wheel mode is STICKY:
// once a bounce confirms it's a mouse, the decay curve applies until an idle
// gap or trackpad-flick-burst signals a possible device switch.
const WHEEL_BOUNCE_GAP_MAX_MS = 200; // flip-back must arrive within this
// Mouse is ~9 events/sec vs VS Code's ~30 — STEP is 3× xterm.js's 5 to
// compensate. At gap=100ms (m≈0.63): one click gives 1+15*0.63≈10.5.
const WHEEL_MODE_STEP = 15;
const WHEEL_MODE_CAP = 15;
// Max mult growth per event. Without this, the +STEP*m term jumps mult
// from 1→10 in one event when wheelMode engages mid-scroll (bounce
// detected after N events in trackpad mode at mult=1). User sees scroll
// suddenly go 10× faster. Cap=3 gives 1→4→7→10→13→15 over ~0.5s at
// 9 events/sec — smooth ramp instead of a jump. Decay is unaffected
// (target<mult wins the min).
const WHEEL_MODE_RAMP = 3;
// Device-switch disengage: mouse finger-repositions max at ~830ms (measured);
// trackpad between-gesture pauses are 2000ms+. An idle gap above this means
// the user stopped — might have switched devices. Disengage; the next mouse
// bounce re-engages. Trackpad slow swipe (no <5ms bursts, so the burst-count
// guard doesn't catch it) is what this protects against.
const WHEEL_MODE_IDLE_DISENGAGE_MS = 1500;

// xterm.js: exponential decay. momentum=0.5^(gap/hl) — slow click → m≈0
// → mult→1 (precision); fast → m≈1 → carries momentum. Steady-state
// = 1 + step×m/(1-m), capped. Measured event rates in VS Code (wheel.log):
// sustained scroll sends events at 20-50ms gaps (20-40 Hz), plus 0-2ms
// same-batch bursts on flicks. Cap is low (3–6, gap-dependent) because event
// frequency is high — at 40 Hz × 6 = 240 rows/sec max demand, which the
// adaptive drain at ~200fps (measured) handles. Higher cap → pending explosion.
// Tuned empirically (boris 2026-03). See docs/research/terminal-scroll-*.
const WHEEL_DECAY_HALFLIFE_MS = 150;
const WHEEL_DECAY_STEP = 5;
// Same-batch events (<BURST_MS) arrive in one stdin batch — the terminal
// is doing proportional reporting. Treat as 1 row/event like native.
const WHEEL_BURST_MS = 5;
// Cap boundary: slow events (≥GAP_MS) cap low for short smooth drains;
// fast events cap higher for throughput (adaptive drain handles backlog).
const WHEEL_DECAY_GAP_MS = 80;
const WHEEL_DECAY_CAP_SLOW = 3; // gap ≥ GAP_MS: precision
const WHEEL_DECAY_CAP_FAST = 6; // gap < GAP_MS: throughput
// Idle threshold: gaps beyond this reset to the kick value (2) so the
// first click after a pause feels responsive regardless of direction.
const WHEEL_DECAY_IDLE_MS = 500;

/**
 * Whether a keypress should clear the virtual text selection. Mimics
 * native terminal selection: any keystroke clears, EXCEPT modified nav
 * keys (shift/opt/cmd + arrow/home/end/page*). In native macOS contexts,
 * shift+nav extends selection, and cmd/opt+nav are often intercepted by
 * the terminal emulator for scrollback nav — neither disturbs selection.
 * Bare arrows DO clear (user's cursor moves, native deselects). Wheel is
 * excluded — scroll:lineUp/Down already clears via the keybinding path.
 */
export function shouldClearSelectionOnKey(key: Key): boolean {
  if (key.wheelUp || key.wheelDown) return false;
  const isNav = key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end || key.pageUp || key.pageDown;
  if (isNav && (key.shift || key.meta || key.super)) return false;
  return true;
}

/**
 * Map a keypress to a selection focus move (keyboard extension). Only
 * shift extends — that's the universal text-selection modifier. cmd
 * (super) only arrives via kitty keyboard protocol — in most terminals
 * cmd+arrow is intercepted by the emulator and never reaches the pty, so
 * no super branch. shift+home/end covers line-edge jumps (and fn+shift+
 * left/right on mac laptops = shift+home/end). shift+opt (word-jump) not
 * yet implemented — falls through to shouldClearSelectionOnKey which
 * preserves (modified nav). Returns null for non-extend keys.
 */
export function selectionFocusMoveForKey(key: Key): FocusMove | null {
  if (!key.shift || key.meta) return null;
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.home) return 'lineStart';
  if (key.end) return 'lineEnd';
  return null;
}
export type WheelAccelState = {
  time: number;
  mult: number;
  dir: 0 | 1 | -1;
  xtermJs: boolean;
  /** Carried fractional scroll (xterm.js only). scrollBy floors, so without
   *  this a mult of 1.5 gives 1 row every time. Carrying the remainder gives
   *  1,2,1,2 on average for mult=1.5 — correct throughput over time. */
  frac: number;
  /** Native-path baseline rows/event. Reset value on idle/reversal; ramp
   *  builds on top. xterm.js path ignores this (own kick=2 tuning). */
  base: number;
  /** Deferred direction flip (native only). Might be encoder bounce or a
   *  real reversal — resolved by the NEXT event. Real reversal loses 1 row
   *  of latency; bounce is swallowed and triggers wheel mode. The flip's
   *  direction and timestamp are derivable (it's always -state.dir at
   *  state.time) so this is just a marker. */
  pendingFlip: boolean;
  /** Set true once a bounce is confirmed (flip-then-flip-back within
   *  BOUNCE_GAP_MAX). Sticky — but disengaged on idle gap >1500ms OR a
   *  trackpad-signature burst (see burstCount). State lives in a useRef so
   *  it persists across device switches; the disengages handle mouse→trackpad. */
  wheelMode: boolean;
  /** Consecutive <5ms events. Trackpad flick produces 100+ at <5ms; mouse
   *  produces ≤3 (verified in /tmp/wheel-tune.txt). 5+ in a row → trackpad
   *  signature → disengage wheel mode so device-switch doesn't leak mouse
   *  accel to trackpad. */
  burstCount: number;
};

/** Compute rows for one wheel event, mutating accel state. Returns 0 when
 *  a direction flip is deferred for bounce detection — call sites no-op on
 *  step=0 (scrollBy(0) is a no-op, onScroll(false) is idempotent). Exported
 *  for tests. */
export function computeWheelStep(state: WheelAccelState, dir: 1 | -1, now: number): number {
  if (!state.xtermJs) {
    // Device-switch guard ①: idle disengage. Runs BEFORE pendingFlip resolve
    // so a pending bounce (28% of last-mouse-events) doesn't bypass it via
    // the real-reversal early return. state.time is either the last committed
    // event OR the deferred flip — both count as "last activity".
    if (state.wheelMode && now - state.time > WHEEL_MODE_IDLE_DISENGAGE_MS) {
      state.wheelMode = false;
      state.burstCount = 0;
      state.mult = state.base;
    }

    // Resolve any deferred flip BEFORE touching state.time/dir — we need the
    // pre-flip state.dir to distinguish bounce (flip-back) from real reversal
    // (flip persisted), and state.time (= bounce timestamp) for the gap check.
    if (state.pendingFlip) {
      state.pendingFlip = false;
      if (dir !== state.dir || now - state.time > WHEEL_BOUNCE_GAP_MAX_MS) {
        // Real reversal: new dir persisted, OR flip-back arrived too late.
        // Commit. The deferred event's 1 row is lost (acceptable latency).
        state.dir = dir;
        state.time = now;
        state.mult = state.base;
        return Math.floor(state.mult);
      }
      // Bounce confirmed: flipped back to original dir within the window.
      // state.dir/mult unchanged from pre-bounce. state.time was advanced to
      // the bounce below, so gap here = flip-back interval — reflects the
      // user's actual click cadence (bounce IS a physical click, just noisy).
      state.wheelMode = true;
    }
    const gap = now - state.time;
    if (dir !== state.dir && state.dir !== 0) {
      // Flip. Defer — next event decides bounce vs. real reversal. Advance
      // time (but NOT dir/mult): if this turns out to be a bounce, the
      // confirm event's gap will be the flip-back interval, which reflects
      // the user's actual click rate. The bounce IS a physical wheel click,
      // just misread by the encoder — it should count toward cadence.
      state.pendingFlip = true;
      state.time = now;
      return 0;
    }
    state.dir = dir;
    state.time = now;

    // ─── MOUSE (wheel mode, sticky until device-switch signal) ───
    if (state.wheelMode) {
      if (gap < WHEEL_BURST_MS) {
        // Same-batch burst check (ported from xterm.js): iTerm2 proportional
        // reporting sends 2+ SGR events for one detent when macOS gives
        // delta>1. Without this, the 2nd event at gap<1ms has m≈1 → STEP*m=15
        // → one gentle click gives 1+15=16 rows.
        //
        // Device-switch guard ②: trackpad flick produces 100+ events at <5ms
        // (measured); mouse produces ≤3. 5+ consecutive → trackpad flick.
        if (++state.burstCount >= 5) {
          state.wheelMode = false;
          state.burstCount = 0;
          state.mult = state.base;
        } else {
          return 1;
        }
      } else {
        state.burstCount = 0;
      }
    }
    // Re-check: may have disengaged above.
    if (state.wheelMode) {
      // xterm.js decay curve with STEP×3, higher cap. No idle threshold —
      // the curve handles it (gap=1000ms → m≈0.01 → mult≈1). No frac —
      // rounding loss is minor at high mult, and frac persisting across idle
      // was causing off-by-one on the first click back.
      const m = Math.pow(0.5, gap / WHEEL_DECAY_HALFLIFE_MS);
      const cap = Math.max(WHEEL_MODE_CAP, state.base * 2);
      const next = 1 + (state.mult - 1) * m + WHEEL_MODE_STEP * m;
      state.mult = Math.min(cap, next, state.mult + WHEEL_MODE_RAMP);
      return Math.floor(state.mult);
    }

    // ─── TRACKPAD / HI-RES (native, non-wheel-mode) ───
    // Tight 40ms burst window: sub-40ms events ramp, anything slower resets.
    // Trackpad flick delivers 200+ events at <20ms gaps → rails to cap 6.
    // Trackpad slow swipe at 40-400ms gaps → resets every event → 1 row each.
    if (gap > WHEEL_ACCEL_WINDOW_MS) {
      state.mult = state.base;
    } else {
      const cap = Math.max(WHEEL_ACCEL_MAX, state.base * 2);
      state.mult = Math.min(cap, state.mult + WHEEL_ACCEL_STEP);
    }
    return Math.floor(state.mult);
  }

  // ─── VSCODE (xterm.js, browser wheel events) ───
  // Browser wheel events — no encoder bounce, no SGR bursts. Decay curve
  // unchanged from the original tuning. Same formula shape as wheel mode
  // above (keep in sync) but STEP=5 not 15 — higher event rate here.
  const gap = now - state.time;
  const sameDir = dir === state.dir;
  state.time = now;
  state.dir = dir;
  // xterm.js path. Debug log shows two patterns: (a) 20-50ms gaps during
  // sustained scroll (~30 Hz), (b) <5ms same-batch bursts on flicks. For
  // (b) give 1 row/event — the burst count IS the acceleration, same as
  // native. For (a) the decay curve gives 3-5 rows. For sparse events
  // (100ms+, slow deliberate scroll) the curve gives 1-3.
  if (sameDir && gap < WHEEL_BURST_MS) return 1;
  if (!sameDir || gap > WHEEL_DECAY_IDLE_MS) {
    // Direction reversal or long idle: start at 2 (not 1) so the first
    // click after a pause moves a visible amount. Without this, idle-
    // then-resume in the same direction decays to mult≈1 (1 row).
    state.mult = 2;
    state.frac = 0;
  } else {
    const m = Math.pow(0.5, gap / WHEEL_DECAY_HALFLIFE_MS);
    const cap = gap >= WHEEL_DECAY_GAP_MS ? WHEEL_DECAY_CAP_SLOW : WHEEL_DECAY_CAP_FAST;
    state.mult = Math.min(cap, 1 + (state.mult - 1) * m + WHEEL_DECAY_STEP * m);
  }
  const total = state.mult + state.frac;
  const rows = Math.floor(total);
  state.frac = total - rows;
  return rows;
}

export const MAX_SCROLL_SPEED = 20;

function normalizeScrollSpeed(n: number): number {
  return Number.isNaN(n) || n <= 0 ? 1 : Math.min(n, MAX_SCROLL_SPEED);
}

/** Read CLAUDE_CODE_SCROLL_SPEED then the persisted scrollSpeed config,
 *  default 1, clamp (0, MAX_SCROLL_SPEED]. Some terminals pre-multiply
 *  wheel events (ghostty discrete=3, iTerm2 "faster scroll") — base=1 is
 *  correct there. Others send 1 event/notch — set the speed to 3 to match
 *  vim/nvim/opencode. We can't detect which kind of terminal we're in,
 *  hence the knob. Called lazily from initAndLogWheelAccel so
 *  globalSettings.env has loaded. */
export function readScrollSpeedBase(): number {
  const raw = process.env.CLAUDE_CODE_SCROLL_SPEED;
  if (raw) return normalizeScrollSpeed(parseFloat(raw));
  return normalizeScrollSpeed(getGlobalConfig().scrollSpeed ?? 1);
}

/** Initial wheel accel state. xtermJs=true selects the decay curve.
 *  base is the native-path baseline rows/event (default 1). */
export function initWheelAccel(xtermJs = false, base = 1): WheelAccelState {
  return {
    time: 0,
    mult: base,
    dir: 0,
    xtermJs,
    frac: 0,
    base,
    pendingFlip: false,
    wheelMode: false,
    burstCount: 0
  };
}

// Lazy-init helper. isXtermJs() combines the TERM_PROGRAM env check + async
// XTVERSION probe — the probe may not have resolved at render time, so this
// is called on the first wheel event (>>50ms after startup) when it's settled.
// Logs detected mode once so --debug users can verify SSH detection worked.
// The renderer also calls isXtermJsHost() (in render-node-to-output) to
// select the drain algorithm — no state to pass through.
function initAndLogWheelAccel(): WheelAccelState {
  const xtermJs = isXtermJs();
  const base = readScrollSpeedBase();
  logForDebugging(`wheel accel: ${xtermJs ? 'decay (xterm.js)' : 'window (native)'} · base=${base} · TERM_PROGRAM=${process.env.TERM_PROGRAM ?? 'unset'}`);
  return initWheelAccel(xtermJs, base);
}

function syncWheelBaseFromConfig(state: WheelAccelState): void {
  const base = readScrollSpeedBase();
  if (state.base !== base) {
    state.base = base;
    state.mult = base;
  }
}

// Drag-to-scroll: when dragging past the viewport edge, scroll by this many
// rows every AUTOSCROLL_INTERVAL_MS. Mode 1002 mouse tracking only fires on
// cell change, so a timer is needed to continue scrolling while stationary.
const AUTOSCROLL_LINES = 2;
const AUTOSCROLL_INTERVAL_MS = 50;
// Hard cap on consecutive auto-scroll ticks. If the release event is lost
// (mouse released outside terminal window — some emulators don't capture the
// pointer and drop the release), isDragging stays true and the timer would
// run until a scroll boundary. Cap bounds the damage; any new drag motion
// event restarts the count via check()→start().
const AUTOSCROLL_MAX_TICKS = 200; // 10s @ 50ms

/**
 * Keyboard scroll navigation for the fullscreen layout's message scroll box.
 * PgUp/PgDn scroll by half-viewport. Mouse wheel scrolls by a few lines.
 * Scrolling breaks sticky mode; Ctrl+End re-enables it. Wheeling down at
 * the bottom also re-enables sticky so new content follows naturally.
 */
export function ScrollKeybindingHandler({
  scrollRef,
  isActive,
  onScroll,
  isModal = false
}: Props): React.ReactNode {
  const selection = useSelection();
  const {
    addNotification
  } = useNotifications();
  // Lazy-inited on first wheel event so the XTVERSION probe (fired at
  // raw-mode-enable time) has resolved by then — initializing in useRef()
  // would read getWheelBase() before the probe reply arrives over SSH.
  const wheelAccel = useRef<WheelAccelState | null>(null);
  function showCopiedToast(text: string): void {
    // getClipboardPath reads env synchronously — predicts what setClipboard
    // did (native pbcopy / tmux load-buffer / raw OSC 52) so we can tell
    // the user whether paste will Just Work or needs prefix+].
    const path = getClipboardPath();
    const n = text.length;
    let msg: string;
    switch (path) {
      case 'native':
        msg = `copied ${n} chars to clipboard`;
        break;
      case 'tmux-buffer':
        msg = `copied ${n} chars to tmux buffer · paste with prefix + ]`;
        break;
      case 'osc52':
        msg = `sent ${n} chars via OSC 52 · check terminal clipboard settings if paste fails`;
        break;
    }
    addNotification({
      key: 'selection-copied',
      text: msg,
      color: 'suggestion',
      priority: 'immediate',
      timeoutMs: path === 'native' ? 2000 : 4000
    });
  }
  function copyAndToast(): void {
    const text_0 = selection.copySelection();
    if (text_0) showCopiedToast(text_0);
  }

  // Translate selection to track a keyboard page jump. Selection coords are
  // screen-buffer-local; a scrollTo that moves content by N rows must also
  // shift anchor+focus by N so the highlight stays on the same text (native
  // terminal behavior: selection moves with content, clips at viewport
  // edges). Rows that scroll out of the viewport are captured into
  // scrolledOffAbove/Below before the scroll so getSelectedText still
  // returns the full text. Wheel scroll (scroll:lineUp/Down via scrollBy)
  // still clears — its async pendingScrollDelta drain means the actual
  // delta isn't known synchronously (follow-up).
  function translateSelectionForJump(s: ScrollBoxHandle, delta: number): void {
    const sel = selection.getState();
    if (!sel?.anchor || !sel.focus) return;
    const top = s.getViewportTop();
    const bottom = top + s.getViewportHeight() - 1;
    // Only translate if the selection is ON scrollbox content. Selections
    // in the footer/prompt/StickyPromptHeader are on static text — the
    // scroll doesn't move what's under them. Same guard as ink.tsx's
    // auto-follow translate (commit 36a8d154).
    if (sel.anchor.row < top || sel.anchor.row > bottom) return;
    // Cross-boundary: anchor in scrollbox, focus in footer/header. Mirror
    // ink.tsx's Flag-3 guard — fall through without shifting OR capturing.
    // The static endpoint pins the selection; shifting would teleport it
    // into scrollbox content.
    if (sel.focus.row < top || sel.focus.row > bottom) return;
    const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
    const cur = s.getScrollTop() + s.getPendingDelta();
    // Actual scroll distance after boundary clamp. jumpBy may call
    // scrollToBottom when target >= max but the view can't move past max,
    // so the selection shift is bounded here.
    const actual = Math.max(0, Math.min(max, cur + delta)) - cur;
    if (actual === 0) return;
    if (actual > 0) {
      // Scrolling down: content moves up. Rows at the TOP leave viewport.
      // Anchor+focus shift -actual so they track the content that moved up.
      selection.captureScrolledRows(top, top + actual - 1, 'above');
      selection.shiftSelection(-actual, top, bottom);
    } else {
      // Scrolling up: content moves down. Rows at the BOTTOM leave viewport.
      const a = -actual;
      selection.captureScrolledRows(bottom - a + 1, bottom, 'below');
      selection.shiftSelection(a, top, bottom);
    }
  }
  useKeybindings({
    'scroll:pageUp': () => {
      const s_0 = scrollRef.current;
      if (!s_0) return;
      const d = -Math.max(1, Math.floor(s_0.getViewportHeight() / 2));
      translateSelectionForJump(s_0, d);
      const sticky = jumpBy(s_0, d);
      onScroll?.(sticky, s_0);
    },
    'scroll:pageDown': () => {
      const s_1 = scrollRef.current;
      if (!s_1) return;
      const d_0 = Math.max(1, Math.floor(s_1.getViewportHeight() / 2));
      translateSelectionForJump(s_1, d_0);
      const sticky_0 = jumpBy(s_1, d_0);
      onScroll?.(sticky_0, s_1);
    },
    'scroll:lineUp': () => {
      // Wheel: scrollBy accumulates into pendingScrollDelta, drained async
      // by the renderer. captureScrolledRows can't read the outgoing rows
      // before they leave (drain is non-deterministic). Clear for now.
      selection.clearSelection();
      const s_2 = scrollRef.current;
      // Return false (not consumed) when the ScrollBox content fits —
      // scroll would be a no-op. Lets a child component's handler take
      // the wheel event instead (e.g. Settings Config's list navigation
      // inside the centered Modal, where the paginated slice always fits).
      if (!s_2 || s_2.getScrollHeight() <= s_2.getViewportHeight()) return false;
      wheelAccel.current ??= initAndLogWheelAccel();
      syncWheelBaseFromConfig(wheelAccel.current);
      scrollUp(s_2, computeWheelStep(wheelAccel.current, -1, performance.now()));
      onScroll?.(false, s_2);
    },
    'scroll:lineDown': () => {
      selection.clearSelection();
      const s_3 = scrollRef.current;
      if (!s_3 || s_3.getScrollHeight() <= s_3.getViewportHeight()) return false;
      wheelAccel.current ??= initAndLogWheelAccel();
      syncWheelBaseFromConfig(wheelAccel.current);
      const step = computeWheelStep(wheelAccel.current, 1, performance.now());
      const reachedBottom = scrollDown(s_3, step);
      onScroll?.(reachedBottom, s_3);
    },
    'scroll:top': () => {
      const s_4 = scrollRef.current;
      if (!s_4) return;
      translateSelectionForJump(s_4, -(s_4.getScrollTop() + s_4.getPendingDelta()));
      s_4.scrollTo(0);
      onScroll?.(false, s_4);
    },
    'scroll:bottom': () => {
      const s_5 = scrollRef.current;
      if (!s_5) return;
      const max_0 = Math.max(0, s_5.getScrollHeight() - s_5.getViewportHeight());
      translateSelectionForJump(s_5, max_0 - (s_5.getScrollTop() + s_5.getPendingDelta()));
      // scrollTo(max) eager-writes scrollTop so the render-phase sticky
      // follow computes followDelta=0. Without this, scrollToBottom()
      // alone leaves scrollTop stale → followDelta=max-stale →
      // shiftSelectionForFollow applies the SAME shift we already did
      // above, 2× offset. scrollToBottom() then re-enables sticky.
      s_5.scrollTo(max_0);
      s_5.scrollToBottom();
      onScroll?.(true, s_5);
    },
    'selection:copy': copyAndToast
  }, {
    context: 'Scroll',
    isActive
  });

  // scroll:halfPage*/fullPage* have no default key bindings — ctrl+u/d/b/f
  // all have real owners in normal mode (kill-line/exit/task:background/
  // kill-agents). Transcript mode gets them via the isModal raw useInput
  // below. These handlers stay for custom rebinds only.
  useKeybindings({
    'scroll:halfPageUp': () => {
      const s_6 = scrollRef.current;
      if (!s_6) return;
      const d_1 = -Math.max(1, Math.floor(s_6.getViewportHeight() / 2));
      translateSelectionForJump(s_6, d_1);
      const sticky_1 = jumpBy(s_6, d_1);
      onScroll?.(sticky_1, s_6);
    },
    'scroll:halfPageDown': () => {
      const s_7 = scrollRef.current;
      if (!s_7) return;
      const d_2 = Math.max(1, Math.floor(s_7.getViewportHeight() / 2));
      translateSelectionForJump(s_7, d_2);
      const sticky_2 = jumpBy(s_7, d_2);
      onScroll?.(sticky_2, s_7);
    },
    'scroll:fullPageUp': () => {
      const s_8 = scrollRef.current;
      if (!s_8) return;
      const d_3 = -Math.max(1, s_8.getViewportHeight());
      translateSelectionForJump(s_8, d_3);
      const sticky_3 = jumpBy(s_8, d_3);
      onScroll?.(sticky_3, s_8);
    },
    'scroll:fullPageDown': () => {
      const s_9 = scrollRef.current;
      if (!s_9) return;
      const d_4 = Math.max(1, s_9.getViewportHeight());
      translateSelectionForJump(s_9, d_4);
      const sticky_4 = jumpBy(s_9, d_4);
      onScroll?.(sticky_4, s_9);
    }
  }, {
    context: 'Scroll',
    isActive
  });

  // Modal pager keys — transcript mode only. less/tmux copy-mode lineage:
  // ctrl+u/d (half-page), ctrl+b/f (full-page), g/G (top/bottom). Tom's
  // resolution (2026-03-15): "In ctrl-o mode, ctrl-u, ctrl-d, etc. should
  // roughly just work!" — transcript is the copy-mode container.
  //
  // Safe because the conflicting handlers aren't reachable here:
  //   ctrl+u → kill-line, ctrl+d → exit: PromptInput not mounted
  //   ctrl+b → task:background: SessionBackgroundHint not mounted
  //   ctrl+f → chat:killAgents moved to ctrl+x ctrl+k; no conflict
  //   g/G → printable chars: no prompt to eat them, no vim/sticky gate needed
  //
  // Transcript search (`/`, n/N) shipped in REPL.tsx (TranscriptSearchBar +
  // held-key-batched n/N) for the virtual-scroll path. Remaining gap: no
  // search when !virtualScrollActive (legacy non-fullscreen transcript) —
  // intentionally unimplemented; match positions would need re-deriving
  // without VirtualMessageList's jump handle.
  useInput((input, key, event) => {
    const s_10 = scrollRef.current;
    if (!s_10) return;
    const sticky_5 = applyModalPagerAction(s_10, modalPagerAction(input, key), d_5 => translateSelectionForJump(s_10, d_5));
    if (sticky_5 === null) return;
    onScroll?.(sticky_5, s_10);
    event.stopImmediatePropagation();
  }, {
    isActive: isActive && isModal
  });

  // Esc clears selection; any other keystroke also clears it (matches
  // native terminal behavior where selection disappears on input).
  // Ctrl+C copies when a selection exists — needed on legacy terminals
  // where ctrl+shift+c sends the same byte (\x03, shift is lost) and
  // cmd+c never reaches the pty (terminal intercepts it for Edit > Copy).
  // Handled via raw useInput so we can conditionally consume: Esc/Ctrl+C
  // only stop propagation when a selection exists, letting them still work
  // for cancel-request / interrupt otherwise. Other keys never stop
  // propagation — they're observed to clear selection as a side-effect.
  // The selection:copy keybinding (ctrl+shift+c / cmd+c) registers above
  // via useKeybindings and consumes its event before reaching here.
  useInput((input_0, key_0, event_0) => {
    if (!selection.hasSelection()) return;
    if (key_0.escape) {
      selection.clearSelection();
      event_0.stopImmediatePropagation();
      return;
    }
    if (key_0.ctrl && !key_0.shift && !key_0.meta && input_0 === 'c') {
      copyAndToast();
      event_0.stopImmediatePropagation();
      return;
    }
    const move = selectionFocusMoveForKey(key_0);
    if (move) {
      selection.moveFocus(move);
      event_0.stopImmediatePropagation();
      return;
    }
    if (shouldClearSelectionOnKey(key_0)) {
      selection.clearSelection();
    }
  }, {
    isActive
  });
  useDragToScroll(scrollRef, selection, isActive, onScroll);
  useCopyOnSelect(selection, isActive, showCopiedToast);
  useSelectionBgColor(selection);
  return null;
}

/**
 * Auto-scroll the ScrollBox when the user drags a selection past its top or
 * bottom edge. The anchor is shifted in the opposite direction so it stays
 * on the same content (content that was at viewport row N is now at row N±d
 * after scrolling by d). Focus stays at the mouse position (edge row).
 *
 * Selection coords are screen-buffer-local, so the anchor is clamped to the
 * viewport bounds once the original content scrolls out. To preserve the full
 * selection, rows about to scroll out are captured into scrolledOffAbove/
 * scrolledOffBelow before each scroll step and joined back in by
 * getSelectedText.
 */
function useDragToScroll(scrollRef: RefObject<ScrollBoxHandle | null>, selection: ReturnType<typeof useSelection>, isActive: boolean, onScroll: Props['onScroll']): void {
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const dirRef = useRef<-1 | 0 | 1>(0); // -1 scrolling up, +1 down, 0 idle
  // Survives stop() — reset only on drag-finish. See check() for semantics.
  const lastScrolledDirRef = useRef<-1 | 0 | 1>(0);
  const ticksRef = useRef(0);
  // onScroll may change identity every render (if not memoized by caller).
  // Read through a ref so the effect doesn't re-subscribe and kill the timer
  // on each scroll-induced re-render.
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  useEffect(() => {
    if (!isActive) return;
    function stop(): void {
      dirRef.current = 0;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    function tick(): void {
      const sel = selection.getState();
      const s = scrollRef.current;
      const dir = dirRef.current;
      // dir === 0 defends against a stale interval (start() may have set one
      // after the immediate tick already called stop() at a scroll boundary).
      // ticks cap defends against a lost release event (mouse released
      // outside terminal window) leaving isDragging stuck true.
      if (!sel?.isDragging || !sel.focus || !s || dir === 0 || ++ticksRef.current > AUTOSCROLL_MAX_TICKS) {
        stop();
        return;
      }
      // scrollBy accumulates into pendingScrollDelta; the screen buffer
      // doesn't update until the next render drains it. If a previous
      // tick's scroll hasn't drained yet, captureScrolledRows would read
      // stale content (same rows as last tick → duplicated in the
      // accumulator AND missing the rows that actually scrolled out).
      // Skip this tick; the 50ms interval will retry after Ink's 16ms
      // render catches up. Also prevents shiftAnchor from desyncing.
      if (s.getPendingDelta() !== 0) return;
      const top = s.getViewportTop();
      const bottom = top + s.getViewportHeight() - 1;
      // Clamp anchor within [top, bottom]. Not [0, bottom]: the ScrollBox
      // padding row at 0 would produce a blank line between scrolledOffAbove
      // and the on-screen content in getSelectedText. The padding-row
      // highlight was a minor visual nicety; text correctness wins.
      if (dir < 0) {
        if (s.getScrollTop() <= 0) {
          stop();
          return;
        }
        // Scrolling up: content moves down in viewport, so anchor row +N.
        // Clamp to actual scroll distance so anchor stays in sync when near
        // the top boundary (renderer clamps scrollTop to 0 on drain).
        const actual = Math.min(AUTOSCROLL_LINES, s.getScrollTop());
        // Capture rows about to scroll out the BOTTOM before scrollBy
        // overwrites them. Only rows inside the selection are captured
        // (captureScrolledRows intersects with selection bounds).
        selection.captureScrolledRows(bottom - actual + 1, bottom, 'below');
        selection.shiftAnchor(actual, 0, bottom);
        s.scrollBy(-AUTOSCROLL_LINES);
      } else {
        const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
        if (s.getScrollTop() >= max) {
          stop();
          return;
        }
        // Scrolling down: content moves up in viewport, so anchor row -N.
        // Clamp to actual scroll distance so anchor stays in sync when near
        // the bottom boundary (renderer clamps scrollTop to max on drain).
        const actual_0 = Math.min(AUTOSCROLL_LINES, max - s.getScrollTop());
        // Capture rows about to scroll out the TOP.
        selection.captureScrolledRows(top, top + actual_0 - 1, 'above');
        selection.shiftAnchor(-actual_0, top, bottom);
        s.scrollBy(AUTOSCROLL_LINES);
      }
      onScrollRef.current?.(false, s);
    }
    function start(dir_0: -1 | 1): void {
      // Record BEFORE early-return: the empty-accumulator reset in check()
      // may have zeroed this during the pre-crossing phase (accumulators
      // empty until the anchor row enters the capture range). Re-record
      // on every call so the corruption is instantly healed.
      lastScrolledDirRef.current = dir_0;
      if (dirRef.current === dir_0) return; // already going this way
      stop();
      dirRef.current = dir_0;
      ticksRef.current = 0;
      tick();
      // tick() may have hit a scroll boundary and called stop() (dir reset to
      // 0). Only start the interval if we're still going — otherwise the
      // interval would run forever with dir === 0 doing nothing useful.
      if (dirRef.current === dir_0) {
        timerRef.current = setInterval(tick, AUTOSCROLL_INTERVAL_MS);
      }
    }

    // Re-evaluated on every selection change (start/drag/finish/clear).
    // Drives drag-to-scroll autoscroll when the drag leaves the viewport.
    // Prior versions broke sticky here on drag-start to prevent selection
    // drift during streaming — ink.tsx now translates selection coords by
    // the follow delta instead (native terminal behavior: view keeps
    // scrolling, highlight walks up with the text). Keeping sticky also
    // avoids useVirtualScroll's tail-walk → forward-walk phantom growth.
    function check(): void {
      const s_0 = scrollRef.current;
      if (!s_0) {
        stop();
        return;
      }
      const top_0 = s_0.getViewportTop();
      const bottom_0 = top_0 + s_0.getViewportHeight() - 1;
      const sel_0 = selection.getState();
      // Pass the LAST-scrolled direction (not dirRef) so the anchor guard is
      // bypassed after shiftAnchor has clamped anchor toward row 0. Using
      // lastScrolledDirRef (survives stop()) lets autoscroll resume after a
      // brief mouse dip into the viewport. Same-direction only — a mouse
      // jump from below-bottom to above-top must stop, since reversing while
      // the scrolledOffAbove/Below accumulators hold the prior direction's
      // rows would duplicate text in getSelectedText. Reset on drag-finish
      // OR when both accumulators are empty: startSelection clears them
      // (selection.ts), so a new drag after a lost-release (isDragging
      // stuck true, the reason AUTOSCROLL_MAX_TICKS exists) still resets.
      // Safe: start() below re-records lastScrolledDirRef before its
      // early-return, so a mid-scroll reset here is instantly undone.
      if (!sel_0?.isDragging || sel_0.scrolledOffAbove.length === 0 && sel_0.scrolledOffBelow.length === 0) {
        lastScrolledDirRef.current = 0;
      }
      const dir_1 = dragScrollDirection(sel_0, top_0, bottom_0, lastScrolledDirRef.current);
      if (dir_1 === 0) {
        // Blocked reversal: focus jumped to the opposite edge (off-window
        // drag return, fast flick). handleSelectionDrag already moved focus
        // past the anchor, flipping selectionBounds — the accumulator is
        // now orphaned (holds rows on the wrong side). Clear it so
        // getSelectedText matches the visible highlight.
        if (lastScrolledDirRef.current !== 0 && sel_0?.focus) {
          const want = sel_0.focus.row < top_0 ? -1 : sel_0.focus.row > bottom_0 ? 1 : 0;
          if (want !== 0 && want !== lastScrolledDirRef.current) {
            sel_0.scrolledOffAbove = [];
            sel_0.scrolledOffBelow = [];
            sel_0.scrolledOffAboveSW = [];
            sel_0.scrolledOffBelowSW = [];
            lastScrolledDirRef.current = 0;
          }
        }
        stop();
      } else start(dir_1);
    }
    const unsubscribe = selection.subscribe(check);
    return () => {
      unsubscribe();
      stop();
      lastScrolledDirRef.current = 0;
    };
  }, [isActive, scrollRef, selection]);
}

/**
 * Compute autoscroll direction for a drag selection relative to the ScrollBox
 * viewport. Returns 0 when not dragging, anchor/focus missing, or the anchor
 * is outside the viewport — a multi-click or drag that started in the input
 * area must not commandeer the message scroll (double-click in the input area
 * while scrolled up previously corrupted the anchor via shiftAnchor and
 * spuriously scrolled the message history every 50ms until release).
 *
 * alreadyScrollingDir bypasses the anchor-in-viewport guard once autoscroll
 * is active (shiftAnchor legitimately clamps the anchor toward row 0, below
 * `top`) but only allows SAME-direction continuation. If the focus jumps to
 * the opposite edge (below→above or above→below — possible with a fast flick
 * or off-window drag since mode 1002 reports on cell change, not per cell),
 * returns 0 to stop — reversing without clearing scrolledOffAbove/Below
 * would duplicate captured rows when they scroll back on-screen.
 */
export function dragScrollDirection(sel: SelectionState | null, top: number, bottom: number, alreadyScrollingDir: -1 | 0 | 1 = 0): -1 | 0 | 1 {
  if (!sel?.isDragging || !sel.anchor || !sel.focus) return 0;
  const row = sel.focus.row;
  const want: -1 | 0 | 1 = row < top ? -1 : row > bottom ? 1 : 0;
  if (alreadyScrollingDir !== 0) {
    // Same-direction only. Focus on the opposite side, or back inside the
    // viewport, stops the scroll — captured rows stay in scrolledOffAbove/
    // Below but never scroll back on-screen, so getSelectedText is correct.
    return want === alreadyScrollingDir ? want : 0;
  }
  // Anchor must be inside the viewport for us to own this drag. If the
  // user started selecting in the input box or header, autoscrolling the
  // message history is surprising and corrupts the anchor via shiftAnchor.
  if (sel.anchor.row < top || sel.anchor.row > bottom) return 0;
  return want;
}

// Keyboard page jumps: scrollTo() writes scrollTop directly and clears
// pendingScrollDelta — one frame, no drain. scrollBy() accumulates into
// pendingScrollDelta which the renderer drains over several frames
// (render-node-to-output.ts drainProportional/drainAdaptive) — correct for
// wheel smoothness, wrong for PgUp/ctrl+u where the user expects a snap.
// Target is relative to scrollTop+pendingDelta so a jump mid-wheel-burst
// lands where the wheel was heading.
export function jumpBy(s: ScrollBoxHandle, delta: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
  const target = s.getScrollTop() + s.getPendingDelta() + delta;
  if (target >= max) {
    // Eager-write scrollTop so follow-scroll sees followDelta=0. Callers
    // that ran translateSelectionForJump already shifted; scrollToBottom()
    // alone would double-shift via the render-phase sticky follow.
    s.scrollTo(max);
    s.scrollToBottom();
    return true;
  }
  s.scrollTo(Math.max(0, target));
  return false;
}

// Wheel-down past maxScroll re-enables sticky so wheeling at the bottom
// naturally re-pins (matches typical chat-app behavior). Returns the
// resulting sticky state so callers can propagate it.
function scrollDown(s: ScrollBoxHandle, amount: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
  // Include pendingDelta: scrollBy accumulates into pendingScrollDelta
  // without updating scrollTop, so getScrollTop() alone is stale within
  // a batch of wheel events. Without this, wheeling to the bottom never
  // re-enables sticky scroll.
  const effectiveTop = s.getScrollTop() + s.getPendingDelta();
  if (effectiveTop + amount >= max) {
    s.scrollToBottom();
    return true;
  }
  s.scrollBy(amount);
  return false;
}

// Wheel-up past scrollTop=0 clamps via scrollTo(0), clearing
// pendingScrollDelta so aggressive wheel bursts (e.g. MX Master free-spin)
// don't accumulate an unbounded negative delta. Without this clamp,
// useVirtualScroll's [effLo, effHi] span grows past what MAX_MOUNTED_ITEMS
// can cover and intermediate drain frames render at scrollTops with no
// mounted children — blank viewport.
export function scrollUp(s: ScrollBoxHandle, amount: number): void {
  // Include pendingDelta: scrollBy accumulates without updating scrollTop,
  // so getScrollTop() alone is stale within a batch of wheel events.
  const effectiveTop = s.getScrollTop() + s.getPendingDelta();
  if (effectiveTop - amount <= 0) {
    s.scrollTo(0);
    return;
  }
  s.scrollBy(-amount);
}
export type ModalPagerAction = 'lineUp' | 'lineDown' | 'halfPageUp' | 'halfPageDown' | 'fullPageUp' | 'fullPageDown' | 'top' | 'bottom';

/**
 * Maps a keystroke to a modal pager action. Exported for testing.
 * Returns null for keys the modal pager doesn't handle (they fall through).
 *
 * ctrl+u/d/b/f are the less-lineage bindings. g/G are bare letters (only
 * safe when no prompt is mounted). G arrives as input='G' shift=false on
 * legacy terminals, or input='g' shift=true on kitty-protocol terminals.
 * Lowercase g needs the !shift guard so it doesn't also match kitty-G.
 *
 * Key-repeat: stdin coalesces held-down printables into one multi-char
 * string (e.g. 'ggg'). Only uniform-char batches are handled — mixed input
 * like 'gG' isn't key-repeat. g/G are idempotent absolute jumps, so the
 * count is irrelevant (consuming the batch just prevents it from leaking
 * to the selection-clear-on-printable handler).
 */
export function modalPagerAction(input: string, key: Pick<Key, 'ctrl' | 'meta' | 'shift' | 'upArrow' | 'downArrow' | 'home' | 'end'>): ModalPagerAction | null {
  if (key.meta) return null;
  // Special keys first — arrows/home/end arrive with empty or junk input,
  // so these must be checked before any input-string logic. shift is
  // reserved for selection-extend (selectionFocusMoveForKey); ctrl+home/end
  // already has a useKeybindings route to scroll:top/bottom.
  if (!key.ctrl && !key.shift) {
    if (key.upArrow) return 'lineUp';
    if (key.downArrow) return 'lineDown';
    if (key.home) return 'top';
    if (key.end) return 'bottom';
  }
  if (key.ctrl) {
    if (key.shift) return null;
    switch (input) {
      case 'u':
        return 'halfPageUp';
      case 'd':
        return 'halfPageDown';
      case 'b':
        return 'fullPageUp';
      case 'f':
        return 'fullPageDown';
      // emacs-style line scroll (less accepts both ctrl+n/p and ctrl+e/y).
      // Works during search nav — fine-adjust after a jump without
      // leaving modal. No !searchOpen gate on this useInput's isActive.
      case 'n':
        return 'lineDown';
      case 'p':
        return 'lineUp';
      default:
        return null;
    }
  }
  // Bare letters. Key-repeat batches: only act on uniform runs.
  const c = input[0];
  if (!c || input !== c.repeat(input.length)) return null;
  // kitty sends G as input='g' shift=true; legacy as 'G' shift=false.
  // Check BEFORE the shift-gate so both hit 'bottom'.
  if (c === 'G' || c === 'g' && key.shift) return 'bottom';
  if (key.shift) return null;
  switch (c) {
    case 'g':
      return 'top';
    // j/k re-added per Tom Mar 18 — reversal of Mar 16 removal. Works
    // during search nav (fine-adjust after n/N lands) since isModal is
    // independent of searchOpen.
    case 'j':
      return 'lineDown';
    case 'k':
      return 'lineUp';
    // less: space = page down, b = page up. ctrl+b already maps above;
    // bare b is the less-native version.
    case ' ':
      return 'fullPageDown';
    case 'b':
      return 'fullPageUp';
    default:
      return null;
  }
}

/**
 * Applies a modal pager action to a ScrollBox. Returns the resulting sticky
 * state, or null if the action was null (nothing to do — caller should fall
 * through). Calls onBeforeJump(delta) before scrolling so the caller can
 * translate the text selection by the scroll delta (capture outgoing rows,
 * shift anchor+focus) instead of clearing it. Exported for testing.
 */
export function applyModalPagerAction(s: ScrollBoxHandle, act: ModalPagerAction | null, onBeforeJump: (delta: number) => void): boolean | null {
  switch (act) {
    case null:
      return null;
    case 'lineUp':
    case 'lineDown':
      {
        const d = act === 'lineDown' ? 1 : -1;
        onBeforeJump(d);
        return jumpBy(s, d);
      }
    case 'halfPageUp':
    case 'halfPageDown':
      {
        const half = Math.max(1, Math.floor(s.getViewportHeight() / 2));
        const d = act === 'halfPageDown' ? half : -half;
        onBeforeJump(d);
        return jumpBy(s, d);
      }
    case 'fullPageUp':
    case 'fullPageDown':
      {
        const page = Math.max(1, s.getViewportHeight());
        const d = act === 'fullPageDown' ? page : -page;
        onBeforeJump(d);
        return jumpBy(s, d);
      }
    case 'top':
      onBeforeJump(-(s.getScrollTop() + s.getPendingDelta()));
      s.scrollTo(0);
      return false;
    case 'bottom':
      {
        const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
        onBeforeJump(max - (s.getScrollTop() + s.getPendingDelta()));
        // Eager-write scrollTop before scrollToBottom — same double-shift
        // fix as scroll:bottom and jumpBy's max branch.
        s.scrollTo(max);
        s.scrollToBottom();
        return true;
      }
  }
}
