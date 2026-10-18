import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { feature } from 'bun:bundle';
import { spawnSync } from 'child_process';
import { snapshotOutputTokensForTurn, getCurrentTurnTokenBudget, getTurnOutputTokens, getBudgetContinuationCount, getTotalInputTokens } from '../bootstrap/state.js';
import { parseTokenBudget } from '../utils/tokenBudget.js';
import { count } from '../utils/array.js';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import figures from 'figures';
import chalk from 'chalk';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- / n N Esc [ v are bare letters in transcript modal context, same class as g/G/j/k in ScrollKeybindingHandler
import { useInput } from '../ink.js';
import { useSearchInput } from '../hooks/useSearchInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useSearchHighlight } from '../ink/hooks/use-search-highlight.js';
import type { JumpHandle } from '../components/VirtualMessageList.js';
import { renderMessagesToPlainText } from '../utils/exportRenderer.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { writeFile } from 'fs/promises';
import { Box, Text, useStdin, useTheme, useTerminalFocus, useTerminalTitle, useTabStatus } from '../ink.js';
import type { TabStatusKind } from '../ink/hooks/use-tab-status.js';
import { CostThresholdDialog } from '../components/CostThresholdDialog.js';
import { IdleReturnDialog } from '../components/IdleReturnDialog.js';
import { ResumeCompactPrompt } from '../components/ResumeCompactPrompt.js';
import { CompactProgressBar } from '../components/CompactProgressBar.js';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState, useCallback, useDeferredValue, useLayoutEffect, type RefObject } from 'react';
import { useNotifications } from '../context/notifications.js';
import { sendNotification } from '../services/notifier.js';
import { startPreventSleep, stopPreventSleep } from '../services/preventSleep.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import { hasCursorUpViewportYankBug } from '../ink/terminal.js';
import { createFileStateCacheWithSizeLimit, mergeFileStateCaches, READ_FILE_STATE_CACHE_SIZE, type FileStateCache } from '../utils/fileStateCache.js';
import { registerPrunableCache } from '../utils/memoryPressure.js';
import { updateLastInteractionTime, getLastInteractionTime, getOriginalCwd, getProjectRoot, getSessionId, switchSession, setCostStateForRestore, resetTurnHookDuration, resetTurnToolDuration, resetTurnClassifierDuration, setMainLoopModelOverride, setMainThreadAgentType } from '../bootstrap/state.js';
import { asSessionId, asAgentId } from '../types/ids.js';
import { logForDebugging } from '../utils/debug.js';
import { QueryGuard } from '../utils/QueryGuard.js';
import { getQueryGuardOptionsFromEnv, tryStartQueryWithConfiguredIdleTimeout } from '../utils/queryGuardConfig.js';
import { QueryLifecycleOperationTracker, formatQueryLifecycleAbortSignalReason, formatQueryLifecycleLogMessage, getQueryTerminalOutcome, getQueryTerminalReason, type QueryActiveOperationSnapshot, type QueryGuardTimeoutInfo, type QueryLifecycleContext, type QueryTerminalReason } from '../utils/queryLifecycle.js';
import { claimBackgroundTurnBudget, canRestoreDeferredMaxTurnsCap, computeDeferredMaxTurnsCapForBackgroundHandoff, createForegroundTurnBudgetHandoff, getReplMaxTurnsWarning, releaseForegroundTurnBudget, resolveReplMaxTurnsForSession, shouldShowReplMaxTurnsUnlimitedWarning, shouldContinueBackgroundAfterForegroundQuery, waitForForegroundTurnBudgetSettlement, type ForegroundTurnBudgetHandoff } from './replMaxTurns.js';
import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { formatTokens, truncateToWidth } from '../utils/format.js';
import { consumeEarlyInput } from '../utils/earlyInput.js';
import { setMemberActive } from '../utils/swarm/teamHelpers.js';
import { isSwarmWorker, generateSandboxRequestId, sendSandboxPermissionRequestViaMailbox, sendSandboxPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js';
import { registerSandboxPermissionCallback } from '../hooks/useSwarmPermissionPoller.js';
import { getTeamName, getAgentName } from '../utils/teammate.js';
import { WorkerPendingPermission } from '../components/permissions/WorkerPendingPermission.js';
import { injectUserMessageToTeammate, getAllInProcessTeammateTasks } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { isLocalAgentTask, queuePendingMessage, appendMessageToLocalAgent, type LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import { registerLeaderToolUseConfirmQueue, unregisterLeaderToolUseConfirmQueue, registerLeaderSetToolPermissionContext, unregisterLeaderSetToolPermissionContext } from '../utils/swarm/leaderPermissionBridge.js';
import { useLogMessages } from '../hooks/useLogMessages.js';
import { useReplBridge } from '../hooks/useReplBridge.js';
import { type Command, type CommandResultDisplay, type ResumeEntrypoint, getCommandName, isCommandEnabled } from '../commands.js';
import type { PromptInputMode, QueuedCommand, VimMode } from '../types/textInputTypes.js';
import { MessageSelector } from '../components/MessageSelector.js';
import { selectableUserMessagesFilter, messagesAfterAreOnlySynthetic } from '../utils/messageFilters.js';
import { useIdeLogging } from '../hooks/useIdeLogging.js';
import { PermissionRequest, type ToolUseConfirm } from '../components/permissions/PermissionRequest.js';
import { ElicitationDialog } from '../components/mcp/ElicitationDialog.js';
import { PromptDialog } from '../components/hooks/PromptDialog.js';
import type { PromptRequest, PromptResponse } from '../types/hooks.js';
import PromptInput from '../components/PromptInput/PromptInput.js';
import { PromptInputQueuedCommands } from '../components/PromptInput/PromptInputQueuedCommands.js';
import { useRemoteSession } from '../hooks/useRemoteSession.js';
import { useDirectConnect } from '../hooks/useDirectConnect.js';
import type { DirectConnectConfig } from '../server/directConnectManager.js';
import { useSSHSession } from '../hooks/useSSHSession.js';
import { useAssistantHistory } from '../hooks/useAssistantHistory.js';
import type { SSHSession } from '../ssh/createSSHSession.js';
import { SpinnerWithVerb, BriefIdleStatus, type SpinnerMode } from '../components/Spinner.js';
import { CompletionFlash } from '../components/Spinner/CompletionFlash.js';
import { getSystemPrompt } from '../constants/prompts.js';
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js';
import { getSystemContext, getUserContext } from '../context.js';
import { getMemoryFiles } from '../utils/claudemd.js';
import { startBackgroundHousekeeping } from '../utils/backgroundHousekeeping.js';
import { getTotalCost, saveCurrentSessionCosts, resetCostState, getStoredSessionCosts } from '../cost-tracker.js';
import { useCostSummary } from '../costHook.js';
import { useFpsMetrics } from '../context/fpsMetrics.js';
import { useAfterFirstRender } from '../hooks/useAfterFirstRender.js';
import { useDeferredHookMessages } from '../hooks/useDeferredHookMessages.js';
import { addToHistory, removeLastFromHistory, expandPastedTextRefs, parseReferences } from '../history.js';
import { prependModeCharacterToInput } from '../components/PromptInput/inputModes.js';
import { prependToShellHistoryCache } from '../utils/suggestions/shellHistoryCompletion.js';
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js';
import { GlobalKeybindingHandlers } from '../hooks/useGlobalKeybindings.js';
import { CommandKeybindingHandlers } from '../hooks/useCommandKeybindings.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js';
import {
  abortPendingToolPermissionRequests,
  CancelRequestHandler,
  type CancelRequestSource,
} from '../hooks/useCancelRequest.js';
import { useBackgroundTaskNavigation } from '../hooks/useBackgroundTaskNavigation.js';
import { useSwarmInitialization } from '../hooks/useSwarmInitialization.js';
import { useTeammateViewAutoExit } from '../hooks/useTeammateViewAutoExit.js';
import { errorMessage } from '../utils/errors.js';
import { isHumanTurn } from '../utils/messagePredicates.js';
import { logError } from '../utils/log.js';
// Dead code elimination: conditional imports
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const useVoiceIntegration: typeof import('../hooks/useVoiceIntegration.js').useVoiceIntegration = feature('VOICE_MODE') ? require('../hooks/useVoiceIntegration.js').useVoiceIntegration : () => ({
  stripTrailing: () => 0,
  handleKeyEvent: () => { },
  resetAnchor: () => { }
});
const VoiceKeybindingHandler: typeof import('../hooks/useVoiceIntegration.js').VoiceKeybindingHandler = feature('VOICE_MODE') ? require('../hooks/useVoiceIntegration.js').VoiceKeybindingHandler : () => null;
// Dead code elimination: conditional import for coordinator mode
const getCoordinatorUserContext: (mcpClients: ReadonlyArray<{
  name: string;
}>, scratchpadDir?: string) => {
  [k: string]: string;
} = feature('COORDINATOR_MODE') ? require('../coordinator/coordinatorMode.js').getCoordinatorUserContext : () => ({});
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import useCanUseTool from '../hooks/useCanUseTool.js';
import type { ToolPermissionContext, Tool } from '../Tool.js';
import { applyPermissionUpdate, persistPermissionUpdate } from '../utils/permissions/PermissionUpdate.js';
import { buildPermissionUpdates } from '../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js';
import { applyPermissionUpdatesToLiveContext, stripDangerousPermissionsForAutoMode } from '../utils/permissions/permissionSetup.js';
import { getScratchpadDir, isScratchpadEnabled } from '../utils/permissions/filesystem.js';
import { isDangerousPermissionMode } from '../utils/permissions/PermissionMode.js';
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js';
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js';
import { clearSpeculativeChecks } from '../tools/BashTool/bashPermissions.js';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { getGlobalConfig, saveGlobalConfig, saveGlobalConfigDeferred } from '../utils/config.js';
import { hasConsoleBillingAccess } from '../utils/billing.js';
import { logEvent, type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { textForResubmit, handleMessageFromStream, type StreamingToolUse, type StreamingThinking, isCompactBoundaryMessage, getMessagesAfterCompactBoundary, getContentText, createUserMessage, createAssistantMessage, createTurnDurationMessage, createAgentsKilledMessage, createSystemMessage, createCommandInputMessage, formatCommandInputTags } from '../utils/messages.js';
import { getCurrentTurnCacheMetrics, resetCurrentTurn } from '../services/api/cacheStatsTracker.js';
import { formatCacheMetricsCompact, formatCacheMetricsFull } from '../services/api/cacheMetrics.js';
import { generateSessionTitle, titleOrNullForPromptFallback } from '../utils/sessionTitle.js';
import { BASH_INPUT_TAG, COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../constants/xml.js';
import { escapeXml } from '../utils/xml.js';
import type { ThinkingConfig } from '../utils/thinking.js';
import { gracefulShutdownSync, isShuttingDown } from '../utils/gracefulShutdown.js';
import { buildConcurrentRequeuedPrompt, handlePromptSubmit, isNormalLocalUserPrompt, type PromptInputHelpers } from '../utils/handlePromptSubmit.js';
import { applyInterruptionCorrectionAutoRestore, applyInterruptionCorrectionAwareMessageUpdate, buildInterruptionCorrectionMessageViews, InterruptionCorrectionTracker } from '../utils/interruptionCorrection.js';
import { useQueueProcessor } from '../hooks/useQueueProcessor.js';
import { useMailboxBridge } from '../hooks/useMailboxBridge.js';
import { queryCheckpoint, logQueryProfileReport, clearQueryProfile } from '../utils/queryProfiler.js';
import type { Message as MessageType, UserMessage, ProgressMessage, HookResultMessage, PartialCompactDirection } from '../types/message.js';
import { query, type QueryTurnBudget } from '../query.js';
import type { Terminal as QueryTerminal } from '../query/transitions.js';
import type { AutoCompactTrackingState } from '../services/compact/autoCompact.js';
import { mergeClients, useMergedClients } from '../hooks/useMergedClients.js';
import { getQuerySourceForREPL } from '../utils/promptCategory.js';
import { useMergedTools } from '../hooks/useMergedTools.js';
import { mergeAndFilterTools } from '../utils/toolPool.js';
import { useMergedCommands } from '../hooks/useMergedCommands.js';
import { useSkillsChange } from '../hooks/useSkillsChange.js';
import { useManagePlugins } from '../hooks/useManagePlugins.js';
import { Messages } from '../components/Messages.js';
import { TaskListV2 } from '../components/TaskListV2.js';
import { TeammateViewHeader } from '../components/TeammateViewHeader.js';
import { useTasksV2WithCollapseEffect } from '../hooks/useTasksV2.js';
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js';
import type { MCPServerConnection } from '../services/mcp/types.js';
import type { ScopedMcpServerConfig } from '../services/mcp/types.js';
import { randomUUID, type UUID } from 'crypto';
import { processSessionStartHooks } from '../utils/sessionStart.js';
import { executeSessionEndHooks, getSessionEndHookTimeoutMs } from '../utils/hooks.js';
import { type IDESelection, useIdeSelection } from '../hooks/useIdeSelection.js';
import { getTools, assembleToolPool } from '../tools.js';
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js';
import { resolveAgentTools } from '../tools/AgentTool/agentToolUtils.js';
import { resumeAgentBackground } from '../tools/AgentTool/resumeAgent.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useAppState, useSetAppState, useAppStateStore, type AppState } from '../state/AppState.js';
import type { ContentBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { ProcessUserInputContext } from '../utils/processUserInput/processUserInput.js';
import type { PastedContent } from '../utils/config.js';
import { copyPlanForFork, copyPlanForResume, getPlanSlug, setPlanSlug } from '../utils/plans.js';
import { clearSessionMetadata, resetSessionFilePointer, adoptResumedSessionFile, removeTranscriptMessage, restoreSessionMetadata, getCurrentSessionTitle, isEphemeralToolProgress, isLoggableMessage, saveWorktreeState, getAgentTranscript, saveAgentSetting } from '../utils/sessionStorage.js';
import { deserializeMessages } from '../utils/conversationRecovery.js';
import { extractReadFilesFromMessages, extractBashToolsFromMessages } from '../utils/queryHelpers.js';
import { resetMicrocompactState } from '../services/compact/microCompact.js';
import { runPostCompactCleanup } from '../services/compact/postCompactCleanup.js';
import { applyToolResultReplacementsToMessages, provisionContentReplacementState, reconstructContentReplacementState, type ContentReplacementRecord } from '../utils/toolResultStorage.js';
import { partialCompactConversation } from '../services/compact/compact.js';
import type { LogOption } from '../types/logs.js';
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js';
import { fileHistoryMakeSnapshot, type FileHistoryState, fileHistoryRewind, type FileHistorySnapshot, copyFileHistoryForResume, fileHistoryEnabled, fileHistoryHasAnyChanges } from '../utils/fileHistory.js';
import { type AttributionState, incrementPromptCount } from '../utils/commitAttribution.js';
import { recordAttributionSnapshot } from '../utils/sessionStorage.js';
import { computeStandaloneAgentContext, restoreAgentFromSession, restoreSessionStateFromLog, restoreWorktreeForResume, exitRestoredWorktree } from '../utils/sessionRestore.js';
import { notifySessionMetadataChanged } from '../utils/sessionState.js';
import { isBgSession, updateSessionName, updateSessionActivity } from '../utils/concurrentSessions.js';
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js';
import { restoreRemoteAgentTasks } from '../tasks/RemoteAgentTask/RemoteAgentTask.js';
import { useInboxPoller } from '../hooks/useInboxPoller.js';
import { getActiveSessionAgentModelSelection } from './replActiveAgentModel.js';
import type { ModelSetting } from '../utils/model/model.js';
// Dead code elimination: conditional import for loop mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/index.js') : null;
const PROACTIVE_NO_OP_SUBSCRIBE = (_cb: () => void) => () => { };
const PROACTIVE_FALSE = () => false;
const SUGGEST_BG_PR_NOOP = (_p: string, _n: string): boolean => false;
const useScheduledTasks = require('../hooks/useScheduledTasks.js').useScheduledTasks;
/* eslint-enable @typescript-eslint/no-require-imports */
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js';
import { decideStreamingTextUpdate } from './streamingTextPublish.js';
import type { SandboxAskCallback, NetworkHostPattern } from '../utils/sandbox/sandbox-adapter.js';
import { type IDEExtensionInstallationStatus, closeOpenDiffs, getConnectedIdeClient, type IdeType } from '../utils/ide.js';
import { useIDEIntegration } from '../hooks/useIDEIntegration.js';
import exit from '../commands/exit/index.js';
import { ExitFlow } from '../components/ExitFlow.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import { popAllEditable, enqueue, prepend, type SetAppState, getCommandQueue, getCommandQueueLength, removeByFilter } from '../utils/messageQueueManager.js';
import { useCommandQueue } from '../hooks/useCommandQueue.js';
import { SessionBackgroundHint } from '../components/SessionBackgroundHint.js';
import { startBackgroundSession } from '../tasks/LocalMainSessionTask.js';
import { useSessionBackgrounding } from '../hooks/useSessionBackgrounding.js';
import { diagnosticTracker } from '../services/diagnosticTracking.js';
import { handleSpeculationAccept, type ActiveSpeculationState } from '../services/PromptSuggestion/speculation.js';
import { IdeOnboardingDialog } from '../components/IdeOnboardingDialog.js';
import { EffortCallout, shouldShowEffortCallout } from '../components/EffortCallout.js';
import { getDisplayedEffortLevel, type EffortValue } from '../utils/effort.js';
import { RemoteCallout } from '../components/RemoteCallout.js';
import { getAPIProvider } from '../utils/model/providers.js';
import { activityManager } from '../utils/activityManager.js';
import { createAbortController } from '../utils/abortController.js';
import {
  flushInterruptionTrace,
  getInterruptionSignalAbortEventId,
  registerInterruptionController,
  requestAbort,
  traceInterruptionEvent,
} from '../utils/interruptionTrace.js';
import { driveQueryEvents } from '../utils/queryEventDriver.js';
import {
  requestBackgroundHandoffAbort,
  requestPriorityNowAbort,
} from '../utils/replInterruption.js';
import { MCPConnectionManager } from 'src/services/mcp/MCPConnectionManager.js';
import { useFeedbackSurvey } from 'src/components/FeedbackSurvey/useFeedbackSurvey.js';
import { useMemorySurvey } from 'src/components/FeedbackSurvey/useMemorySurvey.js';
import { usePostCompactSurvey } from 'src/components/FeedbackSurvey/usePostCompactSurvey.js';
import { FeedbackSurvey } from 'src/components/FeedbackSurvey/FeedbackSurvey.js';
import { useInstallMessages } from 'src/hooks/notifs/useInstallMessages.js';
import { useAwaySummary } from 'src/hooks/useAwaySummary.js';
import { useChromeExtensionNotification } from 'src/hooks/useChromeExtensionNotification.js';
import { useOfficialMarketplaceNotification } from 'src/hooks/useOfficialMarketplaceNotification.js';
import { usePromptsFromClaudeInChrome } from 'src/hooks/usePromptsFromClaudeInChrome.js';
import { getTipToShowOnSpinner, recordShownTip } from 'src/services/tips/tipScheduler.js';
import type { Theme } from 'src/utils/theme.js';
import { resolveCriticalInputDialog } from './replFocusedInputDialog.js';
import { isPromptTypingSuppressionActive } from './replInputSuppression.js';
import { shouldRunStartupChecks } from './replStartupGates.js';
import { checkAndDisableBypassPermissionsIfNeeded, checkAndDisableAutoModeIfNeeded, useKickOffCheckAndDisableBypassPermissionsIfNeeded, useKickOffCheckAndDisableAutoModeIfNeeded } from 'src/utils/permissions/bypassPermissionsKillswitch.js';
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js';
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from 'src/cli/structuredIO.js';
import { useFileHistorySnapshotInit } from 'src/hooks/useFileHistorySnapshotInit.js';
import { SandboxPermissionRequest } from 'src/components/permissions/SandboxPermissionRequest.js';
import { SandboxViolationExpandedView } from 'src/components/SandboxViolationExpandedView.js';
import { useSettingsErrors } from 'src/hooks/notifs/useSettingsErrors.js';
import { useMcpConnectivityStatus } from 'src/hooks/notifs/useMcpConnectivityStatus.js';
import { useAutoModeUnavailableNotification } from 'src/hooks/notifs/useAutoModeUnavailableNotification.js';
import { AUTO_MODE_DESCRIPTION } from 'src/components/AutoModeOptInDialog.js';
import { useLspInitializationNotification } from 'src/hooks/notifs/useLspInitializationNotification.js';
import { useLspPluginRecommendation } from 'src/hooks/useLspPluginRecommendation.js';
import { LspRecommendationMenu } from 'src/components/LspRecommendation/LspRecommendationMenu.js';
import { useClaudeCodeHintRecommendation } from 'src/hooks/useClaudeCodeHintRecommendation.js';
import { PluginHintMenu } from 'src/components/ClaudeCodeHint/PluginHintMenu.js';
import { DesktopUpsellStartup, shouldShowDesktopUpsellStartup } from 'src/components/DesktopUpsell/DesktopUpsellStartup.js';
import { usePluginInstallationStatus } from 'src/hooks/notifs/usePluginInstallationStatus.js';
import { usePluginAutoupdateNotification } from 'src/hooks/notifs/usePluginAutoupdateNotification.js';
import { performStartupChecks } from 'src/utils/plugins/performStartupChecks.js';
import { UserTextMessage } from 'src/components/messages/UserTextMessage.js';
import { AwsAuthStatusBox } from '../components/AwsAuthStatusBox.js';
import { useRateLimitWarningNotification } from 'src/hooks/notifs/useRateLimitWarningNotification.js';
import { useDeprecationWarningNotification } from 'src/hooks/notifs/useDeprecationWarningNotification.js';
import { useNpmDeprecationNotification } from 'src/hooks/notifs/useNpmDeprecationNotification.js';
import { useIDEStatusIndicator } from 'src/hooks/notifs/useIDEStatusIndicator.js';
import { useModelMigrationNotifications } from 'src/hooks/notifs/useModelMigrationNotifications.js';
import { useCanSwitchToExistingSubscription } from 'src/hooks/notifs/useCanSwitchToExistingSubscription.js';
import { useTeammateLifecycleNotification } from 'src/hooks/notifs/useTeammateShutdownNotification.js';
import { useFastModeNotification } from 'src/hooks/notifs/useFastModeNotification.js';
import { AutoRunIssueNotification, shouldAutoRunIssue, getAutoRunIssueReasonText, getAutoRunCommand, type AutoRunIssueReason } from '../utils/autoRunIssue.js';
import type { HookProgress } from '../types/hooks.js';
/* eslint-disable @typescript-eslint/no-require-imports */
const WebBrowserPanelModule = feature('WEB_BROWSER_TOOL') ? require('../tools/WebBrowserTool/WebBrowserPanel.js') as typeof import('../tools/WebBrowserTool/WebBrowserPanel.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { IssueFlagBanner } from '../components/PromptInput/IssueFlagBanner.js';
import { useIssueFlagBanner } from '../hooks/useIssueFlagBanner.js';
import { CompanionSprite, CompanionFloatingBubble, MIN_COLS_FOR_FULL_SPRITE } from '../buddy/CompanionSprite.js';
import { CompanionActionFX } from '../buddy/CompanionActionFX.js';
import { isBuddyEnabled } from '../buddy/feature.js';
import { fireCompanionObserver } from '../buddy/observer.js';
// Session manager removed - using AppState now
import type { RemoteSessionConfig } from '../remote/RemoteSessionManager.js';
import { REMOTE_SAFE_COMMANDS } from '../commands.js';
import type { RemoteMessageContent } from '../utils/teleport/api.js';
import { FullscreenLayout, useUnseenDivider, computeUnseenDivider } from '../components/FullscreenLayout.js';
import { isFullscreenEnvEnabled, maybeGetTmuxMouseHint, isMouseTrackingEnabled } from '../utils/fullscreen.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js';
import { useMessageActions, MessageActionsKeybindings, MessageActionsBar, type MessageActionsState, type MessageActionsNav, type MessageActionCaps } from '../components/messageActions.js';
import { setClipboard } from '../ink/termio/osc.js';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import { createAttachmentMessage, getQueuedCommandAttachments } from '../utils/attachments.js';
import { dedupeQueuedTaskNotifications, filterClaimedTaskNotificationsForRestore, pendingCommandsForEmbeddedNotifications } from '../utils/taskNotificationIdentity.js';

// Stable empty array for hooks that accept MCPServerConnection[] — avoids
// creating a new [] literal on every render in remote mode, which would
// cause useEffect dependency changes and infinite re-render loops.
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];

// Stable stub for useAssistantHistory's non-KAIROS branch — avoids a new
// function identity each render, which would break composedOnScroll's memo.
const HISTORY_STUB = {
  maybeLoadOlder: (_: ScrollBoxHandle) => { }
};
// Window after a user-initiated scroll during which type-into-empty does NOT
// repin to bottom. Josh Rosen's workflow: Claude emits long output → scroll
// up to read the start → start typing → before this fix, snapped to bottom.
// https://anthropic.slack.com/archives/C07VBSHV7EV/p1773545449871739
const RECENT_SCROLL_REPIN_WINDOW_MS = 3000;

// Use LRU cache to prevent unbounded memory growth
// 100 files should be sufficient for most coding sessions while preventing
// memory issues when working across many files in large projects

// Stubs: Ultraplan (remote planning sessions) is not included in this open
// snapshot. Every use below is gated behind feature('ULTRAPLAN'), so these
// render nothing / reject if ever reached.
function UltraplanChoiceDialog(_props: {
  plan: string;
  sessionId: string;
  taskId: string;
  setMessages: (action: React.SetStateAction<MessageType[]>) => void;
  readFileState: FileStateCache;
  getAppState: () => AppState;
  setConversationId: React.Dispatch<React.SetStateAction<UUID>>;
}): React.ReactElement | null {
  return null;
}
function UltraplanLaunchDialog(_props: {
  onChoice: (choice: 'launch' | 'cancel', opts?: {
    disconnectedBridge?: boolean;
  }) => void;
}): React.ReactElement | null {
  return null;
}
async function launchUltraplan(_opts: {
  blurb: string;
  getAppState: () => AppState;
  setAppState: SetAppState;
  signal: AbortSignal;
  disconnectedBridge?: boolean;
  onSessionReady: (msg: string) => void;
}): Promise<string> {
  throw new Error('Ultraplan is not available in this build');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Small component to display transcript mode footer with dynamic keybinding.
 * Must be rendered inside KeybindingSetup to access keybinding context.
 */
function TranscriptModeFooter(t0) {
  const $ = _c(9);
  const {
    showAllInTranscript,
    virtualScroll,
    searchBadge,
    suppressShowAll: t1,
    status
  } = t0;
  const suppressShowAll = t1 === undefined ? false : t1;
  const toggleShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  const showAllShortcut = useShortcutDisplay("transcript:toggleShowAll", "Transcript", "ctrl+e");
  const t2 = searchBadge ? " \xB7 n/N to navigate" : virtualScroll ? ` · ${figures.arrowUp}${figures.arrowDown} scroll · home/end top/bottom` : suppressShowAll ? "" : ` · ${showAllShortcut} to ${showAllInTranscript ? "collapse" : "show all"}`;
  let t3;
  if ($[0] !== t2 || $[1] !== toggleShortcut) {
    t3 = <Text dimColor={true}>Showing detailed transcript · {toggleShortcut} to toggle{t2}</Text>;
    $[0] = t2;
    $[1] = toggleShortcut;
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  let t4;
  if ($[3] !== searchBadge || $[4] !== status) {
    t4 = status ? <><Box flexGrow={1} /><Text>{status} </Text></> : searchBadge ? <><Box flexGrow={1} /><Text dimColor={true}>{searchBadge.current}/{searchBadge.count}{"  "}</Text></> : null;
    $[3] = searchBadge;
    $[4] = status;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] !== t3 || $[7] !== t4) {
    t5 = <Box noSelect={true} alignItems="center" alignSelf="center" borderTopDimColor={true} borderBottom={false} borderLeft={false} borderRight={false} borderStyle="single" marginTop={1} paddingLeft={2} width="100%">{t3}{t4}</Box>;
    $[6] = t3;
    $[7] = t4;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  return t5;
}

/** less-style / bar. 1-row, same border-top styling as TranscriptModeFooter
 *  so swapping them in the bottom slot doesn't shift ScrollBox height.
 *  useSearchInput handles readline editing; we report query changes and
 *  render the counter. Incremental — re-search + highlight per keystroke. */
function TranscriptSearchBar({
  jumpRef,
  count,
  current,
  onClose,
  onCancel,
  setHighlight,
  initialQuery
}: {
  jumpRef: RefObject<JumpHandle | null>;
  count: number;
  current: number;
  /** Enter — commit. Query persists for n/N. */
  onClose: (lastQuery: string) => void;
  /** Esc/ctrl+c/ctrl+g — undo to pre-/ state. */
  onCancel: () => void;
  setHighlight: (query: string) => void;
  // Seed with the previous query (less: / shows last pattern). Mount-fire
  // of the effect re-scans with the same query — idempotent (same matches,
  // nearest-ptr, same highlights). User can edit or clear.
  initialQuery: string;
}): React.ReactNode {
  const {
    query,
    cursorOffset
  } = useSearchInput({
    isActive: true,
    initialQuery,
    onExit: () => onClose(query),
    onCancel
  });
  // Index warm-up runs before the query effect so it measures the real
  // cost — otherwise setSearchQuery fills the cache first and warm
  // reports ~0ms while the user felt the actual lag.
  // First / in a transcript session pays the extractSearchText cost.
  // Subsequent / return 0 immediately (indexWarmed ref in VML).
  // Transcript is frozen at ctrl+o so the cache stays valid.
  // Initial 'building' so warmDone is false on mount — the [query] effect
  // waits for the warm effect's first resolve instead of racing it. With
  // null initial, warmDone would be true on mount → [query] fires →
  // setSearchQuery fills cache → warm reports ~0ms while the user felt
  // the real lag.
  const [indexStatus, setIndexStatus] = React.useState<'building' | {
    ms: number;
  } | null>('building');
  React.useEffect(() => {
    let alive = true;
    const warm = jumpRef.current?.warmSearchIndex;
    if (!warm) {
      setIndexStatus(null); // VML not mounted yet — rare, skip indicator
      return;
    }
    setIndexStatus('building');
    warm().then(ms => {
      if (!alive) return;
      // <20ms = imperceptible. No point showing "indexed in 3ms".
      if (ms < 20) {
        setIndexStatus(null);
      } else {
        setIndexStatus({
          ms
        });
        setTimeout(() => alive && setIndexStatus(null), 2000);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only: bar opens once per /
  // Gate the query effect on warm completion. setHighlight stays instant
  // (screen-space overlay, no indexing). setSearchQuery (the scan) waits.
  const warmDone = indexStatus !== 'building';
  useEffect(() => {
    if (!warmDone) return;
    jumpRef.current?.setSearchQuery(query);
    setHighlight(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, warmDone]);
  const off = cursorOffset;
  const cursorChar = off < query.length ? query[off] : ' ';
  return <Box borderTopDimColor borderBottom={false} borderLeft={false} borderRight={false} borderStyle="single" marginTop={1} paddingLeft={2} width="100%"
    // applySearchHighlight scans the whole screen buffer. The query
    // text rendered here IS on screen — /foo matches its own 'foo' in
    // the bar. With no content matches that's the ONLY visible match →
    // gets CURRENT → underlined. noSelect makes searchHighlight.ts:76
    // skip these cells (same exclusion as gutters). You can't text-
    // select the bar either; it's transient chrome, fine.
    noSelect>
    <Text>/</Text>
    <Text>{query.slice(0, off)}</Text>
    <Text inverse>{cursorChar}</Text>
    {off < query.length && <Text>{query.slice(off + 1)}</Text>}
    <Box flexGrow={1} />
    {indexStatus === 'building' ? <Text dimColor>indexing… </Text> : indexStatus ? <Text dimColor>indexed in {indexStatus.ms}ms </Text> : count === 0 && query ? <Text color="error">no matches </Text> : count > 0 ?
      // Engine-counted (indexOf on extractSearchText). May drift from
      // render-count for ghost/phantom messages — badge is a rough
      // location hint. scanElement gives exact per-message positions
      // but counting ALL would cost ~1-3ms × matched-messages.
      <Text dimColor>
        {current}/{count}
        {'  '}
      </Text> : null}
  </Box>;
}
const TITLE_ANIMATION_FRAMES = ['⠂', '⠐'];
const TITLE_STATIC_PREFIX = '✳';
const TITLE_ANIMATION_INTERVAL_MS = 960;

/**
 * Sets the terminal tab title, with an animated prefix glyph while a query
 * is running. Isolated from REPL so the 960ms animation tick re-renders only
 * this leaf component (which returns null — pure side-effect) instead of the
 * entire REPL tree. Before extraction, the tick was ~1 REPL render/sec for
 * the duration of every turn, dragging PromptInput and friends along.
 */
function AnimatedTerminalTitle(t0) {
  const $ = _c(6);
  const {
    isAnimating,
    title,
    disabled,
    noPrefix
  } = t0;
  const terminalFocused = useTerminalFocus();
  const [frame, setFrame] = useState(0);
  let t1;
  let t2;
  if ($[0] !== disabled || $[1] !== isAnimating || $[2] !== noPrefix || $[3] !== terminalFocused) {
    t1 = () => {
      if (disabled || noPrefix || !isAnimating || !terminalFocused) {
        return;
      }
      const interval = setInterval(_temp2, TITLE_ANIMATION_INTERVAL_MS, setFrame);
      return () => clearInterval(interval);
    };
    t2 = [disabled, noPrefix, isAnimating, terminalFocused];
    $[0] = disabled;
    $[1] = isAnimating;
    $[2] = noPrefix;
    $[3] = terminalFocused;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  useEffect(t1, t2);
  const prefix = isAnimating ? TITLE_ANIMATION_FRAMES[frame] ?? TITLE_STATIC_PREFIX : TITLE_STATIC_PREFIX;
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`);
  return null;
}
function _temp2(setFrame_0) {
  return setFrame_0(_temp);
}
function _temp(f) {
  return (f + 1) % TITLE_ANIMATION_FRAMES.length;
}
function getAbortReasonLabel(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.name;
  return String(reason);
}
function summarizeActiveOperations(snapshot: QueryActiveOperationSnapshot): string {
  const apiIds = snapshot.apiCalls.map(call => call.requestId ?? call.clientRequestId ?? 'unknown').join(',');
  const toolIds = snapshot.toolUses.map(tool => `${tool.toolName}:${tool.toolUseId}`).join(',');
  return `activeApiCalls=${snapshot.apiCalls.length} activeToolUses=${snapshot.toolUses.length}` + (apiIds ? ` apiIds=${apiIds}` : '') + (toolIds ? ` toolIds=${toolIds}` : '');
}
function logQueryLifecycle(event: string, context: QueryLifecycleContext, extras = ''): void {
  logForDebugging(formatQueryLifecycleLogMessage(event, context, extras));
}
// Default per-prompt cap for every local interactive REPL entrypoint. Headless
// and SDK callers retain their explicit maxTurns contracts. Local interactive
// callers can raise the cap via --max-turns, OPENCLAUDE_MAX_TURNS /
// CLAUDE_CODE_MAX_TURNS, or `/config` → Max turns (interactive).
// Remote-backed sessions are not capped here.
export type Props = {
  commands: Command[];
  debug: boolean;
  initialTools: Tool[];
  // Initial messages to populate the REPL with
  initialMessages?: MessageType[];
  // Deferred hook messages promise — REPL renders immediately and injects
  // hook messages when they resolve. Awaited before the first API call.
  pendingHookMessages?: Promise<HookResultMessage[]>;
  initialFileHistorySnapshots?: FileHistorySnapshot[];
  // Content-replacement records from a resumed session's transcript — used to
  // reconstruct contentReplacementState so the same results are re-replaced
  initialContentReplacements?: ContentReplacementRecord[];
  // Initial agent context for session resume (name/color set via /rename or /color)
  initialAgentName?: string;
  initialAgentColor?: AgentColorName;
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  autoConnectIdeFlag?: boolean;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  // Optional callback invoked before query execution
  // Called after user message is added to conversation but before API call
  // Return false to prevent query execution
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>;
  // Optional callback when a turn completes (model finishes responding)
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>;
  // When true, disables REPL input (hides prompt and prevents message selector)
  disabled?: boolean;
  // Optional agent definition to use for the main thread
  mainThreadAgentDefinition?: AgentDefinition;
  // The effective non-agent model to restore when switching to an agent that inherits
  baseMainLoopModel?: ModelSetting;
  // True when startup had an explicit model override that agent switching must preserve
  hasExplicitModelOverride?: boolean;
  // When true, disables all slash commands
  disableSlashCommands?: boolean;
  // Remote session config for --remote mode (uses CCR as execution engine)
  remoteSessionConfig?: RemoteSessionConfig;
  // Direct connect config for `claude connect` mode (connects to a claude server)
  directConnectConfig?: DirectConnectConfig;
  // SSH session for `claude ssh` mode (local REPL, remote tools over ssh)
  sshSession?: SSHSession;
  // Thinking configuration to use when thinking is enabled
  thinkingConfig: ThinkingConfig;
  // Model to fallback to when primary model returns overloaded errors (529)
  fallbackModel?: string;
  // Bound a single interactive prompt's sequential tool-use turns.
  maxTurns?: number;
};
export type Screen = 'prompt' | 'transcript';
export function REPL({
  commands: initialCommands,
  debug,
  initialTools,
  initialMessages,
  pendingHookMessages,
  initialFileHistorySnapshots,
  initialContentReplacements,
  initialAgentName,
  initialAgentColor,
  mcpClients: initialMcpClients,
  dynamicMcpConfig: initialDynamicMcpConfig,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt: customSystemPrompt,
  appendSystemPrompt,
  onBeforeQuery,
  onTurnComplete,
  disabled = false,
  mainThreadAgentDefinition: initialMainThreadAgentDefinition,
  baseMainLoopModel = null,
  hasExplicitModelOverride = false,
  disableSlashCommands = false,
  remoteSessionConfig,
  directConnectConfig,
  sshSession,
  thinkingConfig,
  fallbackModel,
  maxTurns: maxTurnsProp
}: Props): React.ReactNode {
  // Resolve at query time so `/config` changes apply on the next prompt
  // without requiring a REPL remount. CLI prop still wins over env/config.
  const isRemoteSession = !!remoteSessionConfig;
  const foregroundTurnBudgetRef = useRef<ForegroundTurnBudgetHandoff | null>(null);
  const backgroundHandoffStartedRef = useRef(false);
  const [backgroundHandoffPreparing, setBackgroundHandoffPreparing] = useState(false);

  useEffect(() => {
    if (
      shouldShowReplMaxTurnsUnlimitedWarning(maxTurnsProp, {
        isRemoteSession,
        directConnectConfig,
        sshSession,
      })
    ) {
      const warning = getReplMaxTurnsWarning(maxTurnsProp)
      if (warning) {
        process.stderr.write(chalk.yellow(`${warning}\n`))
      }
    }
  }, [maxTurnsProp, isRemoteSession, directConnectConfig, sshSession]);

  // Env-var gates hoisted to mount-time — isEnvTruthy does toLowerCase+trim+
  // includes, and these were on the render path (hot during PageUp spam).
  const titleDisabled = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE), []);
  const disableVirtualScroll = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL), []);
  const disableMessageActions = feature('MESSAGE_ACTIONS') ?
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS), []) : false;

  // Agent definition is state so /resume can update it mid-session
  const [mainThreadAgentDefinition, setMainThreadAgentDefinition] = useState(initialMainThreadAgentDefinition);
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const verbose = useAppState(s => s.verbose);
  const mcp = useAppState(s => s.mcp);
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const fileHistory = useAppState(s => s.fileHistory);
  const initialMessage = useAppState(s => s.initialMessage);
  const queuedCommands = useCommandQueue();
  // feature() is a build-time constant — dead code elimination removes the hook
  // call entirely in external builds, so this is safe despite looking conditional.
  // These fields contain excluded strings that must not appear in external builds.
  const spinnerTip = useAppState(s => s.spinnerTip);
  const showExpandedTodos = useAppState(s => s.expandedView) === 'tasks';
  const pendingWorkerRequest = useAppState(s => s.pendingWorkerRequest);
  const pendingSandboxRequest = useAppState(s => s.pendingSandboxRequest);
  const teamContext = useAppState(s => s.teamContext);
  const tasks = useAppState(s => s.tasks);
  const workerSandboxPermissions = useAppState(s => s.workerSandboxPermissions);
  const elicitation = useAppState(s => s.elicitation);
  const ultraplanPendingChoice = useAppState(s => s.ultraplanPendingChoice);
  const ultraplanLaunchPending = useAppState(s => s.ultraplanLaunchPending);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const setAppState = useSetAppState();
  const autoCompactTrackingBySessionRef = useRef(new Map<ReturnType<typeof getSessionId>, AutoCompactTrackingState>());
  const getAutoCompactTrackingForSession = useCallback((sessionId: ReturnType<typeof getSessionId>) => autoCompactTrackingBySessionRef.current.get(sessionId), []);
  const setAutoCompactTrackingForSession = useCallback((sessionId: ReturnType<typeof getSessionId>, tracking: AutoCompactTrackingState | undefined) => {
    if (tracking) {
      autoCompactTrackingBySessionRef.current.set(sessionId, tracking);
    } else {
      autoCompactTrackingBySessionRef.current.delete(sessionId);
    }
  }, []);
  const setAutoCompactTrackingForSessionIfUnchanged = useCallback((sessionId: ReturnType<typeof getSessionId>, expected: AutoCompactTrackingState | undefined, tracking: AutoCompactTrackingState | undefined) => {
    if (autoCompactTrackingBySessionRef.current.get(sessionId) !== expected) {
      return false;
    }
    if (tracking) {
      autoCompactTrackingBySessionRef.current.set(sessionId, tracking);
    } else {
      autoCompactTrackingBySessionRef.current.delete(sessionId);
    }
    return true;
  }, []);
  const resetAutoCompactTracking = useCallback(() => {
    autoCompactTrackingBySessionRef.current.clear();
  }, []);

  // Bootstrap: retained local_agent that hasn't loaded disk yet → read
  // sidechain JSONL and UUID-merge with whatever stream has appended so far.
  // Stream appends immediately on retain (no defer); bootstrap fills the
  // prefix. Disk-write-before-yield means live is always a suffix of disk.
  const viewedLocalAgent = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const needsBootstrap = isLocalAgentTask(viewedLocalAgent) && viewedLocalAgent.retain && !viewedLocalAgent.diskLoaded;
  useEffect(() => {
    if (!viewingAgentTaskId || !needsBootstrap) return;
    const taskId = viewingAgentTaskId;
    void getAgentTranscript(asAgentId(taskId)).then(result => {
      setAppState(prev => {
        const t = prev.tasks[taskId];
        if (!isLocalAgentTask(t) || t.diskLoaded || !t.retain) return prev;
        const live = t.messages ?? [];
        const liveUuids = new Set(live.map(m => m.uuid));
        const diskOnly = result ? result.messages.filter(m => !liveUuids.has(m.uuid)) : [];
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...t,
              messages: [...diskOnly, ...live],
              diskLoaded: true
            }
          }
        };
      });
    });
  }, [viewingAgentTaskId, needsBootstrap, setAppState]);
  const store = useAppStateStore();
  const terminal = useTerminalNotification();
  const mainLoopModel = useMainLoopModel();
  const appMainLoopModel = useAppState(s => s.mainLoopModel);
  // Ambient ultracode indicator for the prompt border. Reactive to /effort so
  // the border flips the moment ultracode is (de)selected, independent of the
  // per-turn spinner color (which is set at query start in onQuery).
  const effortValue = useAppState(s => s.effortValue);
  const isUltracode = useMemo(
    () => getDisplayedEffortLevel(mainLoopModel, effortValue) === 'ultracode',
    [mainLoopModel, effortValue],
  );
  const appMainLoopModelForSession = useAppState(s => s.mainLoopModelForSession);
  const initialAgentModelSelection = !hasExplicitModelOverride && initialMainThreadAgentDefinition?.model && initialMainThreadAgentDefinition.model !== 'inherit' ? getActiveSessionAgentModelSelection({
    agent: initialMainThreadAgentDefinition,
    baseMainLoopModel,
    hasExplicitModelOverride,
    hasAgentManagedModel: false
  }) : undefined;
  const explicitModelOverrideRef = useRef(hasExplicitModelOverride);
  const baseMainLoopModelRef = useRef<ModelSetting | undefined>(baseMainLoopModel);
  const agentManagedModelRef = useRef<ModelSetting | undefined>(initialAgentModelSelection?.shouldUpdateModel ? initialAgentModelSelection.mainLoopModelForSession : undefined);
  const previousMainLoopModelForSessionRef = useRef(appMainLoopModelForSession);
  const didTrackInitialModelStateRef = useRef(false);
  useEffect(() => {
    const previousMainLoopModelForSession = previousMainLoopModelForSessionRef.current;
    previousMainLoopModelForSessionRef.current = appMainLoopModelForSession;

    if (!didTrackInitialModelStateRef.current) {
      didTrackInitialModelStateRef.current = true;
      return;
    }

    const currentEffectiveModelSetting = appMainLoopModelForSession ?? appMainLoopModel;
    const clearedAgentManagedSessionModel = previousMainLoopModelForSession !== null && appMainLoopModelForSession === null;
    if (!clearedAgentManagedSessionModel && currentEffectiveModelSetting === agentManagedModelRef.current) return;

    explicitModelOverrideRef.current = true;
    baseMainLoopModelRef.current = currentEffectiveModelSetting;
    agentManagedModelRef.current = undefined;
  }, [appMainLoopModel, appMainLoopModelForSession]);

  // Note: standaloneAgentContext is initialized in main.tsx (via initialState) or
  // ResumeConversation.tsx (via setAppState before rendering REPL) to avoid
  // useEffect-based state initialization on mount (per CLAUDE.md guidelines)

  // Local state for commands (hot-reloadable when skill files change)
  const [localCommands, setLocalCommands] = useState(initialCommands);

  // Watch for skill file changes and reload all commands
  useSkillsChange(isRemoteSession ? undefined : getProjectRoot(), setLocalCommands);

  // Track proactive mode for tools dependency - SleepTool filters by proactive state
  const proactiveActive = React.useSyncExternalStore(proactiveModule?.subscribeToProactiveChanges ?? PROACTIVE_NO_OP_SUBSCRIBE, proactiveModule?.isProactiveActive ?? PROACTIVE_FALSE);

  // BriefTool.isEnabled() reads getUserMsgOptIn() from bootstrap state, which
  // /brief flips mid-session alongside isBriefOnly. The memo below needs a
  // React-visible dep to re-run getTools() when that happens; isBriefOnly is
  // the AppState mirror that triggers the re-render. Without this, toggling
  // /brief mid-session leaves the stale tool list (no SendUserMessage) and
  // the model emits plain text the brief filter hides.
  const isBriefOnly = useAppState(s => s.isBriefOnly);
  const localTools = useMemo(() => getTools(toolPermissionContext), [toolPermissionContext, proactiveActive, isBriefOnly]);
  useKickOffCheckAndDisableBypassPermissionsIfNeeded();
  useKickOffCheckAndDisableAutoModeIfNeeded();
  const [dynamicMcpConfig, setDynamicMcpConfig] = useState<Record<string, ScopedMcpServerConfig> | undefined>(initialDynamicMcpConfig);
  const onChangeDynamicMcpConfig = useCallback((config: Record<string, ScopedMcpServerConfig>) => {
    setDynamicMcpConfig(config);
  }, [setDynamicMcpConfig]);
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  // [ forces the dump-to-scrollback path inside transcript mode. Separate
  // from CLAUDE_CODE_NO_FLICKER=0 (which is process-lifetime) — this is
  // ephemeral, reset on transcript exit. Diagnostic escape hatch so
  // terminal/tmux native cmd-F can search the full flat render.
  const [dumpMode, setDumpMode] = useState(false);
  // v-for-editor render progress. Inline in the footer — notifications
  // render inside PromptInput which isn't mounted in transcript.
  const [editorStatus, setEditorStatus] = useState('');
  // Incremented on transcript exit. Async v-render captures this at start;
  // each status write no-ops if stale (user left transcript mid-render —
  // the stable setState would otherwise stamp a ghost toast into the next
  // session). Also clears any pending 4s auto-clear.
  const editorGenRef = useRef(0);
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editorRenderingRef = useRef(false);
  const {
    addNotification,
    removeNotification
  } = useNotifications();

  // eslint-disable-next-line prefer-const
  let trySuggestBgPRIntercept = SUGGEST_BG_PR_NOOP;
  const mcpClients = useMergedClients(initialMcpClients, mcp.clients);

  // IDE integration
  const [ideSelection, setIDESelection] = useState<IDESelection | undefined>(undefined);
  const [ideToInstallExtension, setIDEToInstallExtension] = useState<IdeType | null>(null);
  const [ideInstallationStatus, setIDEInstallationStatus] = useState<IDEExtensionInstallationStatus | null>(null);
  const [showIdeOnboarding, setShowIdeOnboarding] = useState(false);
  const [showEffortCallout, setShowEffortCallout] = useState(() => shouldShowEffortCallout(mainLoopModel));
  const showRemoteCallout = useAppState(s => s.showRemoteCallout);
  const [showDesktopUpsellStartup, setShowDesktopUpsellStartup] = useState(() => shouldShowDesktopUpsellStartup());
  // notifications
  useModelMigrationNotifications();
  useCanSwitchToExistingSubscription();
  useIDEStatusIndicator({
    ideSelection,
    mcpClients,
    ideInstallationStatus
  });
  useMcpConnectivityStatus({
    mcpClients
  });
  useAutoModeUnavailableNotification();
  usePluginInstallationStatus();
  usePluginAutoupdateNotification();
  useSettingsErrors();
  useRateLimitWarningNotification(mainLoopModel);
  useFastModeNotification();
  useDeprecationWarningNotification(mainLoopModel);
  useNpmDeprecationNotification();
  useInstallMessages();
  useChromeExtensionNotification();
  useOfficialMarketplaceNotification();
  useLspInitializationNotification();
  useTeammateLifecycleNotification();
  const {
    recommendation: lspRecommendation,
    handleResponse: handleLspResponse
  } = useLspPluginRecommendation();
  const {
    recommendation: hintRecommendation,
    handleResponse: handleHintResponse
  } = useClaudeCodeHintRecommendation();

  // Memoize the combined initial tools array to prevent reference changes
  const combinedInitialTools = useMemo(() => {
    return [...localTools, ...initialTools];
  }, [localTools, initialTools]);

  // Initialize plugin management
  const pluginCommands = useManagePlugins({
    enabled: !isRemoteSession
  });
  const tasksV2 = useTasksV2WithCollapseEffect();

  // Start background plugin installations

  // SECURITY: This code is guaranteed to run ONLY after the "trust this folder" dialog
  // has been confirmed by the user. The trust dialog is shown in cli.tsx (line ~387)
  // before the REPL component is rendered. The dialog blocks execution until the user
  // accepts, and only then is the REPL component mounted and this effect runs.
  // This ensures that plugin installations from repository and user settings only
  // happen after explicit user consent to trust the current working directory.
  // Deferring startup checks is handled below (after promptTypingSuppressionActive
  // is declared) to avoid temporal dead zone issues.

  // Allow Claude in Chrome MCP to send prompts through MCP notifications
  // and sync permission mode changes to the Chrome extension
  usePromptsFromClaudeInChrome(isRemoteSession ? EMPTY_MCP_CLIENTS : mcpClients, toolPermissionContext.mode);

  // Initialize swarm features: teammate hooks and context
  // Handles both fresh spawns and resumed teammate sessions
  useSwarmInitialization(setAppState, initialMessages, {
    enabled: !isRemoteSession
  });
  const mergedTools = useMergedTools(combinedInitialTools, mcp.tools, toolPermissionContext);

  // Apply agent tool restrictions if mainThreadAgentDefinition is set
  const {
    tools,
    allowedAgentTypes
  } = useMemo(() => {
    if (!mainThreadAgentDefinition) {
      return {
        tools: mergedTools,
        allowedAgentTypes: undefined as string[] | undefined
      };
    }
    const resolved = resolveAgentTools(mainThreadAgentDefinition, mergedTools, false, true);
    return {
      tools: resolved.resolvedTools,
      allowedAgentTypes: resolved.allowedAgentTypes
    };
  }, [mainThreadAgentDefinition, mergedTools]);

  // Merge commands from local state, plugins, and MCP
  const commandsWithPlugins = useMergedCommands(localCommands, pluginCommands as Command[]);
  const mergedCommands = useMergedCommands(commandsWithPlugins, mcp.commands as Command[]);
  // Keep plugin commands out of render-time command props. Feeding the full
  // execution set into PromptInput/Messages reintroduced the startup repaint
  // freeze, while transcript rendering still round-trips plugin skills via the
  // SkillTool's `skill` payload without needing plugin command objects here.
  const renderMergedCommands = useMergedCommands(localCommands, mcp.commands as Command[]);
  // Filter out all commands if disableSlashCommands is true
  const commands = useMemo(() => disableSlashCommands ? [] : mergedCommands, [disableSlashCommands, mergedCommands]);
  const renderCommands = useMemo(() => disableSlashCommands ? [] : renderMergedCommands, [disableSlashCommands, renderMergedCommands]);
  useIdeLogging(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients);
  useIdeSelection(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients, setIDESelection);
  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding');
  // Ref mirror so onSubmit can read the latest value without adding
  // streamMode to its deps. streamMode flips between
  // requesting/responding/tool-use ~10x per turn during streaming; having it
  // in onSubmit's deps was recreating onSubmit on every flip, which
  // cascaded into PromptInput prop churn and downstream useCallback/useMemo
  // invalidation. The only consumers inside callbacks are debug logging and
  // telemetry (handlePromptSubmit.ts), so a stale-by-one-render value is
  // harmless — but ref mirrors sync on every render anyway so it's fresh.
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  const [streamingToolUses, setStreamingToolUses] = useState<StreamingToolUse[]>([]);
  const [streamingThinking, setStreamingThinking] = useState<StreamingThinking | null>(null);

  // Auto-hide streaming thinking after 30 seconds of being completed
  useEffect(() => {
    if (streamingThinking && !streamingThinking.isStreaming && streamingThinking.streamingEndedAt) {
      const elapsed = Date.now() - streamingThinking.streamingEndedAt;
      const remaining = 30000 - elapsed;
      if (remaining > 0) {
        const timer = setTimeout(setStreamingThinking, remaining, null);
        return () => clearTimeout(timer);
      } else {
        setStreamingThinking(null);
      }
    }
  }, [streamingThinking]);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  // Ref that always points to the current abort controller, used by the
  // REPL bridge to abort the active query when a remote interrupt arrives.
  const abortControllerRef = useRef<AbortController | null>(null);
  abortControllerRef.current = abortController;

  // Ref for the bridge result callback — set after useReplBridge initializes,
  // read in the onQuery finally block to notify mobile clients that a turn ended.
  const sendBridgeResultRef = useRef<() => void>(() => { });

  // Ref for the synchronous restore callback — set after restoreMessageSync is
  // defined, read in the onQuery finally block for auto-restore on interrupt.
  const restoreMessageSyncRef = useRef<(m: UserMessage, options?: {
    preserveInterruptionCorrectionReminder?: boolean;
  }) => void>(() => { });

  // Ref to the fullscreen layout's scroll box for keyboard scrolling.
  // Null when fullscreen mode is disabled (ref never attached).
  const scrollRef = useRef<ScrollBoxHandle>(null);
  // Separate ref for the modal slot's inner ScrollBox — passed through
  // FullscreenLayout → ModalContext so Tabs can attach it to its own
  // ScrollBox for tall content (e.g. /status's MCP-server list). NOT
  // keyboard-driven — ScrollKeybindingHandler stays on the outer ref so
  // PgUp/PgDn/wheel always scroll the transcript behind the modal.
  // Plumbing kept for future modal-scroll wiring.
  const modalScrollRef = useRef<ScrollBoxHandle>(null);
  // Timestamp of the last user-initiated scroll (wheel, PgUp/PgDn, ctrl+u,
  // End/Home, G, drag-to-scroll). Stamped in composedOnScroll — the single
  // chokepoint ScrollKeybindingHandler calls for every user scroll action.
  // Programmatic scrolls (repinScroll's scrollToBottom, sticky auto-follow)
  // do NOT go through composedOnScroll, so they don't stamp this. Ref not
  // state: no re-render on every wheel tick.
  const lastUserScrollTsRef = useRef(0);

  // Synchronous state machine for the query lifecycle. Replaces the
  // error-prone dual-state pattern where isLoading (React state, async
  // batched) and isQueryRunning (ref, sync) could desync. See QueryGuard.ts.
  const queryGuardRef = React.useRef<QueryGuard | null>(null);
  if (queryGuardRef.current === null) {
    queryGuardRef.current = new QueryGuard(getQueryGuardOptionsFromEnv());
  }
  const queryGuard = queryGuardRef.current;

  // A user-cancelled model turn arms one hidden reminder for the next normal
  // local prompt. The tracker reads QueryGuard directly so its tested lifecycle
  // rules cannot drift from the REPL's active-query identity.
  const interruptionCorrectionTrackerRef = useRef<InterruptionCorrectionTracker | null>(null);
  if (interruptionCorrectionTrackerRef.current === null) {
    interruptionCorrectionTrackerRef.current = new InterruptionCorrectionTracker(queryGuard, getSessionId);
  }
  const interruptionCorrectionTracker = interruptionCorrectionTrackerRef.current;
  const takeInterruptionCorrectionReminder = useCallback(() => {
    return interruptionCorrectionTracker.takeReminder();
  }, []);
  const restoreInterruptionCorrectionReminder = useCallback(() => {
    interruptionCorrectionTracker.restoreReminder();
  }, []);

  // Subscribe to the guard — true during dispatching or running.
  // This is the single source of truth for "is a local query in flight".
  const isQueryActive = React.useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot);

  // Separate loading flag for operations outside the local query guard:
  // remote sessions (useRemoteSession / useDirectConnect) and foregrounded
  // background tasks (useSessionBackgrounding). These don't route through
  // onQuery / queryGuard, so they need their own spinner-visibility state.
  // Initialize true if remote mode with initial prompt (CCR processing it).
  const [isExternalLoading, setIsExternalLoadingRaw] = React.useState(remoteSessionConfig?.hasInitialPrompt ?? false);

  // Derived: any loading source active. Read-only — no setter. Local query
  // loading is driven by queryGuard (reserve/tryStart/end/cancelReservation),
  // external loading by setIsExternalLoading.
  const isLoading = isQueryActive || isExternalLoading || backgroundHandoffPreparing;

  // Elapsed time is computed by SpinnerWithVerb from these refs on each
  // animation frame, avoiding a useInterval that re-renders the entire REPL.
  const [userInputOnProcessing, setUserInputOnProcessingRaw] = React.useState<string | undefined>(undefined);
  // messagesRef.current.length at the moment userInputOnProcessing was set.
  // The placeholder hides once displayedMessages grows past this — i.e. the
  // real user message has landed in the visible transcript.
  const userInputBaselineRef = React.useRef(0);
  // True while the submitted prompt is being processed but its user message
  // hasn't reached setMessages yet. setMessages uses this to keep the
  // baseline in sync when unrelated async messages (bridge status, hook
  // results, scheduled tasks) land during that window.
  const userMessagePendingRef = React.useRef(false);

  // Wall-clock time tracking refs for accurate elapsed time calculation
  const loadingStartTimeRef = React.useRef<number>(0);
  const totalPausedMsRef = React.useRef(0);
  const pauseStartTimeRef = React.useRef<number | null>(null);
  const resetTimingRefs = React.useCallback(() => {
    loadingStartTimeRef.current = Date.now();
    totalPausedMsRef.current = 0;
    pauseStartTimeRef.current = null;
  }, []);

  // Reset timing refs inline when isQueryActive transitions false→true.
  // queryGuard.reserve() (in executeUserInput) fires BEFORE processUserInput's
  // first await, but the ref reset in onQuery's try block runs AFTER. During
  // that gap, React renders the spinner with loadingStartTimeRef=0, computing
  // elapsedTimeMs = Date.now() - 0 ≈ 56 years. This inline reset runs on the
  // first render where isQueryActive is observed true — the same render that
  // first shows the spinner — so the ref is correct by the time the spinner
  // reads it. See INC-4549.
  const wasQueryActiveRef = React.useRef(false);
  if (isQueryActive && !wasQueryActiveRef.current) {
    resetTimingRefs();
  }
  wasQueryActiveRef.current = isQueryActive;

  // Wrapper for setIsExternalLoading that resets timing refs on transition
  // to true — SpinnerWithVerb reads these for elapsed time, so they must be
  // reset for remote sessions / foregrounded tasks too (not just local
  // queries, which reset them in onQuery). Without this, a remote-only
  // session would show ~56 years elapsed (Date.now() - 0).
  const setIsExternalLoading = React.useCallback((value: boolean) => {
    setIsExternalLoadingRaw(value);
    if (value) resetTimingRefs();
  }, [resetTimingRefs]);

  // Start time of the first turn that had swarm teammates running
  // Used to compute total elapsed time (including teammate execution) for the deferred message
  const swarmStartTimeRef = React.useRef<number | null>(null);
  const swarmBudgetInfoRef = React.useRef<{
    tokens: number;
    limit: number;
    nudges: number;
  } | undefined>(undefined);

  // Ref to track current focusedInputDialog for use in callbacks
  // This avoids stale closures when checking dialog state in timer callbacks
  const focusedInputDialogRef = React.useRef<ReturnType<typeof getFocusedInputDialog>>(undefined);

  // How long after the last keystroke before deferred dialogs are shown
  const PROMPT_SUPPRESSION_MS = 1500;
  // True when user is actively typing — defers interrupt dialogs so keystrokes
  // don't accidentally dismiss or answer a permission prompt the user hasn't read yet.
  const [isPromptInputActive, setIsPromptInputActive] = React.useState(false);
  const [autoUpdaterResult, setAutoUpdaterResult] = useState<AutoUpdaterResult | null>(null);
  useEffect(() => {
    if (autoUpdaterResult?.notifications) {
      autoUpdaterResult.notifications.forEach(notification => {
        addNotification({
          key: 'auto-updater-notification',
          text: notification,
          priority: 'low'
        });
      });
    }
  }, [autoUpdaterResult, addNotification]);

  // tmux + fullscreen + `mouse off`: one-time hint that wheel won't scroll.
  // We no longer mutate tmux's session-scoped mouse option (it poisoned
  // sibling panes); tmux users already know this tradeoff from vim/less.
  useEffect(() => {
    if (isFullscreenEnvEnabled()) {
      void maybeGetTmuxMouseHint().then(hint => {
        if (hint) {
          addNotification({
            key: 'tmux-mouse-hint',
            text: hint,
            priority: 'low'
          });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [toolJSX, setToolJSXInternal] = useState<{
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    isImmediate?: boolean;
  } | null>(null);

  // Track local JSX commands separately so tools can't overwrite them.
  // This enables "immediate" commands (like /btw) to persist while Claude is processing.
  const localJSXCommandRef = useRef<{
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand: true;
  } | null>(null);

  // Wrapper for setToolJSX that preserves local JSX commands (like /btw).
  // When a local JSX command is active, we ignore updates from tools
  // unless they explicitly set clearLocalJSX: true (from onDone callbacks).
  //
  // TO ADD A NEW IMMEDIATE COMMAND:
  // 1. Set `immediate: true` in the command definition
  // 2. Set `isLocalJSXCommand: true` when calling setToolJSX in the command's JSX
  // 3. In the onDone callback, use `setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true })`
  //    to explicitly clear the overlay when the user dismisses it
  const setToolJSX = useCallback((args: {
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    clearLocalJSX?: boolean;
  } | null) => {
    // If setting a local JSX command, store it in the ref
    if (args?.isLocalJSXCommand) {
      const {
        clearLocalJSX: _,
        ...rest
      } = args;
      localJSXCommandRef.current = {
        ...rest,
        isLocalJSXCommand: true
      };
      setToolJSXInternal(rest);
      return;
    }

    // If there's an active local JSX command in the ref
    if (localJSXCommandRef.current) {
      // Allow clearing only if explicitly requested (from onDone callbacks)
      if (args?.clearLocalJSX) {
        localJSXCommandRef.current = null;
        setToolJSXInternal(null);
        return;
      }
      // Otherwise, keep the local JSX command visible - ignore tool updates
      return;
    }

    // No active local JSX command, allow any update
    if (args?.clearLocalJSX) {
      setToolJSXInternal(null);
      return;
    }
    setToolJSXInternal(args);
  }, []);
  const [toolUseConfirmQueue, setToolUseConfirmQueue] = useState<ToolUseConfirm[]>([]);
  const activePermissionSessionId = getSessionId();
  const activeToolUseConfirmQueue = toolUseConfirmQueue.filter(item => item.permissionSessionId === undefined || item.permissionSessionId === activePermissionSessionId);
  // Sticky footer JSX registered by permission request components (currently
  // only ExitPlanModePermissionRequest). Renders in FullscreenLayout's `bottom`
  // slot so response options stay visible while the user scrolls a long plan.
  const [permissionStickyFooter, setPermissionStickyFooter] = useState<React.ReactNode | null>(null);
  const [sandboxPermissionRequestQueue, setSandboxPermissionRequestQueue] = useState<Array<{
    hostPattern: NetworkHostPattern;
    resolvePromise: (allowConnection: boolean) => void;
  }>>([]);
  const [promptQueue, setPromptQueue] = useState<Array<{
    request: PromptRequest;
    title: string;
    toolInputSummary?: string | null;
    resolve: (response: PromptResponse) => void;
    reject: (error: Error) => void;
  }>>([]);

  // Track bridge cleanup functions for sandbox permission requests so the
  // local dialog handler can cancel the remote prompt when the local user
  // responds first. Keyed by host to support concurrent same-host requests.
  const sandboxBridgeCleanupRef = useRef<Map<string, Array<() => void>>>(new Map());

  // -- Terminal title management
  // Session title (set via /rename or restored on resume) wins over
  // the agent name, which wins over the Haiku-extracted topic;
  // all fall back to the product name.
  const terminalTitleFromRename = useAppState(s => s.settings.terminalTitleFromRename) !== false;
  const sessionTitle = terminalTitleFromRename ? getCurrentSessionTitle(getSessionId()) : undefined;
  const [haikuTitle, setHaikuTitle] = useState<string>();
  // Gates the one-shot Haiku call that generates the tab title. Seeded true
  // on resume (initialMessages present) so we don't re-title a resumed
  // session from mid-conversation context.
  const haikuTitleAttemptedRef = useRef((initialMessages?.length ?? 0) > 0);
  const agentTitle = mainThreadAgentDefinition?.agentType;
  const terminalTitle = sessionTitle ?? agentTitle ?? haikuTitle ?? 'OpenClaude';
  const isWaitingForApproval = activeToolUseConfirmQueue.length > 0 || promptQueue.length > 0 || pendingWorkerRequest || pendingSandboxRequest;
  // Local-jsx commands (like /plugin, /config) show user-facing dialogs that
  // wait for input. Require jsx != null — if the flag is stuck true but jsx
  // is null, treat as not-showing so TextInput focus and queue processor
  // aren't deadlocked by a phantom overlay.
  const isShowingLocalJSXCommand = toolJSX?.isLocalJSXCommand === true && toolJSX?.jsx != null;
  const titleIsAnimating = isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand;
  // Title animation state lives in <AnimatedTerminalTitle> so the 960ms tick
  // doesn't re-render REPL. titleDisabled/terminalTitle are still computed
  // here because onQueryImpl reads them (background session description,
  // haiku title extraction gate).

  // Prevent macOS from sleeping while Claude is working
  useEffect(() => {
    if (isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand) {
      startPreventSleep();
      return () => stopPreventSleep();
    }
  }, [isLoading, isWaitingForApproval, isShowingLocalJSXCommand]);
  const sessionStatus: TabStatusKind = isWaitingForApproval || isShowingLocalJSXCommand ? 'waiting' : isLoading ? 'busy' : 'idle';
  const waitingFor = sessionStatus !== 'waiting' ? undefined : activeToolUseConfirmQueue.length > 0 ? `approve ${activeToolUseConfirmQueue[0]!.tool.name}` : pendingWorkerRequest ? 'worker request' : pendingSandboxRequest ? 'sandbox request' : isShowingLocalJSXCommand ? 'dialog open' : 'input needed';

  // Push status to the PID file for `claude ps`. Fire-and-forget; ps falls
  // back to transcript-tail derivation when this is missing/stale.
  useEffect(() => {
    if (feature('BG_SESSIONS')) {
      void updateSessionActivity({
        status: sessionStatus,
        waitingFor
      });
    }
  }, [sessionStatus, waitingFor]);

  // 3P default: off — OSC 21337 is internal-only while the spec stabilizes.
  // Gated so we can roll back if the sidebar indicator conflicts with
  // the title spinner in terminals that render both. When the flag is
  // on, the user-facing config setting controls whether it's active.
  const tabStatusGateEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_sidebar', false);
  const showStatusInTerminalTab = tabStatusGateEnabled && (getGlobalConfig().showStatusInTerminalTab ?? false);
  useTabStatus(titleDisabled || !showStatusInTerminalTab ? null : sessionStatus);

  // Register the leader's setToolUseConfirmQueue for in-process teammates
  useEffect(() => {
    registerLeaderToolUseConfirmQueue(setToolUseConfirmQueue);
    return () => unregisterLeaderToolUseConfirmQueue();
  }, [setToolUseConfirmQueue]);
  const [messages, rawSetMessages] = useState<MessageType[]>(() => {
    if (!initialMessages) return [];
    const initialReplacementState = provisionContentReplacementState(initialMessages, initialContentReplacements);
    return initialReplacementState ? applyToolResultReplacementsToMessages(initialMessages, initialReplacementState.replacements) : initialMessages;
  });
  const messagesRef = useRef(messages);
  // Stores the willowMode variant that was shown (or false if no hint shown).
  // Captured at hint_shown time so hint_converted telemetry reports the same
  // variant — the GrowthBook value shouldn't change mid-session, but reading
  // it once guarantees consistency between the paired events.
  const idleHintShownRef = useRef<string | false>(false);
  // Wrap setMessages so messagesRef is always current the instant the
  // call returns — not when React later processes the batch.  Apply the
  // updater eagerly against the ref, then hand React the computed value
  // (not the function).  rawSetMessages batching becomes last-write-wins,
  // and the last write is correct because each call composes against the
  // already-updated ref.  This is the Zustand pattern: ref is source of
  // truth, React state is the render projection.  Without this, paths
  // that queue functional updaters then synchronously read the ref
  // (e.g. handleSpeculationAccept → onQuery) see stale data.
  const setMessages = useCallback((action: React.SetStateAction<MessageType[]>) => {
    const {
      previousMessages: prev,
      nextMessages: next
    } = applyInterruptionCorrectionAwareMessageUpdate(messagesRef, action, interruptionCorrectionTracker);
    if (next.length < userInputBaselineRef.current) {
      // Shrank (compact/rewind/clear) — clamp so placeholderText's length
      // check can't go stale.
      userInputBaselineRef.current = 0;
    } else if (next.length > prev.length && userMessagePendingRef.current) {
      // Grew while the submitted user message hasn't landed yet. If the
      // added messages don't include it (bridge status, hook results,
      // scheduled tasks landing async during processUserInputBase), bump
      // baseline so the placeholder stays visible. Once the user message
      // lands, stop tracking — later additions (assistant stream) should
      // not re-show the placeholder.
      const delta = next.length - prev.length;
      const added = prev.length === 0 || next[0] === prev[0] ? next.slice(-delta) : next.slice(0, delta);
      if (added.some(isHumanTurn)) {
        userMessagePendingRef.current = false;
      } else {
        userInputBaselineRef.current = next.length;
      }
    }
    rawSetMessages(next);
  }, [interruptionCorrectionTracker]);
  // Capture the baseline message count alongside the placeholder text so
  // the render can hide it once displayedMessages grows past the baseline.
  const setUserInputOnProcessing = useCallback((input: string | undefined) => {
    if (input !== undefined) {
      userInputBaselineRef.current = messagesRef.current.length;
      userMessagePendingRef.current = true;
    } else {
      userMessagePendingRef.current = false;
    }
    setUserInputOnProcessingRaw(input);
  }, []);
  const syncToolResultReplacements = useCallback((replacements: ReadonlyMap<string, string>) => {
    if (replacements.size === 0) return;
    setMessages(current => applyToolResultReplacementsToMessages(current, replacements));
  }, [setMessages]);
  // Fullscreen: track the unseen-divider position. dividerIndex changes
  // only ~twice/scroll-session (first scroll-away + repin). pillVisible
  // and stickyPrompt now live in FullscreenLayout — they subscribe to
  // ScrollBox directly so per-frame scroll never re-renders REPL.
  const {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider
  } = useUnseenDivider(messages.length);
  if (feature('AWAY_SUMMARY')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useAwaySummary(messages, setMessages, isLoading);
  }
  const [cursor, setCursor] = useState<MessageActionsState | null>(null);
  const cursorNavRef = useRef<MessageActionsNav | null>(null);
  // Memoized so Messages' React.memo holds.
  const unseenDivider = useMemo(() => computeUnseenDivider(messages, dividerIndex),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- length change covers appends; useUnseenDivider's count-drop guard clears dividerIndex on replace/rewind
    [dividerIndex, messages.length]);
  // Re-pin scroll to bottom and clear the unseen-messages baseline. Called
  // on any user-driven return-to-live action (submit, type-into-empty,
  // overlay appear/dismiss).
  const repinScroll = useCallback(() => {
    scrollRef.current?.scrollToBottom();
    onRepin();
    setCursor(null);
  }, [onRepin, setCursor]);
  // Backstop for the submit-handler repin at onSubmit. If a buffered stdin
  // event (wheel/drag) races between handler-fire and state-commit, the
  // handler's scrollToBottom can be undone. This effect fires on the render
  // where the user's message actually lands — tied to React's commit cycle,
  // so it can't race with stdin. Keyed on lastMsg identity (not messages.length)
  // so useAssistantHistory's prepends don't spuriously repin.
  const lastMsg = messages.at(-1);
  const lastMsgIsHuman = lastMsg != null && isHumanTurn(lastMsg);
  useEffect(() => {
    if (lastMsgIsHuman) {
      repinScroll();
    }
  }, [lastMsgIsHuman, lastMsg, repinScroll]);
  // Assistant-chat: lazy-load remote history on scroll-up. No-op unless
  // KAIROS build + config.viewerOnly. feature() is build-time constant so
  // the branch is dead-code-eliminated in non-KAIROS builds (same pattern
  // as useUnseenDivider above).
  const {
    maybeLoadOlder
  } = feature('KAIROS') ?
      // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useAssistantHistory({
        config: remoteSessionConfig,
        setMessages,
        scrollRef,
        onPrepend: shiftDivider
      }) : HISTORY_STUB;
  // Compose useUnseenDivider's callbacks with the lazy-load trigger.
  const composedOnScroll = useCallback((sticky: boolean, handle: ScrollBoxHandle) => {
    lastUserScrollTsRef.current = Date.now();
    if (sticky) {
      onRepin();
    } else {
      onScrollAway(handle);
      if (feature('KAIROS')) maybeLoadOlder(handle);
      // Dismiss the companion bubble on scroll — it's absolute-positioned
      // at bottom-right and covers transcript content. Scrolling = user is
      // trying to read something under it.
      if (isBuddyEnabled()) {
        setAppState(prev => prev.companionReaction === undefined ? prev : {
          ...prev,
          companionReaction: undefined
        });
      }
    }
  }, [onRepin, onScrollAway, maybeLoadOlder, setAppState]);
  // Deferred SessionStart hook messages — REPL renders immediately and
  // hook messages are injected when they resolve. awaitPendingHooks()
  // must be called before the first API call so the model sees hook context.
  const awaitPendingHooks = useDeferredHookMessages(pendingHookMessages, setMessages);

  // Deferred messages for the Messages component — renders at transition
  // priority so the reconciler yields every 5ms, keeping input responsive
  // while the expensive message processing pipeline runs.
  const deferredMessages = useDeferredValue(messages);
  const deferredBehind = messages.length - deferredMessages.length;
  if (deferredBehind > 0) {
    logForDebugging(`[useDeferredValue] Messages deferred by ${deferredBehind} (${deferredMessages.length}→${messages.length})`);
  }

  // Frozen state for transcript mode - stores lengths instead of cloning arrays for memory efficiency
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number;
    streamingToolUsesLength: number;
  } | null>(null);
  // Initialize input with any early input that was captured before REPL was ready.
  // Using lazy initialization ensures cursor offset is set correctly in PromptInput.
  const [inputValue, setInputValueRaw] = useState(() => consumeEarlyInput());
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const promptTypingSuppressionActive = isPromptTypingSuppressionActive(isPromptInputActive, inputValue);
  const insertTextRef = useRef<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>(null);

  // Wrap setInputValue to co-locate suppression state updates.
  // Both setState calls happen in the same synchronous context so React
  // batches them into a single render, eliminating the extra render that
  // the previous useEffect → setState pattern caused.
  const setInputValue = useCallback((value: string) => {
    if (trySuggestBgPRIntercept(inputValueRef.current, value)) return;
    // In fullscreen mode, typing into an empty prompt re-pins scroll to
    // bottom. Only fires on empty→non-empty so scrolling up to reference
    // something while composing a message doesn't yank the view back on
    // every keystroke. Restores the pre-fullscreen muscle memory of
    // typing to snap back to the end of the conversation.
    // Skipped if the user scrolled within the last 3s — they're actively
    // reading, not lost. lastUserScrollTsRef starts at 0 so the first-
    // ever keypress (no scroll yet) always repins.
    if (inputValueRef.current === '' && value !== '' && Date.now() - lastUserScrollTsRef.current >= RECENT_SCROLL_REPIN_WINDOW_MS) {
      repinScroll();
    }
    // Sync ref immediately (like setMessages) so callers that read
    // inputValueRef before React commits — e.g. the auto-restore finally
    // block's `=== ''` guard — see the fresh value, not the stale render.
    inputValueRef.current = value;
    setInputValueRaw(value);
    setIsPromptInputActive(value.trim().length > 0);
  }, [setIsPromptInputActive, repinScroll, trySuggestBgPRIntercept]);

  // Schedule a timeout to stop suppressing dialogs after the user stops typing.
  // Only manages the timeout — the immediate activation is handled by setInputValue above.
  useEffect(() => {
    if (inputValue.trim().length === 0) return;
    const timer = setTimeout(setIsPromptInputActive, PROMPT_SUPPRESSION_MS, false);
    return () => clearTimeout(timer);
  }, [inputValue]);
  const [inputMode, setInputMode] = useState<PromptInputMode>('prompt');
  const [stashedPrompt, setStashedPrompt] = useState<{
    text: string;
    cursorOffset: number;
    pastedContents: Record<number, PastedContent>;
  } | undefined>();

  // Callback to filter commands based on CCR's available slash commands
  const handleRemoteInit = useCallback((remoteSlashCommands: string[]) => {
    const remoteCommandSet = new Set(remoteSlashCommands);
    // Keep commands that CCR lists OR that are in the local-safe set
    setLocalCommands(prev => prev.filter(cmd => remoteCommandSet.has(cmd.name) || REMOTE_SAFE_COMMANDS.has(cmd)));
  }, [setLocalCommands]);
  const [inProgressToolUseIDs, setInProgressToolUseIDs] = useState<Set<string>>(new Set());
  const hasInterruptibleToolInProgressRef = useRef(false);
  const queryLifecycleTrackerRef = useRef(new QueryLifecycleOperationTracker());

  // Remote session hook - manages WebSocket connection and message handling for --remote mode
  const remoteSession = useRemoteSession({
    config: remoteSessionConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    onInit: handleRemoteInit,
    setToolUseConfirmQueue,
    tools: combinedInitialTools,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs
  });

  // Direct connect hook - manages WebSocket to a claude server for `claude connect` mode
  const directConnect = useDirectConnect({
    config: directConnectConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools
  });

  // SSH session hook - manages ssh child process for `claude ssh` mode.
  // Same callback shape as useDirectConnect; only the transport under the
  // hood differs (ChildProcess stdin/stdout vs WebSocket).
  const sshRemote = useSSHSession({
    session: sshSession,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools
  });

  // Use whichever remote mode is active
  const activeRemote = sshRemote.isRemoteMode ? sshRemote : directConnect.isRemoteMode ? directConnect : remoteSession;
  const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({});
  const [submitCount, setSubmitCount] = useState(0);

  // Defer startup checks until the user has submitted their first message.
  // A timeout or grace period is insufficient (issue #363): if the user pauses
  // before typing, startup checks can still fire and recommendation dialogs
  // steal focus. Only the user's first submission guarantees the prompt was
  // the first thing they interacted with.
  const startupChecksStartedRef = React.useRef(false);
  const hasHadFirstSubmission = (submitCount ?? 0) > 0;
  useEffect(() => {
    if (isRemoteSession) return;
    if (startupChecksStartedRef.current) return;
    if (!shouldRunStartupChecks({
      isRemoteSession,
      hasStarted: startupChecksStartedRef.current,
      hasHadFirstSubmission,
    })) return;
    startupChecksStartedRef.current = true;
    void performStartupChecks(setAppState);
  }, [setAppState, isRemoteSession, hasHadFirstSubmission]);
  const reducedMotion = useAppState(s => s.settings.prefersReducedMotion) ?? false;
  // Ref instead of state to avoid triggering React re-renders on every
  // streaming text_delta. In reduced-motion mode we publish an initial update
  // and then throttle subsequent token-display refreshes.
  const responseLengthRef = useRef(0);
  const [reducedMotionResponseLength, setReducedMotionResponseLength] = useState(0);
  const reducedMotionRef = useRef(reducedMotion);
  const reducedMotionResponseLengthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    if (reducedMotion) {
      setReducedMotionResponseLength(responseLengthRef.current);
    }
  }, [reducedMotion]);
  useEffect(() => () => {
    if (reducedMotionResponseLengthTimerRef.current) {
      clearTimeout(reducedMotionResponseLengthTimerRef.current);
    }
  }, []);
  const setResponseLength = useCallback((f: (prev: number) => number) => {
    const next = f(responseLengthRef.current);
    responseLengthRef.current = next;
    if (!reducedMotionRef.current || reducedMotionResponseLengthTimerRef.current) return;
    setReducedMotionResponseLength(next);
    reducedMotionResponseLengthTimerRef.current = setTimeout(() => {
      reducedMotionResponseLengthTimerRef.current = null;
      setReducedMotionResponseLength(responseLengthRef.current);
    }, 200);
  }, []);

  // Streaming text display. streamingTextRef holds the full accumulated text
  // (eager, per delta); streamingText state is only published when the visible
  // (newline-truncated) preview actually changes. The Ink root is a LegacyRoot,
  // so every setState from a stream event commits a synchronous REPL render —
  // and because the preview hides the in-progress trailing line, deltas between
  // newlines never change anything on screen. Publishing only on newline (and
  // on clear) drops those no-op renders entirely under fast streams
  // (100-300 deltas/sec) while keeping the displayed text byte-identical.
  // Cleared on message arrival (messages.ts) so displayedMessages switches from
  // deferredMessages to messages atomically.
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const streamingTextRef = useRef<string | null>(null);
  const lastFlushedStreamingVisibleRef = useRef<string | null>(null);
  const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug();
  const onStreamingText = useCallback((f: (current: string | null) => string | null) => {
    // decideStreamingTextUpdate keeps the ref current even when the live preview
    // is disabled (reduced-motion / cursor-up yank bug) — the Esc handler
    // recovers partial assistant output from it — and publishes to state only
    // when the newline-truncated visible preview changes.
    const decision = decideStreamingTextUpdate(
      streamingTextRef.current,
      f,
      showStreamingText,
      lastFlushedStreamingVisibleRef.current,
    );
    streamingTextRef.current = decision.nextText;
    if (decision.publish) {
      lastFlushedStreamingVisibleRef.current = decision.nextVisible;
      setStreamingText(decision.nextText);
    }
  }, [showStreamingText]);

  // Hide the in-progress source line so text streams line-by-line, not
  // char-by-char. lastIndexOf returns -1 when no newline, giving '' → null.
  // Guard on showStreamingText so toggling reducedMotion mid-stream
  // immediately hides the streaming preview.
  const visibleStreamingText = streamingText && showStreamingText ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null : null;
  const [lastQueryCompletionTime, setLastQueryCompletionTime] = useState(0);
  const [spinnerMessage, setSpinnerMessage] = useState<string | null>(null);
  const [spinnerColor, setSpinnerColor] = useState<keyof Theme | null>(null);
  const [spinnerShimmerColor, setSpinnerShimmerColor] = useState<keyof Theme | null>(null);
  const [compactProgressRatio, setCompactProgressRatio] = useState<number | null>(null);
  const [resumeCompactPending, setResumeCompactPending] = useState<{
    tokenCount: number;
    model: string;
    messages: MessageType[];
  } | null>(null);
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] = useState(false);
  const [messageSelectorPreselect, setMessageSelectorPreselect] = useState<UserMessage | undefined>(undefined);
  const [showCostDialog, setShowCostDialog] = useState(false);
  const [conversationId, setConversationId] = useState(randomUUID());

  // Idle-return dialog: shown when user submits after a long idle gap
  const [idleReturnPending, setIdleReturnPending] = useState<{
    input: string;
    idleMinutes: number;
  } | null>(null);
  const skipIdleCheckRef = useRef(false);
  const lastQueryCompletionTimeRef = useRef(lastQueryCompletionTime);
  lastQueryCompletionTimeRef.current = lastQueryCompletionTime;

  // Aggregate tool result budget: per-conversation decision tracking.
  // When the GrowthBook flag is on, query.ts enforces the budget; when
  // off (undefined), enforcement is skipped entirely. Stale entries after
  // /clear, rewind, or compact are harmless (tool_use_ids are UUIDs, stale
  // keys are never looked up). Memory is bounded by total replacement count
  // × ~2KB preview over the REPL lifetime — negligible.
  //
  // Lazy init via useState initializer — useRef(expr) evaluates expr on every
  // render (React ignores it after first, but the computation still runs).
  // For large resumed sessions, reconstruction does O(messages × blocks)
  // work; we only want that once.
  const [contentReplacementStateRef] = useState(() => ({
    current: provisionContentReplacementState(initialMessages, initialContentReplacements)
  }));
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(getGlobalConfig().hasAcknowledgedCostThreshold);
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // showBashesDialog is REPL-level so it survives PromptInput unmounting.
  // When ultraplan approval fires while the pill dialog is open, PromptInput
  // unmounts (focusedInputDialog → 'ultraplan-choice') but this stays true;
  // after accepting, PromptInput remounts into an empty "No tasks" dialog
  // (the completed ultraplan task has been filtered out). Close it here.
  useEffect(() => {
    if (ultraplanPendingChoice && showBashesDialog) {
      setShowBashesDialog(false);
    }
  }, [ultraplanPendingChoice, showBashesDialog]);
  const isTerminalFocused = useTerminalFocus();
  const terminalFocusRef = useRef(isTerminalFocused);
  terminalFocusRef.current = isTerminalFocused;
  const [theme] = useTheme();

  // resetLoadingState runs twice per turn (onQueryImpl tail + onQuery finally).
  // Without this guard, both calls pick a tip → two recordShownTip → two
  // saveGlobalConfig writes back-to-back. Reset at submit in onSubmit.
  const tipPickedThisTurnRef = React.useRef(false);
  const pickNewSpinnerTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) return;
    tipPickedThisTurnRef.current = true;
    const newMessages = messagesRef.current.slice(bashToolsProcessedIdx.current);
    for (const tool of extractBashToolsFromMessages(newMessages)) {
      bashTools.current.add(tool);
    }
    bashToolsProcessedIdx.current = messagesRef.current.length;
    // The viewer's latest prompt — used only by the opt-in earning tip for
    // contextual ad matching (sanitized + sent only when sponsored tips are on).
    const lastUserMsg = messagesRef.current.findLast(selectableUserMessagesFilter);
    const latestUserMessage = lastUserMsg
      ? getContentText(lastUserMsg.message.content) ?? undefined
      : undefined;
    const tipCtx = {
      theme,
      readFileState: readFileState.current,
      bashTools: bashTools.current,
      latestUserMessage
    };
    void getTipToShowOnSpinner(tipCtx).then(async tip => {
      if (tip) {
        const content = await tip.content(tipCtx);
        setAppState(prev => ({
          ...prev,
          spinnerTip: content
        }));
        recordShownTip(tip);
      } else {
        setAppState(prev => {
          if (prev.spinnerTip === undefined) return prev;
          return {
            ...prev,
            spinnerTip: undefined
          };
        });
      }
    });
  }, [setAppState, theme]);

  // Resets UI loading state. Does NOT call onTurnComplete - that should be
  // called explicitly only when a query turn actually completes.
  const resetLoadingState = useCallback(() => {
    // isLoading is now derived from queryGuard — no setter call needed.
    // queryGuard.end() (onQuery finally) or cancelReservation() (executeUserInput
    // finally) have already transitioned the guard to idle by the time this runs.
    // External loading (remote/backgrounding) is reset separately by those hooks.
    setIsExternalLoading(false);
    setUserInputOnProcessing(undefined);
    // Clear any in-flight compaction progress so an aborted/errored compaction
    // does not leave the progress bar rendered in the idle UI.
    setCompactProgressRatio(null);
    responseLengthRef.current = 0;
    setReducedMotionResponseLength(0);
    if (reducedMotionResponseLengthTimerRef.current) {
      clearTimeout(reducedMotionResponseLengthTimerRef.current);
      reducedMotionResponseLengthTimerRef.current = null;
    }
    streamingTextRef.current = null;
    lastFlushedStreamingVisibleRef.current = null;
    setStreamingText(null);
    setStreamingToolUses([]);
    setSpinnerMessage(null);
    setSpinnerColor(null);
    setSpinnerShimmerColor(null);
    pickNewSpinnerTip();
        // Speculative bash classifier checks are only valid for the current
    // turn's commands — clear after each turn to avoid accumulating
    // Promise chains for unconsumed checks (denied/aborted paths).
    clearSpeculativeChecks();
  }, [pickNewSpinnerTip]);

  // Session backgrounding — hook is below, after getToolUseContext

  const hasRunningTeammates = useMemo(() => getAllInProcessTeammateTasks(tasks).some(t => t.status === 'running'), [tasks]);

  // Show deferred turn duration message once all swarm teammates finish
  useEffect(() => {
    if (!hasRunningTeammates && swarmStartTimeRef.current !== null) {
      const totalMs = Date.now() - swarmStartTimeRef.current;
      const deferredBudget = swarmBudgetInfoRef.current;
      swarmStartTimeRef.current = null;
      swarmBudgetInfoRef.current = undefined;
      setMessages(prev => [...prev, createTurnDurationMessage(totalMs, deferredBudget,
        // Count only what recordTranscript will persist — ephemeral
        // progress ticks and non-ant attachments are filtered by
        // isLoggableMessage and never reach disk. Using raw prev.length
        // would make checkResumeConsistency report false delta<0 for
        // every turn that ran a progress-emitting tool.
        count(prev, isLoggableMessage))]);
    }
  }, [hasRunningTeammates, setMessages]);

  // Show auto permissions warning when entering auto mode
  // (either via Shift+Tab toggle or on startup). Debounced to avoid
  // flashing when the user is cycling through modes quickly.
  // Only shown 3 times total across sessions.
  const safeYoloMessageShownRef = useRef(false);
  useEffect(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (toolPermissionContext.mode !== 'auto') {
        safeYoloMessageShownRef.current = false;
        return;
      }
      if (safeYoloMessageShownRef.current) return;
      const config = getGlobalConfig();
      const count = config.autoPermissionsNotificationCount ?? 0;
      if (count >= 3) return;
      const timer = setTimeout((ref, setMessages) => {
        ref.current = true;
        // Loss-tolerant notification counter — coalesce the write so it can't
        // contend on the config lock with other writers.
        saveGlobalConfigDeferred(prev => {
          const prevCount = prev.autoPermissionsNotificationCount ?? 0;
          if (prevCount >= 3) return prev;
          return {
            ...prev,
            autoPermissionsNotificationCount: prevCount + 1
          };
        });
        setMessages(prev => [...prev, createSystemMessage(AUTO_MODE_DESCRIPTION, 'warning')]);
      }, 800, safeYoloMessageShownRef, setMessages);
      return () => clearTimeout(timer);
    }
  }, [toolPermissionContext.mode, setMessages]);

  // If worktree creation was slow and sparse-checkout isn't configured,
  // nudge the user toward settings.worktree.sparsePaths.
  const worktreeTipShownRef = useRef(false);
  useEffect(() => {
    if (worktreeTipShownRef.current) return;
    const wt = getCurrentWorktreeSession();
    if (!wt?.creationDurationMs || wt.usedSparsePaths) return;
    if (wt.creationDurationMs < 15_000) return;
    worktreeTipShownRef.current = true;
    const secs = Math.round(wt.creationDurationMs / 1000);
    setMessages(prev => [...prev, createSystemMessage(`Worktree creation took ${secs}s. For large repos, set \`worktree.sparsePaths\` in .openclaude/settings.json to check out only the directories you need — e.g. \`{"worktree": {"sparsePaths": ["src", "packages/foo"]}}\`.`, 'info')]);
  }, [setMessages]);

  // Hide spinner when the only in-progress tool is Sleep
  const onlySleepToolActive = useMemo(() => {
    const lastAssistant = messages.findLast(m => m.type === 'assistant');
    if (lastAssistant?.type !== 'assistant') return false;
    const inProgressToolUses = lastAssistant.message.content.filter(b => b.type === 'tool_use' && inProgressToolUseIDs.has(b.id));
    return inProgressToolUses.length > 0 && inProgressToolUses.every(b => b.type === 'tool_use' && b.name === SLEEP_TOOL_NAME);
  }, [messages, inProgressToolUseIDs]);
  // Surface the currently-executing tool in the spinner so long-running tools
  // (subagents, typecheck, installs) don't look frozen during the elapsed
  // crunch. Reuses the spinnerSuffix channel; stop-hook progress takes
  // precedence when both apply (stop hooks run after the turn's tools).
  const activeToolSpinnerSuffix = useMemo(() => {
    if (!isLoading || inProgressToolUseIDs.size === 0) return null;
    const lastAssistant = messages.findLast(m => m.type === 'assistant');
    if (lastAssistant?.type !== 'assistant') return null;
    const active = lastAssistant.message.content.filter(b => b.type === 'tool_use' && inProgressToolUseIDs.has(b.id));
    const first = active[0];
    if (!first || first.type !== 'tool_use') return null;
    return active.length > 1 ? `${first.name} +${active.length - 1}` : first.name;
  }, [messages, inProgressToolUseIDs, isLoading]);
  const mrOnBeforeQuery = useCallback(async (_input: string, _allMessages: MessageType[], _newMessageCount: number) => true, []);
  const mrOnTurnComplete = useCallback(async (_allMessages: MessageType[], _aborted: boolean) => { }, []);
  const mrRender = useCallback(() => null, []);
  const abortTimedOutQuery = useCallback((timeout: QueryGuardTimeoutInfo) => {
    const timeoutOperations = summarizeActiveOperations(timeout.activeOperations);
    const timeoutAbortReason = timeout.context.terminalReason ?? 'query-timeout';
    logQueryLifecycle('timeout', timeout.context, timeoutOperations);
    const activeAbortController = abortControllerRef.current;
    if (activeAbortController && !activeAbortController.signal.aborted) {
      logQueryLifecycle('abort_requested', timeout.context, formatQueryLifecycleAbortSignalReason(timeoutAbortReason));
      requestAbort(activeAbortController, timeoutAbortReason, {
        source: 'query_guard',
        causalEventId: timeout.causalEventId,
        subsystem: 'repl',
        phase: 'timeout',
        queryId: timeout.context.queryId,
        queryGeneration: timeout.generation,
        querySource: timeout.context.querySource,
        controllerRole: 'query-root',
        elapsedQueryMs: timeout.elapsedMs,
        activeApiCallCount: timeout.activeOperations.apiCalls.length,
        activeToolUseCount: timeout.activeOperations.toolUses.length,
      });
      flushInterruptionTrace('query_guard_timeout');
    }
    if (timeout.activeOperations.apiCalls.length > 0) {
      logForDebugging(`api.call.active_on_abort queryId=${timeout.context.queryId} generation=${timeout.generation} ${timeoutOperations}`);
    }
    if (feature('TOKEN_BUDGET')) {
      snapshotOutputTokensForTurn(null);
    }

    // QueryGuard calls this before forceEnd(); defer UI cleanup until after
    // the guard has released so the normal stale-generation finally path skips.
    queueMicrotask(() => {
      logQueryLifecycle('abort_acknowledged', timeout.context, formatQueryLifecycleAbortSignalReason(timeoutAbortReason));
      resetLoadingState();
      setAbortController(null);
      void mrOnTurnComplete(messagesRef.current, true);
    });
  }, [mrOnTurnComplete, resetLoadingState]);

  useEffect(() => {
    return queryGuard.setTimeoutHandler(abortTimedOutQuery);
  }, [abortTimedOutQuery, queryGuard]);

  const showSpinner = (!toolJSX || toolJSX.showSpinner === true) && activeToolUseConfirmQueue.length === 0 && promptQueue.length === 0 && (
    // Show spinner during input processing, API call, while teammates are running,
    // or while pending task notifications are queued (prevents spinner bounce between consecutive notifications)
    isLoading || userInputOnProcessing || hasRunningTeammates ||
    // Keep spinner visible while task notifications are queued for processing.
    // Without this, the spinner briefly disappears between consecutive notifications
    // (e.g., multiple background agents completing in rapid succession) because
    // isLoading goes false momentarily between processing each one.
    getCommandQueueLength() > 0) &&
    // Hide spinner when waiting for leader to approve permission request
    !pendingWorkerRequest && !onlySleepToolActive && (
      // Hide spinner when streaming text is visible (the text IS the feedback),
      // but keep it when isBriefOnly suppresses the streaming text display
      !visibleStreamingText || isBriefOnly);

  // Check if any permission or ask question prompt is currently visible
  // This is used to prevent the survey from opening while prompts are active
  const hasActivePrompt = activeToolUseConfirmQueue.length > 0 || promptQueue.length > 0 || sandboxPermissionRequestQueue.length > 0 || elicitation.queue.length > 0 || workerSandboxPermissions.queue.length > 0;
  const feedbackSurveyOriginal = useFeedbackSurvey(messages, isLoading, submitCount, 'session', hasActivePrompt);
  const showIssueFlagBanner = useIssueFlagBanner(messages, submitCount);

  // Wrap feedback survey handler to trigger auto-run /issue
  const feedbackSurvey = useMemo(() => ({
    ...feedbackSurveyOriginal,
    handleSelect: (selected: 'dismissed' | 'bad' | 'fine' | 'good') => {
      // Reset the ref when a new survey response comes in
      didAutoRunIssueRef.current = false;
      const showedTranscriptPrompt = feedbackSurveyOriginal.handleSelect(selected);
      // Auto-run /issue for "bad" if transcript prompt wasn't shown
      if (selected === 'bad' && !showedTranscriptPrompt && shouldAutoRunIssue('feedback_survey_bad')) {
        setAutoRunIssueReason('feedback_survey_bad');
        didAutoRunIssueRef.current = true;
      }
    }
  }), [feedbackSurveyOriginal]);

  // Post-compact survey: shown after compaction if feature gate is enabled
  const postCompactSurvey = usePostCompactSurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession
  });

  // Memory survey: shown when the assistant mentions memory and a memory file
  // was read this conversation
  const memorySurvey = useMemorySurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession
  });

  const frustrationDetection = useMemo(() => ({
    state: 'closed' as const,
    handleTranscriptSelect: () => { }
  }), []);

  // Initialize IDE integration
  useIDEIntegration({
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState: setIDEInstallationStatus
  });
  useFileHistorySnapshotInit(initialFileHistorySnapshots, fileHistory, fileHistoryState => setAppState(prev => ({
    ...prev,
    fileHistory: fileHistoryState
  })));
  const resume = useCallback(async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
    const resumeStart = performance.now();
    try {
      resetAutoCompactTracking();
      // Deserialize messages to properly clean up the conversation
      // This filters unresolved tool uses and adds a synthetic assistant message if needed
      const messages = deserializeMessages(log.messages);

      // Match coordinator/normal mode to the resumed session
      if (feature('COORDINATOR_MODE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const coordinatorModule = require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const warning = coordinatorModule.matchSessionMode(log.mode);
        if (warning) {
          // Re-derive agent definitions after mode switch so built-in agents
          // reflect the new coordinator/normal mode
          /* eslint-disable @typescript-eslint/no-require-imports */
          const {
            getAgentDefinitionsWithOverrides,
            getActiveAgentsFromList
          } = require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js');
          /* eslint-enable @typescript-eslint/no-require-imports */
          getAgentDefinitionsWithOverrides.cache.clear?.();
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(getOriginalCwd());
          setAppState(prev => ({
            ...prev,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents)
            }
          }));
          messages.push(createSystemMessage(warning, 'warning'));
        }
      }

      // Fire SessionEnd hooks for the current session before starting the
      // resumed one, mirroring the /clear flow in conversation.ts.
      const sessionEndTimeoutMs = getSessionEndHookTimeoutMs();
      const { signal, cleanup } = createCombinedAbortSignal(undefined, {
        timeoutMs: sessionEndTimeoutMs,
      });
      try {
        await executeSessionEndHooks('resume', {
          getAppState: () => store.getState(),
          setAppState,
          signal,
          timeoutMs: sessionEndTimeoutMs
        });
      } finally {
        cleanup();
      }

      // Process session start hooks for resume
      const hookMessages = await processSessionStartHooks('resume', {
        sessionId,
        agentType: mainThreadAgentDefinition?.agentType,
        model: mainLoopModel
      });

      // Append hook messages to the conversation
      messages.push(...hookMessages);
      // For forks, generate a new plan slug and copy the plan content so the
      // original and forked sessions don't clobber each other's plan files.
      // For regular resumes, reuse the original session's plan slug.
      if (entrypoint === 'fork') {
        void copyPlanForFork(log, asSessionId(sessionId));
      } else {
        void copyPlanForResume(log, asSessionId(sessionId));
      }

      // Restore file history and attribution state from the resumed conversation
      restoreSessionStateFromLog(log, setAppState);
      if (log.fileHistorySnapshots) {
        void copyFileHistoryForResume(log);
      }

      // Restore agent setting from the resumed conversation
      // Always reset to the new session's values (or clear if none),
      // matching the standaloneAgentContext pattern below
      const {
        agentDefinition: restoredAgent
      } = restoreAgentFromSession(log.agentSetting, initialMainThreadAgentDefinition, agentDefinitions);
      setMainThreadAgentDefinition(restoredAgent);
      setAppState(prev => ({
        ...prev,
        agent: restoredAgent?.agentType
      }));

      // Restore standalone agent context from the resumed conversation
      // Always reset to the new session's values (or clear if none)
      setAppState(prev => ({
        ...prev,
        standaloneAgentContext: computeStandaloneAgentContext(log.agentName, log.agentColor)
      }));
      void updateSessionName(log.agentName);

      // Restore read file state from the message history
      restoreReadFileState(messages, log.projectPath ?? getOriginalCwd());

      // Clear any active loading state (no queryId since we're not in a query)
      resetLoadingState();
      setAbortController(null);
      interruptionCorrectionTracker.handleSessionChange();
      setConversationId(sessionId);

      // Get target session's costs BEFORE saving current session
      // (saveCurrentSessionCosts overwrites the config, so we need to read first)
      const targetSessionCosts = getStoredSessionCosts(sessionId);

      // Save current session's costs before switching to avoid losing accumulated costs
      saveCurrentSessionCosts();

      // Reset cost state for clean slate before restoring target session
      resetCostState();

      // Switch session (id + project dir atomically). fullPath may point to
      // a different project (cross-worktree, /branch); null derives from
      // current originalCwd.
      switchSession(asSessionId(sessionId), log.fullPath ? dirname(log.fullPath) : null);
      // Rename asciicast recording to match the resumed session ID
      const {
        renameRecordingForSession
      } = await import('../utils/asciicast.js');
      await renameRecordingForSession();
      await resetSessionFilePointer();

      // Clear then restore session metadata so it's re-appended on exit via
      // reAppendSessionMetadata. clearSessionMetadata must be called first:
      // restoreSessionMetadata only sets-if-truthy, so without the clear,
      // a session without an agent name would inherit the previous session's
      // cached name and write it to the wrong transcript on first message.
      clearSessionMetadata();
      restoreSessionMetadata(log);
      // Resumed sessions shouldn't re-title from mid-conversation context
      // (same reasoning as the useRef seed), and the previous session's
      // Haiku title shouldn't carry over.
      haikuTitleAttemptedRef.current = true;
      setHaikuTitle(undefined);

      // Exit any worktree a prior /resume entered, then cd into the one
      // this session was in. Without the exit, resuming from worktree B
      // to non-worktree C leaves cwd/currentWorktreeSession stale;
      // resuming B→C where C is also a worktree fails entirely
      // (getCurrentWorktreeSession guard blocks the switch).
      //
      // Skipped for /branch: forkLog doesn't carry worktreeSession, so
      // this would kick the user out of a worktree they're still working
      // in. Same fork skip as processResumedConversation for the adopt —
      // fork materializes its own file via recordTranscript on REPL mount.
      if (entrypoint !== 'fork') {
        exitRestoredWorktree();
        restoreWorktreeForResume(log.worktreeSession);
        adoptResumedSessionFile();
        void restoreRemoteAgentTasks({
          abortController: new AbortController(),
          getAppState: () => store.getState(),
          setAppState
        });
      } else {
        // Fork: same re-persist as /clear (conversation.ts). The clear
        // above wiped currentSessionWorktree, forkLog doesn't carry it,
        // and the process is still in the same worktree.
        const ws = getCurrentWorktreeSession();
        if (ws) saveWorktreeState(ws);
      }

      // Persist the current mode so future resumes know what mode this session was in
      if (feature('COORDINATOR_MODE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const {
          saveMode
        } = require('../utils/sessionStorage.js');
        const {
          isCoordinatorMode
        } = require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        saveMode(isCoordinatorMode() ? 'coordinator' : 'normal');
      }

      // Restore target session's costs from the data we read earlier
      if (targetSessionCosts) {
        setCostStateForRestore(targetSessionCosts);
      }

      // Reconstruct replacement state for the resumed session. Runs after
      // setSessionId so any NEW replacements post-resume write to the
      // resumed session's tool-results dir. Gated on ref.current: the
      // initial mount already read the feature flag, so we don't re-read
      // it here (mid-session flag flips stay unobservable in both
      // directions).
      //
      // Skipped for in-session /branch: the existing ref is already correct
      // (branch preserves tool_use_ids), so there's no need to reconstruct.
      // createFork() does write content-replacement entries to the forked
      // JSONL with the fork's sessionId, so `claude -r {forkId}` also works.
      if (contentReplacementStateRef.current && entrypoint !== 'fork') {
        contentReplacementStateRef.current = reconstructContentReplacementState(messages, log.contentReplacements ?? []);
      }
      const hydratedMessages = contentReplacementStateRef.current ? applyToolResultReplacementsToMessages(messages, contentReplacementStateRef.current.replacements) : messages;

      // Reset messages to the provided initial messages
      // Use a callback to ensure we're not dependent on stale state
      setMessages(() => hydratedMessages);

      // Clear any active tool JSX
      setToolJSX(null);

      // Clear input to ensure no residual state
      setInputValue('');

      // Prompt to compact if the resumed session is large
      if (feature('RESUME_COMPACT_PROMPT')) {
        const { shouldPromptCompactOnResume } = await import('../services/compact/resumeCompactPrompt.js');
        if (shouldPromptCompactOnResume(hydratedMessages, mainLoopModel, false)) {
          const tokenCount = (await import('../utils/tokens.js')).tokenCountWithEstimation(hydratedMessages);
          setResumeCompactPending({ tokenCount, model: mainLoopModel, messages: hydratedMessages });
        }
      }

      logEvent('tengu_session_resumed', {
        entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart)
      });
    } catch (error) {
      logEvent('tengu_session_resumed', {
        entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: false
      });
      throw error;
    }
  }, [resetLoadingState, resetAutoCompactTracking, setAppState]);

  // Lazy init: useRef(createX()) would call createX on every render and
  // discard the result. LRUCache construction inside FileStateCache is
  // expensive (~170ms), so we use useState's lazy initializer to create
  // it exactly once, then feed that stable reference into useRef.
  const [initialReadFileState] = useState(() => {
    const cache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    registerPrunableCache(cache)
    return cache
  });
  const readFileState = useRef(initialReadFileState);
  const bashTools = useRef(new Set<string>());
  const bashToolsProcessedIdx = useRef(0);
  // Session-scoped skill discovery tracking (feeds was_discovered on
  // tengu_skill_tool_invocation). Must persist across getToolUseContext
  // rebuilds within a session: turn-0 discovery writes via processUserInput
  // before onQuery builds its own context, and discovery on turn N must
  // still attribute a SkillTool call on turn N+k. Cleared in clearConversation.
  const discoveredSkillNamesRef = useRef(new Set<string>());
  // Session-level dedup for nested_memory CLAUDE.md attachments.
  // readFileState is a 100-entry LRU; once it evicts a CLAUDE.md path,
  // the next discovery cycle re-injects it. Cleared in clearConversation.
  const loadedNestedMemoryPathsRef = useRef(new Set<string>());

  // Helper to restore read file state from messages (used for resume flows)
  // This allows Claude to edit files that were read in previous sessions
  const restoreReadFileState = useCallback((messages: MessageType[], cwd: string) => {
    const extracted = extractReadFilesFromMessages(messages, cwd, READ_FILE_STATE_CACHE_SIZE);
    readFileState.current = mergeFileStateCaches(readFileState.current, extracted);
    for (const tool of extractBashToolsFromMessages(messages)) {
      bashTools.current.add(tool);
    }
  }, []);

  // Extract read file state from initialMessages on mount
  // This handles CLI flag resume (--resume-session) and ResumeConversation screen
  // where messages are passed as props rather than through the resume callback
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      restoreReadFileState(initialMessages, getOriginalCwd());
      void restoreRemoteAgentTasks({
        abortController: new AbortController(),
        getAppState: () => store.getState(),
        setAppState
      });
      // Startup resume paths (--continue, --resume <id>, ResumeConversation
      // screen) install initialMessages via the initial useState rather than
      // the resume() callback at line ~2024, so schedule the compact prompt
      // here too. Uses the already-hydrated `messages` state, which mirrors
      // the hydration applied in resume().
      if (feature('RESUME_COMPACT_PROMPT')) {
        void (async () => {
          const { shouldPromptCompactOnResume } = await import('../services/compact/resumeCompactPrompt.js');
          if (shouldPromptCompactOnResume(messages, mainLoopModel, false)) {
            const tokenCount = (await import('../utils/tokens.js')).tokenCountWithEstimation(messages);
            setResumeCompactPending({ tokenCount, model: mainLoopModel, messages });
          }
        })();
      }
    }
    // Only run on mount - initialMessages shouldn't change during component lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const {
    status: apiKeyStatus,
    reverify
  } = useApiKeyVerification();

  // Auto-run /issue state
  const [autoRunIssueReason, setAutoRunIssueReason] = useState<AutoRunIssueReason | null>(null);
  // Ref to track if autoRunIssue was triggered this survey cycle,
  // so we can suppress the [1] follow-up prompt even after
  // autoRunIssueReason is cleared.
  const didAutoRunIssueRef = useRef(false);

  // State for exit feedback flow
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null);
  const [isExiting, setIsExiting] = useState(false);

  // Calculate if cost dialog should be shown
  const showingCostDialog = !isLoading && showCostDialog;

  // Determine which dialog should have focus (if any)
  // Permission and interactive dialogs can show even when toolJSX is set,
  // as long as shouldContinueAnimation is true. This prevents deadlocks when
  // agents set background hints while waiting for user interaction.
  function getFocusedInputDialog(): 'message-selector' | 'sandbox-permission' | 'tool-permission' | 'prompt' | 'worker-sandbox-permission' | 'elicitation' | 'cost' | 'idle-return' | 'init-onboarding' | 'ide-onboarding' | 'effort-callout' | 'remote-callout' | 'lsp-recommendation' | 'plugin-hint' | 'desktop-upsell' | 'ultraplan-choice' | 'ultraplan-launch' | 'resume-compact' | undefined {
    // Exit states always take precedence
    if (isExiting || exitFlow) return undefined;

    // High priority dialogs (always show regardless of typing)
    if (isMessageSelectorVisible) return 'message-selector';

    // Resume compact prompt — shown after resuming a large session
    if (resumeCompactPending) return 'resume-compact';

    const allowDialogsWithAnimation = !toolJSX || !!toolJSX.shouldContinueAnimation;
    const criticalDialog = resolveCriticalInputDialog({
      sandboxPermissionPending: !!sandboxPermissionRequestQueue[0],
      toolUseConfirmPending: !!activeToolUseConfirmQueue[0],
      promptPending: !!promptQueue[0],
      workerSandboxPermissionPending: !!workerSandboxPermissions.queue[0],
      elicitationPending: !!elicitation.queue[0],
      showingCostDialog,
      allowDialogsWithAnimation,
    });
    if (criticalDialog) return criticalDialog;

    // Suppress lower-priority interrupt dialogs while user is actively typing
    if (promptTypingSuppressionActive) return undefined;
    if (allowDialogsWithAnimation && idleReturnPending) return 'idle-return';
    if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !isLoading && ultraplanPendingChoice) return 'ultraplan-choice';
    if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !isLoading && ultraplanLaunchPending) return 'ultraplan-launch';

    // Onboarding dialogs (special conditions)
    if (allowDialogsWithAnimation && showIdeOnboarding) return 'ide-onboarding';

    // Effort callout (shown once for recent Opus users when effort is enabled)
    if (allowDialogsWithAnimation && showEffortCallout) return 'effort-callout';

    // Remote callout (shown once before first bridge enable)
    if (allowDialogsWithAnimation && showRemoteCallout) return 'remote-callout';

    // LSP plugin recommendation (lowest priority - non-blocking suggestion)
    // Suppress during startup window to prevent stealing focus from the prompt (issue #363)
    if (allowDialogsWithAnimation && lspRecommendation && startupChecksStartedRef.current) return 'lsp-recommendation';

    // Plugin hint from CLI/SDK stderr (same priority band as LSP rec)
    if (allowDialogsWithAnimation && hintRecommendation && startupChecksStartedRef.current) return 'plugin-hint';

    // Desktop app upsell (max 3 launches, lowest priority)
    if (allowDialogsWithAnimation && showDesktopUpsellStartup && startupChecksStartedRef.current) return 'desktop-upsell';
    return undefined;
  }
  const focusedInputDialog = getFocusedInputDialog();

  // Keep ref in sync so timer callbacks can read the current value
  focusedInputDialogRef.current = focusedInputDialog;

  // Immediately capture pause/resume when focusedInputDialog changes
  // This ensures accurate timing even under high system load, rather than
  // relying on the 100ms polling interval to detect state changes
  useEffect(() => {
    if (!isLoading) return;
    const isPaused = focusedInputDialog === 'tool-permission';
    const now = Date.now();
    if (isPaused && pauseStartTimeRef.current === null) {
      // Just entered pause state - record the exact moment
      pauseStartTimeRef.current = now;
    } else if (!isPaused && pauseStartTimeRef.current !== null) {
      // Just exited pause state - accumulate paused time immediately
      totalPausedMsRef.current += now - pauseStartTimeRef.current;
      pauseStartTimeRef.current = null;
    }
  }, [focusedInputDialog, isLoading]);

  // Re-pin scroll to bottom whenever the permission overlay appears or
  // dismisses. Overlay now renders below messages inside the same
  // ScrollBox (no remount), so we need an explicit scrollToBottom for:
  //  - appear: user may have been scrolled up (sticky broken) — the
  //    dialog is blocking and must be visible
  //  - dismiss: user may have scrolled up to read context during the
  //    overlay, and onScroll was suppressed so the pill state is stale
  // useLayoutEffect so the re-pin commits before the Ink frame renders —
  // no 1-frame flash of the wrong scroll position.
  const prevDialogRef = useRef(focusedInputDialog);
  useLayoutEffect(() => {
    const was = prevDialogRef.current === 'tool-permission';
    const now = focusedInputDialog === 'tool-permission';
    if (was !== now) repinScroll();
    prevDialogRef.current = focusedInputDialog;
  }, [focusedInputDialog, repinScroll]);
  // Omitted means a programmatic edit/restore cancellation, which must not arm
  // correction context because those flows rewind the conversation themselves.
  function onCancel(
    isUserInitiated = false,
    cancelSource: CancelRequestSource | 'programmatic' = 'programmatic',
    causalEventId?: string,
  ) {
    if (focusedInputDialog === 'elicitation') {
      // Elicitation dialog handles its own Escape, and closing it shouldn't affect any loading state.
      return;
    }
    logForDebugging(`[onCancel] focusedInputDialog=${focusedInputDialog} streamMode=${streamMode}`);

    // Pause proactive mode so the user gets control back.
    // It will resume when they submit their next input (see onSubmit).
    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.pauseProactive();
    }
    const cancelContext = queryGuard.activeContext;
    interruptionCorrectionTracker.handleCancellation({
      isUserInitiated,
      isRemoteMode: activeRemote.isRemoteMode,
      hasQueuedNormalPrompt: getCommandQueue().some(
        isNormalLocalUserPrompt,
      ),
    });
    const cancelOperations = queryLifecycleTrackerRef.current.snapshot();
    const completedCancelContext = cancelContext ? {
      ...cancelContext,
      terminalReason: 'user-abort' as const,
      abortReason: 'user-cancel'
    } : null;
    if (cancelContext) {
      logQueryLifecycle('abort_requested', cancelContext, formatQueryLifecycleAbortSignalReason('user-cancel'));
    }
    queryGuard.forceEnd('user-abort', 'user-cancel');
    skipIdleCheckRef.current = false;

    // Preserve partially-streamed text so the user can read what was
    // generated before pressing Esc. Read the ref, not streamingText state:
    // state only holds up to the last published newline, while the ref has the
    // full text including the in-progress trailing line. Pushed before
    // resetLoadingState clears streamingText, and before query.ts yields the
    // async interrupt marker, giving final order
    // [user, partial-assistant, [Request interrupted by user]].
    const partialStreamedText = streamingTextRef.current;
    if (partialStreamedText?.trim()) {
      setMessages(prev => [...prev, createAssistantMessage({
        content: partialStreamedText
      })]);
    }
    resetLoadingState();

    // Clear any active token budget so the backstop doesn't fire on
    // a stale budget if the query generator hasn't exited yet.
    if (feature('TOKEN_BUDGET')) {
      snapshotOutputTokensForTurn(null);
    }
    if (focusedInputDialog === 'tool-permission') {
      // Each request owns a distinct waiter/controller. Settle every entry
      // removed by this parent-turn cancellation so background agents do not
      // remain blocked, while prompts owned by inactive sessions stay queued.
      abortPendingToolPermissionRequests(activeToolUseConfirmQueue, cancelSource, causalEventId, abortController);
      const activeEntries = new Set(activeToolUseConfirmQueue);
      setToolUseConfirmQueue(queue => queue.filter(item => !activeEntries.has(item)));
    } else if (focusedInputDialog === 'prompt') {
      // Reject all pending prompts and clear the queue
      for (const item of promptQueue) {
        item.reject(new Error('Prompt cancelled by user'));
      }
      setPromptQueue([]);
      if (abortController) {
        requestAbort(abortController, 'user-cancel', {
          source: cancelSource,
          causalEventId,
          subsystem: 'repl',
          controllerRole: 'query-root',
        });
      }
    } else if (activeRemote.isRemoteMode) {
      // Remote mode: send interrupt signal to CCR
      activeRemote.cancelRequest();
    } else {
      if (abortController) {
        requestAbort(abortController, 'user-cancel', {
          source: cancelSource,
          causalEventId,
          subsystem: 'repl',
          controllerRole: 'query-root',
        });
      }
    }
    if (cancelContext) {
      logQueryLifecycle('abort_acknowledged', cancelContext, formatQueryLifecycleAbortSignalReason('user-cancel'));
    }
    if (completedCancelContext) {
      const cancelOperationSummary = summarizeActiveOperations(cancelOperations);
      if (cancelOperations.apiCalls.length > 0) {
        logForDebugging(`api.call.active_on_abort queryId=${completedCancelContext.queryId} generation=${completedCancelContext.queryGeneration} ${cancelOperationSummary}`);
      }
      logQueryLifecycle('end', completedCancelContext, cancelOperationSummary);
    }

    // Clear the controller so subsequent Escape presses don't see a stale
    // aborted signal. Without this, canCancelRunningTask is false (signal
    // defined but .aborted === true), so isActive becomes false if no other
    // activating conditions hold — leaving the Escape keybinding inactive.
    setAbortController(null);

    // forceEnd() skips the finally path — fire directly (aborted=true).
    void mrOnTurnComplete(messagesRef.current, true);
  }

  // Function to handle queued command when canceling a permission request
  const handleQueuedCommandOnCancel = useCallback(() => {
    const result = popAllEditable(inputValue, 0);
    if (!result) return;
    setInputValue(result.text);
    setInputMode('prompt');

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
  }, [setInputValue, setInputMode, inputValue, setPastedContents]);

  // CancelRequestHandler props - rendered inside KeybindingSetup
  const cancelRequestProps = {
    onCancel: (source, causalEventId) => onCancel(true, source, causalEventId),
    onAgentsKilled: () => setMessages(prev => [...prev, createAgentsKilledMessage()]),
    isMessageSelectorVisible: isMessageSelectorVisible || !!showBashesDialog,
    screen,
    abortSignal: abortController?.signal,
    popCommandFromQueue: handleQueuedCommandOnCancel,
    vimMode,
    isLocalJSXCommand: toolJSX?.isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode
  };
  useEffect(() => {
    const totalCost = getTotalCost();
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      logEvent('tengu_cost_threshold_reached', {});
      // Mark as shown even if the dialog won't render (no console billing
      // access). Otherwise this effect re-fires on every message change for
      // the rest of the session — 200k+ spurious events observed.
      setHaveShownCostDialog(true);
      if (hasConsoleBillingAccess()) {
        setShowCostDialog(true);
      }
    }
  }, [messages, showCostDialog, haveShownCostDialog]);
  const sandboxAskCallback: SandboxAskCallback = useCallback(async (hostPattern: NetworkHostPattern) => {
    // If running as a swarm worker, forward the request to the leader via mailbox
    if (isAgentSwarmsEnabled() && isSwarmWorker()) {
      const requestId = generateSandboxRequestId();

      // Send the request to the leader via mailbox
      const sent = await sendSandboxPermissionRequestViaMailbox(hostPattern.host, requestId);
      return new Promise(resolveShouldAllowHost => {
        if (!sent) {
          // If we couldn't send via mailbox, fall back to local handling
          setSandboxPermissionRequestQueue(prev => [...prev, {
            hostPattern,
            resolvePromise: resolveShouldAllowHost
          }]);
          return;
        }

        // Register the callback for when the leader responds
        registerSandboxPermissionCallback({
          requestId,
          host: hostPattern.host,
          resolve: resolveShouldAllowHost
        });

        // Update AppState to show pending indicator
        setAppState(prev => ({
          ...prev,
          pendingSandboxRequest: {
            requestId,
            host: hostPattern.host
          }
        }));
      });
    }

    // Normal flow for non-workers: show local UI and optionally race
    // against the REPL bridge (Remote Control) if connected.
    return new Promise(resolveShouldAllowHost => {
      let resolved = false;
      function resolveOnce(allow: boolean): void {
        if (resolved) return;
        resolved = true;
        resolveShouldAllowHost(allow);
      }

      // Queue the local sandbox permission dialog
      setSandboxPermissionRequestQueue(prev => [...prev, {
        hostPattern,
        resolvePromise: resolveOnce
      }]);

      // When the REPL bridge is connected, also forward the sandbox
      // permission request as a can_use_tool control_request so the
      // remote user (e.g. on claude.ai) can approve it too.
      if (feature('BRIDGE_MODE')) {
        const bridgeCallbacks = store.getState().replBridgePermissionCallbacks;
        if (bridgeCallbacks) {
          const bridgeRequestId = randomUUID();
          bridgeCallbacks.sendRequest(bridgeRequestId, SANDBOX_NETWORK_ACCESS_TOOL_NAME, {
            host: hostPattern.host
          }, randomUUID(), `Allow network connection to ${hostPattern.host}?`);
          const unsubscribe = bridgeCallbacks.onResponse(bridgeRequestId, response => {
            unsubscribe();
            const allow = response.behavior === 'allow';
            // Resolve ALL pending requests for the same host, not just
            // this one — mirrors the local dialog handler pattern.
            setSandboxPermissionRequestQueue(queue => {
              queue.filter(item => item.hostPattern.host === hostPattern.host).forEach(item => item.resolvePromise(allow));
              return queue.filter(item => item.hostPattern.host !== hostPattern.host);
            });
            // Clean up all sibling bridge subscriptions for this host
            // (other concurrent same-host requests) before deleting.
            const siblingCleanups = sandboxBridgeCleanupRef.current.get(hostPattern.host);
            if (siblingCleanups) {
              for (const fn of siblingCleanups) {
                fn();
              }
              sandboxBridgeCleanupRef.current.delete(hostPattern.host);
            }
          });

          // Register cleanup so the local dialog handler can cancel
          // the remote prompt and unsubscribe when the local user
          // responds first.
          const cleanup = () => {
            unsubscribe();
            bridgeCallbacks.cancelRequest(bridgeRequestId);
          };
          const existing = sandboxBridgeCleanupRef.current.get(hostPattern.host) ?? [];
          existing.push(cleanup);
          sandboxBridgeCleanupRef.current.set(hostPattern.host, existing);
        }
      }
    });
  }, [setAppState, store]);

  // #34044: if user explicitly set sandbox.enabled=true but deps are missing,
  // isSandboxingEnabled() returns false silently. Surface the reason once at
  // mount so users know their security config isn't being enforced. Full
  // reason goes to debug log; notification points to /sandbox for details.
  // addNotification is stable (useCallback) so the effect fires once.
  useEffect(() => {
    const reason = SandboxManager.getSandboxUnavailableReason();
    if (!reason) return;
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(`\nError: sandbox required but unavailable: ${reason}\n` + `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`);
      gracefulShutdownSync(1, 'other');
      return;
    }
    logForDebugging(`sandbox disabled: ${reason}`, {
      level: 'warn'
    });
    addNotification({
      key: 'sandbox-unavailable',
      jsx: <>
        <Text color="warning">sandbox disabled</Text>
        <Text dimColor> · /sandbox</Text>
      </>,
      priority: 'medium'
    });
  }, [addNotification]);
  if (SandboxManager.isSandboxingEnabled()) {
    // If sandboxing is enabled (setting.sandbox is defined, initialise the manager)
    SandboxManager.initialize(sandboxAskCallback).catch(err => {
      // Initialization/validation failed - display error and exit
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`);
      gracefulShutdownSync(1, 'other');
    });
  }
  const setToolPermissionContext = useCallback((context: ToolPermissionContext, options?: {
    preserveMode?: boolean;
  }) => {
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...context,
        // Preserve the coordinator's mode only when explicitly requested.
        // Workers' getAppState() returns a transformed context with mode
        // 'acceptEdits' that must not leak into the coordinator's actual
        // state via permission-rule updates — those call sites pass
        // { preserveMode: true }. User-initiated mode changes (e.g.,
        // selecting "allow all edits") must NOT be overridden.
        mode: options?.preserveMode ? prev.toolPermissionContext.mode : context.mode
      }
    }));

    // When permission context changes, recheck all queued items
    // This handles the case where approving item1 with "don't ask again"
    // should auto-approve other queued items that now match the updated rules
    setImmediate(setToolUseConfirmQueue => {
      // Use setToolUseConfirmQueue callback to get current queue state
      // instead of capturing it in the closure, to avoid stale closure issues
      setToolUseConfirmQueue(currentQueue => {
        const activeSessionId = getSessionId();
        currentQueue.forEach(item => {
          if (item.permissionSessionId !== undefined && item.permissionSessionId !== activeSessionId) return;
          void item.recheckPermission();
        });
        return currentQueue;
      });
    }, setToolUseConfirmQueue);
  }, [setAppState, setToolUseConfirmQueue]);

  // Register the leader's setToolPermissionContext for in-process teammates
  useEffect(() => {
    registerLeaderSetToolPermissionContext(setToolPermissionContext);
    return () => unregisterLeaderSetToolPermissionContext();
  }, [setToolPermissionContext]);
  const canUseTool = useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext);
  const requestPrompt = useCallback((title: string, toolInputSummary?: string | null) => (request: PromptRequest): Promise<PromptResponse> => new Promise<PromptResponse>((resolve, reject) => {
    setPromptQueue(prev => [...prev, {
      request,
      title,
      toolInputSummary,
      resolve,
      reject
    }]);
  }), []);
  const getToolUseContext = useCallback((messages: MessageType[], newMessages: MessageType[], abortController: AbortController, mainLoopModel: string, queryGeneration?: number, queryLifecycle?: QueryLifecycleOperationTracker): ProcessUserInputContext => {
    // Read mutable values fresh from the store rather than closure-capturing
    // useAppState() snapshots. Same values today (closure is refreshed by the
    // render between turns); decouples freshness from React's render cycle for
    // a future headless conversation loop. Same pattern refreshTools() uses.
    const s = store.getState();

    // Compute tools fresh from store.getState() rather than the closure-
    // captured `tools`. useManageMCPConnections populates appState.mcp
    // async as servers connect — the store may have newer MCP state than
    // the closure captured at render time. Also doubles as refreshTools()
    // for mid-query tool list updates.
    const computeTools = () => {
      const state = store.getState();
      const assembled = assembleToolPool(state.toolPermissionContext, state.mcp.tools);
      const merged = mergeAndFilterTools(combinedInitialTools, assembled, state.toolPermissionContext.mode);
      if (!mainThreadAgentDefinition) return merged;
      return resolveAgentTools(mainThreadAgentDefinition, merged, false, true).resolvedTools;
    };
    const queryActivity = queryGeneration === undefined ? undefined : {
      registerActivity: (reason: string) => {
        queryGuard.registerActivity(reason, queryGeneration);
      },
      acquireLease: (input) => queryGuard.acquireLease(input, queryGeneration),
      beginUserInteraction: () => queryGuard.beginUserInteraction(queryGeneration)
    } satisfies ProcessUserInputContext['queryActivity'];
    return {
      abortController,
      ...(queryLifecycle ? { queryLifecycle } : {}),
      options: {
        commands,
        tools: computeTools(),
        debug,
        verbose: s.verbose,
        mainLoopModel,
        thinkingConfig: s.thinkingEnabled !== false ? thinkingConfig : {
          type: 'disabled'
        },
        // Merge fresh from store rather than closing over useMergedClients'
        // memoized output. initialMcpClients is a prop (session-constant).
        mcpClients: mergeClients(initialMcpClients, s.mcp.clients),
        mcpResources: s.mcp.resources,
        ideInstallationStatus: ideInstallationStatus,
        isNonInteractiveSession: false,
        permissionSessionId: getSessionId(),
        dynamicMcpConfig,
        theme,
        agentDefinitions: allowedAgentTypes ? {
          ...s.agentDefinitions,
          allowedAgentTypes
        } : s.agentDefinitions,
        customSystemPrompt,
        appendSystemPrompt,
        refreshTools: computeTools
      },
      getAppState: () => store.getState(),
      setAppState,
      messages,
      setMessages,
      updateFileHistoryState(updater: (prev: FileHistoryState) => FileHistoryState) {
        // Perf: skip the setState when the updater returns the same reference
        // (e.g. fileHistoryTrackEdit returns `state` when the file is already
        // tracked). Otherwise every no-op call would notify all store listeners.
        setAppState(prev => {
          const updated = updater(prev.fileHistory);
          if (updated === prev.fileHistory) return prev;
          return {
            ...prev,
            fileHistory: updated
          };
        });
      },
      updateAttributionState(updater: (prev: AttributionState) => AttributionState) {
        setAppState(prev => {
          const updated = updater(prev.attribution);
          if (updated === prev.attribution) return prev;
          return {
            ...prev,
            attribution: updated
          };
        });
      },
      openMessageSelector: () => {
        if (!disabled) {
          setIsMessageSelectorVisible(true);
        }
      },
      onChangeAPIKey: reverify,
      readFileState: readFileState.current,
      setToolJSX,
      addNotification,
      appendSystemMessage: msg => setMessages(prev => [...prev, msg]),
      sendOSNotification: opts => {
        void sendNotification(opts, terminal);
      },
      onChangeDynamicMcpConfig,
      onInstallIDEExtension: setIDEToInstallExtension,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: discoveredSkillNamesRef.current,
      setResponseLength,
      setStreamMode,
      onCompactProgress: event => {
        switch (event.type) {
          case 'hooks_start':
            setSpinnerColor('claudeBlue_FOR_SYSTEM_SPINNER');
            setSpinnerShimmerColor('claudeBlueShimmer_FOR_SYSTEM_SPINNER');
            setSpinnerMessage(event.hookType === 'pre_compact' ? 'Running PreCompact hooks\u2026' : event.hookType === 'post_compact' ? 'Running PostCompact hooks\u2026' : 'Running SessionStart hooks\u2026');
            break;
          case 'compact_start':
            setSpinnerMessage('Compacting conversation');
            setCompactProgressRatio(0);
            break;
          case 'compact_progress':
            setCompactProgressRatio(event.ratio);
            break;
          case 'compact_end':
            setCompactProgressRatio(null);
            setSpinnerMessage(null);
            setSpinnerColor(null);
            setSpinnerShimmerColor(null);
            break;
        }
      },
      setInProgressToolUseIDs,
      setHasInterruptibleToolInProgress: (v: boolean) => {
        hasInterruptibleToolInProgressRef.current = v;
      },
      queryActivity,
      resume,
      setConversationId,
      setActiveSessionAgent: agent => {
        const modelSelection = getActiveSessionAgentModelSelection({
          agent,
          baseMainLoopModel: baseMainLoopModelRef.current,
          hasExplicitModelOverride: explicitModelOverrideRef.current,
          hasAgentManagedModel: agentManagedModelRef.current !== undefined
        });
        setMainThreadAgentDefinition(agent);
        setMainThreadAgentType(agent.agentType);
        saveAgentSetting(agent.agentType);
        if (modelSelection.shouldUpdateModel) {
          agentManagedModelRef.current = modelSelection.mainLoopModelForSession;
          setMainLoopModelOverride(modelSelection.mainLoopModelForSession);
          notifySessionMetadataChanged({
            model: modelSelection.mainLoopModelForSession
          });
        }
        setAppState(prev => ({
          ...prev,
          agent: agent.agentType,
          ...(modelSelection.shouldUpdateModel ? {
            mainLoopModelForSession: modelSelection.mainLoopModelForSession
          } : {})
        }));
      },
      requestPrompt: feature('HOOK_PROMPTS') ? requestPrompt : undefined,
      contentReplacementState: contentReplacementStateRef.current,
      syncToolResultReplacements
    };
  }, [commands, combinedInitialTools, mainThreadAgentDefinition, debug, initialMcpClients, ideInstallationStatus, dynamicMcpConfig, theme, allowedAgentTypes, store, setAppState, reverify, addNotification, setMessages, onChangeDynamicMcpConfig, resume, requestPrompt, disabled, customSystemPrompt, appendSystemPrompt, setConversationId, syncToolResultReplacements, queryGuard]);

  // Session backgrounding (Ctrl+B to background/foreground)
  const handleBackgroundQuery = useCallback(() => {
    const backgroundSessionId = getSessionId();
    const backgroundSessionTitle = terminalTitle;
    setBackgroundHandoffPreparing(true);
    // Transfer the exact per-prompt budget before aborting. Re-resolving the
    // limit or copying a callback-maintained count here can reset or skew the
    // cap while the foreground query is winding down.
    const backgroundHandoff = claimBackgroundTurnBudget(foregroundTurnBudgetRef, backgroundHandoffStartedRef);
    if (!backgroundHandoff) return;
    const restoreDeferredMaxTurnsCap = () => {
      const attemptRestore = (): boolean => {
        const cap = backgroundHandoff.deferredMaxTurnsCap;
        if (!cap || !canRestoreDeferredMaxTurnsCap(backgroundHandoff, messagesRef.current)) {
          return false;
        }
        backgroundHandoff.deferredMaxTurnsCap = undefined;
        setMessages(prev => [...prev, createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns: cap.maxTurns,
          turnCount: cap.turnCount
        })]);
        return true;
      };
      if (!attemptRestore()) {
        void backgroundHandoff.settled.then(() => {
          attemptRestore();
        });
      }
    };
    const backgroundSession = startBackgroundSession({
      prepare: async backgroundAbortController => {
        // The foreground owns transcript completion. Wait until its abort path
        // has appended terminal tool results before snapshotting continuation
        // state, while still honoring a task stop during that wait.
        const shouldContinue = await waitForForegroundTurnBudgetSettlement(backgroundHandoff, backgroundAbortController.signal);
        if (shouldContinue === null) {
          throw backgroundAbortController.signal.reason;
        }
        if (!shouldContinue) return null;

        // The foreground is settled, but its QueryGuard will shortly release
        // and allow a new prompt. Capture this continuation's transcript before
        // any preparation await can observe that later foreground turn.
        const settledMessages = [...messagesRef.current];
        backgroundHandoff.settledTranscriptTailUuid =
          settledMessages.at(-1)?.uuid ?? null;
        // Claim main-thread notifications only. Subagent-addressed entries keep
        // their owner-scoped drain path (QueuedCommand.agentId); issue #2079 is
        // about configurable interactive turn caps, not queue isolation.
        const pendingNotifications = removeByFilter(
          cmd =>
            cmd.mode === 'task-notification' && cmd.agentId === undefined,
        );
        let restorableNotifications = filterClaimedTaskNotificationsForRestore(
          pendingNotifications,
          settledMessages,
        );
        let notificationOwnershipActive = true;
        const restoreNotificationsIfUnsent = () => {
          if (!notificationOwnershipActive) return;
          notificationOwnershipActive = false;
          if (restorableNotifications.length > 0) {
            prepend(restorableNotifications);
          }
        };
        try {
        const toolUseContext = getToolUseContext(settledMessages, [], backgroundAbortController, mainLoopModel);
        const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([getSystemPrompt(toolUseContext.options.tools, mainLoopModel, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), toolUseContext.options.mcpClients), getUserContext(), getSystemContext()]).catch(error => {
          restoreNotificationsIfUnsent();
          throw error;
        });
        if (backgroundAbortController.signal.aborted) {
          restoreNotificationsIfUnsent();
          throw backgroundAbortController.signal.reason;
        }
        const systemPrompt = buildEffectiveSystemPrompt({
          mainThreadAgentDefinition,
          toolUseContext,
          customSystemPrompt,
          defaultSystemPrompt,
          appendSystemPrompt
        });
        toolUseContext.renderedSystemPrompt = systemPrompt;
        const notificationAttachments = await getQueuedCommandAttachments(pendingNotifications).catch(error => {
          restoreNotificationsIfUnsent();
          throw error;
        });
        if (backgroundAbortController.signal.aborted) {
          restoreNotificationsIfUnsent();
          throw backgroundAbortController.signal.reason;
        }
        const notificationMessages = notificationAttachments.map(createAttachmentMessage);

        // Deduplicate against settled transcript keys and within the claimed batch.
        const uniqueNotifications = dedupeQueuedTaskNotifications(
          settledMessages,
          notificationMessages,
        );
        restorableNotifications = pendingCommandsForEmbeddedNotifications(
          pendingNotifications,
          uniqueNotifications,
        );
        return {
          messages: [...settledMessages, ...uniqueNotifications],
          restoreNotificationsIfUnsent,
          commitNotificationOwnership: () => {
            notificationOwnershipActive = false;
          },
          queryParams: {
            systemPrompt,
            userContext,
            systemContext,
            canUseTool,
            toolUseContext,
            fallbackModel,
            turnBudget: backgroundHandoff.budget,
            querySource: getQuerySourceForREPL(),
            autoCompactTracking: getAutoCompactTrackingForSession(backgroundSessionId),
            onAutoCompactTrackingChange: tracking => {
              setAutoCompactTrackingForSession(backgroundSessionId, tracking);
            }
          }
        };
        } catch (error) {
          restoreNotificationsIfUnsent();
          throw error;
        }
      },
      description: backgroundSessionTitle,
      setAppState,
      agentDefinition: mainThreadAgentDefinition,
      onPreparationError: () => {
        restoreDeferredMaxTurnsCap();
        addNotification({
          key: 'background-session-start-failed',
          text: 'Could not start the background session. The current request was cancelled.',
          priority: 'high',
        });
      },
      onContinuationCancelled: restoreDeferredMaxTurnsCap,
      onRegistered: controller => {
        setAbortController(current =>
          current === controller ? null : current,
        );
      },
      onSettled: controller => {
        setBackgroundHandoffPreparing(false);
        setAbortController(current =>
          current === controller ? null : current,
        );
      },
    });
    // The task is intentionally published only after the foreground settles,
    // but its controller must be reachable during preparation so Escape can
    // cancel the handoff before it dispatches a provider request.
    setAbortController(backgroundSession.abortController);
    requestBackgroundHandoffAbort(abortController);
  }, [abortController, mainLoopModel, toolPermissionContext, mainThreadAgentDefinition, getToolUseContext, customSystemPrompt, appendSystemPrompt, canUseTool, setAppState, getAutoCompactTrackingForSession, setAutoCompactTrackingForSession, fallbackModel, setAbortController, addNotification, terminalTitle]);
  const {
    handleBackgroundSession
  } = useSessionBackgrounding({
    setMessages,
    setIsLoading: setIsExternalLoading,
    resetLoadingState,
    setAbortController,
    onBackgroundQuery: handleBackgroundQuery
  });
  const onQueryEvent = useCallback((event: Parameters<typeof handleMessageFromStream>[0]) => {
    handleMessageFromStream(event, newMessage => {
      if (isCompactBoundaryMessage(newMessage)) {
        // Fullscreen: keep pre-compact messages for scrollback. query.ts
        // slices at the boundary for API calls, Messages.tsx skips the
        // boundary filter in fullscreen, and useLogMessages treats this
        // as an incremental append (first uuid unchanged). Cap at one
        // compact-interval of scrollback — normalizeMessages/applyGrouping
        // are O(n) per render, so drop everything before the previous
        // boundary to keep n bounded across multi-day sessions.
        if (isFullscreenEnvEnabled()) {
          setMessages(old => [...getMessagesAfterCompactBoundary(old, {
            includeSnipped: true
          }), newMessage]);
        } else {
          setMessages(() => [newMessage]);
        }
        // Bump conversationId so Messages.tsx row keys change and
        // stale memoized rows remount with post-compact content.
        setConversationId(randomUUID());
        // Compaction succeeded — clear the context-blocked flag so ticks resume
        if (feature('PROACTIVE') || feature('KAIROS')) {
          proactiveModule?.setContextBlocked(false);
        }
      } else if (newMessage.type === 'progress' && isEphemeralToolProgress(newMessage.data.type)) {
        // Replace the previous ephemeral progress tick for the same tool
        // call instead of appending. Sleep/Bash emit a tick per second and
        // only the last one is rendered; appending blows up the messages
        // array (13k+ observed) and the transcript (120MB of sleep_progress
        // lines). useLogMessages tracks length, so same-length replacement
        // also skips the transcript write.
        // agent_progress / hook_progress / skill_progress are NOT ephemeral
        // — each carries distinct state the UI needs (e.g. subagent tool
        // history). Replacing those leaves the AgentTool UI stuck at
        // "Initializing…" because it renders the full progress trail.
        setMessages(oldMessages => {
          const last = oldMessages.at(-1);
          if (last?.type === 'progress' && last.parentToolUseID === newMessage.parentToolUseID && last.data.type === newMessage.data.type) {
            const copy = oldMessages.slice();
            copy[copy.length - 1] = newMessage;
            return copy;
          }
          return [...oldMessages, newMessage];
        });
      } else {
        setMessages(oldMessages => [...oldMessages, newMessage]);
      }
      // Block ticks on API errors to prevent tick → error → tick
      // runaway loops (e.g., auth failure, rate limit, blocking limit).
      // Cleared on compact boundary (above) or successful response (below).
      if (feature('PROACTIVE') || feature('KAIROS')) {
        if (newMessage.type === 'assistant' && 'isApiErrorMessage' in newMessage && newMessage.isApiErrorMessage) {
          proactiveModule?.setContextBlocked(true);
        } else if (newMessage.type === 'assistant') {
          proactiveModule?.setContextBlocked(false);
        }
      }
    }, newContent => {
      // setResponseLength updates responseLengthRef for spinner animation.
      setResponseLength(length => length + newContent.length);
    }, setStreamMode, setStreamingToolUses, tombstonedMessage => {
      setMessages(oldMessages => oldMessages.filter(m => m !== tombstonedMessage));
      void removeTranscriptMessage(tombstonedMessage.uuid);
    }, setStreamingThinking, undefined, onStreamingText);
  }, [setMessages, setResponseLength, setStreamMode, setStreamingToolUses, setStreamingThinking, onStreamingText]);
  const onQueryImpl = useCallback(async (messagesIncludingNewMessages: MessageType[], newMessages: MessageType[], abortController: AbortController, shouldQuery: boolean, additionalAllowedTools: string[], mainLoopModelParam: string, queryGeneration: number, turnBudget: QueryTurnBudget, effort?: EffortValue, queryLifecycle?: QueryLifecycleOperationTracker, requestOnlyMessages: MessageType[] = [], interruptionCorrectionQueryId?: string, onModelRequestStart?: () => void): Promise<QueryTerminal | undefined> => {
    // Prepare IDE integration for new prompt. Read mcpClients fresh from
    // store — useManageMCPConnections may have populated it since the
    // render that captured this closure (same pattern as computeTools).
    if (shouldQuery) {
      const freshClients = mergeClients(initialMcpClients, store.getState().mcp.clients);
      void diagnosticTracker.handleQueryStart(freshClients);
      const ideClient = getConnectedIdeClient(freshClients);
      if (ideClient) {
        void closeOpenDiffs(ideClient);
      }
    }

    // Mark onboarding as complete when any user message is sent to Claude
    void maybeMarkProjectOnboardingComplete();

    // Extract a session title from the first real user message. One-shot
    // via ref (was tengu_birch_mist experiment: first-message-only to save
    // Haiku calls). The ref replaces the old `messages.length <= 1` check,
    // which was broken by SessionStart hook messages (prepended via
    // useDeferredHookMessages) and attachment messages (appended by
    // processTextPrompt) — both pushed length past 1 on turn one, so the
    // title silently fell through to the "Claude Code" default.
    if (!titleDisabled && !sessionTitle && !agentTitle && !haikuTitleAttemptedRef.current) {
      const firstUserMessage = newMessages.find(m => m.type === 'user' && !m.isMeta);
      const text = firstUserMessage?.type === 'user' ? getContentText(firstUserMessage.message.content) : null;
      // Skip synthetic breadcrumbs — slash-command output, prompt-skill
      // expansions (/commit → <command-message>), local-command headers
      // (/help → <command-name>), and bash-mode (!cmd → <bash-input>).
      // None of these are the user's topic; wait for real prose.
      if (text && !text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) && !text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) && !text.startsWith(`<${COMMAND_NAME_TAG}>`) && !text.startsWith(`<${BASH_INPUT_TAG}>`)) {
        haikuTitleAttemptedRef.current = true;
        void generateSessionTitle(text, new AbortController().signal).then(title => {
          const generatedTitle = titleOrNullForPromptFallback(title);
          if (generatedTitle) setHaikuTitle(generatedTitle); else haikuTitleAttemptedRef.current = false;
        }, () => {
          haikuTitleAttemptedRef.current = false;
        });
      }
    }

    // Apply slash-command-scoped allowedTools (from skill frontmatter) to the
    // store once per turn. This also covers the reset: the next non-skill turn
    // passes [] and clears it. Must run before the !shouldQuery gate: forked
    // commands (executeForkedSlashCommand) return shouldQuery=false, and
    // createGetAppStateWithAllowedTools in forkedAgent.ts reads this field, so
    // stale skill tools would otherwise leak into forked agent permissions.
    // Previously this write was hidden inside getToolUseContext's getAppState
    // (~85 calls/turn); hoisting it here makes getAppState a pure read and stops
    // ephemeral contexts (permission dialog, BackgroundTasksDialog) from
    // accidentally clearing it mid-turn.
    store.setState(prev => {
      const cur = prev.toolPermissionContext.alwaysAllowRules.command;
      if (cur === additionalAllowedTools || cur?.length === additionalAllowedTools.length && cur.every((v, i) => v === additionalAllowedTools[i])) {
        return prev;
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          alwaysAllowRules: {
            ...prev.toolPermissionContext.alwaysAllowRules,
            command: additionalAllowedTools
          }
        }
      };
    });

    // The last message is an assistant message if the user input was a bash command,
    // or if the user input was an invalid slash command.
    if (!shouldQuery) {
      // Manual /compact sets messages directly (shouldQuery=false) bypassing
      // handleMessageFromStream. Clear context-blocked if a compact boundary
      // is present so proactive ticks resume after compaction.
      if (newMessages.some(isCompactBoundaryMessage)) {
        setAutoCompactTrackingForSession(getSessionId(), undefined);
        // Bump conversationId so Messages.tsx row keys change and
        // stale memoized rows remount with post-compact content.
        setConversationId(randomUUID());
        if (feature('PROACTIVE') || feature('KAIROS')) {
          proactiveModule?.setContextBlocked(false);
        }
      }
      resetLoadingState();
      setAbortController(null);
      return;
    }
    const toolUseContext = getToolUseContext(messagesIncludingNewMessages, newMessages, abortController, mainLoopModelParam, queryGeneration, queryLifecycle);
    const querySessionId = getSessionId();
    const queryAutoCompactTracking = getAutoCompactTrackingForSession(querySessionId);
    // getToolUseContext reads tools/mcpClients fresh from store.getState()
    // (via computeTools/mergeClients). Use those rather than the closure-
    // captured `tools`/`mcpClients` — useManageMCPConnections may have
    // flushed new MCP state between the render that captured this closure
    // and now. Turn 1 via processInitialMessage is the main beneficiary.
    const {
      tools: freshTools,
      mcpClients: freshMcpClients
    } = toolUseContext.options;

    // Scope the skill's effort override to this turn's context only —
    // wrapping getAppState keeps the override out of the global store so
    // background agents and UI subscribers (Spinner, LogoV2) never see it.
    if (effort !== undefined) {
      const previousGetAppState = toolUseContext.getAppState;
      toolUseContext.getAppState = () => ({
        ...previousGetAppState(),
        effortValue: effort
      });
    }
    // Set blue/cyan spinner color for ultracode mode so the thinking
    // indicator is visually distinct from regular thinking/ultrathink.
    const effectiveEffort = effort ?? store.getState().effortValue;
    if (getDisplayedEffortLevel(mainLoopModelParam, effectiveEffort) === 'ultracode') {
      setSpinnerColor('ultracode');
      setSpinnerShimmerColor('ultracodeShimmer');
    }
    queryCheckpoint('query_context_loading_start');
    const [, , defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
      // IMPORTANT: do this after setMessages() above, to avoid UI jank
      checkAndDisableBypassPermissionsIfNeeded(toolPermissionContext, setAppState),
      // Gated on TRANSCRIPT_CLASSIFIER so GrowthBook kill switch runs wherever auto mode is built in
      feature('TRANSCRIPT_CLASSIFIER') ? checkAndDisableAutoModeIfNeeded(toolPermissionContext, setAppState, store.getState().fastMode) : undefined, getSystemPrompt(freshTools, mainLoopModelParam, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), freshMcpClients), getUserContext(), getSystemContext()]);
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(freshMcpClients, isScratchpadEnabled() ? getScratchpadDir() : undefined),
      ...((feature('PROACTIVE') || feature('KAIROS')) && proactiveModule?.isProactiveActive() && !terminalFocusRef.current ? {
        terminalFocus: 'The terminal is unfocused \u2014 the user is not actively watching.'
      } : {})
    };
    queryCheckpoint('query_context_loading_end');
    const systemPrompt = buildEffectiveSystemPrompt({
      mainThreadAgentDefinition,
      toolUseContext,
      customSystemPrompt,
      defaultSystemPrompt,
      appendSystemPrompt
    });
    toolUseContext.renderedSystemPrompt = systemPrompt;
    queryCheckpoint('query_query_start');
    resetTurnHookDuration();
    resetTurnToolDuration();
    resetTurnClassifierDuration();
    let expectedAutoCompactTracking = queryAutoCompactTracking;
    const queryGenerator = query({
      messages: messagesIncludingNewMessages,
      requestOnlyMessages,
      onModelRequestStart: interruptionCorrectionQueryId
        ? () => {
            interruptionCorrectionTracker.bindModelTurn({
              shouldQuery,
              isInterruptionCorrectionEligible: true,
              queryId: interruptionCorrectionQueryId,
            })
            onModelRequestStart?.()
          }
        : undefined,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool,
      toolUseContext,
      querySource: getQuerySourceForREPL(),
      fallbackModel,
      turnBudget,
      autoCompactTracking: queryAutoCompactTracking,
      onAutoCompactTrackingChange: tracking => {
        if (setAutoCompactTrackingForSessionIfUnchanged(querySessionId, expectedAutoCompactTracking, tracking)) {
          expectedAutoCompactTracking = tracking;
        }
      }
    });
    const queryTerminal = await driveQueryEvents(
      queryGenerator,
      reason => queryGuard.registerActivity(reason, queryGeneration),
      onQueryEvent,
    );
    if (isBuddyEnabled()) {
      void fireCompanionObserver(messagesRef.current, reaction => setAppState(prev => prev.companionReaction === reaction ? prev : {
        ...prev,
        companionReaction: reaction
      }));
    }
    queryCheckpoint('query_end');

    resetLoadingState();

    // Log query profiling report if enabled
    logQueryProfileReport();

    // Signal that a query turn has completed successfully
    await onTurnComplete?.(messagesRef.current);
    return queryTerminal;
  }, [initialMcpClients, resetLoadingState, getToolUseContext, toolPermissionContext, setAppState, customSystemPrompt, onTurnComplete, appendSystemPrompt, canUseTool, mainThreadAgentDefinition, onQueryEvent, sessionTitle, titleDisabled, getAutoCompactTrackingForSession, setAutoCompactTrackingForSession, setAutoCompactTrackingForSessionIfUnchanged, queryGuard, interruptionCorrectionTracker]);
  const onQuery = useCallback(async (newMessages: MessageType[], abortController: AbortController, shouldQuery: boolean, additionalAllowedTools: string[], mainLoopModelParam: string, onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>, input?: string, effort?: EffortValue, isInterruptionCorrectionEligible = false, onModelRequestStart?: () => void): Promise<void | false> => {
    // If this is a teammate, mark them as active when starting a turn
    if (isAgentSwarmsEnabled()) {
      const teamName = getTeamName();
      const agentName = getAgentName();
      if (teamName && agentName) {
        // Fire and forget - turn starts immediately, write happens in background
        void setMemberActive(teamName, agentName, true);
      }
    }

    // Concurrent guard via state machine. tryStart() atomically checks
    // and transitions idle→running, returning lifecycle context.
    // Returns null if already running — no separate check-then-set.
    const lifecycleTracker = queryLifecycleTrackerRef.current;
    const querySource = getQuerySourceForREPL();
    if (backgroundHandoffPreparing) {
      logEvent('tengu_concurrent_onquery_detected', {});
      newMessages.filter((m): m is UserMessage => m.type === 'user' && !m.isMeta).map(_ => getContentText(_.message.content)).filter(_ => _ !== null).forEach((msg, i) => {
        enqueue(buildConcurrentRequeuedPrompt(msg, isInterruptionCorrectionEligible));
        if (i === 0) {
          logEvent('tengu_concurrent_onquery_enqueued', {});
        }
      });
      return false;
    }
    const startResult = tryStartQueryWithConfiguredIdleTimeout(queryGuard, {
      queryId: randomUUID(),
      querySource,
      startedAt: Date.now(),
      getActiveOperations: () => lifecycleTracker.snapshot()
    }, process.env, getGlobalConfig().queryIdleTimeoutMs);
    if (startResult === null) {
      logEvent('tengu_concurrent_onquery_detected', {});

      // Extract and enqueue user message text, skipping meta messages
      // (e.g. expanded skill content, tick prompts) that should not be
      // replayed as user-visible text.
      newMessages.filter((m): m is UserMessage => m.type === 'user' && !m.isMeta).map(_ => getContentText(_.message.content)).filter(_ => _ !== null).forEach((msg, i) => {
        enqueue(buildConcurrentRequeuedPrompt(msg, isInterruptionCorrectionEligible));
        if (i === 0) {
          logEvent('tengu_concurrent_onquery_enqueued', {});
        }
      });
      return false;
    }
    lifecycleTracker.clear();
    const thisGeneration = startResult.generation;
    backgroundHandoffStartedRef.current = false;
    const turnBudgetHandoff = createForegroundTurnBudgetHandoff(
      resolveReplMaxTurnsForSession(maxTurnsProp, {
        isRemoteSession,
        directConnectConfig,
        sshSession,
      }),
    );
    const turnBudget = turnBudgetHandoff.budget;
    foregroundTurnBudgetRef.current = turnBudgetHandoff;
    const queryContext = startResult.context;
    registerInterruptionController(abortController, {
      subsystem: 'repl',
      controllerRole: 'query-root',
      queryId: queryContext.queryId,
      queryGeneration: thisGeneration,
      querySource: queryContext.querySource,
    });
    traceInterruptionEvent('query.started', {
      subsystem: 'repl',
      phase: 'running',
      queryId: queryContext.queryId,
      queryGeneration: thisGeneration,
      querySource: queryContext.querySource,
    });
    logQueryLifecycle('start', queryContext);
    logQueryLifecycle('guard_start', queryContext);
    let didThrow = false;
    let queryTerminal: QueryTerminal | undefined;
    let preflightVetoed = false;
    let modelTurnStarted = false;
    let hasInterruptionCorrectionRequestOnlyMessage = false;
    try {
      // isLoading is derived from queryGuard — tryStart() above already
      // transitioned dispatching→running, so no setter call needed here.
      resetTimingRefs();
      // Start-of-turn cache tracker reset. The end-of-turn path at the
      // bottom of this function already resets, but mirror the call here
      // so a turn that never reaches end-of-turn (crash, unhandled
      // rejection, process exit) still starts clean on the next one.
      // Idempotent with respect to the end-of-turn reset — double-reset
      // is a no-op.
      resetCurrentTurn();
      const {
        persistentMessages,
        persistentNewMessages,
        requestOnlyMessages
      } = buildInterruptionCorrectionMessageViews(messagesRef.current, newMessages);
      hasInterruptionCorrectionRequestOnlyMessage = requestOnlyMessages.length > 0;
      setMessages(persistentMessages);
      responseLengthRef.current = 0;
      setReducedMotionResponseLength(0);
      if (reducedMotionResponseLengthTimerRef.current) {
        clearTimeout(reducedMotionResponseLengthTimerRef.current);
        reducedMotionResponseLengthTimerRef.current = null;
      }
      if (feature('TOKEN_BUDGET')) {
        const parsedBudget = input ? parseTokenBudget(input) : null;
        snapshotOutputTokensForTurn(parsedBudget ?? getCurrentTurnTokenBudget());
      }
      setStreamingToolUses([]);
      streamingTextRef.current = null;
      lastFlushedStreamingVisibleRef.current = null;
      setStreamingText(null);

      // Request-only context is passed separately to query(), so compaction,
      // tools, transcript logging, later turns, and resume never persist it.
      const latestMessages = persistentMessages;
      if (input) {
        await mrOnBeforeQuery(input, latestMessages, persistentNewMessages.length);
      }

      // Pass full conversation history to callback
      if (onBeforeQueryCallback && input) {
        const shouldProceed = await onBeforeQueryCallback(input, latestMessages);
        if (!shouldProceed) {
          // No provider request owns this reminder when preflight vetoes
          // the turn. Return false so handlePromptSubmit restores it for
          // the next eligible correction prompt.
          preflightVetoed = true;
        }
      }
      if (!preflightVetoed) {
        modelTurnStarted = true;
        queryTerminal = await onQueryImpl(latestMessages, persistentNewMessages, abortController, shouldQuery, additionalAllowedTools, mainLoopModelParam, thisGeneration, turnBudget, effort, lifecycleTracker, requestOnlyMessages, isInterruptionCorrectionEligible ? queryContext.queryId : undefined, onModelRequestStart);
      }
      if (preflightVetoed) {
        return false;
      }
    } catch (error) {
      didThrow = true;
      // A preflight failure happens before any provider request owns this
      // request-only reminder, so keep it for the next eligible correction.
      if (!modelTurnStarted && hasInterruptionCorrectionRequestOnlyMessage) {
        interruptionCorrectionTracker.restoreReminder();
      }
      throw error;
    } finally {
      // The ref is only an ownership marker for the currently foregrounded
      // prompt. A background handoff already captured the budget object, so
      // clear the ref on every terminal path without disturbing a newer query.
      const shouldContinueBackground =
        shouldContinueBackgroundAfterForegroundQuery({
          didThrow,
          preflightVetoed,
          abortReason: abortController.signal.reason,
          queryTerminal,
        });
      if (shouldContinueBackground) {
        const deferredCap = computeDeferredMaxTurnsCapForBackgroundHandoff(abortController.signal.reason, queryTerminal, turnBudget.maxTurns, turnBudget.turnsStarted);
        if (deferredCap) {
          turnBudgetHandoff.deferredMaxTurnsCap = deferredCap;
          turnBudgetHandoff.settledTranscriptTailUuid =
            messagesRef.current.at(-1)?.uuid ?? null;
        }
      }
      releaseForegroundTurnBudget(foregroundTurnBudgetRef, backgroundHandoffStartedRef, turnBudgetHandoff, shouldContinueBackground);
      // A provider response can hand off to tools before the assistant turn
      // finishes. Keep correction ownership through that work (and retries),
      // then clear it only when this query reaches its terminal cleanup.
      interruptionCorrectionTracker.finishModelTurn(queryContext.queryId);
      const terminalReason = getQueryTerminalReason(abortController.signal, didThrow);
      const terminalOutcome = getQueryTerminalOutcome(abortController.signal, didThrow);
      const abortReason = getAbortReasonLabel(abortController.signal.reason);
      const activeOperations = lifecycleTracker.snapshot();
      traceInterruptionEvent('query.terminal', {
        subsystem: 'repl',
        phase: terminalReason,
        outcome: terminalOutcome,
        queryId: queryContext.queryId,
        queryGeneration: thisGeneration,
        querySource: queryContext.querySource,
        reason: abortController.signal.reason,
        causalEventId: getInterruptionSignalAbortEventId(
          abortController.signal,
        ),
        activeApiCallCount: activeOperations.apiCalls.length,
        activeToolUseCount: activeOperations.toolUses.length,
      });
      if (abortController.signal.aborted) flushInterruptionTrace('query_terminal');
      const completedContext = {
        ...queryContext,
        terminalReason,
        ...(abortReason !== undefined && {
          abortReason
        })
      };
      const activeOperationSummary = summarizeActiveOperations(activeOperations);
      const logCompletedLifecycle = (context: QueryLifecycleContext) => {
        logQueryLifecycle('end', context, activeOperationSummary);
        if (activeOperations.apiCalls.length > 0) {
          logForDebugging(`api.call.orphaned_on_query_end queryId=${queryContext.queryId} generation=${thisGeneration} ${activeOperationSummary}`, {
            level: 'warn'
          });
        }
      };
      // queryGuard.end() atomically checks generation and transitions
      // running→idle. Returns false if a newer query owns the guard
      // (cancel+resubmit race where the stale finally fires as a microtask).
      if (queryGuard.end(thisGeneration, terminalReason, abortReason)) {
        clearQueryProfile();
        logCompletedLifecycle(completedContext);
        lifecycleTracker.clear();
        setLastQueryCompletionTime(Date.now());
        skipIdleCheckRef.current = false;
        // Always reset loading state in finally - this ensures cleanup even
        // if onQueryImpl throws. onTurnComplete is called separately in
        // onQueryImpl only on successful completion.
        resetLoadingState();
        await mrOnTurnComplete(messagesRef.current, abortController.signal.aborted);

        // Notify bridge clients that the turn is complete so mobile apps
        // can stop the spark animation and show post-turn UI.
        sendBridgeResultRef.current();

        // Capture budget info before clearing (internal-only)
        let budgetInfo: {
          tokens: number;
          limit: number;
          nudges: number;
        } | undefined;
        if (feature('TOKEN_BUDGET')) {
          if (getCurrentTurnTokenBudget() !== null && getCurrentTurnTokenBudget()! > 0 && !abortController.signal.aborted) {
            budgetInfo = {
              tokens: getTurnOutputTokens(),
              limit: getCurrentTurnTokenBudget()!,
              nudges: getBudgetContinuationCount()
            };
          }
          snapshotOutputTokensForTurn(null);
        }

        // Add turn duration message for turns longer than 30s or with a budget
        // Skip if user aborted or if in loop mode (too noisy between ticks)
        // Defer if swarm teammates are still running (show when they finish)
        const turnDurationMs = Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;
        if ((turnDurationMs > 30000 || budgetInfo !== undefined) && !abortController.signal.aborted && !proactiveActive) {
          const hasRunningSwarmAgents = getAllInProcessTeammateTasks(store.getState().tasks).some(t => t.status === 'running');
          if (hasRunningSwarmAgents) {
            // Only record start time on the first deferred turn
            if (swarmStartTimeRef.current === null) {
              swarmStartTimeRef.current = loadingStartTimeRef.current;
            }
            // Always update budget — later turns may carry the actual budget
            if (budgetInfo) {
              swarmBudgetInfoRef.current = budgetInfo;
            }
          } else {
            setMessages(prev => [...prev, createTurnDurationMessage(turnDurationMs, budgetInfo, count(prev, isLoggableMessage))]);
          }
        }
        // Cache stats line — controlled by `/config showCacheStats`. Shows
        // per-query read/hit stats using the provider-normalized metrics
        // from cacheStatsTracker. 'off' skips, 'compact' gives a one-liner,
        // 'full' gives a breakdown. Display is skipped when the user
        // aborted or proactive mode is active — but the counter reset
        // below still runs in those cases.
        if (!abortController.signal.aborted && !proactiveActive) {
          // Defensive default: config layer already merges 'compact' from
          // DEFAULT_GLOBAL_CONFIG (see config.ts:1494) for configs that
          // predate this feature, so `mode` should always be defined.
          // The `?? 'compact'` fallback covers pathological cases — a
          // corrupt config read that returned an empty object, or a
          // race between writer and reader — where the merge didn't
          // land. Rendering the line is the safer failure mode than
          // silently hiding it.
          const mode = getGlobalConfig().showCacheStats ?? 'compact';
          if (mode !== 'off') {
            const turnMetrics = getCurrentTurnCacheMetrics();
            // Skip rendering if the turn recorded no API activity at all —
            // avoids a spurious "[Cache: cold]" on local-only commands.
            if (turnMetrics.supported || turnMetrics.read > 0 || turnMetrics.total > 0) {
              const line = mode === 'full' ? formatCacheMetricsFull(turnMetrics) : formatCacheMetricsCompact(turnMetrics);
              setMessages(prev => [...prev, createSystemMessage(line, 'info')]);
            }
          }
        }
        // Reset turn counters UNCONDITIONALLY — users routinely interrupt
        // (Ctrl+C) mid-turn, and if we kept the reset gated on
        // !aborted, the in-flight turn's metrics would leak into the
        // next turn's aggregate. Proactive turns also need the reset so
        // their metrics don't pile onto the following user turn.
        resetCurrentTurn();
        // Clear the controller so CancelRequestHandler's canCancelRunningTask
        // reads false at the idle prompt. Without this, the stale non-aborted
        // controller makes ctrl+c fire onCancel() (aborting nothing) instead of
        // propagating to the double-press exit flow.
        setAbortController(current =>
          current === abortController ? null : current,
        );
      } else {
        const guardCompletedContext = queryGuard.lastContext;
        if ((guardCompletedContext?.terminalReason === 'query-timeout' || guardCompletedContext?.terminalReason === 'hard-max-query-timeout') && guardCompletedContext.queryGeneration === thisGeneration) {
          logCompletedLifecycle(guardCompletedContext);
          setLastQueryCompletionTime(Date.now());
          lifecycleTracker.clear();
          clearQueryProfile();
        } else if (!queryGuard.isActive) {
          lifecycleTracker.clear();
          clearQueryProfile();
        }
      }

      // Auto-restore: if the user interrupted before any meaningful response
      // arrived, rewind the conversation and restore their prompt — same as
      // opening the message selector and picking the last message.
      // This runs OUTSIDE the queryGuard.end() check because onCancel calls
      // forceEnd(), which bumps the generation so end() returns false above.
      // Guards: reason === 'user-cancel' (onCancel/Esc; programmatic aborts
      // use 'background'/'interrupt' and must not rewind — note abort() with
      // no args sets reason to a DOMException, not undefined), !isActive (no
      // newer query started — cancel+resubmit race), empty input (don't
      // clobber text typed during loading), no queued commands (user queued
      // B while A was loading → they've moved on, don't restore A; also
      // avoids removeLastFromHistory removing B's entry instead of A's),
      // not viewing a teammate (messagesRef is the main conversation — the
      // old Up-arrow quick-restore had this guard, preserve it).
      if (abortController.signal.reason === 'user-cancel' && !queryGuard.isActive && inputValueRef.current === '' && getCommandQueueLength() === 0 && !store.getState().viewingAgentTaskId) {
        const msgs = messagesRef.current;
        const lastUserMsg = msgs.findLast(selectableUserMessagesFilter);
        if (lastUserMsg) {
          const idx = msgs.lastIndexOf(lastUserMsg);
          if (messagesAfterAreOnlySynthetic(msgs, idx)) {
            // The submit is being undone — undo its history entry too,
            // otherwise Up-arrow shows the restored text twice.
            removeLastFromHistory();
            restoreMessageSyncRef.current(lastUserMsg, {
              preserveInterruptionCorrectionReminder: true
            });
          }
        }
      }
    }
  }, [onQueryImpl, setAppState, resetLoadingState, queryGuard, mrOnBeforeQuery, mrOnTurnComplete, maxTurnsProp, isRemoteSession, directConnectConfig, sshSession, backgroundHandoffPreparing]);

  // Handle initial message (from CLI args or plan mode exit with context clear)
  // This effect runs when isLoading becomes false and there's a pending message
  const initialMessageRef = useRef(false);
  useEffect(() => {
    const pending = initialMessage;
    if (!pending || isLoading || initialMessageRef.current) return;

    // Mark as processing to prevent re-entry
    initialMessageRef.current = true;
    async function processInitialMessage(initialMsg: NonNullable<typeof pending>) {
      // Clear context if requested (plan mode exit)
      if (initialMsg.clearContext) {
        resetAutoCompactTracking();
        // Preserve the plan slug before clearing context, so the new session
        // can access the same plan file after regenerateSessionId()
        const oldPlanSlug = initialMsg.message.planContent ? getPlanSlug() : undefined;
        const {
          clearConversation
        } = await import('../commands/clear/conversation.js');
        await clearConversation({
          setMessages,
          readFileState: readFileState.current,
          discoveredSkillNames: discoveredSkillNamesRef.current,
          loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
          getAppState: () => store.getState(),
          setAppState,
          setConversationId
        });
        haikuTitleAttemptedRef.current = false;
        setHaikuTitle(undefined);
        bashTools.current.clear();
        bashToolsProcessedIdx.current = 0;

        // Restore the plan slug for the new session so getPlan() finds the file
        if (oldPlanSlug) {
          setPlanSlug(getSessionId(), oldPlanSlug);
        }
      }

      // Atomically clear the initial message and apply permission mode/rules.
      setAppState(prev => {
        // Build and apply permission updates (mode + allowedPrompts rules)
        let updatedToolPermissionContext = initialMsg.mode ? applyPermissionUpdatesToLiveContext(prev.toolPermissionContext, buildPermissionUpdates(initialMsg.mode, initialMsg.allowedPrompts)) : prev.toolPermissionContext;
        // For auto, override the mode (buildPermissionUpdates maps
        // it to 'default' via toExternalPermissionMode) and strip dangerous rules
        if (feature('TRANSCRIPT_CLASSIFIER') && initialMsg.mode === 'auto') {
          updatedToolPermissionContext = stripDangerousPermissionsForAutoMode({
            ...updatedToolPermissionContext,
            mode: 'auto',
            prePlanMode: undefined
          });
        }
        return {
          ...prev,
          initialMessage: null,
          toolPermissionContext: updatedToolPermissionContext
        };
      });

      // Create file history snapshot for code rewind
      if (fileHistoryEnabled()) {
        void fileHistoryMakeSnapshot((updater: (prev: FileHistoryState) => FileHistoryState) => {
          setAppState(prev => ({
            ...prev,
            fileHistory: updater(prev.fileHistory)
          }));
        }, initialMsg.message.uuid);
      }

      // Ensure SessionStart hook context is available before the first API
      // call. onSubmit calls this internally but the onQuery path below
      // bypasses onSubmit — hoist here so both paths see hook messages.
      await awaitPendingHooks();

      // Route all initial prompts through onSubmit to ensure UserPromptSubmit hooks fire
      // TODO: Simplify by always routing through onSubmit once it supports
      // ContentBlockParam arrays (images) as input
      const content = initialMsg.message.message.content;

      // Route all string content through onSubmit to ensure hooks fire
      // For complex content (images, etc.), fall back to direct onQuery
      // Plan messages bypass onSubmit to preserve planContent metadata for rendering
      if (typeof content === 'string' && !initialMsg.message.planContent) {
        // Route through onSubmit for proper processing including UserPromptSubmit hooks
        void onSubmit(content, {
          setCursorOffset: () => { },
          clearBuffer: () => { },
          resetHistory: () => { }
        }, undefined, {
          allowInterruptionCorrection: false
        });
      } else {
        // Plan messages or complex content (images, etc.) - send directly to model
        // Plan messages use onQuery to preserve planContent metadata for rendering
        // TODO: Once onSubmit supports ContentBlockParam arrays, remove this branch
        const newAbortController = createAbortController();
        setAbortController(newAbortController);
        void onQuery([initialMsg.message], newAbortController, true,
          // shouldQuery
          [],
          // additionalAllowedTools
          mainLoopModel);
      }

      // Reset ref after a delay to allow new initial messages
      setTimeout(ref => {
        ref.current = false;
      }, 100, initialMessageRef);
    }
    void processInitialMessage(pending);
  }, [initialMessage, isLoading, setMessages, setAppState, onQuery, mainLoopModel, tools, resetAutoCompactTracking]);
  const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers, speculationAccept?: {
    state: ActiveSpeculationState;
    speculationSessionTimeSavedMs: number;
    setAppState: SetAppState;
  }, options?: {
    fromKeybinding?: boolean;
    slashCommandOverride?: Command;
    allowInterruptionCorrection?: boolean;
    inputModeOverride?: PromptInputMode;
  }) => {
    const effectiveInputMode = options?.inputModeOverride ?? inputMode;
    // Re-pin scroll to bottom on submit so the user always sees the new
    // exchange (matches OpenCode's auto-scroll behavior).
    repinScroll();

    // Resume loop mode if paused
    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.resumeProactive();
    }

    // Handle immediate commands - these bypass the queue and execute right away
    // even while Claude is processing. Commands opt-in via `immediate: true`.
    // Commands triggered via keybindings are always treated as immediate.
    if (!speculationAccept && input.trim().startsWith('/')) {
      // Expand [Pasted text #N] refs so immediate commands (e.g. /btw) receive
      // the pasted content, not the placeholder. The non-immediate path gets
      // this expansion later in handlePromptSubmit.
      const trimmedInput = expandPastedTextRefs(input, pastedContents).trim();
      const spaceIndex = trimmedInput.indexOf(' ');
      const commandName = spaceIndex === -1 ? trimmedInput.slice(1) : trimmedInput.slice(1, spaceIndex);
      const commandArgs = spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim();

      // Find matching command - treat as immediate if:
      // 1. Command has `immediate: true`, OR
      // 2. Command was triggered via keybinding (fromKeybinding option)
      const matchingCommand = commands.find(cmd => isCommandEnabled(cmd) && (cmd.name === commandName || cmd.aliases?.includes(commandName) || getCommandName(cmd) === commandName));
      if (matchingCommand?.name === 'clear' && idleHintShownRef.current) {
        logEvent('tengu_idle_return_action', {
          action: 'hint_converted' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          variant: idleHintShownRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          idleMinutes: Math.round((Date.now() - lastQueryCompletionTimeRef.current) / 60_000),
          messageCount: messagesRef.current.length,
          totalInputTokens: getTotalInputTokens()
        });
        idleHintShownRef.current = false;
      }
      const shouldTreatAsImmediate = queryGuard.isActive && (matchingCommand?.immediate || options?.fromKeybinding);
      if (matchingCommand && shouldTreatAsImmediate && matchingCommand.type === 'local-jsx') {
        // Only clear input if the submitted text matches what's in the prompt.
        // When a command keybinding fires, input is "/<command>" but the actual
        // input value is the user's existing text - don't clear it in that case.
        if (input.trim() === inputValueRef.current.trim()) {
          setInputValue('');
          helpers.setCursorOffset(0);
          helpers.clearBuffer();
          setPastedContents({});
        }
        const pastedTextRefs = parseReferences(input).filter(r => pastedContents[r.id]?.type === 'text');
        const pastedTextCount = pastedTextRefs.length;
        const pastedTextBytes = pastedTextRefs.reduce((sum, r) => sum + (pastedContents[r.id]?.content.length ?? 0), 0);
        logEvent('tengu_paste_text', {
          pastedTextCount,
          pastedTextBytes
        });
        logEvent('tengu_immediate_command_executed', {
          commandName: matchingCommand.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fromKeybinding: options?.fromKeybinding ?? false
        });

        // Execute the command directly
        const executeImmediateCommand = async (): Promise<void> => {
          let doneWasCalled = false;
          const onDone = (result?: string, doneOptions?: {
            display?: CommandResultDisplay;
            metaMessages?: string[];
          }): void => {
            doneWasCalled = true;
            setToolJSX({
              jsx: null,
              shouldHidePromptInput: false,
              clearLocalJSX: true
            });
            const newMessages: MessageType[] = [];
            if (result && doneOptions?.display !== 'skip') {
              addNotification({
                key: `immediate-${matchingCommand.name}`,
                text: result,
                priority: 'immediate'
              });
              // In fullscreen the command just showed as a centered modal
              // pane — the notification above is enough feedback. Adding
              // "❯ /config" + "└ dismissed" to the transcript is clutter
              // (those messages are type:system subtype:local_command —
              // user-visible but NOT sent to the model, so skipping them
              // doesn't change model context). Outside fullscreen the
              // transcript entry stays so scrollback shows what ran.
              if (!isFullscreenEnvEnabled()) {
                newMessages.push(createCommandInputMessage(formatCommandInputTags(getCommandName(matchingCommand), commandArgs)), createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result)}</${LOCAL_COMMAND_STDOUT_TAG}>`));
              }
            }
            // Inject meta messages (model-visible, user-hidden) into the transcript
            if (doneOptions?.metaMessages?.length) {
              newMessages.push(...doneOptions.metaMessages.map(content => createUserMessage({
                content,
                isMeta: true
              })));
            }
            if (newMessages.length) {
              setMessages(prev => [...prev, ...newMessages]);
            }
            // Restore stashed prompt after local-jsx command completes.
            // The normal stash restoration path (below) is skipped because
            // local-jsx commands return early from onSubmit.
            if (stashedPrompt !== undefined) {
              setInputValue(stashedPrompt.text);
              helpers.setCursorOffset(stashedPrompt.cursorOffset);
              setPastedContents(stashedPrompt.pastedContents);
              setStashedPrompt(undefined);
            }
          };

          // Build context for the command (reuses existing getToolUseContext).
          // Read messages via ref to keep onSubmit stable across message
          // updates — matches the pattern at L2384/L2400/L2662 and avoids
          // pinning stale REPL render scopes in downstream closures.
          const context = getToolUseContext(messagesRef.current, [], createAbortController(), mainLoopModel);
          const mod = await matchingCommand.load();
          const jsx = await mod.call(onDone, context, commandArgs);

          // Skip if onDone already fired — prevents stuck isLocalJSXCommand
          // (see processSlashCommand.tsx local-jsx case for full mechanism).
          if (jsx && !doneWasCalled) {
            // shouldHidePromptInput: false keeps Notifications mounted
            // so the onDone result isn't lost
            setToolJSX({
              jsx,
              shouldHidePromptInput: false,
              isLocalJSXCommand: true
            });
          }
        };
        void executeImmediateCommand();
        return; // Always return early - don't add to history or queue
      }
    }

    // Remote mode: skip empty input early before any state mutations
    if (activeRemote.isRemoteMode && !input.trim()) {
      return;
    }

    // Idle-return: prompt returning users to start fresh when the
    // conversation is large and the cache is cold. tengu_willow_mode
    // controls treatment: "dialog" (blocking), "hint" (notification), "off".
    {
      const willowMode = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
      const idleThresholdMin = Number(process.env.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES ?? 75);
      const tokenThreshold = Number(process.env.CLAUDE_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000);
      if (willowMode !== 'off' && !getGlobalConfig().idleReturnDismissed && !skipIdleCheckRef.current && !speculationAccept && !input.trim().startsWith('/') && lastQueryCompletionTimeRef.current > 0 && getTotalInputTokens() >= tokenThreshold) {
        const idleMs = Date.now() - lastQueryCompletionTimeRef.current;
        const idleMinutes = idleMs / 60_000;
        if (idleMinutes >= idleThresholdMin && willowMode === 'dialog') {
          setIdleReturnPending({
            input,
            idleMinutes
          });
          setInputValue('');
          helpers.setCursorOffset(0);
          helpers.clearBuffer();
          return;
        }
      }
    }

    // Add to history for direct user submissions.
    // Queued command processing (executeQueuedInput) doesn't call onSubmit,
    // so notifications and already-queued user input won't be added to history here.
    // Skip history for keybinding-triggered commands (user didn't type the command).
    if (!options?.fromKeybinding) {
      addToHistory({
        display: speculationAccept ? input : prependModeCharacterToInput(input, effectiveInputMode),
        pastedContents: speculationAccept ? {} : pastedContents
      });
      // Add the just-submitted command to the front of the ghost-text
      // cache so it's suggested immediately (not after the 60s TTL).
      if (effectiveInputMode === 'bash') {
        prependToShellHistoryCache(input.trim());
      }
    }

    // Restore stash if present, but NOT for slash commands or when loading.
    // - Slash commands (especially interactive ones like /model, /context) hide
    //   the prompt and show a picker UI. Restoring the stash during a command would
    //   place the text in a hidden input, and the user would lose it by typing the
    //   next command. Instead, preserve the stash so it survives across command runs.
    // - When loading, the submitted input will be queued and handlePromptSubmit
    //   will clear the input field (onInputChange('')), which would clobber the
    //   restored stash. Defer restoration to after handlePromptSubmit (below).
    //   Remote mode is exempt: it sends via WebSocket and returns early without
    //   calling handlePromptSubmit, so there's no clobbering risk — restore eagerly.
    // In both deferred cases, the stash is restored after await handlePromptSubmit.
    const isSlashCommand = !speculationAccept && input.trim().startsWith('/');
    // Submit runs "now" (not queued) when not already loading, or when
    // accepting speculation, or in remote mode (which sends via WS and
    // returns early without calling handlePromptSubmit).
    const submitsNow = !isLoading || speculationAccept || activeRemote.isRemoteMode;
    if (stashedPrompt !== undefined && !isSlashCommand && submitsNow) {
      setInputValue(stashedPrompt.text);
      helpers.setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    } else if (submitsNow) {
      if (!options?.fromKeybinding) {
        // Clear input when not loading or accepting speculation.
        // Preserve input for keybinding-triggered commands.
        setInputValue('');
        helpers.setCursorOffset(0);
      }
      setPastedContents({});
    }
    if (submitsNow) {
      setInputMode('prompt');
      setIDESelection(undefined);
      setSubmitCount(_ => _ + 1);
      if (isBuddyEnabled() && !isSlashCommand && effectiveInputMode === 'prompt') {
        // Change token for the companion's signature action (one Enter = one
        // shot; queued messages intentionally don't re-fire on dequeue).
        // Real prompts only — slash commands and bash lines aren't "sending
        // a message" and shouldn't launch projectiles.
        setAppState(prev => ({ ...prev, companionShotAt: Date.now() }));
      }
      helpers.clearBuffer();
      tipPickedThisTurnRef.current = false;

      // Show the placeholder in the same React batch as setInputValue('').
      // Skip for slash/bash (they have their own echo), speculation and remote
      // mode (both setMessages directly with no gap to bridge).
      if (!isSlashCommand && effectiveInputMode === 'prompt' && !speculationAccept && !activeRemote.isRemoteMode) {
        setUserInputOnProcessing(input);
        // showSpinner includes userInputOnProcessing, so the spinner appears
        // on this render. Reset timing refs now (before queryGuard.reserve()
        // would) so elapsed time doesn't read as Date.now() - 0. The
        // isQueryActive transition above does the same reset — idempotent.
        resetTimingRefs();
      }

      // Increment prompt count for attribution tracking and save snapshot
      // The snapshot persists promptCount so it survives compaction
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`);
            });
          })
        }));
      }
    }

    // Handle speculation acceptance
    if (speculationAccept) {
      const {
        queryRequired
      } = await handleSpeculationAccept(speculationAccept.state, speculationAccept.speculationSessionTimeSavedMs, speculationAccept.setAppState, input, {
        setMessages,
        readFileState,
        cwd: getOriginalCwd()
      });
      if (queryRequired) {
        const newAbortController = createAbortController();
        setAbortController(newAbortController);
        void onQuery([], newAbortController, true, [], mainLoopModel);
      }
      return;
    }

    // Remote mode: send input via stream-json instead of local query.
    // Permission requests from the remote are bridged into toolUseConfirmQueue
    // and rendered using the standard PermissionRequest component.
    //
    // local-jsx slash commands (e.g. /agents, /config) render UI in THIS
    // process — they have no remote equivalent. Let those fall through to
    // handlePromptSubmit so they execute locally. Prompt commands and
    // plain text go to the remote.
    if (activeRemote.isRemoteMode && !(isSlashCommand && commands.find(c => {
      const name = input.trim().slice(1).split(/\s/)[0];
      return isCommandEnabled(c) && (c.name === name || c.aliases?.includes(name!) || getCommandName(c) === name);
    })?.type === 'local-jsx')) {
      // Build content blocks when there are pasted attachments (images)
      const pastedValues = Object.values(pastedContents);
      const imageContents = pastedValues.filter(c => c.type === 'image');
      const imagePasteIds = imageContents.length > 0 ? imageContents.map(c => c.id) : undefined;
      let messageContent: string | ContentBlockParam[] = input.trim();
      let remoteContent: RemoteMessageContent = input.trim();
      if (pastedValues.length > 0) {
        const contentBlocks: ContentBlockParam[] = [];
        const remoteBlocks: Array<{
          type: string;
          [key: string]: unknown;
        }> = [];
        const trimmedInput = input.trim();
        if (trimmedInput) {
          contentBlocks.push({
            type: 'text',
            text: trimmedInput
          });
          remoteBlocks.push({
            type: 'text',
            text: trimmedInput
          });
        }
        for (const pasted of pastedValues) {
          if (pasted.type === 'image') {
            const source = {
              type: 'base64' as const,
              media_type: (pasted.mediaType ?? 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: pasted.content
            };
            contentBlocks.push({
              type: 'image',
              source
            });
            remoteBlocks.push({
              type: 'image',
              source
            });
          } else {
            contentBlocks.push({
              type: 'text',
              text: pasted.content
            });
            remoteBlocks.push({
              type: 'text',
              text: pasted.content
            });
          }
        }
        messageContent = contentBlocks;
        remoteContent = remoteBlocks;
      }

      // Create and add user message to UI
      // Note: empty input already handled by early return above
      const userMessage = createUserMessage({
        content: messageContent,
        imagePasteIds
      });
      setMessages(prev => [...prev, userMessage]);

      // Send to remote session
      await activeRemote.sendMessage(remoteContent, {
        uuid: userMessage.uuid
      });
      return;
    }

    // Ensure SessionStart hook context is available before the first API call.
    await awaitPendingHooks();
    await handlePromptSubmit({
      input,
      helpers,
      queryGuard,
      isExternalLoading,
      mode: effectiveInputMode,
      commands,
      onInputChange: setInputValue,
      setPastedContents,
      setToolJSX,
      getToolUseContext,
      messages: messagesRef.current,
      mainLoopModel,
      pastedContents,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      abortController,
      onQuery,
      setAppState,
      querySource: getQuerySourceForREPL(),
      onBeforeQuery,
      canUseTool,
      addNotification,
      setMessages,
      slashCommandOverride: options?.slashCommandOverride,
      allowInterruptionCorrection: options?.allowInterruptionCorrection,
      takeInterruptionCorrectionReminder,
      restoreInterruptionCorrectionReminder,
      // Read via ref so streamMode can be dropped from onSubmit deps —
      // handlePromptSubmit only uses it for debug log + telemetry event.
      streamMode: streamModeRef.current,
      hasInterruptibleToolInProgress: hasInterruptibleToolInProgressRef.current
    });

    // Restore stash that was deferred above. Two cases:
    // - Slash command: handlePromptSubmit awaited the full command execution
    //   (including interactive pickers). Restoring now places the stash back in
    //   the visible input.
    // - Loading (queued): handlePromptSubmit enqueued + cleared input, then
    //   returned quickly. Restoring now places the stash back after the clear.
    if ((isSlashCommand || isLoading) && stashedPrompt !== undefined) {
      setInputValue(stashedPrompt.text);
      helpers.setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    }
  }, [queryGuard,
    // isLoading is read at the !isLoading checks above for input-clearing
    // and submitCount gating. It's derived from isQueryActive || isExternalLoading,
    // so including it here ensures the closure captures the fresh value.
    isLoading, isExternalLoading, inputMode, commands, setInputValue, setInputMode, setPastedContents, setSubmitCount, setIDESelection, setToolJSX, getToolUseContext,
    // messages is read via messagesRef.current inside the callback to
    // keep onSubmit stable across message updates (see L2384/L2400/L2662).
    // Without this, each setMessages call (~30× per turn) recreates
    // onSubmit, pinning the REPL render scope (1776B) + that render's
    // messages array in downstream closures (PromptInput, handleAutoRunIssue).
    // Heap analysis showed ~9 REPL scopes and ~15 messages array versions
    // accumulating after #20174/#20175, all traced to this dep.
    mainLoopModel, pastedContents, ideSelection, setUserInputOnProcessing, setAbortController, addNotification, onQuery, stashedPrompt, setStashedPrompt, setAppState, onBeforeQuery, canUseTool, remoteSession, setMessages, awaitPendingHooks, repinScroll, takeInterruptionCorrectionReminder, restoreInterruptionCorrectionReminder]);

  // Callback for when user submits input while viewing a teammate's transcript
  const onAgentSubmit = useCallback(async (input: string, task: InProcessTeammateTaskState | LocalAgentTaskState, helpers: PromptInputHelpers) => {
    if (isLocalAgentTask(task)) {
      appendMessageToLocalAgent(task.id, createUserMessage({
        content: input
      }), setAppState);
      if (task.status === 'running') {
        queuePendingMessage(task.id, input, setAppState);
      } else {
        void resumeAgentBackground({
          agentId: task.id,
          prompt: input,
          toolUseContext: getToolUseContext(messagesRef.current, [], new AbortController(), mainLoopModel),
          canUseTool
        }).catch(err => {
          logForDebugging(`resumeAgentBackground failed: ${errorMessage(err)}`);
          addNotification({
            key: `resume-agent-failed-${task.id}`,
            jsx: <Text color="error">
              Failed to resume agent: {errorMessage(err)}
            </Text>,
            priority: 'low'
          });
        });
      }
    } else {
      injectUserMessageToTeammate(task.id, input, setAppState);
    }
    setInputValue('');
    helpers.setCursorOffset(0);
    helpers.clearBuffer();
  }, [setAppState, setInputValue, getToolUseContext, canUseTool, mainLoopModel, addNotification]);

  // Handlers for auto-run /issue or /good-claude (defined after onSubmit)
  const handleAutoRunIssue = useCallback(() => {
    const command = autoRunIssueReason ? getAutoRunCommand(autoRunIssueReason) : '/issue';
    setAutoRunIssueReason(null); // Clear the state
    onSubmit(command, {
      setCursorOffset: () => { },
      clearBuffer: () => { },
      resetHistory: () => { }
    }).catch(err => {
      logForDebugging(`Auto-run ${command} failed: ${errorMessage(err)}`);
    });
  }, [onSubmit, autoRunIssueReason]);
  const handleCancelAutoRunIssue = useCallback(() => {
    setAutoRunIssueReason(null);
  }, []);

  // onSubmit is unstable (deps include `messages` which changes every turn).
  // `handleOpenRateLimitOptions` is prop-drilled to every MessageRow, and each
  // MessageRow fiber pins the closure (and transitively the entire REPL render
  // scope, ~1.8KB) at mount time. Using a ref keeps this callback stable so
  // old REPL scopes can be GC'd — saves ~35MB over a 1000-turn session.
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const handleOpenRateLimitOptions = useCallback(() => {
    void onSubmitRef.current('/rate-limit-options', {
      setCursorOffset: () => { },
      clearBuffer: () => { },
      resetHistory: () => { }
    });
  }, []);
  const handleExit = useCallback(async () => {
    setIsExiting(true);
    // In bg sessions, always detach instead of kill — even when a worktree is
    // active. Without this guard, the worktree branch below short-circuits into
    // ExitFlow (which calls gracefulShutdown) before exit.tsx is ever loaded.
    if (feature('BG_SESSIONS') && isBgSession()) {
      spawnSync('tmux', ['detach-client'], {
        stdio: 'ignore'
      });
      setIsExiting(false);
      return;
    }
    const showWorktree = getCurrentWorktreeSession() !== null;
    if (showWorktree) {
      setExitFlow(<ExitFlow showWorktree onDone={() => { }} onCancel={() => {
        setExitFlow(null);
        setIsExiting(false);
      }} />);
      return;
    }
    const exitMod = await exit.load();
    const exitFlowResult = await exitMod.call(() => { });
    setExitFlow(exitFlowResult);
    // If call() returned without killing the process (bg session detach),
    // clear isExiting so the UI is usable on reattach. No-op on the normal
    // path — gracefulShutdown's process.exit() means we never get here.
    if (exitFlowResult === null) {
      setIsExiting(false);
    }
  }, []);
  const handleShowMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible(prev => !prev);
  }, []);

  // Rewind conversation state to just before `message`: slice messages,
  // reset conversation ID, microcompact state, permission mode, prompt suggestion.
  // Does NOT touch the prompt input. Index is computed from messagesRef (always
  // fresh via the setMessages wrapper) so callers don't need to worry about
  // stale closures.
  const rewindConversationTo = useCallback((message: UserMessage, {
    preserveInterruptionCorrectionReminder = false
  }: {
    preserveInterruptionCorrectionReminder?: boolean;
  } = {}) => {
    const prev = messagesRef.current;
    const messageIndex = applyInterruptionCorrectionAutoRestore(prev, message, setMessages, interruptionCorrectionTracker, preserveInterruptionCorrectionReminder);
    if (messageIndex === null) return;
    logEvent('tengu_conversation_rewind', {
      preRewindMessageCount: prev.length,
      postRewindMessageCount: messageIndex,
      messagesRemoved: prev.length - messageIndex,
      rewindToMessageIndex: messageIndex
    });
    resetAutoCompactTracking();
    // Careful, this has to happen after setMessages
    setConversationId(randomUUID());
    // Reset cached microcompact state so stale pinned cache edits
    // don't reference tool_use_ids from truncated messages
    resetMicrocompactState();
    if (feature('CONTEXT_COLLAPSE')) {
      // Rewind truncates the REPL array. Commits whose archived span
      // was past the rewind point can't be projected anymore
      // (projectView silently skips them) but the staged queue and ID
      // maps reference stale uuids. Simplest safe reset: drop
      // everything. The ctx-agent will re-stage on the next
      // threshold crossing.
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;
      (require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js')).resetContextCollapse();
      /* eslint-enable @typescript-eslint/no-require-imports */
    }

    // Restore state from the message we're rewinding to.
    // Dangerous modes are never restored from rewind snapshots.
    const rewindRestorablePermissionMode = message.permissionMode && !isDangerousPermissionMode(message.permissionMode) ? message.permissionMode : undefined;
    setAppState(prev => ({
      ...prev,
      // Restore permission mode from the message
      toolPermissionContext: rewindRestorablePermissionMode && prev.toolPermissionContext.mode !== rewindRestorablePermissionMode ? {
        ...prev.toolPermissionContext,
        mode: rewindRestorablePermissionMode
      } : prev.toolPermissionContext,
      // Clear stale prompt suggestion from previous conversation state
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      }
    }));
  }, [setMessages, resetAutoCompactTracking, setAppState, interruptionCorrectionTracker, setConversationId]);

  // Synchronous rewind + input population. Used directly by auto-restore on
  // interrupt (so React batches with the abort's setMessages → single render,
  // no flicker). MessageSelector wraps this in setImmediate via handleRestoreMessage.
  const restoreMessageSync = useCallback((message: UserMessage, options?: {
    preserveInterruptionCorrectionReminder?: boolean;
  }) => {
    rewindConversationTo(message, options);
    const r = textForResubmit(message);
    if (r) {
      setInputValue(r.text);
      setInputMode(r.mode);
    }

    // Restore pasted images
    if (Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'image')) {
      const imageBlocks: Array<ImageBlockParam> = message.message.content.filter(block => block.type === 'image');
      if (imageBlocks.length > 0) {
        const newPastedContents: Record<number, PastedContent> = {};
        imageBlocks.forEach((block, index) => {
          if (block.source.type === 'base64') {
            const id = message.imagePasteIds?.[index] ?? index + 1;
            newPastedContents[id] = {
              id,
              type: 'image',
              content: block.source.data,
              mediaType: block.source.media_type
            };
          }
        });
        setPastedContents(newPastedContents);
      }
    }
  }, [rewindConversationTo, setInputValue, setInputMode]);
  restoreMessageSyncRef.current = restoreMessageSync;

  // MessageSelector path: defer via setImmediate so the "Interrupted" message
  // renders to static output before rewind — otherwise it remains vestigial
  // at the top of the screen.
  const handleRestoreMessage = useCallback(async (message: UserMessage) => {
    setImmediate((restore, message) => restore(message), restoreMessageSync, message);
  }, [restoreMessageSync]);

  // Not memoized — hook stores caps via ref, reads latest closure at dispatch.
  // 24-char prefix: deriveUUID preserves first 24, renderable uuid prefix-matches raw source.
  const findRawIndex = (uuid: string) => {
    const prefix = uuid.slice(0, 24);
    return messages.findIndex(m => m.uuid.slice(0, 24) === prefix);
  };
  const messageActionCaps: MessageActionCaps = {
    copy: text =>
      // setClipboard RETURNS OSC 52 — caller must stdout.write (tmux side-effects load-buffer, but that's tmux-only).
      void setClipboard(text).then(raw => {
        if (raw) process.stdout.write(raw);
        addNotification({
          // Same key as text-selection copy — repeated copies replace toast, don't queue.
          key: 'selection-copied',
          text: 'copied',
          color: 'success',
          priority: 'immediate',
          timeoutMs: 2000
        });
      }),
    edit: async msg => {
      // Same skip-confirm check as /rewind: lossless → direct, else confirm dialog.
      const rawIdx = findRawIndex(msg.uuid);
      const raw = rawIdx >= 0 ? messages[rawIdx] : undefined;
      if (!raw || !selectableUserMessagesFilter(raw)) return;
      const noFileChanges = !(await fileHistoryHasAnyChanges(fileHistory, raw.uuid));
      const onlySynthetic = messagesAfterAreOnlySynthetic(messages, rawIdx);
      if (noFileChanges && onlySynthetic) {
        // rewindConversationTo's setMessages races stream appends — cancel first (idempotent).
        onCancel();
        // handleRestoreMessage also restores pasted images.
        void handleRestoreMessage(raw);
      } else {
        // Dialog path: onPreRestore (= onCancel) fires when user CONFIRMS, not on nevermind.
        setMessageSelectorPreselect(raw);
        setIsMessageSelectorVisible(true);
      }
    }
  };
  const {
    enter: enterMessageActions,
    handlers: messageActionHandlers
  } = useMessageActions(cursor, setCursor, cursorNavRef, messageActionCaps);
  async function onInit() {
    // Always verify API key on startup, so we can show the user an error in the
    // bottom right corner of the screen if the API key is invalid.
    void reverify();

    // Populate readFileState with CLAUDE.md files at startup
    const memoryFiles = await getMemoryFiles();
    if (memoryFiles.length > 0) {
      const fileList = memoryFiles.map(f => `  [${f.type}] ${f.path} (${f.content.length} chars)${f.parent ? ` (included by ${f.parent})` : ''}`).join('\n');
      logForDebugging(`Loaded ${memoryFiles.length} CLAUDE.md/rules files:\n${fileList}`);
    } else {
      logForDebugging('No CLAUDE.md/rules files found');
    }
    for (const file of memoryFiles) {
      // When the injected content doesn't match disk (stripped HTML comments,
      // stripped frontmatter, MEMORY.md truncation), cache the RAW disk bytes
      // with isPartialView so Edit/Write require a real Read first while
      // getChangedFiles + nested_memory dedup still work.
      readFileState.current.set(file.path, {
        content: file.contentDiffersFromDisk ? file.rawContent ?? file.content : file.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: file.contentDiffersFromDisk
      });
    }

    // Initial message handling is done via the initialMessage effect
  }

  // Register cost summary tracker
  useCostSummary(useFpsMetrics());

  // Record transcripts locally, for debugging and conversation recovery
  // Don't record conversation if we only have initial messages; optimizes
  // the case where user resumes a conversation then quites before doing
  // anything else
  useLogMessages(messages, messages.length === initialMessages?.length);

  // REPL Bridge: replicate user/assistant messages to the bridge session
  // for remote access via claude.ai. No-op in external builds or when not enabled.
  const {
    sendBridgeResult
  } = useReplBridge(messages, setMessages, abortControllerRef, commands, mainLoopModel);
  sendBridgeResultRef.current = sendBridgeResult;
  useAfterFirstRender();

  // Track prompt queue usage for analytics. Fire once per transition from
  // empty to non-empty, not on every length change -- otherwise a render loop
  // (concurrent onQuery thrashing, etc.) spams saveGlobalConfig, which hits
  // ELOCKED under concurrent sessions and falls back to unlocked writes.
  // That write storm is the primary trigger for ~/.openclaude.json corruption
  // (GH #3117).
  const hasCountedQueueUseRef = useRef(false);
  useEffect(() => {
    if (queuedCommands.length < 1) {
      hasCountedQueueUseRef.current = false;
      return;
    }
    if (hasCountedQueueUseRef.current) return;
    hasCountedQueueUseRef.current = true;
    // Loss-tolerant analytics counter. Deferring it coalesces the write so a
    // render loop (see comment above) can no longer drive the lock contention
    // that triggers GH #3117.
    saveGlobalConfigDeferred(current => ({
      ...current,
      promptQueueUseCount: (current.promptQueueUseCount ?? 0) + 1
    }));
  }, [queuedCommands.length]);

  // Process queued commands when query completes and queue has items

  const executeQueuedInput = useCallback(async (queuedCommands: QueuedCommand[]) => {
    await handlePromptSubmit({
      helpers: {
        setCursorOffset: () => { },
        clearBuffer: () => { },
        resetHistory: () => { }
      },
      queryGuard,
      commands,
      onInputChange: () => { },
      setPastedContents: () => { },
      setToolJSX,
      getToolUseContext,
      messages,
      mainLoopModel,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      onQuery,
      setAppState,
      querySource: getQuerySourceForREPL(),
      onBeforeQuery,
      canUseTool,
      addNotification,
      setMessages,
      takeInterruptionCorrectionReminder,
      restoreInterruptionCorrectionReminder,
      queuedCommands
    });
  }, [queryGuard, commands, setToolJSX, getToolUseContext, messages, mainLoopModel, ideSelection, setUserInputOnProcessing, canUseTool, setAbortController, onQuery, addNotification, setAppState, onBeforeQuery, takeInterruptionCorrectionReminder, restoreInterruptionCorrectionReminder]);
  useQueueProcessor({
    executeQueuedInput,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    queryGuard
  });

  // We'll use the global lastInteractionTime from state.ts

  // Update last interaction time when input changes.
  // Must be immediate because useEffect runs after the Ink render cycle flush.
  useEffect(() => {
    activityManager.recordUserActivity();
    updateLastInteractionTime(true);
  }, [inputValue, submitCount]);
  useEffect(() => {
    if (submitCount === 1) {
      startBackgroundHousekeeping();
    }
  }, [submitCount]);

  // Show notification when Claude is done responding and user is idle
  useEffect(() => {
    // Don't set up notification if Claude is busy
    if (isLoading) return;

    // Only enable notifications after the first new interaction in this session
    if (submitCount === 0) return;

    // No query has completed yet
    if (lastQueryCompletionTime === 0) return;

    // Set timeout to check idle state
    const timer = setTimeout((lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal) => {
      // Check if user has interacted since the response ended
      const lastUserInteraction = getLastInteractionTime();
      if (lastUserInteraction > lastQueryCompletionTime) {
        // User has interacted since Claude finished - they're not idle, don't notify
        return;
      }

      // User hasn't interacted since response ended, check other conditions
      const idleTimeSinceResponse = Date.now() - lastQueryCompletionTime;
      if (!isLoading && !toolJSX &&
        // Use ref to get current dialog state, avoiding stale closure
        focusedInputDialogRef.current === undefined && idleTimeSinceResponse >= getGlobalConfig().messageIdleNotifThresholdMs) {
        void sendNotification({
          message: 'Claude is waiting for your input',
          notificationType: 'idle_prompt'
        }, terminal);
      }
    }, getGlobalConfig().messageIdleNotifThresholdMs, lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal);
    return () => clearTimeout(timer);
  }, [isLoading, toolJSX, submitCount, lastQueryCompletionTime, terminal]);

  // Idle-return hint: show notification when idle threshold is exceeded.
  // Timer fires after the configured idle period; notification persists until
  // dismissed or the user submits.
  useEffect(() => {
    if (lastQueryCompletionTime === 0) return;
    if (isLoading) return;
    const willowMode: string = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
    if (willowMode !== 'hint' && willowMode !== 'hint_v2') return;
    if (getGlobalConfig().idleReturnDismissed) return;
    const tokenThreshold = Number(process.env.CLAUDE_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000);
    if (getTotalInputTokens() < tokenThreshold) return;
    const idleThresholdMs = Number(process.env.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES ?? 75) * 60_000;
    const elapsed = Date.now() - lastQueryCompletionTime;
    const remaining = idleThresholdMs - elapsed;
    const timer = setTimeout((lqct, addNotif, msgsRef, mode, hintRef) => {
      if (msgsRef.current.length === 0) return;
      const totalTokens = getTotalInputTokens();
      const formattedTokens = formatTokens(totalTokens);
      const idleMinutes = (Date.now() - lqct) / 60_000;
      addNotif({
        key: 'idle-return-hint',
        jsx: mode === 'hint_v2' ? <>
          <Text dimColor>new task? </Text>
          <Text color="suggestion">/clear</Text>
          <Text dimColor> to save </Text>
          <Text color="suggestion">{formattedTokens} tokens</Text>
        </> : <Text color="warning">
          new task? /clear to save {formattedTokens} tokens
        </Text>,
        priority: 'medium',
        // Persist until submit — the hint fires at T+75min idle, user may
        // not return for hours. removeNotification in useEffect cleanup
        // handles dismissal. 0x7FFFFFFF = setTimeout max (~24.8 days).
        timeoutMs: 0x7fffffff
      });
      hintRef.current = mode;
      logEvent('tengu_idle_return_action', {
        action: 'hint_shown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        variant: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        idleMinutes: Math.round(idleMinutes),
        messageCount: msgsRef.current.length,
        totalInputTokens: totalTokens
      });
    }, Math.max(0, remaining), lastQueryCompletionTime, addNotification, messagesRef, willowMode, idleHintShownRef);
    return () => {
      clearTimeout(timer);
      removeNotification('idle-return-hint');
      idleHintShownRef.current = false;
    };
  }, [lastQueryCompletionTime, isLoading, addNotification, removeNotification]);

  // Submits incoming prompts from teammate messages or tasks mode as new turns
  // Returns true if submission succeeded, false if a query is already running
  const handleIncomingPrompt = useCallback((content: string, options?: {
    isMeta?: boolean;
  }): boolean => {
    if (queryGuard.isActive) return false;

    // Defer to user-queued commands — user input always takes priority
    // over system messages (teammate messages, task list items, etc.)
    // Read from the module-level store at call time (not the render-time
    // snapshot) to avoid a stale closure — this callback's deps don't
    // include the queue.
    if (getCommandQueue().some(cmd => cmd.mode === 'prompt' || cmd.mode === 'bash')) {
      return false;
    }
    const newAbortController = createAbortController();
    setAbortController(newAbortController);

    // Create a user message with the formatted content (includes XML wrapper)
    const userMessage = createUserMessage({
      content,
      isMeta: options?.isMeta ? true : undefined
    });
    void onQuery([userMessage], newAbortController, true, [], mainLoopModel);
    return true;
  }, [onQuery, mainLoopModel, store]);

  // Voice input integration (VOICE_MODE builds only)
  const voice = feature('VOICE_MODE') ?
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useVoiceIntegration({
      setInputValueRaw,
      inputValueRef,
      insertTextRef
    }) : {
      stripTrailing: () => 0,
      handleKeyEvent: () => { },
      resetAnchor: () => { },
      interimRange: null
    };
  useInboxPoller({
    enabled: isAgentSwarmsEnabled(),
    isLoading,
    focusedInputDialog,
    onSubmitMessage: handleIncomingPrompt
  });
  useMailboxBridge({
    isLoading,
    onSubmitMessage: handleIncomingPrompt
  });

  // Scheduled tasks from .claude/scheduled_tasks.json (CronCreate/Delete/List)
  // and session-only /loop runs.
  const assistantMode = store.getState().kairosEnabled;
  useScheduledTasks({
    isLoading,
    assistantMode,
    setMessages
  });

  // Note: Permission polling is now handled by useInboxPoller
  // - Workers receive permission responses via mailbox messages
  // - Leaders receive permission requests via mailbox messages

  // Abort the current operation when a 'now' priority message arrives
  // (e.g. from a chat UI client via UDS).
  useEffect(() => {
    if (queuedCommands.some(cmd => cmd.priority === 'now')) {
      requestPriorityNowAbort(abortControllerRef);
    }
  }, [queuedCommands]);

  // Initial load
  useEffect(() => {
    void onInit();

    // Cleanup on unmount
    return () => {
      void diagnosticTracker.shutdown();
    };
    // TODO: fix this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for suspend/resume events
  const {
    internal_eventEmitter
  } = useStdin();
  const [remountKey, setRemountKey] = useState(0);
  useEffect(() => {
    const handleSuspend = () => {
      // Print suspension instructions
      process.stdout.write(`\nOpenClaude has been suspended. Run \`fg\` to bring OpenClaude back.\nNote: ctrl + z now suspends OpenClaude, ctrl + _ undoes input.\n`);
    };
    const handleResume = () => {
      // Force complete component tree replacement instead of terminal clear
      // Ink now handles line count reset internally on SIGCONT
      setRemountKey(prev => prev + 1);
    };
    internal_eventEmitter?.on('suspend', handleSuspend);
    internal_eventEmitter?.on('resume', handleResume);
    return () => {
      internal_eventEmitter?.off('suspend', handleSuspend);
      internal_eventEmitter?.off('resume', handleResume);
    };
  }, [internal_eventEmitter]);

  // Derive stop hook spinner suffix from messages state
  const stopHookSpinnerSuffix = useMemo(() => {
    if (!isLoading) return null;

    // Find stop hook progress messages
    const progressMsgs = messages.filter((m): m is ProgressMessage<HookProgress> => m.type === 'progress' && m.data.type === 'hook_progress' && (m.data.hookEvent === 'Stop' || m.data.hookEvent === 'SubagentStop'));
    if (progressMsgs.length === 0) return null;

    // Get the most recent stop hook execution
    const currentToolUseID = progressMsgs.at(-1)?.toolUseID;
    if (!currentToolUseID) return null;

    // Check if there's already a summary message for this execution (hooks completed)
    const hasSummaryForCurrentExecution = messages.some(m => m.type === 'system' && m.subtype === 'stop_hook_summary' && m.toolUseID === currentToolUseID);
    if (hasSummaryForCurrentExecution) return null;
    const currentHooks = progressMsgs.filter(p => p.toolUseID === currentToolUseID);
    const total = currentHooks.length;

    // Count completed hooks
    const completedCount = count(messages, m => {
      if (m.type !== 'attachment') return false;
      const attachment = m.attachment;
      return 'hookEvent' in attachment && (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') && 'toolUseID' in attachment && attachment.toolUseID === currentToolUseID;
    });

    // Check if any hook has a custom status message
    const customMessage = currentHooks.find(p => p.data.statusMessage)?.data.statusMessage;
    if (customMessage) {
      // Use custom message with progress counter if multiple hooks
      return total === 1 ? `${customMessage}…` : `${customMessage}… ${completedCount}/${total}`;
    }

    // Fall back to default behavior
    const hookType = currentHooks[0]?.data.hookEvent === 'SubagentStop' ? 'subagent stop' : 'stop';
    return total === 1 ? `running ${hookType} hook` : `running stop hooks… ${completedCount}/${total}`;
  }, [messages, isLoading]);

  // Callback to capture frozen state when entering transcript mode
  const handleEnterTranscript = useCallback(() => {
    setFrozenTranscriptState({
      messagesLength: messages.length,
      streamingToolUsesLength: streamingToolUses.length
    });
  }, [messages.length, streamingToolUses.length]);

  // Callback to clear frozen state when exiting transcript mode
  const handleExitTranscript = useCallback(() => {
    setFrozenTranscriptState(null);
  }, []);

  // Props for GlobalKeybindingHandlers component (rendered inside KeybindingSetup)
  const virtualScrollActive = isFullscreenEnvEnabled() && !disableVirtualScroll;

  // Transcript search state. Hooks must be unconditional so they live here
  // (not inside the `if (screen === 'transcript')` branch below); isActive
  // gates the useInput. Query persists across bar open/close so n/N keep
  // working after Enter dismisses the bar (less semantics).
  const jumpRef = useRef<JumpHandle | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCount, setSearchCount] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchCount(count);
    setSearchCurrent(current);
  }, []);
  useInput((input, key, event) => {
    if (key.ctrl || key.meta) return;
    // No Esc handling here — less has no navigating mode. Search state
    // (highlights, n/N) is just state. Esc/q/ctrl+c → transcript:exit
    // (ungated). Highlights clear on exit via the screen-change effect.
    if (input === '/') {
      // Capture scrollTop NOW — typing is a preview, 0-matches snaps
      // back here. Synchronous ref write, fires before the bar's
      // mount-effect calls setSearchQuery.
      jumpRef.current?.setAnchor();
      setSearchOpen(true);
      event.stopImmediatePropagation();
      return;
    }
    // Held-key batching: tokenizer coalesces to 'nnn'. Same uniform-batch
    // pattern as modalPagerAction in ScrollKeybindingHandler.tsx. Each
    // repeat is a step (n isn't idempotent like g).
    const c = input[0];
    if ((c === 'n' || c === 'N') && input === c.repeat(input.length) && searchCount > 0) {
      const fn = c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch;
      if (fn) for (let i = 0; i < input.length; i++) fn();
      event.stopImmediatePropagation();
    }
  },
    // Search needs virtual scroll (jumpRef drives VirtualMessageList). [
    // kills it, so !dumpMode — after [ there's nothing to jump in.
    {
      isActive: screen === 'transcript' && virtualScrollActive && !searchOpen && !dumpMode
    });
  const {
    setQuery: setHighlight,
    scanElement,
    setPositions
  } = useSearchHighlight();

  // Resize → abort search. Positions are (msg, query, WIDTH)-keyed —
  // cached positions are stale after a width change (new layout, new
  // wrapping). Clearing searchQuery triggers VML's setSearchQuery('')
  // which clears positionsCache + setPositions(null). Bar closes.
  // User hits / again → fresh everything.
  const transcriptCols = useTerminalSize().columns;
  const prevColsRef = React.useRef(transcriptCols);
  React.useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols;
      if (searchQuery || searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        setSearchCount(0);
        setSearchCurrent(0);
        jumpRef.current?.disarmSearch();
        setHighlight('');
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight]);

  // Transcript escape hatches. Bare letters in modal context (no prompt
  // competing for input) — same class as g/G/j/k in ScrollKeybindingHandler.
  useInput((input, key, event) => {
    if (key.ctrl || key.meta) return;
    if (input === 'q') {
      // less: q quits the pager. ctrl+o toggles; q is the lineage exit.
      handleExitTranscript();
      event.stopImmediatePropagation();
      return;
    }
    if (input === '[' && !dumpMode) {
      // Force dump-to-scrollback. Also expand + uncap — no point dumping
      // a subset. Terminal/tmux cmd-F can now find anything. Guard here
      // (not in isActive) so v still works post-[ — dump-mode footer at
      // ~4898 wires editorStatus, confirming v is meant to stay live.
      setDumpMode(true);
      setShowAllInTranscript(true);
      event.stopImmediatePropagation();
    } else if (input === 'v') {
      // less-style: v opens the file in $VISUAL/$EDITOR. Render the full
      // transcript (same path /export uses), write to tmp, hand off.
      // openFileInExternalEditor handles alt-screen suspend/resume for
      // terminal editors; GUI editors spawn detached.
      event.stopImmediatePropagation();
      // Drop double-taps: the render is async and a second press before it
      // completes would run a second parallel render (double memory, two
      // tempfiles, two editor spawns). editorGenRef only guards
      // transcript-exit staleness, not same-session concurrency.
      if (editorRenderingRef.current) return;
      editorRenderingRef.current = true;
      // Capture generation + make a staleness-aware setter. Each write
      // checks gen (transcript exit bumps it → late writes from the
      // async render go silent).
      const gen = editorGenRef.current;
      const setStatus = (s: string): void => {
        if (gen !== editorGenRef.current) return;
        clearTimeout(editorTimerRef.current);
        setEditorStatus(s);
      };
      setStatus(`rendering ${deferredMessages.length} messages…`);
      void (async () => {
        try {
          // Width = terminal minus vim's line-number gutter (4 digits +
          // space + slack). Floor at 80. PassThrough has no .columns so
          // without this Ink defaults to 80. Trailing-space strip: right-
          // aligned timestamps still leave a flexbox spacer run at EOL.
          // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- one-shot at keypress time, not a reactive render dep
          const w = Math.max(80, (process.stdout.columns ?? 80) - 6);
          const raw = await renderMessagesToPlainText(deferredMessages, tools, w);
          const text = raw.replace(/[ \t]+$/gm, '');
          const path = join(tmpdir(), `cc-transcript-${Date.now()}.txt`);
          await writeFile(path, text);
          const opened = openFileInExternalEditor(path);
          setStatus(opened ? `opening ${path}` : `wrote ${path} · no $VISUAL/$EDITOR set`);
        } catch (e) {
          setStatus(`render failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        editorRenderingRef.current = false;
        if (gen !== editorGenRef.current) return;
        editorTimerRef.current = setTimeout(s => s(''), 4000, setEditorStatus);
      })();
    }
  },
    // !searchOpen: typing 'v' or '[' in the search bar is search input, not
    // a command. No !dumpMode here — v should work after [ (the [ handler
    // guards itself inline).
    {
      isActive: screen === 'transcript' && virtualScrollActive && !searchOpen
    });

  // Fresh `less` per transcript entry. Prevents stale highlights matching
  // unrelated normal-mode text (overlay is alt-screen-global) and avoids
  // surprise n/N on re-entry. Same exit resets [ dump mode — each ctrl+o
  // entry is a fresh instance.
  const inTranscript = screen === 'transcript' && virtualScrollActive;
  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('');
      setSearchCount(0);
      setSearchCurrent(0);
      setSearchOpen(false);
      editorGenRef.current++;
      clearTimeout(editorTimerRef.current);
      setDumpMode(false);
      setEditorStatus('');
    }
  }, [inTranscript]);
  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '');
    // Clear the position-based CURRENT (yellow) overlay too. setHighlight
    // only clears the scan-based inverse. Without this, the yellow box
    // persists at its last screen coords after ctrl-c exits transcript.
    if (!inTranscript) setPositions(null);
  }, [inTranscript, searchQuery, setHighlight, setPositions]);
  const globalKeybindingProps = {
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    virtualScrollActive,
    // Bar-open is a mode (owns keystrokes — j/k type, Esc cancels).
    // Navigating (query set, bar closed) is NOT — Esc exits transcript,
    // same as less q with highlights still visible. useSearchInput
    // doesn't stopPropagation, so without this gate transcript:exit
    // would fire on the same Esc that cancels the bar (child registers
    // first, fires first, bubbles).
    searchBarOpen: searchOpen
  };

  // Use frozen lengths to slice arrays, avoiding memory overhead of cloning
  const transcriptMessages = frozenTranscriptState ? deferredMessages.slice(0, frozenTranscriptState.messagesLength) : deferredMessages;
  const transcriptStreamingToolUses = frozenTranscriptState ? streamingToolUses.slice(0, frozenTranscriptState.streamingToolUsesLength) : streamingToolUses;

  // Handle shift+down for teammate navigation and background task management.
  // Guard onOpenBackgroundTasks when a local-jsx dialog (e.g. /mcp) is open —
  // otherwise Shift+Down stacks BackgroundTasksDialog on top and deadlocks input.
  useBackgroundTaskNavigation({
    onOpenBackgroundTasks: isShowingLocalJSXCommand ? undefined : () => setShowBashesDialog(true)
  });
  // Auto-exit viewing mode when teammate completes or errors
  useTeammateViewAutoExit();
  if (screen === 'transcript') {
    // Virtual scroll replaces the 30-message cap: everything is scrollable
    // and memory is bounded by the viewport. Without it, wrapping transcript
    // in a ScrollBox would mount all messages (~250 MB on long sessions —
    // the exact problem), so the kill switch and non-fullscreen paths must
    // fall through to the legacy render: no alt screen, dump to terminal
    // scrollback, 30-cap + Ctrl+E. Reusing scrollRef is safe — normal-mode
    // and transcript-mode are mutually exclusive (this early return), so
    // only one ScrollBox is ever mounted at a time.
    const transcriptScrollRef = isFullscreenEnvEnabled() && !disableVirtualScroll && !dumpMode ? scrollRef : undefined;
    const transcriptMessagesElement = <Messages messages={transcriptMessages} tools={tools} commands={renderCommands} verbose={true} toolJSX={null} toolUseConfirmQueue={[]} inProgressToolUseIDs={inProgressToolUseIDs} isMessageSelectorVisible={false} conversationId={conversationId} screen={screen} agentDefinitions={agentDefinitions} streamingToolUses={transcriptStreamingToolUses} showAllInTranscript={showAllInTranscript} onOpenRateLimitOptions={handleOpenRateLimitOptions} isLoading={isLoading} hidePastThinking={true} streamingThinking={streamingThinking} scrollRef={transcriptScrollRef} jumpRef={jumpRef} onSearchMatchesChange={onSearchMatchesChange} scanElement={scanElement} setPositions={setPositions} disableRenderCap={dumpMode} />;
    const transcriptToolJSX = toolJSX && <Box flexDirection="column" width="100%">
      {toolJSX.jsx}
    </Box>;
    const transcriptReturn = <KeybindingSetup>
      <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={terminalTitle} disabled={titleDisabled} noPrefix={showStatusInTerminalTab} />
      <GlobalKeybindingHandlers {...globalKeybindingProps} />
      {feature('VOICE_MODE') ? <VoiceKeybindingHandler voiceHandleKeyEvent={voice.handleKeyEvent} stripTrailing={voice.stripTrailing} resetAnchor={voice.resetAnchor} isActive={!toolJSX?.isLocalJSXCommand} /> : null}
      <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
      {transcriptScrollRef ?
        // ScrollKeybindingHandler must mount before CancelRequestHandler so
        // ctrl+c-with-selection copies instead of cancelling the active task.
        // Its raw useInput handler only stops propagation when a selection
        // exists — without one, ctrl+c falls through to CancelRequestHandler.
        <ScrollKeybindingHandler scrollRef={scrollRef}
          // Yield wheel/ctrl+u/d to UltraplanChoiceDialog's own scroll
          // handler while the modal is showing.
          isActive={focusedInputDialog !== 'ultraplan-choice'}
          // g/G/j/k/ctrl+u/ctrl+d would eat keystrokes the search bar
          // wants. Off while searching.
          isModal={!searchOpen}
          // Manual scroll exits the search context — clear the yellow
          // current-match marker. Positions are (msg, rowOffset)-keyed;
          // j/k changes scrollTop so rowOffset is stale → wrong row
          // gets yellow. Next n/N re-establishes via step()→jump().
          onScroll={() => jumpRef.current?.disarmSearch()} /> : null}
      <CancelRequestHandler {...cancelRequestProps} />
      {transcriptScrollRef ? <FullscreenLayout scrollRef={scrollRef} scrollable={<>
        {transcriptMessagesElement}
        {transcriptToolJSX}
        <SandboxViolationExpandedView />
      </>} bottom={searchOpen ? <TranscriptSearchBar jumpRef={jumpRef}
        // Seed was tried (c01578c8) — broke /hello muscle
        // memory (cursor lands after 'foo', /hello → foohello).
        // Cancel-restore handles the 'don't lose prior search'
        // concern differently (onCancel re-applies searchQuery).
        initialQuery="" count={searchCount} current={searchCurrent} onClose={q => {
          // Enter — commit. 0-match guard: junk query shouldn't
          // persist (badge hidden, n/N dead anyway).
          setSearchQuery(searchCount > 0 ? q : '');
          setSearchOpen(false);
          // onCancel path: bar unmounts before its useEffect([query])
          // can fire with ''. Without this, searchCount stays stale
          // (n guard at :4956 passes) and VML's matches[] too
          // (nextMatch walks the old array). Phantom nav, no
          // highlight. onExit (Enter, q non-empty) still commits.
          if (!q) {
            setSearchCount(0);
            setSearchCurrent(0);
            jumpRef.current?.setSearchQuery('');
          }
        }} onCancel={() => {
          // Esc/ctrl+c/ctrl+g — undo. Bar's effect last fired
          // with whatever was typed. searchQuery (REPL state)
          // is unchanged since / (onClose = commit, didn't run).
          // Two VML calls: '' restores anchor (0-match else-
          // branch), then searchQuery re-scans from anchor's
          // nearest. Both synchronous — one React batch.
          // setHighlight explicit: REPL's sync-effect dep is
          // searchQuery (unchanged), wouldn't re-fire.
          setSearchOpen(false);
          jumpRef.current?.setSearchQuery('');
          jumpRef.current?.setSearchQuery(searchQuery);
          setHighlight(searchQuery);
        }} setHighlight={setHighlight} /> : <TranscriptModeFooter showAllInTranscript={showAllInTranscript} virtualScroll={true} status={editorStatus || undefined} searchBadge={searchQuery && searchCount > 0 ? {
          current: searchCurrent,
          count: searchCount
        } : undefined} />} /> : <>
        {transcriptMessagesElement}
        {transcriptToolJSX}
        <SandboxViolationExpandedView />
        <TranscriptModeFooter showAllInTranscript={showAllInTranscript} virtualScroll={false} suppressShowAll={dumpMode} status={editorStatus || undefined} />
      </>}
    </KeybindingSetup>;
    // The virtual-scroll branch (FullscreenLayout above) needs
    // <AlternateScreen>'s <Box height={rows}> constraint — without it,
    // ScrollBox's flexGrow has no ceiling, viewport = content height,
    // scrollTop pins at 0, and Ink's screen buffer sizes to the full
    // spacer (200×5k+ rows on long sessions). Same root type + props as
    // normal mode's wrap below so React reconciles and the alt buffer
    // stays entered across toggle. The 30-cap dump branch stays
    // unwrapped — it wants native terminal scrollback.
    if (transcriptScrollRef) {
      return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
        {transcriptReturn}
      </AlternateScreen>;
    }
    return transcriptReturn;
  }

  // Get viewed agent task (inlined from selectors for explicit data flow).
  // viewedAgentTask: teammate OR local_agent — drives the boolean checks
  // below. viewedTeammateTask: teammate-only narrowed, for teammate-specific
  // field access (inProgressToolUseIDs).
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const viewedTeammateTask = viewedTask && isInProcessTeammateTask(viewedTask) ? viewedTask : undefined;
  const viewedAgentTask = viewedTeammateTask ?? (viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined);

  // Bypass useDeferredValue when streaming text is showing so Messages renders
  // the final message in the same frame streaming text clears. Also bypass when
  // not loading — deferredMessages only matters during streaming (keeps input
  // responsive); after the turn ends, showing messages immediately prevents a
  // jitter gap where the spinner is gone but the answer hasn't appeared yet.
  // Only reducedMotion users keep the deferred path during loading.
  const usesSyncMessages = showStreamingText || !isLoading;
  // When viewing an agent, never fall through to leader — empty until
  // bootstrap/stream fills. Closes the see-leader-type-agent footgun.
  const displayedMessages = viewedAgentTask ? viewedAgentTask.messages ?? [] : usesSyncMessages ? messages : deferredMessages;
  // Show the placeholder until the real user message appears in
  // displayedMessages. userInputOnProcessing stays set for the whole turn
  // (cleared in resetLoadingState); this length check hides it once
  // displayedMessages grows past the baseline captured at submit time.
  // Covers both gaps: before setMessages is called (processUserInput), and
  // while deferredMessages lags behind messages. Suppressed when viewing an
  // agent — displayedMessages is a different array there, and onAgentSubmit
  // doesn't use the placeholder anyway.
  const placeholderText = userInputOnProcessing && !viewedAgentTask && displayedMessages.length <= userInputBaselineRef.current ? userInputOnProcessing : undefined;
  const activeToolUseConfirm = activeToolUseConfirmQueue[0];
  const toolPermissionOverlay = focusedInputDialog === 'tool-permission' ? <PermissionRequest key={`${activeToolUseConfirm?.permissionSessionId ?? 'legacy'}:${activeToolUseConfirm?.toolUseContext.agentId ?? 'root'}:${activeToolUseConfirm?.toolUseID}`} onDone={() => setToolUseConfirmQueue(queue => queue.filter(item => item !== activeToolUseConfirm))} onReject={handleQueuedCommandOnCancel} toolUseConfirm={activeToolUseConfirm!} toolUseContext={getToolUseContext(messages, messages, abortController ?? createAbortController(), mainLoopModel)} verbose={verbose} workerBadge={activeToolUseConfirm?.workerBadge} setStickyFooter={isFullscreenEnvEnabled() ? setPermissionStickyFooter : undefined} /> : null;

  // Narrow terminals: companion collapses to a one-liner that REPL stacks
  // on its own row (above input in fullscreen, below in scrollback) instead
  // of row-beside. Wide terminals keep the row layout with sprite on the right.
  const companionNarrow = transcriptCols < MIN_COLS_FOR_FULL_SPRITE;
  // Hide the sprite when PromptInput early-returns BackgroundTasksDialog.
  // The sprite sits as a row sibling of PromptInput, so the dialog's Pane
  // divider draws at useTerminalSize() width but only gets terminalWidth -
  // spriteWidth — divider stops short and dialog text wraps early. Don't
  // check footerSelection: pill FOCUS (arrow-down to tasks pill) must keep
  // the sprite visible so arrow-right can navigate to it.
  const companionVisible = !toolJSX?.shouldHidePromptInput && !focusedInputDialog && !showBashesDialog;

  // In fullscreen, ALL local-jsx slash commands float in the modal slot —
  // FullscreenLayout wraps them in an absolute-positioned bottom-anchored
  // pane (▔ divider, ModalContext). Pane/Dialog inside detect the context
  // and skip their own top-level frame. Non-fullscreen keeps the inline
  // render paths below. Commands that used to route through bottom
  // (immediate: /model, /mcp, /btw, ...) and scrollable (non-immediate:
  // /config, /theme, /diff, ...) both go here now.
  const toolJsxCentered = isFullscreenEnvEnabled() && toolJSX?.isLocalJSXCommand === true;
  const centeredModal: React.ReactNode = toolJsxCentered ? toolJSX!.jsx : null;

  // <AlternateScreen> at the root: everything below is inside its
  // <Box height={rows}>. Handlers/contexts are zero-height so ScrollBox's
  // flexGrow in FullscreenLayout resolves against this Box. The transcript
  // early return above wraps its virtual-scroll branch the same way; only
  // the 30-cap dump branch stays unwrapped for native terminal scrollback.
  const mainReturn = <KeybindingSetup>
    <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={terminalTitle} disabled={titleDisabled} noPrefix={showStatusInTerminalTab} />
    <GlobalKeybindingHandlers {...globalKeybindingProps} />
    {feature('VOICE_MODE') ? <VoiceKeybindingHandler voiceHandleKeyEvent={voice.handleKeyEvent} stripTrailing={voice.stripTrailing} resetAnchor={voice.resetAnchor} isActive={!toolJSX?.isLocalJSXCommand} /> : null}
    <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
    {/* ScrollKeybindingHandler must mount before CancelRequestHandler so
          ctrl+c-with-selection copies instead of cancelling the active task.
          Its raw useInput handler only stops propagation when a selection
          exists — without one, ctrl+c falls through to CancelRequestHandler.
          PgUp/PgDn/wheel always scroll the transcript behind the modal —
          the modal's inner ScrollBox is not keyboard-driven. onScroll
          stays suppressed while a modal is showing so scroll doesn't
          stamp divider/pill state. */}
    <ScrollKeybindingHandler scrollRef={scrollRef} isActive={isFullscreenEnvEnabled() && (centeredModal != null || !focusedInputDialog || focusedInputDialog === 'tool-permission')} onScroll={centeredModal || toolPermissionOverlay || viewedAgentTask ? undefined : composedOnScroll} />
    {feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? <MessageActionsKeybindings handlers={messageActionHandlers} isActive={cursor !== null} /> : null}
    <CancelRequestHandler {...cancelRequestProps} />
    <MCPConnectionManager key={remountKey} dynamicMcpConfig={dynamicMcpConfig} isStrictMcpConfig={strictMcpConfig}>
      <FullscreenLayout scrollRef={scrollRef} overlay={toolPermissionOverlay} bottomFloat={isBuddyEnabled() && companionVisible && !companionNarrow ? <CompanionFloatingBubble /> : undefined} modal={centeredModal} modalScrollRef={modalScrollRef} dividerYRef={dividerYRef} hidePill={!!viewedAgentTask} hideSticky={!!viewedTeammateTask} newMessageCount={unseenDivider?.count ?? 0} onPillClick={() => {
        setCursor(null);
        jumpToNew(scrollRef.current);
      }} scrollable={<>
        <TeammateViewHeader />
        <Messages messages={displayedMessages} tools={tools} commands={renderCommands} verbose={verbose} toolJSX={toolJSX} toolUseConfirmQueue={activeToolUseConfirmQueue} inProgressToolUseIDs={viewedTeammateTask ? viewedTeammateTask.inProgressToolUseIDs ?? new Set() : inProgressToolUseIDs} isMessageSelectorVisible={isMessageSelectorVisible} conversationId={conversationId} screen={screen} streamingToolUses={streamingToolUses} showAllInTranscript={showAllInTranscript} agentDefinitions={agentDefinitions} onOpenRateLimitOptions={handleOpenRateLimitOptions} isLoading={isLoading} streamingText={isLoading && !viewedAgentTask ? visibleStreamingText : null} isBriefOnly={viewedAgentTask ? false : isBriefOnly} unseenDivider={viewedAgentTask ? undefined : unseenDivider} scrollRef={isFullscreenEnvEnabled() ? scrollRef : undefined} trackStickyPrompt={isFullscreenEnvEnabled() ? true : undefined} cursor={cursor} setCursor={setCursor} cursorNavRef={cursorNavRef} />
        <AwsAuthStatusBox />
        {/* Hide the processing placeholder while a modal is showing —
                  it would sit at the last visible transcript row right above
                  the ▔ divider, showing "❯ /config" as redundant clutter
                  (the modal IS the /config UI). Outside modals it stays so
                  the user sees their input echoed while Claude processes. */}
        {!disabled && placeholderText && !centeredModal && <UserTextMessage param={{
          text: placeholderText,
          type: 'text'
        }} addMargin={true} verbose={verbose} />}
        {toolJSX && !(toolJSX.isLocalJSXCommand && toolJSX.isImmediate) && !toolJsxCentered && <Box flexDirection="column" width="100%">
          {toolJSX.jsx}
        </Box>}
        {feature('WEB_BROWSER_TOOL') ? WebBrowserPanelModule && <WebBrowserPanelModule.WebBrowserPanel /> : null}
        <Box flexGrow={1} />
        {showSpinner && <SpinnerWithVerb mode={streamMode} spinnerTip={spinnerTip} responseLengthRef={responseLengthRef} responseLength={reducedMotion ? reducedMotionResponseLength : undefined} overrideMessage={spinnerMessage} spinnerSuffix={stopHookSpinnerSuffix ?? activeToolSpinnerSuffix} verbose={verbose} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} overrideColor={spinnerColor} overrideShimmerColor={spinnerShimmerColor} hasActiveTools={inProgressToolUseIDs.size > 0} leaderIsIdle={!isLoading} />}
        {/* Permanently mounted: it observes the isLoading transition to flash
            `✓ Done` for ~1.5s. Suppressed wherever another element owns the
            row or the user's attention. */}
        <CompletionFlash turnActive={isLoading || userInputOnProcessing !== undefined} suppressed={isBriefOnly || hasRunningTeammates || hasActivePrompt || viewedAgentTask !== undefined} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} />
        {compactProgressRatio !== null && feature('RESUME_COMPACT_PROMPT') && <CompactProgressBar ratio={compactProgressRatio} />}
        {!showSpinner && !isLoading && !userInputOnProcessing && !hasRunningTeammates && isBriefOnly && !viewedAgentTask && <BriefIdleStatus />}
        {isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
      </>} bottom={<Box flexDirection={isBuddyEnabled() && companionNarrow ? 'column' : 'row'} width="100%" alignItems={isBuddyEnabled() && companionNarrow ? undefined : 'flex-end'}>
        {isBuddyEnabled() && companionNarrow && isFullscreenEnvEnabled() && companionVisible ? <CompanionSprite /> : null}
        <Box flexDirection="column" flexGrow={1}>
          {permissionStickyFooter}
          {/* Immediate local-jsx commands (/btw, /sandbox, /assistant,
                  /issue) render here, NOT inside scrollable. They stay mounted
                  while the main conversation streams behind them, so ScrollBox
                  relayouts on each new message would drag them around. bottom
                  is flexShrink={0} outside the ScrollBox — it never moves.
                  Non-immediate local-jsx (/diff, /status, /theme, ~40 others)
                  stays in scrollable: the main loop is paused so no jiggle,
                  and their tall content (DiffDetailView renders up to 400
                  lines with no internal scroll) needs the outer ScrollBox. */}
          {toolJSX?.isLocalJSXCommand && toolJSX.isImmediate && !toolJsxCentered && <Box flexDirection="column" width="100%">
            {toolJSX.jsx}
          </Box>}
          {!showSpinner && !toolJSX?.isLocalJSXCommand && showExpandedTodos && tasksV2 && tasksV2.length > 0 && <Box width="100%" flexDirection="column">
            <TaskListV2 tasks={tasksV2} isStandalone={true} />
          </Box>}
          {focusedInputDialog === 'sandbox-permission' && <SandboxPermissionRequest key={sandboxPermissionRequestQueue[0]!.hostPattern.host} hostPattern={sandboxPermissionRequestQueue[0]!.hostPattern} onUserResponse={(response: {
            allow: boolean;
            persistToSettings: boolean;
          }) => {
            const {
              allow,
              persistToSettings
            } = response;
            const currentRequest = sandboxPermissionRequestQueue[0];
            if (!currentRequest) return;
            const approvedHost = currentRequest.hostPattern.host;
            if (persistToSettings) {
              const update = {
                type: 'addRules' as const,
                rules: [{
                  toolName: WEB_FETCH_TOOL_NAME,
                  ruleContent: `domain:${approvedHost}`
                }],
                behavior: (allow ? 'allow' : 'deny') as 'allow' | 'deny',
                destination: 'localSettings' as const
              };
              setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update)
              }));
              persistPermissionUpdate(update);

              // Immediately update sandbox in-memory config to prevent race conditions
              // where pending requests slip through before settings change is detected
              SandboxManager.refreshConfig();
            }

            // Resolve ALL pending requests for the same host (not just the first one)
            // This handles the case where multiple parallel requests came in for the same domain
            setSandboxPermissionRequestQueue(queue => {
              queue.filter(item => item.hostPattern.host === approvedHost).forEach(item => item.resolvePromise(allow));
              return queue.filter(item => item.hostPattern.host !== approvedHost);
            });

            // Clean up bridge subscriptions and cancel remote prompts
            // for this host since the local user already responded.
            const cleanups = sandboxBridgeCleanupRef.current.get(approvedHost);
            if (cleanups) {
              for (const fn of cleanups) {
                fn();
              }
              sandboxBridgeCleanupRef.current.delete(approvedHost);
            }
          }} />}
          {focusedInputDialog === 'prompt' && <PromptDialog key={promptQueue[0]!.request.prompt} title={promptQueue[0]!.title} toolInputSummary={promptQueue[0]!.toolInputSummary} request={promptQueue[0]!.request} onRespond={selectedKey => {
            const item = promptQueue[0];
            if (!item) return;
            item.resolve({
              prompt_response: item.request.prompt,
              selected: selectedKey
            });
            setPromptQueue(([, ...tail]) => tail);
          }} onAbort={() => {
            const item = promptQueue[0];
            if (!item) return;
            item.reject(new Error('Prompt cancelled by user'));
            setPromptQueue(([, ...tail]) => tail);
          }} />}
          {/* Show pending indicator on worker while waiting for leader approval */}
          {pendingWorkerRequest && <WorkerPendingPermission toolName={pendingWorkerRequest.toolName} description={pendingWorkerRequest.description} />}
          {/* Show pending indicator for sandbox permission on worker side */}
          {pendingSandboxRequest && <WorkerPendingPermission toolName="Network Access" description={`Waiting for leader to approve network access to ${pendingSandboxRequest.host}`} />}
          {/* Worker sandbox permission requests from swarm workers */}
          {focusedInputDialog === 'worker-sandbox-permission' && <SandboxPermissionRequest key={workerSandboxPermissions.queue[0]!.requestId} hostPattern={{
            host: workerSandboxPermissions.queue[0]!.host,
            port: undefined
          } as NetworkHostPattern} onUserResponse={(response: {
            allow: boolean;
            persistToSettings: boolean;
          }) => {
            const {
              allow,
              persistToSettings
            } = response;
            const currentRequest = workerSandboxPermissions.queue[0];
            if (!currentRequest) return;
            const approvedHost = currentRequest.host;

            // Send response via mailbox to the worker
            void sendSandboxPermissionResponseViaMailbox(currentRequest.workerName, currentRequest.requestId, approvedHost, allow, teamContext?.teamName);
            if (persistToSettings && allow) {
              const update = {
                type: 'addRules' as const,
                rules: [{
                  toolName: WEB_FETCH_TOOL_NAME,
                  ruleContent: `domain:${approvedHost}`
                }],
                behavior: 'allow' as const,
                destination: 'localSettings' as const
              };
              setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update)
              }));
              persistPermissionUpdate(update);
              SandboxManager.refreshConfig();
            }

            // Remove from queue
            setAppState(prev => ({
              ...prev,
              workerSandboxPermissions: {
                ...prev.workerSandboxPermissions,
                queue: prev.workerSandboxPermissions.queue.slice(1)
              }
            }));
          }} />}
          {focusedInputDialog === 'elicitation' && <ElicitationDialog key={elicitation.queue[0]!.serverName + ':' + String(elicitation.queue[0]!.requestId)} event={elicitation.queue[0]!} onResponse={(action, content) => {
            const currentRequest = elicitation.queue[0];
            if (!currentRequest) return;
            // Call respond callback to resolve Promise
            currentRequest.respond({
              action,
              content
            });
            // For URL accept, keep in queue for phase 2
            const isUrlAccept = currentRequest.params.mode === 'url' && action === 'accept';
            if (!isUrlAccept) {
              setAppState(prev => ({
                ...prev,
                elicitation: {
                  queue: prev.elicitation.queue.slice(1)
                }
              }));
            }
          }} onWaitingDismiss={action => {
            const currentRequest = elicitation.queue[0];
            // Remove from queue
            setAppState(prev => ({
              ...prev,
              elicitation: {
                queue: prev.elicitation.queue.slice(1)
              }
            }));
            currentRequest?.onWaitingDismiss?.(action);
          }} />}
          {focusedInputDialog === 'cost' && <CostThresholdDialog onDone={() => {
            setShowCostDialog(false);
            setHaveShownCostDialog(true);
            saveGlobalConfig(current => ({
              ...current,
              hasAcknowledgedCostThreshold: true
            }));
            logEvent('tengu_cost_threshold_acknowledged', {});
          }} />}
          {focusedInputDialog === 'idle-return' && idleReturnPending && <IdleReturnDialog idleMinutes={idleReturnPending.idleMinutes} totalInputTokens={getTotalInputTokens()} onDone={async action => {
            const pending = idleReturnPending;
            setIdleReturnPending(null);
            logEvent('tengu_idle_return_action', {
              action: action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              idleMinutes: Math.round(pending.idleMinutes),
              messageCount: messagesRef.current.length,
              totalInputTokens: getTotalInputTokens()
            });
            if (action === 'dismiss') {
              setInputValue(pending.input);
              return;
            }
            if (action === 'never') {
              saveGlobalConfig(current => {
                if (current.idleReturnDismissed) return current;
                return {
                  ...current,
                  idleReturnDismissed: true
                };
              });
            }
            if (action === 'clear') {
              resetAutoCompactTracking();
              const {
                clearConversation
              } = await import('../commands/clear/conversation.js');
              await clearConversation({
                setMessages,
                readFileState: readFileState.current,
                discoveredSkillNames: discoveredSkillNamesRef.current,
                loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
                getAppState: () => store.getState(),
                setAppState,
                setConversationId
              });
              haikuTitleAttemptedRef.current = false;
              setHaikuTitle(undefined);
              bashTools.current.clear();
              bashToolsProcessedIdx.current = 0;
            }
            skipIdleCheckRef.current = true;
            void onSubmitRef.current(pending.input, {
              setCursorOffset: () => { },
              clearBuffer: () => { },
              resetHistory: () => { }
            });
          }} />}
          {focusedInputDialog === 'resume-compact' && resumeCompactPending && <ResumeCompactPrompt tokenCount={resumeCompactPending.tokenCount} model={resumeCompactPending.model} onDone={async choice => {
            const pending = resumeCompactPending;
            setResumeCompactPending(null);
            logEvent('tengu_resume_compact_prompt', {
              action: (choice === 'yes' ? 'accept' : 'decline') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              tokenCount: pending.tokenCount,
            });
            if (choice === 'yes') {
              skipIdleCheckRef.current = true;
              void onSubmitRef.current('/compact', {
                setCursorOffset: () => {},
                clearBuffer: () => {},
                resetHistory: () => {}
              });
            }
          }} />}
          {focusedInputDialog === 'ide-onboarding' && <IdeOnboardingDialog onDone={() => setShowIdeOnboarding(false)} installationStatus={ideInstallationStatus} />}
          {focusedInputDialog === 'effort-callout' && <EffortCallout model={mainLoopModel} onDone={selection => {
            setShowEffortCallout(false);
            if (selection !== 'dismiss') {
              setAppState(prev => ({
                ...prev,
                effortValue: selection
              }));
            }
          }} />}
          {focusedInputDialog === 'remote-callout' && <RemoteCallout onDone={selection => {
            setAppState(prev => {
              if (!prev.showRemoteCallout) return prev;
              return {
                ...prev,
                showRemoteCallout: false,
                ...(selection === 'enable' && {
                  replBridgeEnabled: true,
                  replBridgeExplicit: true,
                  replBridgeOutboundOnly: false
                })
              };
            });
          }} />}

          {exitFlow}

          {focusedInputDialog === 'plugin-hint' && hintRecommendation && <PluginHintMenu pluginName={hintRecommendation.pluginName} pluginDescription={hintRecommendation.pluginDescription} marketplaceName={hintRecommendation.marketplaceName} sourceCommand={hintRecommendation.sourceCommand} onResponse={handleHintResponse} />}

          {focusedInputDialog === 'lsp-recommendation' && lspRecommendation && <LspRecommendationMenu pluginName={lspRecommendation.pluginName} pluginDescription={lspRecommendation.pluginDescription} fileExtension={lspRecommendation.fileExtension} onResponse={handleLspResponse} />}

          {focusedInputDialog === 'desktop-upsell' && <DesktopUpsellStartup onDone={() => setShowDesktopUpsellStartup(false)} />}

          {feature('ULTRAPLAN') ? focusedInputDialog === 'ultraplan-choice' && ultraplanPendingChoice && <UltraplanChoiceDialog plan={ultraplanPendingChoice.plan} sessionId={ultraplanPendingChoice.sessionId} taskId={ultraplanPendingChoice.taskId} setMessages={setMessages} readFileState={readFileState.current} getAppState={() => store.getState()} setConversationId={setConversationId} /> : null}

          {feature('ULTRAPLAN') ? focusedInputDialog === 'ultraplan-launch' && ultraplanLaunchPending && <UltraplanLaunchDialog onChoice={(choice, opts) => {
            const blurb = ultraplanLaunchPending.blurb;
            setAppState(prev => prev.ultraplanLaunchPending ? {
              ...prev,
              ultraplanLaunchPending: undefined
            } : prev);
            if (choice === 'cancel') return;
            // Command's onDone used display:'skip', so add the
            // echo here — gives immediate feedback before the
            // ~5s teleportToRemote resolves.
            setMessages(prev => [...prev, createCommandInputMessage(formatCommandInputTags('ultraplan', blurb))]);
            const appendStdout = (msg: string) => setMessages(prev => [...prev, createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(msg)}</${LOCAL_COMMAND_STDOUT_TAG}>`)]);
            // Defer the second message if a query is mid-turn
            // so it lands after the assistant reply, not
            // between the user's prompt and the reply.
            const appendWhenIdle = (msg: string) => {
              if (!queryGuard.isActive) {
                appendStdout(msg);
                return;
              }
              const unsub = queryGuard.subscribe(() => {
                if (queryGuard.isActive) return;
                unsub();
                // Skip if the user stopped ultraplan while we
                // were waiting — avoids a stale "Monitoring
                // <url>" message for a session that's gone.
                if (!store.getState().ultraplanSessionUrl) return;
                appendStdout(msg);
              });
            };
            void launchUltraplan({
              blurb,
              getAppState: () => store.getState(),
              setAppState,
              signal: createAbortController().signal,
              disconnectedBridge: opts?.disconnectedBridge,
              onSessionReady: appendWhenIdle
            }).then(appendStdout).catch(logError);
          }} /> : null}

          {mrRender()}

          {!toolJSX?.shouldHidePromptInput && !focusedInputDialog && !isExiting && !disabled && !cursor && !isShuttingDown() && <>
            {autoRunIssueReason && <AutoRunIssueNotification onRun={handleAutoRunIssue} onCancel={handleCancelAutoRunIssue} reason={getAutoRunIssueReasonText(autoRunIssueReason)} />}
            {postCompactSurvey.state !== 'closed' ? <FeedbackSurvey state={postCompactSurvey.state} lastResponse={postCompactSurvey.lastResponse} handleSelect={postCompactSurvey.handleSelect} inputValue={inputValue} setInputValue={setInputValue} /> : memorySurvey.state !== 'closed' ? <FeedbackSurvey state={memorySurvey.state} lastResponse={memorySurvey.lastResponse} handleSelect={memorySurvey.handleSelect} handleTranscriptSelect={memorySurvey.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} message="How well did Claude use its memory? (optional)" /> : <FeedbackSurvey state={feedbackSurvey.state} lastResponse={feedbackSurvey.lastResponse} handleSelect={feedbackSurvey.handleSelect} handleTranscriptSelect={feedbackSurvey.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} />}
            {/* Frustration-triggered transcript sharing prompt */}
            {frustrationDetection.state !== 'closed' && <FeedbackSurvey state={frustrationDetection.state} lastResponse={null} handleSelect={() => { }} handleTranscriptSelect={frustrationDetection.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} />}
            {showIssueFlagBanner && <IssueFlagBanner />}
            {isBuddyEnabled() && companionVisible && !companionNarrow && <CompanionActionFX />}
            <PromptInput debug={debug} ideSelection={ideSelection} isLocalJSXCommandActive={isShowingLocalJSXCommand} getToolUseContext={getToolUseContext} toolPermissionContext={toolPermissionContext} setToolPermissionContext={setToolPermissionContext} apiKeyStatus={apiKeyStatus} commands={renderCommands} agents={agentDefinitions.activeAgents} isLoading={isLoading} onExit={handleExit} verbose={verbose} messages={messages} onAutoUpdaterResult={setAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} input={inputValue} onInputChange={setInputValue} mode={inputMode} onModeChange={setInputMode} stashedPrompt={stashedPrompt} setStashedPrompt={setStashedPrompt} submitCount={submitCount} onShowMessageSelector={handleShowMessageSelector} onMessageActionsEnter={
              // Works during isLoading — edit cancels first; uuid selection survives appends.
              feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? enterMessageActions : undefined} mcpClients={mcpClients} pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={showBashesDialog} setShowBashesDialog={setShowBashesDialog} onSubmit={onSubmit} onAgentSubmit={onAgentSubmit} isSearchingHistory={isSearchingHistory} setIsSearchingHistory={setIsSearchingHistory} helpOpen={isHelpOpen} setHelpOpen={setIsHelpOpen} insertTextRef={feature('VOICE_MODE') ? insertTextRef : undefined} voiceInterimRange={voice.interimRange} ultracodeActive={isUltracode} />
            <SessionBackgroundHint onBackgroundSession={handleBackgroundSession} isLoading={isLoading} />
          </>}
          {cursor &&
            // inputValue is REPL state; typed text survives the round-trip.
            <MessageActionsBar cursor={cursor} />}
          {focusedInputDialog === 'message-selector' && <MessageSelector messages={messages} preselectedMessage={messageSelectorPreselect} onPreRestore={onCancel} onRestoreCode={async (message: UserMessage) => {
            await fileHistoryRewind((updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory)
              }));
            }, message.uuid);
          }} onSummarize={async (message: UserMessage, feedback?: string, direction: PartialCompactDirection = 'from') => {
            // Project snipped messages so the compact model
            // doesn't summarize content that was intentionally removed.
            const compactMessages = getMessagesAfterCompactBoundary(messages);
            const messageIndex = compactMessages.indexOf(message);
            if (messageIndex === -1) {
              // Selected a snipped or pre-compact message that the
              // selector still shows (REPL keeps full history for
              // scrollback). Surface why nothing happened instead
              // of silently no-oping.
              setMessages(prev => [...prev, createSystemMessage('That message is no longer in the active context (snipped or pre-compact). Choose a more recent message.', 'warning')]);
              return;
            }
            const newAbortController = createAbortController();
            const context = getToolUseContext(compactMessages, [], newAbortController, mainLoopModel);
            const appState = context.getAppState();
            const defaultSysPrompt = await getSystemPrompt(context.options.tools, context.options.mainLoopModel, Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys()), context.options.mcpClients);
            const systemPrompt = buildEffectiveSystemPrompt({
              mainThreadAgentDefinition: undefined,
              toolUseContext: context,
              customSystemPrompt: context.options.customSystemPrompt,
              defaultSystemPrompt: defaultSysPrompt,
              appendSystemPrompt: context.options.appendSystemPrompt
            });
            const [userContext, systemContext] = await Promise.all([getUserContext(), getSystemContext()]);
            const result = await partialCompactConversation(compactMessages, messageIndex, context, {
              systemPrompt,
              userContext,
              systemContext,
              toolUseContext: context,
              forkContextMessages: compactMessages
            }, feedback, direction);
            const kept = result.messagesToKeep ?? [];
            const ordered = direction === 'up_to' ? [...result.summaryMessages, ...kept] : [...kept, ...result.summaryMessages];
            const postCompact = [result.boundaryMarker, ...ordered, ...result.attachments, ...result.hookResults];
            // Fullscreen 'from' keeps scrollback; 'up_to' must not
            // (old[0] unchanged + grown array means incremental
            // useLogMessages path, so boundary never persisted).
            // Find by uuid since old is raw REPL history and snipped
            // entries can shift the projected messageIndex.
            if (isFullscreenEnvEnabled() && direction === 'from') {
              setMessages(old => {
                const rawIdx = old.findIndex(m => m.uuid === message.uuid);
                return [...old.slice(0, rawIdx === -1 ? 0 : rawIdx), ...postCompact];
              });
            } else {
              setMessages(postCompact);
            }
            // Partial compact bypasses handleMessageFromStream — clear
            // the auto-compact breaker and context-blocked flag.
            setAutoCompactTrackingForSession(getSessionId(), undefined);
            if (feature('PROACTIVE') || feature('KAIROS')) {
              proactiveModule?.setContextBlocked(false);
            }
            setConversationId(randomUUID());
            runPostCompactCleanup(context.options.querySource);
            if (direction === 'from') {
              const r = textForResubmit(message);
              if (r) {
                setInputValue(r.text);
                setInputMode(r.mode);
              }
            }

            // Show notification with ctrl+o hint
            const historyShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
            addNotification({
              key: 'summarize-ctrl-o-hint',
              text: `Conversation summarized (${historyShortcut} for history)`,
              priority: 'medium',
              timeoutMs: 8000
            });
          }} onRestoreMessage={handleRestoreMessage} onClose={() => {
            setIsMessageSelectorVisible(false);
            setMessageSelectorPreselect(undefined);
          }} />}
        </Box>
        {isBuddyEnabled() && !(companionNarrow && isFullscreenEnvEnabled()) && companionVisible ? <CompanionSprite /> : null}
      </Box>} />
    </MCPConnectionManager>
  </KeybindingSetup>;
  if (isFullscreenEnvEnabled()) {
    return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
      {mainReturn}
    </AlternateScreen>;
  }
  return mainReturn;
}
