import { c as _c } from "react-compiler-runtime";
import type { ToolResultBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { ConfigurableShortcutHint } from 'src/components/ConfigurableShortcutHint.js';
import { CtrlOToExpand, SubAgentProvider } from 'src/components/CtrlOToExpand.js';
import { Byline } from 'src/components/design-system/Byline.js';
import { KeyboardShortcutHint } from 'src/components/design-system/KeyboardShortcutHint.js';
import type { z } from 'zod/v4';
import { AgentProgressLine } from '../../components/AgentProgressLine.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js';
import { Markdown } from '../../components/Markdown.js';
import { Message as MessageComponent } from '../../components/Message.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { ToolUseLoader } from '../../components/ToolUseLoader.js';
import { Box, Text } from '../../ink.js';
import { findToolByName, type Tools } from '../../Tool.js';
import type { Message, ProgressMessage } from '../../types/message.js';
import type { AgentToolProgress } from '../../types/tools.js';
import { count } from '../../utils/array.js';
import { getSearchOrReadFromContent, getSearchReadSummaryText } from '../../utils/collapseReadSearch.js';
import { formatDuration, formatNumber } from '../../utils/format.js';
import { buildSubagentLookups, createAssistantMessage, EMPTY_LOOKUPS } from '../../utils/messages.js';
import { getMainLoopModel, parseUserSpecifiedModel, renderModelName } from '../../utils/model/model.js';
import type { Theme, ThemeName } from '../../utils/theme.js';
import type { outputSchema, Progress } from './AgentTool.js';
import { inputSchema } from './AgentTool.js';
import { getAgentColor } from './agentColorManager.js';
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js';
const MAX_PROGRESS_MESSAGES_TO_SHOW = 3;

/**
 * Guard: checks if progress data has a `message` field (agent_progress or
 * skill_progress).  Other progress types (e.g. bash_progress forwarded from
 * sub-agents) lack this field and must be skipped by UI helpers.
 */
function hasProgressMessage(data: Progress): data is AgentToolProgress {
  if (!('message' in data)) {
    return false;
  }
  const msg = (data as AgentToolProgress).message;
  return msg != null && typeof msg === 'object' && 'type' in msg;
}

/**
 * Check if a progress message is a search/read/REPL operation (tool use or result).
 * Returns { isSearch, isRead, isREPL } if it's a collapsible operation, null otherwise.
 *
 * For tool_result messages, uses the provided `toolUseByID` map to find the
 * corresponding tool_use block instead of relying on `normalizedMessages`.
 */
function getSearchOrReadInfo(progressMessage: ProgressMessage<Progress>, tools: Tools, toolUseByID: Map<string, ToolUseBlockParam>): {
  isSearch: boolean;
  isRead: boolean;
  isREPL: boolean;
} | null {
  if (!hasProgressMessage(progressMessage.data)) {
    return null;
  }
  const message = progressMessage.data.message;

  // Check tool_use (assistant message)
  if (message.type === 'assistant') {
    return getSearchOrReadFromContent(message.message.content[0], tools);
  }

  // Check tool_result (user message) - find corresponding tool use from the map
  if (message.type === 'user') {
    const content = message.message.content[0];
    if (content?.type === 'tool_result') {
      const toolUse = toolUseByID.get(content.tool_use_id);
      if (toolUse) {
        return getSearchOrReadFromContent(toolUse, tools);
      }
    }
  }
  return null;
}
type SummaryMessage = {
  type: 'summary';
  searchCount: number;
  readCount: number;
  replCount: number;
  uuid: string;
  isActive: boolean; // true if still in progress (last message was tool_use, not tool_result)
};
type ProcessedMessage = {
  type: 'original';
  message: ProgressMessage<AgentToolProgress>;
} | SummaryMessage;

function processProgressMessages(messages: ProgressMessage<Progress>[], _tools: Tools, _isAgentRunning: boolean): ProcessedMessage[] {
  return messages.filter((m): m is ProgressMessage<AgentToolProgress> => hasProgressMessage(m.data) && m.data.message.type !== 'user').map(m => ({
    type: 'original',
    message: m
  }));
}
const ESTIMATED_LINES_PER_TOOL = 9;
const TERMINAL_BUFFER_LINES = 7;
type Output = z.input<ReturnType<typeof outputSchema>>;
export function AgentPromptDisplay(t0) {
  const $ = _c(3);
  const {
    prompt
  } = t0;
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Text color="success" bold={true}>Prompt:</Text>;
    $[0] = t2;
  } else {
    t2 = $[0];
  }
  let t3;
  if ($[1] !== prompt) {
    t3 = <Box flexDirection="column">{t2}<Box paddingLeft={2}><Markdown>{prompt}</Markdown></Box></Box>;
    $[1] = prompt;
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  return t3;
}
export function AgentResponseDisplay(t0) {
  const $ = _c(5);
  const {
    content
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text color="success" bold={true}>Response:</Text>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== content) {
    t2 = content.map(_temp);
    $[1] = content;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== t2) {
    t3 = <Box flexDirection="column">{t1}{t2}</Box>;
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}
function _temp(block, index) {
  return <Box key={index} paddingLeft={2} marginTop={index === 0 ? 0 : 1}><Markdown>{block.text}</Markdown></Box>;
}
type VerboseAgentTranscriptProps = {
  progressMessages: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
};
function VerboseAgentTranscript(t0) {
  const $ = _c(15);
  const {
    progressMessages,
    tools,
    verbose
  } = t0;
  let t1;
  if ($[0] !== progressMessages) {
    t1 = buildSubagentLookups(progressMessages.filter(_temp2).map(_temp3));
    $[0] = progressMessages;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const {
    lookups: agentLookups,
    inProgressToolUseIDs
  } = t1;
  let t2;
  if ($[2] !== agentLookups || $[3] !== inProgressToolUseIDs || $[4] !== progressMessages || $[5] !== tools || $[6] !== verbose) {
    const filteredMessages = progressMessages.filter(_temp4);
    let t3;
    if ($[8] !== agentLookups || $[9] !== inProgressToolUseIDs || $[10] !== tools || $[11] !== verbose) {
      t3 = progressMessage => <MessageResponse key={progressMessage.uuid} height={1}><MessageComponent message={progressMessage.data.message} lookups={agentLookups} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} isTranscriptMode={false} isStatic={true} /></MessageResponse>;
      $[8] = agentLookups;
      $[9] = inProgressToolUseIDs;
      $[10] = tools;
      $[11] = verbose;
      $[12] = t3;
    } else {
      t3 = $[12];
    }
    t2 = filteredMessages.map(t3);
    $[2] = agentLookups;
    $[3] = inProgressToolUseIDs;
    $[4] = progressMessages;
    $[5] = tools;
    $[6] = verbose;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  let t3;
  if ($[13] !== t2) {
    t3 = <>{t2}</>;
    $[13] = t2;
    $[14] = t3;
  } else {
    t3 = $[14];
  }
  return t3;
}
function _temp4(pm_1) {
  if (!hasProgressMessage(pm_1.data)) {
    return false;
  }
  const msg = pm_1.data.message;
  if (msg.type === "user" && msg.toolUseResult === undefined) {
    return false;
  }
  return true;
}
function _temp3(pm_0) {
  return pm_0.data;
}
function _temp2(pm) {
  return hasProgressMessage(pm.data);
}
export function renderToolResultMessage(data: Output, progressMessagesForMessage: ProgressMessage<Progress>[], {
  tools,
  verbose,
  theme,
  isTranscriptMode = false
}: {
  tools: Tools;
  verbose: boolean;
  theme: ThemeName;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  if (data.status === 'async_launched') {
    const {
      prompt
    } = data;
    return <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Backgrounded agent
            {!isTranscriptMode && <Text dimColor>
                {' ('}
                <Byline>
                  <KeyboardShortcutHint shortcut="↓" action="manage" />
                  {prompt && <ConfigurableShortcutHint action="app:toggleTranscript" context="Global" fallback="ctrl+o" description="expand" />}
                </Byline>
                {')'}
              </Text>}
          </Text>
        </MessageResponse>
        {isTranscriptMode && prompt && <MessageResponse>
            <AgentPromptDisplay prompt={prompt} theme={theme} />
          </MessageResponse>}
      </Box>;
  }
  if (data.status !== 'completed') {
    return null;
  }
  const {
    totalDurationMs,
    totalToolUseCount,
    totalTokens,
    usage,
    content,
    prompt
  } = data;
  const result = [totalToolUseCount === 1 ? '1 tool use' : `${totalToolUseCount} tool uses`, formatNumber(totalTokens) + ' tokens', formatDuration(totalDurationMs)];
  const completionMessage = `Done (${result.join(' · ')})`;
  const finalAssistantMessage = createAssistantMessage({
    content: completionMessage,
    usage: {
      ...usage,
      output_tokens_details: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      speed: null
    }
  });
  return <Box flexDirection="column">
      {isTranscriptMode && prompt && <MessageResponse>
          <AgentPromptDisplay prompt={prompt} theme={theme} />
        </MessageResponse>}
      {isTranscriptMode ? <SubAgentProvider>
          <VerboseAgentTranscript progressMessages={progressMessagesForMessage} tools={tools} verbose={verbose} />
        </SubAgentProvider> : null}
      {isTranscriptMode && content && content.length > 0 && <MessageResponse>
          <AgentResponseDisplay content={content} theme={theme} />
        </MessageResponse>}
      <MessageResponse height={1}>
        <MessageComponent message={finalAssistantMessage} lookups={EMPTY_LOOKUPS} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={new Set()} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} isTranscriptMode={false} isStatic={true} />
      </MessageResponse>
      {!isTranscriptMode && <Text dimColor>
          {'  '}
          <CtrlOToExpand />
        </Text>}
    </Box>;
}
export function renderToolUseMessage({
  description,
  prompt
}: Partial<{
  description: string;
  prompt: string;
}>): React.ReactNode {
  if (!description || !prompt) {
    return null;
  }
  return description;
}
export function renderToolUseTag(input: Partial<{
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string;
}>): React.ReactNode {
  const tags: React.ReactNode[] = [];
  if (input.model) {
    const mainModel = getMainLoopModel();
    const agentModel = parseUserSpecifiedModel(input.model);
    if (agentModel !== mainModel) {
      tags.push(<Box key="model" flexWrap="nowrap" marginLeft={1}>
          <Text dimColor>{renderModelName(agentModel)}</Text>
        </Box>);
    }
  }
  if (tags.length === 0) {
    return null;
  }
  return <>{tags}</>;
}
const INITIALIZING_TEXT = 'Initializing…';
export function renderToolUseProgressMessage(progressMessages: ProgressMessage<Progress>[], {
  tools,
  verbose,
  terminalSize,
  inProgressToolCallCount,
  isTranscriptMode = false
}: {
  tools: Tools;
  verbose: boolean;
  terminalSize?: {
    columns: number;
    rows: number;
  };
  inProgressToolCallCount?: number;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  if (!progressMessages.length) {
    return <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>;
  }

  // Checks to see if we should show a super condensed progress message summary.
  // This prevents flickers when the terminal size is too small to render all the dynamic content
  const toolToolRenderLinesEstimate = (inProgressToolCallCount ?? 1) * ESTIMATED_LINES_PER_TOOL + TERMINAL_BUFFER_LINES;
  const shouldUseCondensedMode = !isTranscriptMode && terminalSize && terminalSize.rows && terminalSize.rows < toolToolRenderLinesEstimate;
  const getProgressStats = () => {
    const toolUseCount = count(progressMessages, msg => {
      if (!hasProgressMessage(msg.data)) {
        return false;
      }
      const message = msg.data.message;
      return message.message.content.some(content => content.type === 'tool_use');
    });
    const latestAssistant = progressMessages.findLast((msg): msg is ProgressMessage<AgentToolProgress> => hasProgressMessage(msg.data) && msg.data.message.type === 'assistant');
    let tokens = null;
    if (latestAssistant?.data.message.type === 'assistant') {
      const usage = latestAssistant.data.message.message.usage;
      tokens = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.input_tokens + usage.output_tokens;
    }
    return {
      toolUseCount,
      tokens
    };
  };
  if (shouldUseCondensedMode) {
    const {
      toolUseCount,
      tokens
    } = getProgressStats();
    return <MessageResponse height={1}>
        <Text dimColor>
          In progress… · <Text bold>{toolUseCount}</Text> tool{' '}
          {toolUseCount === 1 ? 'use' : 'uses'}
          {tokens && ` · ${formatNumber(tokens)} tokens`} ·{' '}
          <ConfigurableShortcutHint action="app:toggleTranscript" context="Global" fallback="ctrl+o" description="expand" parens />
        </Text>
      </MessageResponse>;
  }

  // Process messages to group consecutive search/read operations into summaries (ants only)
  // isAgentRunning=true since this is the progress view while the agent is still running
  const processedMessages = processProgressMessages(progressMessages, tools, true);

  // For display, take the last few processed messages
  const displayedMessages = isTranscriptMode ? processedMessages : processedMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW);

  // Count hidden tool uses specifically (not all messages) to match the
  // final "Done (N tool uses)" count. Each tool use generates multiple
  // progress messages (tool_use + tool_result + text), so counting all
  // hidden messages inflates the number shown to the user.
  const hiddenMessages = isTranscriptMode ? [] : processedMessages.slice(0, Math.max(0, processedMessages.length - MAX_PROGRESS_MESSAGES_TO_SHOW));
  const hiddenToolUseCount = count(hiddenMessages, m => {
    if (m.type === 'summary') {
      return m.searchCount + m.readCount + m.replCount > 0;
    }
    const data = m.message.data;
    if (!hasProgressMessage(data)) {
      return false;
    }
    return data.message.message.content.some(content => content.type === 'tool_use');
  });
  const firstData = progressMessages[0]?.data;
  const prompt = firstData && hasProgressMessage(firstData) ? firstData.prompt : undefined;

  // After grouping, displayedMessages can be empty when the only progress so
  // far is an assistant tool_use for a search/read op (grouped but not yet
  // counted, since counts increment on tool_result). Fall back to the
  // initializing text so MessageResponse doesn't render a bare └.
  if (displayedMessages.length === 0 && !(isTranscriptMode && prompt)) {
    return <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>;
  }
  const {
    lookups: subagentLookups,
    inProgressToolUseIDs: collapsedInProgressIDs
  } = buildSubagentLookups(progressMessages.filter((pm): pm is ProgressMessage<AgentToolProgress> => hasProgressMessage(pm.data)).map(pm => pm.data));
  return <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {isTranscriptMode && prompt && <Box marginBottom={1}>
              <AgentPromptDisplay prompt={prompt} />
            </Box>}
          {displayedMessages.map(processed => {
          if (processed.type === 'summary') {
            // Render summary for grouped search/read/REPL operations using shared formatting
            const summaryText = getSearchReadSummaryText(processed.searchCount, processed.readCount, processed.isActive, processed.replCount);
            return <Box key={processed.uuid} height={1} overflow="hidden">
                  <Text dimColor>{summaryText}</Text>
                </Box>;
          }
          // Render original message without height=1 wrapper so null
          // content (tool not found, renderToolUseMessage returns null)
          // doesn't leave a blank line. Tool call headers are single-line
          // anyway so truncation isn't needed.
          return <MessageComponent key={processed.message.uuid} message={processed.message.data.message} lookups={subagentLookups} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={collapsedInProgressIDs} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} style="condensed" isTranscriptMode={false} isStatic={true} />;
        })}
        </SubAgentProvider>
        {hiddenToolUseCount > 0 && <Text dimColor>
            +{hiddenToolUseCount} more tool{' '}
            {hiddenToolUseCount === 1 ? 'use' : 'uses'} <CtrlOToExpand />
          </Text>}
      </Box>
    </MessageResponse>;
}
export function renderToolUseRejectedMessage(_input: {
  description: string;
  prompt: string;
  subagent_type: string;
}, {
  progressMessagesForMessage,
  tools,
  verbose,
  isTranscriptMode
}: {
  columns: number;
  messages: Message[];
  style?: 'condensed';
  theme: ThemeName;
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose,
      isTranscriptMode
    })}
      <FallbackToolUseRejectedMessage />
    </>;
}
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  progressMessagesForMessage,
  tools,
  verbose,
  isTranscriptMode
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose,
      isTranscriptMode
    })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>;
}
function calculateAgentStats(progressMessages: ProgressMessage<Progress>[]): {
  toolUseCount: number;
  tokens: number | null;
} {
  const toolUseCount = count(progressMessages, msg => {
    if (!hasProgressMessage(msg.data)) {
      return false;
    }
    const message = msg.data.message;
    return message.type === 'user' && message.message.content.some(content => content.type === 'tool_result');
  });
  const latestAssistant = progressMessages.findLast((msg): msg is ProgressMessage<AgentToolProgress> => hasProgressMessage(msg.data) && msg.data.message.type === 'assistant');
  let tokens = null;
  if (latestAssistant?.data.message.type === 'assistant') {
    const usage = latestAssistant.data.message.message.usage;
    tokens = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.input_tokens + usage.output_tokens;
  }
  return {
    toolUseCount,
    tokens
  };
}
export function renderGroupedAgentToolUse(toolUses: Array<{
  param: ToolUseBlockParam;
  isResolved: boolean;
  isError: boolean;
  isInProgress: boolean;
  progressMessages: ProgressMessage<Progress>[];
  result?: {
    param: ToolResultBlockParam;
    output: Output;
  };
}>, options: {
  shouldAnimate: boolean;
  tools: Tools;
}): React.ReactNode | null {
  const {
    shouldAnimate,
    tools
  } = options;

  // Calculate stats for each agent
  const agentStats = toolUses.map(({
    param,
    isResolved,
    isError,
    progressMessages,
    result
  }) => {
    const stats = calculateAgentStats(progressMessages);
    const lastToolInfo = extractLastToolInfo(progressMessages, tools);
    const parsedInput = inputSchema().safeParse(param.input);

    // teammate_spawned is not part of the exported Output type (cast through unknown
    // for dead code elimination), so check via string comparison on the raw value
    const isTeammateSpawn = result?.output?.status as string === 'teammate_spawned';

    // For teammate spawns, show @name with type in parens and description as status
    let agentType: string;
    let description: string | undefined;
    let color: keyof Theme | undefined;
    let descriptionColor: keyof Theme | undefined;
    let taskDescription: string | undefined;
    if (isTeammateSpawn && parsedInput.success && parsedInput.data.name) {
      agentType = `@${parsedInput.data.name}`;
      const subagentType = parsedInput.data.subagent_type;
      description = isCustomSubagentType(subagentType) ? subagentType : undefined;
      taskDescription = parsedInput.data.description;
      // Use the custom agent definition's color on the type, not the name
      descriptionColor = isCustomSubagentType(subagentType) ? getAgentColor(subagentType) as keyof Theme | undefined : undefined;
    } else {
      agentType = parsedInput.success ? userFacingName(parsedInput.data) : 'Agent';
      description = parsedInput.success ? parsedInput.data.description : undefined;
      color = parsedInput.success ? userFacingNameBackgroundColor(parsedInput.data) : undefined;
      taskDescription = undefined;
    }

    // Check if this was launched as a background agent OR backgrounded mid-execution
    const launchedAsAsync = parsedInput.success && 'run_in_background' in parsedInput.data && parsedInput.data.run_in_background === true;
    const outputStatus = (result?.output as {
      status?: string;
    } | undefined)?.status;
    const backgroundedMidExecution = outputStatus === 'async_launched';
    const isAsync = launchedAsAsync || backgroundedMidExecution || isTeammateSpawn;
    const name = parsedInput.success ? parsedInput.data.name : undefined;
    return {
      id: param.id,
      agentType,
      description,
      toolUseCount: stats.toolUseCount,
      tokens: stats.tokens,
      isResolved,
      isError,
      isAsync,
      color,
      descriptionColor,
      lastToolInfo,
      taskDescription,
      name
    };
  });
  const anyUnresolved = toolUses.some(t => !t.isResolved);
  const anyError = toolUses.some(t => t.isError);
  const allComplete = !anyUnresolved;

  // Check if all agents are the same type
  const allSameType = agentStats.length > 0 && agentStats.every(stat => stat.agentType === agentStats[0]?.agentType);
  const commonType = allSameType && agentStats[0]?.agentType !== 'Agent' ? agentStats[0]?.agentType : null;

  // Check if all resolved agents are async (background)
  const allAsync = agentStats.every(stat => stat.isAsync);
  return <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <ToolUseLoader shouldAnimate={shouldAnimate && anyUnresolved} isUnresolved={anyUnresolved} isError={anyError} />
        <Text>
          {allComplete ? allAsync ? <>
                <Text bold>{toolUses.length}</Text> background agents launched{' '}
                <Text dimColor>
                  <KeyboardShortcutHint shortcut="↓" action="manage" parens />
                </Text>
              </> : <>
                <Text bold>{toolUses.length}</Text>{' '}
                {commonType ? `${commonType} agents` : 'agents'} finished
              </> : <>
              Running <Text bold>{toolUses.length}</Text>{' '}
              {commonType ? `${commonType} agents` : 'agents'}…
            </>}{' '}
        </Text>
        {!allAsync && <CtrlOToExpand />}
      </Box>
      {agentStats.map((stat, index) => <AgentProgressLine key={stat.id} agentType={stat.agentType} description={stat.description} descriptionColor={stat.descriptionColor} taskDescription={stat.taskDescription} toolUseCount={stat.toolUseCount} tokens={stat.tokens} color={stat.color} isLast={index === agentStats.length - 1} isResolved={stat.isResolved} isError={stat.isError} isAsync={stat.isAsync} shouldAnimate={shouldAnimate} lastToolInfo={stat.lastToolInfo} hideType={allSameType} name={stat.name} />)}
    </Box>;
}
export function userFacingName(input: Partial<{
  description: string;
  prompt: string;
  subagent_type: string;
  name: string;
  team_name: string;
}> | undefined): string {
  if (input?.subagent_type && input.subagent_type !== GENERAL_PURPOSE_AGENT.agentType) {
    // Display "worker" agents as "Agent" for cleaner UI
    if (input.subagent_type === 'worker') {
      return 'Agent';
    }
    return input.subagent_type;
  }
  return 'Agent';
}
export function userFacingNameBackgroundColor(input: Partial<{
  description: string;
  prompt: string;
  subagent_type: string;
}> | undefined): keyof Theme | undefined {
  if (!input?.subagent_type) {
    return undefined;
  }

  // Get the color for this agent
  return getAgentColor(input.subagent_type) as keyof Theme | undefined;
}
export function extractLastToolInfo(progressMessages: ProgressMessage<Progress>[], tools: Tools): string | null {
  // Build tool_use lookup from all progress messages (needed for reverse iteration)
  const toolUseByID = new Map<string, ToolUseBlockParam>();
  for (const pm of progressMessages) {
    if (!hasProgressMessage(pm.data)) {
      continue;
    }
    if (pm.data.message.type === 'assistant') {
      for (const c of pm.data.message.message.content) {
        if (c.type === 'tool_use') {
          toolUseByID.set(c.id, c as ToolUseBlockParam);
        }
      }
    }
  }

  // Count trailing consecutive search/read operations from the end
  let searchCount = 0;
  let readCount = 0;
  for (let i = progressMessages.length - 1; i >= 0; i--) {
    const msg = progressMessages[i]!;
    if (!hasProgressMessage(msg.data)) {
      continue;
    }
    const info = getSearchOrReadInfo(msg, tools, toolUseByID);
    if (info && (info.isSearch || info.isRead)) {
      // Only count tool_result messages to avoid double counting
      if (msg.data.message.type === 'user') {
        if (info.isSearch) {
          searchCount++;
        } else if (info.isRead) {
          readCount++;
        }
      }
    } else {
      break;
    }
  }
  if (searchCount + readCount >= 2) {
    return getSearchReadSummaryText(searchCount, readCount, true);
  }

  // Find the last tool_result message
  const lastToolResult = progressMessages.findLast((msg): msg is ProgressMessage<AgentToolProgress> => {
    if (!hasProgressMessage(msg.data)) {
      return false;
    }
    const message = msg.data.message;
    return message.type === 'user' && message.message.content.some(c => c.type === 'tool_result');
  });
  if (lastToolResult?.data.message.type === 'user') {
    const toolResultBlock = lastToolResult.data.message.message.content.find(c => c.type === 'tool_result');
    if (toolResultBlock?.type === 'tool_result') {
      // Look up the corresponding tool_use — already indexed above
      const toolUseBlock = toolUseByID.get(toolResultBlock.tool_use_id);
      if (toolUseBlock) {
        const tool = findToolByName(tools, toolUseBlock.name);
        if (!tool) {
          return toolUseBlock.name; // Fallback to raw name
        }
        const input = toolUseBlock.input as Record<string, unknown>;
        const parsedInput = tool.inputSchema.safeParse(input);

        // Get user-facing tool name
        const userFacingToolName = tool.userFacingName(parsedInput.success ? parsedInput.data : undefined);

        // Try to get summary from the tool itself
        if (tool.getToolUseSummary) {
          const summary = tool.getToolUseSummary(parsedInput.success ? parsedInput.data : undefined);
          if (summary) {
            return `${userFacingToolName}: ${summary}`;
          }
        }

        // Default: just show user-facing tool name
        return userFacingToolName;
      }
    }
  }
  return null;
}
function isCustomSubagentType(subagentType: string | undefined): subagentType is string {
  return !!subagentType && subagentType !== GENERAL_PURPOSE_AGENT.agentType && subagentType !== 'worker';
}
