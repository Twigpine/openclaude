import { feature } from 'bun:bundle';
import type { UUID } from 'crypto';
import figures from 'figures';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import type { Notification } from 'src/context/notifications.js';
import { PRODUCT_DISPLAY_NAME } from '../../../constants/product.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { useAppState, useAppStateStore, useSetAppState } from 'src/state/AppState.js';
import { getSdkBetas, getSessionId, isSessionPersistenceDisabled, setHasExitedPlanMode, setNeedsAutoModeExitAttachment, setNeedsPlanModeExitAttachment } from '../../../bootstrap/state.js';
import { generateSessionName } from '../../../commands/rename/generateSessionName.js';
import { launchUltraplan } from '../../../commands/ultraplan.js';
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js';
import { Box, Text } from '../../../ink.js';
import type { AppState } from '../../../state/AppStateStore.js';
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../../tools/ExitPlanModeTool/constants.js';
import type { AllowedPrompt } from '../../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { TEAM_CREATE_TOOL_NAME } from '../../../tools/TeamCreateTool/constants.js';
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js';
import { calculateContextPercentages, getContextWindowForModel } from '../../../utils/context.js';
import { getExternalEditor } from '../../../utils/editor.js';
import { getDisplayPath } from '../../../utils/file.js';
import { toIDEDisplayName } from '../../../utils/ide.js';
import { logError } from '../../../utils/log.js';
import { enqueuePendingNotification } from '../../../utils/messageQueueManager.js';
import { createUserMessage } from '../../../utils/messages.js';
import { getMainLoopModel, getRuntimeMainLoopModel, modelDisplayString } from '../../../utils/model/model.js';
import { createPromptRuleContent, isClassifierPermissionsEnabled, PROMPT_PREFIX } from '../../../utils/permissions/bashClassifier.js';
import { type PermissionMode, toExternalPermissionMode } from '../../../utils/permissions/PermissionMode.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { isAutoModeGateEnabled, restoreDangerousPermissions, stripDangerousPermissionsForAutoMode } from '../../../utils/permissions/permissionSetup.js';
import { getPewterLedgerVariant, isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js';
import { writeFile } from 'fs/promises';
import { getPlan, getPlanFilePath, persistFileSnapshotIfRemote } from '../../../utils/plans.js';
import { editFileInEditor, editPromptInEditor } from '../../../utils/promptEditor.js';
import { getCurrentSessionTitle, getTranscriptPath, saveAgentName, saveCustomTitle } from '../../../utils/sessionStorage.js';
import { getSettings_DEPRECATED } from '../../../utils/settings/settings.js';
import { type OptionWithDescription, Select } from '../../CustomSelect/index.js';
import { Markdown } from '../../Markdown.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { usePermissionModeChangeRequest } from '../usePermissionModeChangeRequest.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('../../../utils/permissions/autoModeState.js') as typeof import('../../../utils/permissions/autoModeState.js') : null;
import type { Base64ImageSource, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
/* eslint-enable @typescript-eslint/no-require-imports */
import type { PastedContent } from '../../../utils/config.js';
import type { ImageDimensions } from '../../../utils/imageResizer.js';
import { maybeResizeAndDownsampleImageBlock } from '../../../utils/imageResizer.js';
import { cacheImagePath, storeImage } from '../../../utils/imageStore.js';
type ResponseValue = 'yes-bypass-permissions' | 'yes-full-access' | 'yes-accept-edits' | 'yes-bypass-permissions-keep-context' | 'yes-full-access-keep-context' | 'yes-accept-edits-keep-context' | 'yes-default-keep-context' | 'yes-resume-auto-mode' | 'yes-auto-clear-context' | 'ultraplan' | 'no';
type DangerousPlanExitMode = Extract<
  PermissionMode,
  'bypassPermissions' | 'fullAccess'
>;

function dangerousModeForResponse(value: ResponseValue): DangerousPlanExitMode | null {
  if (value === 'yes-full-access' || value === 'yes-full-access-keep-context') {
    return 'fullAccess';
  }
  if (value === 'yes-bypass-permissions' || value === 'yes-bypass-permissions-keep-context') {
    return 'bypassPermissions';
  }
  return null;
}

/**
 * Build permission updates for plan approval, including prompt-based rules if provided.
 * Prompt-based rules are only added when classifier permissions are enabled (Ant-only).
 */
export function buildPermissionUpdates(mode: PermissionMode, allowedPrompts?: AllowedPrompt[]): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [{
    type: 'setMode',
    mode: toExternalPermissionMode(mode),
    destination: 'session'
  }];

  // Add prompt-based permission rules if provided (Ant-only feature)
  if (isClassifierPermissionsEnabled() && allowedPrompts && allowedPrompts.length > 0) {
    updates.push({
      type: 'addRules',
      rules: allowedPrompts.map(p => ({
        toolName: p.tool,
        ruleContent: createPromptRuleContent(p.prompt)
      })),
      behavior: 'allow',
      destination: 'session'
    });
  }
  return updates;
}

/** @internal Exported for testing. */
export function getDangerousPlanExitMode({
  isBypassPermissionsModeAvailable,
  prePlanMode
}: {
  isBypassPermissionsModeAvailable: boolean | undefined;
  prePlanMode?: PermissionMode;
}): DangerousPlanExitMode | null {
  if (!isBypassPermissionsModeAvailable) {
    return null;
  }
  return prePlanMode === 'fullAccess' ? 'fullAccess' : 'bypassPermissions';
}

function getDangerousPlanExitLabel(mode: DangerousPlanExitMode): string {
  return mode === 'fullAccess' ? 'full access' : 'bypass permissions';
}

/**
 * Auto-name the session from the plan content when the user accepts a plan,
 * if they haven't already named it via /rename or --name. Fire-and-forget.
 * Mirrors /rename: kebab-case name, updates the prompt-border badge.
 */
export function autoNameSessionFromPlan(plan: string, setAppState: (updater: (prev: AppState) => AppState) => void, isClearContext: boolean): void {
  if (isSessionPersistenceDisabled() || getSettings_DEPRECATED()?.cleanupPeriodDays === 0) {
    return;
  }
  // On clear-context, the current session is about to be abandoned — its
  // title (which may have been set by a PRIOR auto-name) is irrelevant.
  // Checking it would make the feature self-defeating after first use.
  if (!isClearContext && getCurrentSessionTitle(getSessionId())) return;
  void generateSessionName(
  // generateSessionName tail-slices to the last 1000 chars (correct for
  // conversations, where recency matters). Plans front-load the goal and
  // end with testing steps — head-slice so Haiku sees the summary.
  [createUserMessage({
    content: plan.slice(0, 1000)
  })], new AbortController().signal).then(async name => {
    // On clear-context acceptance, regenerateSessionId() has run by now —
    // this intentionally names the NEW execution session. Do not "fix" by
    // capturing sessionId once; that would name the abandoned planning session.
    if (!name || getCurrentSessionTitle(getSessionId())) return;
    const sessionId = getSessionId() as UUID;
    const fullPath = getTranscriptPath();
    await saveCustomTitle(sessionId, name, fullPath, 'auto');
    await saveAgentName(sessionId, name, fullPath, 'auto');
    setAppState(prev => {
      if (prev.standaloneAgentContext?.name === name) return prev;
      return {
        ...prev,
        standaloneAgentContext: {
          ...prev.standaloneAgentContext,
          name
        }
      };
    });
  }).catch(logError);
}
/**
 * @internal Exported for testing. Persists the plan file before exiting plan
 * mode. Returns true on success. On write failure it logs, queues a
 * 'plan-save-error' notification, and returns false so the caller stays in
 * plan mode (does not grant permissions or resolve the tool use).
 */
export async function persistPlanFileBeforeExit({
  planFilePath,
  currentPlan,
  addNotification
}: {
  planFilePath: string;
  currentPlan: string;
  addNotification: (content: Notification) => void;
}): Promise<boolean> {
  try {
    await writeFile(planFilePath, currentPlan, 'utf-8');
    void persistFileSnapshotIfRemote();
    return true;
  } catch (e) {
    logError(`Failed to save plan file to ${planFilePath}: ${e}`);
    addNotification({
      key: 'plan-save-error',
      text: `Failed to save plan file: ${e instanceof Error ? e.message : String(e)}`,
      color: 'warning',
      priority: 'high'
    });
    return false;
  }
}
export function ExitPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
  setStickyFooter
}: PermissionRequestProps): React.ReactNode {
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const setAppState = useSetAppState();
  const store = useAppStateStore();
  const {
    addNotification
  } = useNotifications();
  // Feedback text from the 'No' option's input. Threaded through onAllow as
  // acceptFeedback when the user approves — lets users annotate the plan
  // ("also update the README") without a reject+re-plan round-trip.
  const [planFeedback, setPlanFeedback] = useState('');
  const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({});
  const nextPasteIdRef = useRef(0);
  const {
    dangerousModeDialog,
    requestPermissionModeChange
  } = usePermissionModeChangeRequest();
  const showClearContext = useAppState(s => s.settings.showClearContextOnPlanAccept) ?? false;
  const ultraplanSessionUrl = useAppState(s => s.ultraplanSessionUrl);
  const ultraplanLaunching = useAppState(s => s.ultraplanLaunching);
  // Hide the Ultraplan button while a session is active or launching —
  // selecting it would dismiss the dialog and reject locally before
  // launchUltraplan can notice the session exists and return "already polling".
  // feature() must sit directly in an if/ternary (bun:bundle DCE constraint).
  const showUltraplan = feature('ULTRAPLAN') ? !ultraplanSessionUrl && !ultraplanLaunching : false;
  const usage = toolUseConfirm.assistantMessage.message.usage;
  const {
    mode,
    prePlanMode,
    isAutoModeAvailable,
    isBypassPermissionsModeAvailable
  } = toolPermissionContext;
  const dangerousPlanExitMode = getDangerousPlanExitMode({
    isBypassPermissionsModeAvailable,
    prePlanMode
  });
  const planAuthorName = modelDisplayString(toolUseConfirm.assistantMessage.message.model);
  const options = useMemo(() => buildPlanApprovalOptions({
    showClearContext,
    showUltraplan,
    usedPercent: showClearContext ? getContextUsedPercent(usage, mode) : null,
    isAutoModeAvailable,
    dangerousPlanExitMode,
    planAuthorName,
    onFeedbackChange: setPlanFeedback
  }), [showClearContext, showUltraplan, usage, mode, isAutoModeAvailable, dangerousPlanExitMode, planAuthorName]);
  const requestPlanExitModeChange = useCallback(async (value: ResponseValue, onApply: () => void) => {
    const dangerousMode = dangerousModeForResponse(value);
    if (!dangerousMode) {
      onApply();
      return;
    }
    await requestPermissionModeChange({
      mode: dangerousMode,
      toolPermissionContext,
      onApply,
      onBlocked: error => {
        addNotification({
          key: `exit-plan-mode-${dangerousMode}`,
          text: error,
          color: 'warning',
          priority: 'high'
        });
      }
    });
  }, [addNotification, requestPermissionModeChange, toolPermissionContext]);
  function onImagePaste(base64Image: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, _sourcePath?: string) {
    const pasteId = nextPasteIdRef.current++;
    const newContent: PastedContent = {
      id: pasteId,
      type: 'image',
      content: base64Image,
      mediaType: mediaType || 'image/png',
      filename: filename || 'Pasted image',
      dimensions
    };
    cacheImagePath(newContent);
    void storeImage(newContent);
    setPastedContents(prev => ({
      ...prev,
      [pasteId]: newContent
    }));
  }
  const onRemoveImage = useCallback((id: number) => {
    setPastedContents(prev => {
      const next = {
        ...prev
      };
      delete next[id];
      return next;
    });
  }, []);
  const imageAttachments = Object.values(pastedContents).filter(c => c.type === 'image');
  const hasImages = imageAttachments.length > 0;

  // TODO: Delete the branch after moving to V2
  // Use tool name to detect V2 instead of checking input.plan, because PR #10394
  // injects plan content into input.plan for hooks/SDK, which broke the old detection
  // (see issue #10878)
  const isV2 = toolUseConfirm.tool.name === EXIT_PLAN_MODE_V2_TOOL_NAME;
  const inputPlan = isV2 ? undefined : toolUseConfirm.input.plan as string | undefined;
  const planFilePath = isV2 ? getPlanFilePath() : undefined;

  // Extract allowed prompts requested by the plan (Ant-only feature)
  const allowedPrompts = toolUseConfirm.input.allowedPrompts as AllowedPrompt[] | undefined;

  // Get the raw plan to check if it's empty
  const rawPlan = inputPlan ?? getPlan();
  const isEmpty = !rawPlan || rawPlan.trim() === '';

  // Capture the variant once on mount. GrowthBook reads from a disk cache
  // so the value is stable across a single planning session. undefined =
  // control arm. The variant is a fixed 3-value enum of short literals,
  // not user input.
  const [planStructureVariant] = useState(() => (getPewterLedgerVariant() ?? undefined) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS);
  const [currentPlan, setCurrentPlan] = useState(() => {
    if (inputPlan) return inputPlan;
    const plan = getPlan();
    return plan ?? 'No plan found. Please write your plan to the plan file first.';
  });
  const [showSaveMessage, setShowSaveMessage] = useState(false);
  // Track Ctrl+G local edits so updatedInput can include the plan (the tool
  // only echoes the plan in tool_result when input.plan is set — otherwise
  // the model already has it in context from writing the plan file).
  const [planEditedLocally, setPlanEditedLocally] = useState(false);

  // Auto-hide save message after 5 seconds
  useEffect(() => {
    if (showSaveMessage) {
      const timer = setTimeout(setShowSaveMessage, 5000, false);
      return () => clearTimeout(timer);
    }
  }, [showSaveMessage]);

  // Handle Ctrl+G to edit plan in $EDITOR, Shift+Tab for auto-accept edits
  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrl && e.key === 'g') {
      e.preventDefault();
      logEvent('tengu_plan_external_editor_used', {});
      void (async () => {
        if (isV2 && planFilePath) {
          const result = await editFileInEditor(planFilePath);
          if (result.error) {
            addNotification({
              key: 'external-editor-error',
              text: result.error,
              color: 'warning',
              priority: 'high'
            });
          }
          if (result.content !== null) {
            if (result.content !== currentPlan) setPlanEditedLocally(true);
            setCurrentPlan(result.content);
            setShowSaveMessage(true);
          }
        } else {
          const result = await editPromptInEditor(currentPlan);
          if (result.error) {
            addNotification({
              key: 'external-editor-error',
              text: result.error,
              color: 'warning',
              priority: 'high'
            });
          }
          if (result.content !== null && result.content !== currentPlan) {
            setCurrentPlan(result.content);
            setShowSaveMessage(true);
          }
        }
      })();
      return;
    }

    // Shift+Tab approves with feedback using the existing accept-edits path.
    if (e.shift && e.key === 'tab') {
      e.preventDefault();
      void handleResponse(showClearContext ? 'yes-accept-edits' : 'yes-accept-edits-keep-context');
      return;
    }
  };
  async function handleResponse(value: ResponseValue): Promise<void> {
    if (value !== 'no' && value !== 'ultraplan' && isV2 && planFilePath) {
      const saved = await persistPlanFileBeforeExit({ planFilePath, currentPlan, addNotification });
      // Write failed — stay in plan mode rather than granting permissions on a
      // plan that was never persisted to disk.
      if (!saved) return;
    }

    const trimmedFeedback = planFeedback.trim();
    const acceptFeedback = trimmedFeedback || undefined;

    // Ultraplan: reject locally, teleport the plan to CCR as a seed draft.
    // Dialog dismisses immediately so the query loop unblocks; the teleport
    // runs detached and its launch message lands via the command queue.
    if (value === 'ultraplan') {
      logEvent('tengu_plan_exit', {
        planLengthChars: currentPlan.length,
        outcome: 'ultraplan' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        planStructureVariant
      });
      onDone();
      onReject();
      toolUseConfirm.onReject('Plan being refined via Ultraplan — please wait for the result.');
      void launchUltraplan({
        blurb: '',
        seedPlan: currentPlan,
        getAppState: store.getState,
        setAppState: store.setState,
        signal: new AbortController().signal
      }).then(msg => enqueuePendingNotification({
        value: msg,
        mode: 'task-notification'
      })).catch(logError);
      return;
    }

    // V1: pass plan in input. V2: plan is on disk, but if the user edited it
    // via Ctrl+G we pass it through so the tool echoes the edit in tool_result
    // (otherwise the model never sees the user's changes).
    const updatedInput = isV2 && !planEditedLocally ? {} : {
      plan: currentPlan
    };
    // If auto was active during plan (from auto mode or opt-in) and NOT going
    // to auto, deactivate auto + restore permissions + fire exit attachment.
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const goingToAuto = (value === 'yes-resume-auto-mode' || value === 'yes-auto-clear-context') && isAutoModeGateEnabled();
      // isAutoModeActive() is the authoritative signal — prePlanMode/
      // strippedDangerousRules are stale after transitionPlanAutoMode
      // deactivates mid-plan (would cause duplicate exit attachment).
      const autoWasUsedDuringPlan = autoModeStateModule?.isAutoModeActive() ?? false;
      if (value !== 'no' && !goingToAuto && autoWasUsedDuringPlan) {
        autoModeStateModule?.setAutoModeActive(false);
        setNeedsAutoModeExitAttachment(true);
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...restoreDangerousPermissions(prev.toolPermissionContext),
            prePlanMode: undefined
          }
        }));
      }
    }

    // Clear-context options: set pending plan implementation and reject the dialog
    // The REPL will handle context clear and trigger a fresh query
    // Keep-context options skip this block and go through the normal flow below
    const isResumeAutoOption = feature('TRANSCRIPT_CLASSIFIER') ? value === 'yes-resume-auto-mode' : false;
    const isKeepContextOption = value === 'yes-bypass-permissions-keep-context' || value === 'yes-full-access-keep-context' || value === 'yes-accept-edits-keep-context' || value === 'yes-default-keep-context' || isResumeAutoOption;
    if (value !== 'no') {
      autoNameSessionFromPlan(currentPlan, setAppState, !isKeepContextOption);
    }
    if (value !== 'no' && !isKeepContextOption) {
      // Determine the permission mode based on the selected option
      let mode: PermissionMode = 'default';
      if (value === 'yes-bypass-permissions') {
        mode = 'bypassPermissions';
      } else if (value === 'yes-full-access') {
        mode = 'fullAccess';
      } else if (value === 'yes-accept-edits') {
        mode = 'acceptEdits';
      } else if (feature('TRANSCRIPT_CLASSIFIER') && value === 'yes-auto-clear-context' && isAutoModeGateEnabled()) {
        // REPL's processInitialMessage handles stripDangerousPermissions + mode,
        // but does NOT set autoModeActive. Gate-off falls through to 'default'.
        mode = 'auto';
        autoModeStateModule?.setAutoModeActive(true);
      }

      // Log plan exit event
      logEvent('tengu_plan_exit', {
        planLengthChars: currentPlan.length,
        outcome: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        clearContext: true,
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        planStructureVariant,
        hasFeedback: !!acceptFeedback
      });

      // Set initial message - REPL will handle context clear and fresh query
      // Capture the transcript path before context is cleared (session ID will be regenerated)
      const transcriptPath = getTranscriptPath();
      const transcriptHint = `\n\nIf you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
      const teamHint = isAgentSwarmsEnabled() ? `\n\nIf this plan can be broken down into multiple independent tasks, consider using the ${TEAM_CREATE_TOOL_NAME} tool to create a team and parallelize the work.` : '';
      const feedbackSuffix = acceptFeedback ? `\n\nUser feedback on this plan: ${acceptFeedback}` : '';
      setAppState(prev => ({
        ...prev,
        initialMessage: {
          message: {
            ...createUserMessage({
              content: `Implement the following plan:\n\n${currentPlan}${transcriptHint}${teamHint}${feedbackSuffix}`
            }),
            planContent: currentPlan
          },
          clearContext: true,
          mode,
          allowedPrompts
        }
      }));
      setHasExitedPlanMode(true);
      onDone();
      onReject();
      // Reject the tool use to unblock the query loop
      // The REPL will see pendingInitialQuery and trigger fresh query
      toolUseConfirm.onReject();
      return;
    }

    // Handle auto keep-context option — needs special handling because
    // buildPermissionUpdates maps auto to 'default' via toExternalPermissionMode.
    // We set the mode directly via setAppState and sync the bootstrap state.
    if (feature('TRANSCRIPT_CLASSIFIER') && value === 'yes-resume-auto-mode' && isAutoModeGateEnabled()) {
      logEvent('tengu_plan_exit', {
        planLengthChars: currentPlan.length,
        outcome: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        clearContext: false,
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        planStructureVariant,
        hasFeedback: !!acceptFeedback
      });
      setHasExitedPlanMode(true);
      setNeedsPlanModeExitAttachment(true);
      autoModeStateModule?.setAutoModeActive(true);
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: stripDangerousPermissionsForAutoMode({
          ...prev.toolPermissionContext,
          mode: 'auto',
          prePlanMode: undefined
        })
      }));
      onDone();
      toolUseConfirm.onAllow(updatedInput, [], acceptFeedback);
      return;
    }

    // Handle keep-context options (goes through normal onAllow flow)
    // yes-resume-auto-mode falls through here when the auto mode gate is
    // disabled (e.g. circuit breaker fired after the dialog rendered).
    // Without this fallback the function would return without resolving the
    // dialog, leaving the query loop blocked and safety state corrupted.
    const keepContextModes: Record<string, PermissionMode> = {
      'yes-bypass-permissions-keep-context': 'bypassPermissions',
      'yes-full-access-keep-context': 'fullAccess',
      'yes-accept-edits-keep-context': dangerousPlanExitMode ?? 'acceptEdits',
      'yes-default-keep-context': 'default',
      ...(feature('TRANSCRIPT_CLASSIFIER') ? {
        'yes-resume-auto-mode': 'default' as const
      } : {})
    };
    const keepContextMode = keepContextModes[value];
    if (keepContextMode) {
      logEvent('tengu_plan_exit', {
        planLengthChars: currentPlan.length,
        outcome: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        clearContext: false,
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        planStructureVariant,
        hasFeedback: !!acceptFeedback
      });
      setHasExitedPlanMode(true);
      setNeedsPlanModeExitAttachment(true);
      onDone();
      toolUseConfirm.onAllow(updatedInput, buildPermissionUpdates(keepContextMode, allowedPrompts), acceptFeedback);
      return;
    }

    // Handle standard approval options
    const standardModes: Record<string, PermissionMode> = {
      ...(dangerousPlanExitMode ? {
        'yes-bypass-permissions': 'bypassPermissions' as const,
        'yes-full-access': 'fullAccess' as const
      } : {}),
      'yes-accept-edits': 'acceptEdits'
    };
    const standardMode = standardModes[value];
    if (standardMode) {
      logEvent('tengu_plan_exit', {
        planLengthChars: currentPlan.length,
        outcome: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        planStructureVariant,
        hasFeedback: !!acceptFeedback
      });
      setHasExitedPlanMode(true);
      setNeedsPlanModeExitAttachment(true);
      onDone();
      toolUseConfirm.onAllow(updatedInput, buildPermissionUpdates(standardMode, allowedPrompts), acceptFeedback);
      return;
    }

    // Handle 'no' - stay in plan mode
    if (value === 'no') {
      if (!trimmedFeedback && !hasImages) {
        // No feedback yet - user is still on the input field
        return;
      }
      logEvent('tengu_plan_exit', {
        planLengthChars: currentPlan.length,
        outcome: 'no' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        planStructureVariant
      });

      // Convert pasted images to ImageBlockParam[] with resizing
      let imageBlocks: ImageBlockParam[] | undefined;
      if (hasImages) {
        imageBlocks = await Promise.all(imageAttachments.map(async img => {
          const block: ImageBlockParam = {
            type: 'image',
            source: {
              type: 'base64',
              media_type: (img.mediaType || 'image/png') as Base64ImageSource['media_type'],
              data: img.content
            }
          };
          const resized = await maybeResizeAndDownsampleImageBlock(block);
          return resized.block;
        }));
      }
      onDone();
      onReject();
      toolUseConfirm.onReject(trimmedFeedback || (hasImages ? '(See attached image)' : undefined), imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined);
    }
  }
  const editor = getExternalEditor();
  const editorName = editor ? toIDEDisplayName(editor) : null;

  // Sticky footer: when setStickyFooter is provided (fullscreen mode), the
  // Select options render in FullscreenLayout's `bottom` slot so they stay
  // visible while the user scrolls through a long plan. handleResponse is
  // wrapped in a ref so the JSX (set once per options/images change) can call
  // the latest closure without re-registering on every keystroke. React
  // reconciles the sticky-footer Select by type, preserving focus/input state.
  const handleResponseRef = useRef(handleResponse);
  handleResponseRef.current = handleResponse;
  const handleCancelRef = useRef<() => void>(undefined);
  handleCancelRef.current = () => {
    logEvent('tengu_plan_exit', {
      planLengthChars: currentPlan.length,
      outcome: 'no' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
      planStructureVariant
    });
    onDone();
    onReject();
    toolUseConfirm.onReject();
  };
  const useStickyFooter = !isEmpty && !!setStickyFooter && !dangerousModeDialog;
  useLayoutEffect(() => {
    if (!useStickyFooter) return;
    setStickyFooter(<Box flexDirection="column" borderStyle="round" borderColor="planMode" borderLeft={false} borderRight={false} borderBottom={false} paddingX={1}>
        <Text dimColor>Would you like to proceed?</Text>
        <Box marginTop={1}>
          <Select options={options} onChange={v => {
          void requestPlanExitModeChange(v, () => {
            void handleResponseRef.current(v);
          });
        }} onCancel={() => handleCancelRef.current?.()} onImagePaste={onImagePaste} pastedContents={pastedContents} onRemoveImage={onRemoveImage} />
        </Box>
        {editorName && <Box flexDirection="row" gap={1} marginTop={1}>
            <Text dimColor>ctrl-g to edit in </Text>
            <Text bold dimColor>
              {editorName}
            </Text>
            {isV2 && planFilePath && <Text dimColor> · {getDisplayPath(planFilePath)}</Text>}
            {showSaveMessage && <>
                <Text dimColor>{' · '}</Text>
                <Text color="success">{figures.tick}Plan saved!</Text>
              </>}
          </Box>}
      </Box>);
    return () => setStickyFooter(null);
    // onImagePaste/onRemoveImage are stable (useCallback/useRef-backed above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useStickyFooter, setStickyFooter, options, pastedContents, editorName, isV2, planFilePath, showSaveMessage]);
  if (dangerousModeDialog) {
    return dangerousModeDialog;
  }

  // Simplified UI for empty plans
  if (isEmpty) {
    function handleEmptyPlanResponse(value: 'yes' | 'no'): void {
      if (value === 'yes') {
        logEvent('tengu_plan_exit', {
          planLengthChars: 0,
          outcome: 'yes-default' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
          planStructureVariant
        });
        if (feature('TRANSCRIPT_CLASSIFIER')) {
          const autoWasUsedDuringPlan = autoModeStateModule?.isAutoModeActive() ?? false;
          if (autoWasUsedDuringPlan) {
            autoModeStateModule?.setAutoModeActive(false);
            setNeedsAutoModeExitAttachment(true);
            setAppState(prev => ({
              ...prev,
              toolPermissionContext: {
                ...restoreDangerousPermissions(prev.toolPermissionContext),
                prePlanMode: undefined
              }
            }));
          }
        }
        setHasExitedPlanMode(true);
        setNeedsPlanModeExitAttachment(true);
        onDone();
        toolUseConfirm.onAllow({}, [{
          type: 'setMode',
          mode: 'default',
          destination: 'session'
        }]);
      } else {
        logEvent('tengu_plan_exit', {
          planLengthChars: 0,
          outcome: 'no' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
          planStructureVariant
        });
        onDone();
        onReject();
        toolUseConfirm.onReject();
      }
    }
    return <PermissionDialog color="planMode" title="Exit plan mode?" workerBadge={workerBadge}>
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text>{PRODUCT_DISPLAY_NAME} wants to exit plan mode</Text>
          <Box marginTop={1}>
            <Select options={[{
            label: 'Yes',
            value: 'yes' as const
          }, {
            label: 'No',
            value: 'no' as const
          }]} onChange={handleEmptyPlanResponse} onCancel={() => {
            logEvent('tengu_plan_exit', {
              planLengthChars: 0,
              outcome: 'no' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
              planStructureVariant
            });
            onDone();
            onReject();
            toolUseConfirm.onReject();
          }} />
          </Box>
        </Box>
      </PermissionDialog>;
  }
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <PermissionDialog color="planMode" title="Ready to code?" innerPaddingX={0} workerBadge={workerBadge}>
        <Box flexDirection="column" marginTop={1}>
          <Box paddingX={1} flexDirection="column">
            <Text>Here is {planAuthorName}&apos;s plan:</Text>
          </Box>
          <Box borderColor="subtle" borderStyle="dashed" flexDirection="column" borderLeft={false} borderRight={false} paddingX={1} marginBottom={1}
        // Necessary for Windows Terminal to render properly
        overflow="hidden">
            <Markdown>{currentPlan}</Markdown>
          </Box>
          <Box flexDirection="column" paddingX={1}>
            <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" />
            {isClassifierPermissionsEnabled() && allowedPrompts && allowedPrompts.length > 0 && <Box flexDirection="column" marginBottom={1}>
                  <Text bold>Requested permissions:</Text>
                  {allowedPrompts.map((p, i) => <Text key={i} dimColor>
                      {'  '}· {p.tool}({PROMPT_PREFIX} {p.prompt})
                    </Text>)}
                </Box>}
            {!useStickyFooter && <>
                <Text dimColor>
                  {planAuthorName} has written up a plan and is ready to execute. Would
                  you like to proceed?
                </Text>
                <Box marginTop={1}>
                  <Select options={options} onChange={v => {
                void requestPlanExitModeChange(v, () => {
                  void handleResponse(v);
                });
              }} onCancel={() => handleCancelRef.current?.()} onImagePaste={onImagePaste} pastedContents={pastedContents} onRemoveImage={onRemoveImage} />
                </Box>
              </>}
          </Box>
        </Box>
      </PermissionDialog>
      {!useStickyFooter && editorName && <Box flexDirection="row" gap={1} paddingX={1} marginTop={1}>
          <Box>
            <Text dimColor>ctrl-g to edit in </Text>
            <Text bold dimColor>
              {editorName}
            </Text>
            {isV2 && planFilePath && <Text dimColor> · {getDisplayPath(planFilePath)}</Text>}
          </Box>
          {showSaveMessage && <Box>
              <Text dimColor>{' · '}</Text>
              <Text color="success">{figures.tick}Plan saved!</Text>
            </Box>}
        </Box>}
    </Box>;
}

/** @internal Exported for testing. */
export function buildPlanApprovalOptions({
  showClearContext,
  showUltraplan,
  usedPercent,
  isAutoModeAvailable,
  dangerousPlanExitMode,
  planAuthorName,
  onFeedbackChange
}: {
  showClearContext: boolean;
  showUltraplan: boolean;
  usedPercent: number | null;
  isAutoModeAvailable: boolean | undefined;
  dangerousPlanExitMode: DangerousPlanExitMode | null;
  planAuthorName: string;
  onFeedbackChange: (v: string) => void;
}): OptionWithDescription<ResponseValue>[] {
  const options: OptionWithDescription<ResponseValue>[] = [];
  const usedLabel = usedPercent !== null ? ` (${usedPercent}% used)` : '';
  if (showClearContext) {
    if (feature('TRANSCRIPT_CLASSIFIER') && isAutoModeAvailable) {
      options.push({
        label: `Yes, clear context${usedLabel} and use auto mode`,
        value: 'yes-auto-clear-context'
      });
    }
    if (dangerousPlanExitMode) {
      options.push({
        label: `Yes, clear context${usedLabel} and ${getDangerousPlanExitLabel(dangerousPlanExitMode)}`,
        value: dangerousPlanExitMode === 'fullAccess' ? 'yes-full-access' : 'yes-bypass-permissions'
      });
      if (dangerousPlanExitMode !== 'fullAccess') {
        options.push({
          label: `Yes, clear context${usedLabel} and full access`,
          value: 'yes-full-access'
        });
      }
    } else if (!feature('TRANSCRIPT_CLASSIFIER') || !isAutoModeAvailable) {
      options.push({
        label: `Yes, clear context${usedLabel} and auto-accept edits`,
        value: 'yes-accept-edits'
      });
    }
  }

  // Slot 2: keep-context with elevated mode (same priority: auto > bypass > edits).
  if (feature('TRANSCRIPT_CLASSIFIER') && isAutoModeAvailable) {
    options.push({
      label: 'Yes, and use auto mode',
      value: 'yes-resume-auto-mode'
    });
  }
  if (dangerousPlanExitMode) {
    options.push({
      label: `Yes, and ${getDangerousPlanExitLabel(dangerousPlanExitMode)}`,
      value: dangerousPlanExitMode === 'fullAccess' ? 'yes-full-access-keep-context' : 'yes-bypass-permissions-keep-context'
    });
    if (dangerousPlanExitMode !== 'fullAccess') {
      options.push({
        label: 'Yes, and full access',
        value: 'yes-full-access-keep-context'
      });
    }
  } else if (!feature('TRANSCRIPT_CLASSIFIER') || !isAutoModeAvailable) {
    options.push({
      label: 'Yes, auto-accept edits',
      value: 'yes-accept-edits-keep-context'
    });
  }
  options.push({
    label: 'Yes, manually approve edits',
    value: 'yes-default-keep-context'
  });
  if (showUltraplan) {
    options.push({
      label: `No, refine with Ultraplan on ${PRODUCT_DISPLAY_NAME} on the web`,
      value: 'ultraplan'
    });
  }
  options.push({
    type: 'input',
    label: 'No, keep planning',
    value: 'no',
    placeholder: `Tell ${planAuthorName} what to change`,
    description: 'shift+tab to approve with this feedback',
    onChange: onFeedbackChange
  });
  return options;
}
function getContextUsedPercent(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | undefined, permissionMode: PermissionMode): number | null {
  if (!usage) return null;
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel: getMainLoopModel(),
    exceeds200kTokens: false
  });
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas());
  const {
    used
  } = calculateContextPercentages({
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0
  }, contextWindowSize);
  return used;
}
