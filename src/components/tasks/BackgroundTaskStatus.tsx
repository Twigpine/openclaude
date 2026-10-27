import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useState } from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { stringWidth } from 'src/ink/stringWidth.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { enterTeammateView, exitTeammateView } from 'src/state/teammateViewHelpers.js';
import { isPanelAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { getPillLabel, pillNeedsCta } from 'src/tasks/pillLabel.js';
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import { calculateHorizontalScrollWindow } from 'src/utils/horizontalScroll.js';
import { Box, Text } from '../../ink.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js';
import type { Theme } from '../../utils/theme.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { shouldHideTasksFooter } from './taskStatusUtils.js';
type Props = {
  tasksSelected: boolean;
  isViewingTeammate?: boolean;
  teammateFooterIndex?: number;
  isLeaderIdle?: boolean;
  onOpenDialog?: (taskId?: string) => void;
};
export function BackgroundTaskStatus(t0) {
  const $ = _c(48);
  const {
    tasksSelected,
    isViewingTeammate,
    teammateFooterIndex: t1,
    isLeaderIdle: t2,
    onOpenDialog
  } = t0;
  const teammateFooterIndex = t1 === undefined ? 0 : t1;
  const isLeaderIdle = t2 === undefined ? false : t2;
  const setAppState = useSetAppState();
  const {
    columns
  } = useTerminalSize();
  const tasks = useAppState(_temp);
  const viewingAgentTaskId = useAppState(_temp2);
  let t3;
  if ($[0] !== tasks) {
    t3 = (Object.values(tasks ?? {}) as TaskState[]).filter(_temp3);
    $[0] = tasks;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  const runningTasks = t3;
  const expandedView = useAppState(_temp4);
  const showSpinnerTree = expandedView === "teammates";
  const allTeammates = !showSpinnerTree && runningTasks.length > 0 && runningTasks.every(_temp5);
  let t4;
  if ($[2] !== runningTasks) {
    t4 = runningTasks.filter(_temp6).sort(_temp7);
    $[2] = runningTasks;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  const teammateEntries = t4;
  let t5;
  if ($[4] !== isLeaderIdle) {
    t5 = {
      name: "main",
      color: undefined as keyof Theme | undefined,
      isIdle: isLeaderIdle,
      taskId: undefined as string | undefined
    };
    $[4] = isLeaderIdle;
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  const mainPill = t5;
  let t6;
  if ($[6] !== mainPill || $[7] !== tasksSelected || $[8] !== teammateEntries) {
    const teammatePills = teammateEntries.map(_temp8);
    if (!tasksSelected) {
      teammatePills.sort(_temp9);
    }
    const pills = [mainPill, ...teammatePills];
    t6 = pills.map(_temp0);
    $[6] = mainPill;
    $[7] = tasksSelected;
    $[8] = teammateEntries;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  const allPills = t6;
  let t7;
  if ($[10] !== allPills) {
    t7 = allPills.map(_temp1);
    $[10] = allPills;
    $[11] = t7;
  } else {
    t7 = $[11];
  }
  const pillWidths = t7;
  if (allTeammates || !showSpinnerTree && isViewingTeammate) {
    const selectedIdx = tasksSelected ? teammateFooterIndex : -1;
    let t8;
    if ($[12] !== teammateEntries || $[13] !== viewingAgentTaskId) {
      t8 = viewingAgentTaskId ? teammateEntries.findIndex(t_3 => t_3.id === viewingAgentTaskId) + 1 : 0;
      $[12] = teammateEntries;
      $[13] = viewingAgentTaskId;
      $[14] = t8;
    } else {
      t8 = $[14];
    }
    const viewedIdx = t8;
    const availableWidth = Math.max(20, columns - 20 - 4);
    const t9 = selectedIdx >= 0 ? selectedIdx : 0;
    let t10;
    if ($[15] !== availableWidth || $[16] !== pillWidths || $[17] !== t9) {
      t10 = calculateHorizontalScrollWindow(pillWidths, availableWidth, 2, t9);
      $[15] = availableWidth;
      $[16] = pillWidths;
      $[17] = t9;
      $[18] = t10;
    } else {
      t10 = $[18];
    }
    const {
      startIndex,
      endIndex,
      showLeftArrow,
      showRightArrow
    } = t10;
    let t11;
    if ($[19] !== allPills || $[20] !== endIndex || $[21] !== startIndex) {
      t11 = allPills.slice(startIndex, endIndex);
      $[19] = allPills;
      $[20] = endIndex;
      $[21] = startIndex;
      $[22] = t11;
    } else {
      t11 = $[22];
    }
    const visiblePills = t11;
    let t12;
    if ($[23] !== showLeftArrow) {
      t12 = showLeftArrow && <Text dimColor={true}>{figures.arrowLeft} </Text>;
      $[23] = showLeftArrow;
      $[24] = t12;
    } else {
      t12 = $[24];
    }
    let t13;
    if ($[25] !== selectedIdx || $[26] !== setAppState || $[27] !== viewedIdx || $[28] !== visiblePills) {
      t13 = visiblePills.map((pill_1, i_1) => {
        const needsSeparator = i_1 > 0;
        return <React.Fragment key={pill_1.name}>{needsSeparator && <Text> </Text>}<AgentPill name={pill_1.name} color={pill_1.color} isSelected={selectedIdx === pill_1.idx} isViewed={viewedIdx === pill_1.idx} isIdle={pill_1.isIdle} onClick={() => pill_1.taskId ? enterTeammateView(pill_1.taskId, setAppState) : exitTeammateView(setAppState)} /></React.Fragment>;
      });
      $[25] = selectedIdx;
      $[26] = setAppState;
      $[27] = viewedIdx;
      $[28] = visiblePills;
      $[29] = t13;
    } else {
      t13 = $[29];
    }
    let t14;
    if ($[30] !== showRightArrow) {
      t14 = showRightArrow && <Text dimColor={true}> {figures.arrowRight}</Text>;
      $[30] = showRightArrow;
      $[31] = t14;
    } else {
      t14 = $[31];
    }
    let t15;
    if ($[32] === Symbol.for("react.memo_cache_sentinel")) {
      t15 = <Text dimColor={true}>{" \xB7 "}<KeyboardShortcutHint shortcut={"shift + \u2193"} action="expand" /></Text>;
      $[32] = t15;
    } else {
      t15 = $[32];
    }
    let t16;
    if ($[33] !== t12 || $[34] !== t13 || $[35] !== t14) {
      t16 = <>{t12}{t13}{t14}{t15}</>;
      $[33] = t12;
      $[34] = t13;
      $[35] = t14;
      $[36] = t16;
    } else {
      t16 = $[36];
    }
    return t16;
  }
  if (shouldHideTasksFooter(tasks ?? {}, showSpinnerTree)) {
    return null;
  }
  if (runningTasks.length === 0) {
    return null;
  }
  let t8;
  if ($[37] !== runningTasks) {
    t8 = getPillLabel(runningTasks);
    $[37] = runningTasks;
    $[38] = t8;
  } else {
    t8 = $[38];
  }
  let t9;
  if ($[39] !== onOpenDialog || $[40] !== t8 || $[41] !== tasksSelected) {
    t9 = <SummaryPill selected={tasksSelected} onClick={onOpenDialog}>{t8}</SummaryPill>;
    $[39] = onOpenDialog;
    $[40] = t8;
    $[41] = tasksSelected;
    $[42] = t9;
  } else {
    t9 = $[42];
  }
  let t10;
  if ($[43] !== runningTasks) {
    t10 = pillNeedsCta(runningTasks) && <Text dimColor={true}> · {figures.arrowDown} to view</Text>;
    $[43] = runningTasks;
    $[44] = t10;
  } else {
    t10 = $[44];
  }
  let t11;
  if ($[45] !== t10 || $[46] !== t9) {
    t11 = <>{t9}{t10}</>;
    $[45] = t10;
    $[46] = t9;
    $[47] = t11;
  } else {
    t11 = $[47];
  }
  return t11;
}
function _temp1(pill_0, i_0) {
  const pillText = `@${pill_0.name}`;
  return stringWidth(pillText) + (i_0 > 0 ? 1 : 0);
}
function _temp0(pill, i) {
  return {
    ...pill,
    idx: i
  };
}
function _temp9(a_0, b_0) {
  if (a_0.isIdle !== b_0.isIdle) {
    return a_0.isIdle ? 1 : -1;
  }
  return 0;
}
function _temp8(t_2) {
  return {
    name: t_2.identity.agentName,
    color: getAgentThemeColor(t_2.identity.color),
    isIdle: t_2.isIdle,
    taskId: t_2.id
  };
}
function _temp7(a, b) {
  return a.identity.agentName.localeCompare(b.identity.agentName);
}
function _temp6(t_1) {
  return t_1.type === "in_process_teammate";
}
function _temp5(t_0) {
  return t_0.type === "in_process_teammate";
}
function _temp4(s_1) {
  return s_1.expandedView;
}
function _temp3(t) {
  return isBackgroundTask(t) && !(false && isPanelAgentTask(t));
}
function _temp2(s_0) {
  return s_0.viewingAgentTaskId;
}
function _temp(s) {
  return s.tasks;
}
type AgentPillProps = {
  name: string;
  color?: keyof Theme;
  isSelected: boolean;
  isViewed: boolean;
  isIdle: boolean;
  onClick?: () => void;
};
function AgentPill(t0) {
  const $ = _c(19);
  const {
    name,
    color,
    isSelected,
    isViewed,
    isIdle,
    onClick
  } = t0;
  const [hover, setHover] = useState(false);
  const highlighted = isSelected || hover;
  let label;
  if (highlighted) {
    let t1;
    if ($[0] !== color || $[1] !== isViewed || $[2] !== name) {
      t1 = color ? <Text backgroundColor={color} color="inverseText" bold={isViewed}>@{name}</Text> : <Text color="background" inverse={true} bold={isViewed}>@{name}</Text>;
      $[0] = color;
      $[1] = isViewed;
      $[2] = name;
      $[3] = t1;
    } else {
      t1 = $[3];
    }
    label = t1;
  } else {
    if (isIdle) {
      let t1;
      if ($[4] !== isViewed || $[5] !== name) {
        t1 = <Text dimColor={true} bold={isViewed}>@{name}</Text>;
        $[4] = isViewed;
        $[5] = name;
        $[6] = t1;
      } else {
        t1 = $[6];
      }
      label = t1;
    } else {
      if (isViewed) {
        let t1;
        if ($[7] !== color || $[8] !== name) {
          t1 = <Text color={color} bold={true}>@{name}</Text>;
          $[7] = color;
          $[8] = name;
          $[9] = t1;
        } else {
          t1 = $[9];
        }
        label = t1;
      } else {
        const t1 = !color;
        let t2;
        if ($[10] !== color || $[11] !== name || $[12] !== t1) {
          t2 = <Text color={color} dimColor={t1}>@{name}</Text>;
          $[10] = color;
          $[11] = name;
          $[12] = t1;
          $[13] = t2;
        } else {
          t2 = $[13];
        }
        label = t2;
      }
    }
  }
  if (!onClick) {
    return label;
  }
  let t1;
  let t2;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => setHover(true);
    t2 = () => setHover(false);
    $[14] = t1;
    $[15] = t2;
  } else {
    t1 = $[14];
    t2 = $[15];
  }
  let t3;
  if ($[16] !== label || $[17] !== onClick) {
    t3 = <Box onClick={onClick} onMouseEnter={t1} onMouseLeave={t2}>{label}</Box>;
    $[16] = label;
    $[17] = onClick;
    $[18] = t3;
  } else {
    t3 = $[18];
  }
  return t3;
}
function SummaryPill(t0) {
  const $ = _c(8);
  const {
    selected,
    onClick,
    children
  } = t0;
  const [hover, setHover] = useState(false);
  const t1 = selected || hover;
  let t2;
  if ($[0] !== children || $[1] !== t1) {
    t2 = <Text color="background" inverse={t1}>{children}</Text>;
    $[0] = children;
    $[1] = t1;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const label = t2;
  if (!onClick) {
    return label;
  }
  let t3;
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = () => setHover(true);
    t4 = () => setHover(false);
    $[3] = t3;
    $[4] = t4;
  } else {
    t3 = $[3];
    t4 = $[4];
  }
  let t5;
  if ($[5] !== label || $[6] !== onClick) {
    t5 = <Box onClick={onClick} onMouseEnter={t3} onMouseLeave={t4}>{label}</Box>;
    $[5] = label;
    $[6] = onClick;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  return t5;
}
function getAgentThemeColor(colorName: string | undefined): keyof Theme | undefined {
  if (!colorName) return undefined;
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}
