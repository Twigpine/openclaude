import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import { dirname } from 'path';
import React from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { getOriginalCwd, getSessionId, switchSession } from '../bootstrap/state.js';
import type { Command } from '../commands.js';
import { LogSelector, getResumeLogDisplayTitle } from '../components/LogSelector.js';
import { DeleteSessionConfirm } from '../components/DeleteSessionConfirm.js';
import { Spinner } from '../components/Spinner.js';
import { restoreCostStateForSession } from '../cost-tracker.js';
import { setClipboard } from '../ink/termio/osc.js';
import { Box, Text } from '../ink.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import useApp from '../ink/hooks/use-app.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { listBackgroundSessions } from '../cli/bgRegistry.js';
import { deleteSession } from '../entrypoints/sdk/sessions.js';
import { getSessionIdFromLog } from '../utils/sessionStorage.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../services/analytics/index.js';
import type { MCPServerConnection, ScopedMcpServerConfig } from '../services/mcp/types.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import type { Tool } from '../Tool.js';
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js';
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js';
import { asSessionId } from '../types/ids.js';
import type { LogOption } from '../types/logs.js';
import type { Message } from '../types/message.js';
import { agenticSessionSearch } from '../utils/agenticSessionSearch.js';
import { renameRecordingForSession } from '../utils/asciicast.js';
import { updateSessionName } from '../utils/concurrentSessions.js';
import { loadConversationForResume } from '../utils/conversationRecovery.js';
import { checkCrossProjectResume } from '../utils/crossProjectResume.js';
import { errorMessage } from '../utils/errors.js';
import type { FileHistorySnapshot } from '../utils/fileHistory.js';
import { isMouseTrackingEnabled, isTmuxControlMode } from '../utils/fullscreen.js';
import { logError } from '../utils/log.js';
import { createSystemMessage } from '../utils/messages.js';
import { computeStandaloneAgentContext, createForkSessionInfoMessage, restoreAgentFromSession, restoreWorktreeForResume } from '../utils/sessionRestore.js';
import { adoptResumedSessionFile, enrichLogs, isCustomTitleEnabled, loadAllProjectsMessageLogsProgressive, loadSameRepoMessageLogsProgressive, recordContentReplacement, resetSessionFilePointer, restoreSessionMetadata, type SessionLogResult } from '../utils/sessionStorage.js';
import type { ModelSetting } from '../utils/model/model.js';
import type { ThinkingConfig } from '../utils/thinking.js';
import { filterContentReplacementsForMessages, type ContentReplacementRecord } from '../utils/toolResultStorage.js';
import { REPL } from './REPL.js';
import { filterResumeLogs } from './resumeFilters.js';
import { getDeleteBlockReason } from './resumeDeleteGuards.js';
type Props = {
  commands: Command[];
  worktreePaths: string[];
  initialTools: Tool[];
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  debug: boolean;
  mainThreadAgentDefinition?: AgentDefinition;
  baseMainLoopModel?: ModelSetting;
  hasExplicitModelOverride?: boolean;
  autoConnectIdeFlag?: boolean;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  initialSearchQuery?: string;
  disableSlashCommands?: boolean;
  forkSession?: boolean;
  filterByPr?: boolean | number | string;
  thinkingConfig: ThinkingConfig;
  fallbackModel?: string;
  maxTurns?: number;
  onTurnComplete?: (messages: Message[]) => void | Promise<void>;
};
export function ResumeConversation({
  commands,
  worktreePaths,
  initialTools,
  mcpClients,
  dynamicMcpConfig,
  debug,
  mainThreadAgentDefinition,
  baseMainLoopModel,
  hasExplicitModelOverride,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt,
  appendSystemPrompt,
  initialSearchQuery,
  disableSlashCommands = false,
  forkSession,
  filterByPr,
  thinkingConfig,
  fallbackModel,
  maxTurns,
  onTurnComplete
}: Props): React.ReactNode {
  const {
    rows
  } = useTerminalSize();
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const setAppState = useSetAppState();
  const { exit } = useApp();
  const [logs, setLogs] = React.useState<LogOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [resuming, setResuming] = React.useState(false);
  const [showAllProjects, setShowAllProjects] = React.useState(false);
  const [resumeData, setResumeData] = React.useState<{
    messages: Message[];
    fileHistorySnapshots?: FileHistorySnapshot[];
    contentReplacements?: ContentReplacementRecord[];
    agentName?: string;
    agentColor?: AgentColorName;
    mainThreadAgentDefinition?: AgentDefinition;
  } | null>(null);
  const [resumeError, setResumeError] = React.useState<string | null>(null);
  const [deletingLog, setDeletingLog] = React.useState<LogOption | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = React.useState<string | null>(null);
  const [crossProjectCommand, setCrossProjectCommand] = React.useState<string | null>(null);
  const sessionLogResultRef = React.useRef<SessionLogResult | null>(null);
  // Mirror of logs.length so loadMoreLogs can compute value indices outside
  // the setLogs updater (keeping it pure per React's contract).
  const logCountRef = React.useRef(0);
  const filteredLogs = React.useMemo(() => {
    return filterResumeLogs(logs, filterByPr);
  }, [logs, filterByPr]);
  const isResumeWithRenameEnabled = isCustomTitleEnabled();
  React.useEffect(() => {
    loadSameRepoMessageLogsProgressive(worktreePaths).then(result_0 => {
      sessionLogResultRef.current = result_0;
      logCountRef.current = result_0.logs.length;
      setLogs(result_0.logs);
      setLoading(false);
    }).catch(error => {
      logError(error);
      setLoading(false);
    });
  }, [worktreePaths]);
  const loadMoreLogs = React.useCallback((count: number) => {
    const ref = sessionLogResultRef.current;
    if (!ref || ref.nextIndex >= ref.allStatLogs.length) return;
    void enrichLogs(ref.allStatLogs, ref.nextIndex, count).then(result_1 => {
      ref.nextIndex = result_1.nextIndex;
      if (result_1.logs.length > 0) {
        // enrichLogs returns fresh unshared objects — safe to mutate in place.
        // Offset comes from logCountRef so the setLogs updater stays pure.
        const offset = logCountRef.current;
        result_1.logs.forEach((log, i) => {
          log.value = offset + i;
        });
        setLogs(prev => prev.concat(result_1.logs));
        logCountRef.current += result_1.logs.length;
      } else if (ref.nextIndex < ref.allStatLogs.length) {
        loadMoreLogs(count);
      }
    });
  }, []);
  const loadLogs = React.useCallback((allProjects: boolean) => {
    setLoading(true);
    const promise = allProjects ? loadAllProjectsMessageLogsProgressive() : loadSameRepoMessageLogsProgressive(worktreePaths);
    promise.then(result_2 => {
      sessionLogResultRef.current = result_2;
      logCountRef.current = result_2.logs.length;
      setLogs(result_2.logs);
    }).catch(error_0 => {
      logError(error_0);
    }).finally(() => {
      setLoading(false);
    });
  }, [worktreePaths]);
  const handleToggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects;
    setShowAllProjects(newValue);
    loadLogs(newValue);
  }, [showAllProjects, loadLogs]);
  /**
   * Exit the picker with the given code after Ink has unmounted.
   * Unmount restores terminal modes and exits the alternate screen back to
   * the main buffer via synchronous writes; any remaining async output is
   * flushed first via the drain callback because process.exit() drops
   * unflushed writes. The failsafe covers a stdout that never drains.
   */
  function exitPicker(exitCode: number): void {
    try {
      process.stdout.write('', () => {
        // eslint-disable-next-line custom-rules/no-process-exit -- flush-then-exit, see above
        process.exit(exitCode);
      });
    } catch {
      // eslint-disable-next-line custom-rules/no-process-exit -- flush-then-exit, see above
      process.exit(exitCode);
    }
    // eslint-disable-next-line custom-rules/no-process-exit -- failsafe, see above
    setTimeout(() => process.exit(exitCode), 500);
  }
  function onCancel() {
    // Unmount first so terminal modes are restored and the alternate screen
    // is exited back to the main buffer; exitPicker flushes remaining output
    // before exiting. Exiting here preempts renderAndRun's shutdown epilogue,
    // so no resume hint or SessionEnd hooks run for a cancel — same observable
    // behavior as before, minus the residue. Exit code 1 (cancel) is preserved.
    exit();
    exitPicker(1);
  }
  async function onSelect(log_0: LogOption) {
    setResumeError(null);
    setResuming(true);
    const resumeStart = performance.now();
    const crossProjectCheck = checkCrossProjectResume(log_0, showAllProjects, worktreePaths);
    if (crossProjectCheck.isCrossProject) {
      if (!crossProjectCheck.isSameRepoWorktree) {
        const raw = await setClipboard(crossProjectCheck.command);
        if (raw) process.stdout.write(raw);
        setCrossProjectCommand(crossProjectCheck.command);
        return;
      }
    }
    try {
      const result_3 = await loadConversationForResume(log_0, undefined);
      if (!result_3) {
        throw new Error('Failed to load conversation');
      }
      if (feature('COORDINATOR_MODE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const coordinatorModule = require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const warning = coordinatorModule.matchSessionMode(result_3.mode);
        if (warning) {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const {
            getAgentDefinitionsWithOverrides,
            getActiveAgentsFromList
          } = require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js');
          /* eslint-enable @typescript-eslint/no-require-imports */
          getAgentDefinitionsWithOverrides.cache.clear?.();
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(getOriginalCwd());
          setAppState(prev_0 => ({
            ...prev_0,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents)
            }
          }));
          result_3.messages.push(createSystemMessage(warning, 'warning'));
        }
      }
      if (result_3.sessionId && !forkSession) {
        switchSession(asSessionId(result_3.sessionId), log_0.fullPath ? dirname(log_0.fullPath) : null);
        await renameRecordingForSession();
        await resetSessionFilePointer();
        restoreCostStateForSession(result_3.sessionId);
      } else if (forkSession && result_3.contentReplacements?.length) {
        result_3.contentReplacements = filterContentReplacementsForMessages(result_3.messages, result_3.contentReplacements);
        if (result_3.contentReplacements.length) {
          await recordContentReplacement(result_3.contentReplacements);
        }
      }
      if (forkSession) {
        result_3.messages.push(createForkSessionInfoMessage(result_3.sessionId ?? log_0.sessionId));
      }
      const {
        agentDefinition: resolvedAgentDef
      } = restoreAgentFromSession(result_3.agentSetting, mainThreadAgentDefinition, agentDefinitions);
      setAppState(prev_1 => ({
        ...prev_1,
        agent: resolvedAgentDef?.agentType
      }));
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
      const standaloneAgentContext = computeStandaloneAgentContext(result_3.agentName, result_3.agentColor);
      if (standaloneAgentContext) {
        setAppState(prev_2 => ({
          ...prev_2,
          standaloneAgentContext
        }));
      }
      void updateSessionName(result_3.agentName);
      restoreSessionMetadata(forkSession ? {
        ...result_3,
        worktreeSession: undefined
      } : result_3);
      if (!forkSession) {
        restoreWorktreeForResume(result_3.worktreeSession);
        if (result_3.sessionId) {
          adoptResumedSessionFile();
        }
      }
      if (feature('CONTEXT_COLLAPSE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        ;
        (require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')).restoreFromEntries(result_3.contextCollapseCommits ?? [], result_3.contextCollapseSnapshot);
        /* eslint-enable @typescript-eslint/no-require-imports */
      }
      logEvent('tengu_session_resumed', {
        entrypoint: 'picker' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart)
      });
      setLogs([]);
      setResumeData({
        messages: result_3.messages,
        fileHistorySnapshots: result_3.fileHistorySnapshots,
        contentReplacements: result_3.contentReplacements,
        agentName: result_3.agentName,
        agentColor: (result_3.agentColor === 'default' ? undefined : result_3.agentColor) as AgentColorName | undefined,
        mainThreadAgentDefinition: resolvedAgentDef
      });
    } catch (e) {
      logEvent('tengu_session_resumed', {
        entrypoint: 'picker' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: false
      });
      logError(e as Error);
      setResumeError(errorMessage(e));
      setResuming(false);
    }
  }
  function dropLogFromList(sessionId: string) {
    setLogs(prev => prev.filter(l => getSessionIdFromLog(l) !== sessionId));
    logCountRef.current = Math.max(0, logCountRef.current - 1);
  }
  async function handleDeleteRequest(log_0: LogOption) {
    const targetId = getSessionIdFromLog(log_0);
    setDeleteError(null);
    setDeleteNotice(null);
    if (!targetId) {
      setDeleteError('Cannot determine the session id for this entry.');
      return;
    }
    if (targetId === getSessionId()) {
      setDeleteError('Cannot delete the active session.');
      return;
    }
    try {
      const bgSessions = await listBackgroundSessions();
      const runningIds = new Set(bgSessions.filter(s => s.status === 'running' || s.status === 'unknown').map(s => s.sessionId));
      const blockReason = getDeleteBlockReason(targetId, getSessionId(), runningIds);
      if (blockReason) {
        setDeleteError(blockReason);
        return;
      }
    } catch (e) {
      setDeleteError(`Failed to check background sessions: ${errorMessage(e)}`);
      return;
    }
    setDeletingLog(log_0);
  }
  async function handleDeleteConfirm() {
    const target = deletingLog;
    if (!target) return;
    const targetId = getSessionIdFromLog(target);
    if (!targetId) {
      setDeletingLog(null);
      return;
    }
    try {
      await deleteSession(targetId);
      dropLogFromList(targetId);
      setDeletingLog(null);
      setDeleteNotice(`Deleted ${getResumeLogDisplayTitle(target)}.`);
      logEvent('tengu_session_delete', {
        confirmed: true,
        success: true
      });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Session not found')) {
        dropLogFromList(targetId);
        setDeletingLog(null);
        setDeleteNotice('Already deleted.');
        logEvent('tengu_session_delete', {
          confirmed: true,
          success: true
        });
        return;
      }
      setDeleteError(`Failed to delete: ${errorMessage(e)}`);
      logEvent('tengu_session_delete', {
        confirmed: true,
        success: false
      });
    }
  }
  function handleDeleteCancel() {
    logEvent('tengu_session_delete', {
      confirmed: false
    });
    setDeletingLog(null);
  }
  if (crossProjectCommand) {
    return <CrossProjectMessage command={crossProjectCommand} />;
  }
  if (resumeData) {
    return <REPL debug={debug} commands={commands} initialTools={initialTools} initialMessages={resumeData.messages} initialFileHistorySnapshots={resumeData.fileHistorySnapshots} initialContentReplacements={resumeData.contentReplacements} initialAgentName={resumeData.agentName} initialAgentColor={resumeData.agentColor} mcpClients={mcpClients} dynamicMcpConfig={dynamicMcpConfig} strictMcpConfig={strictMcpConfig} systemPrompt={systemPrompt} appendSystemPrompt={appendSystemPrompt} mainThreadAgentDefinition={resumeData.mainThreadAgentDefinition} baseMainLoopModel={baseMainLoopModel} hasExplicitModelOverride={hasExplicitModelOverride} autoConnectIdeFlag={autoConnectIdeFlag} disableSlashCommands={disableSlashCommands} thinkingConfig={thinkingConfig} fallbackModel={fallbackModel} maxTurns={maxTurns} onTurnComplete={onTurnComplete} />;
  }
  if (loading) {
    return <Box>
        <Spinner />
        <Text> Loading conversations…</Text>
      </Box>;
  }
  if (resuming) {
    return <Box>
        <Spinner />
        <Text> Resuming conversation…</Text>
      </Box>;
  }
  const resumeErrorBanner = resumeError ? <Box flexDirection="column" marginBottom={1}>
      <Text color="red">Failed to resume conversation.</Text>
      <Text>{resumeError}</Text>
      <Text dimColor={true}>Choose a different conversation to continue.</Text>
    </Box> : null;
  const deleteBanner = deleteError || deleteNotice ? <Box flexDirection="column" marginBottom={1}>
      {deleteError && <Text color="red">{deleteError}</Text>}
      {deleteNotice && <Text>{deleteNotice}</Text>}
    </Box> : null;
  if (filteredLogs.length === 0) {
    return <NoConversationsMessage />;
  }
  const picker = <Box flexDirection="column">
      {resumeErrorBanner}
      {deleteBanner}
      {deletingLog && <DeleteSessionConfirm sessionTitle={getResumeLogDisplayTitle(deletingLog)} sessionId={getSessionIdFromLog(deletingLog) ?? ''} onConfirm={() => void handleDeleteConfirm()} onCancel={handleDeleteCancel} />}
      <LogSelector logs={filteredLogs} maxHeight={rows} onCancel={onCancel} onSelect={onSelect} onDeleteRequest={handleDeleteRequest} isInputDisabled={deletingLog !== null} onLogsChanged={isResumeWithRenameEnabled ? () => loadLogs(showAllProjects) : undefined} onLoadMore={loadMoreLogs} initialSearchQuery={initialSearchQuery} showAllProjects={showAllProjects} onToggleAllProjects={handleToggleAllProjects} onAgenticSearch={agenticSessionSearch} />
    </Box>;
  // Run the picker on the alternate screen everywhere except tmux -CC, where
  // alt-screen is known to corrupt terminal state. Cancelling then restores
  // the main buffer instead of leaving a stale frame: Ink deliberately
  // persists the last inline frame on exit, so inline rendering can never
  // exit cleanly here. Mirrors the REPL's <AlternateScreen> usage.
  if (!isTmuxControlMode()) {
    return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{picker}</AlternateScreen>;
  }
  return picker;
}
function NoConversationsMessage() {
  const $ = _c(2);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = {
      context: "Global"
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  useKeybinding("app:interrupt", _temp, t0);
  let t1;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Box flexDirection="column"><Text>No conversations found to resume.</Text><Text dimColor={true}>Press Ctrl+C to exit and start a new conversation.</Text></Box>;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}
function _temp() {
  process.exit(1);
}
function CrossProjectMessage(t0) {
  const $ = _c(8);
  const {
    command
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  React.useEffect(_temp3, t1);
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Text>This conversation is from a different directory.</Text>;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  let t3;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text>To resume, run:</Text>;
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  let t4;
  if ($[3] !== command) {
    t4 = <Box flexDirection="column">{t3}<Text> {command}</Text></Box>;
    $[3] = command;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  let t5;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text dimColor={true}>(Command copied to clipboard)</Text>;
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  let t6;
  if ($[6] !== t4) {
    t6 = <Box flexDirection="column" gap={1}>{t2}{t4}{t5}</Box>;
    $[6] = t4;
    $[7] = t6;
  } else {
    t6 = $[7];
  }
  return t6;
}
function _temp3() {
  const timeout = setTimeout(_temp2, 100);
  return () => clearTimeout(timeout);
}
function _temp2() {
  process.exit(0);
}
