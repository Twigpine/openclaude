import React, { PureComponent, type ReactNode } from 'react';
import { updateLastInteractionTime } from '../../bootstrap/state.js';
import { stopCapturingEarlyInput } from '../../utils/earlyInput.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isMouseClicksDisabled } from '../../utils/fullscreen.js';
import { logForDebugging } from '../../utils/debug.js';
import { logError } from '../../utils/log.js';
import { EventEmitter } from '../events/emitter.js';
import { InputEvent } from '../events/input-event.js';
import { TerminalFocusEvent } from '../events/terminal-focus-event.js';
import { INITIAL_STATE, type ParsedInput, type ParsedKey, type ParsedMouse, parseMultipleKeypresses } from '../parse-keypress.js';
import reconciler from '../reconciler.js';
import { finishSelection, hasSelection, type SelectionState, startSelection } from '../selection.js';
import { isXtermJs, setXtversionName, supportsExtendedKeys } from '../terminal.js';
import { getTerminalFocused, setTerminalFocused } from '../terminal-focus-state.js';
import { TerminalQuerier, xtversion } from '../terminal-querier.js';
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS, FOCUS_IN, FOCUS_OUT } from '../termio/csi.js';
import { DBP, DFE, DISABLE_MOUSE_TRACKING, EBP, EFE, HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js';
import AppContext from './AppContext.js';
import { ClockProvider } from './ClockContext.js';
import CursorDeclarationContext, { type CursorDeclarationSetter } from './CursorDeclarationContext.js';
import ErrorOverview from './ErrorOverview.js';
import StdinContext from './StdinContext.js';
import { TerminalFocusProvider } from './TerminalFocusContext.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';

// Platforms that support Unix-style process suspension (SIGSTOP/SIGCONT)
const SUPPORTS_SUSPEND = process.platform !== 'win32';

// After this many milliseconds of stdin silence, the next chunk triggers
// a terminal mode re-assert (mouse tracking). Catches tmux detach→attach,
// ssh reconnect, and laptop wake — the terminal resets DEC private modes
// but no signal reaches us. 5s is well above normal inter-keystroke gaps
// but short enough that the first scroll after reattach works.
const STDIN_RESUME_GAP_MS = 5000;
type Props = {
  readonly children: ReactNode;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly exitOnCtrlC: boolean;
  readonly onExit: (error?: Error) => void;
  readonly terminalColumns: number;
  readonly terminalRows: number;
  // Text selection state. App mutates this directly from mouse events
  // and calls onSelectionChange to trigger a repaint. Mouse events only
  // arrive when <AlternateScreen> (or similar) enables mouse tracking,
  // so the handler is always wired but dormant until tracking is on.
  readonly selection: SelectionState;
  readonly onSelectionChange: () => void;
  // Dispatch a click at (col, row) — hit-tests the DOM tree and bubbles
  // onClick handlers. Returns true if a DOM handler consumed the click.
  // No-op (returns false) outside fullscreen mode (Ink.dispatchClick
  // gates on altScreenActive).
  readonly onClickAt: (col: number, row: number) => boolean;
  // Dispatch hover (onMouseEnter/onMouseLeave) as the pointer moves over
  // DOM elements. Called for mode-1003 motion events with no button held.
  // No-op outside fullscreen (Ink.dispatchHover gates on altScreenActive).
  readonly onHoverAt: (col: number, row: number) => void;
  // Look up the OSC 8 hyperlink at (col, row) synchronously at click
  // time. Returns the URL or undefined. The browser-open is deferred by
  // MULTI_CLICK_TIMEOUT_MS so double-click can cancel it.
  readonly getHyperlinkAt: (col: number, row: number) => string | undefined;
  // Open a hyperlink URL in the browser. Called after the timer fires.
  readonly onOpenHyperlink: (url: string) => void;
  // Called on double/triple-click PRESS at (col, row). count=2 selects
  // the word under the cursor; count=3 selects the line. Ink reads the
  // screen buffer to find word/line boundaries and mutates selection,
  // setting isDragging=true so a subsequent drag extends by word/line.
  readonly onMultiClick: (col: number, row: number, count: 2 | 3) => void;
  // Called on drag-motion. Mode-aware: char mode updates focus to the
  // exact cell; word/line mode snaps to word/line boundaries. Needs
  // screen-buffer access (word boundaries) so lives on Ink, not here.
  readonly onSelectionDrag: (col: number, row: number) => void;
  // Called when stdin data arrives after a >STDIN_RESUME_GAP_MS gap.
  // Ink re-asserts terminal modes: extended key reporting, and (when in
  // fullscreen) re-enters alt-screen + mouse tracking. Idempotent on the
  // terminal side. Optional so testing.tsx doesn't need to stub it.
  readonly onStdinResume?: () => void;
  // Receives the declared native-cursor position from useDeclaredCursor
  // so ink.tsx can park the terminal cursor there after each frame.
  // Enables IME composition at the input caret and lets screen readers /
  // magnifiers track the input. Optional so testing.tsx doesn't stub it.
  readonly onCursorDeclaration?: CursorDeclarationSetter;
  // Dispatch a keyboard event through the DOM tree. Called for each
  // parsed key alongside the legacy EventEmitter path.
  readonly dispatchKeyboardEvent: (parsedKey: ParsedKey) => void;
};

// Multi-click detection thresholds. 500ms is the macOS default; a small
// position tolerance allows for trackpad jitter between clicks.
const MULTI_CLICK_TIMEOUT_MS = 500;
const MULTI_CLICK_DISTANCE = 1;
type State = {
  readonly error?: Error;
};

// Root component for all Ink apps
// It renders stdin and stdout contexts, so that children can access them if needed
// It also handles Ctrl+C exiting and cursor visibility
export default class App extends PureComponent<Props, State> {
  static displayName = 'InternalApp';
  static getDerivedStateFromError(error: Error) {
    return {
      error
    };
  }
  override state = {
    error: undefined
  };

  // Count how many components enabled raw mode to avoid disabling
  // raw mode until all components don't need it anymore
  rawModeEnabledCount = 0;
  internal_eventEmitter = new EventEmitter();
  keyParseState = INITIAL_STATE;
  // Timer for flushing incomplete escape sequences
  incompleteEscapeTimer: NodeJS.Timeout | null = null;
  // Default to readable-mode stdin (legacy Ink behavior). The data-mode path
  // is kept as an explicit opt-in because some terminals can enter a state
  // where startup input appears frozen when data mode is the default.
  stdinMode: 'readable' | 'data' = process.env.OPENCLAUDE_USE_DATA_STDIN === '1' || process.env.OPENCLAUDE_USE_READABLE_STDIN === '0' ? 'data' : 'readable';
  // Timeout durations for incomplete sequences (ms)
  // NORMAL_TIMEOUT must exceed IME composition gaps: Vietnamese Telex/VNI
  // and CJK IMEs emit multi-byte UTF-8 / CSI-u sequences whose halves can
  // arrive with inter-chunk pauses. Flushing at 50ms split those sequences
  // into garbage keys (#2018); 300ms gives composition room while keeping
  // lone-escape detection acceptable.
  readonly NORMAL_TIMEOUT = 300;
  readonly PASTE_TIMEOUT = 1000; // Longer timeout for paste operations

  // Terminal query/response dispatch. Responses arrive on stdin (parsed
  // out by parse-keypress) and are routed to pending promise resolvers.
  querier = new TerminalQuerier(this.props.stdout);

  // Multi-click tracking for double/triple-click text selection. A click
  // within MULTI_CLICK_TIMEOUT_MS and MULTI_CLICK_DISTANCE of the previous
  // click increments clickCount; otherwise it resets to 1.
  lastClickTime = 0;
  lastClickCol = -1;
  lastClickRow = -1;
  clickCount = 0;
  // Deferred hyperlink-open timer — cancelled if a second click arrives
  // within MULTI_CLICK_TIMEOUT_MS (so double-clicking a hyperlink selects
  // the word without also opening the browser). DOM onClick dispatch is
  // NOT deferred — it returns true from onClickAt and skips this timer.
  pendingHyperlinkTimer: ReturnType<typeof setTimeout> | null = null;
  // Last mode-1003 motion position. Terminals already dedupe to cell
  // granularity but this also lets us skip dispatchHover entirely on
  // repeat events (drag-then-release at same cell, etc.).
  lastHoverCol = -1;
  lastHoverRow = -1;

  // Timestamp of last stdin chunk. Used to detect long gaps (tmux attach,
  // ssh reconnect, laptop wake) and trigger terminal mode re-assert.
  // Initialized to now so startup doesn't false-trigger.
  lastStdinTime = Date.now();

  // Determines if TTY is supported on the provided stdin
  isRawModeSupported(): boolean {
    return this.props.stdin.isTTY;
  }
  override render() {
    return <TerminalSizeContext.Provider value={{
      columns: this.props.terminalColumns,
      rows: this.props.terminalRows
    }}>
        <AppContext.Provider value={{
        exit: this.handleExit
      }}>
          <StdinContext.Provider value={{
          stdin: this.props.stdin,
          setRawMode: this.handleSetRawMode,
          isRawModeSupported: this.isRawModeSupported(),
          internal_exitOnCtrlC: this.props.exitOnCtrlC,
          internal_eventEmitter: this.internal_eventEmitter,
          internal_querier: this.querier
        }}>
            <TerminalFocusProvider>
              <ClockProvider>
                <CursorDeclarationContext.Provider value={this.props.onCursorDeclaration ?? (() => {})}>
                  {this.state.error ? <ErrorOverview error={this.state.error as Error} /> : this.props.children}
                </CursorDeclarationContext.Provider>
              </ClockProvider>
            </TerminalFocusProvider>
          </StdinContext.Provider>
        </AppContext.Provider>
      </TerminalSizeContext.Provider>;
  }
  override componentDidMount() {
    // In accessibility mode, keep the native cursor visible for screen magnifiers and other tools
    if (this.props.stdout.isTTY && !isEnvTruthy(process.env.CLAUDE_CODE_ACCESSIBILITY)) {
      this.props.stdout.write(HIDE_CURSOR);
    }
  }
  override componentWillUnmount() {
    if (this.props.stdout.isTTY) {
      this.props.stdout.write(SHOW_CURSOR);
    }

    // Clear any pending timers
    if (this.incompleteEscapeTimer) {
      clearTimeout(this.incompleteEscapeTimer);
      this.incompleteEscapeTimer = null;
    }
    if (this.pendingHyperlinkTimer) {
      clearTimeout(this.pendingHyperlinkTimer);
      this.pendingHyperlinkTimer = null;
    }
    // ignore calling setRawMode on an handle stdin it cannot be called
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false);
    }
  }
  override componentDidCatch(error: Error) {
    logError(error);
    this.handleExit(error);
  }
  handleSetRawMode = (isEnabled: boolean): void => {
    const {
      stdin
    } = this.props;
    if (!this.isRawModeSupported()) {
      if (stdin === process.stdin) {
        throw new Error('Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported');
      } else {
        throw new Error('Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported');
      }
    }
    stdin.setEncoding('utf8');
    if (isEnabled) {
      // Guard against negative count from async races or effect cleanup bugs.
      // If count is negative, reset to 0 so setup runs on this enable.
      if (this.rawModeEnabledCount < 0) {
        logForDebugging(`handleSetRawMode: recovering rawModeEnabledCount from ${this.rawModeEnabledCount} to 0`);
        this.rawModeEnabledCount = 0;
      }

      // Ensure raw mode is enabled only once
      if (this.rawModeEnabledCount === 0) {
        // Stop early input capture right before we add our own readable handler.
        // Both use the same stdin 'readable' + read() pattern, so they can't
        // coexist -- our handler would drain stdin before Ink's can see it.
        // The buffered text is preserved for REPL.tsx via consumeEarlyInput().
        stopCapturingEarlyInput();
        stdin.ref();
        stdin.setRawMode(true);
        if (this.stdinMode === 'data') {
          stdin.addListener('data', this.handleDataChunk);
          stdin.resume();
        } else {
          stdin.addListener('readable', this.handleReadable);
        }
        // Enable bracketed paste mode
        this.props.stdout.write(EBP);
        // Enable terminal focus reporting (DECSET 1004)
        this.props.stdout.write(EFE);
        // Enable extended key reporting so ctrl+shift+<letter> is
        // distinguishable from ctrl+<letter>. We write both the kitty stack
        // push (CSI >1u) and xterm modifyOtherKeys level 2 (CSI >4;2m) —
        // terminals honor whichever they implement (tmux only accepts the
        // latter).
        if (supportsExtendedKeys()) {
          this.props.stdout.write(ENABLE_KITTY_KEYBOARD);
          this.props.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
        }
        // Probe terminal identity. XTVERSION survives SSH (query/reply goes
        // through the pty), unlike TERM_PROGRAM. Used for wheel-scroll base
        // detection when env vars are absent. Fire-and-forget: the DA1
        // sentinel bounds the round-trip, and if the terminal ignores the
        // query, flush() still resolves and name stays undefined.
        // Deferred to next tick so it fires AFTER the current synchronous
        // init sequence completes — avoids interleaving with alt-screen/mouse
        // tracking enable writes that may happen in the same render cycle.
        setImmediate(() => {
          void Promise.all([this.querier.send(xtversion()), this.querier.flush()]).then(([r]) => {
            if (r) {
              setXtversionName(r.name);
              logForDebugging(`XTVERSION: terminal identified as "${r.name}"`);
            } else {
              logForDebugging('XTVERSION: no reply (terminal ignored query)');
            }
          });
        });
      }
      this.rawModeEnabledCount++;
      return;
    }

    // Guard against unbalanced disable calls (e.g. from rapid mount/unmount
    // during MCP-driven re-renders). Prevent count from going negative.
    if (this.rawModeEnabledCount <= 0) {
      logForDebugging(`handleSetRawMode: ignoring disable call with count=${this.rawModeEnabledCount}`);
      return;
    }

    // Disable raw mode only when no components left that are using it
    if (--this.rawModeEnabledCount === 0) {
      this.props.stdout.write(DISABLE_MODIFY_OTHER_KEYS);
      this.props.stdout.write(DISABLE_KITTY_KEYBOARD);
      // Disable terminal focus reporting (DECSET 1004)
      this.props.stdout.write(DFE);
      // Disable bracketed paste mode
      this.props.stdout.write(DBP);
      stdin.setRawMode(false);
      stdin.removeListener('readable', this.handleReadable);
      stdin.removeListener('data', this.handleDataChunk);
      stdin.pause();
      stdin.unref();
    }
  };

  // Helper to flush incomplete escape sequences
  flushIncomplete = (): void => {
    // Clear the timer reference
    this.incompleteEscapeTimer = null;

    // Only proceed if we have incomplete sequences
    if (!this.keyParseState.incomplete) return;

    // Fullscreen: if stdin has data waiting, it's almost certainly the
    // continuation of the buffered sequence (e.g. `[<64;74;16M` after a
    // lone ESC). Node's event loop runs the timers phase before the poll
    // phase, so when a heavy render blocks the loop past 50ms, this timer
    // fires before the queued readable event even though the bytes are
    // already buffered. Re-arm instead of flushing: handleReadable will
    // drain stdin next and clear this timer. Prevents both the spurious
    // Escape key and the lost scroll event.
    if (this.props.stdin.readableLength > 0) {
      this.incompleteEscapeTimer = setTimeout(this.flushIncomplete, this.NORMAL_TIMEOUT);
      return;
    }

    // Process incomplete as a flush operation (input=null)
    // This reuses all existing parsing logic
    this.processInput(null);
  };

  // Process input through the parser and handle the results
  processInput = (input: string | Buffer | null): void => {
    // Parse input using our state machine
    const [keys, newState] = parseMultipleKeypresses(this.keyParseState, input);
    this.keyParseState = newState;

    // Process ALL keys in a SINGLE discreteUpdates call to prevent
    // "Maximum update depth exceeded" error when many keys arrive at once
    // (e.g., from paste operations or holding keys rapidly).
    // This batches all state updates from handleInput and all useInput
    // listeners together within one high-priority update context.
    if (keys.length > 0) {
      reconciler.discreteUpdates(processKeysInBatch, this, keys, undefined, undefined);
    }

    // If we have incomplete escape sequences, set a timer to flush them
    if (this.keyParseState.incomplete) {
      // Cancel any existing timer first
      if (this.incompleteEscapeTimer) {
        clearTimeout(this.incompleteEscapeTimer);
      }
      this.incompleteEscapeTimer = setTimeout(this.flushIncomplete, this.keyParseState.mode === 'IN_PASTE' ? this.PASTE_TIMEOUT : this.NORMAL_TIMEOUT);
    }
  };
  handleReadable = (): void => {
    // Detect long stdin gaps (tmux attach, ssh reconnect, laptop wake).
    // The terminal may have reset DEC private modes; re-assert mouse
    // tracking. Checked before the read loop so one Date.now() covers
    // all chunks in this readable event.
    const now = Date.now();
    if (now - this.lastStdinTime > STDIN_RESUME_GAP_MS) {
      this.props.onStdinResume?.();
    }
    this.lastStdinTime = now;
    try {
      let chunk;
      while ((chunk = this.props.stdin.read() as string | null) !== null) {
        // Process the input chunk
        this.processInput(chunk);
      }
    } catch (error) {
      // In Bun, an uncaught throw inside a stream 'readable' handler can
      // permanently wedge the stream: data stays buffered and 'readable'
      // never re-emits. Catching here ensures the stream stays healthy so
      // subsequent keystrokes are still delivered.
      logError(error);

      // Re-attach the listener in case the exception detached it.
      // Bun may remove the listener after an error; without this,
      // the session freezes permanently (stdin reader dead, event loop alive).
      const {
        stdin
      } = this.props;
      if (this.rawModeEnabledCount > 0 && !stdin.listeners('readable').includes(this.handleReadable)) {
        logForDebugging('handleReadable: re-attaching stdin readable listener after error recovery', {
          level: 'warn'
        });
        stdin.addListener('readable', this.handleReadable);
      }
    }
  };
  handleDataChunk = (chunk: string | Buffer): void => {
    const now = Date.now();
    if (now - this.lastStdinTime > STDIN_RESUME_GAP_MS) {
      this.props.onStdinResume?.();
    }
    this.lastStdinTime = now;
    try {
      this.processInput(chunk);
    } catch (error) {
      logError(error);
      const {
        stdin
      } = this.props;
      if (this.rawModeEnabledCount > 0 && !stdin.listeners('data').includes(this.handleDataChunk)) {
        logForDebugging('handleDataChunk: re-attaching stdin data listener after error recovery', {
          level: 'warn'
        });
        stdin.addListener('data', this.handleDataChunk);
      }
    }
  };
  handleInput = (input: string | undefined): void => {
    // Exit on Ctrl+C
    if (input === '\x03' && this.props.exitOnCtrlC) {
      this.handleExit();
    }

    // Note: Ctrl+Z (suspend) is now handled in processKeysInBatch using the
    // parsed key to support both raw (\x1a) and CSI u format from Kitty
    // keyboard protocol terminals (Ghostty, iTerm2, kitty, WezTerm)
  };
  handleExit = (error?: Error): void => {
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false);
    }
    this.props.onExit(error);
  };
  handleTerminalFocus = (isFocused: boolean): void => {
    // setTerminalFocused notifies subscribers: TerminalFocusProvider (context)
    // and Clock (interval speed) — no App setState needed.
    setTerminalFocused(isFocused);
  };
  handleSuspend = (): void => {
    if (!this.isRawModeSupported()) {
      return;
    }

    // Store the exact raw mode count to restore it properly
    const rawModeCountBeforeSuspend = this.rawModeEnabledCount;

    // Completely disable raw mode before suspending
    while (this.rawModeEnabledCount > 0) {
      this.handleSetRawMode(false);
    }

    // Show cursor, disable focus reporting, and disable mouse tracking
    // before suspending. DISABLE_MOUSE_TRACKING is a no-op if tracking
    // wasn't enabled, so it's safe to emit unconditionally — without
    // it, SGR mouse sequences would appear as garbled text at the
    // shell prompt while suspended.
    if (this.props.stdout.isTTY) {
      this.props.stdout.write(SHOW_CURSOR + DFE + DISABLE_MOUSE_TRACKING);
    }

    // Emit suspend event for Claude Code to handle. Mostly just has a notification
    this.internal_eventEmitter.emit('suspend');

    // Set up resume handler
    const resumeHandler = () => {
      // Restore raw mode to exact previous state
      for (let i = 0; i < rawModeCountBeforeSuspend; i++) {
        if (this.isRawModeSupported()) {
          this.handleSetRawMode(true);
        }
      }

      // Hide cursor (unless in accessibility mode) and re-enable focus reporting after resuming
      if (this.props.stdout.isTTY) {
        if (!isEnvTruthy(process.env.CLAUDE_CODE_ACCESSIBILITY)) {
          this.props.stdout.write(HIDE_CURSOR);
        }
        // Re-enable focus reporting to restore terminal state
        this.props.stdout.write(EFE);
      }

      // Emit resume event for Claude Code to handle
      this.internal_eventEmitter.emit('resume');
      process.removeListener('SIGCONT', resumeHandler);
    };
    process.on('SIGCONT', resumeHandler);
    process.kill(process.pid, 'SIGSTOP');
  };
}

// Helper to process all keys within a single discrete update context.
// discreteUpdates expects (fn, a, b, c, d) -> fn(a, b, c, d)
function processKeysInBatch(app: App, items: ParsedInput[], _unused1: undefined, _unused2: undefined): void {
  // Update interaction time for notification timeout tracking.
  // This is called from the central input handler to avoid having multiple
  // stdin listeners that can cause race conditions and dropped input.
  // Terminal responses (kind: 'response') are automated, not user input.
  // Mode-1003 no-button motion is also excluded — passive cursor drift is
  // not engagement (would suppress idle notifications + defer housekeeping).
  if (items.some(i => i.kind === 'key' || i.kind === 'mouse' && !((i.button & 0x20) !== 0 && (i.button & 0x03) === 3))) {
    updateLastInteractionTime();
  }
  for (const item of items) {
    // Terminal responses (DECRPM, DA1, OSC replies, etc.) are not user
    // input — route them to the querier to resolve pending promises.
    if (item.kind === 'response') {
      app.querier.onResponse(item.response);
      continue;
    }

    // Mouse click/drag events update selection state (fullscreen only).
    // Terminal sends 1-indexed col/row; convert to 0-indexed for the
    // screen buffer. Button bit 0x20 = drag (motion while button held).
    if (item.kind === 'mouse') {
      handleMouseEvent(app, item);
      continue;
    }
    const sequence = item.sequence;

    // Handle terminal focus events (DECSET 1004)
    if (sequence === FOCUS_IN) {
      app.handleTerminalFocus(true);
      const event = new TerminalFocusEvent('terminalfocus');
      app.internal_eventEmitter.emit('terminalfocus', event);
      continue;
    }
    if (sequence === FOCUS_OUT) {
      app.handleTerminalFocus(false);
      // Defensive: if we lost the release event (mouse released outside
      // terminal window — some emulators drop it rather than capturing the
      // pointer), focus-out is the next observable signal that the drag is
      // over. Without this, drag-to-scroll's timer runs until the scroll
      // boundary is hit.
      if (app.props.selection.isDragging) {
        finishSelection(app.props.selection);
        app.props.onSelectionChange();
      }
      const event = new TerminalFocusEvent('terminalblur');
      app.internal_eventEmitter.emit('terminalblur', event);
      continue;
    }

    // Failsafe: if we receive input, the terminal must be focused
    if (!getTerminalFocused()) {
      setTerminalFocused(true);
    }

    // Handle Ctrl+Z (suspend) using parsed key to support both raw (\x1a) and
    // CSI u format (\x1b[122;5u) from Kitty keyboard protocol terminals
    if (item.name === 'z' && item.ctrl && SUPPORTS_SUSPEND) {
      app.handleSuspend();
      continue;
    }
    app.handleInput(sequence);
    const event = new InputEvent(item);
    app.internal_eventEmitter.emit('input', event);

    // Also dispatch through the DOM tree so onKeyDown handlers fire.
    app.props.dispatchKeyboardEvent(item);
  }
}

/** Exported for testing. Mutates app.props.selection and click/hover state. */
export function handleMouseEvent(app: App, m: ParsedMouse): void {
  // Allow disabling click handling while keeping wheel scroll (which goes
  // through the keybinding system as 'wheelup'/'wheeldown', not here).
  if (isMouseClicksDisabled()) return;
  const sel = app.props.selection;
  // Terminal coords are 1-indexed; screen buffer is 0-indexed
  const col = m.col - 1;
  const row = m.row - 1;
  const baseButton = m.button & 0x03;
  if (m.action === 'press') {
    if ((m.button & 0x20) !== 0 && baseButton === 3) {
      // Mode-1003 motion with no button held. Dispatch hover; skip the
      // rest of this handler (no selection, no click-count side effects).
      // Lost-release recovery: no-button motion while isDragging=true means
      // the release happened outside the terminal window (iTerm2 doesn't
      // capture the pointer past window bounds, so the SGR 'm' never
      // arrives). Finish the selection here so copy-on-select fires. The
      // FOCUS_OUT handler covers the "switched apps" case but not "released
      // past the edge, came back" — and tmux drops focus events unless
      // `focus-events on` is set, so this is the more reliable signal.
      if (sel.isDragging) {
        finishSelection(sel);
        app.props.onSelectionChange();
      }
      if (col === app.lastHoverCol && row === app.lastHoverRow) return;
      app.lastHoverCol = col;
      app.lastHoverRow = row;
      app.props.onHoverAt(col, row);
      return;
    }
    if (baseButton !== 0) {
      // Non-left press breaks the multi-click chain.
      app.clickCount = 0;
      return;
    }
    if ((m.button & 0x20) !== 0) {
      // Drag motion: mode-aware extension (char/word/line). onSelectionDrag
      // calls notifySelectionChange internally — no extra onSelectionChange.
      app.props.onSelectionDrag(col, row);
      return;
    }
    // Lost-release fallback for mode-1002-only terminals: a fresh press
    // while isDragging=true means the previous release was dropped (cursor
    // left the window). Finish that selection so copy-on-select fires
    // before startSelection/onMultiClick clobbers it. Mode-1003 terminals
    // hit the no-button-motion recovery above instead, so this is rare.
    if (sel.isDragging) {
      finishSelection(sel);
      app.props.onSelectionChange();
    }
    // Fresh left press. Detect multi-click HERE (not on release) so the
    // word/line highlight appears immediately and a subsequent drag can
    // extend by word/line like native macOS. Previously detected on
    // release, which meant (a) visible latency before the word highlights
    // and (b) double-click+drag fell through to char-mode selection.
    const now = Date.now();
    const nearLast = now - app.lastClickTime < MULTI_CLICK_TIMEOUT_MS && Math.abs(col - app.lastClickCol) <= MULTI_CLICK_DISTANCE && Math.abs(row - app.lastClickRow) <= MULTI_CLICK_DISTANCE;
    app.clickCount = nearLast ? app.clickCount + 1 : 1;
    app.lastClickTime = now;
    app.lastClickCol = col;
    app.lastClickRow = row;
    if (app.clickCount >= 2) {
      // Cancel any pending hyperlink-open from the first click — this is
      // a double-click, not a single-click on a link.
      if (app.pendingHyperlinkTimer) {
        clearTimeout(app.pendingHyperlinkTimer);
        app.pendingHyperlinkTimer = null;
      }
      // Cap at 3 (line select) for quadruple+ clicks.
      const count = app.clickCount === 2 ? 2 : 3;
      app.props.onMultiClick(col, row, count);
      return;
    }
    startSelection(sel, col, row);
    // SGR bit 0x08 = alt (xterm.js wires altKey here, not metaKey — see
    // comment at the hyperlink-open guard below). On macOS xterm.js,
    // receiving alt means macOptionClickForcesSelection is OFF (otherwise
    // xterm.js would have consumed the event for native selection).
    sel.lastPressHadAlt = (m.button & 0x08) !== 0;
    app.props.onSelectionChange();
    return;
  }

  // Release: end the drag even for non-zero button codes. Some terminals
  // encode release with the motion bit or button=3 "no button" (carried
  // over from pre-SGR X10 encoding) — filtering those would orphan
  // isDragging=true and leave drag-to-scroll's timer running until the
  // scroll boundary. Only act on non-left releases when we ARE dragging
  // (so an unrelated middle/right click-release doesn't touch selection).
  if (baseButton !== 0) {
    if (!sel.isDragging) return;
    finishSelection(sel);
    app.props.onSelectionChange();
    return;
  }
  finishSelection(sel);
  // NOTE: unlike the old release-based detection we do NOT reset clickCount
  // on release-after-drag. This aligns with NSEvent.clickCount semantics:
  // an intervening drag doesn't break the click chain. Practical upside:
  // trackpad jitter during an intended double-click (press→wobble→release
  // →press) now correctly resolves to word-select instead of breaking to a
  // fresh single click. The nearLast window (500ms, 1 cell) bounds the
  // effect — a deliberate drag past that just starts a fresh chain.
  // A press+release with no drag in char mode is a click: anchor set,
  // focus null → hasSelection false. In word/line mode the press already
  // set anchor+focus (hasSelection true), so release just keeps the
  // highlight. The anchor check guards against an orphaned release (no
  // prior press — e.g. button was held when mouse tracking was enabled).
  if (!hasSelection(sel) && sel.anchor) {
    // Single click: dispatch DOM click immediately (cursor repositioning
    // etc. are latency-sensitive). If no DOM handler consumed it, defer
    // the hyperlink check so a second click can cancel it.
    if (!app.props.onClickAt(col, row)) {
      // Resolve the hyperlink URL synchronously while the screen buffer
      // still reflects what the user clicked — deferring only the
      // browser-open so double-click can cancel it.
      const url = app.props.getHyperlinkAt(col, row);
      // xterm.js (VS Code, Cursor, Windsurf, etc.) has its own OSC 8 link
      // handler that fires on Cmd+click *without consuming the mouse event*
      // (Linkifier._handleMouseUp calls link.activate() but never
      // preventDefault/stopPropagation). The click is also forwarded to the
      // pty as SGR, so both VS Code's terminalLinkManager AND our handler
      // here would open the URL — twice. We can't filter on Cmd: xterm.js
      // drops metaKey before SGR encoding (ICoreMouseEvent has no meta
      // field; the SGR bit we call 'meta' is wired to alt). Let xterm.js
      // own link-opening; Cmd+click is the native UX there anyway.
      // TERM_PROGRAM is the sync fast-path; isXtermJs() is the XTVERSION
      // probe result (catches SSH + non-VS Code embedders like Hyper).
      if (url && process.env.TERM_PROGRAM !== 'vscode' && !isXtermJs()) {
        // Clear any prior pending timer — clicking a second link
        // supersedes the first (only the latest click opens).
        if (app.pendingHyperlinkTimer) {
          clearTimeout(app.pendingHyperlinkTimer);
        }
        app.pendingHyperlinkTimer = setTimeout((app, url) => {
          app.pendingHyperlinkTimer = null;
          app.props.onOpenHyperlink(url);
        }, MULTI_CLICK_TIMEOUT_MS, app, url);
      }
    }
  }
  app.props.onSelectionChange();
}
