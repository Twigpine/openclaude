import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, Text } from '../../ink.js';
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js';
export type TranscriptShareResponse = 'yes' | 'no' | 'dont_ask_again';
type Props = {
  onSelect: (option: TranscriptShareResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
};
const RESPONSE_INPUTS = ['1', '2', '3'] as const;
type ResponseInput = (typeof RESPONSE_INPUTS)[number];
const inputToResponse: Record<ResponseInput, TranscriptShareResponse> = {
  '1': 'yes',
  '2': 'no',
  '3': 'dont_ask_again'
} as const;
const isValidResponseInput = (input: string): input is ResponseInput => (RESPONSE_INPUTS as readonly string[]).includes(input);
export function TranscriptSharePrompt(t0) {
  const $ = _c(11);
  const {
    onSelect,
    inputValue,
    setInputValue
  } = t0;
  let t1;
  if ($[0] !== onSelect) {
    t1 = digit => onSelect(inputToResponse[digit]);
    $[0] = onSelect;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== inputValue || $[3] !== setInputValue || $[4] !== t1) {
    t2 = {
      inputValue,
      setInputValue,
      isValidDigit: isValidResponseInput,
      onDigit: t1
    };
    $[2] = inputValue;
    $[3] = setInputValue;
    $[4] = t1;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  useDebouncedDigitInput(t2);
  let t3;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box><Text color="ansi:cyan">{BLACK_CIRCLE} </Text><Text bold={true}>Can Anthropic look at your session transcript to help us improve Claude Code?</Text></Box>;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Box marginLeft={2}><Text dimColor={true}>Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys</Text></Box>;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Box width={10}><Text><Text color="ansi:cyan">1</Text>: Yes</Text></Box>;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Box width={10}><Text><Text color="ansi:cyan">2</Text>: No</Text></Box>;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  let t7;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Box flexDirection="column" marginTop={1}>{t3}{t4}<Box marginLeft={2}>{t5}{t6}<Box><Text><Text color="ansi:cyan">3</Text>: Don&apos;t ask again</Text></Box></Box></Box>;
    $[10] = t7;
  } else {
    t7 = $[10];
  }
  return t7;
}
