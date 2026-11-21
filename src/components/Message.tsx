import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import type { ImageBlockParam, TextBlockParam, ThinkingBlockParam, ToolResultBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import type { Command } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box } from '../ink.js';
import type { Tools } from '../Tool.js';
import { type ConnectorTextBlock, isConnectorTextBlock } from '../types/connectorText.js';
import type { AssistantMessage, AttachmentMessage as AttachmentMessageType, CollapsedReadSearchGroup as CollapsedReadSearchGroupType, GroupedToolUseMessage as GroupedToolUseMessageType, NormalizedUserMessage, ProgressMessage, SystemMessage, SystemSnipBoundaryMessage } from '../types/message.js';
import { type AdvisorBlock, isAdvisorBlock } from '../utils/advisor.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { logError } from '../utils/log.js';
import type { buildMessageLookups } from '../utils/messages.js';
import { CompactSummary } from './CompactSummary.js';
import { AdvisorMessage } from './messages/AdvisorMessage.js';
import { AssistantRedactedThinkingMessage } from './messages/AssistantRedactedThinkingMessage.js';
import { AssistantTextMessage } from './messages/AssistantTextMessage.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js';
import { AttachmentMessage } from './messages/AttachmentMessage.js';
import { CollapsedReadSearchContent } from './messages/CollapsedReadSearchContent.js';
import { CompactBoundaryMessage } from './messages/CompactBoundaryMessage.js';
import { FocusMarkerMessage } from './messages/FocusMarkerMessage.js';
import { FocusSummaryMessage } from './messages/FocusSummaryMessage.js';
import { GroupedToolUseContent } from './messages/GroupedToolUseContent.js';
import { SystemTextMessage } from './messages/SystemTextMessage.js';
import { UserImageMessage } from './messages/UserImageMessage.js';
import { UserTextMessage } from './messages/UserTextMessage.js';
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import { ExpandShellOutputProvider } from './shell/ExpandShellOutputContext.js';
export type Props = {
  message: NormalizedUserMessage | AssistantMessage | AttachmentMessageType | SystemMessage | GroupedToolUseMessageType | CollapsedReadSearchGroupType;
  lookups: ReturnType<typeof buildMessageLookups>;
  // TODO: Find a way to remove this, and leave spacing to the consumer
  /** Absolute width for the container Box. When provided, eliminates a wrapper Box in the caller. */
  containerWidth?: number;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  style?: 'condensed';
  width?: number | string;
  isTranscriptMode: boolean;
  isStatic: boolean;
  onOpenRateLimitOptions?: () => void;
  isActiveCollapsedGroup?: boolean;
  isUserContinuation?: boolean;
  /** ID of the last thinking block (uuid:index) to show, used for hiding past thinking in transcript mode */
  lastThinkingBlockId?: string | null;
  /** UUID of the latest user bash output message (for auto-expanding) */
  latestBashOutputUUID?: string | null;
};
function MessageImpl(t0: Props) {
  const $ = _c(94);
  const {
    message,
    lookups,
    containerWidth,
    addMargin,
    tools,
    commands,
    verbose,
    inProgressToolUseIDs,
    progressMessagesForMessage,
    shouldAnimate,
    shouldShowDot,
    style,
    width,
    isTranscriptMode,
    onOpenRateLimitOptions,
    isActiveCollapsedGroup,
    isUserContinuation: t1,
    lastThinkingBlockId,
    latestBashOutputUUID
  } = t0;
  const isUserContinuation = t1 === undefined ? false : t1;
  switch (message.type) {
    case "attachment":
      {
        let t2;
        if ($[0] !== addMargin || $[1] !== isTranscriptMode || $[2] !== message.attachment || $[3] !== verbose) {
          t2 = <AttachmentMessage addMargin={addMargin} attachment={message.attachment} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
          $[0] = addMargin;
          $[1] = isTranscriptMode;
          $[2] = message.attachment;
          $[3] = verbose;
          $[4] = t2;
        } else {
          t2 = $[4];
        }
        return t2;
      }
    case "assistant":
      {
        const t2 = containerWidth ?? "100%";
        let t3;
        if ($[5] !== addMargin || $[6] !== commands || $[7] !== inProgressToolUseIDs || $[8] !== isTranscriptMode || $[9] !== lastThinkingBlockId || $[10] !== lookups || $[11] !== message.advisorModel || $[12] !== message.message.content || $[13] !== message.uuid || $[14] !== onOpenRateLimitOptions || $[15] !== progressMessagesForMessage || $[16] !== shouldAnimate || $[17] !== shouldShowDot || $[18] !== tools || $[19] !== verbose || $[20] !== width) {
          let t4;
          if ($[22] !== addMargin || $[23] !== commands || $[24] !== inProgressToolUseIDs || $[25] !== isTranscriptMode || $[26] !== lastThinkingBlockId || $[27] !== lookups || $[28] !== message.advisorModel || $[29] !== message.uuid || $[30] !== onOpenRateLimitOptions || $[31] !== progressMessagesForMessage || $[32] !== shouldAnimate || $[33] !== shouldShowDot || $[34] !== tools || $[35] !== verbose || $[36] !== width) {
            t4 = (_, index_0) => <AssistantMessageBlock key={index_0} param={_} addMargin={addMargin} tools={tools} commands={commands} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={progressMessagesForMessage} shouldAnimate={shouldAnimate} shouldShowDot={shouldShowDot} width={width} inProgressToolCallCount={inProgressToolUseIDs.size} isTranscriptMode={isTranscriptMode} lookups={lookups} onOpenRateLimitOptions={onOpenRateLimitOptions} thinkingBlockId={`${message.uuid}:${index_0}`} lastThinkingBlockId={lastThinkingBlockId} advisorModel={message.advisorModel} />;
            $[22] = addMargin;
            $[23] = commands;
            $[24] = inProgressToolUseIDs;
            $[25] = isTranscriptMode;
            $[26] = lastThinkingBlockId;
            $[27] = lookups;
            $[28] = message.advisorModel;
            $[29] = message.uuid;
            $[30] = onOpenRateLimitOptions;
            $[31] = progressMessagesForMessage;
            $[32] = shouldAnimate;
            $[33] = shouldShowDot;
            $[34] = tools;
            $[35] = verbose;
            $[36] = width;
            $[37] = t4;
          } else {
            t4 = $[37];
          }
          t3 = message.message.content.map(t4);
          $[5] = addMargin;
          $[6] = commands;
          $[7] = inProgressToolUseIDs;
          $[8] = isTranscriptMode;
          $[9] = lastThinkingBlockId;
          $[10] = lookups;
          $[11] = message.advisorModel;
          $[12] = message.message.content;
          $[13] = message.uuid;
          $[14] = onOpenRateLimitOptions;
          $[15] = progressMessagesForMessage;
          $[16] = shouldAnimate;
          $[17] = shouldShowDot;
          $[18] = tools;
          $[19] = verbose;
          $[20] = width;
          $[21] = t3;
        } else {
          t3 = $[21];
        }
        let t4;
        if ($[38] !== t2 || $[39] !== t3) {
          t4 = <Box flexDirection="column" width={t2}>{t3}</Box>;
          $[38] = t2;
          $[39] = t3;
          $[40] = t4;
        } else {
          t4 = $[40];
        }
        return t4;
      }
    case "user":
      {
        if (message.isCompactSummary) {
          const t2 = isTranscriptMode ? "transcript" : "prompt";
          let t3;
          if ($[41] !== message || $[42] !== t2) {
            t3 = <CompactSummary message={message} screen={t2} />;
            $[41] = message;
            $[42] = t2;
            $[43] = t3;
          } else {
            t3 = $[43];
          }
          return t3;
        }
        let imageIndices;
        if ($[44] !== message.imagePasteIds || $[45] !== message.message.content) {
          imageIndices = [];
          let imagePosition = 0;
          for (const param of message.message.content) {
            if (param.type === "image") {
              const id = message.imagePasteIds?.[imagePosition];
              imagePosition++;
              imageIndices.push(id ?? imagePosition);
            } else {
              imageIndices.push(imagePosition);
            }
          }
          $[44] = message.imagePasteIds;
          $[45] = message.message.content;
          $[46] = imageIndices;
        } else {
          imageIndices = $[46];
        }
        const isLatestBashOutput = latestBashOutputUUID === message.uuid;
        const t2 = containerWidth ?? "100%";
        let t3;
        if ($[47] !== addMargin || $[48] !== imageIndices || $[49] !== isTranscriptMode || $[50] !== isUserContinuation || $[51] !== lookups || $[52] !== message || $[53] !== progressMessagesForMessage || $[54] !== style || $[55] !== tools || $[56] !== verbose) {
          t3 = message.message.content.map((param_0, index) => <UserMessage key={index} message={message} addMargin={addMargin} tools={tools} progressMessagesForMessage={progressMessagesForMessage} param={param_0} style={style} verbose={verbose} imageIndex={imageIndices[index]} isUserContinuation={isUserContinuation} lookups={lookups} isTranscriptMode={isTranscriptMode} />);
          $[47] = addMargin;
          $[48] = imageIndices;
          $[49] = isTranscriptMode;
          $[50] = isUserContinuation;
          $[51] = lookups;
          $[52] = message;
          $[53] = progressMessagesForMessage;
          $[54] = style;
          $[55] = tools;
          $[56] = verbose;
          $[57] = t3;
        } else {
          t3 = $[57];
        }
        let t4;
        if ($[58] !== t2 || $[59] !== t3) {
          t4 = <Box flexDirection="column" width={t2}>{t3}</Box>;
          $[58] = t2;
          $[59] = t3;
          $[60] = t4;
        } else {
          t4 = $[60];
        }
        const content = t4;
        let t5;
        if ($[61] !== content || $[62] !== isLatestBashOutput) {
          t5 = isLatestBashOutput ? <ExpandShellOutputProvider>{content}</ExpandShellOutputProvider> : content;
          $[61] = content;
          $[62] = isLatestBashOutput;
          $[63] = t5;
        } else {
          t5 = $[63];
        }
        return t5;
      }
    case "system":
      {
        if (message.subtype === "compact_boundary") {
          if (isFullscreenEnvEnabled()) {
            return null;
          }
          let t2;
          if ($[64] === Symbol.for("react.memo_cache_sentinel")) {
            t2 = <CompactBoundaryMessage />;
            $[64] = t2;
          } else {
            t2 = $[64];
          }
          return t2;
        }
        if (message.subtype === "focus_marker") {
          return <FocusMarkerMessage hiddenTurns={message.hiddenTurns} compacted={message.compacted} />;
        }
        if (message.subtype === "focus_summary") {
          return <FocusSummaryMessage summary={message.summary} />;
        }
        if (message.subtype === "microcompact_boundary") {
          return null;
        }
        if (feature("HISTORY_SNIP")) {
          const {
            isSnipBoundaryMessage
          } = require("../services/compact/snipProjection.js") as typeof import('../services/compact/snipProjection.js');
          const {
            isSnipMarkerMessage
          } = require("../services/compact/snipCompact.js") as typeof import('../services/compact/snipCompact.js');
          if (isSnipBoundaryMessage(message)) {
            let t2;
            if ($[65] === Symbol.for("react.memo_cache_sentinel")) {
              t2 = require("./messages/SnipBoundaryMessage.js");
              $[65] = t2;
            } else {
              t2 = $[65];
            }
            const {
              SnipBoundaryMessage
            } = t2 as typeof import('./messages/SnipBoundaryMessage.js');
            let t3;
            if ($[66] !== message) {
              // isSnipBoundaryMessage checks for snipMetadata at runtime but
              // is not a type predicate, so narrow explicitly here.
              t3 = <SnipBoundaryMessage message={message as SystemSnipBoundaryMessage} />;
              $[66] = message;
              $[67] = t3;
            } else {
              t3 = $[67];
            }
            return t3;
          }
          if (isSnipMarkerMessage(message)) {
            return null;
          }
        }
        if (message.subtype === "local_command") {
          let t2;
          if ($[68] !== message.content) {
            t2 = {
              type: "text",
              text: message.content
            };
            $[68] = message.content;
            $[69] = t2;
          } else {
            t2 = $[69];
          }
          let t3;
          if ($[70] !== addMargin || $[71] !== isTranscriptMode || $[72] !== t2 || $[73] !== verbose) {
            t3 = <UserTextMessage addMargin={addMargin} param={t2} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
            $[70] = addMargin;
            $[71] = isTranscriptMode;
            $[72] = t2;
            $[73] = verbose;
            $[74] = t3;
          } else {
            t3 = $[74];
          }
          return t3;
        }
        let t2;
        if ($[75] !== addMargin || $[76] !== isTranscriptMode || $[77] !== message || $[78] !== verbose) {
          t2 = <SystemTextMessage message={message} addMargin={addMargin} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
          $[75] = addMargin;
          $[76] = isTranscriptMode;
          $[77] = message;
          $[78] = verbose;
          $[79] = t2;
        } else {
          t2 = $[79];
        }
        return t2;
      }
    case "grouped_tool_use":
      {
        let t2;
        if ($[80] !== inProgressToolUseIDs || $[81] !== lookups || $[82] !== message || $[83] !== shouldAnimate || $[84] !== tools) {
          t2 = <GroupedToolUseContent message={message} tools={tools} lookups={lookups} inProgressToolUseIDs={inProgressToolUseIDs} shouldAnimate={shouldAnimate} />;
          $[80] = inProgressToolUseIDs;
          $[81] = lookups;
          $[82] = message;
          $[83] = shouldAnimate;
          $[84] = tools;
          $[85] = t2;
        } else {
          t2 = $[85];
        }
        return t2;
      }
    case "collapsed_read_search":
      {
        const t2 = verbose || isTranscriptMode;
        let t3;
        if ($[86] !== inProgressToolUseIDs || $[87] !== isActiveCollapsedGroup || $[88] !== lookups || $[89] !== message || $[90] !== shouldAnimate || $[91] !== t2 || $[92] !== tools) {
          t3 = <OffscreenFreeze><CollapsedReadSearchContent message={message} inProgressToolUseIDs={inProgressToolUseIDs} shouldAnimate={shouldAnimate} verbose={t2} tools={tools} lookups={lookups} isActiveGroup={isActiveCollapsedGroup} /></OffscreenFreeze>;
          $[86] = inProgressToolUseIDs;
          $[87] = isActiveCollapsedGroup;
          $[88] = lookups;
          $[89] = message;
          $[90] = shouldAnimate;
          $[91] = t2;
          $[92] = tools;
          $[93] = t3;
        } else {
          t3 = $[93];
        }
        return t3;
      }
  }
}
function UserMessage(t0) {
  const $ = _c(20);
  const {
    message,
    addMargin,
    tools,
    progressMessagesForMessage,
    param,
    style,
    verbose,
    imageIndex,
    isUserContinuation,
    lookups,
    isTranscriptMode
  } = t0;
  const {
    columns
  } = useTerminalSize();
  switch (param.type) {
    case "text":
      {
        let t1;
        if ($[0] !== addMargin || $[1] !== isTranscriptMode || $[2] !== message.planContent || $[3] !== message.timestamp || $[4] !== param || $[5] !== verbose) {
          t1 = <UserTextMessage addMargin={addMargin} param={param} verbose={verbose} planContent={message.planContent} isTranscriptMode={isTranscriptMode} timestamp={message.timestamp} />;
          $[0] = addMargin;
          $[1] = isTranscriptMode;
          $[2] = message.planContent;
          $[3] = message.timestamp;
          $[4] = param;
          $[5] = verbose;
          $[6] = t1;
        } else {
          t1 = $[6];
        }
        return t1;
      }
    case "image":
      {
        const t1 = addMargin && !isUserContinuation;
        let t2;
        if ($[7] !== imageIndex || $[8] !== t1) {
          t2 = <UserImageMessage imageId={imageIndex} addMargin={t1} />;
          $[7] = imageIndex;
          $[8] = t1;
          $[9] = t2;
        } else {
          t2 = $[9];
        }
        return t2;
      }
    case "tool_result":
      {
        const t1 = columns - 5;
        let t2;
        if ($[10] !== isTranscriptMode || $[11] !== lookups || $[12] !== message || $[13] !== param || $[14] !== progressMessagesForMessage || $[15] !== style || $[16] !== t1 || $[17] !== tools || $[18] !== verbose) {
          t2 = <UserToolResultMessage param={param} message={message} lookups={lookups} progressMessagesForMessage={progressMessagesForMessage} style={style} tools={tools} verbose={verbose} width={t1} isTranscriptMode={isTranscriptMode} />;
          $[10] = isTranscriptMode;
          $[11] = lookups;
          $[12] = message;
          $[13] = param;
          $[14] = progressMessagesForMessage;
          $[15] = style;
          $[16] = t1;
          $[17] = tools;
          $[18] = verbose;
          $[19] = t2;
        } else {
          t2 = $[19];
        }
        return t2;
      }
    default:
      {
        return;
      }
  }
}
function AssistantMessageBlock(t0) {
  const $ = _c(45);
  const {
    param,
    addMargin,
    tools,
    commands,
    verbose,
    inProgressToolUseIDs,
    progressMessagesForMessage,
    shouldAnimate,
    shouldShowDot,
    width,
    inProgressToolCallCount,
    isTranscriptMode,
    lookups,
    onOpenRateLimitOptions,
    thinkingBlockId,
    lastThinkingBlockId,
    advisorModel
  } = t0;
  if (feature("CONNECTOR_TEXT")) {
    if (isConnectorTextBlock(param)) {
      let t1;
      if ($[0] !== param.connector_text) {
        t1 = {
          type: "text",
          text: param.connector_text
        };
        $[0] = param.connector_text;
        $[1] = t1;
      } else {
        t1 = $[1];
      }
      let t2;
      if ($[2] !== addMargin || $[3] !== onOpenRateLimitOptions || $[4] !== shouldShowDot || $[5] !== t1 || $[6] !== verbose || $[7] !== width) {
        t2 = <AssistantTextMessage param={t1} addMargin={addMargin} shouldShowDot={shouldShowDot} verbose={verbose} width={width} onOpenRateLimitOptions={onOpenRateLimitOptions} />;
        $[2] = addMargin;
        $[3] = onOpenRateLimitOptions;
        $[4] = shouldShowDot;
        $[5] = t1;
        $[6] = verbose;
        $[7] = width;
        $[8] = t2;
      } else {
        t2 = $[8];
      }
      return t2;
    }
  }
  switch (param.type) {
    case "tool_use":
      {
        let t1;
        if ($[9] !== addMargin || $[10] !== commands || $[11] !== inProgressToolCallCount || $[12] !== inProgressToolUseIDs || $[13] !== isTranscriptMode || $[14] !== lookups || $[15] !== param || $[16] !== progressMessagesForMessage || $[17] !== shouldAnimate || $[18] !== shouldShowDot || $[19] !== tools || $[20] !== verbose) {
          t1 = <AssistantToolUseMessage param={param} addMargin={addMargin} tools={tools} commands={commands} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={progressMessagesForMessage} shouldAnimate={shouldAnimate} shouldShowDot={shouldShowDot} inProgressToolCallCount={inProgressToolCallCount} lookups={lookups} isTranscriptMode={isTranscriptMode} />;
          $[9] = addMargin;
          $[10] = commands;
          $[11] = inProgressToolCallCount;
          $[12] = inProgressToolUseIDs;
          $[13] = isTranscriptMode;
          $[14] = lookups;
          $[15] = param;
          $[16] = progressMessagesForMessage;
          $[17] = shouldAnimate;
          $[18] = shouldShowDot;
          $[19] = tools;
          $[20] = verbose;
          $[21] = t1;
        } else {
          t1 = $[21];
        }
        return t1;
      }
    case "text":
      {
        let t1;
        if ($[22] !== addMargin || $[23] !== onOpenRateLimitOptions || $[24] !== param || $[25] !== shouldShowDot || $[26] !== verbose || $[27] !== width) {
          t1 = <AssistantTextMessage param={param} addMargin={addMargin} shouldShowDot={shouldShowDot} verbose={verbose} width={width} onOpenRateLimitOptions={onOpenRateLimitOptions} />;
          $[22] = addMargin;
          $[23] = onOpenRateLimitOptions;
          $[24] = param;
          $[25] = shouldShowDot;
          $[26] = verbose;
          $[27] = width;
          $[28] = t1;
        } else {
          t1 = $[28];
        }
        return t1;
      }
    case "redacted_thinking":
      {
        if (!isTranscriptMode && !verbose) {
          return null;
        }
        let t1;
        if ($[29] !== addMargin) {
          t1 = <AssistantRedactedThinkingMessage addMargin={addMargin} />;
          $[29] = addMargin;
          $[30] = t1;
        } else {
          t1 = $[30];
        }
        return t1;
      }
    case "thinking":
      {
        if (!isTranscriptMode && !verbose) {
          return null;
        }
        const isLastThinking = !lastThinkingBlockId || thinkingBlockId === lastThinkingBlockId;
        const t1 = isTranscriptMode && !isLastThinking;
        let t2;
        if ($[31] !== addMargin || $[32] !== isTranscriptMode || $[33] !== param || $[34] !== t1 || $[35] !== verbose) {
          t2 = <AssistantThinkingMessage addMargin={addMargin} param={param} isTranscriptMode={isTranscriptMode} verbose={verbose} hideInTranscript={t1} />;
          $[31] = addMargin;
          $[32] = isTranscriptMode;
          $[33] = param;
          $[34] = t1;
          $[35] = verbose;
          $[36] = t2;
        } else {
          t2 = $[36];
        }
        return t2;
      }
    case "server_tool_use":
    case "advisor_tool_result":
      {
        if (isAdvisorBlock(param)) {
          const t1 = verbose || isTranscriptMode;
          let t2;
          if ($[37] !== addMargin || $[38] !== advisorModel || $[39] !== lookups.erroredToolUseIDs || $[40] !== lookups.resolvedToolUseIDs || $[41] !== param || $[42] !== shouldAnimate || $[43] !== t1) {
            t2 = <AdvisorMessage block={param} addMargin={addMargin} resolvedToolUseIDs={lookups.resolvedToolUseIDs} erroredToolUseIDs={lookups.erroredToolUseIDs} shouldAnimate={shouldAnimate} verbose={t1} advisorModel={advisorModel} />;
            $[37] = addMargin;
            $[38] = advisorModel;
            $[39] = lookups.erroredToolUseIDs;
            $[40] = lookups.resolvedToolUseIDs;
            $[41] = param;
            $[42] = shouldAnimate;
            $[43] = t1;
            $[44] = t2;
          } else {
            t2 = $[44];
          }
          return t2;
        }
        logError(new Error(`Unable to render server tool block: ${param.type}`));
        return null;
      }
    default:
      {
        logError(new Error(`Unable to render message type: ${param.type}`));
        return null;
      }
  }
}
export function hasThinkingContent(m: {
  type: string;
  message?: {
    content: Array<{
      type: string;
    }>;
  };
}): boolean {
  if (m.type !== 'assistant' || !m.message) return false;
  return m.message.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking');
}

/** Exported for testing */
export function areMessagePropsEqual(prev: Props, next: Props): boolean {
  if (prev.message.uuid !== next.message.uuid) return false;
  // Only re-render on lastThinkingBlockId change if this message actually
  // has thinking content — otherwise every message in scrollback re-renders
  // whenever streaming thinking starts/stops (CC-941).
  if (prev.lastThinkingBlockId !== next.lastThinkingBlockId && hasThinkingContent(next.message)) {
    return false;
  }
  // Verbose toggle changes thinking block visibility/expansion
  if (prev.verbose !== next.verbose) return false;
  // Only re-render if this message's "is latest bash output" status changed,
  // not when the global latestBashOutputUUID changes to a different message
  const prevIsLatest = prev.latestBashOutputUUID === prev.message.uuid;
  const nextIsLatest = next.latestBashOutputUUID === next.message.uuid;
  if (prevIsLatest !== nextIsLatest) return false;
  if (prev.isTranscriptMode !== next.isTranscriptMode) return false;
  // containerWidth is an absolute number in the no-metadata path (wrapper
  // Box is skipped). Static messages must re-render on terminal resize.
  if (prev.containerWidth !== next.containerWidth) return false;
  if (prev.isStatic && next.isStatic) return true;
  return false;
}
export const Message = React.memo(MessageImpl, areMessagePropsEqual);
