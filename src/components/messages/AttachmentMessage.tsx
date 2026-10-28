import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import React from 'react';
import { Ansi, Box, Text } from '../../ink.js';
import type { Attachment } from 'src/utils/attachments.js';
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js';
import { useAppState } from '../../state/AppState.js';
import { getDisplayPath } from 'src/utils/file.js';
import { formatFileSize } from 'src/utils/format.js';
import { MessageResponse } from '../MessageResponse.js';
import { basename, sep } from 'path';
import { UserTextMessage } from './UserTextMessage.js';
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js';
import { getContentText } from 'src/utils/messages.js';
import type { Theme } from 'src/utils/theme.js';
import { UserImageMessage } from './UserImageMessage.js';
import { toInkColor } from '../../utils/ink.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { plural } from '../../utils/stringUtils.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { tryRenderPlanApprovalMessage, formatTeammateMessageContent } from './PlanApprovalMessage.js';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { TeammateMessageContent } from './UserTeammateMessage.js';
import { isShutdownApproved } from '../../utils/teammateMailbox.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import FullWidthRow from '../design-system/FullWidthRow.js';
import { FilePathLink } from '../FilePathLink.js';
import { feature } from 'bun:bundle';
import { useSelectedMessageBg } from '../messageActions.js';
type Props = {
  addMargin: boolean;
  attachment: Attachment;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function AttachmentMessage({
  attachment,
  addMargin,
  verbose,
  isTranscriptMode
}: Props): React.ReactNode {
  const bg = useSelectedMessageBg();
  // Handle teammate_mailbox BEFORE switch
  if (isAgentSwarmsEnabled() && attachment.type === 'teammate_mailbox') {
    // Filter out idle notifications BEFORE counting - they are hidden in the UI
    // so showing them in the count would be confusing ("2 messages in mailbox:" with nothing shown)
    const visibleMessages = attachment.messages.filter(msg => {
      if (isShutdownApproved(msg.text)) {
        return false;
      }
      try {
        const parsed = jsonParse(msg.text);
        return parsed?.type !== 'idle_notification' && parsed?.type !== 'teammate_terminated';
      } catch {
        return true; // Non-JSON messages are visible
      }
    });
    if (visibleMessages.length === 0) {
      return null;
    }
    return <Box flexDirection="column">
        {visibleMessages.map((msg_0, idx) => {
        // Try to parse as JSON for task_assignment messages
        let parsedMsg: {
          type?: string;
          taskId?: string;
          subject?: string;
          assignedBy?: string;
        } | null = null;
        try {
          parsedMsg = jsonParse(msg_0.text);
        } catch {
          // Not JSON, treat as plain text
        }
        if (parsedMsg?.type === 'task_assignment') {
          return <Box key={idx} paddingLeft={2}>
                <Text>{BLACK_CIRCLE} </Text>
                <Text>Task assigned: </Text>
                <Text bold>#{parsedMsg.taskId}</Text>
                <Text> - {parsedMsg.subject}</Text>
                <Text dimColor> (from {parsedMsg.assignedBy || msg_0.from})</Text>
              </Box>;
        }

        // Note: idle_notification messages already filtered out above

        // Try to render as plan approval message (request or response)
        const planApprovalElement = tryRenderPlanApprovalMessage(msg_0.text, msg_0.from);
        if (planApprovalElement) {
          return <React.Fragment key={idx}>{planApprovalElement}</React.Fragment>;
        }

        // Plain text message - sender header with chevron, truncated content
        const inkColor = toInkColor(msg_0.color);
        const formattedContent = formatTeammateMessageContent(msg_0.text) ?? msg_0.text;
        return <TeammateMessageContent key={idx} displayName={msg_0.from} inkColor={inkColor} content={formattedContent} summary={msg_0.summary} isTranscriptMode={isTranscriptMode} />;
      })}
      </Box>;
  }

  // skill_discovery rendered here (not in the switch) so the 'skill_discovery'
  // string literal stays inside a feature()-guarded block. A case label can't
  // be conditionally eliminated; an if-body can.
  if (feature('EXPERIMENTAL_SKILL_SEARCH')) {
    if (attachment.type === 'skill_discovery') {
      if (attachment.skills.length === 0) return null;
      const names = attachment.skills.map(s => s.shortId ? `${s.name} [${s.shortId}]` : s.name).join(', ');
      const hint = '';
      return <Line>
          <Text bold>{attachment.skills.length}</Text> relevant{' '}
          {plural(attachment.skills.length, 'skill')}: {names}
          {hint && <Text dimColor>{hint}</Text>}
        </Line>;
    }
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- teammate_mailbox/skill_discovery handled before switch
  switch (attachment.type) {
    case 'max_turns_reached':
      return <Line>
          <Text color="warning">Reached the maximum number of turns ({attachment.maxTurns}).</Text>
        </Line>;
    case 'directory':
      return <Line>
          Listed directory <Text bold>{attachment.displayPath + sep}</Text>
        </Line>;
    case 'file':
    case 'already_read_file':
      if (attachment.content.type === 'notebook') {
        return <Line>
            Read <Text bold>{attachment.displayPath}</Text> (
            {attachment.content.file.cells.length} cells)
          </Line>;
      }
      if (attachment.content.type === 'file_unchanged') {
        return <Line>
            Read <Text bold>{attachment.displayPath}</Text> (unchanged)
          </Line>;
      }
      return <Line>
          Read <Text bold>{attachment.displayPath}</Text> (
          {attachment.content.type === 'text' ? `${attachment.content.file.numLines}${attachment.truncated ? '+' : ''} lines` : formatFileSize(attachment.content.file.originalSize)}
          )
        </Line>;
    case 'compact_file_reference':
      return <Line>
          Referenced file <Text bold>{attachment.displayPath}</Text>
        </Line>;
    case 'pdf_reference':
      return <Line>
          Referenced PDF <Text bold>{attachment.displayPath}</Text> (
          {attachment.pageCount} pages)
        </Line>;
    case 'selected_lines_in_ide':
      return <Line>
          ⧉ Selected{' '}
          <Text bold>{attachment.lineEnd - attachment.lineStart + 1}</Text>{' '}
          lines from <Text bold>{attachment.displayPath}</Text> in{' '}
          {attachment.ideName}
        </Line>;
    case 'nested_memory':
      return <Line>
          Loaded <Text bold>{attachment.displayPath}</Text>
        </Line>;
    case 'relevant_memories':
      // Usually absorbed into a CollapsedReadSearchGroup (collapseReadSearch.ts)
      // so this only renders when the preceding tool was non-collapsible (Edit,
      // Write) and no group was open. Match CollapsedReadSearchContent's style:
      // 2-space gutter, dim text, count only — filenames/content in ctrl+o.
      return <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={bg}>
          <Box flexDirection="row">
            <Box minWidth={2} />
            <Text dimColor>
              Recalled <Text bold>{attachment.memories.length}</Text>{' '}
              {attachment.memories.length === 1 ? 'memory' : 'memories'}
              {!isTranscriptMode && <>
                  {' '}
                  <CtrlOToExpand />
                </>}
            </Text>
          </Box>
          {(verbose || isTranscriptMode) && attachment.memories.map(m => <Box key={m.path} flexDirection="column">
                <MessageResponse>
                  <Text dimColor>
                    <FilePathLink filePath={m.path}>
                      {basename(m.path)}
                    </FilePathLink>
                  </Text>
                </MessageResponse>
                {isTranscriptMode && <Box paddingLeft={5}>
                    <Text>
                      <Ansi>{m.content}</Ansi>
                    </Text>
                  </Box>}
              </Box>)}
        </Box>;
    case 'dynamic_skill':
      {
        const skillCount = attachment.skillNames.length;
        return <Line>
          Loaded{' '}
          <Text bold>
            {skillCount} {plural(skillCount, 'skill')}
          </Text>{' '}
          from <Text bold>{attachment.displayPath}</Text>
        </Line>;
      }
    case 'skill_listing':
      {
        if (attachment.isInitial) {
          return null;
        }
        return <Line>
          <Text bold>{attachment.skillCount}</Text>{' '}
          {plural(attachment.skillCount, 'skill')} available
        </Line>;
      }
    case 'agent_listing_delta':
      {
        if (attachment.isInitial || attachment.addedTypes.length === 0) {
          return null;
        }
        const count = attachment.addedTypes.length;
        return <Line>
          <Text bold>{count}</Text> agent {plural(count, 'type')} available
        </Line>;
      }
    case 'queued_command':
      {
        const text = typeof attachment.prompt === 'string' ? attachment.prompt : getContentText(attachment.prompt) || '';
        const hasImages = attachment.imagePasteIds && attachment.imagePasteIds.length > 0;
        return <Box flexDirection="column">
          <UserTextMessage addMargin={addMargin} param={{
            text,
            type: 'text'
          }} verbose={verbose} isTranscriptMode={isTranscriptMode} />
          {hasImages && attachment.imagePasteIds?.map(id => <UserImageMessage key={id} imageId={id} />)}
        </Box>;
      }
    case 'plan_file_reference':
      return <Line>
          Plan file referenced ({getDisplayPath(attachment.planFilePath)})
        </Line>;
    case 'invoked_skills':
      {
        if (attachment.skills.length === 0) {
          return null;
        }
        const skillNames = attachment.skills.map(s_0 => s_0.name).join(', ');
        return <Line>Skills restored ({skillNames})</Line>;
      }
    case 'diagnostics':
      return <DiagnosticsDisplay attachment={attachment} verbose={verbose} />;
    case 'mcp_resource':
      return <Line>
          Read MCP resource <Text bold>{attachment.name}</Text> from{' '}
          {attachment.server}
        </Line>;
    case 'command_permissions':
      // The skill success message is rendered by SkillTool's renderToolResultMessage,
      // so we don't render anything here to avoid duplicate messages.
      return null;
    case 'async_hook_response':
      {
        // SessionStart hook completions are only shown in verbose mode
        if (attachment.hookEvent === 'SessionStart' && !verbose) {
          return null;
        }
        // Generally hide async hook completion messages unless in verbose mode
        if (!verbose && !isTranscriptMode) {
          return null;
        }
        return <Line>
          Async hook <Text bold>{attachment.hookEvent}</Text> completed
        </Line>;
      }
    case 'hook_blocking_error':
      {
        // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
        if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
          return null;
        }
        // Show stderr to the user so they can understand why the hook blocked
        const stderr = attachment.blockingError.blockingError.trim();
        return <>
          <Line color="error">
            {attachment.hookName} hook returned blocking error
          </Line>
          {stderr ? <Line color="error">{stderr}</Line> : null}
        </>;
      }
    case 'hook_non_blocking_error':
      {
        // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
        if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
          return null;
        }
        // Full hook output is logged to debug log via hookEvents.ts
        return <Line color="error">{attachment.hookName} hook error</Line>;
      }
    case 'hook_error_during_execution':
      // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null;
      }
      // Full hook output is logged to debug log via hookEvents.ts
      return <Line>{attachment.hookName} hook warning</Line>;
    case 'hook_success':
      // Full hook output is logged to debug log via hookEvents.ts
      return null;
    case 'hook_stopped_continuation':
      // Stop hooks are rendered as a summary in SystemStopHookSummaryMessage
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null;
      }
      return <Line color="warning">
          {attachment.hookName} hook stopped continuation: {attachment.message}
        </Line>;
    case 'hook_system_message':
      return <Line>
          {attachment.hookName} says: {attachment.content}
        </Line>;
    case 'hook_permission_decision':
      {
        const action = attachment.decision === 'allow' ? 'Allowed' : 'Denied';
        return <Line>
          {action} by <Text bold>{attachment.hookEvent}</Text> hook
        </Line>;
      }
    case 'task_status':
      return <TaskStatusMessage attachment={attachment} />;
    case 'teammate_shutdown_batch':
      return <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg}>
          <Text dimColor>{BLACK_CIRCLE} </Text>
          <Text dimColor>
            {attachment.count} {plural(attachment.count, 'teammate')} shut down
            gracefully
          </Text>
        </Box>;
    default:
      // Exhaustiveness: every type reaching here must be in NULL_RENDERING_TYPES.
      // If TS errors, a new Attachment type was added without a case above AND
      // without an entry in NULL_RENDERING_TYPES — decide: render something (add
      // a case) or render nothing (add to the array). Messages.tsx pre-filters
      // these so this branch is defense-in-depth for other render paths.
      //
      // skill_discovery and teammate_mailbox are handled BEFORE the switch in
      // runtime-gated blocks (feature() / isAgentSwarmsEnabled()) that TS can't
      // narrow through — excluded here via type union (compile-time only, no emit).
      // bagel_console intentionally renders null here (it has no UI of its own)
      // but is not in NULL_RENDERING_TYPES, so it still counts toward the
      // Messages.tsx render budget.
      attachment.type satisfies NullRenderingAttachmentType | 'skill_discovery' | 'teammate_mailbox' | 'bagel_console';
      return null;
  }
}
type TaskStatusAttachment = Extract<Attachment, {
  type: 'task_status';
}>;
function TaskStatusMessage(t0) {
  const $ = _c(4);
  const {
    attachment
  } = t0;
  if (isAgentSwarmsEnabled() && attachment.taskType === "in_process_teammate") {
    let t1;
    if ($[0] !== attachment) {
      t1 = <TeammateTaskStatus attachment={attachment} />;
      $[0] = attachment;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    return t1;
  }
  let t1;
  if ($[2] !== attachment) {
    t1 = <GenericTaskStatus attachment={attachment} />;
    $[2] = attachment;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  return t1;
}
function GenericTaskStatus(t0) {
  const $ = _c(9);
  const {
    attachment
  } = t0;
  const bg = useSelectedMessageBg();
  const statusText = attachment.status === "completed" ? "completed in background" : attachment.status === "killed" ? "stopped" : attachment.status === "running" ? "still running in background" : attachment.status;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text dimColor={true}>{BLACK_CIRCLE} </Text>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== attachment.description) {
    t2 = <Text bold={true}>{attachment.description}</Text>;
    $[1] = attachment.description;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== statusText || $[4] !== t2) {
    t3 = <Text dimColor={true}>Task "{t2}" {statusText}</Text>;
    $[3] = statusText;
    $[4] = t2;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] !== bg || $[7] !== t3) {
    t4 = <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg}>{t1}{t3}</Box>;
    $[6] = bg;
    $[7] = t3;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  return t4;
}
function TeammateTaskStatus(t0) {
  const $ = _c(16);
  const {
    attachment
  } = t0;
  const bg = useSelectedMessageBg();
  let t1;
  if ($[0] !== attachment.taskId) {
    t1 = s => s.tasks[attachment.taskId];
    $[0] = attachment.taskId;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const task = useAppState(t1);
  if (task?.type !== "in_process_teammate") {
    let t2;
    if ($[2] !== attachment) {
      t2 = <GenericTaskStatus attachment={attachment} />;
      $[2] = attachment;
      $[3] = t2;
    } else {
      t2 = $[3];
    }
    return t2;
  }
  let t2;
  if ($[4] !== task.identity.color) {
    t2 = toInkColor(task.identity.color);
    $[4] = task.identity.color;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const agentColor = t2;
  const statusText = attachment.status === "completed" ? "shut down gracefully" : attachment.status;
  let t3;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text dimColor={true}>{BLACK_CIRCLE} </Text>;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  let t4;
  if ($[7] !== agentColor || $[8] !== task.identity.agentName) {
    t4 = <Text color={agentColor} bold={true} dimColor={false}>@{task.identity.agentName}</Text>;
    $[7] = agentColor;
    $[8] = task.identity.agentName;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  let t5;
  if ($[10] !== statusText || $[11] !== t4) {
    t5 = <Text dimColor={true}>Teammate{" "}{t4}{" "}{statusText}</Text>;
    $[10] = statusText;
    $[11] = t4;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  let t6;
  if ($[13] !== bg || $[14] !== t5) {
    t6 = <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg}>{t3}{t5}</Box>;
    $[13] = bg;
    $[14] = t5;
    $[15] = t6;
  } else {
    t6 = $[15];
  }
  return t6;
}
// We allow setting dimColor to false here to help work around the dim-bold bug.
// https://github.com/chalk/chalk/issues/290
function Line(t0) {
  const $ = _c(7);
  const {
    dimColor: t1,
    children,
    color
  } = t0;
  const dimColor = t1 === undefined ? true : t1;
  const bg = useSelectedMessageBg();
  let t2;
  if ($[0] !== children || $[1] !== color || $[2] !== dimColor) {
    t2 = <MessageResponse><FullWidthRow><Text color={color} dimColor={dimColor} wrap="wrap">{children}</Text></FullWidthRow></MessageResponse>;
    $[0] = children;
    $[1] = color;
    $[2] = dimColor;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== bg || $[5] !== t2) {
    t3 = <Box backgroundColor={bg}>{t2}</Box>;
    $[4] = bg;
    $[5] = t2;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  return t3;
}
