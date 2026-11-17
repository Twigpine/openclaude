import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import type { UUID } from 'crypto';
import figures from 'figures';
import * as React from 'react';
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js';
import { buildGoalStartInstruction } from '../../services/goal/instructions.js';
import { saveGoalState } from '../../services/goal/persistence.js';
import { resumeGoal } from '../../services/goal/state.js';
import type { GoalState } from '../../services/goal/types.js';
import type { CommandResultDisplay, ResumeEntrypoint } from '../../commands.js';
import { LogSelector } from '../../components/LogSelector.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { SessionSummary } from '../../components/SessionSummary.js';
import { Spinner } from '../../components/Spinner.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { setClipboard } from '../../ink/termio/osc.js';
import { Box, Text, useInput } from '../../ink.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { LogOption } from '../../types/logs.js';
import type { TodoItem, TodoList } from '../../utils/todo/types.js';
import { agenticSessionSearch } from '../../utils/agenticSessionSearch.js';
import { checkCrossProjectResume } from '../../utils/crossProjectResume.js';
import { getWorktreePaths } from '../../utils/getWorktreePaths.js';
import { logError } from '../../utils/log.js';
import { loadReplayIndex } from '../../utils/replayIndex.js';
import { getLastSessionLog, getSessionIdFromLog, getTranscriptPathForSession, isCustomTitleEnabled, isLiteLog, loadAllProjectsMessageLogs, loadFullLog, loadSameRepoMessageLogs, searchSessionsByCustomTitle } from '../../utils/sessionStorage.js';
import { validateUuid } from '../../utils/uuid.js';
type ResumeResult = {
  resultType: 'sessionNotFound';
  arg: string;
} | {
  resultType: 'multipleMatches';
  arg: string;
  count: number;
};
function resumeHelpMessage(result: ResumeResult): string {
  switch (result.resultType) {
    case 'sessionNotFound':
      return `Session ${chalk.bold(result.arg)} was not found.`;
    case 'multipleMatches':
      return `Found ${result.count} sessions matching ${chalk.bold(result.arg)}. Please use /resume to pick a specific session.`;
  }
}

type ResumeConfirmationSession = {
  sessionId: UUID;
  log: LogOption;
}

export function ResumeConfirmation({
  selectedSession,
  sessionSummary,
  resuming,
  onResume,
  onCancel,
}: {
  selectedSession: ResumeConfirmationSession;
  sessionSummary: import('../../types/logs.js').ReplaySummary;
  resuming: boolean;
  onResume: (session: ResumeConfirmationSession) => void;
  onCancel: () => void;
}): React.ReactNode {
  useInput((_input, key) => {
    if (key.return) {
      onResume(selectedSession);
    } else if (key.escape) {
      onCancel();
    }
  }, {
    isActive: !resuming,
  });

  return (
    <Box flexDirection="column">
      <SessionSummary summary={sessionSummary} />
      <Box marginTop={1}>
        <Text>Press </Text>
        <Text bold color="green">Enter</Text>
        <Text> to resume, </Text>
        <Text bold color="red">Escape</Text>
        <Text> to cancel</Text>
      </Box>
    </Box>
  );
}

function ResumeError(t0) {
  const $ = _c(10);
  const {
    message,
    args,
    onDone
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onDone) {
    t1 = () => {
      const timer = setTimeout(onDone, 0);
      return () => clearTimeout(timer);
    };
    t2 = [onDone];
    $[0] = onDone;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  React.useEffect(t1, t2);
  let t3;
  if ($[3] !== args) {
    t3 = <Text dimColor={true}>{figures.pointer} /resume {args}</Text>;
    $[3] = args;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== message) {
    t4 = <MessageResponse><Text>{message}</Text></MessageResponse>;
    $[5] = message;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== t3 || $[8] !== t4) {
    t5 = <Box flexDirection="column">{t3}{t4}</Box>;
    $[7] = t3;
    $[8] = t4;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
function ResumeCommand({
  onDone,
  onResume
}: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onResume: (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => Promise<void>;
}): React.ReactNode {
  const [logs, setLogs] = React.useState<LogOption[]>([]);
  const [worktreePaths, setWorktreePaths] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [resuming, setResuming] = React.useState(false);
  const [showAllProjects, setShowAllProjects] = React.useState(false);
  const [selectedSession, setSelectedSession] = React.useState<{ sessionId: UUID; log: LogOption } | null>(null);
  const [sessionSummary, setSessionSummary] = React.useState<import('../../types/logs.js').ReplaySummary | null>(null);
  const {
    rows
  } = useTerminalSize();
  const insideModal = useIsInsideModal();
  const loadLogs = React.useCallback(async (allProjects: boolean, paths: string[]) => {
    setLoading(true);
    try {
      const allLogs = allProjects ? await loadAllProjectsMessageLogs() : await loadSameRepoMessageLogs(paths);
      const resumable = filterResumableSessions(allLogs, getSessionId());
      if (resumable.length === 0) {
        onDone('No conversations found to resume');
        return;
      }
      setLogs(resumable);
    } catch (_err) {
      onDone('Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }, [onDone]);
  React.useEffect(() => {
    async function init() {
      const paths_0 = await getWorktreePaths(getProjectRoot());
      setWorktreePaths(paths_0);
      void loadLogs(false, paths_0);
    }
    void init();
  }, [loadLogs]);
  const handleToggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects;
    setShowAllProjects(newValue);
    void loadLogs(newValue, worktreePaths);
  }, [showAllProjects, loadLogs, worktreePaths]);
  async function handleSelect(log: LogOption) {
    const sessionId = validateUuid(getSessionIdFromLog(log));
    if (!sessionId) {
      onDone('Failed to resume conversation');
      return;
    }

    // Load full messages for lite logs
    const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;

    // Check if this conversation is from a different directory
    const crossProjectCheck = checkCrossProjectResume(fullLog, showAllProjects, worktreePaths);
    if (crossProjectCheck.isCrossProject) {
      if (crossProjectCheck.isSameRepoWorktree) {
        // Same repo worktree - can resume directly
        // Try to load replay summary
        const transcriptPath = fullLog.fullPath || getTranscriptPathForSession(sessionId);
        const replayIndex = await loadReplayIndex(sessionId, transcriptPath);
        if (replayIndex) {
          setSessionSummary(replayIndex.summary);
          setSelectedSession({ sessionId, log: fullLog });
        } else {
          setResuming(true);
          void onResume(sessionId, fullLog, 'slash_command_picker');
        }
        return;
      }

      // Different project - show command instead of resuming
      const raw = await setClipboard(crossProjectCheck.command);
      if (raw) process.stdout.write(raw);

      // Format the output message
      const message = ['', 'This conversation is from a different directory.', '', 'To resume, run:', `  ${crossProjectCheck.command}`, '', '(Command copied to clipboard)', ''].join('\n');
      onDone(message, {
        display: 'user'
      });
      return;
    }

    // Same directory - try to show summary first
    const transcriptPath = fullLog.fullPath || getTranscriptPathForSession(sessionId);
    const replayIndex = await loadReplayIndex(sessionId, transcriptPath);
    if (replayIndex) {
      setSessionSummary(replayIndex.summary);
      setSelectedSession({ sessionId, log: fullLog });
    } else {
      // No replay data, proceed directly
      setResuming(true);
      void onResume(sessionId, fullLog, 'slash_command_picker');
    }
  }

  function handleConfirmResume(session = selectedSession) {
    if (session) {
      setResuming(true);
      void onResume(session.sessionId, session.log, 'slash_command_picker');
    }
  }

  function handleCancelResume() {
    setSelectedSession(null);
    setSessionSummary(null);
  }

  function handleCancel() {
    onDone('Resume cancelled', {
      display: 'system'
    });
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

  // Show session summary confirmation if a session is selected
  if (selectedSession && sessionSummary) {
    return <ResumeConfirmation selectedSession={selectedSession} sessionSummary={sessionSummary} resuming={resuming} onResume={handleConfirmResume} onCancel={handleCancelResume} />;
  }

  return <LogSelector logs={logs} maxHeight={insideModal ? Math.floor(rows / 2) : rows - 2} onCancel={handleCancel} onSelect={handleSelect} onLogsChanged={() => loadLogs(showAllProjects, worktreePaths)} showAllProjects={showAllProjects} onToggleAllProjects={handleToggleAllProjects} onAgenticSearch={agenticSessionSearch} />;
}
export function filterResumableSessions(logs: LogOption[], currentSessionId: string): LogOption[] {
  return logs.filter(l => !l.isSidechain && getSessionIdFromLog(l) !== currentSessionId);
}

function DirectResumeConfirmation({
  selectedSession,
  sessionSummary,
  entrypoint,
  onResume,
  onDone,
}: {
  selectedSession: ResumeConfirmationSession;
  sessionSummary: import('../../types/logs.js').ReplaySummary;
  entrypoint: ResumeEntrypoint;
  onResume: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>;
  onDone: Parameters<LocalJSXCommandCall>[0];
}): React.ReactNode {
  const [resuming, setResuming] = React.useState(false);

  return (
    <ResumeConfirmation
      selectedSession={selectedSession}
      sessionSummary={sessionSummary}
      resuming={resuming}
      onResume={session => {
        if (resuming) return;
        setResuming(true);
        void onResume(session.sessionId, session.log, entrypoint);
      }}
      onCancel={() => {
        if (resuming) return;
        onDone('Resume cancelled', {
          display: 'system',
        });
      }}
    />
  );
}

async function resumeWithOptionalSummary(
  sessionId: UUID,
  log: LogOption,
  entrypoint: ResumeEntrypoint,
  onResume: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>,
  onDone: Parameters<LocalJSXCommandCall>[0],
): Promise<React.ReactNode> {
  const transcriptPath = log.fullPath || getTranscriptPathForSession(sessionId);
  const replayIndex = await loadReplayIndex(sessionId, transcriptPath);
  if (!replayIndex) {
    void onResume(sessionId, log, entrypoint);
    return null;
  }

  return (
    <DirectResumeConfirmation
      selectedSession={{ sessionId, log }}
      sessionSummary={replayIndex.summary}
      entrypoint={entrypoint}
      onResume={onResume}
      onDone={onDone}
    />
  );
}

function isResumableGoal(goal: GoalState | null): goal is GoalState {
  return goal != null && (goal.status === 'active' || goal.status === 'paused');
}

function formatTodoStatus(status: TodoItem['status']): string {
  switch (status) {
    case 'in_progress':
      return 'in progress';
    case 'completed':
      return 'done';
    default:
      return status;
  }
}

function formatTodosMessage(todos: TodoList): string {
  const lines = todos.map(todo => `- [${formatTodoStatus(todo.status)}] ${todo.content}`);
  return lines.length === 0
    ? 'No todos are currently tracked.'
    : ['Current todos:', ...lines].join('\n');
}

const CONTINUE_INSTRUCTION = `The user asked you to continue.

Resume the most recent task based on the conversation transcript. Do not simply acknowledge the request. Pick up exactly where you left off and take the next concrete step. Only ask for clarification if the next action is genuinely ambiguous.`;

function buildGenericContinueMessage(extraContext: string | null): string {
  return extraContext
    ? `${extraContext}\n\n${CONTINUE_INSTRUCTION}`
    : CONTINUE_INSTRUCTION;
}

function formatContinuationHint(hint: string | null): string | null {
  return hint ? `User continuation hint:\n${hint}` : null;
}

function appendContinuationHint(message: string, hint: string | null): string {
  const formattedHint = formatContinuationHint(hint);
  return formattedHint ? `${message}\n\n${formattedHint}` : message;
}

async function tryContinueCurrentTask(
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: Parameters<LocalJSXCommandCall>[0],
  continuationHint: string | null = null,
): Promise<boolean> {
  const appState = context.getAppState();
  const currentGoal = appState.goal ?? null;

  if (isResumableGoal(currentGoal)) {
    const goal =
      currentGoal.status === 'paused' ? resumeGoal(currentGoal) : currentGoal;
    if (goal !== currentGoal) {
      context.setAppState(prev => ({ ...prev, goal }));
      try {
        await saveGoalState(goal);
      } catch (error) {
        logError(error as Error);
      }
    }
    onDone(
      currentGoal.status === 'active'
        ? 'Goal already active; continuing.'
        : 'Goal resumed.',
      {
        shouldQuery: true,
        metaMessages: [
          appendContinuationHint(
            buildGoalStartInstruction(goal),
            continuationHint,
          ),
        ],
      },
    );
    return true;
  }

  const sessionId = context.agentId ?? getSessionId();
  const todos = appState.todos[sessionId];

  if (todos && todos.length > 0) {
    const todoContext = [
      formatTodosMessage(todos),
      formatContinuationHint(continuationHint),
    ].filter(Boolean).join('\n\n');
    onDone('Continuing current task.', {
      shouldQuery: true,
      metaMessages: [buildGenericContinueMessage(todoContext)],
    });
    return true;
  }

  return false;
}

export const continueCall: LocalJSXCommandCall = async (onDone, context, args) => {
  const arg = args?.trim() || null;
  if (await tryContinueCurrentTask(context, onDone, arg)) {
    return null;
  }

  onDone('Continuing current task.', {
    shouldQuery: true,
    metaMessages: [
      buildGenericContinueMessage(formatContinuationHint(arg)),
    ],
  });
  return null;
};

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const onResume = async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
    try {
      await context.resume?.(sessionId, log, entrypoint);
      onDone(undefined, {
        display: 'skip'
      });
    } catch (error) {
      logError(error as Error);
      onDone(`Failed to resume: ${(error as Error).message}`);
    }
  };
  const arg = args?.trim();

  // No argument provided - show picker
  if (!arg) {
    return <ResumeCommand key={Date.now()} onDone={onDone} onResume={onResume} />;
  }

  // Load logs to search (includes same-repo worktrees)
  const worktreePaths = await getWorktreePaths(getProjectRoot());
  const logs = await loadSameRepoMessageLogs(worktreePaths);
  if (logs.length === 0) {
    const message = 'No conversations found to resume.';
    return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
  }

  // First, check if arg is a valid UUID
  const maybeSessionId = validateUuid(arg);
  if (maybeSessionId) {
    const matchingLogs = logs.filter(l => getSessionIdFromLog(l) === maybeSessionId).sort((a, b) => b.modified.getTime() - a.modified.getTime());
    if (matchingLogs.length > 0) {
      const log = matchingLogs[0]!;
      const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
      return resumeWithOptionalSummary(
        maybeSessionId,
        fullLog,
        'slash_command_session_id',
        onResume,
        onDone,
      );
    }

    // Enriched logs didn't find it — try direct file lookup. This handles
    // sessions filtered out by enrichLogs (e.g., first message >16KB makes
    // firstPrompt extraction fail, causing the session to be dropped).
    const directLog = await getLastSessionLog(maybeSessionId);
    if (directLog) {
      return resumeWithOptionalSummary(
        maybeSessionId,
        directLog,
        'slash_command_session_id',
        onResume,
        onDone,
      );
    }
  }

  // Next, try exact custom title match (only if feature is enabled)
  if (isCustomTitleEnabled()) {
    const titleMatches = await searchSessionsByCustomTitle(arg, {
      exact: true
    });
    if (titleMatches.length === 1) {
      const log = titleMatches[0]!;
      const sessionId = getSessionIdFromLog(log);
      if (sessionId) {
        const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
        return resumeWithOptionalSummary(
          sessionId,
          fullLog,
          'slash_command_title',
          onResume,
          onDone,
        );
      }
    }

    // Multiple matches - show error
    if (titleMatches.length > 1) {
      const message = resumeHelpMessage({
        resultType: 'multipleMatches',
        arg,
        count: titleMatches.length
      });
      return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
    }
  }

  // No match found - show error
  const message = resumeHelpMessage({
    resultType: 'sessionNotFound',
    arg
  });
  return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
};
