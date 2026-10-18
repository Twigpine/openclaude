import { feature } from 'bun:bundle';
import * as React from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import type { PermissionMode } from 'src/utils/permissions/PermissionMode.js';
import { getIsRemoteMode, getKairosActive, getMainThreadAgentType, getOriginalCwd, getSdkBetas, getSessionId } from '../bootstrap/state.js';
import { DEFAULT_OUTPUT_STYLE_NAME } from '../constants/outputStyles.js';
import { useNotifications } from '../context/notifications.js';
import { getTotalAPIDuration, getTotalCost, getTotalDuration, getTotalInputTokens, getTotalLinesAdded, getTotalLinesRemoved, getTotalOutputTokens } from '../cost-tracker.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { type ReadonlySettings, useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, Text } from '../ink.js';
import { getRawUtilization } from '../services/claudeAiLimits.js';
import type { Message } from '../types/message.js';
import type { StatusLineCommandInput } from '../types/statusLine.js';
import type { VimMode } from '../types/textInputTypes.js';
import { checkHasTrustDialogAccepted } from '../utils/config.js';
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { createBaseHookInput, executeStatusLineCommand } from '../utils/hooks.js';
import { getLastAssistantMessage, getMessagesAfterCompactBoundary } from '../utils/messages.js';
import { getRuntimeMainLoopModel, type ModelName, renderModelName } from '../utils/model/model.js';
import { getCurrentSessionTitle } from '../utils/sessionStorage.js';
import { doesMostRecentAssistantMessageExceed200k, getCurrentUsage, getUnreportedSessionUsage, type SessionUsage } from '../utils/tokens.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import { isVimModeEnabled } from './PromptInput/utils.js';
export function statusLineShouldDisplay(settings: ReadonlySettings): boolean {
  // Assistant mode: statusline fields (model, permission mode, cwd) reflect the
  // REPL/daemon process, not what the agent child is actually running. Hide it.
  if (feature('KAIROS') && getKairosActive()) return false;
  return settings?.statusLine !== undefined;
}

export function resolveStatusLineTokenTotals(
  totalInputTokens: number,
  totalOutputTokens: number,
  unreportedSessionUsage: SessionUsage | null,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokensAreEstimated: boolean | undefined;
} {
  if (!unreportedSessionUsage) {
    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokensAreEstimated: undefined,
    };
  }

  return {
    totalInputTokens: totalInputTokens + unreportedSessionUsage.input_tokens,
    totalOutputTokens: totalOutputTokens + unreportedSessionUsage.output_tokens,
    totalTokensAreEstimated: true,
  };
}

/** Resolves the next statusline side effect for the current visibility transition. */
export function resolveStatusLineUpdateAction(options: {
  active: boolean;
  hasRun: boolean;
  needsRefresh: boolean;
  stateChanged: boolean;
  commandChanged: boolean;
  hasPendingUpdate: boolean;
}): {
  action: 'cancel';
  needsRefresh: boolean;
} | {
  action: 'run' | 'schedule' | 'none';
} {
  if (!options.active) {
    return {
      action: 'cancel',
      needsRefresh: options.needsRefresh || options.stateChanged || options.commandChanged || options.hasPendingUpdate
    };
  }
  if (!options.hasRun || options.needsRefresh || options.commandChanged) {
    return {
      action: 'run'
    };
  }
  if (options.stateChanged) {
    return {
      action: 'schedule'
    };
  }
  return {
    action: 'none'
  };
}

export function buildStatusLineCommandInput(permissionMode: PermissionMode, exceeds200kTokens: boolean, settings: ReadonlySettings, messages: Message[], addedDirs: string[], mainLoopModel: ModelName, vimMode?: VimMode): StatusLineCommandInput {
  const agentType = getMainThreadAgentType();
  const worktreeSession = getCurrentWorktreeSession();
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel,
    exceeds200kTokens
  });
  const outputStyleName = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME;
  const currentUsage = getCurrentUsage(messages);
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas());
  const contextPercentages = calculateContextPercentages(currentUsage, contextWindowSize);
  const totalInputTokens = getTotalInputTokens();
  const totalOutputTokens = getTotalOutputTokens();
  const resolvedTokenTotals = resolveStatusLineTokenTotals(totalInputTokens, totalOutputTokens, getUnreportedSessionUsage(messages));
  const sessionId = getSessionId();
  const sessionName = getCurrentSessionTitle(sessionId);
  const rawUtil = getRawUtilization();
  const rateLimits: StatusLineCommandInput['rate_limits'] = {
    ...(rawUtil.five_hour && {
      five_hour: {
        used_percentage: rawUtil.five_hour.utilization * 100,
        resets_at: rawUtil.five_hour.resets_at
      }
    }),
    ...(rawUtil.seven_day && {
      seven_day: {
        used_percentage: rawUtil.seven_day.utilization * 100,
        resets_at: rawUtil.seven_day.resets_at
      }
    })
  };
  return {
    ...createBaseHookInput(),
    ...(sessionName && {
      session_name: sessionName
    }),
    model: {
      id: runtimeModel,
      display_name: renderModelName(runtimeModel)
    },
    workspace: {
      current_dir: getCwd(),
      project_dir: getOriginalCwd(),
      added_dirs: addedDirs
    },
    version: MACRO.VERSION,
    output_style: {
      name: outputStyleName
    },
    cost: {
      total_cost_usd: getTotalCost(),
      total_duration_ms: getTotalDuration(),
      total_api_duration_ms: getTotalAPIDuration(),
      total_lines_added: getTotalLinesAdded(),
      total_lines_removed: getTotalLinesRemoved()
    },
    context_window: {
      total_input_tokens: resolvedTokenTotals.totalInputTokens,
      total_output_tokens: resolvedTokenTotals.totalOutputTokens,
      total_tokens_are_estimated: resolvedTokenTotals.totalTokensAreEstimated,
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: contextPercentages.used,
      remaining_percentage: contextPercentages.remaining
    },
    exceeds_200k_tokens: exceeds200kTokens,
    ...((rateLimits.five_hour || rateLimits.seven_day) && {
      rate_limits: rateLimits
    }),
    ...(isVimModeEnabled() && {
      vim: {
        mode: vimMode ?? 'INSERT'
      }
    }),
    ...(agentType && {
      agent: {
        name: agentType
      }
    }),
    ...(getIsRemoteMode() && {
      remote: {
        session_id: getSessionId()
      }
    }),
    ...(worktreeSession && {
      worktree: {
        name: worktreeSession.worktreeName,
        path: worktreeSession.worktreePath,
        branch: worktreeSession.worktreeBranch,
        original_cwd: worktreeSession.originalCwd,
        original_branch: worktreeSession.originalBranch
      }
    })
  };
}
type Props = {
  // messages stays behind a ref (read only in the debounced callback);
  // lastAssistantMessageId is the actual re-render trigger.
  messagesRef: React.RefObject<Message[]>;
  lastAssistantMessageId: string | null;
  vimMode?: VimMode;
  active?: boolean;
  executeCommand?: typeof executeStatusLineCommand;
};
export function getLastAssistantMessageId(messages: Message[]): string | null {
  // Returning null at a new compact boundary also invalidates the built-in
  // and custom status lines before the next assistant response arrives.
  return getLastAssistantMessage(getMessagesAfterCompactBoundary(messages))?.uuid ?? null;
}
function StatusLineInner({
  messagesRef,
  lastAssistantMessageId,
  vimMode,
  active = true,
  executeCommand = executeStatusLineCommand
}: Props): React.ReactNode {
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const permissionMode = useAppState(s => s.toolPermissionContext.mode);
  const additionalWorkingDirectories = useAppState(s => s.toolPermissionContext.additionalWorkingDirectories);
  const statusLineText = useAppState(s => s.statusLineText);
  const setAppState = useSetAppState();
  const settings = useSettings();
  const {
    addNotification
  } = useNotifications();
  // AppState-sourced model — same source as API requests. getMainLoopModel()
  // re-reads settings.json on every call, so another session's /model write
  // would leak into this session's statusline (anthropics/claude-code#37596).
  const mainLoopModel = useMainLoopModel();

  // Keep latest values in refs for stable callback access
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const addedDirsRef = useRef(additionalWorkingDirectories);
  addedDirsRef.current = additionalWorkingDirectories;
  const mainLoopModelRef = useRef(mainLoopModel);
  mainLoopModelRef.current = mainLoopModel;
  const activeRef = useRef(active);
  const needsRefreshRef = useRef(false);
  useLayoutEffect(() => {
    activeRef.current = active;
    if (!active && abortControllerRef.current !== undefined) {
      needsRefreshRef.current = true;
      abortControllerRef.current.abort();
    }
  }, [active]);

  // Track previous state to detect changes and cache expensive calculations
  const previousStateRef = useRef<{
    messageId: string | null;
    exceeds200kTokens: boolean;
    permissionMode: PermissionMode;
    vimMode: VimMode | undefined;
    mainLoopModel: ModelName;
    outputStyle: ReadonlySettings['outputStyle'];
    additionalWorkingDirectories: typeof additionalWorkingDirectories;
  }>({
    messageId: null,
    exceeds200kTokens: false,
    permissionMode,
    vimMode,
    mainLoopModel,
    outputStyle: settings?.outputStyle,
    additionalWorkingDirectories
  });

  // Debounce timer ref
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // True when the next invocation should log its result (first run or after settings reload)
  const logNextResultRef = useRef(true);
  const hasRunRef = useRef(false);
  const statusLineCommand = settings?.statusLine?.command;
  const previousStatusLineCommandRef = useRef(statusLineCommand);

  // Stable update function — reads latest values from refs
  const doUpdate = useCallback(async () => {
    if (!activeRef.current) {
      needsRefreshRef.current = true;
      return;
    }
    // Cancel any in-flight requests
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const msgs = messagesRef.current;
    const logResult = logNextResultRef.current;
    try {
      let exceeds200kTokens = previousStateRef.current.exceeds200kTokens;

      // Only recalculate 200k check if messages changed
      const currentMessageId = getLastAssistantMessageId(msgs);
      if (currentMessageId !== previousStateRef.current.messageId) {
        exceeds200kTokens = doesMostRecentAssistantMessageExceed200k(msgs);
        previousStateRef.current.messageId = currentMessageId;
        previousStateRef.current.exceeds200kTokens = exceeds200kTokens;
      }
      const statusInput = buildStatusLineCommandInput(permissionModeRef.current, exceeds200kTokens, settingsRef.current, msgs, Array.from(addedDirsRef.current.keys()), mainLoopModelRef.current, vimModeRef.current);
      const text = await executeCommand(statusInput, controller.signal, undefined, logResult);
      if (!controller.signal.aborted) {
        if (logResult) logNextResultRef.current = false;
        setAppState(prev => {
          if (prev.statusLineText === text) return prev;
          return {
            ...prev,
            statusLineText: text
          };
        });
      }
    } catch {
      // Silently ignore errors in status line updates
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = undefined;
      }
    }
  }, [executeCommand, messagesRef, setAppState]);

  const cancelPendingUpdate = useCallback(() => {
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = undefined;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
  }, []);

  // Stable debounced schedule function — no deps, uses refs
  const scheduleUpdate = useCallback(() => {
    if (!activeRef.current) {
      needsRefreshRef.current = true;
      return;
    }
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout((ref, doUpdate) => {
      ref.current = undefined;
      void doUpdate();
    }, 300, debounceTimerRef, doUpdate);
  }, [doUpdate]);

  // Single state-machine effect for initial activation, visibility changes,
  // input changes, and command hot reload. Keeping these transitions together
  // avoids correctness depending on effect declaration order.
  useEffect(() => {
    const stateChanged = lastAssistantMessageId !== previousStateRef.current.messageId || permissionMode !== previousStateRef.current.permissionMode || vimMode !== previousStateRef.current.vimMode || mainLoopModel !== previousStateRef.current.mainLoopModel || settings?.outputStyle !== previousStateRef.current.outputStyle || additionalWorkingDirectories !== previousStateRef.current.additionalWorkingDirectories;
    const commandChanged = statusLineCommand !== previousStatusLineCommandRef.current;
    previousStateRef.current.permissionMode = permissionMode;
    previousStateRef.current.vimMode = vimMode;
    previousStateRef.current.mainLoopModel = mainLoopModel;
    previousStateRef.current.outputStyle = settings?.outputStyle;
    previousStateRef.current.additionalWorkingDirectories = additionalWorkingDirectories;
    previousStatusLineCommandRef.current = statusLineCommand;
    if (commandChanged) logNextResultRef.current = true;

    const transition = resolveStatusLineUpdateAction({
      active,
      hasRun: hasRunRef.current,
      needsRefresh: needsRefreshRef.current,
      stateChanged,
      commandChanged,
      hasPendingUpdate: debounceTimerRef.current !== undefined || abortControllerRef.current !== undefined
    });
    if (transition.action === 'cancel') {
      needsRefreshRef.current = transition.needsRefresh;
      cancelPendingUpdate();
      return;
    }
    needsRefreshRef.current = false;
    if (transition.action === 'run') {
      cancelPendingUpdate();
      hasRunRef.current = true;
      void doUpdate();
      return;
    }
    if (transition.action === 'schedule') scheduleUpdate();
  }, [active, lastAssistantMessageId, permissionMode, vimMode, mainLoopModel, settings?.outputStyle, additionalWorkingDirectories, statusLineCommand, cancelPendingUpdate, doUpdate, scheduleUpdate]);

  // Separate effect for logging on mount
  useEffect(() => {
    const statusLine = settings?.statusLine;
    if (statusLine) {
      logEvent('tengu_status_line_mount', {
        command_length: statusLine.command.length,
        padding: statusLine.padding
      });
      // Log if status line is configured but disabled by disableAllHooks
      if (settings.disableAllHooks === true) {
        logForDebugging('Status line is configured but disableAllHooks is true', {
          level: 'warn'
        });
      }
      // executeStatusLineCommand (hooks.ts) returns undefined when trust is
      // blocked — statusLineText stays undefined forever, user sees nothing,
      // and tengu_status_line_mount above fires anyway so telemetry looks fine.
      if (!checkHasTrustDialogAccepted()) {
        addNotification({
          key: 'statusline-trust-blocked',
          text: 'statusline skipped · restart to fix',
          color: 'warning',
          priority: 'low'
        });
        logForDebugging('Status line command skipped: workspace trust not accepted', {
          level: 'warn'
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, []); // Only run once on mount - settings stable for initial logging

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPendingUpdate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [cancelPendingUpdate]);

  // Get padding from settings or default to 0
  const paddingX = settings?.statusLine?.padding ?? 0;

  // StatusLine must have stable height in fullscreen — the footer is
  // flexShrink:0 so a 0→1 row change when the command finishes steals
  // a row from ScrollBox and shifts content. Reserve the row while loading
  // (same trick as PromptInputFooterLeftSide).
  return <Box paddingX={paddingX} gap={2}>
      {statusLineText ? <Text dimColor wrap="truncate">
          <Ansi>{statusLineText}</Ansi>
        </Text> : isFullscreenEnvEnabled() ? <Text> </Text> : null}
    </Box>;
}

// Parent (PromptInputFooter) re-renders on every setMessages, but StatusLine's
// own props now only change when lastAssistantMessageId flips — memo keeps it
// from being dragged along (previously ~18 no-prop-change renders per session).
export const StatusLine = memo(StatusLineInner);
