import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Box, Text } from '../ink.js';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { computeGlimmerIndex, computeShimmerSegments, SHIMMER_INTERVAL_MS } from '../bridge/bridgeStatusUtil.js';
import { feature } from 'bun:bundle';
import { getKairosActive, getUserMsgOptIn } from '../bootstrap/state.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { count } from '../utils/array.js';
import sample from 'lodash-es/sample.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import type { Theme } from 'src/utils/theme.js';
import { activityManager } from '../utils/activityManager.js';
import { getSpinnerVerbs } from '../constants/spinnerVerbs.js';
import { MessageResponse } from './MessageResponse.js';
import { TaskListV2 } from './TaskListV2.js';
import { useTasksV2 } from '../hooks/useTasksV2.js';
import type { Task } from '../utils/tasks.js';
import { type AppState, useAppState } from '../state/AppState.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { stringWidth } from '../ink/stringWidth.js';
import { getDefaultCharacters, type SpinnerMode } from './Spinner/index.js';
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js';
import { useSettings } from '../hooks/useSettings.js';
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js';
import { isBackgroundTask } from '../tasks/types.js';
import { getAllInProcessTeammateTasks } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { getEffortSuffix } from '../utils/effort.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { getViewedTeammateTask } from '../state/selectors.js';
import { TEARDROP_ASTERISK } from '../constants/figures.js';
import figures from 'figures';
import { getCurrentTurnTokenBudget, getTurnOutputTokens } from '../bootstrap/state.js';
import { TeammateSpinnerTree } from './Spinner/TeammateSpinnerTree.js';
import { useAnimationFrame } from '../ink.js';
import { getGlobalConfig } from '../utils/config.js';
export type { SpinnerMode } from './Spinner/index.js';
const DEFAULT_CHARACTERS = getDefaultCharacters();
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
type Props = {
  mode: SpinnerMode;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;
  spinnerTip?: string;
  responseLengthRef: React.RefObject<number>;
  responseLength?: number;
  overrideColor?: keyof Theme | null;
  overrideShimmerColor?: keyof Theme | null;
  overrideMessage?: string | null;
  spinnerSuffix?: string | null;
  verbose: boolean;
  hasActiveTools?: boolean;
  /** Leader's turn has completed (no active query). Used to suppress stall-red spinner when only teammates are running. */
  leaderIsIdle?: boolean;
};

// Thin wrapper: branches on isBriefOnly so the two variants have independent
// hook call chains. Without this split, toggling /brief mid-render would
// violate Rules of Hooks (the inner variant calls ~10 more hooks).
export function SpinnerWithVerb(props: Props): React.ReactNode {
  const isBriefOnly = useAppState(s => s.isBriefOnly);
  // REPL overrides isBriefOnly→false when viewing a teammate transcript
  // (see isBriefOnly={viewedTeammateTask ? false : isBriefOnly}). That
  // prop isn't threaded here, so replicate the gate from the store —
  // teammate view needs the real spinner (which shows teammate status).
  const viewingAgentTaskId = useAppState(s_0 => s_0.viewingAgentTaskId);
  // Hoisted to mount-time — this component re-renders at animation framerate.
  const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_BRIEF), []) : false;

  // Runtime gate mirrors isBriefEnabled() but inlined — importing from
  // BriefTool.ts would leak tool-name strings into external builds. Single
  // spinner instance → hooks stay unconditional (two subs, negligible).
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && (getKairosActive() || getUserMsgOptIn() && (briefEnvEnabled || getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_brief', false))) && isBriefOnly && !viewingAgentTaskId) {
    return <BriefSpinner mode={props.mode} overrideMessage={props.overrideMessage} />;
  }
  return <SpinnerWithVerbInner {...props} />;
}
function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  responseLength,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  leaderIsIdle = false
}: Props): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;

  // NOTE: useAnimationFrame(50) lives in SpinnerAnimationRow, not here.
  // This component only re-renders when props or app state change —
  // it is no longer on the 50ms clock. All `time`-derived values
  // (frame, glimmer, stalled intensity, token display, thinking shimmer,
  // elapsed-time timer) are computed inside the child.

  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s_0 => s_0.viewingAgentTaskId);
  const expandedView = useAppState(s_1 => s_1.expandedView);
  const showExpandedTodos = expandedView === 'tasks';
  const showSpinnerTree = expandedView === 'teammates';
  const selectedIPAgentIndex = useAppState(s_2 => s_2.selectedIPAgentIndex);
  const viewSelectionMode = useAppState(s_3 => s_3.viewSelectionMode);
  // Get foregrounded teammate (if viewing a teammate's transcript)
  const foregroundedTeammate = viewingAgentTaskId ? getViewedTeammateTask({
    viewingAgentTaskId,
    tasks
  }) : undefined;
  const {
    columns
  } = useTerminalSize();
  const tasksV2 = useTasksV2();

  // Track thinking status: 'thinking' | number (duration in ms) | null
  // Shows each state for minimum 2s to avoid UI jank
  const [thinkingStatus, setThinkingStatus] = useState<'thinking' | number | null>(null);
  const thinkingStartRef = useRef<number | null>(null);
  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null;
    if (mode === 'thinking') {
      // Started thinking
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
        setThinkingStatus('thinking');
      }
    } else if (thinkingStartRef.current !== null) {
      // Stopped thinking - calculate duration and ensure 2s minimum display
      const duration = Date.now() - thinkingStartRef.current;
      const elapsed = Date.now() - thinkingStartRef.current;
      const remainingThinkingTime = Math.max(0, 2000 - elapsed);
      thinkingStartRef.current = null;

      // Show "thinking..." for remaining time if < 2s elapsed, then show duration
      const showDuration = (): void => {
        setThinkingStatus(duration);
        // Clear after 2s
        clearStatusTimer = setTimeout(setThinkingStatus, 2000, null);
      };
      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime);
      } else {
        showDuration();
      }
    }
    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer);
      if (clearStatusTimer) clearTimeout(clearStatusTimer);
    };
  }, [mode]);

  // Find the current in-progress task and next pending task
  const currentTodo = tasksV2?.find(task => task.status !== 'pending' && task.status !== 'completed');
  const nextTask = findNextPendingTask(tasksV2);

  // Use useState with initializer to pick a random verb once on mount
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()));

  // Leader's own verb (always the leader's, regardless of who is foregrounded)
  const leaderVerb = overrideMessage ?? currentTodo?.activeForm ?? currentTodo?.subject ?? randomVerb;
  const effectiveVerb = foregroundedTeammate && !foregroundedTeammate.isIdle ? foregroundedTeammate.spinnerVerb ?? randomVerb : leaderVerb;
  const message = effectiveVerb + '…';

  // Track CLI activity when spinner is active
  useEffect(() => {
    const operationId = 'spinner-' + mode;
    activityManager.startCLIActivity(operationId);
    return () => {
      activityManager.endCLIActivity(operationId);
    };
  }, [mode]);
  const mainLoopModel = useMainLoopModel();
  const effortValue = useAppState(s_4 => s_4.effortValue);
  const effortSuffix = getEffortSuffix(mainLoopModel, effortValue);

  // Check if any running in-process teammates exist (needed for both modes)
  const runningTeammates = getAllInProcessTeammateTasks(tasks).filter(t => t.status === 'running');
  const hasRunningTeammates = runningTeammates.length > 0;
  const allIdle = hasRunningTeammates && runningTeammates.every(t_0 => t_0.isIdle);

  // Gather aggregate token stats from all running swarm teammates
  // In spinner-tree mode, skip aggregation (teammates have their own lines in the tree)
  let teammateTokens = 0;
  if (!showSpinnerTree) {
    for (const task_0 of Object.values(tasks)) {
      if (isInProcessTeammateTask(task_0) && task_0.status === 'running') {
        if (task_0.progress?.tokenCount) {
          teammateTokens += task_0.progress.tokenCount;
        }
      }
    }
  }

  // Stale read of the refs for showBtwTip below — we're off the 50ms clock
  // so this only updates when props/app state change, which is sufficient for
  // a coarse 30s threshold.
  const elapsedSnapshot = pauseStartTimeRef.current !== null ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current : Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;

  // Leader token count for TeammateSpinnerTree — read raw (non-animated) from
  // the ref. The tree is only shown when teammates are running; teammate
  // progress updates to s.tasks trigger re-renders that keep this fresh.
  const leaderTokenCount = Math.round(responseLengthRef.current / 4);
  const defaultColor: keyof Theme = 'brand';
  const defaultShimmerColor = 'brandShimmer';
  const messageColor = overrideColor ?? defaultColor;
  const shimmerColor = overrideShimmerColor ?? defaultShimmerColor;

  // When leader is idle but teammates are running (and we're viewing the leader),
  // show a static dim idle display instead of the animated spinner — otherwise
  // useStalledAnimation detects no new tokens after 3s and turns the spinner red.
  if (leaderIsIdle && hasRunningTeammates && !foregroundedTeammate) {
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="nowrap" marginTop={1} width="100%">
          <Text dimColor>
            {TEARDROP_ASTERISK} Idle
            {!allIdle && ' · teammates running'}
          </Text>
        </Box>
        {showSpinnerTree && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderTokenCount={leaderTokenCount} leaderIdleText="Idle" />}
      </Box>;
  }

  // When viewing an idle teammate, show static idle display instead of animated spinner
  if (foregroundedTeammate?.isIdle) {
    const idleText = allIdle ? `${TEARDROP_ASTERISK} Worked for ${formatDuration(Date.now() - foregroundedTeammate.startTime)}` : `${TEARDROP_ASTERISK} Idle`;
    return <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="nowrap" marginTop={1} width="100%">
          <Text dimColor>{idleText}</Text>
        </Box>
        {showSpinnerTree && hasRunningTeammates && <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? 'Idle' : undefined} leaderTokenCount={leaderTokenCount} />}
      </Box>;
  }

  // Time-based tip overrides: coarse thresholds so a stale ref read (we're
  // off the 50ms clock) is fine. Other triggers (mode change, setMessages)
  // cause re-renders that refresh this in practice.
  let contextTipsActive = false;
  const tipsEnabled = settings.spinnerTipsEnabled !== false;
  const showClearTip = tipsEnabled && elapsedSnapshot > 1_800_000;
  const showBtwTip = tipsEnabled && elapsedSnapshot > 30_000 && !getGlobalConfig().btwUseCount;
  const effectiveTip = contextTipsActive ? undefined : showClearTip && !nextTask ? 'Use /clear to start fresh when switching topics and free up context' : showBtwTip && !nextTask ? "Use /btw to ask a quick side question without interrupting Claude's current work" : spinnerTip;

  // Budget text (internal-only) — shown above the tip line
  let budgetText: string | null = null;
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget();
    if (budget !== null && budget > 0) {
      const tokens = getTurnOutputTokens();
      if (tokens >= budget) {
        budgetText = `Target: ${formatNumber(tokens)} used (${formatNumber(budget)} min ${figures.tick})`;
      } else {
        const pct = Math.round(tokens / budget * 100);
        const remaining = budget - tokens;
        const rate = elapsedSnapshot > 5000 && tokens >= 2000 ? tokens / elapsedSnapshot : 0;
        const eta = rate > 0 ? ` \u00B7 ~${formatDuration(remaining / rate, {
          mostSignificantOnly: true
        })}` : '';
        budgetText = `Target: ${formatNumber(tokens)} / ${formatNumber(budget)} (${pct}%)${eta}`;
      }
    }
  }
  return <Box flexDirection="column" width="100%" alignItems="flex-start">
      <SpinnerAnimationRow mode={mode} reducedMotion={reducedMotion} hasActiveTools={hasActiveTools} responseLengthRef={responseLengthRef} responseLength={responseLength} message={message} messageColor={messageColor} shimmerColor={shimmerColor} overrideColor={overrideColor} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} spinnerSuffix={spinnerSuffix} verbose={verbose} columns={columns} hasRunningTeammates={hasRunningTeammates} teammateTokens={teammateTokens} foregroundedTeammate={foregroundedTeammate} leaderIsIdle={leaderIsIdle} thinkingStatus={thinkingStatus} effortSuffix={effortSuffix} />
      {showSpinnerTree && hasRunningTeammates ? <TeammateSpinnerTree selectedIndex={selectedIPAgentIndex} isInSelectionMode={viewSelectionMode === 'selecting-agent'} allIdle={allIdle} leaderVerb={leaderIsIdle ? undefined : leaderVerb} leaderIdleText={leaderIsIdle ? 'Idle' : undefined} leaderTokenCount={leaderTokenCount} /> : showExpandedTodos && tasksV2 && tasksV2.length > 0 ? <Box width="100%" flexDirection="column">
          <MessageResponse>
            <TaskListV2 tasks={tasksV2} />
          </MessageResponse>
        </Box> : nextTask || effectiveTip || budgetText ?
    // IMPORTANT: we need this width="100%" to avoid an Ink bug where the
    // tip gets duplicated over and over while the spinner is running if
    // the terminal is very small. TODO: fix this in Ink.
    <Box width="100%" flexDirection="column">
          {budgetText && <MessageResponse>
              <Text dimColor>{budgetText}</Text>
            </MessageResponse>}
          {(nextTask || effectiveTip) && <MessageResponse>
              <Text dimColor>
                {nextTask ? `Next: ${nextTask.subject}` : `Tip: ${effectiveTip}`}
              </Text>
            </MessageResponse>}
        </Box> : null}
    </Box>;
}

// Brief/assistant mode spinner: single status line. PromptInput drops its
// own marginTop when isBriefOnly is active, so this component owns the
// 2-row footprint between messages and input. Footprint is [blank, content]
// — one blank row above (breathing room under the messages list), spinner
// flush against the input bar. PromptInput's absolute-positioned
// Notifications overlay compensates with marginTop=-2 in brief mode
// (PromptInput.tsx:~2928) so it floats into the blank row above the
// spinner, not over the spinner content. Paired with BriefIdleStatus which
// keeps the same footprint when idle.
type BriefSpinnerProps = {
  mode: SpinnerMode;
  overrideMessage?: string | null;
};
function BriefSpinner(t0) {
  const $ = _c(31);
  const {
    mode,
    overrideMessage
  } = t0;
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [randomVerb] = useState(_temp4);
  const verb = overrideMessage ?? randomVerb;
  const connStatus = useAppState(_temp5);
  let t1;
  let t2;
  if ($[0] !== mode) {
    t1 = () => {
      const operationId = "spinner-" + mode;
      activityManager.startCLIActivity(operationId);
      return () => {
        activityManager.endCLIActivity(operationId);
      };
    };
    t2 = [mode];
    $[0] = mode;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  useEffect(t1, t2);
  const [, time] = useAnimationFrame(reducedMotion ? null : 120);
  const runningCount = useAppState(_temp6);
  const showConnWarning = connStatus === "reconnecting" || connStatus === "disconnected";
  const connText = connStatus === "reconnecting" ? "Reconnecting" : "Disconnected";
  const dotFrame = Math.floor(time / 300) % 3;
  let t3;
  if ($[3] !== dotFrame || $[4] !== reducedMotion) {
    t3 = reducedMotion ? "\u2026  " : ".".repeat(dotFrame + 1).padEnd(3);
    $[3] = dotFrame;
    $[4] = reducedMotion;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const dots = t3;
  let t4;
  if ($[6] !== verb) {
    t4 = stringWidth(verb);
    $[6] = verb;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  const verbWidth = t4;
  let t5;
  if ($[8] !== reducedMotion || $[9] !== showConnWarning || $[10] !== time || $[11] !== verb || $[12] !== verbWidth) {
    const glimmerIndex = reducedMotion || showConnWarning ? -100 : computeGlimmerIndex(Math.floor(time / SHIMMER_INTERVAL_MS), verbWidth);
    t5 = computeShimmerSegments(verb, glimmerIndex);
    $[8] = reducedMotion;
    $[9] = showConnWarning;
    $[10] = time;
    $[11] = verb;
    $[12] = verbWidth;
    $[13] = t5;
  } else {
    t5 = $[13];
  }
  const {
    before,
    shimmer,
    after
  } = t5;
  const {
    columns
  } = useTerminalSize();
  const rightText = runningCount > 0 ? `${runningCount} in background` : "";
  let t6;
  if ($[14] !== connText || $[15] !== showConnWarning || $[16] !== verbWidth) {
    t6 = showConnWarning ? stringWidth(connText) : verbWidth;
    $[14] = connText;
    $[15] = showConnWarning;
    $[16] = verbWidth;
    $[17] = t6;
  } else {
    t6 = $[17];
  }
  const leftWidth = t6 + 3;
  const pad = Math.max(1, columns - 2 - leftWidth - stringWidth(rightText));
  let t7;
  if ($[18] !== after || $[19] !== before || $[20] !== connText || $[21] !== dots || $[22] !== shimmer || $[23] !== showConnWarning) {
    t7 = showConnWarning ? <Text color="error">{connText + dots}</Text> : <>{before ? <Text dimColor={true}>{before}</Text> : null}{shimmer ? <Text>{shimmer}</Text> : null}{after ? <Text dimColor={true}>{after}</Text> : null}<Text dimColor={true}>{dots}</Text></>;
    $[18] = after;
    $[19] = before;
    $[20] = connText;
    $[21] = dots;
    $[22] = shimmer;
    $[23] = showConnWarning;
    $[24] = t7;
  } else {
    t7 = $[24];
  }
  let t8;
  if ($[25] !== pad || $[26] !== rightText) {
    t8 = rightText ? <><Text>{" ".repeat(pad)}</Text><Text color="subtle">{rightText}</Text></> : null;
    $[25] = pad;
    $[26] = rightText;
    $[27] = t8;
  } else {
    t8 = $[27];
  }
  let t9;
  if ($[28] !== t7 || $[29] !== t8) {
    t9 = <Box flexDirection="row" width="100%" marginTop={1} paddingLeft={2}>{t7}{t8}</Box>;
    $[28] = t7;
    $[29] = t8;
    $[30] = t9;
  } else {
    t9 = $[30];
  }
  return t9;
}

// Idle placeholder for brief mode. Same 2-row [blank, content] footprint
// as BriefSpinner so the input bar never jumps when toggling between
// working/idle/disconnected. See BriefSpinner's comment for the
// Notifications overlay coupling.
function _temp6(s_0: AppState) {
  return count(Object.values(s_0.tasks), isBackgroundTask) + s_0.remoteBackgroundTaskCount;
}
function _temp5(s) {
  return s.remoteConnectionStatus;
}
function _temp4() {
  return sample(getSpinnerVerbs()) ?? "Working";
}
export function BriefIdleStatus() {
  const $ = _c(9);
  const connStatus = useAppState(_temp7);
  const runningCount = useAppState(_temp8);
  const {
    columns
  } = useTerminalSize();
  const showConnWarning = connStatus === "reconnecting" || connStatus === "disconnected";
  const connText = connStatus === "reconnecting" ? "Reconnecting\u2026" : "Disconnected";
  const leftText = showConnWarning ? connText : "";
  const rightText = runningCount > 0 ? `${runningCount} in background` : "";
  if (!leftText && !rightText) {
    let t0;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t0 = <Box height={2} />;
      $[0] = t0;
    } else {
      t0 = $[0];
    }
    return t0;
  }
  const pad = Math.max(1, columns - 2 - stringWidth(leftText) - stringWidth(rightText));
  let t0;
  if ($[1] !== leftText) {
    t0 = leftText ? <Text color="error">{leftText}</Text> : null;
    $[1] = leftText;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  let t1;
  if ($[3] !== pad || $[4] !== rightText) {
    t1 = rightText ? <><Text>{" ".repeat(pad)}</Text><Text color="subtle">{rightText}</Text></> : null;
    $[3] = pad;
    $[4] = rightText;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  let t2;
  if ($[6] !== t0 || $[7] !== t1) {
    t2 = <Box marginTop={1} paddingLeft={2}><Text>{t0}{t1}</Text></Box>;
    $[6] = t0;
    $[7] = t1;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  return t2;
}
function _temp8(s_0: AppState) {
  return count(Object.values(s_0.tasks), isBackgroundTask) + s_0.remoteBackgroundTaskCount;
}
function _temp7(s) {
  return s.remoteConnectionStatus;
}
export function Spinner() {
  const $ = _c(8);
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 120);
  if (reducedMotion) {
    let t0;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t0 = <Text color="text">●</Text>;
      $[0] = t0;
    } else {
      t0 = $[0];
    }
    let t1;
    if ($[1] !== ref) {
      t1 = <Box ref={ref} flexWrap="wrap" height={1} width={2}>{t0}</Box>;
      $[1] = ref;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  const frame = Math.floor(time / 120) % SPINNER_FRAMES.length;
  const t0 = SPINNER_FRAMES[frame];
  let t1;
  if ($[3] !== t0) {
    t1 = <Text color="text">{t0}</Text>;
    $[3] = t0;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  let t2;
  if ($[5] !== ref || $[6] !== t1) {
    t2 = <Box ref={ref} flexWrap="wrap" height={1} width={2}>{t1}</Box>;
    $[5] = ref;
    $[6] = t1;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  return t2;
}
function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined;
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) {
    return undefined;
  }
  const unresolvedIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));
  return pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ?? pendingTasks[0];
}
