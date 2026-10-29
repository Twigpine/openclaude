import { c as _c } from "react-compiler-runtime";
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { randomUUID, type UUID } from 'crypto';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { useAppState } from 'src/state/AppState.js';
import { type DiffStats, fileHistoryCanRestore, fileHistoryEnabled, fileHistoryGetDiffStats } from 'src/utils/fileHistory.js';
import { logError } from 'src/utils/log.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../ink.js';
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js';
import type { Message, PartialCompactDirection, UserMessage } from '../types/message.js';
import { stripDisplayTags } from '../utils/displayTags.js';
import { createUserMessage, extractTag, isEmptyMessageText, isToolUseResultMessage } from '../utils/messages.js';
import { selectableUserMessagesFilter } from '../utils/messageFilters.js';
import { type OptionWithDescription, Select } from './CustomSelect/select.js';
import { Spinner } from './Spinner.js';
function isTextBlock(block: ContentBlockParam): block is TextBlockParam {
  return block.type === 'text';
}
import * as path from 'path';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import type { FileEditOutput } from 'src/tools/FileEditTool/types.js';
import type { Output as FileWriteToolOutput } from 'src/tools/FileWriteTool/FileWriteTool.js';
import { COMMAND_MESSAGE_TAG } from '../constants/xml.js';
import { count } from '../utils/array.js';
import { formatRelativeTimeAgo, truncate } from '../utils/format.js';
import type { Theme } from '../utils/theme.js';
import { Divider } from './design-system/Divider.js';
type RestoreOption = 'both' | 'conversation' | 'code' | 'summarize' | 'summarize_up_to' | 'nevermind';
function isSummarizeOption(option: RestoreOption | null): option is 'summarize' | 'summarize_up_to' {
  return option === 'summarize' || option === 'summarize_up_to';
}
type Props = {
  messages: Message[];
  onPreRestore: () => void;
  onRestoreMessage: (message: UserMessage) => Promise<void>;
  onRestoreCode: (message: UserMessage) => Promise<void>;
  onSummarize: (message: UserMessage, feedback?: string, direction?: PartialCompactDirection) => Promise<void>;
  onClose: () => void;
  /** Skip pick-list, land on confirm. Caller ran skip-check first. Esc closes fully (no back-to-list). */
  preselectedMessage?: UserMessage;
};
const MAX_VISIBLE_MESSAGES = 7;
export function MessageSelector({
  messages,
  onPreRestore,
  onRestoreMessage,
  onRestoreCode,
  onSummarize,
  onClose,
  preselectedMessage
}: Props): React.ReactNode {
  const fileHistory = useAppState(s => s.fileHistory);
  const [error, setError] = useState<string | undefined>(undefined);
  const isFileHistoryEnabled = fileHistoryEnabled();

  // Add current prompt as a virtual message
  const currentUUID = useMemo(randomUUID, []);
  const messageOptions = useMemo(() => [...messages.filter(selectableUserMessagesFilter), {
    ...createUserMessage({
      content: ''
    }),
    uuid: currentUUID
  } as UserMessage], [messages, currentUUID]);
  const [selectedIndex, setSelectedIndex] = useState(messageOptions.length - 1);

  // Orient the selected message as the middle of the visible options
  const firstVisibleIndex = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE_MESSAGES / 2), messageOptions.length - MAX_VISIBLE_MESSAGES));
  const hasMessagesToSelect = messageOptions.length > 1;
  const [messageToRestore, setMessageToRestore] = useState<UserMessage | undefined>(preselectedMessage);
  const [diffStatsForRestore, setDiffStatsForRestore] = useState<DiffStats | undefined>(undefined);
  useEffect(() => {
    if (!preselectedMessage || !isFileHistoryEnabled) return;
    let cancelled = false;
    void fileHistoryGetDiffStats(fileHistory, preselectedMessage.uuid).then(stats => {
      if (!cancelled) setDiffStatsForRestore(stats);
    });
    return () => {
      cancelled = true;
    };
  }, [preselectedMessage, isFileHistoryEnabled, fileHistory]);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoringOption, setRestoringOption] = useState<RestoreOption | null>(null);
  const [selectedRestoreOption, setSelectedRestoreOption] = useState<RestoreOption>('both');
  // Per-option feedback state; Select's internal inputValues Map persists
  // per-option text independently, so sharing one variable would desync.
  const [summarizeFromFeedback, setSummarizeFromFeedback] = useState('');
  const [summarizeUpToFeedback] = useState('');

  // Generate options with summarize as input type for inline context
  function getRestoreOptions(canRestoreCode: boolean): OptionWithDescription<RestoreOption>[] {
    const baseOptions: OptionWithDescription<RestoreOption>[] = canRestoreCode ? [{
      value: 'both',
      label: 'Restore code and conversation'
    }, {
      value: 'conversation',
      label: 'Restore conversation'
    }, {
      value: 'code',
      label: 'Restore code'
    }] : [{
      value: 'conversation',
      label: 'Restore conversation'
    }];
    const summarizeInputProps = {
      type: 'input' as const,
      placeholder: 'add context (optional)',
      initialValue: '',
      allowEmptySubmitToCancel: true,
      showLabelWithValue: true,
      labelValueSeparator: ': '
    };
    baseOptions.push({
      value: 'summarize',
      label: 'Summarize from here',
      ...summarizeInputProps,
      onChange: setSummarizeFromFeedback
    });
    baseOptions.push({
      value: 'nevermind',
      label: 'Never mind'
    });
    return baseOptions;
  }

  // Log when selector is opened
  useEffect(() => {
    logEvent('tengu_message_selector_opened', {});
  }, []);

  // Helper to restore conversation without confirmation
  async function restoreConversationDirectly(message: UserMessage) {
    onPreRestore();
    setIsRestoring(true);
    try {
      await onRestoreMessage(message);
      setIsRestoring(false);
      onClose();
    } catch (error_0) {
      logError(error_0 as Error);
      setIsRestoring(false);
      setError(`Failed to restore the conversation:\n${error_0}`);
    }
  }
  async function handleSelect(message_0: UserMessage) {
    const index = messages.indexOf(message_0);
    const indexFromEnd = messages.length - 1 - index;
    logEvent('tengu_message_selector_selected', {
      index_from_end: indexFromEnd,
      message_type: message_0.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      is_current_prompt: false
    });

    // Do nothing if the message is not found
    if (!messages.includes(message_0)) {
      onClose();
      return;
    }
    if (!isFileHistoryEnabled) {
      await restoreConversationDirectly(message_0);
      return;
    }
    const diffStats = await fileHistoryGetDiffStats(fileHistory, message_0.uuid);
    setMessageToRestore(message_0);
    setDiffStatsForRestore(diffStats);
  }
  async function onSelectRestoreOption(option: RestoreOption) {
    logEvent('tengu_message_selector_restore_option_selected', {
      option: option as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    if (!messageToRestore) {
      setError('Message not found.');
      return;
    }
    if (option === 'nevermind') {
      if (preselectedMessage) onClose();else setMessageToRestore(undefined);
      return;
    }
    if (isSummarizeOption(option)) {
      onPreRestore();
      setIsRestoring(true);
      setRestoringOption(option);
      setError(undefined);
      try {
        const direction = option === 'summarize_up_to' ? 'up_to' : 'from';
        const feedback = (direction === 'up_to' ? summarizeUpToFeedback : summarizeFromFeedback).trim() || undefined;
        await onSummarize(messageToRestore, feedback, direction);
        setIsRestoring(false);
        setRestoringOption(null);
        setMessageToRestore(undefined);
        onClose();
      } catch (error_1) {
        logError(error_1 as Error);
        setIsRestoring(false);
        setRestoringOption(null);
        setMessageToRestore(undefined);
        setError(`Failed to summarize:\n${error_1}`);
      }
      return;
    }
    onPreRestore();
    setIsRestoring(true);
    setError(undefined);
    let codeError: Error | null = null;
    let conversationError: Error | null = null;
    if (option === 'code' || option === 'both') {
      try {
        await onRestoreCode(messageToRestore);
      } catch (error_2) {
        codeError = error_2 as Error;
        logError(codeError);
      }
    }
    if (option === 'conversation' || option === 'both') {
      try {
        await onRestoreMessage(messageToRestore);
      } catch (error_3) {
        conversationError = error_3 as Error;
        logError(conversationError);
      }
    }
    setIsRestoring(false);
    setMessageToRestore(undefined);

    // Handle errors
    if (conversationError && codeError) {
      setError(`Failed to restore the conversation and code:\n${conversationError}\n${codeError}`);
    } else if (conversationError) {
      setError(`Failed to restore the conversation:\n${conversationError}`);
    } else if (codeError) {
      setError(`Failed to restore the code:\n${codeError}`);
    } else {
      // Success - close the selector
      onClose();
    }
  }
  const exitState = useExitOnCtrlCDWithKeybindings();
  const handleEscape = useCallback(() => {
    if (messageToRestore && !preselectedMessage) {
      // Go back to message list instead of closing entirely
      setMessageToRestore(undefined);
      return;
    }
    logEvent('tengu_message_selector_cancelled', {});
    onClose();
  }, [onClose, messageToRestore, preselectedMessage]);
  const moveUp = useCallback(() => setSelectedIndex(prev => Math.max(0, prev - 1)), []);
  const moveDown = useCallback(() => setSelectedIndex(prev_0 => Math.min(messageOptions.length - 1, prev_0 + 1)), [messageOptions.length]);
  const jumpToTop = useCallback(() => setSelectedIndex(0), []);
  const jumpToBottom = useCallback(() => setSelectedIndex(messageOptions.length - 1), [messageOptions.length]);
  const handleSelectCurrent = useCallback(() => {
    const selected = messageOptions[selectedIndex];
    if (selected) {
      void handleSelect(selected);
    }
  }, [messageOptions, selectedIndex, handleSelect]);

  // Escape to close - uses Confirmation context where escape is bound
  useKeybinding('confirm:no', handleEscape, {
    context: 'Confirmation',
    isActive: !messageToRestore
  });

  // Message selector navigation keybindings
  useKeybindings({
    'messageSelector:up': moveUp,
    'messageSelector:down': moveDown,
    'messageSelector:top': jumpToTop,
    'messageSelector:bottom': jumpToBottom,
    'messageSelector:select': handleSelectCurrent
  }, {
    context: 'MessageSelector',
    isActive: !isRestoring && !error && !messageToRestore && hasMessagesToSelect
  });
  const [fileHistoryMetadata, setFileHistoryMetadata] = useState<Record<number, DiffStats>>({});
  useEffect(() => {
    async function loadFileHistoryMetadata() {
      if (!isFileHistoryEnabled) {
        return;
      }
      // Load file snapshot metadata
      void Promise.all(messageOptions.map(async (userMessage, itemIndex) => {
        if (userMessage.uuid !== currentUUID) {
          const canRestore = fileHistoryCanRestore(fileHistory, userMessage.uuid);
          const nextUserMessage = messageOptions.at(itemIndex + 1);
          const diffStats_0 = canRestore ? computeDiffStatsBetweenMessages(messages, userMessage.uuid, nextUserMessage?.uuid !== currentUUID ? nextUserMessage?.uuid : undefined) : undefined;
          if (diffStats_0 !== undefined) {
            setFileHistoryMetadata(prev_1 => ({
              ...prev_1,
              [itemIndex]: diffStats_0
            }));
          } else {
            setFileHistoryMetadata(prev_2 => ({
              ...prev_2,
              [itemIndex]: undefined
            }));
          }
        }
      }));
    }
    void loadFileHistoryMetadata();
  }, [messageOptions, messages, currentUUID, fileHistory, isFileHistoryEnabled]);
  const canRestoreCode_0 = isFileHistoryEnabled && diffStatsForRestore?.filesChanged && diffStatsForRestore.filesChanged.length > 0;
  const showPickList = !error && !messageToRestore && !preselectedMessage && hasMessagesToSelect;
  return <Box flexDirection="column" width="100%">
      <Divider color="suggestion" />
      <Box flexDirection="column" marginX={1} gap={1}>
        <Text bold color="suggestion">
          Rewind
        </Text>

        {error && <>
            <Text color="error">Error: {error}</Text>
          </>}
        {!hasMessagesToSelect && <>
            <Text>Nothing to rewind to yet.</Text>
          </>}
        {!error && messageToRestore && hasMessagesToSelect && <>
            <Text>
              Confirm you want to restore{' '}
              {!diffStatsForRestore && 'the conversation '}to the point before
              you sent this message:
            </Text>
            <Box flexDirection="column" paddingLeft={1} borderStyle="single" borderRight={false} borderTop={false} borderBottom={false} borderLeft={true} borderLeftDimColor>
              <UserMessageOption userMessage={messageToRestore} color="text" isCurrent={false} />
              <Text dimColor>
                ({formatRelativeTimeAgo(new Date(messageToRestore.timestamp))})
              </Text>
            </Box>
            <RestoreOptionDescription selectedRestoreOption={selectedRestoreOption} canRestoreCode={!!canRestoreCode_0} diffStatsForRestore={diffStatsForRestore} />
            {isRestoring && isSummarizeOption(restoringOption) ? <Box flexDirection="row" gap={1}>
                <Spinner />
                <Text>Summarizing…</Text>
              </Box> : <Select isDisabled={isRestoring} options={getRestoreOptions(!!canRestoreCode_0)} defaultFocusValue={canRestoreCode_0 ? 'both' : 'conversation'} onFocus={value => setSelectedRestoreOption(value as RestoreOption)} onChange={value_0 => onSelectRestoreOption(value_0 as RestoreOption)} onCancel={() => preselectedMessage ? onClose() : setMessageToRestore(undefined)} />}
            {canRestoreCode_0 && <Box marginBottom={1}>
                <Text dimColor>
                  {figures.warning} Rewinding does not affect files edited
                  manually or via bash.
                </Text>
              </Box>}
          </>}
        {showPickList && <>
            {isFileHistoryEnabled ? <Text>
                Restore the code and/or conversation to the point before…
              </Text> : <Text>
                Restore and fork the conversation to the point before…
              </Text>}
            <Box width="100%" flexDirection="column">
              {messageOptions.slice(firstVisibleIndex, firstVisibleIndex + MAX_VISIBLE_MESSAGES).map((msg, visibleOptionIndex) => {
            const optionIndex = firstVisibleIndex + visibleOptionIndex;
            const isSelected = optionIndex === selectedIndex;
            const isCurrent = msg.uuid === currentUUID;
            const metadataLoaded = optionIndex in fileHistoryMetadata;
            const metadata = fileHistoryMetadata[optionIndex];
            const numFilesChanged = metadata?.filesChanged && metadata.filesChanged.length;
            return <Box key={msg.uuid} height={isFileHistoryEnabled ? 3 : 2} overflow="hidden" width="100%" flexDirection="row">
                      <Box width={2} minWidth={2}>
                        {isSelected ? <Text color="permission" bold>
                            {figures.pointer}{' '}
                          </Text> : <Text>{'  '}</Text>}
                      </Box>
                      <Box flexDirection="column">
                        <Box flexShrink={1} height={1} overflow="hidden">
                          <UserMessageOption userMessage={msg} color={isSelected ? 'suggestion' : undefined} isCurrent={isCurrent} paddingRight={10} />
                        </Box>
                        {isFileHistoryEnabled && metadataLoaded && <Box height={1} flexDirection="row">
                            {metadata ? <>
                                <Text dimColor={!isSelected} color="inactive">
                                  {numFilesChanged ? <>
                                      {numFilesChanged === 1 && metadata.filesChanged![0] ? `${path.basename(metadata.filesChanged![0])} ` : `${numFilesChanged} files changed `}
                                      <DiffStatsText diffStats={metadata} />
                                    </> : <>No code changes</>}
                                </Text>
                              </> : <Text dimColor color="warning">
                                {figures.warning} No code restore
                              </Text>}
                          </Box>}
                      </Box>
                    </Box>;
          })}
            </Box>
          </>}
        {!messageToRestore && <Text dimColor italic>
            {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>
                {!error && hasMessagesToSelect && 'Enter to continue · '}Esc to
                exit
              </>}
          </Text>}
      </Box>
    </Box>;
}
function getRestoreOptionConversationText(option: RestoreOption): string {
  switch (option) {
    case 'summarize':
      return 'Messages after this point will be summarized.';
    case 'summarize_up_to':
      return 'Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.';
    case 'both':
    case 'conversation':
      return 'The conversation will be forked.';
    case 'code':
    case 'nevermind':
      return 'The conversation will be unchanged.';
  }
}
function RestoreOptionDescription(t0) {
  const $ = _c(11);
  const {
    selectedRestoreOption,
    canRestoreCode,
    diffStatsForRestore
  } = t0;
  const showCodeRestore = canRestoreCode && (selectedRestoreOption === "both" || selectedRestoreOption === "code");
  let t1;
  if ($[0] !== selectedRestoreOption) {
    t1 = getRestoreOptionConversationText(selectedRestoreOption);
    $[0] = selectedRestoreOption;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1) {
    t2 = <Text dimColor={true}>{t1}</Text>;
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== diffStatsForRestore || $[5] !== selectedRestoreOption || $[6] !== showCodeRestore) {
    t3 = !isSummarizeOption(selectedRestoreOption) && (showCodeRestore ? <RestoreCodeConfirmation diffStatsForRestore={diffStatsForRestore} /> : <Text dimColor={true}>The code will be unchanged.</Text>);
    $[4] = diffStatsForRestore;
    $[5] = selectedRestoreOption;
    $[6] = showCodeRestore;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  let t4;
  if ($[8] !== t2 || $[9] !== t3) {
    t4 = <Box flexDirection="column">{t2}{t3}</Box>;
    $[8] = t2;
    $[9] = t3;
    $[10] = t4;
  } else {
    t4 = $[10];
  }
  return t4;
}
function RestoreCodeConfirmation(t0) {
  const $ = _c(14);
  const {
    diffStatsForRestore
  } = t0;
  if (diffStatsForRestore === undefined) {
    return;
  }
  if (!diffStatsForRestore.filesChanged || !diffStatsForRestore.filesChanged[0]) {
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text dimColor={true}>The code has not changed (nothing will be restored).</Text>;
      $[0] = t1;
    } else {
      t1 = $[0];
    }
    return t1;
  }
  const numFilesChanged = diffStatsForRestore.filesChanged.length;
  let fileLabel;
  if (numFilesChanged === 1) {
    let t1;
    if ($[1] !== diffStatsForRestore.filesChanged[0]) {
      t1 = path.basename(diffStatsForRestore.filesChanged[0] || "");
      $[1] = diffStatsForRestore.filesChanged[0];
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    fileLabel = t1;
  } else {
    if (numFilesChanged === 2) {
      let t1;
      if ($[3] !== diffStatsForRestore.filesChanged[0]) {
        t1 = path.basename(diffStatsForRestore.filesChanged[0] || "");
        $[3] = diffStatsForRestore.filesChanged[0];
        $[4] = t1;
      } else {
        t1 = $[4];
      }
      const file1 = t1;
      let t2;
      if ($[5] !== diffStatsForRestore.filesChanged[1]) {
        t2 = path.basename(diffStatsForRestore.filesChanged[1] || "");
        $[5] = diffStatsForRestore.filesChanged[1];
        $[6] = t2;
      } else {
        t2 = $[6];
      }
      const file2 = t2;
      fileLabel = `${file1} and ${file2}`;
    } else {
      let t1;
      if ($[7] !== diffStatsForRestore.filesChanged[0]) {
        t1 = path.basename(diffStatsForRestore.filesChanged[0] || "");
        $[7] = diffStatsForRestore.filesChanged[0];
        $[8] = t1;
      } else {
        t1 = $[8];
      }
      const file1_0 = t1;
      fileLabel = `${file1_0} and ${diffStatsForRestore.filesChanged.length - 1} other files`;
    }
  }
  let t1;
  if ($[9] !== diffStatsForRestore) {
    t1 = <DiffStatsText diffStats={diffStatsForRestore} />;
    $[9] = diffStatsForRestore;
    $[10] = t1;
  } else {
    t1 = $[10];
  }
  let t2;
  if ($[11] !== fileLabel || $[12] !== t1) {
    t2 = <><Text dimColor={true}>The code will be restored{" "}{t1} in {fileLabel}.</Text></>;
    $[11] = fileLabel;
    $[12] = t1;
    $[13] = t2;
  } else {
    t2 = $[13];
  }
  return t2;
}
function DiffStatsText(t0) {
  const $ = _c(7);
  const {
    diffStats
  } = t0;
  if (!diffStats || !diffStats.filesChanged) {
    return;
  }
  let t1;
  if ($[0] !== diffStats.insertions) {
    t1 = <Text color="diffAddedWord">+{diffStats.insertions} </Text>;
    $[0] = diffStats.insertions;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== diffStats.deletions) {
    t2 = <Text color="diffRemovedWord">-{diffStats.deletions}</Text>;
    $[2] = diffStats.deletions;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== t1 || $[5] !== t2) {
    t3 = <>{t1}{t2}</>;
    $[4] = t1;
    $[5] = t2;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  return t3;
}
function UserMessageOption(t0) {
  const $ = _c(31);
  const {
    userMessage,
    color,
    dimColor,
    isCurrent,
    paddingRight
  } = t0;
  const {
    columns
  } = useTerminalSize();
  if (isCurrent) {
    let t1;
    if ($[0] !== color || $[1] !== dimColor) {
      t1 = <Box width="100%"><Text italic={true} color={color} dimColor={dimColor}>(current)</Text></Box>;
      $[0] = color;
      $[1] = dimColor;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  const content = userMessage.message.content;
  const lastBlock = typeof content === "string" ? null : content[content.length - 1];
  let T0;
  let T1;
  let t1;
  let t2;
  let t3;
  let t4;
  let t5;
  let t6;
  if ($[3] !== color || $[4] !== columns || $[5] !== content || $[6] !== dimColor || $[7] !== lastBlock || $[8] !== paddingRight) {
    t6 = Symbol.for("react.early_return_sentinel");
    bb0: {
      const rawMessageText = typeof content === "string" ? content.trim() : lastBlock && isTextBlock(lastBlock) ? lastBlock.text.trim() : "(no prompt)";
      const messageText = stripDisplayTags(rawMessageText);
      if (isEmptyMessageText(messageText)) {
        let t7;
        if ($[17] !== color || $[18] !== dimColor) {
          t7 = <Box flexDirection="row" width="100%"><Text italic={true} color={color} dimColor={dimColor}>((empty message))</Text></Box>;
          $[17] = color;
          $[18] = dimColor;
          $[19] = t7;
        } else {
          t7 = $[19];
        }
        t6 = t7;
        break bb0;
      }
      if (messageText.includes("<bash-input>")) {
        const input = extractTag(messageText, "bash-input");
        if (input) {
          let t7;
          if ($[20] === Symbol.for("react.memo_cache_sentinel")) {
            t7 = <Text color="bashBorder">!</Text>;
            $[20] = t7;
          } else {
            t7 = $[20];
          }
          t6 = <Box flexDirection="row" width="100%">{t7}<Text color={color} dimColor={dimColor}>{" "}{input}</Text></Box>;
          break bb0;
        }
      }
      if (messageText.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
        const commandMessage = extractTag(messageText, COMMAND_MESSAGE_TAG);
        const args = extractTag(messageText, "command-args");
        const isSkillFormat = extractTag(messageText, "skill-format") === "true";
        if (commandMessage) {
          if (isSkillFormat) {
            t6 = <Box flexDirection="row" width="100%"><Text color={color} dimColor={dimColor}>Skill({commandMessage})</Text></Box>;
            break bb0;
          } else {
            t6 = <Box flexDirection="row" width="100%"><Text color={color} dimColor={dimColor}>/{commandMessage} {args}</Text></Box>;
            break bb0;
          }
        }
      }
      T1 = Box;
      t4 = "row";
      t5 = "100%";
      T0 = Text;
      t1 = color;
      t2 = dimColor;
      t3 = paddingRight ? truncate(messageText, columns - paddingRight, true) : messageText.slice(0, 500).split("\n").slice(0, 4).join("\n");
    }
    $[3] = color;
    $[4] = columns;
    $[5] = content;
    $[6] = dimColor;
    $[7] = lastBlock;
    $[8] = paddingRight;
    $[9] = T0;
    $[10] = T1;
    $[11] = t1;
    $[12] = t2;
    $[13] = t3;
    $[14] = t4;
    $[15] = t5;
    $[16] = t6;
  } else {
    T0 = $[9];
    T1 = $[10];
    t1 = $[11];
    t2 = $[12];
    t3 = $[13];
    t4 = $[14];
    t5 = $[15];
    t6 = $[16];
  }
  if (t6 !== Symbol.for("react.early_return_sentinel")) {
    return t6;
  }
  let t7;
  if ($[21] !== T0 || $[22] !== t1 || $[23] !== t2 || $[24] !== t3) {
    t7 = <T0 color={t1} dimColor={t2}>{t3}</T0>;
    $[21] = T0;
    $[22] = t1;
    $[23] = t2;
    $[24] = t3;
    $[25] = t7;
  } else {
    t7 = $[25];
  }
  let t8;
  if ($[26] !== T1 || $[27] !== t4 || $[28] !== t5 || $[29] !== t7) {
    t8 = <T1 flexDirection={t4} width={t5}>{t7}</T1>;
    $[26] = T1;
    $[27] = t4;
    $[28] = t5;
    $[29] = t7;
    $[30] = t8;
  } else {
    t8 = $[30];
  }
  return t8;
}

/**
 * Computes the diff stats for all the file edits in-between two messages.
 */
function computeDiffStatsBetweenMessages(messages: Message[], fromMessageId: UUID, toMessageId: UUID | undefined): DiffStats | undefined {
  const startIndex = messages.findIndex(msg => msg.uuid === fromMessageId);
  if (startIndex === -1) {
    return undefined;
  }
  let endIndex = toMessageId ? messages.findIndex(msg => msg.uuid === toMessageId) : messages.length;
  if (endIndex === -1) {
    endIndex = messages.length;
  }
  const filesChanged: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (let i = startIndex + 1; i < endIndex; i++) {
    const msg = messages[i];
    if (!msg || !isToolUseResultMessage(msg)) {
      continue;
    }
    const result = msg.toolUseResult as FileEditOutput | FileWriteToolOutput;
    if (!result || !result.filePath || !result.structuredPatch) {
      continue;
    }
    if (!filesChanged.includes(result.filePath)) {
      filesChanged.push(result.filePath);
    }
    try {
      if ('type' in result && result.type === 'create') {
        insertions += result.content.split(/\r?\n/).length;
      } else {
        for (const hunk of result.structuredPatch) {
          const additions = count(hunk.lines, line => line.startsWith('+'));
          const removals = count(hunk.lines, line => line.startsWith('-'));
          insertions += additions;
          deletions += removals;
        }
      }
    } catch {
      continue;
    }
  }
  return {
    filesChanged,
    insertions,
    deletions
  };
}
