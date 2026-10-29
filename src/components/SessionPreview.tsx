import { c as _c } from "react-compiler-runtime";
import type { UUID } from 'crypto';
import React from 'react';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getAllBaseTools } from '../tools.js';
import type { LogOption } from '../types/logs.js';
import { formatRelativeTimeAgo } from '../utils/format.js';
import { getSessionIdFromLog, isLiteLog, loadFullLog } from '../utils/sessionStorage.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { LoadingState } from './design-system/LoadingState.js';
import { Messages } from './Messages.js';
type Props = {
  log: LogOption;
  onExit: () => void;
  onSelect: (log: LogOption) => void;
};
export function SessionPreview(t0) {
  const $ = _c(33);
  const {
    log,
    onExit,
    onSelect
  } = t0;
  const [fullLog, setFullLog] = React.useState<LogOption | null>(null);
  let t1;
  let t2;
  if ($[0] !== log) {
    t1 = () => {
      setFullLog(null);
      if (isLiteLog(log)) {
        loadFullLog(log).then(setFullLog);
      }
    };
    t2 = [log];
    $[0] = log;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  React.useEffect(t1, t2);
  const isLoading = isLiteLog(log) && fullLog === null;
  const displayLog = fullLog ?? log;
  let t3;
  if ($[3] !== displayLog) {
    t3 = getSessionIdFromLog(displayLog) || "" as UUID;
    $[3] = displayLog;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const conversationId = t3;
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = getAllBaseTools();
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  const tools = t4;
  let t5;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      context: "Confirmation"
    };
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  useKeybinding("confirm:no", onExit, t5);
  let t6;
  if ($[7] !== fullLog || $[8] !== log || $[9] !== onSelect) {
    t6 = () => {
      onSelect(fullLog ?? log);
    };
    $[7] = fullLog;
    $[8] = log;
    $[9] = onSelect;
    $[10] = t6;
  } else {
    t6 = $[10];
  }
  const handleSelect = t6;
  let t7;
  if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = {
      context: "Confirmation"
    };
    $[11] = t7;
  } else {
    t7 = $[11];
  }
  useKeybinding("confirm:yes", handleSelect, t7);
  if (isLoading) {
    let t8;
    if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
      t8 = <LoadingState message={"Loading session\u2026"} />;
      $[12] = t8;
    } else {
      t8 = $[12];
    }
    let t9;
    if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
      t9 = <Box flexDirection="column" padding={1}>{t8}<Text dimColor={true}><Byline><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text></Box>;
      $[13] = t9;
    } else {
      t9 = $[13];
    }
    return t9;
  }
  let t8;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = [];
    $[14] = t8;
  } else {
    t8 = $[14];
  }
  let t10;
  let t9;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t9 = [];
    t10 = new Set();
    $[15] = t10;
    $[16] = t9;
  } else {
    t10 = $[15];
    t9 = $[16];
  }
  let t11;
  if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = [];
    $[17] = t11;
  } else {
    t11 = $[17];
  }
  let t12;
  if ($[18] !== conversationId || $[19] !== displayLog.messages) {
    t12 = <Messages messages={displayLog.messages} tools={tools} commands={t8} verbose={true} toolJSX={null} toolUseConfirmQueue={t9} inProgressToolUseIDs={t10} isMessageSelectorVisible={false} conversationId={conversationId} screen="transcript" streamingToolUses={t11} showAllInTranscript={true} isLoading={false} />;
    $[18] = conversationId;
    $[19] = displayLog.messages;
    $[20] = t12;
  } else {
    t12 = $[20];
  }
  let t13;
  if ($[21] !== displayLog.modified) {
    t13 = formatRelativeTimeAgo(displayLog.modified);
    $[21] = displayLog.modified;
    $[22] = t13;
  } else {
    t13 = $[22];
  }
  const t14 = displayLog.gitBranch ? ` · ${displayLog.gitBranch}` : "";
  let t15;
  if ($[23] !== displayLog.messageCount || $[24] !== t13 || $[25] !== t14) {
    t15 = <Text>{t13} ·{" "}{displayLog.messageCount} messages{t14}</Text>;
    $[23] = displayLog.messageCount;
    $[24] = t13;
    $[25] = t14;
    $[26] = t15;
  } else {
    t15 = $[26];
  }
  let t16;
  if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
    t16 = <Text dimColor={true}><Byline><KeyboardShortcutHint shortcut="Enter" action="resume" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text>;
    $[27] = t16;
  } else {
    t16 = $[27];
  }
  let t17;
  if ($[28] !== t15) {
    t17 = <Box flexShrink={0} flexDirection="column" borderTopDimColor={true} borderBottom={false} borderLeft={false} borderRight={false} borderStyle="single" paddingLeft={2}>{t15}{t16}</Box>;
    $[28] = t15;
    $[29] = t17;
  } else {
    t17 = $[29];
  }
  let t18;
  if ($[30] !== t12 || $[31] !== t17) {
    t18 = <Box flexDirection="column">{t12}{t17}</Box>;
    $[30] = t12;
    $[31] = t17;
    $[32] = t18;
  } else {
    t18 = $[32];
  }
  return t18;
}
