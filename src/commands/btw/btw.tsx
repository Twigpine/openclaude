import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useInterval } from 'usehooks-ts';
import type { CommandResultDisplay } from '../../commands.js';
import { Markdown } from '../../components/Markdown.js';
import { SpinnerGlyph } from '../../components/Spinner/SpinnerGlyph.js';
import { DOWN_ARROW, UP_ARROW } from '../../constants/figures.js';
import { getSystemPrompt } from '../../constants/prompts.js';
import { useModalOrTerminalSize } from '../../context/modalContext.js';
import { getSystemContext, getUserContext } from '../../context.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message } from '../../types/message.js';
import { createAbortController } from '../../utils/abortController.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { errorMessage } from '../../utils/errors.js';
import { type CacheSafeParams, getLastCacheSafeParams, getQueryModelSelection } from '../../utils/forkedAgent.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import { getDefaultMainLoopModelSetting, parseUserSpecifiedModel } from '../../utils/model/model.js';
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js';
import { runSideQuestion } from '../../utils/sideQuestion.js';
import { asSystemPrompt } from '../../utils/systemPromptType.js';
type BtwComponentProps = {
  question: string;
  context: ProcessUserInputContext;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
const CHROME_ROWS = 5;
const OUTER_CHROME_ROWS = 6;
const SCROLL_LINES = 3;
function BtwSideQuestion(t0) {
  const $ = _c(25);
  const {
    question,
    context,
    onDone
  } = t0;
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const scrollRef = useRef<ScrollBoxHandle>(null);
  const {
    rows
  } = useModalOrTerminalSize(useTerminalSize());
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => setFrame(_temp);
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  useInterval(t1, response || error ? null : 80);
  let t2;
  if ($[1] !== onDone) {
    t2 = function handleKeyDown(e) {
      if (e.key === "escape" || e.key === "return" || e.key === " " || e.ctrl && (e.key === "c" || e.key === "d")) {
        e.preventDefault();
        onDone(undefined, {
          display: "skip"
        });
        return;
      }
      if (e.key === "up" || e.ctrl && e.key === "p") {
        e.preventDefault();
        scrollRef.current?.scrollBy(-SCROLL_LINES);
      }
      if (e.key === "down" || e.ctrl && e.key === "n") {
        e.preventDefault();
        scrollRef.current?.scrollBy(SCROLL_LINES);
      }
    };
    $[1] = onDone;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const handleKeyDown = t2;
  let t3;
  let t4;
  if ($[3] !== context || $[4] !== question) {
    t3 = () => {
      const abortController = createAbortController();
      const fetchResponse = async function fetchResponse() {
        ;
        try {
          const cacheSafeParams = await buildCacheSafeParams(context);
          const result = await runSideQuestion({
            question,
            cacheSafeParams
          });
          if (!abortController.signal.aborted) {
            if (result.response) {
              setResponse(result.response);
            } else {
              setError("No response received");
            }
          }
        } catch (t5) {
          const err = t5;
          if (!abortController.signal.aborted) {
            setError(errorMessage(err) || "Failed to get response");
          }
        }
      };
      fetchResponse();
      return () => {
        abortController.abort();
      };
    };
    t4 = [question, context];
    $[3] = context;
    $[4] = question;
    $[5] = t3;
    $[6] = t4;
  } else {
    t3 = $[5];
    t4 = $[6];
  }
  useEffect(t3, t4);
  const maxContentHeight = Math.max(5, rows - CHROME_ROWS - OUTER_CHROME_ROWS);
  let t5;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text color="warning" bold={true}>/btw{" "}</Text>;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  let t6;
  if ($[8] !== question) {
    t6 = <Box>{t5}<Text dimColor={true}>{question}</Text></Box>;
    $[8] = question;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  let t7;
  if ($[10] !== error || $[11] !== frame || $[12] !== response) {
    t7 = <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>{error ? <Text color="error">{error}</Text> : response ? <Markdown>{response}</Markdown> : <Box><SpinnerGlyph frame={frame} messageColor="warning" /><Text color="warning">Answering...</Text></Box>}</ScrollBox>;
    $[10] = error;
    $[11] = frame;
    $[12] = response;
    $[13] = t7;
  } else {
    t7 = $[13];
  }
  let t8;
  if ($[14] !== maxContentHeight || $[15] !== t7) {
    t8 = <Box marginTop={1} marginLeft={2} maxHeight={maxContentHeight}>{t7}</Box>;
    $[14] = maxContentHeight;
    $[15] = t7;
    $[16] = t8;
  } else {
    t8 = $[16];
  }
  let t9;
  if ($[17] !== error || $[18] !== response) {
    t9 = (response || error) && <Box marginTop={1}><Text dimColor={true}>{UP_ARROW}/{DOWN_ARROW} to scroll · Space, Enter, or Escape to dismiss</Text></Box>;
    $[17] = error;
    $[18] = response;
    $[19] = t9;
  } else {
    t9 = $[19];
  }
  let t10;
  if ($[20] !== handleKeyDown || $[21] !== t6 || $[22] !== t8 || $[23] !== t9) {
    t10 = <Box flexDirection="column" paddingLeft={2} marginTop={1} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{t6}{t8}{t9}</Box>;
    $[20] = handleKeyDown;
    $[21] = t6;
    $[22] = t8;
    $[23] = t9;
    $[24] = t10;
  } else {
    t10 = $[24];
  }
  return t10;
}

/**
 * Build CacheSafeParams for the side question fork.
 *
 * The preferred source is getLastCacheSafeParams — the exact
 * systemPrompt/userContext/systemContext bytes the main thread sent on its
 * last request (captured in stopHooks). Reusing them guarantees a byte-
 * identical prefix and thus a prompt cache hit. We pair these with the
 * current toolUseContext (for thinkingConfig/tools) and current messages
 * (for up-to-date context).
 *
 * Fallback (first turn before stop hooks fire, or prompt-suggestion
 * disabled): rebuild from scratch. This may miss the cache if the main loop
 * applied buildEffectiveSystemPrompt extras (--agent, --system-prompt,
 * --append-system-prompt, coordinator mode).
 */
function _temp(f) {
  return f + 1;
}
function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1);
  }
  return messages;
}
async function buildCacheSafeParams(context: ProcessUserInputContext): Promise<CacheSafeParams> {
  const forkContextMessages = getMessagesAfterCompactBoundary(stripInProgressAssistantMessage(context.messages));
  const saved = getLastCacheSafeParams();
  if (saved) {
    const parent = saved.toolUseContext;
    const selection = getQueryModelSelection(parent);
    let toolUseContext = context;
    // Commands get fresh options. Carry the accepted request only while both
    // its source and the current configured selection are still unchanged.
    if (!context.agentId && !context.queryModelSelection && selection) {
      const state = context.getAppState();
      const selectedModel = state.mainLoopModelForSession ?? state.mainLoopModel ?? getDefaultMainLoopModelSetting();
      if (selectedModel === selection.selectedModel && context.options.mainLoopModel === parseUserSpecifiedModel(selectedModel)) {
        toolUseContext = {
          ...context,
          queryModelSelection: {
            agentId: context.agentId,
            current: { ...selection, options: context.options, model: context.options.mainLoopModel }
          }
        };
      }
    }
    return {
      systemPrompt: saved.systemPrompt,
      userContext: saved.userContext,
      systemContext: saved.systemContext,
      toolUseContext,
      forkContextMessages
    };
  }
  const [rawSystemPrompt, userContext, systemContext] = await Promise.all([getSystemPrompt(context.options.tools, context.options.mainLoopModel, [], context.options.mcpClients), getUserContext(), getSystemContext()]);
  return {
    systemPrompt: asSystemPrompt(rawSystemPrompt),
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages
  };
}
export async function call(onDone: LocalJSXCommandOnDone, context: ProcessUserInputContext, args: string): Promise<React.ReactNode> {
  const question = args?.trim();
  if (!question) {
    onDone('Usage: /btw <your question>', {
      display: 'system'
    });
    return null;
  }
  saveGlobalConfig(current => ({
    ...current,
    btwUseCount: current.btwUseCount + 1
  }));
  return <BtwSideQuestion question={question} context={context} onDone={onDone} />;
}
