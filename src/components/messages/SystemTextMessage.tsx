import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Box, Text, type TextProps } from '../../ink.js';
import { feature } from 'bun:bundle';
import * as React from 'react';
import { useState } from 'react';
import sample from 'lodash-es/sample.js';
import { BLACK_CIRCLE, REFERENCE_MARK, TEARDROP_ASTERISK } from '../../constants/figures.js';
import figures from 'figures';
import { basename } from 'path';
import { MessageResponse } from '../MessageResponse.js';
import { FilePathLink } from '../FilePathLink.js';
import { openPath } from '../../utils/browser.js';
/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemSaved = feature('TEAMMEM') ? require('./teamMemSaved.js') as typeof import('./teamMemSaved.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { SystemMessage, SystemStopHookSummaryMessage, SystemBridgeStatusMessage, SystemTurnDurationMessage, SystemThinkingMessage, SystemMemorySavedMessage } from '../../types/message.js';
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js';
import { formatDuration, formatNumber, formatSecondsShort } from '../../utils/format.js';
import { getGlobalConfig } from '../../utils/config.js';
import Link from '../../ink/components/Link.js';
import ThemedText from '../design-system/ThemedText.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { useAppStateStore } from '../../state/AppState.js';
import { isBackgroundTask, type TaskState } from '../../tasks/types.js';
import { getPillLabel } from '../../tasks/pillLabel.js';
import { useSelectedMessageBg } from '../messageActions.js';
// Hooks faster than this render no timing line (display gate only — currently
// short-circuited by the `true ||` below, matching upstream).
const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 1000;
type Props = {
  message: SystemMessage;
  addMargin: boolean;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function SystemTextMessage(t0) {
  const $ = _c(51);
  const {
    message,
    addMargin,
    verbose,
    isTranscriptMode
  } = t0;
  const bg = useSelectedMessageBg();
  if (message.subtype === "turn_duration") {
    let t1;
    if ($[0] !== addMargin || $[1] !== message) {
      t1 = <TurnDurationMessage message={message} addMargin={addMargin} />;
      $[0] = addMargin;
      $[1] = message;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  if (message.subtype === "memory_saved") {
    let t1;
    if ($[3] !== addMargin || $[4] !== message) {
      t1 = <MemorySavedMessage message={message} addMargin={addMargin} />;
      $[3] = addMargin;
      $[4] = message;
      $[5] = t1;
    } else {
      t1 = $[5];
    }
    return t1;
  }
  if (message.subtype === "away_summary") {
    const t1 = addMargin ? 1 : 0;
    let t2;
    if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Box minWidth={2}><Text dimColor={true}>{REFERENCE_MARK}</Text></Box>;
      $[6] = t2;
    } else {
      t2 = $[6];
    }
    let t3;
    if ($[7] !== message.content) {
      t3 = <Text dimColor={true}>{message.content}</Text>;
      $[7] = message.content;
      $[8] = t3;
    } else {
      t3 = $[8];
    }
    let t4;
    if ($[9] !== bg || $[10] !== t1 || $[11] !== t3) {
      t4 = <Box flexDirection="row" marginTop={t1} backgroundColor={bg} width="100%">{t2}{t3}</Box>;
      $[9] = bg;
      $[10] = t1;
      $[11] = t3;
      $[12] = t4;
    } else {
      t4 = $[12];
    }
    return t4;
  }
  if (message.subtype === "agents_killed") {
    const t1 = addMargin ? 1 : 0;
    let t2;
    let t3;
    if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Box minWidth={2}><Text color="error">{BLACK_CIRCLE}</Text></Box>;
      t3 = <Text dimColor={true}>All background agents stopped</Text>;
      $[13] = t2;
      $[14] = t3;
    } else {
      t2 = $[13];
      t3 = $[14];
    }
    let t4;
    if ($[15] !== bg || $[16] !== t1) {
      t4 = <Box flexDirection="row" marginTop={t1} backgroundColor={bg} width="100%">{t2}{t3}</Box>;
      $[15] = bg;
      $[16] = t1;
      $[17] = t4;
    } else {
      t4 = $[17];
    }
    return t4;
  }
  if (message.subtype === "thinking") {
    return null;
  }
  if (message.subtype === "bridge_status") {
    let t1;
    if ($[18] !== addMargin || $[19] !== message) {
      t1 = <BridgeStatusMessage message={message} addMargin={addMargin} />;
      $[18] = addMargin;
      $[19] = message;
      $[20] = t1;
    } else {
      t1 = $[20];
    }
    return t1;
  }
  if (message.subtype === "scheduled_task_fire") {
    const t1 = addMargin ? 1 : 0;
    let t2;
    if ($[21] !== message.content) {
      t2 = <Text dimColor={true}>{TEARDROP_ASTERISK} {message.content}</Text>;
      $[21] = message.content;
      $[22] = t2;
    } else {
      t2 = $[22];
    }
    let t3;
    if ($[23] !== bg || $[24] !== t1 || $[25] !== t2) {
      t3 = <Box marginTop={t1} backgroundColor={bg} width="100%">{t2}</Box>;
      $[23] = bg;
      $[24] = t1;
      $[25] = t2;
      $[26] = t3;
    } else {
      t3 = $[26];
    }
    return t3;
  }
  if (message.subtype === "permission_retry") {
    const t1 = addMargin ? 1 : 0;
    let t2;
    let t3;
    if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Text dimColor={true}>{TEARDROP_ASTERISK} </Text>;
      t3 = <Text>Allowed </Text>;
      $[27] = t2;
      $[28] = t3;
    } else {
      t2 = $[27];
      t3 = $[28];
    }
    let t4;
    if ($[29] !== message.commands) {
      t4 = message.commands.join(", ");
      $[29] = message.commands;
      $[30] = t4;
    } else {
      t4 = $[30];
    }
    let t5;
    if ($[31] !== t4) {
      t5 = <Text bold={true}>{t4}</Text>;
      $[31] = t4;
      $[32] = t5;
    } else {
      t5 = $[32];
    }
    let t6;
    if ($[33] !== bg || $[34] !== t1 || $[35] !== t5) {
      t6 = <Box marginTop={t1} backgroundColor={bg} width="100%">{t2}{t3}{t5}</Box>;
      $[33] = bg;
      $[34] = t1;
      $[35] = t5;
      $[36] = t6;
    } else {
      t6 = $[36];
    }
    return t6;
  }
  const isStopHookSummary = message.subtype === "stop_hook_summary";
  if (!isStopHookSummary && !verbose && message.level === "info") {
    return null;
  }
  if (message.subtype === "api_error") {
    let t1;
    if ($[37] !== message || $[38] !== verbose) {
      t1 = <SystemAPIErrorMessage message={message} verbose={verbose} />;
      $[37] = message;
      $[38] = verbose;
      $[39] = t1;
    } else {
      t1 = $[39];
    }
    return t1;
  }
  if (message.subtype === "stop_hook_summary") {
    let t1;
    if ($[40] !== addMargin || $[41] !== isTranscriptMode || $[42] !== message || $[43] !== verbose) {
      t1 = <StopHookSummaryMessage message={message} addMargin={addMargin} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
      $[40] = addMargin;
      $[41] = isTranscriptMode;
      $[42] = message;
      $[43] = verbose;
      $[44] = t1;
    } else {
      t1 = $[44];
    }
    return t1;
  }
  const content = message.content;
  if (typeof content !== "string") {
    return null;
  }
  const t1 = message.level !== "info";
  const t2 = message.level === "warning" ? "warning" : undefined;
  const t3 = message.level === "info";
  let t4;
  if ($[45] !== addMargin || $[46] !== content || $[47] !== t1 || $[48] !== t2 || $[49] !== t3) {
    t4 = <Box flexDirection="row" width="100%"><SystemTextMessageInner content={content} addMargin={addMargin} dot={t1} color={t2} dimColor={t3} /></Box>;
    $[45] = addMargin;
    $[46] = content;
    $[47] = t1;
    $[48] = t2;
    $[49] = t3;
    $[50] = t4;
  } else {
    t4 = $[50];
  }
  return t4;
}
function StopHookSummaryMessage(t0) {
  const $ = _c(47);
  const {
    message,
    addMargin,
    verbose,
    isTranscriptMode
  } = t0;
  const bg = useSelectedMessageBg();
  const {
    hookCount,
    hookInfos,
    hookErrors,
    preventedContinuation,
    stopReason
  } = message;
  const {
    columns
  } = useTerminalSize();
  let t1;
  if ($[0] !== hookInfos || $[1] !== message.totalDurationMs) {
    t1 = message.totalDurationMs ?? hookInfos.reduce(_temp, 0);
    $[0] = hookInfos;
    $[1] = message.totalDurationMs;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const totalDurationMs = t1;
  if (hookErrors.length === 0 && !preventedContinuation && !message.hookLabel) {
    if (true || totalDurationMs < HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
      return null;
    }
  }
  let t2;
  if ($[3] !== totalDurationMs) {
    t2 = false && totalDurationMs > 0 ? ` (${formatSecondsShort(totalDurationMs)})` : "";
    $[3] = totalDurationMs;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const totalStr = t2;
  if (message.hookLabel) {
    const t3 = hookCount === 1 ? "hook" : "hooks";
    let t4;
    if ($[5] !== hookCount || $[6] !== message.hookLabel || $[7] !== t3 || $[8] !== totalStr) {
      t4 = <Text dimColor={true}>{"  \u2514  "}Ran {hookCount} {message.hookLabel}{" "}{t3}{totalStr}</Text>;
      $[5] = hookCount;
      $[6] = message.hookLabel;
      $[7] = t3;
      $[8] = totalStr;
      $[9] = t4;
    } else {
      t4 = $[9];
    }
    let t5;
    if ($[10] !== hookInfos || $[11] !== isTranscriptMode) {
      t5 = isTranscriptMode && hookInfos.map(_temp2);
      $[10] = hookInfos;
      $[11] = isTranscriptMode;
      $[12] = t5;
    } else {
      t5 = $[12];
    }
    let t6;
    if ($[13] !== t4 || $[14] !== t5) {
      t6 = <Box flexDirection="column" width="100%">{t4}{t5}</Box>;
      $[13] = t4;
      $[14] = t5;
      $[15] = t6;
    } else {
      t6 = $[15];
    }
    return t6;
  }
  const t3 = addMargin ? 1 : 0;
  let t4;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Box minWidth={2}><Text>{BLACK_CIRCLE}</Text></Box>;
    $[16] = t4;
  } else {
    t4 = $[16];
  }
  const t5 = columns - 10;
  let t6;
  if ($[17] !== hookCount) {
    t6 = <Text bold={true}>{hookCount}</Text>;
    $[17] = hookCount;
    $[18] = t6;
  } else {
    t6 = $[18];
  }
  const t7 = message.hookLabel ?? "stop";
  const t8 = hookCount === 1 ? "hook" : "hooks";
  let t9;
  if ($[19] !== hookInfos || $[20] !== verbose) {
    t9 = !verbose && hookInfos.length > 0 && <>{" "}<CtrlOToExpand /></>;
    $[19] = hookInfos;
    $[20] = verbose;
    $[21] = t9;
  } else {
    t9 = $[21];
  }
  let t10;
  if ($[22] !== t6 || $[23] !== t7 || $[24] !== t8 || $[25] !== t9 || $[26] !== totalStr) {
    t10 = <Text>Ran {t6} {t7}{" "}{t8}{totalStr}{t9}</Text>;
    $[22] = t6;
    $[23] = t7;
    $[24] = t8;
    $[25] = t9;
    $[26] = totalStr;
    $[27] = t10;
  } else {
    t10 = $[27];
  }
  let t11;
  if ($[28] !== hookInfos || $[29] !== verbose) {
    t11 = verbose && hookInfos.length > 0 && hookInfos.map(_temp3);
    $[28] = hookInfos;
    $[29] = verbose;
    $[30] = t11;
  } else {
    t11 = $[30];
  }
  let t12;
  if ($[31] !== preventedContinuation || $[32] !== stopReason) {
    t12 = preventedContinuation && stopReason && <Text><Text dimColor={true}>└  </Text>{stopReason}</Text>;
    $[31] = preventedContinuation;
    $[32] = stopReason;
    $[33] = t12;
  } else {
    t12 = $[33];
  }
  let t13;
  if ($[34] !== hookErrors || $[35] !== message.hookLabel) {
    t13 = hookErrors.length > 0 && hookErrors.map((err, idx_1) => <Text key={idx_1}><Text dimColor={true}>└  </Text>{message.hookLabel ?? "Stop"} hook error: {err}</Text>);
    $[34] = hookErrors;
    $[35] = message.hookLabel;
    $[36] = t13;
  } else {
    t13 = $[36];
  }
  let t14;
  if ($[37] !== t10 || $[38] !== t11 || $[39] !== t12 || $[40] !== t13 || $[41] !== t5) {
    t14 = <Box flexDirection="column" width={t5}>{t10}{t11}{t12}{t13}</Box>;
    $[37] = t10;
    $[38] = t11;
    $[39] = t12;
    $[40] = t13;
    $[41] = t5;
    $[42] = t14;
  } else {
    t14 = $[42];
  }
  let t15;
  if ($[43] !== bg || $[44] !== t14 || $[45] !== t3) {
    t15 = <Box flexDirection="row" marginTop={t3} backgroundColor={bg} width="100%">{t4}{t14}</Box>;
    $[43] = bg;
    $[44] = t14;
    $[45] = t3;
    $[46] = t15;
  } else {
    t15 = $[46];
  }
  return t15;
}
function _temp3(info_0, idx_0) {
  const durationStr_0 = false && info_0.durationMs !== undefined ? ` (${formatSecondsShort(info_0.durationMs)})` : "";
  return <Text key={`cmd-${idx_0}`} dimColor={true}>└  {info_0.command === "prompt" ? `prompt: ${info_0.promptText || ""}` : info_0.command}{durationStr_0}</Text>;
}
function _temp2(info, idx) {
  const durationStr = false && info.durationMs !== undefined ? ` (${formatSecondsShort(info.durationMs)})` : "";
  return <Text key={`cmd-${idx}`} dimColor={true}>{"     \u2514 "}{info.command === "prompt" ? `prompt: ${info.promptText || ""}` : info.command}{durationStr}</Text>;
}
function _temp(sum, h) {
  return sum + (h.durationMs ?? 0);
}
function SystemTextMessageInner(t0) {
  const $ = _c(18);
  const {
    content,
    addMargin,
    dot,
    color,
    dimColor
  } = t0;
  const {
    columns
  } = useTerminalSize();
  const bg = useSelectedMessageBg();
  const t1 = addMargin ? 1 : 0;
  let t2;
  if ($[0] !== color || $[1] !== dimColor || $[2] !== dot) {
    t2 = dot && <Box minWidth={2}><Text color={color} dimColor={dimColor}>{BLACK_CIRCLE}</Text></Box>;
    $[0] = color;
    $[1] = dimColor;
    $[2] = dot;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const t3 = columns - 10;
  let t4;
  if ($[4] !== content) {
    t4 = content.trim();
    $[4] = content;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] !== color || $[7] !== dimColor || $[8] !== t4) {
    t5 = <Text color={color} dimColor={dimColor} wrap="wrap">{t4}</Text>;
    $[6] = color;
    $[7] = dimColor;
    $[8] = t4;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  let t6;
  if ($[10] !== t3 || $[11] !== t5) {
    t6 = <Box flexDirection="column" width={t3}>{t5}</Box>;
    $[10] = t3;
    $[11] = t5;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  let t7;
  if ($[13] !== bg || $[14] !== t1 || $[15] !== t2 || $[16] !== t6) {
    t7 = <Box flexDirection="row" marginTop={t1} backgroundColor={bg} width="100%">{t2}{t6}</Box>;
    $[13] = bg;
    $[14] = t1;
    $[15] = t2;
    $[16] = t6;
    $[17] = t7;
  } else {
    t7 = $[17];
  }
  return t7;
}
function TurnDurationMessage(t0) {
  const $ = _c(17);
  const {
    message,
    addMargin
  } = t0;
  const bg = useSelectedMessageBg();
  const [verb] = useState(_temp4);
  const store = useAppStateStore();
  let t1;
  if ($[0] !== store) {
    t1 = () => {
      const tasks = store.getState().tasks;
      const running = (Object.values(tasks ?? {}) as TaskState[]).filter(isBackgroundTask);
      return running.length > 0 ? getPillLabel(running) : null;
    };
    $[0] = store;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const [backgroundTaskSummary] = useState(t1);
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = getGlobalConfig().showTurnDuration ?? true;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const showTurnDuration = t2;
  let t3;
  if ($[3] !== message.durationMs) {
    t3 = formatDuration(message.durationMs);
    $[3] = message.durationMs;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const duration = t3;
  const hasBudget = message.budgetLimit !== undefined;
  let t4;
  bb0: {
    if (!hasBudget) {
      t4 = "";
      break bb0;
    }
    const tokens = message.budgetTokens;
    const limit = message.budgetLimit;
    let t5;
    if ($[5] !== limit || $[6] !== tokens) {
      t5 = tokens >= limit ? `${formatNumber(tokens)} used (${formatNumber(limit)} min ${figures.tick})` : `${formatNumber(tokens)} / ${formatNumber(limit)} (${Math.round(tokens / limit * 100)}%)`;
      $[5] = limit;
      $[6] = tokens;
      $[7] = t5;
    } else {
      t5 = $[7];
    }
    const usage = t5;
    const nudges = message.budgetNudges > 0 ? ` \u00B7 ${message.budgetNudges} ${message.budgetNudges === 1 ? "nudge" : "nudges"}` : "";
    t4 = `${showTurnDuration ? " \xB7 " : ""}${usage}${nudges}`;
  }
  const budgetSuffix = t4;
  if (!showTurnDuration && !hasBudget) {
    return null;
  }
  const t5 = addMargin ? 1 : 0;
  let t6;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Box minWidth={2}><Text dimColor={true}>{TEARDROP_ASTERISK}</Text></Box>;
    $[8] = t6;
  } else {
    t6 = $[8];
  }
  const t7 = showTurnDuration && `${verb} for ${duration}`;
  const t8 = backgroundTaskSummary && ` \u00B7 ${backgroundTaskSummary} still running`;
  let t9;
  if ($[9] !== budgetSuffix || $[10] !== t7 || $[11] !== t8) {
    t9 = <Text dimColor={true}>{t7}{budgetSuffix}{t8}</Text>;
    $[9] = budgetSuffix;
    $[10] = t7;
    $[11] = t8;
    $[12] = t9;
  } else {
    t9 = $[12];
  }
  let t10;
  if ($[13] !== bg || $[14] !== t5 || $[15] !== t9) {
    t10 = <Box flexDirection="row" marginTop={t5} backgroundColor={bg} width="100%">{t6}{t9}</Box>;
    $[13] = bg;
    $[14] = t5;
    $[15] = t9;
    $[16] = t10;
  } else {
    t10 = $[16];
  }
  return t10;
}
function _temp4() {
  return sample(TURN_COMPLETION_VERBS) ?? "Worked";
}
function MemorySavedMessage(t0) {
  const $ = _c(16);
  const {
    message,
    addMargin
  } = t0;
  const bg = useSelectedMessageBg();
  const {
    writtenPaths
  } = message;
  let t1;
  if ($[0] !== message) {
    t1 = feature("TEAMMEM") && teamMemSaved != null ? teamMemSaved.teamMemSavedPart(message) : null;
    $[0] = message;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const team = t1;
  const privateCount = writtenPaths.length - (team?.count ?? 0);
  const t2 = privateCount > 0 ? `${privateCount} ${privateCount === 1 ? "memory" : "memories"}` : null;
  const t3 = team?.segment;
  let t4;
  if ($[2] !== t2 || $[3] !== t3) {
    t4 = [t2, t3].filter(Boolean);
    $[2] = t2;
    $[3] = t3;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  const parts = t4;
  const t5 = addMargin ? 1 : 0;
  let t6;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Box minWidth={2}><Text dimColor={true}>{BLACK_CIRCLE}</Text></Box>;
    $[5] = t6;
  } else {
    t6 = $[5];
  }
  const t7 = message.verb ?? "Saved";
  const t8 = parts.join(" \xB7 ");
  let t9;
  if ($[6] !== t7 || $[7] !== t8) {
    t9 = <Box flexDirection="row">{t6}<Text>{t7} {t8}</Text></Box>;
    $[6] = t7;
    $[7] = t8;
    $[8] = t9;
  } else {
    t9 = $[8];
  }
  let t10;
  if ($[9] !== writtenPaths) {
    t10 = writtenPaths.map(_temp5);
    $[9] = writtenPaths;
    $[10] = t10;
  } else {
    t10 = $[10];
  }
  let t11;
  if ($[11] !== bg || $[12] !== t10 || $[13] !== t5 || $[14] !== t9) {
    t11 = <Box flexDirection="column" marginTop={t5} backgroundColor={bg}>{t9}{t10}</Box>;
    $[11] = bg;
    $[12] = t10;
    $[13] = t5;
    $[14] = t9;
    $[15] = t11;
  } else {
    t11 = $[15];
  }
  return t11;
}
function _temp5(p) {
  return <MemoryFileRow key={p} path={p} />;
}
function MemoryFileRow(t0) {
  const $ = _c(16);
  const {
    path
  } = t0;
  const [hover, setHover] = useState(false);
  let t1;
  if ($[0] !== path) {
    t1 = () => void openPath(path);
    $[0] = path;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  let t3;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => setHover(true);
    t3 = () => setHover(false);
    $[2] = t2;
    $[3] = t3;
  } else {
    t2 = $[2];
    t3 = $[3];
  }
  const t4 = !hover;
  let t5;
  if ($[4] !== path) {
    t5 = basename(path);
    $[4] = path;
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  let t6;
  if ($[6] !== path || $[7] !== t5) {
    t6 = <FilePathLink filePath={path}>{t5}</FilePathLink>;
    $[6] = path;
    $[7] = t5;
    $[8] = t6;
  } else {
    t6 = $[8];
  }
  let t7;
  if ($[9] !== hover || $[10] !== t4 || $[11] !== t6) {
    t7 = <Text dimColor={t4} underline={hover}>{t6}</Text>;
    $[9] = hover;
    $[10] = t4;
    $[11] = t6;
    $[12] = t7;
  } else {
    t7 = $[12];
  }
  let t8;
  if ($[13] !== t1 || $[14] !== t7) {
    t8 = <MessageResponse><Box onClick={t1} onMouseEnter={t2} onMouseLeave={t3}>{t7}</Box></MessageResponse>;
    $[13] = t1;
    $[14] = t7;
    $[15] = t8;
  } else {
    t8 = $[15];
  }
  return t8;
}
function BridgeStatusMessage(t0) {
  const $ = _c(13);
  const {
    message,
    addMargin
  } = t0;
  const bg = useSelectedMessageBg();
  const t1 = addMargin ? 1 : 0;
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Box minWidth={2} />;
    $[0] = t2;
  } else {
    t2 = $[0];
  }
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text><ThemedText color="suggestion">/remote-control</ThemedText> is active. Code in CLI or at</Text>;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  let t4;
  if ($[2] !== message.url) {
    t4 = <Link url={message.url}>{message.url}</Link>;
    $[2] = message.url;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  let t5;
  if ($[4] !== message.upgradeNudge) {
    t5 = message.upgradeNudge && <Text dimColor={true}>└ {message.upgradeNudge}</Text>;
    $[4] = message.upgradeNudge;
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  let t6;
  if ($[6] !== t4 || $[7] !== t5) {
    t6 = <Box flexDirection="column">{t3}{t4}{t5}</Box>;
    $[6] = t4;
    $[7] = t5;
    $[8] = t6;
  } else {
    t6 = $[8];
  }
  let t7;
  if ($[9] !== bg || $[10] !== t1 || $[11] !== t6) {
    t7 = <Box flexDirection="row" marginTop={t1} backgroundColor={bg} width={999}>{t2}{t6}</Box>;
    $[9] = bg;
    $[10] = t1;
    $[11] = t6;
    $[12] = t7;
  } else {
    t7 = $[12];
  }
  return t7;
}
