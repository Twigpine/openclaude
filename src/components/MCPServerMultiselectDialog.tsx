import { c as _c } from "react-compiler-runtime";
import partition from 'lodash-es/partition.js';
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Text } from '../ink.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { MCPServerDialogCopy } from './MCPServerDialogCopy.js';
type Props = {
  serverNames: string[];
  onDone(): void;
};
export function MCPServerMultiselectDialog(t0) {
  const $ = _c(21);
  const {
    serverNames,
    onDone
  } = t0;
  let t1;
  if ($[0] !== onDone || $[1] !== serverNames) {
    t1 = function onSubmit(selectedServers) {
      const currentSettings = getSettings_DEPRECATED() || {};
      const enabledServers = currentSettings.enabledMcpjsonServers || [];
      const disabledServers = currentSettings.disabledMcpjsonServers || [];
      const [approvedServers, rejectedServers] = partition(serverNames, server => selectedServers.includes(server));
      logEvent("tengu_mcp_multidialog_choice", {
        approved: approvedServers.length,
        rejected: rejectedServers.length
      });
      if (approvedServers.length > 0) {
        const newEnabledServers = [...new Set([...enabledServers, ...approvedServers])];
        updateSettingsForSource("localSettings", {
          enabledMcpjsonServers: newEnabledServers
        });
      }
      if (rejectedServers.length > 0) {
        const newDisabledServers = [...new Set([...disabledServers, ...rejectedServers])];
        updateSettingsForSource("localSettings", {
          disabledMcpjsonServers: newDisabledServers
        });
      }
      onDone();
    };
    $[0] = onDone;
    $[1] = serverNames;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const onSubmit = t1;
  let t2;
  if ($[3] !== onDone || $[4] !== serverNames) {
    t2 = () => {
      const currentSettings_0 = getSettings_DEPRECATED() || {};
      const disabledServers_0 = currentSettings_0.disabledMcpjsonServers || [];
      const newDisabledServers_0 = [...new Set([...disabledServers_0, ...serverNames])];
      updateSettingsForSource("localSettings", {
        disabledMcpjsonServers: newDisabledServers_0
      });
      onDone();
    };
    $[3] = onDone;
    $[4] = serverNames;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const handleEscRejectAll = t2;
  const t3 = `${serverNames.length} new MCP servers found in .mcp.json`;
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <MCPServerDialogCopy />;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== serverNames) {
    t5 = serverNames.map(_temp);
    $[7] = serverNames;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] !== handleEscRejectAll || $[10] !== onSubmit || $[11] !== serverNames || $[12] !== t5) {
    t6 = <SelectMulti options={t5} defaultValue={serverNames} onSubmit={onSubmit} onCancel={handleEscRejectAll} hideIndexes={true} />;
    $[9] = handleEscRejectAll;
    $[10] = onSubmit;
    $[11] = serverNames;
    $[12] = t5;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  let t7;
  if ($[14] !== handleEscRejectAll || $[15] !== t3 || $[16] !== t6) {
    t7 = <Dialog title={t3} subtitle="Select any you wish to enable." color="warning" onCancel={handleEscRejectAll} hideInputGuide={true}>{t4}{t6}</Dialog>;
    $[14] = handleEscRejectAll;
    $[15] = t3;
    $[16] = t6;
    $[17] = t7;
  } else {
    t7 = $[17];
  }
  let t8;
  if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = <Box paddingX={1}><Text dimColor={true} italic={true}><Byline><KeyboardShortcutHint shortcut="Space" action="select" /><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="reject all" /></Byline></Text></Box>;
    $[18] = t8;
  } else {
    t8 = $[18];
  }
  let t9;
  if ($[19] !== t7) {
    t9 = <>{t7}{t8}</>;
    $[19] = t7;
    $[20] = t9;
  } else {
    t9 = $[20];
  }
  return t9;
}
function _temp(server_0) {
  return {
    label: server_0,
    value: server_0
  };
}
