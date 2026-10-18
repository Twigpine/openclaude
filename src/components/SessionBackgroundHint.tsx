import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useCallback, useState } from 'react';
import { useDoublePress } from '../hooks/useDoublePress.js';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import { backgroundAll, hasForegroundTasks } from '../tasks/LocalShellTask/LocalShellTask.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { env } from '../utils/env.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
type Props = {
  onBackgroundSession: () => void;
  isLoading: boolean;
};

/**
 * Shows a hint when user presses Ctrl+B to background the current session.
 * Uses double-press pattern: first press shows hint, second press within 800ms backgrounds.
 *
 * Only activates when:
 * 1. isLoading is true (a query is in progress)
 * 2. No foreground tasks (bash/agent) are running (those take priority for Ctrl+B)
 */
export function SessionBackgroundHint(t0) {
  const $ = _c(10);
  const {
    onBackgroundSession,
    isLoading
  } = t0;
  const setAppState = useSetAppState();
  const appStateStore = useAppStateStore();
  const [showSessionHint, setShowSessionHint] = useState(false);
  const handleDoublePress = useDoublePress(setShowSessionHint, onBackgroundSession, _temp);
  let t1;
  if ($[0] !== appStateStore || $[1] !== handleDoublePress || $[2] !== isLoading || $[3] !== setAppState) {
    t1 = () => {
      if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
        return;
      }
      const state = appStateStore.getState();
      if (hasForegroundTasks(state)) {
        backgroundAll(() => appStateStore.getState(), setAppState);
        if (!getGlobalConfig().hasUsedBackgroundTask) {
          saveGlobalConfig(_temp2);
        }
      } else {
        // Session backgrounding remains intentionally disabled until the
        // handoff path is ready to ship; shell/agent backgrounding still runs.
        if (isEnvTruthy("false") && isLoading) {
          handleDoublePress();
        }
      }
    };
    $[0] = appStateStore;
    $[1] = handleDoublePress;
    $[2] = isLoading;
    $[3] = setAppState;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const handleBackground = t1;
  const hasForeground = useAppState(hasForegroundTasks);
  let t2;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = isEnvTruthy("false");
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const sessionBgEnabled = t2;
  const t3 = hasForeground || sessionBgEnabled && isLoading;
  let t4;
  if ($[6] !== t3) {
    t4 = {
      context: "Task",
      isActive: t3
    };
    $[6] = t3;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  useKeybinding("task:background", handleBackground, t4);
  const baseShortcut = useShortcutDisplay("task:background", "Task", "ctrl+b");
  const shortcut = env.terminal === "tmux" && baseShortcut === "ctrl+b" ? "ctrl+b ctrl+b" : baseShortcut;
  if (!isLoading || !showSessionHint) {
    return null;
  }
  let t5;
  if ($[8] !== shortcut) {
    t5 = <Box paddingLeft={2}><Text dimColor={true}><KeyboardShortcutHint shortcut={shortcut} action="background" /></Text></Box>;
    $[8] = shortcut;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
function _temp2(c) {
  return c.hasUsedBackgroundTask ? c : {
    ...c,
    hasUsedBackgroundTask: true
  };
}
function _temp() {}
