import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { feature } from 'bun:bundle';
// Dead code elimination: conditional import for COORDINATOR_MODE
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModule = feature('COORDINATOR_MODE') ? require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js') : undefined;
/* eslint-enable @typescript-eslint/no-require-imports */
import { Box, Text, Link } from '../../ink.js';
import * as React from 'react';
import figures from 'figures';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { VimMode, PromptInputMode } from '../../types/textInputTypes.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { isVimModeEnabled } from './utils.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { isDefaultMode, permissionModeSymbol, permissionModeTitle, getModeColor } from '../../utils/permissions/PermissionMode.js';
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js';
import { count } from '../../utils/array.js';
import { countVisibleBackgroundTasks, shouldHideTasksFooter } from '../tasks/taskStatusUtils.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { TeamStatus } from '../teams/TeamStatus.js';
import { isInProcessEnabled } from '../../utils/swarm/backends/registry.js';
import { useAppState, useAppStateStore } from 'src/state/AppState.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
import HistorySearchInput from './HistorySearchInput.js';
import { usePrStatus } from '../../hooks/usePrStatus.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { Byline } from '../design-system/Byline.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTasksV2 } from '../../hooks/useTasksV2.js';
import { formatDuration } from '../../utils/format.js';
import { VoiceWarmupHint } from './VoiceIndicator.js';
import { useVoiceEnabled } from '../../hooks/useVoiceEnabled.js';
import { useVoiceState } from '../../context/voice.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { isXtermJs } from '../../ink/terminal.js';
import { useHasSelection, useSelection } from '../../ink/hooks/use-selection.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { getPlatform } from '../../utils/platform.js';
import { PrBadge } from '../PrBadge.js';
import { resolveRegularFooterActive, resolveVisibleTransientFooterMessage } from './footerVisibility.js';
import { KeepMounted } from './KeepMounted.js';

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../proactive/index.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
const NO_OP_SUBSCRIBE = (_cb: () => void) => () => {};
const NULL = () => null;
const MAX_VOICE_HINT_SHOWS = 3;
type Props = {
  active: boolean;
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  suppressHint: boolean;
  isLoading: boolean;
  showMemoryTypeSelector?: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  isPasting?: boolean;
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};
function ProactiveCountdown({
  active
}: {
  active: boolean;
}) {
  const $ = _c(8);
  const nextTickAt = useSyncExternalStore(proactiveModule?.subscribeToProactiveChanges ?? NO_OP_SUBSCRIBE, proactiveModule?.getNextTickAt ?? NULL, NULL);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  let t0;
  let t1;
  if ($[0] !== active || $[1] !== nextTickAt) {
    t0 = () => {
      if (!active || nextTickAt === null) {
        setRemainingSeconds(null);
        return;
      }
      const update = function update() {
        const remaining = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
        setRemainingSeconds(remaining);
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    };
    t1 = [active, nextTickAt];
    $[0] = active;
    $[1] = nextTickAt;
    $[2] = t0;
    $[3] = t1;
  } else {
    t0 = $[2];
    t1 = $[3];
  }
  useEffect(t0, t1);
  if (remainingSeconds === null) {
    return null;
  }
  const t2 = remainingSeconds * 1000;
  let t3;
  if ($[4] !== t2) {
    t3 = formatDuration(t2, {
      mostSignificantOnly: true
    });
    $[4] = t2;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] !== t3) {
    t4 = <Text dimColor={true}>waiting{" "}{t3}</Text>;
    $[6] = t3;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  return t4;
}
export function PromptInputFooterLeftSide(t0) {
  const $ = _c(29);
  const {
    active,
    exitMessage,
    vimMode,
    mode,
    toolPermissionContext,
    suppressHint,
    isLoading,
    tasksSelected,
    teamsSelected,
    tmuxSelected,
    teammateFooterIndex,
    isPasting = false,
    isSearching,
    historyQuery,
    setHistoryQuery,
    historyFailedMatch,
    onOpenTasksDialog
  } = t0;
  let transientMessage: React.ReactNode = null;
  const transientMessageType = resolveVisibleTransientFooterMessage({
    isSearching,
    exitMessageShown: exitMessage.show,
    isPasting
  });
  if (transientMessageType === 'exit') {
    let t1;
    if ($[0] !== exitMessage.key) {
      t1 = <Text dimColor={true} key="exit-message">Press {exitMessage.key} again to exit</Text>;
      $[0] = exitMessage.key;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    transientMessage = t1;
  } else if (transientMessageType === 'paste') {
    let t1;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text dimColor={true} key="pasting-message">Pasting text…</Text>;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    transientMessage = t1;
  }
  let t1;
  if ($[3] !== isSearching || $[4] !== vimMode) {
    t1 = isVimModeEnabled() && vimMode === "INSERT" && !isSearching;
    $[3] = isSearching;
    $[4] = vimMode;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  const showVim = t1;
  let t2;
  const isRegularFooterActive = resolveRegularFooterActive({
    parentActive: active,
    transientMessage: transientMessageType
  });
  if ($[6] !== historyFailedMatch || $[7] !== historyQuery || $[8] !== isRegularFooterActive || $[9] !== isSearching || $[10] !== setHistoryQuery) {
    t2 = isSearching && <HistorySearchInput value={historyQuery} onChange={setHistoryQuery} historyFailedMatch={historyFailedMatch} focus={isRegularFooterActive} />;
    $[6] = historyFailedMatch;
    $[7] = historyQuery;
    $[8] = isRegularFooterActive;
    $[9] = isSearching;
    $[10] = setHistoryQuery;
    $[11] = t2;
  } else {
    t2 = $[11];
  }
  let t3;
  if ($[12] !== showVim) {
    t3 = showVim ? <Text dimColor={true} key="vim-insert">-- INSERT --</Text> : null;
    $[12] = showVim;
    $[13] = t3;
  } else {
    t3 = $[13];
  }
  const t4 = !suppressHint && !showVim;
  let t5;
  if ($[14] !== isRegularFooterActive || $[15] !== isLoading || $[16] !== mode || $[17] !== onOpenTasksDialog || $[18] !== t4 || $[19] !== tasksSelected || $[20] !== teammateFooterIndex || $[21] !== teamsSelected || $[22] !== tmuxSelected || $[23] !== toolPermissionContext) {
    t5 = <ModeIndicator mode={mode} toolPermissionContext={toolPermissionContext} showHint={t4} isLoading={isLoading} tasksSelected={tasksSelected} teamsSelected={teamsSelected} teammateFooterIndex={teammateFooterIndex} onOpenTasksDialog={onOpenTasksDialog} active={isRegularFooterActive} />;
    $[14] = isRegularFooterActive;
    $[15] = isLoading;
    $[16] = mode;
    $[17] = onOpenTasksDialog;
    $[18] = t4;
    $[19] = tasksSelected;
    $[20] = teammateFooterIndex;
    $[21] = teamsSelected;
    $[22] = tmuxSelected;
    $[23] = toolPermissionContext;
    $[24] = t5;
  } else {
    t5 = $[24];
  }
  let t6;
  if ($[25] !== t2 || $[26] !== t3 || $[27] !== t5) {
    t6 = <Box justifyContent="flex-start" gap={1}>{t2}{t3}{t5}</Box>;
    $[25] = t2;
    $[26] = t3;
    $[27] = t5;
    $[28] = t6;
  } else {
    t6 = $[28];
  }
  return <>
    <KeepMounted hidden={transientMessage !== null}>{t6}</KeepMounted>
    {transientMessage}
  </>;
}
type ModeIndicatorProps = {
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  showHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  teammateFooterIndex?: number;
  onOpenTasksDialog?: (taskId?: string) => void;
  active: boolean;
};
function ModeIndicator({
  mode,
  toolPermissionContext,
  showHint,
  isLoading,
  tasksSelected,
  teamsSelected,
  teammateFooterIndex,
  onOpenTasksDialog,
  active
}: ModeIndicatorProps): React.ReactNode {
  const {
    columns
  } = useTerminalSize();
  const modeCycleShortcut = useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');
  const tasks = useAppState(s => s.tasks);
  const teamContext = useAppState(s_0 => s_0.teamContext);
  // Set once in initialState (main.tsx --remote mode) and never mutated — lazy
  // init captures the immutable value without a subscription.
  const store = useAppStateStore();
  const [remoteSessionUrl] = useState(() => store.getState().remoteSessionUrl);
  const viewSelectionMode = useAppState(s_1 => s_1.viewSelectionMode);
  const viewingAgentTaskId = useAppState(s_2 => s_2.viewingAgentTaskId);
  const expandedView = useAppState(s_3 => s_3.expandedView);
  const showSpinnerTree = expandedView === 'teammates';
  const prStatus = usePrStatus(isLoading, active && isPrStatusEnabled());
  const nextTickAt = useSyncExternalStore(proactiveModule?.subscribeToProactiveChanges ?? NO_OP_SUBSCRIBE, proactiveModule?.getNextTickAt ?? NULL, NULL);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const voiceEnabled = feature('VOICE_MODE') ? useVoiceEnabled() : false;
  const voiceState = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useVoiceState(s_5 => s_5.voiceState) : 'idle' as const;
  const voiceWarmingUp = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useVoiceState(s_6 => s_6.voiceWarmingUp) : false;
  const hasSelection = useHasSelection();
  const selGetState = useSelection().getState;
  const hasNextTick = nextTickAt !== null;
  const isCoordinator = feature('COORDINATOR_MODE') ? coordinatorModule?.isCoordinatorMode() === true : false;
  const backgroundTaskCount = useMemo(() => countVisibleBackgroundTasks(tasks), [tasks]);
  const tasksV2 = useTasksV2();
  const hasTaskItems = tasksV2 !== undefined && tasksV2.length > 0;
  const escShortcut = useShortcutDisplay('chat:cancel', 'Chat', 'esc').toLowerCase();
  const todosShortcut = useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t');
  const killAgentsShortcut = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k');
  const voiceKeyShortcut = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useShortcutDisplay('voice:pushToTalk', 'Chat', 'Space') : '';
  // Captured at mount so the hint doesn't flicker mid-session if another
  // CC instance increments the counter. Incremented once via useEffect the
  // first time voice is enabled in this session — approximates "hint was
  // shown" without tracking the exact render-time condition (which depends
  // on parts/hintParts computed after the early-return hooks boundary).
  const [voiceHintUnderCap] = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useState(() => (getGlobalConfig().voiceFooterHintSeenCount ?? 0) < MAX_VOICE_HINT_SHOWS) : [false];
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const voiceHintIncrementedRef = feature('VOICE_MODE') ? useRef(false) : null;
  useEffect(() => {
    if (feature('VOICE_MODE')) {
      if (!active || !voiceEnabled || !voiceHintUnderCap) return;
      if (voiceHintIncrementedRef?.current) return;
      if (voiceHintIncrementedRef) voiceHintIncrementedRef.current = true;
      const newCount = (getGlobalConfig().voiceFooterHintSeenCount ?? 0) + 1;
      saveGlobalConfig(prev => {
        if ((prev.voiceFooterHintSeenCount ?? 0) >= newCount) return prev;
        return {
          ...prev,
          voiceFooterHintSeenCount: newCount
        };
      });
    }
  }, [active, voiceEnabled, voiceHintUnderCap]);
  const isKillAgentsConfirmShowing = useAppState(s_7 => s_7.notifications.current?.key === 'kill-agents-confirm');

  // Derive team info from teamContext (no filesystem I/O needed)
  // Match the same logic as TeamStatus to avoid trailing separator
  // In-process mode uses Shift+Down/Up navigation, not footer teams menu
  const hasTeams = isAgentSwarmsEnabled() && !isInProcessEnabled() && teamContext !== undefined && count(Object.values(teamContext.teammates), t_0 => t_0.name !== 'team-lead') > 0;
  if (mode === 'bash') {
    return <Text color="bashBorder">! for bash mode</Text>;
  }
  const currentMode = toolPermissionContext?.mode;
  const hasActiveMode = !isDefaultMode(currentMode);
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const isViewingTeammate = viewSelectionMode === 'viewing-agent' && viewedTask?.type === 'in_process_teammate';
  const isViewingCompletedTeammate = isViewingTeammate && viewedTask != null && viewedTask.status !== 'running';
  const hasBackgroundTasks = backgroundTaskCount > 0 || isViewingTeammate;

  // Count primary items (permission mode or coordinator mode, background tasks, and teams)
  const primaryItemCount = (isCoordinator || hasActiveMode ? 1 : 0) + (hasBackgroundTasks ? 1 : 0) + (hasTeams ? 1 : 0);

  // PR indicator is short (~10 chars) — unlike the old diff indicator the
  // >=100 threshold was tuned for. Now that auto mode is effectively the
  // baseline, primaryItemCount is ≥1 for most sessions; keep the threshold
  // low enough to show PR status on standard 80-col terminals.
  const shouldShowPrStatus = isPrStatusEnabled() && prStatus.number !== null && prStatus.reviewState !== null && prStatus.url !== null && primaryItemCount < 2 && (primaryItemCount === 0 || columns >= 80);

  // Hide the shift+tab hint when there are 2 primary items
  const shouldShowModeHint = primaryItemCount < 2;

  // Check if we have in-process teammates (showing pills)
  // In spinner-tree mode, pills are disabled - teammates appear in the spinner tree instead
  const hasInProcessTeammates = !showSpinnerTree && hasBackgroundTasks && Object.values(tasks).some(t_1 => t_1.type === 'in_process_teammate');
  const hasTeammatePills = hasInProcessTeammates || !showSpinnerTree && isViewingTeammate;

  // In remote mode (`claude assistant`, --teleport) the agent runs elsewhere;
  // the local permission mode shown here doesn't reflect the agent's state.
  // Rendered before the tasks pill so a long pill label (e.g. ultraplan URL)
  // doesn't push the mode indicator off-screen.
  const modePart = currentMode && hasActiveMode && !getIsRemoteMode() ? <Text color={getModeColor(currentMode)} key="mode">
        {permissionModeSymbol(currentMode)}{' '}
        {permissionModeTitle(currentMode).toLowerCase()} on
        {shouldShowModeHint && <Text dimColor>
            {' '}
            <KeyboardShortcutHint shortcut={modeCycleShortcut} action="cycle" parens />
          </Text>}
      </Text> : null;

  // Build parts array - exclude BackgroundTaskStatus when we have teammate pills
  // (teammate pills get their own row)
  const parts = [
  // Remote session indicator
  ...(remoteSessionUrl ? [<Link url={remoteSessionUrl} key="remote">
            <Text color="ide">{figures.circleDouble} remote</Text>
          </Link>] : []),
  // BackgroundTaskStatus is NOT in parts — it renders as a Box sibling so
  // its click-target Box isn't nested inside the <Text wrap="truncate">
  // wrapper (reconciler throws on Box-in-Text).
  ...(isAgentSwarmsEnabled() && hasTeams ? [<TeamStatus key="teams" teamsSelected={teamsSelected} showHint={showHint && !hasBackgroundTasks} />] : []), ...(shouldShowPrStatus ? [<PrBadge key="pr-status" number={prStatus.number!} url={prStatus.url!} reviewState={prStatus.reviewState!} />] : [])];

  // Check if any in-process teammates exist (for hint text cycling)
  const hasAnyInProcessTeammates = Object.values(tasks).some(t_2 => t_2.type === 'in_process_teammate' && t_2.status === 'running');
  const hasRunningAgentTasks = Object.values(tasks).some(t_3 => t_3.type === 'local_agent' && t_3.status === 'running');

  // Get hint parts separately for potential second-line rendering
  const hintParts = showHint ? getSpinnerHintParts(isLoading, escShortcut, todosShortcut, killAgentsShortcut, hasTaskItems, expandedView, hasAnyInProcessTeammates, hasRunningAgentTasks, isKillAgentsConfirmShowing) : [];
  if (isViewingCompletedTeammate) {
    parts.push(<Text dimColor key="esc-return">
        <KeyboardShortcutHint shortcut={escShortcut} action="return to team lead" />
      </Text>);
  } else if ((feature('PROACTIVE') || feature('KAIROS')) && hasNextTick) {
    parts.push(<ProactiveCountdown key="proactive" active={active} />);
  } else if (!hasTeammatePills && showHint) {
    parts.push(...hintParts);
  }

  // When we have teammate pills, always render them on their own line above other parts
  if (hasTeammatePills) {
    // Don't append spinner hints when viewing a completed teammate —
    // the "esc to return to team lead" hint already replaces "esc to interrupt"
    const otherParts = [...(modePart ? [modePart] : []), ...parts, ...(isViewingCompletedTeammate ? [] : hintParts)];
    return <Box flexDirection="column">
        <Box>
          <BackgroundTaskStatus tasksSelected={tasksSelected} isViewingTeammate={isViewingTeammate} teammateFooterIndex={teammateFooterIndex} isLeaderIdle={!isLoading} onOpenDialog={onOpenTasksDialog} />
        </Box>
        {otherParts.length > 0 && <Box>
            <Byline>{otherParts}</Byline>
          </Box>}
      </Box>;
  }

  // Tasks pill renders as a Box sibling (not a parts entry) so its
  // click-target Box isn't nested inside <Text wrap="truncate"> — the
  // reconciler throws on Box-in-Text. Computed here so the empty-checks
  // below still treat "pill present" as non-empty.
  const tasksPart = hasBackgroundTasks && !hasTeammatePills && !shouldHideTasksFooter(tasks, showSpinnerTree) ? <BackgroundTaskStatus tasksSelected={tasksSelected} isViewingTeammate={isViewingTeammate} teammateFooterIndex={teammateFooterIndex} isLeaderIdle={!isLoading} onOpenDialog={onOpenTasksDialog} /> : null;
  if (parts.length === 0 && !tasksPart && !modePart && showHint) {
    parts.push(<Text dimColor key="shortcuts-hint">
        ? for shortcuts
      </Text>);
  }

  // Only replace the idle voice hint when there's something to say — otherwise
  // fall through instead of showing an empty Byline. "esc to clear" was removed
  // (looked like "esc to interrupt" when idle; esc-clears-selection is standard
  // UX) leaving only ctrl+c (copyOnSelect off) and the xterm.js native-select hint.
  const copyOnSelect = getGlobalConfig().copyOnSelect ?? true;
  const selectionHintHasContent = hasSelection && (!copyOnSelect || isXtermJs());

  // Warmup hint takes priority — when the user is actively holding
  // the activation key, show feedback regardless of other hints.
  if (feature('VOICE_MODE') && voiceEnabled && voiceWarmingUp) {
    parts.push(<VoiceWarmupHint key="voice-warmup" />);
  } else if (isFullscreenEnvEnabled() && selectionHintHasContent) {
    // xterm.js (VS Code/Cursor/Windsurf) force-selection modifier is
    // platform-specific and gated on macOS (SelectionService.shouldForceSelection):
    //   macOS:     altKey && macOptionClickForcesSelection (VS Code default: false)
    //   non-macOS: shiftKey
    // On macOS, if we RECEIVED an alt+click (lastPressHadAlt), the VS Code
    // setting is off — xterm.js would have consumed the event otherwise.
    // Tell the user the exact setting to flip instead of repeating the
    // option+click hint they just tried.
    // Non-reactive getState() read is safe: lastPressHadAlt is immutable
    // while hasSelection is true (set pre-drag, cleared with selection).
    const isMac = getPlatform() === 'macos';
    const altClickFailed = isMac && (selGetState()?.lastPressHadAlt ?? false);
    parts.push(<Text dimColor key="selection-copy">
        <Byline>
          {!copyOnSelect && <KeyboardShortcutHint shortcut="ctrl+c" action="copy" />}
          {isXtermJs() && (altClickFailed ? <Text>set macOptionClickForcesSelection in VS Code settings</Text> : <KeyboardShortcutHint shortcut={isMac ? 'option+click' : 'shift+click'} action="native select" />)}
        </Byline>
      </Text>);
  } else if (feature('VOICE_MODE') && parts.length > 0 && showHint && voiceEnabled && voiceState === 'idle' && hintParts.length === 0 && voiceHintUnderCap) {
    parts.push(<Text dimColor key="voice-hint">
        hold {voiceKeyShortcut} to speak
      </Text>);
  }
  if (tasksPart && showHint && !hasTeams) {
    parts.push(<Text dimColor key="manage-tasks">
        {tasksSelected ? <KeyboardShortcutHint shortcut="Enter" action="view tasks" /> : <KeyboardShortcutHint shortcut="↓" action="manage" />}
      </Text>);
  }

  // In fullscreen the bottom section is flexShrink:0 — every row here
  // is a row stolen from the ScrollBox. This component must have a STABLE
  // height so the footer never grows/shrinks and shifts scroll content.
  // Returning null when parts is empty (e.g. StatusLine on → suppressHint
  // → showHint=false → no "? for shortcuts") would let a later-added
  // part (e.g. the selection copy/native-select hints) grow the column
  // from 0→1 row. Always render 1 row in fullscreen; return a space when
  // empty so Yoga reserves the row without painting anything visible.
  if (parts.length === 0 && !tasksPart && !modePart) {
    return isFullscreenEnvEnabled() ? <Text> </Text> : null;
  }

  // flexShrink=0 keeps mode + pill at natural width; the remaining parts
  // truncate at the tail as one string inside the Text wrapper.
  return <Box height={1} overflow="hidden">
      {modePart && <Box flexShrink={0}>
          {modePart}
          {(tasksPart || parts.length > 0) && <Text dimColor> · </Text>}
        </Box>}
      {tasksPart && <Box flexShrink={0}>
          {tasksPart}
          {parts.length > 0 && <Text dimColor> · </Text>}
        </Box>}
      {parts.length > 0 && <Text wrap="truncate">
          <Byline>{parts}</Byline>
        </Text>}
    </Box>;
}
function getSpinnerHintParts(isLoading: boolean, escShortcut: string, todosShortcut: string, killAgentsShortcut: string, hasTaskItems: boolean, expandedView: 'none' | 'tasks' | 'teammates', hasTeammates: boolean, hasRunningAgentTasks: boolean, isKillAgentsConfirmShowing: boolean): React.ReactElement[] {
  let toggleAction: string;
  if (hasTeammates) {
    // Cycling: none → tasks → teammates → none
    switch (expandedView) {
      case 'none':
        toggleAction = 'show tasks';
        break;
      case 'tasks':
        toggleAction = 'show teammates';
        break;
      case 'teammates':
        toggleAction = 'hide';
        break;
    }
  } else {
    toggleAction = expandedView === 'tasks' ? 'hide tasks' : 'show tasks';
  }

  // Show the toggle hint only when there are task items to display or
  // teammates to cycle to
  const showToggleHint = hasTaskItems || hasTeammates;
  return [...(isLoading ? [<Text dimColor key="esc">
            <KeyboardShortcutHint shortcut={escShortcut} action="interrupt" />
          </Text>] : []), ...(!isLoading && hasRunningAgentTasks && !isKillAgentsConfirmShowing ? [<Text dimColor key="kill-agents">
            <KeyboardShortcutHint shortcut={killAgentsShortcut} action="stop agents" />
          </Text>] : []), ...(showToggleHint ? [<Text dimColor key="toggle-tasks">
            <KeyboardShortcutHint shortcut={todosShortcut} action={toggleAction} />
          </Text>] : [])];
}
function isPrStatusEnabled(): boolean {
  return getGlobalConfig().prStatusFooterEnabled ?? true;
}
