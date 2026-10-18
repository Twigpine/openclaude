import { feature } from 'bun:bundle';
import chalk from 'chalk';
import * as path from 'path';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { useCommandQueue } from 'src/hooks/useCommandQueue.js';
import { type IDEAtMentioned, useIdeAtMentioned } from 'src/hooks/useIdeAtMentioned.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { type AppState, useAppState, useAppStateStore, useSetAppState } from 'src/state/AppState.js';
import type { FooterItem } from 'src/state/AppStateStore.js';
import { getCwd } from 'src/utils/cwd.js';
import { isQueuedCommandEditable, popAllEditable } from 'src/utils/messageQueueManager.js';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import { companionReservedColumns } from '../../buddy/CompanionSprite.js';
import { isBuddyEnabled } from '../../buddy/feature.js';
import { findBuddyTriggerPositions, useBuddyNotification } from '../../buddy/useBuddyNotification.js';
import { FastModePicker } from '../../commands/fast/fast.js';
import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js';
import { getNativeCSIuTerminalDisplayName } from '../../commands/terminalSetup/terminalSetup.js';
import { type Command, hasCommand } from '../../commands.js';
import { useIsModalOverlayActive } from '../../context/overlayContext.js';
import { useSetPromptOverlayDialog } from '../../context/promptOverlayContext.js';
import { formatImageRef, formatPastedTextRef, getPastedTextRefNumLines, parseReferences } from '../../history.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import { type HistoryMode, useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js';
import { useDoublePress } from '../../hooks/useDoublePress.js';
import { useHistorySearch } from '../../hooks/useHistorySearch.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useInputBuffer } from '../../hooks/useInputBuffer.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTypeahead } from '../../hooks/useTypeahead.js';
import type { BorderTextOptions } from '../../ink/render-border.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, type ClickEvent, type Key, Text, useInput } from '../../ink.js';
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js';
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import { abortPromptSuggestion, logSuggestionSuppressed } from '../../services/PromptSuggestion/promptSuggestion.js';
import { type ActiveSpeculationState, abortSpeculation } from '../../services/PromptSuggestion/speculation.js';
import { getActiveAgentForInput, getViewedTeammateTask } from '../../state/selectors.js';
import { enterTeammateView, exitTeammateView, stopOrDismissAgent } from '../../state/teammateViewHelpers.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js';
import { type LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask } from '../../tasks/types.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js';
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js';
import type { Message } from '../../types/message.js';
import type { PermissionMode } from '../../types/permissions.js';
import type { BaseTextInputProps, PromptInputMode, TextInputChangeContext, VimMode } from '../../types/textInputTypes.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { count } from '../../utils/array.js';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js';
import { Cursor } from '../../utils/Cursor.js';
import { getGlobalConfig, type PastedContent, saveGlobalConfig } from '../../utils/config.js';
import { logForDebugging } from '../../utils/debug.js';
import { parseDirectMemberMessage, sendDirectMemberMessage } from '../../utils/directMemberMessage.js';
import type { EffortLevel } from '../../utils/effort.js';
import { env } from '../../utils/env.js';
import { errorMessage } from '../../utils/errors.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { getFastModeUnavailableReason, isFastModeAvailable, isFastModeCooldown, isFastModeEnabled, isFastModeSupportedByModel } from '../../utils/fastMode.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js';
import { extractDraggedFilePaths } from '../../utils/dragDropPaths.js';
import { CLIPBOARD_IMAGE_PASTE_FAILURE_KEY, formatClipboardImagePasteError, getImageFromClipboard, PASTE_THRESHOLD } from '../../utils/imagePaste.js';
import type { ImageDimensions } from '../../utils/imageResizer.js';
import { cacheImagePath, storeImage } from '../../utils/imageStore.js';
import { isMacosOptionChar, MACOS_OPTION_SPECIAL_CHARS } from '../../utils/keyboardShortcuts.js';
import { logError } from '../../utils/log.js';
import { isOpus1mMergeEnabled, modelDisplayString } from '../../utils/model/model.js';
import { setAutoModeActive } from '../../utils/permissions/autoModeState.js';
import { cyclePermissionMode, getNextPermissionMode } from '../../utils/permissions/getNextPermissionMode.js';
import { transitionPermissionMode } from '../../utils/permissions/permissionSetup.js';
import { getPlatform } from '../../utils/platform.js';
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js';
import { editPromptInEditor } from '../../utils/promptEditor.js';
import { hasAutoModeOptIn } from '../../utils/settings/settings.js';
import { findBtwTriggerPositions } from '../../utils/sideQuestion.js';
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js';
import { findSlackChannelPositions, getKnownChannelsVersion, hasSlackMcpServer, subscribeKnownChannels } from '../../utils/suggestions/slackChannelSuggestions.js';
import { isInProcessEnabled } from '../../utils/swarm/backends/registry.js';
import { syncTeammateMode } from '../../utils/swarm/teamHelpers.js';
import type { TeamSummary } from '../../utils/teamDiscovery.js';
import { getTeammateColor, getTeamName } from '../../utils/teammate.js';
import { isInProcessTeammate } from '../../utils/teammateContext.js';
import { writeToMailbox } from '../../utils/teammateMailbox.js';
import type { TextHighlight } from '../../utils/textHighlighting.js';
import type { Theme } from '../../utils/theme.js';
import { findThinkingTriggerPositions, getRainbowColor, isUltrathinkEnabled } from '../../utils/thinking.js';
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js';
import { findUltraplanTriggerPositions, findUltrareviewTriggerPositions } from '../../utils/ultraplan/keyword.js';
import { AutoModeOptInDialog } from '../AutoModeOptInDialog.js';
import { BridgeDialog } from '../BridgeDialog.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { getVisibleAgentTasks, useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js';
import { getFastIconString } from '../FastIcon.js';
import { GlobalSearchDialog } from '../GlobalSearchDialog.js';
import { HistorySearchDialog } from '../HistorySearchDialog.js';
import { ModelPicker } from '../ModelPicker.js';
import { usePermissionModeChangeRequest } from '../permissions/usePermissionModeChangeRequest.js';
import { QuickOpenDialog } from '../QuickOpenDialog.js';
import TextInput from '../TextInput.js';
import { ThinkingToggle } from '../ThinkingToggle.js';
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js';
import { countVisibleBackgroundTasks, shouldHideTasksFooter } from '../tasks/taskStatusUtils.js';
import { TeamsDialog } from '../teams/TeamsDialog.js';
import VimTextInput from '../VimTextInput.js';
import { applyHistorySearchActiveState } from './footerVisibility.js';
import { detectModeEntry, getModeFromInput, getValueFromInput } from './inputModes.js';
import { FOOTER_TEMPORARY_STATUS_TIMEOUT, Notifications } from './Notifications.js';
import PromptInputFooter from './PromptInputFooter.js';
import type { SuggestionItem } from './PromptInputFooterSuggestions.js';
import { PromptInputModeIndicator } from './PromptInputModeIndicator.js';
import { PromptInputQueuedCommands } from './PromptInputQueuedCommands.js';
import { PromptInputStashNotice } from './PromptInputStashNotice.js';
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js';
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js';
import { useShowFastIconHint } from './useShowFastIconHint.js';
import { useSwarmBanner } from './useSwarmBanner.js';
import { canAcceptPromptSuggestion, isVimModeEnabled, normalizePromptInputChunk, resolveCoalescedModeSubmission, resolveHelpToggleChange, resolvePromptBorderColor } from './utils.js';
type Props = {
  debug: boolean;
  ideSelection: IDESelection | undefined;
  toolPermissionContext: ToolPermissionContext;
  setToolPermissionContext: (ctx: ToolPermissionContext) => void;
  apiKeyStatus: VerificationStatus;
  commands: Command[];
  agents: AgentDefinition[];
  isLoading: boolean;
  /** True when ultracode is the active effort. Tints the prompt border
   *  cyan-blue as a persistent ambient indicator of the mode. */
  ultracodeActive?: boolean;
  verbose: boolean;
  messages: Message[];
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  input: string;
  onInputChange: (value: string) => void;
  mode: PromptInputMode;
  onModeChange: (mode: PromptInputMode) => void;
  stashedPrompt: {
    text: string;
    cursorOffset: number;
    pastedContents: Record<number, PastedContent>;
  } | undefined;
  setStashedPrompt: (value: {
    text: string;
    cursorOffset: number;
    pastedContents: Record<number, PastedContent>;
  } | undefined) => void;
  submitCount: number;
  onShowMessageSelector: () => void;
  /** Fullscreen message actions: shift+↑ enters cursor. */
  onMessageActionsEnter?: () => void;
  mcpClients: MCPServerConnection[];
  pastedContents: Record<number, PastedContent>;
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>;
  vimMode: VimMode;
  setVimMode: (mode: VimMode) => void;
  showBashesDialog: string | boolean;
  setShowBashesDialog: (show: string | boolean) => void;
  onExit: () => void;
  getToolUseContext: (messages: Message[], newMessages: Message[], abortController: AbortController, mainLoopModel: string) => ProcessUserInputContext;
  onSubmit: (input: string, helpers: PromptInputHelpers, speculationAccept?: {
    state: ActiveSpeculationState;
    speculationSessionTimeSavedMs: number;
    setAppState: (f: (prev: AppState) => AppState) => void;
  }, options?: {
    fromKeybinding?: boolean;
    slashCommandOverride?: Command;
    inputModeOverride?: PromptInputMode;
  }) => Promise<void>;
  onAgentSubmit?: (input: string, task: InProcessTeammateTaskState | LocalAgentTaskState, helpers: PromptInputHelpers) => Promise<void>;
  isSearchingHistory: boolean;
  setIsSearchingHistory: (isSearching: boolean) => void;
  onDismissSideQuestion?: () => void;
  isSideQuestionVisible?: boolean;
  helpOpen: boolean;
  setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isLocalJSXCommandActive?: boolean;
  insertTextRef?: React.MutableRefObject<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>;
  voiceInterimRange?: {
    start: number;
    end: number;
  } | null;
};

// Bottom slot has maxHeight="50%"; reserve lines for footer, border, status.
const PROMPT_FOOTER_LINES = 5;
const MIN_INPUT_VIEWPORT_LINES = 3;
/** Renders the prompt editor, agent banner, and mode-aware input controls. */
function PromptInput({
  debug,
  ideSelection,
  toolPermissionContext,
  setToolPermissionContext,
  apiKeyStatus,
  commands,
  agents,
  isLoading,
  ultracodeActive,
  verbose,
  messages,
  onAutoUpdaterResult,
  autoUpdaterResult,
  input,
  onInputChange,
  mode,
  onModeChange,
  stashedPrompt,
  setStashedPrompt,
  submitCount,
  onShowMessageSelector,
  onMessageActionsEnter,
  mcpClients,
  pastedContents,
  setPastedContents,
  vimMode,
  setVimMode,
  showBashesDialog,
  setShowBashesDialog,
  onExit,
  getToolUseContext,
  onSubmit: onSubmitProp,
  onAgentSubmit,
  isSearchingHistory,
  setIsSearchingHistory,
  onDismissSideQuestion,
  isSideQuestionVisible,
  helpOpen,
  setHelpOpen,
  isLocalJSXCommandActive = false,
  insertTextRef,
  voiceInterimRange
}: Props): React.ReactNode {
  const mainLoopModel = useMainLoopModel();
  // A local-jsx command (e.g., /mcp while agent is running) renders a full-
  // screen dialog on top of PromptInput via the immediate-command path with
  // shouldHidePromptInput: false. Those dialogs don't register in the overlay
  // system, so treat them as a modal overlay here to stop navigation keys from
  // leaking into TextInput/footer handlers and stacking a second dialog.
  const isModalOverlayActive = useIsModalOverlayActive() || isLocalJSXCommandActive;
  const [isAutoUpdating, setIsAutoUpdating] = useState(false);
  const [exitMessage, setExitMessage] = useState<{
    show: boolean;
    key?: string;
  }>({
    show: false
  });
  const [cursorOffset, setCursorOffset] = useState<number>(input.length);
  // Track the last input value set via internal handlers so external updates
  // (for example speech-to-text injection) can still move the cursor to end
  // without clobbering a pending internal keystroke during render.
  const lastInternalInputRef = React.useRef(input);
  const lastPropInputRef = React.useRef(input);
  React.useLayoutEffect(() => {
    if (input === lastPropInputRef.current) {
      return;
    }

    lastPropInputRef.current = input;
    if (input === lastInternalInputRef.current) {
      return;
    }

    lastInternalInputRef.current = input;
    setCursorOffset(prev => prev === input.length ? prev : input.length);
  }, [input]);
  // Wrap onInputChange to track internal changes before they trigger re-render
  const trackAndSetInput = React.useCallback((value: string) => {
    lastInternalInputRef.current = value;
    onInputChange(value);
  }, [onInputChange]);
  // Expose an insertText function so callers (e.g. STT) can splice text at the
  // current cursor position instead of replacing the entire input.
  if (insertTextRef) {
    insertTextRef.current = {
      cursorOffset,
      insert: (text: string) => {
        const needsSpace = cursorOffset === input.length && input.length > 0 && !/\s$/.test(input);
        const insertText = needsSpace ? ' ' + text : text;
        const newValue = input.slice(0, cursorOffset) + insertText + input.slice(cursorOffset);
        lastInternalInputRef.current = newValue;
        onInputChange(newValue);
        setCursorOffset(cursorOffset + insertText.length);
      },
      setInputWithCursor: (value: string, cursor: number) => {
        lastInternalInputRef.current = value;
        onInputChange(value);
        setCursorOffset(cursor);
      }
    };
  }
  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const tasks = useAppState(s => s.tasks);
  const replBridgeConnected = useAppState(s => s.replBridgeConnected);
  const replBridgeExplicit = useAppState(s => s.replBridgeExplicit);
  const replBridgeReconnecting = useAppState(s => s.replBridgeReconnecting);
  // Must match BridgeStatusIndicator's render condition (PromptInputFooter.tsx) —
  // the pill returns null for implicit-and-not-reconnecting, so nav must too,
  // otherwise bridge becomes an invisible selection stop.
  const bridgeFooterVisible = replBridgeConnected && (replBridgeExplicit || replBridgeReconnecting);
  const tmuxFooterVisible = false;
  // WebBrowser pill — visible when a browser is open
  const bagelFooterVisible = useAppState(s => false);
  const teamContext = useAppState(s => s.teamContext);
  const standaloneAgentContext = useAppState(s => s.standaloneAgentContext);
  const queuedCommands = useCommandQueue();
  const promptSuggestionState = useAppState(s => s.promptSuggestion);
  const speculation = useAppState(s => s.speculation);
  const speculationSessionTimeSavedMs = useAppState(s => s.speculationSessionTimeSavedMs);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const viewSelectionMode = useAppState(s => s.viewSelectionMode);
  const showSpinnerTree = useAppState(s => s.expandedView) === 'teammates';
  const {
    companion: _companion,
    companionMuted
  } = isBuddyEnabled() ? getGlobalConfig() : {
    companion: undefined,
    companionMuted: undefined
  };
  const companionFooterVisible = !!_companion && !companionMuted;
  // Brief mode: BriefSpinner/BriefIdleStatus own the 2-row footprint above
  // the input. Dropping marginTop here lets the spinner sit flush against
  // the input bar. viewingAgentTaskId mirrors the gate on both (Spinner.tsx,
  // REPL.tsx) — teammate view falls back to SpinnerWithVerbInner which has
  // its own marginTop, so the gap stays even without ours.
  const briefOwnsGap = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.isBriefOnly) && !viewingAgentTaskId : false;
  const mainLoopModel_ = useAppState(s => s.mainLoopModel);
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession);
  const thinkingEnabled = useAppState(s => s.thinkingEnabled);
  const isFastMode = useAppState(s => isFastModeEnabled() ? s.fastMode : false);
  const viewedTeammate = getViewedTeammateTask(store.getState());
  const viewingAgentName = viewedTeammate?.identity.agentName;
  // identity.color is typed as `string | undefined` (not AgentColorName) because
  // teammate identity comes from file-based config. Validate before casting to
  // ensure we only use valid color names (falls back to cyan if invalid).
  const viewingAgentColor = viewedTeammate?.identity.color && AGENT_COLORS.includes(viewedTeammate.identity.color as AgentColorName) ? viewedTeammate.identity.color as AgentColorName : undefined;
  // In-process teammates sorted alphabetically for footer team selector
  const inProcessTeammates = useMemo(() => getRunningTeammatesSorted(tasks), [tasks]);

  // Team mode: all background tasks are in-process teammates
  const isTeammateMode = inProcessTeammates.length > 0 || viewedTeammate !== undefined;

  // When viewing a teammate, show their permission mode in the footer instead of the leader's
  const effectiveToolPermissionContext = useMemo((): ToolPermissionContext => {
    if (viewedTeammate) {
      return {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode
      };
    }
    return toolPermissionContext;
  }, [viewedTeammate, toolPermissionContext]);
  const setHistorySearchActive = useCallback((active: boolean) => {
    applyHistorySearchActiveState(active, setHelpOpen, setIsSearchingHistory);
  }, [setHelpOpen, setIsSearchingHistory]);
  const {
    historyQuery,
    setHistoryQuery,
    historyMatch,
    historyFailedMatch
  } = useHistorySearch(entry => {
    setPastedContents(entry.pastedContents);
    void onSubmit(entry.display);
  }, input, trackAndSetInput, setCursorOffset, cursorOffset, onModeChange, mode, isSearchingHistory, setHistorySearchActive, setPastedContents, pastedContents);
  // Counter for paste IDs (shared between images and text).
  // Compute initial value once from existing messages (for --continue/--resume).
  // useRef(fn()) evaluates fn() on every render and discards the result after
  // mount — getInitialPasteId walks all messages + regex-scans text blocks,
  // so guard with a lazy-init pattern to run it exactly once.
  const nextPasteIdRef = useRef(-1);
  if (nextPasteIdRef.current === -1) {
    nextPasteIdRef.current = getInitialPasteId(messages);
  }
  // Armed by onImagePaste; if the very next keystroke is a non-space
  // printable, inputFilter prepends a space before it. Any other input
  // (arrow, escape, backspace, paste, space) disarms without inserting.
  const pendingSpaceAfterPillRef = useRef(false);
  const [showTeamsDialog, setShowTeamsDialog] = useState(false);
  const [showBridgeDialog, setShowBridgeDialog] = useState(false);
  const [teammateFooterIndex, setTeammateFooterIndex] = useState(0);
  // -1 sentinel: tasks pill is selected but no specific agent row is selected yet.
  // First ↓ selects the pill, second ↓ moves to row 0. Prevents double-select
  // of pill + row when both bg tasks (pill) and forked agents (rows) are visible.
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex);
  const setCoordinatorTaskIndex = useCallback((v: number | ((prev: number) => number)) => setAppState(prev => {
    const next = typeof v === 'function' ? v(prev.coordinatorTaskIndex) : v;
    if (next === prev.coordinatorTaskIndex) return prev;
    return {
      ...prev,
      coordinatorTaskIndex: next
    };
  }), [setAppState]);
  const coordinatorTaskCount = useCoordinatorTaskCount();
  // The pill (BackgroundTaskStatus) only renders when non-local_agent bg tasks
  // exist. When only local_agent tasks are running (coordinator/fork mode), the
  // pill is absent, so the -1 sentinel would leave nothing visually selected.
  // In that case, skip -1 and treat 0 as the minimum selectable index.
  const hasBgTaskPill = useMemo(() => Object.values(tasks).some(t => isBackgroundTask(t)), [tasks]);
  const minCoordinatorIndex = hasBgTaskPill ? -1 : 0;
  // Clamp index when tasks complete and the list shrinks beneath the cursor
  useEffect(() => {
    if (coordinatorTaskIndex >= coordinatorTaskCount) {
      setCoordinatorTaskIndex(Math.max(minCoordinatorIndex, coordinatorTaskCount - 1));
    } else if (coordinatorTaskIndex < minCoordinatorIndex) {
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
  }, [coordinatorTaskCount, coordinatorTaskIndex, minCoordinatorIndex]);
  const [isPasting, setIsPasting] = useState(false);
  const [isExternalEditorActive, setIsExternalEditorActive] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const [showFastModePicker, setShowFastModePicker] = useState(false);
  const [showThinkingToggle, setShowThinkingToggle] = useState(false);
  const [showAutoModeOptIn, setShowAutoModeOptIn] = useState(false);
  const [previousModeBeforeAuto, setPreviousModeBeforeAuto] = useState<PermissionMode | null>(null);
  const autoModeOptInTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const {
    dangerousModeDialog,
    isConfirmingDangerousMode,
    requestPermissionModeChange
  } = usePermissionModeChangeRequest();

  // Check if cursor is on the first line of input
  const isCursorOnFirstLine = useMemo(() => {
    const firstNewlineIndex = input.indexOf('\n');
    if (firstNewlineIndex === -1) {
      return true; // No newlines, cursor is always on first line
    }
    return cursorOffset <= firstNewlineIndex;
  }, [input, cursorOffset]);
  const isCursorOnLastLine = useMemo(() => {
    const lastNewlineIndex = input.lastIndexOf('\n');
    if (lastNewlineIndex === -1) {
      return true; // No newlines, cursor is always on last line
    }
    return cursorOffset > lastNewlineIndex;
  }, [input, cursorOffset]);

  // Derive team info from teamContext (no filesystem I/O needed)
  // A session can only lead one team at a time
  const cachedTeams: TeamSummary[] = useMemo(() => {
    if (!isAgentSwarmsEnabled()) return [];
    // In-process mode uses Shift+Down/Up navigation instead of footer menu
    if (isInProcessEnabled()) return [];
    if (!teamContext) {
      return [];
    }
    const teammateCount = count(Object.values(teamContext.teammates), t => t.name !== 'team-lead');
    return [{
      name: teamContext.teamName,
      memberCount: teammateCount,
      runningCount: 0,
      idleCount: 0
    }];
  }, [teamContext]);

  // ─── Footer pill navigation ─────────────────────────────────────────────
  // Which pills render below the input box. Order here IS the nav order
  // (down/right = forward, up/left = back). Selection lives in AppState so
  // pills rendered outside PromptInput (CompanionSprite) can read focus.
  const backgroundTaskCount = useMemo(() => countVisibleBackgroundTasks(tasks), [tasks]);
  const tasksFooterVisible = backgroundTaskCount > 0 && !shouldHideTasksFooter(tasks, showSpinnerTree);
  const teamsFooterVisible = cachedTeams.length > 0;
  const footerItems = useMemo(() => [tasksFooterVisible && 'tasks', tmuxFooterVisible && 'tmux', bagelFooterVisible && 'bagel', teamsFooterVisible && 'teams', bridgeFooterVisible && 'bridge', companionFooterVisible && 'companion'].filter(Boolean) as FooterItem[], [tasksFooterVisible, tmuxFooterVisible, bagelFooterVisible, teamsFooterVisible, bridgeFooterVisible, companionFooterVisible]);

  // Effective selection: null if the selected pill stopped rendering (bridge
  // disconnected, task finished). The derivation makes the UI correct
  // immediately; the useEffect below clears the raw state so it doesn't
  // resurrect when the same pill reappears (new task starts → focus stolen).
  const rawFooterSelection = useAppState(s => s.footerSelection);
  const footerItemSelected = rawFooterSelection && footerItems.includes(rawFooterSelection) ? rawFooterSelection : null;
  useEffect(() => {
    if (rawFooterSelection && !footerItemSelected) {
      setAppState(prev => prev.footerSelection === null ? prev : {
        ...prev,
        footerSelection: null
      });
    }
  }, [rawFooterSelection, footerItemSelected, setAppState]);
  const tasksSelected = footerItemSelected === 'tasks';
  const tmuxSelected = footerItemSelected === 'tmux';
  const bagelSelected = footerItemSelected === 'bagel';
  const teamsSelected = footerItemSelected === 'teams';
  const bridgeSelected = footerItemSelected === 'bridge';
  function selectFooterItem(item: FooterItem | null): void {
    setAppState(prev => prev.footerSelection === item ? prev : {
      ...prev,
      footerSelection: item
    });
    if (item === 'tasks') {
      setTeammateFooterIndex(0);
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
  }

  // delta: +1 = down/right, -1 = up/left. Returns true if nav happened
  // (including deselecting at the start), false if at a boundary.
  function navigateFooter(delta: 1 | -1, exitAtStart = false): boolean {
    const idx = footerItemSelected ? footerItems.indexOf(footerItemSelected) : -1;
    const next = footerItems[idx + delta];
    if (next) {
      selectFooterItem(next);
      return true;
    }
    if (delta < 0 && exitAtStart) {
      selectFooterItem(null);
      return true;
    }
    return false;
  }

  // Prompt suggestion hook - reads suggestions generated by forked agent in query loop
  const {
    suggestion: promptSuggestion,
    markAccepted,
    logOutcomeAtSubmission,
    markShown
  } = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading
  });
  const displayedValue = useMemo(() => isSearchingHistory && historyMatch ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display) : input, [isSearchingHistory, historyMatch, input]);
  const thinkTriggers = useMemo(() => findThinkingTriggerPositions(displayedValue), [displayedValue]);
  const ultraplanSessionUrl = useAppState(s => s.ultraplanSessionUrl);
  const ultraplanLaunching = useAppState(s => s.ultraplanLaunching);
  const ultraplanTriggers = useMemo(() => feature('ULTRAPLAN') && !ultraplanSessionUrl && !ultraplanLaunching ? findUltraplanTriggerPositions(displayedValue) : [], [displayedValue, ultraplanSessionUrl, ultraplanLaunching]);
  const ultrareviewTriggers = useMemo(() => isUltrareviewEnabled() ? findUltrareviewTriggerPositions(displayedValue) : [], [displayedValue]);
  const btwTriggers = useMemo(() => findBtwTriggerPositions(displayedValue), [displayedValue]);
  const buddyTriggers = useMemo(() => findBuddyTriggerPositions(displayedValue), [displayedValue]);
  const slashCommandTriggers = useMemo(() => {
    const positions = findSlashCommandPositions(displayedValue);
    // Only highlight valid commands
    return positions.filter(pos => {
      const commandName = displayedValue.slice(pos.start + 1, pos.end); // +1 to skip "/"
      return hasCommand(commandName, commands);
    });
  }, [displayedValue, commands]);
  const tokenBudgetTriggers = useMemo(() => feature('TOKEN_BUDGET') ? findTokenBudgetPositions(displayedValue) : [], [displayedValue]);
  const knownChannelsVersion = useSyncExternalStore(subscribeKnownChannels, getKnownChannelsVersion);
  const slackChannelTriggers = useMemo(() => hasSlackMcpServer(store.getState().mcp.clients) ? findSlackChannelPositions(displayedValue) : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps -- store is a stable ref
  [displayedValue, knownChannelsVersion]);

  // Find @name mentions and highlight with team member's color
  const memberMentionHighlights = useMemo((): Array<{
    start: number;
    end: number;
    themeColor: keyof Theme;
  }> => {
    if (!isAgentSwarmsEnabled()) return [];
    if (!teamContext?.teammates) return [];
    const highlights: Array<{
      start: number;
      end: number;
      themeColor: keyof Theme;
    }> = [];
    const members = teamContext.teammates;
    if (!members) return highlights;

    // Find all @name patterns in the input
    const regex = /(^|\s)@([\w-]+)/g;
    const memberValues = Object.values(members);
    let match;
    while ((match = regex.exec(displayedValue)) !== null) {
      const leadingSpace = match[1] ?? '';
      const nameStart = match.index + leadingSpace.length;
      const fullMatch = match[0].trimStart();
      const name = match[2];

      // Check if this name matches a team member
      const member = memberValues.find(t => t.name === name);
      if (member?.color) {
        const themeColor = AGENT_COLOR_TO_THEME_COLOR[member.color as AgentColorName];
        if (themeColor) {
          highlights.push({
            start: nameStart,
            end: nameStart + fullMatch.length,
            themeColor
          });
        }
      }
    }
    return highlights;
  }, [displayedValue, teamContext]);
  const imageRefPositions = useMemo(() => parseReferences(displayedValue).filter(r => r.match.startsWith('[Image')).map(r => ({
    start: r.index,
    end: r.index + r.match.length
  })), [displayedValue]);

  // chip.start is the "selected" state: the inverted chip IS the cursor.
  // chip.end stays a normal position so you can park the cursor right after
  // `]` like any other character.
  const cursorAtImageChip = imageRefPositions.some(r => r.start === cursorOffset);

  // up/down movement or a fullscreen click can land the cursor strictly
  // inside a chip; snap to the nearer boundary so it's never editable
  // char-by-char.
  useEffect(() => {
    const inside = imageRefPositions.find(r => cursorOffset > r.start && cursorOffset < r.end);
    if (inside) {
      const mid = (inside.start + inside.end) / 2;
      setCursorOffset(cursorOffset < mid ? inside.start : inside.end);
    }
  }, [cursorOffset, imageRefPositions, setCursorOffset]);
  const combinedHighlights = useMemo((): TextHighlight[] => {
    const highlights: TextHighlight[] = [];

    // Invert the [Image #N] chip when the cursor is at chip.start (the
    // "selected" state) so backspace-to-delete is visually obvious.
    for (const ref of imageRefPositions) {
      if (cursorOffset === ref.start) {
        highlights.push({
          start: ref.start,
          end: ref.end,
          color: undefined,
          inverse: true,
          priority: 8
        });
      }
    }
    if (isSearchingHistory && historyMatch && !historyFailedMatch) {
      highlights.push({
        start: cursorOffset,
        end: cursorOffset + historyQuery.length,
        color: 'warning',
        priority: 20
      });
    }

    // Add "btw" highlighting (solid yellow)
    for (const trigger of btwTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'warning',
        priority: 15
      });
    }

    // Add /command highlighting (blue)
    for (const trigger of slashCommandTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5
      });
    }

    // Add token budget highlighting (blue)
    for (const trigger of tokenBudgetTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5
      });
    }
    for (const trigger of slackChannelTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5
      });
    }

    // Add @name highlighting with team member's color
    for (const mention of memberMentionHighlights) {
      highlights.push({
        start: mention.start,
        end: mention.end,
        color: mention.themeColor,
        priority: 5
      });
    }

    // Dim interim voice dictation text
    if (voiceInterimRange) {
      highlights.push({
        start: voiceInterimRange.start,
        end: voiceInterimRange.end,
        color: undefined,
        dimColor: true,
        priority: 1
      });
    }

    // Rainbow highlighting for ultrathink keyword (per-character cycling colors)
    if (isUltrathinkEnabled()) {
      for (const trigger of thinkTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10
          });
        }
      }
    }

    // Same rainbow treatment for the ultraplan keyword
    if (feature('ULTRAPLAN')) {
      for (const trigger of ultraplanTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10
          });
        }
      }
    }

    // Same rainbow treatment for the ultrareview keyword
    for (const trigger of ultrareviewTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10
        });
      }
    }

    // Rainbow for /buddy
    for (const trigger of buddyTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10
        });
      }
    }
    return highlights;
  }, [isSearchingHistory, historyQuery, historyMatch, historyFailedMatch, cursorOffset, btwTriggers, imageRefPositions, memberMentionHighlights, slashCommandTriggers, tokenBudgetTriggers, slackChannelTriggers, displayedValue, voiceInterimRange, thinkTriggers, ultraplanTriggers, ultrareviewTriggers, buddyTriggers]);
  const {
    addNotification,
    removeNotification
  } = useNotifications();

  // Show ultrathink notification
  useEffect(() => {
    if (thinkTriggers.length && isUltrathinkEnabled()) {
      addNotification({
        key: 'ultrathink-active',
        text: 'Effort set to high for this turn',
        priority: 'immediate',
        timeoutMs: 5000
      });
    } else {
      removeNotification('ultrathink-active');
    }
  }, [addNotification, removeNotification, thinkTriggers.length]);
  useEffect(() => {
    if (feature('ULTRAPLAN') && ultraplanTriggers.length) {
      addNotification({
        key: 'ultraplan-active',
        text: 'This prompt will launch an ultraplan session in OpenClaude on the web',
        priority: 'immediate',
        timeoutMs: 5000
      });
    } else {
      removeNotification('ultraplan-active');
    }
  }, [addNotification, removeNotification, ultraplanTriggers.length]);
  useEffect(() => {
    if (isUltrareviewEnabled() && ultrareviewTriggers.length) {
      addNotification({
        key: 'ultrareview-active',
        text: 'Run /ultrareview after Claude finishes to review these changes in the cloud',
        priority: 'immediate',
        timeoutMs: 5000
      });
    }
  }, [addNotification, ultrareviewTriggers.length]);

  // Track input length for stash hint
  const prevInputLengthRef = useRef(input.length);
  const peakInputLengthRef = useRef(input.length);

  // Dismiss stash hint when user makes any input change
  const dismissStashHint = useCallback(() => {
    removeNotification('stash-hint');
  }, [removeNotification]);

  // Show stash hint when user gradually clears substantial input
  useEffect(() => {
    const prevLength = prevInputLengthRef.current;
    const peakLength = peakInputLengthRef.current;
    const currentLength = input.length;
    prevInputLengthRef.current = currentLength;

    // Update peak when input grows
    if (currentLength > peakLength) {
      peakInputLengthRef.current = currentLength;
      return;
    }

    // Reset state when input is empty
    if (currentLength === 0) {
      peakInputLengthRef.current = 0;
      return;
    }

    // Detect gradual clear: peak was high, current is low, but this wasn't a single big jump
    // (rapid clears like esc-esc go from 20+ to 0 in one step)
    const clearedSubstantialInput = peakLength >= 20 && currentLength <= 5;
    const wasRapidClear = prevLength >= 20 && currentLength <= 5;
    if (clearedSubstantialInput && !wasRapidClear) {
      const config = getGlobalConfig();
      if (!config.hasUsedStash) {
        addNotification({
          key: 'stash-hint',
          jsx: <Text dimColor>
              Tip:{' '}
              <ConfigurableShortcutHint action="chat:stash" context="Chat" fallback="ctrl+s" description="stash" />
            </Text>,
          priority: 'immediate',
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT
        });
      }
      peakInputLengthRef.current = currentLength;
    }
  }, [input.length, addNotification]);

  // Initialize input buffer for undo functionality
  const {
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer
  } = useInputBuffer({
    maxBufferSize: 50,
    debounceMs: 1000
  });
  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange: trackAndSetInput,
    setCursorOffset,
    setPastedContents
  });
  const defaultPlaceholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName
  });
  const pendingCoalescedModeSubmitRef = React.useRef<ReturnType<typeof detectModeEntry>>(null);
  const suppressNextCoalescedSubmitRef = React.useRef(false);
  const onChange = useCallback((value: string, changeContext?: TextInputChangeContext) => {
    const helpToggleChange = resolveHelpToggleChange(value, changeContext);
    if (helpToggleChange) {
      logEvent('tengu_help_toggled', {});
      setHelpOpen(v => !v);
      pendingCoalescedModeSubmitRef.current = null;
      suppressNextCoalescedSubmitRef.current = helpToggleChange.suppressSubmit;
      if (helpToggleChange.restore) {
        trackAndSetInput(helpToggleChange.restore.value);
        setCursorOffset(helpToggleChange.restore.cursorOffset);
      }
      return;
    }
    setHelpOpen(false);

    // Dismiss stash hint when user makes any input change
    dismissStashHint();

    // Cancel any pending prompt suggestion and speculation when user types
    abortPromptSuggestion();
    abortSpeculation(setAppState);

    // Strip the mode character from the buffer when entering bash mode — the
    // mode itself is shown via the prompt prefix in the UI. Without this,
    // typing `!` into empty input would enter bash mode but leave the literal
    // `!` in the buffer (issue #662).
    const modeDetectionValue = changeContext?.previousValue ?? input;
    const modeDetectionCursorOffset = changeContext?.cursorOffset ?? cursorOffset;
    const modeEntry = detectModeEntry({
      value,
      prevInputLength: modeDetectionValue.length,
      cursorOffset: modeDetectionCursorOffset,
    });
    if (modeEntry) {
      const cleaned = modeEntry.strippedValue.replaceAll('\t', '    ');
      pendingCoalescedModeSubmitRef.current = changeContext?.willSubmit ? {
        ...modeEntry,
        strippedValue: cleaned
      } : null;
      onModeChange(modeEntry.mode);
      pushToBuffer(input, cursorOffset, pastedContents);
      trackAndSetInput(cleaned);
      setCursorOffset(cleaned.length);
      return;
    }
    pendingCoalescedModeSubmitRef.current = null;
    const processedValue = value.replaceAll('\t', '    ');

    // Push current state to buffer before making changes
    if (input !== processedValue) {
      pushToBuffer(input, cursorOffset, pastedContents);
    }

    // Deselect footer items when user types
    setAppState(prev => prev.footerSelection === null ? prev : {
      ...prev,
      footerSelection: null
    });
    trackAndSetInput(processedValue);
  }, [trackAndSetInput, onModeChange, input, cursorOffset, pushToBuffer, pastedContents, dismissStashHint, setAppState]);
  const {
    resetHistory,
    onHistoryUp,
    onHistoryDown,
    dismissSearchHint,
    historyIndex
  } = useArrowKeyHistory((value: string, historyMode: HistoryMode, pastedContents: Record<number, PastedContent>) => {
    onChange(value);
    onModeChange(historyMode);
    setPastedContents(pastedContents);
  }, input, pastedContents, setCursorOffset, mode);

  // Dismiss search hint when user starts searching
  useEffect(() => {
    if (isSearchingHistory) {
      dismissSearchHint();
    }
  }, [isSearchingHistory, dismissSearchHint]);

  // Only use history navigation when there are 0 or 1 slash command suggestions.
  // Footer nav is NOT here — when a pill is selected, TextInput focus=false so
  // these never fire. The Footer keybinding context handles ↑/↓ instead.
  function handleHistoryUp() {
    if (suggestions.length > 1) {
      return;
    }

    // Only navigate history when cursor is on the first line.
    // In multiline inputs, up arrow should move the cursor (handled by TextInput)
    // and only trigger history when at the top of the input.
    if (!isCursorOnFirstLine) {
      return;
    }

    // If there's an editable queued command, move it to the input for editing when UP is pressed
    const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
    if (hasEditableCommand) {
      void popAllCommandsFromQueue();
      return;
    }
    onHistoryUp();
  }
  function handleHistoryDown() {
    if (suggestions.length > 1) {
      return;
    }

    // Only navigate history/footer when cursor is on the last line.
    // In multiline inputs, down arrow should move the cursor (handled by TextInput)
    // and only trigger navigation when at the bottom of the input.
    if (!isCursorOnLastLine) {
      return;
    }

    // At bottom of history → enter footer at first visible pill
    if (onHistoryDown() && footerItems.length > 0) {
      const first = footerItems[0]!;
      selectFooterItem(first);
      if (first === 'tasks' && !getGlobalConfig().hasSeenTasksHint) {
        saveGlobalConfig(c => c.hasSeenTasksHint ? c : {
          ...c,
          hasSeenTasksHint: true
        });
      }
    }
  }

  // Create a suggestions state directly - we'll sync it with useTypeahead later
  const [suggestionsState, setSuggestionsStateRaw] = useState<{
    suggestions: SuggestionItem[];
    selectedSuggestion: number;
    commandArgumentHint?: string;
  }>({
    suggestions: [],
    selectedSuggestion: -1,
    commandArgumentHint: undefined
  });

  // Setter for suggestions state
  const setSuggestionsState = useCallback((updater: typeof suggestionsState | ((prev: typeof suggestionsState) => typeof suggestionsState)) => {
    setSuggestionsStateRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const onSubmit = useCallback(async (inputParam: string, isSubmittingSlashCommand = false, slashCommandOverride?: Command) => {
    if (suppressNextCoalescedSubmitRef.current) {
      suppressNextCoalescedSubmitRef.current = false;
      return;
    }
    const pendingModeEntry = pendingCoalescedModeSubmitRef.current;
    pendingCoalescedModeSubmitRef.current = null;
    const modeSubmission = resolveCoalescedModeSubmission(inputParam, mode, pendingModeEntry);
    inputParam = modeSubmission.input;
    const effectiveSubmissionMode = modeSubmission.mode;
    inputParam = inputParam.trimEnd();

    // Don't submit if a footer indicator is being opened. Read fresh from
    // store — footer:openSelected calls selectFooterItem(null) then onSubmit
    // in the same tick, and the closure value hasn't updated yet. Apply the
    // same "still visible?" derivation as footerItemSelected so a stale
    // selection (pill disappeared) doesn't swallow Enter.
    const state = store.getState();
    if (state.footerSelection && footerItems.includes(state.footerSelection)) {
      return;
    }

    // Enter in selection modes confirms selection (useBackgroundTaskNavigation).
    // BaseTextInput's useInput registers before that hook (child effects fire first),
    // so without this guard Enter would double-fire and auto-submit the suggestion.
    if (state.viewSelectionMode === 'selecting-agent') {
      return;
    }

    // Check for images early - we need this for suggestion logic below
    const hasImages = Object.values(pastedContents).some(c => c.type === 'image');

    // If input is empty OR matches the suggestion, submit it
    // But if there are images attached, don't auto-accept the suggestion -
    // the user wants to submit just the image(s).
    // Only in leader view — promptSuggestion is leader-context, not teammate.
    const suggestionText = promptSuggestionState.text;
    const inputMatchesSuggestion = inputParam.trim() === '' || inputParam === suggestionText;
    if (canAcceptPromptSuggestion(effectiveSubmissionMode) && inputMatchesSuggestion && suggestionText && !hasImages && !state.viewingAgentTaskId) {
      // If speculation is active, inject messages immediately as they stream
      if (speculation.status === 'active') {
        markAccepted();
        // skipReset: resetSuggestion would abort the speculation before we accept it
        logOutcomeAtSubmission(suggestionText, {
          skipReset: true
        });
        void onSubmitProp(suggestionText, {
          setCursorOffset,
          clearBuffer,
          resetHistory
        }, {
          state: speculation,
          speculationSessionTimeSavedMs: speculationSessionTimeSavedMs,
          setAppState
        }, modeSubmission.inputModeOverride ? {
          inputModeOverride: modeSubmission.inputModeOverride
        } : undefined);
        return; // Skip normal query - speculation handled it
      }

      // Regular suggestion acceptance (requires shownAt > 0)
      if (promptSuggestionState.shownAt > 0) {
        markAccepted();
        inputParam = suggestionText;
      }
    }

    // Handle @name direct message
    if (isAgentSwarmsEnabled()) {
      const directMessage = parseDirectMemberMessage(inputParam);
      if (directMessage) {
        const result = await sendDirectMemberMessage(directMessage.recipientName, directMessage.message, teamContext, writeToMailbox);
        if (result.success) {
          addNotification({
            key: 'direct-message-sent',
            text: `Sent to @${result.recipientName}`,
            priority: 'immediate',
            timeoutMs: 3000
          });
          trackAndSetInput('');
          setCursorOffset(0);
          clearBuffer();
          resetHistory();
          return;
        } else if (result.error === 'no_team_context') {
          // No team context - fall through to normal prompt submission
        } else {
          // Unknown recipient - fall through to normal prompt submission
          // This allows e.g. "@utils explain this code" to be sent as a prompt
        }
      }
    }

    // Allow submission if there are images attached, even without text
    if (inputParam.trim() === '' && !hasImages) {
      return;
    }

    // PromptInput UX: Check if suggestions dropdown is showing
    // For directory suggestions, allow submission (Tab is used for completion)
    const hasDirectorySuggestions = suggestionsState.suggestions.length > 0 && suggestionsState.suggestions.every(s => s.description === 'directory');
    if (canAcceptPromptSuggestion(effectiveSubmissionMode) && suggestionsState.suggestions.length > 0 && !isSubmittingSlashCommand && !hasDirectorySuggestions) {
      logForDebugging(`[onSubmit] early return: suggestions showing (count=${suggestionsState.suggestions.length})`);
      return; // Don't submit, user needs to clear suggestions first
    }

    // Log suggestion outcome if one exists
    if (promptSuggestionState.text && promptSuggestionState.shownAt > 0) {
      logOutcomeAtSubmission(inputParam);
    }

    // Clear stash hint notification on submit
    removeNotification('stash-hint');

    // Route input to viewed agent (in-process teammate or named local_agent).
    const activeAgent = getActiveAgentForInput(store.getState());
    if (activeAgent.type !== 'leader' && onAgentSubmit) {
      logEvent('tengu_transcript_input_to_teammate', {});
      await onAgentSubmit(inputParam, activeAgent.task, {
        setCursorOffset,
        clearBuffer,
        resetHistory
      });
      return;
    }

    // Normal leader submission
    const submitOptions = slashCommandOverride || modeSubmission.inputModeOverride ? {
      slashCommandOverride,
      inputModeOverride: modeSubmission.inputModeOverride
    } : undefined;
    await onSubmitProp(inputParam, {
      setCursorOffset,
      clearBuffer,
      resetHistory
    }, undefined, submitOptions);
  }, [promptSuggestionState, speculation, speculationSessionTimeSavedMs, teamContext, store, footerItems, suggestionsState.suggestions, onSubmitProp, onAgentSubmit, clearBuffer, resetHistory, logOutcomeAtSubmission, setAppState, markAccepted, pastedContents, removeNotification, mode]);
  const {
    suggestions,
    selectedSuggestion,
    commandArgumentHint,
    inlineGhostText,
    maxColumnWidth
  } = useTypeahead({
    commands,
    onInputChange: trackAndSetInput,
    onSubmit,
    setCursorOffset,
    input,
    cursorOffset,
    mode,
    agents,
    setSuggestionsState,
    suggestionsState,
    suppressSuggestions: isSearchingHistory || historyIndex > 0,
    markAccepted,
    onModeChange
  });

  // Track if prompt suggestion should be shown (computed later with terminal width).
  // Hidden in teammate view — suggestion is leader-context only.
  const showPromptSuggestion = mode === 'prompt' && suggestions.length === 0 && promptSuggestion && !viewingAgentTaskId;
  if (showPromptSuggestion) {
    markShown();
  }

  // If suggestion was generated but can't be shown due to timing, log suppression.
  // Exclude teammate view: markShown() is gated above, so shownAt stays 0 there —
  // but that's not a timing failure, the suggestion is valid when returning to leader.
  if (promptSuggestionState.text && !promptSuggestion && promptSuggestionState.shownAt === 0 && !viewingAgentTaskId) {
    logSuggestionSuppressed('timing', promptSuggestionState.text);
    setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      }
    }));
  }
  function onImagePaste(image: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) {
    logEvent('tengu_paste_image', {});
    onModeChange('prompt');
    const pasteId = nextPasteIdRef.current++;
    const newContent: PastedContent = {
      id: pasteId,
      type: 'image',
      content: image,
      mediaType: mediaType || 'image/png',
      // default to PNG if not provided
      filename: filename || 'Pasted image',
      dimensions,
      sourcePath
    };

    // Cache path immediately (fast) so links work on render
    cacheImagePath(newContent);

    // Store image to disk in background
    void storeImage(newContent);

    // Update UI
    setPastedContents(prev => ({
      ...prev,
      [pasteId]: newContent
    }));
    // Multi-image paste calls onImagePaste in a loop. If the ref is already
    // armed, the previous pill's lazy space fires now (before this pill)
    // rather than being lost.
    const prefix = pendingSpaceAfterPillRef.current ? ' ' : '';
    insertTextAtCursor(prefix + formatImageRef(pasteId));
    pendingSpaceAfterPillRef.current = true;
  }

  // Prune images whose [Image #N] placeholder is no longer in the input text.
  // Covers pill backspace, Ctrl+U, char-by-char deletion — any edit that drops
  // the ref. onImagePaste batches setPastedContents + insertTextAtCursor in the
  // same event, so this effect sees the placeholder already present.
  useEffect(() => {
    const referencedIds = new Set(parseReferences(input).map(r => r.id));
    setPastedContents(prev => {
      const orphaned = Object.values(prev).filter(c => c.type === 'image' && !referencedIds.has(c.id));
      if (orphaned.length === 0) return prev;
      const next = {
        ...prev
      };
      for (const img of orphaned) delete next[img.id];
      return next;
    });
  }, [input, setPastedContents]);
  function onTextPaste(rawText: string) {
    pendingSpaceAfterPillRef.current = false;
    // Clean up pasted text - strip ANSI escape codes and normalize line endings and tabs
    let text = stripAnsi(rawText).replace(/\r/g, '\n').replaceAll('\t', '    ');

    // Detect file paths from drag-and-drop and convert to @mentions.
    // When files are dragged into the terminal, the terminal sends their
    // absolute paths via bracketed paste. Image files are handled by the
    // image paste handler upstream; here we handle non-image files by
    // converting them to @mentions so they get attached on submit.
    const draggedPaths = extractDraggedFilePaths(text);
    if (draggedPaths.length > 0) {
      const mentions = draggedPaths
        .map(p => (p.includes(' ') || p.includes(':') ? `@"${p}"` : `@${p}`))
        .join(' ');
      // Ensure spacing around the mention(s) relative to existing input
      const charBefore = input[cursorOffset - 1];
      const prefix = charBefore && !/\s/.test(charBefore) ? ' ' : '';
      text = prefix + mentions + ' ';
    }

    // Match typed/auto-suggest: `!cmd` pasted into empty input enters bash mode.
    if (input.length === 0) {
      const pastedMode = getModeFromInput(text);
      if (pastedMode !== 'prompt') {
        onModeChange(pastedMode);
        text = getValueFromInput(text);
      }
    }
    const numLines = getPastedTextRefNumLines(text);
    // Limit the number of lines to show in the input
    // If the overall layout is too high then Ink will repaint
    // the entire terminal.
    // The actual required height is dependent on the content, this
    // is just an estimate.
    const maxLines = Math.min(rows - 10, 2);

    // Use special handling for long pasted text (>PASTE_THRESHOLD chars)
    // or if it exceeds the number of lines we want to show
    if (text.length > PASTE_THRESHOLD || numLines > maxLines) {
      const pasteId = nextPasteIdRef.current++;
      const newContent: PastedContent = {
        id: pasteId,
        type: 'text',
        content: text
      };
      setPastedContents(prev => ({
        ...prev,
        [pasteId]: newContent
      }));
      insertTextAtCursor(formatPastedTextRef(pasteId, numLines));
    } else {
      // For shorter pastes, just insert the text normally
      insertTextAtCursor(text);
    }
  }
  const lazySpaceInputFilter = useCallback((input: string, key: Key): string => {
    const prependLazySpace = pendingSpaceAfterPillRef.current;
    pendingSpaceAfterPillRef.current = false;
    return normalizePromptInputChunk(input, key, prependLazySpace);
  }, []);
  // Ref mirrors cursorOffset for use in synchronous loops (e.g. multi-image
  // paste) where React batches state updates and the closure value is stale.
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;

  function insertTextAtCursor(text: string) {
    // Use refs for input/cursor so back-to-back calls in the same event
    // (e.g. onImagePaste loop for multiple dragged images) chain correctly
    // instead of each reading the same stale closure values.
    const currentInput = lastInternalInputRef.current;
    const currentOffset = cursorOffsetRef.current;
    pushToBuffer(currentInput, currentOffset, pastedContents);
    const newInput = currentInput.slice(0, currentOffset) + text + currentInput.slice(currentOffset);
    trackAndSetInput(newInput);
    const newOffset = currentOffset + text.length;
    cursorOffsetRef.current = newOffset;
    setCursorOffset(newOffset);
  }
  const doublePressEscFromEmpty = useDoublePress(() => {}, () => onShowMessageSelector());

  // Function to get the queued command for editing. Returns true if commands were popped.
  const popAllCommandsFromQueue = useCallback((): boolean => {
    const result = popAllEditable(input, cursorOffset);
    if (!result) {
      return false;
    }
    trackAndSetInput(result.text);
    onModeChange('prompt'); // Always prompt mode for queued commands
    setCursorOffset(result.cursorOffset);

    // Restore images from queued commands to pastedContents
    if (result.images.length > 0) {
      setPastedContents(prev => {
        const newContents = {
          ...prev
        };
        for (const image of result.images) {
          newContents[image.id] = image;
        }
        return newContents;
      });
    }
    return true;
  }, [trackAndSetInput, onModeChange, input, cursorOffset, setPastedContents]);

  // Insert the at-mentioned reference (the file and, optionally, a line range) when
  // we receive an at-mentioned notification the IDE.
  const onIdeAtMentioned = function (atMentioned: IDEAtMentioned) {
    logEvent('tengu_ext_at_mentioned', {});
    let atMentionedText: string;
    const relativePath = path.relative(getCwd(), atMentioned.filePath);
    if (atMentioned.lineStart && atMentioned.lineEnd) {
      atMentionedText = atMentioned.lineStart === atMentioned.lineEnd ? `@${relativePath}#L${atMentioned.lineStart} ` : `@${relativePath}#L${atMentioned.lineStart}-${atMentioned.lineEnd} `;
    } else {
      atMentionedText = `@${relativePath} `;
    }
    const cursorChar = input[cursorOffset - 1] ?? ' ';
    if (!/\s/.test(cursorChar)) {
      atMentionedText = ` ${atMentionedText}`;
    }
    insertTextAtCursor(atMentionedText);
  };
  useIdeAtMentioned(mcpClients, onIdeAtMentioned);

  // Handler for chat:undo - undo last edit
  const handleUndo = useCallback(() => {
    if (canUndo) {
      const previousState = undo();
      if (previousState) {
        trackAndSetInput(previousState.text);
        setCursorOffset(previousState.cursorOffset);
        setPastedContents(previousState.pastedContents);
      }
    }
  }, [canUndo, undo, trackAndSetInput, setPastedContents]);

  // Handler for chat:newline - insert a newline at the cursor position
  const handleNewline = useCallback(() => {
    pushToBuffer(input, cursorOffset, pastedContents);
    const newInput = input.slice(0, cursorOffset) + '\n' + input.slice(cursorOffset);
    trackAndSetInput(newInput);
    setCursorOffset(cursorOffset + 1);
  }, [input, cursorOffset, trackAndSetInput, setCursorOffset, pushToBuffer, pastedContents]);

  // Handler for chat:externalEditor - edit in $EDITOR
  const handleExternalEditor = useCallback(async () => {
    logEvent('tengu_external_editor_used', {});
    setIsExternalEditorActive(true);
    try {
      // Pass pastedContents to expand collapsed text references
      const result = await editPromptInEditor(input, pastedContents);
      if (result.error) {
        addNotification({
          key: 'external-editor-error',
          text: result.error,
          color: 'warning',
          priority: 'high'
        });
      }
      if (result.content !== null && result.content !== input) {
        // Push current state to buffer before making changes
        pushToBuffer(input, cursorOffset, pastedContents);
        trackAndSetInput(result.content);
        setCursorOffset(result.content.length);
      }
    } catch (err) {
      if (err instanceof Error) {
        logError(err);
      }
      addNotification({
        key: 'external-editor-error',
        text: `External editor failed: ${errorMessage(err)}`,
        color: 'warning',
        priority: 'high'
      });
    } finally {
      setIsExternalEditorActive(false);
    }
  }, [input, cursorOffset, pastedContents, pushToBuffer, trackAndSetInput, addNotification]);

  // Handler for chat:stash - stash/unstash prompt
  const handleStash = useCallback(() => {
    if (input.trim() === '' && stashedPrompt !== undefined) {
      // Pop stash when input is empty
      trackAndSetInput(stashedPrompt.text);
      setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    } else if (input.trim() !== '') {
      // Push to stash (save text, cursor position, and pasted contents)
      setStashedPrompt({
        text: input,
        cursorOffset,
        pastedContents
      });
      trackAndSetInput('');
      setCursorOffset(0);
      setPastedContents({});
      // Track usage for /discover and stop showing hint
      saveGlobalConfig(c => {
        if (c.hasUsedStash) return c;
        return {
          ...c,
          hasUsedStash: true
        };
      });
    }
  }, [input, cursorOffset, stashedPrompt, trackAndSetInput, setStashedPrompt, pastedContents, setPastedContents]);

  // Handler for chat:modelPicker - toggle model picker
  const handleModelPicker = useCallback(() => {
    setShowModelPicker(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // Handler for chat:fastMode - toggle fast mode picker
  const handleFastModePicker = useCallback(() => {
    setShowFastModePicker(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // Handler for chat:thinkingToggle - toggle thinking mode
  const handleThinkingToggle = useCallback(() => {
    setShowThinkingToggle(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // Handler for chat:cycleMode - cycle through permission modes
  const handleCycleMode = useCallback(() => {
    const applyModeChange = (nextMode: PermissionMode, preparedContext: ToolPermissionContext) => {
      logEvent('tengu_mode_cycle', {
        to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });

      if (nextMode === 'plan') {
        saveGlobalConfig(current => ({
          ...current,
          lastPlanModeUse: Date.now()
        }));
      }

      setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...preparedContext,
          mode: nextMode
        }
      }));
      setToolPermissionContext({
        ...preparedContext,
        mode: nextMode
      });
      syncTeammateMode(nextMode, teamContext?.teamName);

      if (helpOpen) {
        setHelpOpen(false);
      }
    };
    // When viewing a teammate, cycle their mode instead of the leader's
    if (isAgentSwarmsEnabled() && viewedTeammate && viewingAgentTaskId) {
      const teammateContext: ToolPermissionContext = {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode
      };
      // Pass undefined for teamContext (unused but kept for API compatibility)
      const nextMode = getNextPermissionMode(teammateContext, undefined);
      const applyTeammateModeChange = async () => {
        logEvent('tengu_mode_cycle', {
          to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        const teammateTaskId = viewingAgentTaskId;
        setAppState(prev => {
          const task = prev.tasks[teammateTaskId];
          if (!task || task.type !== 'in_process_teammate') {
            return prev;
          }
          if (task.permissionMode === nextMode) {
            return prev;
          }
          return {
            ...prev,
            tasks: {
              ...prev.tasks,
              [teammateTaskId]: {
                ...task,
                permissionMode: nextMode
              }
            }
          };
        });
        if (helpOpen) {
          setHelpOpen(false);
        }
      };
      void requestPermissionModeChange({
        mode: nextMode,
        toolPermissionContext: teammateContext,
        onApply: () => {
        void applyTeammateModeChange();
        },
        onBlocked: error => {
          addNotification({
            key: `permission-mode-cycle-${nextMode}`,
            text: error,
            color: 'warning',
            priority: 'high'
          });
        }
      });
      return;
    }

    // Compute the next mode without triggering side effects first
    logForDebugging(`[auto-mode] handleCycleMode: currentMode=${toolPermissionContext.mode} isAutoModeAvailable=${toolPermissionContext.isAutoModeAvailable} showAutoModeOptIn=${showAutoModeOptIn} timeoutPending=${!!autoModeOptInTimeoutRef.current}`);
    const nextMode = getNextPermissionMode(toolPermissionContext, teamContext);
    if (nextMode === 'bypassPermissions' || nextMode === 'fullAccess') {
      void requestPermissionModeChange({
        mode: nextMode,
        toolPermissionContext,
        onApply: () => {
          const {
            context: preparedContext
          } = cyclePermissionMode(toolPermissionContext, teamContext);
          applyModeChange(nextMode, preparedContext);
        },
        onBlocked: error => {
          addNotification({
            key: `permission-mode-cycle-${nextMode}`,
            text: error,
            color: 'warning',
            priority: 'high'
          });
        }
      });
      return;
    }

    // Check if user is entering auto mode for the first time. Gated on the
    // persistent settings flag (hasAutoModeOptIn) rather than the broader
    // hasAutoModeOptInAnySource so that --enable-auto-mode users still see
    // the warning dialog once — the CLI flag should grant carousel access,
    // not bypass the safety text.
    let isEnteringAutoModeFirstTime = false;
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      isEnteringAutoModeFirstTime = nextMode === 'auto' && toolPermissionContext.mode !== 'auto' && !hasAutoModeOptIn() && !viewingAgentTaskId; // Only show for primary agent, not subagents
    }
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (isEnteringAutoModeFirstTime) {
        // Store previous mode so we can revert if user declines
        setPreviousModeBeforeAuto(toolPermissionContext.mode);

        // Only update the UI mode label — do NOT call transitionPermissionMode
        // or cyclePermissionMode yet; we haven't confirmed with the user.
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: 'auto'
          }
        }));
        setToolPermissionContext({
          ...toolPermissionContext,
          mode: 'auto'
        });

        // Show opt-in dialog after 400ms debounce
        if (autoModeOptInTimeoutRef.current) {
          clearTimeout(autoModeOptInTimeoutRef.current);
        }
        autoModeOptInTimeoutRef.current = setTimeout((setShowAutoModeOptIn, autoModeOptInTimeoutRef) => {
          setShowAutoModeOptIn(true);
          autoModeOptInTimeoutRef.current = null;
        }, 400, setShowAutoModeOptIn, autoModeOptInTimeoutRef);
        if (helpOpen) {
          setHelpOpen(false);
        }
        return;
      }
    }

    // Dismiss auto mode opt-in dialog if showing or pending (user is cycling away).
    // Do NOT revert to previousModeBeforeAuto here — shift+tab means "advance the
    // carousel", not "decline". Reverting causes a ping-pong loop: auto reverts to
    // the prior mode, whose next mode is auto again, forever.
    // The dialog's own decline button (handleAutoModeOptInDecline) handles revert.
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (showAutoModeOptIn || autoModeOptInTimeoutRef.current) {
        if (showAutoModeOptIn) {
          logEvent('tengu_auto_mode_opt_in_dialog_decline', {});
        }
        setShowAutoModeOptIn(false);
        if (autoModeOptInTimeoutRef.current) {
          clearTimeout(autoModeOptInTimeoutRef.current);
          autoModeOptInTimeoutRef.current = null;
        }
        setPreviousModeBeforeAuto(null);
        // Fall through — mode is 'auto', cyclePermissionMode below goes to 'default'.
      }
    }

    // Now that we know this is NOT the first-time auto mode path,
    // call cyclePermissionMode to apply side effects (e.g. strip
    // dangerous permissions, activate classifier)
    const {
      context: preparedContext
    } = cyclePermissionMode(toolPermissionContext, teamContext);
    applyModeChange(nextMode, preparedContext);
  }, [addNotification, helpOpen, requestPermissionModeChange, setAppState, setHelpOpen, setToolPermissionContext, showAutoModeOptIn, teamContext, toolPermissionContext, viewedTeammate, viewingAgentTaskId]);

  // Handler for auto mode opt-in dialog acceptance
  const handleAutoModeOptInAccept = useCallback(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      setShowAutoModeOptIn(false);
      setPreviousModeBeforeAuto(null);

      // Now that the user accepted, apply the full transition: activate the
      // auto mode backend (classifier, beta headers) and strip dangerous
      // permissions (e.g. Bash(*) always-allow rules).
      const strippedContext = transitionPermissionMode(previousModeBeforeAuto ?? toolPermissionContext.mode, 'auto', toolPermissionContext);
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...strippedContext,
          mode: 'auto'
        }
      }));
      setToolPermissionContext({
        ...strippedContext,
        mode: 'auto'
      });

      // Close help tips if they're open when auto mode is enabled
      if (helpOpen) {
        setHelpOpen(false);
      }
    }
  }, [helpOpen, setHelpOpen, previousModeBeforeAuto, toolPermissionContext, setAppState, setToolPermissionContext]);

  // Handler for auto mode opt-in dialog decline
  const handleAutoModeOptInDecline = useCallback(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      logForDebugging(`[auto-mode] handleAutoModeOptInDecline: reverting to ${previousModeBeforeAuto}, setting isAutoModeAvailable=false`);
      setShowAutoModeOptIn(false);
      if (autoModeOptInTimeoutRef.current) {
        clearTimeout(autoModeOptInTimeoutRef.current);
        autoModeOptInTimeoutRef.current = null;
      }

      // Revert to previous mode and remove auto from the carousel
      // for the rest of this session
      if (previousModeBeforeAuto) {
        setAutoModeActive(false);
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: previousModeBeforeAuto,
            isAutoModeAvailable: false
          }
        }));
        setToolPermissionContext({
          ...toolPermissionContext,
          mode: previousModeBeforeAuto,
          isAutoModeAvailable: false
        });
        setPreviousModeBeforeAuto(null);
      }
    }
  }, [previousModeBeforeAuto, toolPermissionContext, setAppState, setToolPermissionContext]);

  // Handler for chat:imagePaste - paste image from clipboard
  const handleImagePaste = useCallback(() => {
    void getImageFromClipboard().then(imageData => {
      if (imageData) {
        onImagePaste(imageData.base64, imageData.mediaType);
      } else {
        const shortcutDisplay = getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v');
        const message = env.isSSH() ? "No image found in clipboard. You're SSH'd; try scp?" : `No image found in clipboard. Use ${shortcutDisplay} to paste images.`;
        addNotification({
          key: 'no-image-in-clipboard',
          text: message,
          priority: 'immediate',
          timeoutMs: 1000
        });
      }
    }).catch(error => {
      addNotification({
        key: CLIPBOARD_IMAGE_PASTE_FAILURE_KEY,
        text: formatClipboardImagePasteError(error),
        priority: 'immediate',
        timeoutMs: 5000
      });
    });
  }, [addNotification, onImagePaste]);

  // Register chat:submit handler directly in the handler registry (not via
  // useKeybindings) so that only the ChordInterceptor can invoke it for chord
  // completions (e.g., "ctrl+e s"). The default Enter binding for submit is
  // handled by TextInput directly (via onSubmit prop) and useTypeahead (for
  // autocomplete acceptance). Using useKeybindings would cause
  // stopImmediatePropagation on Enter, blocking autocomplete from seeing the key.
  const keybindingContext = useOptionalKeybindingContext();
  useEffect(() => {
    if (!keybindingContext || isModalOverlayActive) return;
    return keybindingContext.registerHandler({
      action: 'chat:submit',
      context: 'Chat',
      handler: () => {
        void onSubmit(input);
      }
    });
  }, [keybindingContext, isModalOverlayActive, onSubmit, input]);

  // Chat context keybindings for editing shortcuts
  // Note: history:previous/history:next are NOT handled here. They are passed as
  // onHistoryUp/onHistoryDown props to TextInput, so that useTextInput's
  // upOrHistoryUp/downOrHistoryDown can try cursor movement first and only
  // fall through to history when the cursor can't move further.
  const chatHandlers = useMemo(() => ({
    'chat:undo': handleUndo,
    'chat:newline': handleNewline,
    'chat:externalEditor': handleExternalEditor,
    'chat:stash': handleStash,
    'chat:modelPicker': handleModelPicker,
    'chat:thinkingToggle': handleThinkingToggle,
    'chat:cycleMode': handleCycleMode,
    'chat:imagePaste': handleImagePaste
  }), [handleUndo, handleNewline, handleExternalEditor, handleStash, handleModelPicker, handleThinkingToggle, handleCycleMode, handleImagePaste]);
  useKeybindings(chatHandlers, {
    context: 'Chat',
    isActive: !isModalOverlayActive && !isConfirmingDangerousMode
  });

  // Shift+↑ enters message-actions cursor. Separate isActive so ctrl+r search
  // doesn't leave stale isSearchingHistory on cursor-exit remount.
  useKeybinding('chat:messageActions', () => onMessageActionsEnter?.(), {
    context: 'Chat',
    isActive: !isModalOverlayActive && !isSearchingHistory
  });

  // Fast mode keybinding is only active when fast mode is enabled and available
  useKeybinding('chat:fastMode', handleFastModePicker, {
    context: 'Chat',
    isActive: !isModalOverlayActive && isFastModeEnabled() && isFastModeAvailable()
  });

  // Handle help:dismiss keybinding (ESC closes help menu)
  // This is registered separately from Chat context so it has priority over
  // CancelRequestHandler when help menu is open
  useKeybinding('help:dismiss', () => {
    setHelpOpen(false);
  }, {
    context: 'Help',
    isActive: helpOpen
  });

  // Quick Open / Global Search. Hook calls are unconditional (Rules of Hooks);
  // the handler body is feature()-gated so the setState calls and component
  // references get tree-shaken in external builds.
  const quickSearchActive = feature('QUICK_SEARCH') ? !isModalOverlayActive : false;
  useKeybinding('app:quickOpen', () => {
    if (feature('QUICK_SEARCH')) {
      setShowQuickOpen(true);
      setHelpOpen(false);
    }
  }, {
    context: 'Global',
    isActive: quickSearchActive
  });
  useKeybinding('app:globalSearch', () => {
    if (feature('QUICK_SEARCH')) {
      setShowGlobalSearch(true);
      setHelpOpen(false);
    }
  }, {
    context: 'Global',
    isActive: quickSearchActive
  });
  useKeybinding('history:search', () => {
    if (feature('HISTORY_PICKER')) {
      setShowHistoryPicker(true);
      setHelpOpen(false);
    }
  }, {
    context: 'Global',
    isActive: feature('HISTORY_PICKER') ? !isModalOverlayActive : false
  });

  // Handle Ctrl+C to abort speculation when idle (not loading)
  // CancelRequestHandler only handles Ctrl+C during active tasks
  useKeybinding('app:interrupt', () => {
    abortSpeculation(setAppState);
  }, {
    context: 'Global',
    isActive: !isLoading && speculation.status === 'active'
  });

  // Footer indicator navigation keybindings. ↑/↓ live here (not in
  // handleHistoryUp/Down) because TextInput focus=false when a pill is
  // selected — its useInput is inactive, so this is the only path.
  useKeybindings({
    'footer:up': () => {
      navigateFooter(-1, true);
    },
    'footer:down': () => {
      if (tasksSelected && !isTeammateMode) {
        setShowBashesDialog(true);
        selectFooterItem(null);
        return;
      }
      navigateFooter(1);
    },
    'footer:next': () => {
      // Teammate mode: ←/→ cycles within the team member list
      if (tasksSelected && isTeammateMode) {
        const totalAgents = 1 + inProcessTeammates.length;
        setTeammateFooterIndex(prev => (prev + 1) % totalAgents);
        return;
      }
      navigateFooter(1);
    },
    'footer:previous': () => {
      if (tasksSelected && isTeammateMode) {
        const totalAgents = 1 + inProcessTeammates.length;
        setTeammateFooterIndex(prev => (prev - 1 + totalAgents) % totalAgents);
        return;
      }
      navigateFooter(-1);
    },
    'footer:openSelected': () => {
      if (viewSelectionMode === 'selecting-agent') {
        return;
      }
      switch (footerItemSelected) {
        case 'companion':
          if (isBuddyEnabled()) {
            selectFooterItem(null);
            void onSubmit('/buddy');
          }
          break;
        case 'tasks':
          if (isTeammateMode) {
            // Enter switches to the selected agent's view
            if (teammateFooterIndex === 0) {
              exitTeammateView(setAppState);
            } else {
              const teammate = inProcessTeammates[teammateFooterIndex - 1];
              if (teammate) enterTeammateView(teammate.id, setAppState);
            }
          } else if (coordinatorTaskIndex === 0 && coordinatorTaskCount > 0) {
            exitTeammateView(setAppState);
          } else {
            const selectedTaskId = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]?.id;
            if (selectedTaskId) {
              enterTeammateView(selectedTaskId, setAppState);
            } else {
              setShowBashesDialog(true);
              selectFooterItem(null);
            }
          }
          break;
        case 'bagel':
          break;
        case 'teams':
          setShowTeamsDialog(true);
          selectFooterItem(null);
          break;
        case 'bridge':
          setShowBridgeDialog(true);
          selectFooterItem(null);
          break;
      }
    },
    'footer:clearSelection': () => {
      selectFooterItem(null);
    },
    'footer:close': () => {
      if (tasksSelected && coordinatorTaskIndex >= 1) {
        const task = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1];
        if (!task) return false;
        // When the selected row IS the viewed agent, 'x' types into the
        // steering input. Any other row — dismiss it.
        if (viewSelectionMode === 'viewing-agent' && task.id === viewingAgentTaskId) {
          onChange(input.slice(0, cursorOffset) + 'x' + input.slice(cursorOffset));
          setCursorOffset(cursorOffset + 1);
          return;
        }
        stopOrDismissAgent(task.id, setAppState);
        if (task.status !== 'running') {
          setCoordinatorTaskIndex(i => Math.max(minCoordinatorIndex, i - 1));
        }
        return;
      }
      // Not handled — let 'x' fall through to type-to-exit
      return false;
    }
  }, {
    context: 'Footer',
    isActive: !!footerItemSelected && !isModalOverlayActive && !isConfirmingDangerousMode
  });
  useInput((char, key) => {
    // Skip all input handling when a full-screen dialog is open. These dialogs
    // render via early return, but hooks run unconditionally — so without this
    // guard, Escape inside a dialog leaks to the double-press message-selector.
    if (showTeamsDialog || showQuickOpen || showGlobalSearch || showHistoryPicker || isConfirmingDangerousMode) {
      return;
    }

    // Detect failed Alt shortcuts on macOS (Option key produces special characters)
    if (getPlatform() === 'macos' && isMacosOptionChar(char)) {
      const shortcut = MACOS_OPTION_SPECIAL_CHARS[char];
      const terminalName = getNativeCSIuTerminalDisplayName();
      const jsx = terminalName ? <Text dimColor>
          To enable {shortcut}, set <Text bold>Option as Meta</Text> in{' '}
          {terminalName} preferences (⌘,)
        </Text> : <Text dimColor>To enable {shortcut}, run /terminal-setup</Text>;
      addNotification({
        key: 'option-meta-hint',
        jsx,
        priority: 'immediate',
        timeoutMs: 5000
      });
      // Don't return - let the character be typed so user sees the issue
    }

    // Footer navigation is handled via useKeybindings above (Footer context)

    // NOTE: ctrl+_, ctrl+g, ctrl+s are handled via Chat context keybindings above

    // Type-to-exit footer: printable chars while a pill is selected refocus
    // the input and type the char. Nav keys are captured by useKeybindings
    // above, so anything reaching here is genuinely not a footer action.
    // onChange clears footerSelection, so no explicit deselect.
    if (footerItemSelected && char && !key.ctrl && !key.meta && !key.escape && !key.return) {
      onChange(input.slice(0, cursorOffset) + char + input.slice(cursorOffset));
      setCursorOffset(cursorOffset + char.length);
      return;
    }

    // Exit special modes when backspace/escape/delete/ctrl+u is pressed at cursor position 0
    if (cursorOffset === 0 && (key.escape || key.backspace || key.delete || key.ctrl && char === 'u')) {
      onModeChange('prompt');
      setHelpOpen(false);
    }

    // Exit help mode when backspace is pressed and input is empty
    if (helpOpen && input === '' && (key.backspace || key.delete)) {
      setHelpOpen(false);
    }

    // esc is a little overloaded:
    // - when we're loading a response, it's used to cancel the request
    // - otherwise, it's used to show the message selector
    // - when double pressed, it's used to clear the input
    // - when input is empty, pop from command queue

    // Handle ESC key press
    if (key.escape) {
      // Abort active speculation
      if (speculation.status === 'active') {
        abortSpeculation(setAppState);
        return;
      }

      // Dismiss side question response if visible
      if (isSideQuestionVisible && onDismissSideQuestion) {
        onDismissSideQuestion();
        return;
      }

      // Close help menu if open
      if (helpOpen) {
        setHelpOpen(false);
        return;
      }

      // Footer selection clearing is now handled via Footer context keybindings
      // (footer:clearSelection action bound to escape)
      // If a footer item is selected, let the Footer keybinding handle it
      if (footerItemSelected) {
        return;
      }

      // If there's an editable queued command, move it to the input for editing when ESC is pressed
      const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
      if (hasEditableCommand) {
        void popAllCommandsFromQueue();
        return;
      }
      if (messages.length > 0 && !input && !isLoading) {
        doublePressEscFromEmpty();
      }
    }
    if (key.return && helpOpen) {
      setHelpOpen(false);
    }
  });
  const swarmBanner = useSwarmBanner();
  const fastModeCooldown = isFastModeEnabled() ? isFastModeCooldown() : false;
  const showFastIcon = isFastModeEnabled() ? isFastMode && (isFastModeAvailable() || fastModeCooldown) : false;
  const showFastIconHint = useShowFastIconHint(showFastIcon ?? false);

  useBuddyNotification();
  const companionSpeaking = isBuddyEnabled() ?
  useAppState(s => s.companionReaction !== undefined) : false;
  const {
    columns,
    rows
  } = useTerminalSize();
  const textInputColumns = columns - 3 - companionReservedColumns(columns, companionSpeaking);

  // POC: click-to-position-cursor. Mouse tracking is only enabled inside
  // <AlternateScreen>, so this is dormant in the normal main-screen REPL.
  // localCol/localRow are relative to the onClick Box's top-left; the Box
  // tightly wraps the text input so they map directly to (column, line)
  // in the Cursor wrap model. MeasuredText.getOffsetFromPosition handles
  // wide chars, wrapped lines, and clamps past-end clicks to line end.
  const maxVisibleLines = isFullscreenEnvEnabled() ? Math.max(MIN_INPUT_VIEWPORT_LINES, Math.floor(rows / 2) - PROMPT_FOOTER_LINES) : undefined;
  const handleInputClick = useCallback((e: ClickEvent) => {
    // During history search the displayed text is historyMatch, not
    // input, and showCursor is false anyway — skip rather than
    // compute an offset against the wrong string.
    if (!input || isSearchingHistory) return;
    const c = Cursor.fromText(input, textInputColumns, cursorOffset);
    const viewportStart = c.getViewportStartLine(maxVisibleLines);
    const offset = c.measuredText.getOffsetFromPosition({
      line: e.localRow + viewportStart,
      column: e.localCol
    });
    setCursorOffset(offset);
  }, [input, textInputColumns, isSearchingHistory, cursorOffset, maxVisibleLines]);
  const handleOpenTasksDialog = useCallback((taskId?: string) => setShowBashesDialog(taskId ?? true), [setShowBashesDialog]);
  const placeholder = showPromptSuggestion && promptSuggestion ? promptSuggestion : defaultPlaceholder;

  // Calculate if input has multiple lines
  const isInputWrapped = useMemo(() => input.includes('\n'), [input]);

  // Memoized callbacks for model picker to prevent re-renders when unrelated
  // state (like notifications) changes. This prevents the inline model picker
  // from visually "jumping" when notifications arrive.
  const handleModelSelect = useCallback((model: string | null, _effort: EffortLevel | undefined) => {
    let wasFastModeDisabled = false;
    setAppState(prev => {
      wasFastModeDisabled = isFastModeEnabled() && !isFastModeSupportedByModel(model) && !!prev.fastMode;
      return {
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: null,
        // Turn off fast mode if switching to a model that doesn't support it
        ...(wasFastModeDisabled && {
          fastMode: false
        })
      };
    });
    setShowModelPicker(false);
    const effectiveFastMode = (isFastMode ?? false) && !wasFastModeDisabled;
    let message = `Model set to ${modelDisplayString(model)}`;
    if (isBilledAsExtraUsage(model, effectiveFastMode, isOpus1mMergeEnabled())) {
      message += ' · Billed as extra usage';
    }
    if (wasFastModeDisabled) {
      message += ' · Fast mode OFF';
    }
    addNotification({
      key: 'model-switched',
      jsx: <Text>{message}</Text>,
      priority: 'immediate',
      timeoutMs: 3000
    });
    logEvent('tengu_model_picker_hotkey', {
      model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
  }, [setAppState, addNotification, isFastMode]);
  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  // Memoize the model picker element to prevent unnecessary re-renders
  // when AppState changes for unrelated reasons (e.g., notifications arriving)
  const modelPickerElement = useMemo(() => {
    if (!showModelPicker) return null;
    return <Box flexDirection="column" marginTop={1}>
        <ModelPicker initial={mainLoopModel_} sessionModel={mainLoopModelForSession} onSelect={handleModelSelect} onCancel={handleModelCancel} isStandaloneCommand showFastModeNotice={isFastModeEnabled() && isFastMode && isFastModeSupportedByModel(mainLoopModel_) && isFastModeAvailable()} />
      </Box>;
  }, [showModelPicker, mainLoopModel_, mainLoopModelForSession, handleModelSelect, handleModelCancel]);
  const handleFastModeSelect = useCallback((result?: string) => {
    setShowFastModePicker(false);
    if (result) {
      addNotification({
        key: 'fast-mode-toggled',
        jsx: <Text>{result}</Text>,
        priority: 'immediate',
        timeoutMs: 3000
      });
    }
  }, [addNotification]);

  // Memoize the fast mode picker element
  const fastModePickerElement = useMemo(() => {
    if (!showFastModePicker) return null;
    return <Box flexDirection="column" marginTop={1}>
        <FastModePicker onDone={handleFastModeSelect} unavailableReason={getFastModeUnavailableReason()} />
      </Box>;
  }, [showFastModePicker, handleFastModeSelect]);

  // Memoized callbacks for thinking toggle
  const handleThinkingSelect = useCallback((enabled: boolean) => {
    setAppState(prev => ({
      ...prev,
      thinkingEnabled: enabled
    }));
    setShowThinkingToggle(false);
    logEvent('tengu_thinking_toggled_hotkey', {
      enabled
    });
    addNotification({
      key: 'thinking-toggled-hotkey',
      jsx: <Text color={enabled ? 'suggestion' : undefined} dimColor={!enabled}>
            Thinking {enabled ? 'on' : 'off'}
          </Text>,
      priority: 'immediate',
      timeoutMs: 3000
    });
  }, [setAppState, addNotification]);
  const handleThinkingCancel = useCallback(() => {
    setShowThinkingToggle(false);
  }, []);

  // Memoize the thinking toggle element
  const thinkingToggleElement = useMemo(() => {
    if (!showThinkingToggle) return null;
    return <Box flexDirection="column" marginTop={1}>
        <ThinkingToggle currentValue={thinkingEnabled ?? true} onSelect={handleThinkingSelect} onCancel={handleThinkingCancel} isMidConversation={messages.some(m => m.type === 'assistant')} />
      </Box>;
  }, [showThinkingToggle, thinkingEnabled, handleThinkingSelect, handleThinkingCancel, messages.length]);

  // Portal dialog to DialogOverlay in fullscreen so it escapes the bottom
  // slot's overflowY:hidden clip (same pattern as SuggestionsOverlay).
  // Must be called before early returns below to satisfy rules-of-hooks.
  // Memoized so the portal useEffect doesn't churn on every PromptInput render.
  const autoModeOptInDialog = useMemo(() => feature('TRANSCRIPT_CLASSIFIER') && showAutoModeOptIn ? <AutoModeOptInDialog onAccept={handleAutoModeOptInAccept} onDecline={handleAutoModeOptInDecline} /> : null, [showAutoModeOptIn, handleAutoModeOptInAccept, handleAutoModeOptInDecline]);
  useSetPromptOverlayDialog(isFullscreenEnvEnabled() ? autoModeOptInDialog : null);
  if (showBashesDialog) {
    return <BackgroundTasksDialog onDone={() => setShowBashesDialog(false)} toolUseContext={getToolUseContext(messages, [], new AbortController(), mainLoopModel)} initialDetailTaskId={typeof showBashesDialog === 'string' ? showBashesDialog : undefined} />;
  }
  if (isAgentSwarmsEnabled() && showTeamsDialog) {
    return <TeamsDialog initialTeams={cachedTeams} onDone={() => {
      setShowTeamsDialog(false);
    }} />;
  }
  if (feature('QUICK_SEARCH')) {
    const insertWithSpacing = (text: string) => {
      const cursorChar = input[cursorOffset - 1] ?? ' ';
      insertTextAtCursor(/\s/.test(cursorChar) ? text : ` ${text}`);
    };
    if (showQuickOpen) {
      return <QuickOpenDialog onDone={() => setShowQuickOpen(false)} onInsert={insertWithSpacing} />;
    }
    if (showGlobalSearch) {
      return <GlobalSearchDialog onDone={() => setShowGlobalSearch(false)} onInsert={insertWithSpacing} />;
    }
  }
  if (feature('HISTORY_PICKER') && showHistoryPicker) {
    return <HistorySearchDialog initialQuery={input} onSelect={entry => {
      const entryMode = getModeFromInput(entry.display);
      const value = getValueFromInput(entry.display);
      onModeChange(entryMode);
      trackAndSetInput(value);
      setPastedContents(entry.pastedContents);
      setCursorOffset(value.length);
      setShowHistoryPicker(false);
    }} onCancel={() => setShowHistoryPicker(false)} />;
  }

  // Show loop mode menu when requested (internal-only, eliminated from external builds)
  if (modelPickerElement) {
    return modelPickerElement;
  }
  if (fastModePickerElement) {
    return fastModePickerElement;
  }
  if (thinkingToggleElement) {
    return thinkingToggleElement;
  }
  if (showBridgeDialog) {
    return <BridgeDialog onDone={() => {
      setShowBridgeDialog(false);
      selectFooterItem(null);
    }} />;
  }
  if (dangerousModeDialog) {
    return dangerousModeDialog;
  }
  const baseProps: BaseTextInputProps = {
    multiline: true,
    onSubmit,
    onChange,
    value: isSearchingHistory && historyMatch ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display) : input,
    // History navigation is handled via TextInput props (onHistoryUp/onHistoryDown),
    // NOT via useKeybindings. This allows useTextInput's upOrHistoryUp/downOrHistoryDown
    // to try cursor movement first and only fall through to history navigation when the
    // cursor can't move further (important for wrapped text and multi-line input).
    onHistoryUp: handleHistoryUp,
    onHistoryDown: handleHistoryDown,
    onHistoryReset: resetHistory,
    placeholder,
    onExit,
    onExitMessage: (show, key) => setExitMessage({
      show,
      key
    }),
    onImagePaste,
    columns: textInputColumns,
    maxVisibleLines,
    disableCursorMovementForUpDownKeys: suggestions.length > 0 || !!footerItemSelected,
    disableEscapeDoublePress: suggestions.length > 0,
    cursorOffset,
    onChangeCursorOffset: setCursorOffset,
    onPaste: onTextPaste,
    onIsPastingChange: setIsPasting,
    focus: !isSearchingHistory && !isModalOverlayActive && !footerItemSelected,
    showCursor: !footerItemSelected && !isSearchingHistory && !cursorAtImageChip,
    argumentHint: commandArgumentHint,
    onUndo: canUndo ? () => {
      const previousState = undo();
      if (previousState) {
        trackAndSetInput(previousState.text);
        setCursorOffset(previousState.cursorOffset);
        setPastedContents(previousState.pastedContents);
      }
    } : undefined,
    highlights: combinedHighlights,
    inlineGhostText,
    inputFilter: lazySpaceInputFilter
  };
  /** Resolves the current mode and team/standalone identity for the input border. */
  const getBorderColor = (): keyof Theme => resolvePromptBorderColor({
    mode,
    inProcessTeammate: isInProcessTeammate(),
    teammateColor: getTeammateColor(),
    teamContext,
    teamName: getTeamName(teamContext),
    standaloneColor: standaloneAgentContext?.color,
    ultracodeActive,
  });
  if (isExternalEditorActive) {
    return <Box flexDirection="row" alignItems="center" justifyContent="center" borderColor={getBorderColor()} borderStyle="round" borderLeft={false} borderRight={false} borderBottom width="100%">
        <Text dimColor italic>
          Save and close editor to continue...
        </Text>
      </Box>;
  }
  const textInputElement = isVimModeEnabled() ? <VimTextInput {...baseProps} initialMode={vimMode} onModeChange={setVimMode} /> : <TextInput {...baseProps} />;
  return <Box flexDirection="column" marginTop={briefOwnsGap ? 0 : 1}>
      {!isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
      <PromptInputStashNotice hasStash={stashedPrompt !== undefined} />
      {swarmBanner ? <>
          <Text color={swarmBanner.bgColor}>
            {swarmBanner.text ? <>
                {'─'.repeat(Math.min(columns - 1, Math.max(0, columns - stringWidth(swarmBanner.text) - 4)))}
                <Text backgroundColor={swarmBanner.bgColor} color="inverseText">
                  {' '}
                  {swarmBanner.text}{' '}
                </Text>
                {'──'}
              </> : '─'.repeat(Math.max(0, columns - 1))}
          </Text>
          <Box flexDirection="row" width="100%">
            <PromptInputModeIndicator mode={mode} isLoading={isLoading} viewingAgentName={viewingAgentName} viewingAgentColor={viewingAgentColor} />
            <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
              {textInputElement}
            </Box>
          </Box>
          <Text color={swarmBanner.bgColor}>{'─'.repeat(Math.max(0, columns - 1))}</Text>
        </> : <Box flexDirection="row" alignItems="flex-start" justifyContent="flex-start" borderColor={getBorderColor()} borderStyle="round" borderLeft={false} borderRight={false} borderBottom width="100%" borderText={buildBorderText(showFastIcon ?? false, showFastIconHint, fastModeCooldown)}>
          <PromptInputModeIndicator mode={mode} isLoading={isLoading} viewingAgentName={viewingAgentName} viewingAgentColor={viewingAgentColor} />
          <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
            {textInputElement}
          </Box>
        </Box>}
      <PromptInputFooter apiKeyStatus={apiKeyStatus} debug={debug} exitMessage={exitMessage} vimMode={isVimModeEnabled() ? vimMode : undefined} mode={mode} autoUpdaterResult={autoUpdaterResult} isAutoUpdating={isAutoUpdating} verbose={verbose} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={setIsAutoUpdating} suggestions={suggestions} selectedSuggestion={selectedSuggestion} maxColumnWidth={maxColumnWidth} toolPermissionContext={effectiveToolPermissionContext} helpOpen={helpOpen} suppressHint={input.length > 0} isLoading={isLoading} tasksSelected={tasksSelected} teamsSelected={teamsSelected} bridgeSelected={bridgeSelected} tmuxSelected={tmuxSelected} teammateFooterIndex={teammateFooterIndex} ideSelection={ideSelection} mcpClients={mcpClients} isPasting={isPasting} isInputWrapped={isInputWrapped} messages={messages} isSearching={isSearchingHistory} historyQuery={historyQuery} setHistoryQuery={setHistoryQuery} historyFailedMatch={historyFailedMatch} onOpenTasksDialog={isFullscreenEnvEnabled() ? handleOpenTasksDialog : undefined} />
      {isFullscreenEnvEnabled() ? null : autoModeOptInDialog}
      {isFullscreenEnvEnabled() ?
    // position=absolute takes zero layout height so the spinner
    // doesn't shift when a notification appears/disappears. Yoga
    // anchors absolute children at the parent's content-box origin;
    // marginTop=-1 pulls it into the marginTop=1 gap row above the
    // prompt border. In brief mode there is no such gap (briefOwnsGap
    // strips our marginTop) and BriefSpinner sits flush against the
    // border — marginTop=-2 skips over the spinner content into
    // BriefSpinner's own marginTop=1 blank row. height=1 +
    // overflow=hidden clips multi-line notifications to a single row.
    // flex-end anchors the bottom line so the visible row is always
    // the most recent. Suppressed while the slash overlay or
    // auto-mode opt-in dialog is up by height=0 (NOT unmount) — this
    // Box renders later in tree order so it would paint over their
    // bottom row. Keeping Notifications mounted prevents AutoUpdater's
    // initial-check effect from re-firing on every slash-completion
    // toggle (PR#22413).
    <Box position="absolute" marginTop={briefOwnsGap ? -2 : -1} height={suggestions.length === 0 && !showAutoModeOptIn && !isConfirmingDangerousMode ? 1 : 0} width="100%" paddingLeft={2} paddingRight={1} flexDirection="column" justifyContent="flex-end" overflow="hidden">
          <Notifications apiKeyStatus={apiKeyStatus} autoUpdaterResult={autoUpdaterResult} debug={debug} isAutoUpdating={isAutoUpdating} verbose={verbose} messages={messages} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={setIsAutoUpdating} ideSelection={ideSelection} mcpClients={mcpClients} isInputWrapped={isInputWrapped} />
        </Box> : null}
    </Box>;
}

/**
 * Compute the initial paste ID by finding the max ID used in existing messages.
 * This handles --continue/--resume scenarios where we need to avoid ID collisions.
 */
function getInitialPasteId(messages: Message[]): number {
  let maxId = 0;
  for (const message of messages) {
    if (message.type === 'user') {
      // Check image paste IDs
      if (message.imagePasteIds) {
        for (const id of message.imagePasteIds) {
          if (id > maxId) maxId = id;
        }
      }
      // Check text paste references in message content
      if (Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            const refs = parseReferences(block.text);
            for (const ref of refs) {
              if (ref.id > maxId) maxId = ref.id;
            }
          }
        }
      }
    }
  }
  return maxId + 1;
}
function buildBorderText(showFastIcon: boolean, showFastIconHint: boolean, fastModeCooldown: boolean): BorderTextOptions | undefined {
  if (!showFastIcon) return undefined;
  const fastSeg = showFastIconHint ? `${getFastIconString(true, fastModeCooldown)} ${chalk.dim('/fast')}` : getFastIconString(true, fastModeCooldown);
  return {
    content: ` ${fastSeg} `,
    position: 'top',
    align: 'end',
    offset: 0
  };
}
export default React.memo(PromptInput);
