import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { useShortcutDisplay } from 'src/keybindings/useShortcutDisplay.js';
import { builtInCommandNames, type Command, type CommandResultDisplay, INTERNAL_ONLY_COMMANDS } from '../../commands.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Link, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getPublicBuildVersion } from '../../utils/version.js';
import { Pane } from '../design-system/Pane.js';
import { Tab, Tabs } from '../design-system/Tabs.js';
import { Commands } from './Commands.js';
import { General } from './General.js';
type Props = {
  onClose: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands: Command[];
};
export function HelpV2(t0) {
  const $ = _c(44);
  const {
    onClose,
    commands
  } = t0;
  const {
    rows,
    columns
  } = useTerminalSize();
  const maxHeight = Math.floor(rows / 2);
  const insideModal = useIsInsideModal();
  let t1;
  if ($[0] !== onClose) {
    t1 = () => onClose("Help dialog dismissed", {
      display: "system"
    });
    $[0] = onClose;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const close = t1;
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Help"
    };
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  useKeybinding("help:dismiss", close, t2);
  const exitState = useExitOnCtrlCDWithKeybindings(close);
  const dismissShortcut = useShortcutDisplay("help:dismiss", "Help", "esc");
  let antOnlyCommands;
  let builtinCommands;
  let t3;
  if ($[3] !== commands) {
    const builtinNames = builtInCommandNames();
    builtinCommands = commands.filter(cmd => builtinNames.has(cmd.name) && !cmd.isHidden);
    let t4;
    if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = [];
      $[7] = t4;
    } else {
      t4 = $[7];
    }
    antOnlyCommands = t4;
    t3 = commands.filter(cmd_2 => !builtinNames.has(cmd_2.name) && !cmd_2.isHidden);
    $[3] = commands;
    $[4] = antOnlyCommands;
    $[5] = builtinCommands;
    $[6] = t3;
  } else {
    antOnlyCommands = $[4];
    builtinCommands = $[5];
    t3 = $[6];
  }
  const customCommands = t3;
  let t4;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Tab key="general" title="general"><General /></Tab>;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  let tabs;
  if ($[9] !== antOnlyCommands || $[10] !== builtinCommands || $[11] !== close || $[12] !== columns || $[13] !== customCommands || $[14] !== maxHeight) {
    tabs = [t4];
    let t5;
    if ($[16] !== builtinCommands || $[17] !== close || $[18] !== columns || $[19] !== maxHeight) {
      t5 = <Tab key="commands" title="commands"><Commands commands={builtinCommands} maxHeight={maxHeight} columns={columns} title="Browse default commands:" onCancel={close} /></Tab>;
      $[16] = builtinCommands;
      $[17] = close;
      $[18] = columns;
      $[19] = maxHeight;
      $[20] = t5;
    } else {
      t5 = $[20];
    }
    tabs.push(t5);
    let t6;
    if ($[21] !== close || $[22] !== columns || $[23] !== customCommands || $[24] !== maxHeight) {
      t6 = <Tab key="custom" title="custom-commands"><Commands commands={customCommands} maxHeight={maxHeight} columns={columns} title="Browse custom commands:" emptyMessage="No custom commands found" onCancel={close} /></Tab>;
      $[21] = close;
      $[22] = columns;
      $[23] = customCommands;
      $[24] = maxHeight;
      $[25] = t6;
    } else {
      t6 = $[25];
    }
    tabs.push(t6);
    if (false && antOnlyCommands.length > 0) {
    let t7;
      if ($[26] !== antOnlyCommands || $[27] !== close || $[28] !== columns || $[29] !== maxHeight) {
        t7 = <Tab key="internal-only" title="[internal-only]"><Commands commands={antOnlyCommands} maxHeight={maxHeight} columns={columns} title="Browse internal-only commands:" onCancel={close} /></Tab>;
        $[26] = antOnlyCommands;
        $[27] = close;
        $[28] = columns;
        $[29] = maxHeight;
        $[30] = t7;
      } else {
        t7 = $[30];
      }
      tabs.push(t7);
    }
    $[9] = antOnlyCommands;
    $[10] = builtinCommands;
    $[11] = close;
    $[12] = columns;
    $[13] = customCommands;
    $[14] = maxHeight;
    $[15] = tabs;
  } else {
    tabs = $[15];
  }
  const t5 = insideModal ? undefined : maxHeight;
  const publicBuildVersion = getPublicBuildVersion();
  let t6;
  if ($[31] !== publicBuildVersion || $[32] !== tabs) {
    t6 = <Tabs title={false ? "/help" : `OpenClaude v${publicBuildVersion}`} color="professionalBlue" defaultTab="general">{tabs}</Tabs>;
    $[31] = publicBuildVersion;
    $[32] = tabs;
    $[33] = t6;
  } else {
    t6 = $[33];
  }
  let t7;
  if ($[34] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Box marginTop={1}><Text>For more help:{" "}<Link url="https://github.com/Twigpine/openclaude" /></Text></Box>;
    $[34] = t7;
  } else {
    t7 = $[34];
  }
  let t8;
  if ($[35] !== dismissShortcut || $[36] !== exitState.keyName || $[37] !== exitState.pending) {
    t8 = <Box marginTop={1}><Text dimColor={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : <Text italic={true}>{dismissShortcut} to cancel</Text>}</Text></Box>;
    $[35] = dismissShortcut;
    $[36] = exitState.keyName;
    $[37] = exitState.pending;
    $[38] = t8;
  } else {
    t8 = $[38];
  }
  let t9;
  if ($[39] !== t6 || $[40] !== t8) {
    t9 = <Pane color="professionalBlue">{t6}{t7}{t8}</Pane>;
    $[39] = t6;
    $[40] = t8;
    $[41] = t9;
  } else {
    t9 = $[41];
  }
  const t10 = <Box flexDirection="column" height={t5}>{t9}</Box>;
  return t10;
}
