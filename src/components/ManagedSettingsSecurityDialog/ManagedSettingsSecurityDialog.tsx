import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { SettingsJson } from '../../utils/settings/types.js';
import { Select } from '../CustomSelect/index.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
import { extractDangerousSettings, formatDangerousSettingsList } from './utils.js';
type Props = {
  settings: SettingsJson;
  onAccept: () => void;
  onReject: () => void;
};
export function ManagedSettingsSecurityDialog(t0) {
  const $ = _c(26);
  const {
    settings,
    onAccept,
    onReject
  } = t0;
  const dangerous = extractDangerousSettings(settings);
  const settingsList = formatDangerousSettingsList(dangerous);
  const exitState = useExitOnCtrlCDWithKeybindings();
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      context: "Confirmation"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  useKeybinding("confirm:no", onReject, t1);
  let t2;
  if ($[1] !== onAccept || $[2] !== onReject) {
    t2 = function onChange(value) {
      if (value === "exit") {
        onReject();
        return;
      }
      onAccept();
    };
    $[1] = onAccept;
    $[2] = onReject;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const onChange = t2;
  const T0 = PermissionDialog;
  const t3 = "warning";
  const t4 = "warning";
  const t5 = "Managed settings require approval";
  const T1 = Box;
  const t6 = "column";
  const t7 = 1;
  const t8 = 1;
  let t9;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t9 = <Text>Your organization has configured managed settings that could allow execution of arbitrary code or interception of your prompts and responses.</Text>;
    $[4] = t9;
  } else {
    t9 = $[4];
  }
  const T2 = Box;
  const t10 = "column";
  let t11;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = <Text dimColor={true}>Settings requiring approval:</Text>;
    $[5] = t11;
  } else {
    t11 = $[5];
  }
  const t12 = settingsList.map(_temp);
  let t13;
  if ($[6] !== T2 || $[7] !== t11 || $[8] !== t12) {
    t13 = <T2 flexDirection={t10}>{t11}{t12}</T2>;
    $[6] = T2;
    $[7] = t11;
    $[8] = t12;
    $[9] = t13;
  } else {
    t13 = $[9];
  }
  let t14;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t14 = <Text>Only accept if you trust your organization&apos;s IT administration and expect these settings to be configured.</Text>;
    $[10] = t14;
  } else {
    t14 = $[10];
  }
  let t15;
  if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
    t15 = [{
      label: "Yes, I trust these settings",
      value: "accept"
    }, {
      label: "No, exit Claude Code",
      value: "exit"
    }];
    $[11] = t15;
  } else {
    t15 = $[11];
  }
  let t16;
  if ($[12] !== onChange) {
    t16 = <Select options={t15} onChange={value_0 => onChange(value_0 as 'accept' | 'exit')} onCancel={() => onChange("exit")} />;
    $[12] = onChange;
    $[13] = t16;
  } else {
    t16 = $[13];
  }
  let t17;
  if ($[14] !== exitState.keyName || $[15] !== exitState.pending) {
    t17 = <Text dimColor={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Enter to confirm · Esc to exit</>}</Text>;
    $[14] = exitState.keyName;
    $[15] = exitState.pending;
    $[16] = t17;
  } else {
    t17 = $[16];
  }
  let t18;
  if ($[17] !== T1 || $[18] !== t13 || $[19] !== t16 || $[20] !== t17 || $[21] !== t9) {
    t18 = <T1 flexDirection={t6} gap={t7} paddingTop={t8}>{t9}{t13}{t14}{t16}{t17}</T1>;
    $[17] = T1;
    $[18] = t13;
    $[19] = t16;
    $[20] = t17;
    $[21] = t9;
    $[22] = t18;
  } else {
    t18 = $[22];
  }
  let t19;
  if ($[23] !== T0 || $[24] !== t18) {
    t19 = <T0 color={t3} titleColor={t4} title={t5}>{t18}</T0>;
    $[23] = T0;
    $[24] = t18;
    $[25] = t19;
  } else {
    t19 = $[25];
  }
  return t19;
}
function _temp(item, index) {
  return <Box key={index} paddingLeft={2}><Text><Text dimColor={true}>· </Text><Text>{item}</Text></Text></Box>;
}
