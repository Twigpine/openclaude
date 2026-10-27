import { c as _c } from "react-compiler-runtime";
import React from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text, useTheme } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { getEmptyToolPermissionContext } from '../../Tool.js';
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { getTools } from '../../tools.js';
import { formatNumber } from '../../utils/format.js';
import { extractTag } from '../../utils/messages.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { UserPlanMessage } from '../messages/UserPlanMessage.js';
import { renderToolActivity } from './renderToolActivity.js';
import { getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js';
type Props = {
  agent: DeepImmutable<LocalAgentTaskState>;
  onDone: () => void;
  onKillAgent?: () => void;
  onBack?: () => void;
};
export function AsyncAgentDetailDialog(t0) {
  const $ = _c(54);
  const {
    agent,
    onDone,
    onKillAgent,
    onBack
  } = t0;
  const [theme] = useTheme();
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getTools(getEmptyToolPermissionContext());
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const tools = t1;
  const elapsedTime = useElapsedTime(agent.startTime, agent.status === "running", 1000, agent.totalPausedMs ?? 0);
  let t2;
  if ($[1] !== onDone) {
    t2 = {
      "confirm:yes": onDone
    };
    $[1] = onDone;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = {
      context: "Confirmation"
    };
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  useKeybindings(t2, t3);
  let t4;
  if ($[4] !== agent.status || $[5] !== onBack || $[6] !== onDone || $[7] !== onKillAgent) {
    t4 = e => {
      if (e.key === " ") {
        e.preventDefault();
        onDone();
      } else {
        if (e.key === "left" && onBack) {
          e.preventDefault();
          onBack();
        } else {
          if (e.key === "x" && agent.status === "running" && onKillAgent) {
            e.preventDefault();
            onKillAgent();
          }
        }
      }
    };
    $[4] = agent.status;
    $[5] = onBack;
    $[6] = onDone;
    $[7] = onKillAgent;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const handleKeyDown = t4;
  let t5;
  if ($[9] !== agent.prompt) {
    t5 = extractTag(agent.prompt, "plan");
    $[9] = agent.prompt;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  const planContent = t5;
  const displayPrompt = agent.prompt.length > 300 ? agent.prompt.substring(0, 297) + "\u2026" : agent.prompt;
  const tokenCount = agent.result?.totalTokens ?? agent.progress?.tokenCount;
  const toolUseCount = agent.result?.totalToolUseCount ?? agent.progress?.toolUseCount;
  const t6 = agent.selectedAgent?.agentType ?? "agent";
  const t7 = agent.description || "Async agent";
  let t8;
  if ($[11] !== t6 || $[12] !== t7) {
    t8 = <Text>{t6} ›{" "}{t7}</Text>;
    $[11] = t6;
    $[12] = t7;
    $[13] = t8;
  } else {
    t8 = $[13];
  }
  const title = t8;
  let t9;
  if ($[14] !== agent.status) {
    t9 = agent.status !== "running" && <Text color={getTaskStatusColor(agent.status)}>{getTaskStatusIcon(agent.status)}{" "}{agent.status === "completed" ? "Completed" : agent.status === "failed" ? "Failed" : "Stopped"}{" \xB7 "}</Text>;
    $[14] = agent.status;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  let t10;
  if ($[16] !== tokenCount) {
    t10 = tokenCount !== undefined && tokenCount > 0 && <> · {formatNumber(tokenCount)} tokens</>;
    $[16] = tokenCount;
    $[17] = t10;
  } else {
    t10 = $[17];
  }
  let t11;
  if ($[18] !== toolUseCount) {
    t11 = toolUseCount !== undefined && toolUseCount > 0 && <>{" "}· {toolUseCount} {toolUseCount === 1 ? "tool" : "tools"}</>;
    $[18] = toolUseCount;
    $[19] = t11;
  } else {
    t11 = $[19];
  }
  let t12;
  if ($[20] !== elapsedTime || $[21] !== t10 || $[22] !== t11) {
    t12 = <Text dimColor={true}>{elapsedTime}{t10}{t11}</Text>;
    $[20] = elapsedTime;
    $[21] = t10;
    $[22] = t11;
    $[23] = t12;
  } else {
    t12 = $[23];
  }
  let t13;
  if ($[24] !== t12 || $[25] !== t9) {
    t13 = <Text>{t9}{t12}</Text>;
    $[24] = t12;
    $[25] = t9;
    $[26] = t13;
  } else {
    t13 = $[26];
  }
  const subtitle = t13;
  let t14;
  if ($[27] !== agent.status || $[28] !== onBack || $[29] !== onKillAgent) {
    t14 = exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline>{onBack && <KeyboardShortcutHint shortcut={"\u2190"} action="go back" />}<KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />{agent.status === "running" && onKillAgent && <KeyboardShortcutHint shortcut="x" action="stop" />}</Byline>;
    $[27] = agent.status;
    $[28] = onBack;
    $[29] = onKillAgent;
    $[30] = t14;
  } else {
    t14 = $[30];
  }
  let t15;
  if ($[31] !== agent.progress || $[32] !== agent.status || $[33] !== theme) {
    t15 = agent.status === "running" && agent.progress?.recentActivities && agent.progress.recentActivities.length > 0 && <Box flexDirection="column"><Text bold={true} dimColor={true}>Progress</Text>{agent.progress.recentActivities.map((activity, i) => <Text key={i} dimColor={i < agent.progress.recentActivities.length - 1} wrap="truncate-end">{i === agent.progress.recentActivities.length - 1 ? "\u203A " : "  "}{renderToolActivity(activity, tools, theme)}</Text>)}</Box>;
    $[31] = agent.progress;
    $[32] = agent.status;
    $[33] = theme;
    $[34] = t15;
  } else {
    t15 = $[34];
  }
  let t16;
  if ($[35] !== displayPrompt || $[36] !== planContent) {
    t16 = planContent ? <Box marginTop={1}><UserPlanMessage addMargin={false} planContent={planContent} /></Box> : <Box flexDirection="column" marginTop={1}><Text bold={true} dimColor={true}>Prompt</Text><Text wrap="wrap">{displayPrompt}</Text></Box>;
    $[35] = displayPrompt;
    $[36] = planContent;
    $[37] = t16;
  } else {
    t16 = $[37];
  }
  let t17;
  if ($[38] !== agent.error || $[39] !== agent.status) {
    t17 = agent.status === "failed" && agent.error && <Box flexDirection="column" marginTop={1}><Text bold={true} color="error">Error</Text><Text color="error" wrap="wrap">{agent.error}</Text></Box>;
    $[38] = agent.error;
    $[39] = agent.status;
    $[40] = t17;
  } else {
    t17 = $[40];
  }
  let t18;
  if ($[41] !== t15 || $[42] !== t16 || $[43] !== t17) {
    t18 = <Box flexDirection="column">{t15}{t16}{t17}</Box>;
    $[41] = t15;
    $[42] = t16;
    $[43] = t17;
    $[44] = t18;
  } else {
    t18 = $[44];
  }
  let t19;
  if ($[45] !== onDone || $[46] !== subtitle || $[47] !== t14 || $[48] !== t18 || $[49] !== title) {
    t19 = <Dialog title={title} subtitle={subtitle} onCancel={onDone} color="background" inputGuide={t14}>{t18}</Dialog>;
    $[45] = onDone;
    $[46] = subtitle;
    $[47] = t14;
    $[48] = t18;
    $[49] = title;
    $[50] = t19;
  } else {
    t19 = $[50];
  }
  let t20;
  if ($[51] !== handleKeyDown || $[52] !== t19) {
    t20 = <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{t19}</Box>;
    $[51] = handleKeyDown;
    $[52] = t19;
    $[53] = t20;
  } else {
    t20 = $[53];
  }
  return t20;
}
