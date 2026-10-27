import { c as _c } from "react-compiler-runtime";
import sample from 'lodash-es/sample.js';
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { extractTag } from '../../utils/messages.js';
import { MessageResponse } from '../MessageResponse.js';
function getSavingMessage(): string {
  return sample(['Got it.', 'Good to know.', 'Noted.']);
}
type Props = {
  addMargin: boolean;
  text: string;
};
export function UserMemoryInputMessage(t0) {
  const $ = _c(10);
  const {
    text,
    addMargin
  } = t0;
  let t1;
  if ($[0] !== text) {
    t1 = extractTag(text, "user-memory-input");
    $[0] = text;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const input = t1;
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = getSavingMessage();
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const savingText = t2;
  if (!input) {
    return null;
  }
  const t3 = addMargin ? 1 : 0;
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text color="remember" backgroundColor="memoryBackgroundColor">#</Text>;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  let t5;
  if ($[4] !== input) {
    t5 = <Box>{t4}<Text backgroundColor="memoryBackgroundColor" color="text">{" "}{input}{" "}</Text></Box>;
    $[4] = input;
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  let t6;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <MessageResponse height={1}><Text dimColor={true}>{savingText}</Text></MessageResponse>;
    $[6] = t6;
  } else {
    t6 = $[6];
  }
  let t7;
  if ($[7] !== t3 || $[8] !== t5) {
    t7 = <Box flexDirection="column" marginTop={t3} width="100%">{t5}{t6}</Box>;
    $[7] = t3;
    $[8] = t5;
    $[9] = t7;
  } else {
    t7 = $[9];
  }
  return t7;
}
