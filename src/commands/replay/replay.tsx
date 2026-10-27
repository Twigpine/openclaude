import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import type { UUID } from 'crypto';
import * as React from 'react';
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js';
import { LogSelector } from '../../components/LogSelector.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Spinner } from '../../components/Spinner.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { LogOption, ReplayIndex } from '../../types/logs.js';
import { loadReplayIndex } from '../../utils/replayIndex.js';
import { getWorktreePaths } from '../../utils/getWorktreePaths.js';
import { getSessionIdFromLog, getTranscriptPathForSession, isLiteLog, loadFullLog, loadSameRepoMessageLogs } from '../../utils/sessionStorage.js';
import { validateUuid } from '../../utils/uuid.js';
import { agenticSessionSearch } from '../../utils/agenticSessionSearch.js';
import { ReplayTimeline } from './ReplayTimeline.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}m ${seconds}s`
}

function formatToolBreakdown(breakdown: Record<string, number>): string {
  return Object.entries(breakdown)
    .map(([tool, count]) => `${count} ${tool}`)
    .join(', ')
}

async function findLogBySessionId(sessionId: UUID): Promise<LogOption | undefined> {
  const logs = await loadSameRepoMessageLogs(await getWorktreePaths(getOriginalCwd()));
  return logs.find(log => getSessionIdFromLog(log) === sessionId);
}

function ReplaySessionPicker({
  onDone,
}: {
  onDone: (result?: string) => void;
}): React.ReactNode {
  const [logs, setLogs] = React.useState<LogOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState(false);
  const [replayIndex, setReplayIndex] = React.useState<ReplayIndex | null>(null);
  const { rows } = useTerminalSize();
  const insideModal = useIsInsideModal();

  React.useEffect(() => {
    async function loadLogs() {
      setLoading(true);
      try {
        const allLogs = await loadSameRepoMessageLogs(await getWorktreePaths(getOriginalCwd()));
        // Filter out sidechain sessions and current session
        const replayable = allLogs.filter(l => !l.isSidechain && getSessionIdFromLog(l) !== getSessionId());
        if (replayable.length === 0) {
          onDone('No sessions found to replay');
          return;
        }
        setLogs(replayable);
      } catch (_err) {
        onDone('Failed to load sessions');
      } finally {
        setLoading(false);
      }
    }
    void loadLogs();
  }, [onDone]);

  async function handleSelect(log: LogOption) {
    const sessionId = validateUuid(getSessionIdFromLog(log));
    if (!sessionId) {
      onDone('Failed to load session');
      return;
    }

    let fullLog: LogOption;
    try {
      fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
    } catch {
      onDone('Failed to load log file');
      return;
    }
    setSelected(true);
    const transcriptPath = fullLog.fullPath || getTranscriptPathForSession(sessionId);
    const index = await loadReplayIndex(sessionId, transcriptPath);
    if (index) {
      setReplayIndex(index);
      return;
    }
    onDone('No replay data found for this session');
  }

  function handleCancel() {
    onDone('Replay cancelled');
  }

  if (loading) {
    return (
      <Box>
        <Spinner />
        <Text> Loading sessions…</Text>
      </Box>
    );
  }

  if (replayIndex) {
    return <ReplayTimeline index={replayIndex} onExit={() => onDone('Replay dismissed')} />;
  }

  if (selected) {
    return (
      <Box>
        <Spinner />
        <Text> Loading replay…</Text>
      </Box>
    );
  }

  return (
    <LogSelector
      logs={logs}
      maxHeight={insideModal ? Math.floor(rows / 2) : rows - 2}
      onCancel={handleCancel}
      onSelect={handleSelect}
      onLogsChanged={() => {}}
    />
  );
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  // If args provided, try to find session by ID or search
  if (args?.trim()) {
    const query = args.trim();
    try {
      const sessionId = validateUuid(query);
      if (sessionId) {
        const matchingLog = await findLogBySessionId(sessionId);
        const transcriptPath = matchingLog?.fullPath || getTranscriptPathForSession(sessionId);
        const replayIndex = await loadReplayIndex(sessionId, transcriptPath);
        if (replayIndex) {
          return <ReplayTimeline index={replayIndex} onExit={() => onDone('Replay dismissed')} />;
        }
        return <MessageResponse>
          <Text>No replay data found for session {chalk.bold(query)}</Text>
        </MessageResponse>;
      }

      // Try to search by title
      const logs = await loadSameRepoMessageLogs(await getWorktreePaths(getOriginalCwd()));
      const matchingLog = logs.find(l =>
        l.customTitle?.toLowerCase().includes(query.toLowerCase()) ||
        l.firstPrompt?.toLowerCase().includes(query.toLowerCase())
      );

      if (matchingLog) {
        const sessionId = validateUuid(getSessionIdFromLog(matchingLog));
        if (sessionId) {
          const transcriptPath = matchingLog.fullPath || getTranscriptPathForSession(sessionId);
          const replayIndex = await loadReplayIndex(sessionId, transcriptPath);
          if (replayIndex) {
            return <ReplayTimeline index={replayIndex} onExit={() => onDone('Replay dismissed')} />;
          }
          return <MessageResponse>
            <Text>No replay data found for session {chalk.bold(matchingLog.customTitle ?? matchingLog.firstPrompt ?? query)}</Text>
          </MessageResponse>;
        }
      }

      return <MessageResponse>
        <Text>No session found matching &quot;{query}&quot;</Text>
      </MessageResponse>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return <MessageResponse>
        <Text>Unable to load replay data for {chalk.bold(query)}: {message}</Text>
      </MessageResponse>;
    }
  }

  // No args - show session picker
  return <ReplaySessionPicker 
    onDone={onDone}
  />;
};
