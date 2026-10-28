import { c as _c } from "react-compiler-runtime";
import { mkdir, writeFile } from 'fs/promises';
import { marked, type Tokens } from 'marked';
import { tmpdir } from 'os';
import { join } from 'path';
import React, { useRef } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import type { OptionWithDescription } from '../../components/CustomSelect/select.js';
import { Select } from '../../components/CustomSelect/select.js';
import { Byline } from '../../components/design-system/Byline.js';
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js';
import { Pane } from '../../components/design-system/Pane.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { setClipboard } from '../../ink/termio/osc.js';
import { Box, Text } from '../../ink.js';
import { logEvent } from '../../services/analytics/index.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { AssistantMessage, Message } from '../../types/message.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { extractTextContent, stripPromptXMLTags } from '../../utils/messages.js';
import { countCharInString } from '../../utils/stringUtils.js';
const COPY_DIR = join(tmpdir(), 'claude');
const RESPONSE_FILENAME = 'response.md';
const MAX_LOOKBACK = 20;
type CodeBlock = {
  code: string;
  lang: string | undefined;
};
function extractCodeBlocks(markdown: string): CodeBlock[] {
  const tokens = marked.lexer(stripPromptXMLTags(markdown));
  const blocks: CodeBlock[] = [];
  for (const token of tokens) {
    if (token.type === 'code') {
      const codeToken = token as Tokens.Code;
      blocks.push({
        code: codeToken.codeBlockStyle === 'indented'
          ? codeToken.text.replace(/\n+$/, '')
          : codeToken.text,
        lang: codeToken.lang
      });
    }
  }
  return blocks;
}

/**
 * Walk messages newest-first, returning text from assistant messages that
 * actually said something (skips tool-use-only turns and API errors).
 * Index 0 = latest, 1 = second-to-latest, etc. Caps at MAX_LOOKBACK.
 */
export function collectRecentAssistantTexts(messages: Message[]): string[] {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < MAX_LOOKBACK; i--) {
    const msg = messages[i];
    if (msg?.type !== 'assistant' || msg.isApiErrorMessage) continue;
    const content = (msg as AssistantMessage).message.content;
    if (!Array.isArray(content)) continue;
    const text = extractTextContent(content, '\n\n');
    if (text) texts.push(text);
  }
  return texts;
}
export function fileExtension(lang: string | undefined): string {
  if (lang) {
    // Sanitize to prevent path traversal (e.g. ```../../etc/passwd)
    // Language identifiers are alphanumeric: python, tsx, jsonc, etc.
    const sanitized = lang.replace(/[^a-zA-Z0-9]/g, '');
    if (sanitized && sanitized !== 'plaintext') {
      return `.${sanitized}`;
    }
  }
  return '.txt';
}
async function writeToFile(text: string, filename: string): Promise<string> {
  const filePath = join(COPY_DIR, filename);
  await mkdir(COPY_DIR, {
    recursive: true
  });
  await writeFile(filePath, text, 'utf-8');
  return filePath;
}
async function copyOrWriteToFile(text: string, filename: string): Promise<string> {
  const raw = await setClipboard(text);
  if (raw) process.stdout.write(raw);
  const lineCount = countCharInString(text, '\n') + 1;
  const charCount = text.length;
  // Also write to a temp file — clipboard paths are best-effort (OSC 52 needs
  // terminal support), so the file provides a reliable fallback.
  try {
    const filePath = await writeToFile(text, filename);
    return `Copied to clipboard (${charCount} characters, ${lineCount} lines)\nAlso written to ${filePath}`;
  } catch {
    return `Copied to clipboard (${charCount} characters, ${lineCount} lines)`;
  }
}
function truncateLine(text: string, maxLen: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  if (stringWidth(firstLine) <= maxLen) {
    return firstLine;
  }
  let result = '';
  let width = 0;
  const targetWidth = maxLen - 1;
  for (const char of firstLine) {
    const charWidth = stringWidth(char);
    if (width + charWidth > targetWidth) break;
    result += char;
    width += charWidth;
  }
  return result + '\u2026';
}
type PickerProps = {
  fullText: string;
  codeBlocks: CodeBlock[];
  messageAge: number;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type PickerSelection = number | 'full' | 'always';
function CopyPicker(t0) {
  const $ = _c(33);
  const {
    fullText,
    codeBlocks,
    messageAge,
    onDone
  } = t0;
  const focusedRef = useRef("full");
  const t1 = `${fullText.length} chars, ${countCharInString(fullText, "\n") + 1} lines`;
  let t2;
  if ($[0] !== t1) {
    t2 = {
      label: "Full response",
      value: "full" as const,
      description: t1
    };
    $[0] = t1;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  let t3;
  if ($[2] !== codeBlocks || $[3] !== t2) {
    let t4;
    if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = {
        label: "Always copy full response",
        value: "always" as const,
        description: "Skip this picker in the future (revert via /config)"
      };
      $[5] = t4;
    } else {
      t4 = $[5];
    }
    t3 = [t2, ...codeBlocks.map(_temp), t4];
    $[2] = codeBlocks;
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const options = t3;
  let t4;
  if ($[6] !== codeBlocks || $[7] !== fullText) {
    t4 = function getSelectionContent(selected) {
      if (selected === "full" || selected === "always") {
        return {
          text: fullText,
          filename: RESPONSE_FILENAME
        };
      }
      const block_0 = codeBlocks[selected];
      return {
        text: block_0.code,
        filename: `copy${fileExtension(block_0.lang)}`,
        blockIndex: selected
      };
    };
    $[6] = codeBlocks;
    $[7] = fullText;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const getSelectionContent = t4;
  let t5;
  if ($[9] !== codeBlocks.length || $[10] !== getSelectionContent || $[11] !== messageAge || $[12] !== onDone) {
    t5 = async function handleSelect(selected_0) {
      const content = getSelectionContent(selected_0);
      if (selected_0 === "always") {
        if (!getGlobalConfig().copyFullResponse) {
          saveGlobalConfig(_temp2);
        }
        logEvent("tengu_copy", {
          block_count: codeBlocks.length,
          always: true,
          message_age: messageAge
        });
        const result = await copyOrWriteToFile(content.text, content.filename);
        onDone(`${result}\nPreference saved. Use /config to change copyFullResponse`);
        return;
      }
      logEvent("tengu_copy", {
        selected_block: content.blockIndex,
        block_count: codeBlocks.length,
        message_age: messageAge
      });
      const result_0 = await copyOrWriteToFile(content.text, content.filename);
      onDone(result_0);
    };
    $[9] = codeBlocks.length;
    $[10] = getSelectionContent;
    $[11] = messageAge;
    $[12] = onDone;
    $[13] = t5;
  } else {
    t5 = $[13];
  }
  const handleSelect = t5;
  let t6;
  if ($[14] !== codeBlocks.length || $[15] !== getSelectionContent || $[16] !== messageAge || $[17] !== onDone) {
    const handleWrite = async function handleWrite(selected_1) {
      const content_0 = getSelectionContent(selected_1);
      logEvent("tengu_copy", {
        selected_block: content_0.blockIndex,
        block_count: codeBlocks.length,
        message_age: messageAge,
        write_shortcut: true
      });
      ;
      try {
        const filePath = await writeToFile(content_0.text, content_0.filename);
        onDone(`Written to ${filePath}`);
      } catch (t7) {
        const e = t7;
        onDone(`Failed to write file: ${e instanceof Error ? e.message : e}`);
      }
    };
    t6 = function handleKeyDown(e_0) {
      if (e_0.key === "w") {
        e_0.preventDefault();
        handleWrite(focusedRef.current);
      }
    };
    $[14] = codeBlocks.length;
    $[15] = getSelectionContent;
    $[16] = messageAge;
    $[17] = onDone;
    $[18] = t6;
  } else {
    t6 = $[18];
  }
  const handleKeyDown = t6;
  let t7;
  if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Text dimColor={true}>Select content to copy:</Text>;
    $[19] = t7;
  } else {
    t7 = $[19];
  }
  let t8;
  if ($[20] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = value => {
      focusedRef.current = value;
    };
    $[20] = t8;
  } else {
    t8 = $[20];
  }
  let t9;
  if ($[21] !== handleSelect) {
    t9 = selected_2 => {
      handleSelect(selected_2);
    };
    $[21] = handleSelect;
    $[22] = t9;
  } else {
    t9 = $[22];
  }
  let t10;
  if ($[23] !== onDone) {
    t10 = () => {
      onDone("Copy cancelled", {
        display: "system"
      });
    };
    $[23] = onDone;
    $[24] = t10;
  } else {
    t10 = $[24];
  }
  let t11;
  if ($[25] !== options || $[26] !== t10 || $[27] !== t9) {
    t11 = <Select options={options} hideIndexes={false} onFocus={t8} onChange={t9} onCancel={t10} />;
    $[25] = options;
    $[26] = t10;
    $[27] = t9;
    $[28] = t11;
  } else {
    t11 = $[28];
  }
  let t12;
  if ($[29] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = <Text dimColor={true}><Byline><KeyboardShortcutHint shortcut="enter" action="copy" /><KeyboardShortcutHint shortcut="w" action="write to file" /><KeyboardShortcutHint shortcut="esc" action="cancel" /></Byline></Text>;
    $[29] = t12;
  } else {
    t12 = $[29];
  }
  let t13;
  if ($[30] !== handleKeyDown || $[31] !== t11) {
    t13 = <Pane><Box flexDirection="column" gap={1} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{t7}{t11}{t12}</Box></Pane>;
    $[30] = handleKeyDown;
    $[31] = t11;
    $[32] = t13;
  } else {
    t13 = $[32];
  }
  return t13;
}
function _temp2(c) {
  return {
    ...c,
    copyFullResponse: true
  };
}
function _temp(block, index) {
  const blockLines = countCharInString(block.code, "\n") + 1;
  return {
    label: truncateLine(block.code, 60),
    value: index,
    description: [block.lang, blockLines > 1 ? `${blockLines} lines` : undefined].filter(Boolean).join(", ") || undefined
  };
}
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const texts = collectRecentAssistantTexts(context.messages);
  if (texts.length === 0) {
    onDone('No assistant message to copy');
    return null;
  }

  // /copy N reaches back N-1 messages (1 = latest, 2 = second-to-latest, ...)
  let age = 0;
  const arg = args?.trim();
  if (arg) {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) {
      onDone(`Usage: /copy [N] where N is 1 (latest), 2, 3, \u2026 Got: ${arg}`);
      return null;
    }
    if (n > texts.length) {
      onDone(`Only ${texts.length} assistant ${texts.length === 1 ? 'message' : 'messages'} available to copy`);
      return null;
    }
    age = n - 1;
  }
  const text = texts[age]!;
  const codeBlocks = extractCodeBlocks(text);
  const config = getGlobalConfig();
  if (codeBlocks.length === 0 || config.copyFullResponse) {
    logEvent('tengu_copy', {
      always: config.copyFullResponse,
      block_count: codeBlocks.length,
      message_age: age
    });
    const result = await copyOrWriteToFile(text, RESPONSE_FILENAME);
    onDone(result);
    return null;
  }
  return <CopyPicker fullText={text} codeBlocks={codeBlocks} messageAge={age} onDone={onDone} />;
};
