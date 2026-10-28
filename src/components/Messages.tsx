import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import chalk from 'chalk';
import type { UUID } from 'crypto';
import type { RefObject } from 'react';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { every } from 'src/utils/set.js';
import { getIsRemoteMode } from '../bootstrap/state.js';
import type { Command } from '../commands.js';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import { Box, Text } from '../ink.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import type { Screen } from '../screens/REPL.js';
import type { Tools } from '../Tool.js';
import { findToolByName } from '../Tool.js';
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js';
import type { Message as MessageType, NormalizedMessage, ProgressMessage as ProgressMessageType, RenderableMessage } from '../types/message.js';
import { type AdvisorBlock, isAdvisorBlock } from '../utils/advisor.js';
import { collapseBackgroundBashNotifications } from '../utils/collapseBackgroundBashNotifications.js';
import { collapseHookSummaries } from '../utils/collapseHookSummaries.js';
import { collapseReadSearchGroups } from '../utils/collapseReadSearch.js';
import { collapseTeammateShutdowns } from '../utils/collapseTeammateShutdowns.js';
import { getGlobalConfig } from '../utils/config.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { applyGrouping } from '../utils/groupToolUses.js';
import { buildMessageLookups, createAssistantMessage, deriveUUID, getMessagesAfterCompactBoundary, getToolUseID, getToolUseIDs, hasUnresolvedHooksFromLookup, isNotEmptyMessage, normalizeMessages, normalizeMessagesCached, reorderMessagesInUI, type StreamingThinking, type StreamingToolUse, shouldShowUserMessage } from '../utils/messages.js';
import { plural } from '../utils/stringUtils.js';
import { renderableSearchText } from '../utils/transcriptSearch.js';
import { Divider } from './design-system/Divider.js';
import type { UnseenDivider } from './FullscreenLayout.js';
import { StreamingMarkdown } from './Markdown.js';
import { hasContentAfterIndex, MessageRow } from './MessageRow.js';
import { InVirtualListContext, type MessageActionsNav, MessageActionsSelectedContext, type MessageActionsState } from './messageActions.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { isNullRenderingAttachment } from './messages/nullRenderingAttachments.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import type { ToolUseConfirm } from './permissions/PermissionRequest.js';
import { StatusNotices } from './StatusNotices.js';
import type { JumpHandle } from './VirtualMessageList.js';

// Memoed logo header: this box is the FIRST sibling before all MessageRows
// in main-screen mode. If it becomes dirty on every Messages re-render,
// renderChildren's seenDirtyChild cascade disables prevScreen (blit) for
// ALL subsequent siblings — every MessageRow re-writes from scratch instead
// of blitting. In long sessions (~2800 messages) this is 150K+ writes/frame
// and pegs CPU at 100%. Memo on agentDefinitions so a new messages array
// doesn't invalidate the logo subtree. LogoV2/StatusNotices internally
// subscribe to useAppState/useSettings for their own updates.
const LogoHeader = React.memo(function LogoHeader(t0: {
  agentDefinitions?: AgentDefinitionsResult;
}) {
  const $ = _c(3);
  const {
    agentDefinitions
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = null;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== agentDefinitions) {
    t2 = <OffscreenFreeze><Box flexDirection="column" gap={1}>{t1}<React.Suspense fallback={null}><StatusNotices agentDefinitions={agentDefinitions} /></React.Suspense></Box></OffscreenFreeze>;
    $[1] = agentDefinitions;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  return t2;
});

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/index.js') : null;
const BRIEF_TOOL_NAME: string | null = feature('KAIROS') || feature('KAIROS_BRIEF') ? (require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')).BRIEF_TOOL_NAME : null;
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS') ? (require('../tools/SendUserFileTool/prompt.js') as typeof import('../tools/SendUserFileTool/prompt.js')).SEND_USER_FILE_TOOL_NAME : null;

/* eslint-enable @typescript-eslint/no-require-imports */
import { VirtualMessageList } from './VirtualMessageList.js';

/**
 * In brief-only mode, filter messages to show ONLY Brief tool_use blocks,
 * their tool_results, and real user input. All assistant text is dropped —
 * if the model forgets to call Brief, the user sees nothing for that turn.
 * That's on the model to get right; the filter does not second-guess it.
 */
export function filterForBriefTool<T extends {
  type: string;
  subtype?: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    content: Array<{
      type: string;
      name?: string;
      tool_use_id?: string;
    }>;
  };
  attachment?: {
    type: string;
    isMeta?: boolean;
    origin?: unknown;
    commandMode?: string;
  };
}>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames);
  // tool_use always precedes its tool_result in the array, so we can collect
  // IDs and match against them in a single pass.
  const briefToolUseIDs = new Set<string>();
  return messages.filter(msg => {
    // System messages (attach confirmation, remote errors, compact boundaries)
    // must stay visible — dropping them leaves the viewer with no feedback.
    // Exception: api_metrics is per-turn debug noise (TTFT, config writes,
    // hook timing) that defeats the point of brief mode. Still visible in
    // transcript mode (ctrl+o) which bypasses this filter.
    if (msg.type === 'system') return msg.subtype !== 'api_metrics';
    const block = msg.message?.content[0];
    if (msg.type === 'assistant') {
      // API error messages (auth failures, rate limits, etc.) must stay visible
      if (msg.isApiErrorMessage) return true;
      // Keep Brief tool_use blocks (renders with standard tool call chrome,
      // and must be in the list so buildMessageLookups can resolve tool results)
      if (block?.type === 'tool_use' && block.name && nameSet.has(block.name)) {
        if ('id' in block) {
          briefToolUseIDs.add((block as {
            id: string;
          }).id);
        }
        return true;
      }
      return false;
    }
    if (msg.type === 'user') {
      if (block?.type === 'tool_result') {
        return block.tool_use_id !== undefined && briefToolUseIDs.has(block.tool_use_id);
      }
      // Real user input only — drop meta/tick messages.
      return !msg.isMeta;
    }
    if (msg.type === 'attachment') {
      // Human input drained mid-turn arrives as a queued_command attachment
      // (query.ts mid-chain drain → getQueuedCommandAttachments). Keep it —
      // it's what the user typed. commandMode === 'prompt' positively
      // identifies human-typed input; task-notification callers set
      // mode: 'task-notification' but not origin/isMeta, so the positive
      // commandMode check is required to exclude them.
      const att = msg.attachment;
      return att?.type === 'queued_command' && att.commandMode === 'prompt' && !att.isMeta && att.origin === undefined;
    }
    return false;
  });
}

/**
 * Full-transcript companion to filterForBriefTool. When the Brief tool is
 * in use, the model's text output is redundant with the SendUserMessage
 * content it wrote right after — drop the text so only the SendUserMessage
 * block shows. Tool calls and their results stay visible.
 *
 * Per-turn: only drops text in turns that actually called Brief. If the
 * model forgets, text still shows — otherwise the user would see nothing.
 */
export function dropTextInBriefTurns<T extends {
  type: string;
  isMeta?: boolean;
  message?: {
    content: Array<{
      type: string;
      name?: string;
    }>;
  };
}>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames);
  // First pass: find which turns (bounded by non-meta user messages) contain
  // a Brief tool_use. Tag each assistant text block with its turn index.
  const turnsWithBrief = new Set<number>();
  const textIndexToTurn: number[] = [];
  let turn = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const block = msg.message?.content[0];
    if (msg.type === 'user' && block?.type !== 'tool_result' && !msg.isMeta) {
      turn++;
      continue;
    }
    if (msg.type === 'assistant') {
      if (block?.type === 'text') {
        textIndexToTurn[i] = turn;
      } else if (block?.type === 'tool_use' && block.name && nameSet.has(block.name)) {
        turnsWithBrief.add(turn);
      }
    }
  }
  if (turnsWithBrief.size === 0) return messages;
  // Second pass: drop text blocks whose turn called Brief.
  return messages.filter((_, i) => {
    const t = textIndexToTurn[i];
    return t === undefined || !turnsWithBrief.has(t);
  });
}
type Props = {
  messages: MessageType[];
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  toolJSX: {
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
  } | null;
  toolUseConfirmQueue: ToolUseConfirm[];
  inProgressToolUseIDs: Set<string>;
  isMessageSelectorVisible: boolean;
  conversationId: string;
  screen: Screen;
  streamingToolUses: StreamingToolUse[];
  showAllInTranscript?: boolean;
  agentDefinitions?: AgentDefinitionsResult;
  onOpenRateLimitOptions?: () => void;
  /** Hide the logo/header - used for subagent zoom view */
  hideLogo?: boolean;
  isLoading: boolean;
  /** In transcript mode, hide all thinking blocks except the last one */
  hidePastThinking?: boolean;
  /** Streaming thinking content (live updates, not frozen) */
  streamingThinking?: StreamingThinking | null;
  /** Streaming text preview (rendered as last item so transition to final message is positionally seamless) */
  streamingText?: string | null;
  /** When true, only show Brief tool output (hide everything else) */
  isBriefOnly?: boolean;
  /** Fullscreen-mode "─── N new ───" divider. Renders before the first
   *  renderableMessage derived from firstUnseenUuid (matched by the 24-char
   *  prefix that deriveUUID preserves). */
  unseenDivider?: UnseenDivider;
  /** Fullscreen-mode ScrollBox handle. Enables React-level virtualization when present. */
  scrollRef?: RefObject<ScrollBoxHandle | null>;
  /** Fullscreen-mode: enable sticky-prompt tracking (writes via ScrollChromeContext). */
  trackStickyPrompt?: boolean;
  /** Transcript search: jump-to-index + setSearchQuery/nextMatch/prevMatch. */
  jumpRef?: RefObject<JumpHandle | null>;
  /** Transcript search: fires when match count/position changes. */
  onSearchMatchesChange?: (count: number, current: number) => void;
  /** Paint an existing DOM subtree to fresh Screen, scan. Element comes
   *  from the main tree (all real providers). Message-relative positions. */
  scanElement?: (el: import('../ink/dom.js').DOMElement) => import('../ink/render-to-screen.js').MatchPosition[];
  /** Position-based CURRENT highlight. positions stable (msg-relative),
   *  rowOffset tracks scroll. null clears. */
  setPositions?: (state: {
    positions: import('../ink/render-to-screen.js').MatchPosition[];
    rowOffset: number;
    currentIdx: number;
  } | null) => void;
  /** Bypass MAX_MESSAGES_WITHOUT_VIRTUALIZATION. For one-shot headless renders
   *  (e.g. /export via renderToString) where the memory concern doesn't apply
   *  and the "already in scrollback" justification doesn't hold. */
  disableRenderCap?: boolean;
  /** In-transcript cursor; expanded overrides verbose for selected message. */
  cursor?: MessageActionsState | null;
  setCursor?: (cursor: MessageActionsState | null) => void;
  /** Passed through to VirtualMessageList (heightCache owns visibility). */
  cursorNavRef?: React.Ref<MessageActionsNav>;
  /** Render only collapsed.slice(start, end). For chunked headless export
   *  (streamRenderedMessages in exportRenderer.tsx): prep runs on the FULL
   *  messages array so grouping/lookups are correct, but only this slice
   *  chunk instead of the full session. The logo renders only for chunk 0
   *  (start === 0); later chunks are mid-stream continuations.
   *  Measured Mar 2026: 538-msg session, 20 slices → −55% plateau RSS. */
  renderRange?: readonly [start: number, end: number];
};
const MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30;

// Safety cap for the non-virtualized render path (fullscreen off or
// explicitly disabled). Ink mounts a full fiber tree per message (~250 KB
// RSS each); yoga layout height grows unbounded; the screen buffer is sized
// to fit every line. At ~2000 messages this is ~3000-line screens, ~500 MB
// of fibers, and per-frame write costs that push the process into a GC
// death spiral (observed: 59 GB RSS, 14k mmap/munmap/sec). Content dropped
// from this slice has already been printed to terminal scrollback — users
// can still scroll up natively. VirtualMessageList (the default ant path)
// bypasses this cap entirely. Headless one-shot renders (e.g. /export)
// pass disableRenderCap to opt out — they have no scrollback and the
// memory concern doesn't apply to renderToString.
//
// The slice boundary is tracked as a UUID anchor, not a count-derived
// index. Count-based slicing (slice(-200)) drops one message from the
// front on every append, shifting scrollback content and forcing a full
// terminal reset per turn (CC-941). Quantizing to 50-message steps
// (CC-1154) helped but still shifted on compaction and collapse regrouping
// since those change collapsed.length without adding messages. The UUID
// anchor only advances when rendered count genuinely exceeds CAP+STEP —
// immune to length churn from grouping/compaction (CC-1174).
//
// The anchor stores BOTH uuid and index. Some uuids are unstable between
// renders: collapseHookSummaries derives the merged uuid from the first
// summary in a group, but reorderMessagesInUI reshuffles hook adjacency
// as tool results stream in, changing which summary is first. When the
// uuid vanishes, falling back to the stored index (clamped) keeps the
// slice roughly where it was instead of resetting to 0 — which would
// jump from ~200 rendered messages to the full history, orphaning
// in-progress badge snapshots in scrollback.
const MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200;
const MESSAGE_CAP_STEP = 50;
export type SliceAnchor = {
  uuid: string;
  idx: number;
} | null;

/** Exported for testing. Mutates anchorRef when the window needs to advance. */
export function computeSliceStart(collapsed: ReadonlyArray<{
  uuid: string;
}>, anchorRef: {
  current: SliceAnchor;
}, cap = MAX_MESSAGES_WITHOUT_VIRTUALIZATION, step = MESSAGE_CAP_STEP): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor ? collapsed.findIndex(m => m.uuid === anchor.uuid) : -1;
  // Anchor found → use it. Anchor lost → fall back to stored index
  // (clamped) so collapse-regrouping uuid churn doesn't reset to 0.
  let start = anchorIdx >= 0 ? anchorIdx : anchor ? Math.min(anchor.idx, Math.max(0, collapsed.length - cap)) : 0;
  if (collapsed.length - start > cap + step) {
    start = collapsed.length - cap;
  }
  // Refresh anchor from whatever lives at the current start — heals a
  // stale uuid after fallback and captures a new one after advancement.
  const msgAtStart = collapsed[start];
  if (msgAtStart && (anchor?.uuid !== msgAtStart.uuid || anchor.idx !== start)) {
    anchorRef.current = {
      uuid: msgAtStart.uuid,
      idx: start
    };
  } else if (!msgAtStart && anchor) {
    anchorRef.current = null;
  }
  return start;
}
const MessagesImpl = ({
  messages,
  tools,
  commands,
  verbose,
  toolJSX,
  toolUseConfirmQueue,
  inProgressToolUseIDs,
  isMessageSelectorVisible,
  conversationId,
  screen,
  streamingToolUses,
  showAllInTranscript = false,
  agentDefinitions,
  onOpenRateLimitOptions,
  hideLogo = false,
  isLoading,
  hidePastThinking = false,
  streamingThinking,
  streamingText,
  isBriefOnly = false,
  unseenDivider,
  scrollRef,
  trackStickyPrompt,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
  disableRenderCap = false,
  cursor = null,
  setCursor,
  cursorNavRef,
  renderRange
}: Props): React.ReactNode => {
  const {
    columns
  } = useTerminalSize();
  const toggleShowAllShortcut = useShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'Ctrl+E');
  // normalizeMessagesCached reuses per-message normalized output across
  // renders, so a single append no longer re-normalizes the whole transcript
  // and unchanged rows keep their object identity for memo/WeakMap reuse.
  const normalizedMessages = useMemo(() => normalizeMessagesCached(messages).filter(isNotEmptyMessage), [messages]);

  // Check if streaming thinking should be visible (streaming or within 30s timeout)
  const isStreamingThinkingVisible = useMemo(() => {
    if (!streamingThinking) return false;
    if (streamingThinking.isStreaming) return true;
    if (streamingThinking.streamingEndedAt) {
      return Date.now() - streamingThinking.streamingEndedAt < 30000;
    }
    return false;
  }, [streamingThinking]);

  // Find the last thinking block (message UUID + content index) for hiding past thinking in transcript mode
  // When streaming thinking is visible, use a special ID that won't match any completed thinking block
  // With adaptive thinking, only consider thinking blocks from the current turn and stop searching once we
  // hit the last user message.
  const lastThinkingBlockId = useMemo(() => {
    if (!hidePastThinking) return null;
    // If streaming thinking is visible, hide all completed thinking blocks by using a non-matching ID
    if (isStreamingThinkingVisible) return 'streaming';
    // Iterate backwards to find the last message with a thinking block
    for (let i = normalizedMessages.length - 1; i >= 0; i--) {
      const msg = normalizedMessages[i];
      if (msg?.type === 'assistant') {
        const content = msg.message.content;
        // Find the last thinking block in this message
        for (let j = content.length - 1; j >= 0; j--) {
          if (content[j]?.type === 'thinking') {
            return `${msg.uuid}:${j}`;
          }
        }
      } else if (msg?.type === 'user') {
        const hasToolResult = msg.message.content.some(block => block.type === 'tool_result');
        if (!hasToolResult) {
          // Reached a previous user turn so don't show stale thinking from before
          return 'no-thinking';
        }
      }
    }
    return null;
  }, [normalizedMessages, hidePastThinking, isStreamingThinkingVisible]);

  // Find the latest user bash output message (from ! commands)
  // This allows us to show full output for the most recent bash command
  const latestBashOutputUUID = useMemo(() => {
    // Iterate backwards to find the last user message with bash output
    for (let i_0 = normalizedMessages.length - 1; i_0 >= 0; i_0--) {
      const msg_0 = normalizedMessages[i_0];
      if (msg_0?.type === 'user') {
        const content_0 = msg_0.message.content;
        // Check if any text content is bash output
        for (const block_0 of content_0) {
          if (block_0.type === 'text') {
            const text = block_0.text;
            if (text.startsWith('<bash-stdout') || text.startsWith('<bash-stderr')) {
              return msg_0.uuid;
            }
          }
        }
      }
    }
    return null;
  }, [normalizedMessages]);

  // streamingToolUses updates on every input_json_delta while normalizedMessages
  // stays stable — precompute the Set so the filter is O(k) not O(n×k) per chunk.
  const normalizedToolUseIDs = useMemo(() => getToolUseIDs(normalizedMessages), [normalizedMessages]);
  const streamingToolUsesWithoutInProgress = useMemo(() => streamingToolUses.filter(stu => !inProgressToolUseIDs.has(stu.contentBlock.id) && !normalizedToolUseIDs.has(stu.contentBlock.id)), [streamingToolUses, inProgressToolUseIDs, normalizedToolUseIDs]);
  const syntheticStreamingToolUseMessages = useMemo(() => streamingToolUsesWithoutInProgress.flatMap(streamingToolUse => {
    const msg_1 = createAssistantMessage({
      content: [streamingToolUse.contentBlock]
    });
    // Override randomUUID with deterministic value derived from content
    // block ID to prevent React key changes on every memo recomputation.
    // Same class of bug fixed in normalizeMessages (commit 383326e613):
    // fresh randomUUID → unstable React keys → component remounts →
    // Ink rendering corruption (overlapping text from stale DOM nodes).
    msg_1.uuid = deriveUUID(streamingToolUse.contentBlock.id as UUID, 0);
    return normalizeMessages([msg_1]);
  }), [streamingToolUsesWithoutInProgress]);
  const isTranscriptMode = screen === 'transcript';
  // Hoisted to mount-time — this component re-renders on every scroll.
  const disableVirtualScroll = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL), []);
  // Virtual scroll replaces the transcript cap: everything is scrollable and
  // memory is bounded by the mounted-item count, not the total. scrollRef is
  // only passed when isFullscreenEnvEnabled() is true (REPL.tsx gates it),
  // so scrollRef's presence is the signal.
  const virtualScrollRuntimeGate = scrollRef != null && !disableVirtualScroll;
  const shouldTruncate = isTranscriptMode && !showAllInTranscript && !virtualScrollRuntimeGate;

  // Anchor for the first rendered message in the non-virtualized cap slice.
  // Monotonic advance only — mutation during render is idempotent (safe
  // under StrictMode double-render). See MAX_MESSAGES_WITHOUT_VIRTUALIZATION
  // comment above for why this replaced count-based slicing.
  const sliceAnchorRef = useRef<SliceAnchor>(null);

  // Expensive message transforms — filter, reorder, group, collapse, lookups.
  // All O(n) over 27k messages. Split from the renderRange slice so scrolling
  // (which only changes renderRange) doesn't re-run these. Previously this
  // useMemo included renderRange → every scroll rebuilt 6 Maps over 27k
  // messages + 4 filter/map passes = ~50ms alloc per scroll → GC pressure →
  // 100-173ms stop-the-world pauses on the 1GB heap.
  const {
    collapsed: collapsed_0,
    lookups: lookups_0,
    hasTruncatedMessages: hasTruncatedMessages_0,
    hiddenMessageCount: hiddenMessageCount_0
  } = useMemo(() => {
    // In fullscreen mode the alt buffer has no native scrollback, so the
    // compact-boundary filter just hides history the ScrollBox could
    // otherwise scroll to. Main-screen mode keeps the filter — pre-compact
    // rows live above the viewport in native scrollback there, and
    // re-rendering them triggers full resets.
    // includeSnipped: UI rendering keeps snipped messages for scrollback
    // (this PR's core goal — full history in UI, filter only for the model).
    // Also avoids a UUID mismatch: normalizeMessages derives new UUIDs, so
    // projectSnippedView's check against original removedUuids would fail.
    const compactAwareMessages = verbose || isFullscreenEnvEnabled() ? normalizedMessages : getMessagesAfterCompactBoundary(normalizedMessages, {
      includeSnipped: true
    });
    const messagesToShowNotTruncated = reorderMessagesInUI(compactAwareMessages.filter((msg_2): msg_2 is Exclude<NormalizedMessage, ProgressMessageType> => msg_2.type !== 'progress')
    // CC-724: drop attachment messages that AttachmentMessage renders as
    // null (hook_success, hook_additional_context, hook_cancelled, etc.)
    // BEFORE counting/slicing so they don't inflate the "N messages"
    // count in ctrl-o or consume slots in the 200-message render cap.
    .filter(msg_3 => !isNullRenderingAttachment(msg_3)).filter(_ => shouldShowUserMessage(_, isTranscriptMode)), syntheticStreamingToolUseMessages);
    // Three-tier filtering. Transcript mode (ctrl+o screen) is truly unfiltered.
    // Brief-only: SendUserMessage + user input only. Default: drop redundant
    // assistant text in turns where SendUserMessage was called (the model's
    // text is working-notes that duplicate the SendUserMessage content).
    const briefToolNames = [BRIEF_TOOL_NAME, SEND_USER_FILE_TOOL_NAME].filter((n): n is string => n !== null);
    // dropTextInBriefTurns should only trigger on SendUserMessage turns —
    // SendUserFile delivers a file without replacement text, so dropping
    // assistant text for file-only turns would leave the user with no context.
    const dropTextToolNames = [BRIEF_TOOL_NAME].filter((n_0): n_0 is string => n_0 !== null);
    const briefFiltered = briefToolNames.length > 0 && !isTranscriptMode ? isBriefOnly ? filterForBriefTool(messagesToShowNotTruncated, briefToolNames) : dropTextToolNames.length > 0 ? dropTextInBriefTurns(messagesToShowNotTruncated, dropTextToolNames) : messagesToShowNotTruncated : messagesToShowNotTruncated;
    const messagesToShow = shouldTruncate ? briefFiltered.slice(-MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE) : briefFiltered;
    const hasTruncatedMessages = shouldTruncate && briefFiltered.length > MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE;
    const {
      messages: groupedMessages
    } = applyGrouping(messagesToShow, tools, verbose);
    const collapsed = collapseBackgroundBashNotifications(collapseHookSummaries(collapseTeammateShutdowns(collapseReadSearchGroups(groupedMessages, tools))), verbose);
    const lookups = buildMessageLookups(normalizedMessages, messagesToShow);
    const hiddenMessageCount = messagesToShowNotTruncated.length - MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE;
    return {
      collapsed,
      lookups,
      hasTruncatedMessages,
      hiddenMessageCount
    };
  }, [verbose, normalizedMessages, isTranscriptMode, syntheticStreamingToolUseMessages, shouldTruncate, tools, isBriefOnly]);

  // Cheap slice — only runs when scroll range or slice config changes.
  const renderableMessages = useMemo(() => {
    // Safety cap for the non-virtualized render path. Applied here (not at
    // the JSX site) so renderMessageRow's index-based lookups and
    // dividerBeforeIndex compute on the same array. VirtualMessageList
    // never sees this slice — virtualScrollRuntimeGate is constant for the
    // component's lifetime (scrollRef is either always passed or never).
    // renderRange is first: the chunked export path slices the
    // post-grouping array so each chunk gets correct tool-call grouping.
    const capApplies = !virtualScrollRuntimeGate && !disableRenderCap;
    const sliceStart = capApplies ? computeSliceStart(collapsed_0, sliceAnchorRef) : 0;
    return renderRange ? collapsed_0.slice(renderRange[0], renderRange[1]) : sliceStart > 0 ? collapsed_0.slice(sliceStart) : collapsed_0;
  }, [collapsed_0, renderRange, virtualScrollRuntimeGate, disableRenderCap]);
  const streamingToolUseIDs = useMemo(() => new Set(streamingToolUses.map(__0 => __0.contentBlock.id)), [streamingToolUses]);

  // Divider insertion point: first renderableMessage whose uuid shares the
  // 24-char prefix with firstUnseenUuid (deriveUUID keeps the first 24
  // chars of the source message uuid, so this matches any block from it).
  const dividerBeforeIndex = useMemo(() => {
    if (!unseenDivider) return -1;
    const prefix = unseenDivider.firstUnseenUuid.slice(0, 24);
    return renderableMessages.findIndex(m => m.uuid.slice(0, 24) === prefix);
  }, [unseenDivider, renderableMessages]);
  const selectedIdx = useMemo(() => {
    if (!cursor) return -1;
    return renderableMessages.findIndex(m_0 => m_0.uuid === cursor.uuid);
  }, [cursor, renderableMessages]);

  // Fullscreen: click a message to toggle verbose rendering for it. Keyed by
  // tool_use_id where available so a tool_use and its tool_result (separate
  // rows) expand together; falls back to uuid for groups/thinking. Stale keys
  // are harmless — they never match anything in renderableMessages.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const onItemClick = useCallback((msg_4: RenderableMessage) => {
    const k = expandKey(msg_4);
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);else next.add(k);
      return next;
    });
  }, []);
  const isItemExpanded = useCallback((msg_5: RenderableMessage) => expandedKeys.size > 0 && expandedKeys.has(expandKey(msg_5)), [expandedKeys]);
  // Only hover/click messages where the verbose toggle reveals more:
  // collapsed read/search groups, or tool results that self-report truncation
  // via isResultTruncated. Callback must be stable across message updates: if
  // its identity (or return value) flips during streaming, onMouseEnter
  // attaches after the mouse is already inside → hover never fires. tools is
  // session-stable; lookups is read via ref so the callback doesn't churn on
  // every new message.
  const lookupsRef = useRef(lookups_0);
  lookupsRef.current = lookups_0;
  const isItemClickable = useCallback((msg_6: RenderableMessage): boolean => {
    if (msg_6.type === 'collapsed_read_search') return true;
    if (msg_6.type === 'assistant') {
      const b = msg_6.message.content[0] as unknown as AdvisorBlock | undefined;
      return b != null && isAdvisorBlock(b) && b.type === 'advisor_tool_result' && b.content.type === 'advisor_result';
    }
    if (msg_6.type !== 'user') return false;
    const b_0 = msg_6.message.content[0];
    if (b_0?.type !== 'tool_result' || b_0.is_error || !msg_6.toolUseResult) return false;
    const name = lookupsRef.current.toolUseByToolUseID.get(b_0.tool_use_id)?.name;
    const tool = name ? findToolByName(tools, name) : undefined;
    return tool?.isResultTruncated?.(msg_6.toolUseResult as never) ?? false;
  }, [tools]);
  const canAnimate = (!toolJSX || !!toolJSX.shouldContinueAnimation) && !toolUseConfirmQueue.length && !isMessageSelectorVisible;
  const hasToolsInProgress = inProgressToolUseIDs.size > 0;

  // Report progress to terminal (for terminals that support OSC 9;4)
  const {
    progress
  } = useTerminalNotification();
  const prevProgressState = useRef<string | null>(null);
  const progressEnabled = getGlobalConfig().terminalProgressBarEnabled && !getIsRemoteMode() && !(proactiveModule?.isProactiveActive() ?? false);
  useEffect(() => {
    const state = progressEnabled ? hasToolsInProgress ? 'indeterminate' : 'completed' : null;
    if (prevProgressState.current === state) return;
    prevProgressState.current = state;
    progress(state);
  }, [progress, progressEnabled, hasToolsInProgress]);
  useEffect(() => {
    return () => progress(null);
  }, [progress]);
  const messageKey = useCallback((msg_7: RenderableMessage) => `${msg_7.uuid}-${conversationId}`, [conversationId]);
  const renderMessageRow = (msg_8: RenderableMessage, index: number) => {
    const prevType = index > 0 ? renderableMessages[index - 1]?.type : undefined;
    const isUserContinuation = msg_8.type === 'user' && prevType === 'user';
    // hasContentAfter is only consumed for collapsed_read_search groups;
    // skip the scan for everything else. streamingText is rendered as a
    // sibling after this map, so it's never in renderableMessages — OR it
    // in explicitly so the group flips to past tense as soon as text starts
    // streaming instead of waiting for the block to finalize.
    const hasContentAfter = msg_8.type === 'collapsed_read_search' && (!!streamingText || hasContentAfterIndex(renderableMessages, index, tools, streamingToolUseIDs));
    const k_0 = messageKey(msg_8);
    const row = <MessageRow key={k_0} message={msg_8} isUserContinuation={isUserContinuation} hasContentAfter={hasContentAfter} tools={tools} commands={commands} verbose={verbose || isItemExpanded(msg_8) || cursor?.expanded === true && index === selectedIdx} inProgressToolUseIDs={inProgressToolUseIDs} streamingToolUseIDs={streamingToolUseIDs} screen={screen} canAnimate={canAnimate} onOpenRateLimitOptions={onOpenRateLimitOptions} lastThinkingBlockId={lastThinkingBlockId} latestBashOutputUUID={latestBashOutputUUID} columns={columns} isLoading={isLoading} lookups={lookups_0} />;

    // Per-row Provider — only 2 rows re-render on selection change.
    // Wrapped BEFORE divider branch so both return paths get it.
    const wrapped = <MessageActionsSelectedContext.Provider key={k_0} value={index === selectedIdx}>
        {row}
      </MessageActionsSelectedContext.Provider>;
    if (unseenDivider && index === dividerBeforeIndex) {
      return [<Box key="unseen-divider" marginTop={1}>
          <Divider title={`${unseenDivider.count} new ${plural(unseenDivider.count, 'message')}`} width={columns} color="inactive" />
        </Box>, wrapped];
    }
    return wrapped;
  };

  // Search indexing: for tool_result messages, look up the Tool and use
  // its extractSearchText — tool-owned, precise, matches what
  // renderToolResultMessage shows. Falls back to renderableSearchText
  // (duck-types toolUseResult) for tools that haven't implemented it,
  // and for all non-tool-result message types. The drift-catcher test
  // (toolSearchText.test.tsx) renders + compares to keep these in sync.
  //
  // A second-React-root reconcile approach was tried and ruled out
  // (measured 3.1ms/msg, growing — flushSyncWork processes all roots;
  // component hooks mutate shared state → main root accumulates updates).
  const searchTextCache = useRef(new WeakMap<RenderableMessage, string>());
  const extractSearchText = useCallback((msg_9: RenderableMessage): string => {
    const cached = searchTextCache.current.get(msg_9);
    if (cached !== undefined) return cached;
    let text_0 = renderableSearchText(msg_9);
    // If this is a tool_result message and the tool implements
    // extractSearchText, prefer that — it's precise (tool-owned)
    // vs renderableSearchText's field-name heuristic.
    if (msg_9.type === 'user' && msg_9.toolUseResult && Array.isArray(msg_9.message.content)) {
      const tr = msg_9.message.content.find(b_1 => b_1.type === 'tool_result');
      if (tr && 'tool_use_id' in tr) {
        const tu = lookups_0.toolUseByToolUseID.get(tr.tool_use_id);
        const tool_0 = tu && findToolByName(tools, tu.name);
        const extracted = tool_0?.extractSearchText?.(msg_9.toolUseResult as never);
        // undefined = tool didn't implement → keep heuristic. Empty
        // string = tool says "nothing to index" → respect that.
        if (extracted !== undefined) text_0 = extracted;
      }
    }
    // Cache LOWERED: setSearchQuery's hot loop indexOfs per keystroke.
    // Lowering here (once, at warm) vs there (every keystroke) trades
    // ~same steady-state memory for zero per-keystroke alloc. Cache
    // GC's with messages on transcript exit. Tool methods return raw;
    // renderableSearchText already lowercases (redundant but cheap).
    const lowered = text_0.toLowerCase();
    searchTextCache.current.set(msg_9, lowered);
    return lowered;
  }, [tools, lookups_0]);
  return <>
      {/* Logo */}
      {!hideLogo && !(renderRange && renderRange[0] > 0) && <LogoHeader agentDefinitions={agentDefinitions} />}

      {/* Truncation indicator */}
      {hasTruncatedMessages_0 && <Divider title={`${toggleShowAllShortcut} to show ${chalk.bold(hiddenMessageCount_0)} previous messages`} width={columns} />}

      {/* Show all indicator */}
      {isTranscriptMode && showAllInTranscript && hiddenMessageCount_0 > 0 &&
    // disableRenderCap (e.g. [ dump-to-scrollback) means we're uncapped
    // as a one-shot escape hatch, not a toggle — ctrl+e is dead and
    // nothing is actually "hidden" to restore.
    !disableRenderCap && <Divider title={`${toggleShowAllShortcut} to hide ${chalk.bold(hiddenMessageCount_0)} previous messages`} width={columns} />}

      {/* Messages - rendered as memoized MessageRow components.
          flatMap inserts the unseen-divider as a separate keyed sibling so
          (a) non-fullscreen renders pay no per-message Fragment wrap, and
          (b) divider toggle in fullscreen preserves all MessageRows by key.
          Pre-compute derived values instead of passing renderableMessages to
          each row - React Compiler pins props in the fiber's memoCache, so
          passing the array would accumulate every historical version
          (~1-2MB over a 7-turn session). */}
      {virtualScrollRuntimeGate ? <InVirtualListContext.Provider value={true}>
          <VirtualMessageList messages={renderableMessages} scrollRef={scrollRef} columns={columns} itemKey={messageKey} renderItem={renderMessageRow} onItemClick={onItemClick} isItemClickable={isItemClickable} isItemExpanded={isItemExpanded} trackStickyPrompt={trackStickyPrompt} selectedIndex={selectedIdx >= 0 ? selectedIdx : undefined} cursorNavRef={cursorNavRef} setCursor={setCursor} jumpRef={jumpRef} onSearchMatchesChange={onSearchMatchesChange} scanElement={scanElement} setPositions={setPositions} extractSearchText={extractSearchText} />
        </InVirtualListContext.Provider> : renderableMessages.flatMap(renderMessageRow)}

      {streamingText && !isBriefOnly && <Box alignItems="flex-start" flexDirection="row" marginTop={1} width="100%">
          <Box flexDirection="row">
            <Box minWidth={2}>
              <Text color="text">{BLACK_CIRCLE}</Text>
            </Box>
            <Box flexDirection="column">
              <StreamingMarkdown>{streamingText}</StreamingMarkdown>
            </Box>
          </Box>
        </Box>}

      {isStreamingThinkingVisible && streamingThinking && !isBriefOnly && <Box marginTop={1}>
          <AssistantThinkingMessage param={{
        type: 'thinking',
        thinking: streamingThinking.thinking
      }} addMargin={false} isTranscriptMode={true} verbose={verbose} hideInTranscript={false} />
        </Box>}
    </>;
};

/** Key for click-to-expand: tool_use_id where available (so tool_use + its
 *  tool_result expand together), else uuid for groups/thinking. */
function expandKey(msg: RenderableMessage): string {
  return (msg.type === 'assistant' || msg.type === 'user' ? getToolUseID(msg) : null) ?? msg.uuid;
}

// Custom comparator to prevent unnecessary re-renders during streaming.
// Default React.memo does shallow comparison which fails when:
// 1. onOpenRateLimitOptions callback is recreated (doesn't affect render output)
// 2. streamingToolUses array is recreated on every delta, but only contentBlock matters for rendering
// 3. streamingThinking changes on every delta - we DO want to re-render for this
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
export const Messages = React.memo(MessagesImpl, (prev, next) => {
  const keys = Object.keys(prev) as (keyof typeof prev)[];
  for (const key of keys) {
    if (key === 'onOpenRateLimitOptions' || key === 'scrollRef' || key === 'trackStickyPrompt' || key === 'setCursor' || key === 'cursorNavRef' || key === 'jumpRef' || key === 'onSearchMatchesChange' || key === 'scanElement' || key === 'setPositions') continue;
    if (prev[key] !== next[key]) {
      if (key === 'streamingToolUses') {
        const p = prev.streamingToolUses;
        const n = next.streamingToolUses;
        if (p.length === n.length && p.every((item, i) => item.contentBlock === n[i]?.contentBlock)) {
          continue;
        }
      }
      if (key === 'inProgressToolUseIDs') {
        if (setsEqual(prev.inProgressToolUseIDs, next.inProgressToolUseIDs)) {
          continue;
        }
      }
      if (key === 'unseenDivider') {
        const p = prev.unseenDivider;
        const n = next.unseenDivider;
        if (p?.firstUnseenUuid === n?.firstUnseenUuid && p?.count === n?.count) {
          continue;
        }
      }
      if (key === 'tools') {
        const p = prev.tools;
        const n = next.tools;
        if (p.length === n.length && p.every((tool, i) => tool.name === n[i]?.name)) {
          continue;
        }
      }
      // streamingThinking changes frequently - always re-render when it changes
      // (no special handling needed, default behavior is correct)
      return false;
    }
  }
  return true;
});
export function shouldRenderStatically(message: RenderableMessage, streamingToolUseIDs: Set<string>, inProgressToolUseIDs: Set<string>, siblingToolUseIDs: ReadonlySet<string>, screen: Screen, lookups: ReturnType<typeof buildMessageLookups>): boolean {
  if (screen === 'transcript') {
    return true;
  }
  switch (message.type) {
    case 'attachment':
    case 'user':
    case 'assistant':
      {
        if (message.type === 'assistant') {
          const block = message.message.content[0];
          if (block?.type === 'server_tool_use') {
            return lookups.resolvedToolUseIDs.has(block.id);
          }
        }
        const toolUseID = getToolUseID(message);
        if (!toolUseID) {
          return true;
        }
        if (streamingToolUseIDs.has(toolUseID)) {
          return false;
        }
        if (inProgressToolUseIDs.has(toolUseID)) {
          return false;
        }

        // Check if there are any unresolved PostToolUse hooks for this tool use
        // If so, keep the message transient so the HookProgressMessage can update
        if (hasUnresolvedHooksFromLookup(toolUseID, 'PostToolUse', lookups)) {
          return false;
        }
        return every(siblingToolUseIDs, lookups.resolvedToolUseIDs);
      }
    case 'system':
      {
        // api errors always render dynamically, since we hide
        // them as soon as we see another non-error message.
        return message.subtype !== 'api_error';
      }
    case 'grouped_tool_use':
      {
        const allResolved = message.messages.every(msg => {
          const content = msg.message.content[0];
          return content?.type === 'tool_use' && lookups.resolvedToolUseIDs.has(content.id);
        });
        return allResolved;
      }
    case 'collapsed_read_search':
      {
        // In prompt mode, never mark as static to prevent flicker between API turns
        // (In transcript mode, we already returned true at the top of this function)
        return false;
      }
  }
}
