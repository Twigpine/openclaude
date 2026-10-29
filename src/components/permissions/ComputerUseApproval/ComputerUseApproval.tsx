import { c as _c } from "react-compiler-runtime";
import { getSentinelCategory } from '@ant/computer-use-mcp/sentinelApps';
import type { CuPermissionRequest, CuPermissionResponse } from '@ant/computer-use-mcp/types';
import { DEFAULT_GRANT_FLAGS } from '@ant/computer-use-mcp/types';
import figures from 'figures';
import * as React from 'react';
import { useState } from 'react';
import { PRODUCT_DISPLAY_NAME } from '../../../constants/product.js';
import { Box, Text } from '../../../ink.js';
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js';
import { plural } from '../../../utils/stringUtils.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { Select } from '../../CustomSelect/select.js';
import { Dialog } from '../../design-system/Dialog.js';
type ComputerUseApprovalProps = {
  request: CuPermissionRequest;
  onDone: (response: CuPermissionResponse) => void;
};
const DENY_ALL_RESPONSE: CuPermissionResponse = {
  granted: [],
  denied: [],
  flags: DEFAULT_GRANT_FLAGS
};

/**
 * Two-panel dispatcher. When `request.tccState` is present, macOS permissions
 * (Accessibility / Screen Recording) are missing and the app list is
 * irrelevant — show a TCC panel that opens System Settings. Otherwise show the
 * app allowlist + grant-flags panel.
 */
export function ComputerUseApproval(t0) {
  const $ = _c(3);
  const {
    request,
    onDone
  } = t0;
  let t1;
  if ($[0] !== onDone || $[1] !== request) {
    t1 = request.tccState ? <ComputerUseTccPanel tccState={request.tccState} onDone={() => onDone(DENY_ALL_RESPONSE)} /> : <ComputerUseAppListPanel request={request} onDone={onDone} />;
    $[0] = onDone;
    $[1] = request;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  return t1;
}

// ── TCC panel ─────────────────────────────────────────────────────────────

type TccOption = 'open_accessibility' | 'open_screen_recording' | 'retry';
function ComputerUseTccPanel(t0) {
  const $ = _c(26);
  const {
    tccState,
    onDone
  } = t0;
  let opts;
  if ($[0] !== tccState.accessibility || $[1] !== tccState.screenRecording) {
    opts = [];
    if (!tccState.accessibility) {
      let t1;
      if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = {
          label: "Open System Settings \u2192 Accessibility",
          value: "open_accessibility"
        };
        $[3] = t1;
      } else {
        t1 = $[3];
      }
      opts.push(t1);
    }
    if (!tccState.screenRecording) {
      let t1;
      if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = {
          label: "Open System Settings \u2192 Screen Recording",
          value: "open_screen_recording"
        };
        $[4] = t1;
      } else {
        t1 = $[4];
      }
      opts.push(t1);
    }
    let t1;
    if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = {
        label: "Try again",
        value: "retry"
      };
      $[5] = t1;
    } else {
      t1 = $[5];
    }
    opts.push(t1);
    $[0] = tccState.accessibility;
    $[1] = tccState.screenRecording;
    $[2] = opts;
  } else {
    opts = $[2];
  }
  const options = opts;
  let t1;
  if ($[6] !== onDone) {
    t1 = function onChange(value) {
      switch (value) {
        case "open_accessibility":
          {
            execFileNoThrow("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
              useCwd: false
            });
            return;
          }
        case "open_screen_recording":
          {
            execFileNoThrow("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"], {
              useCwd: false
            });
            return;
          }
        case "retry":
          {
            onDone();
            return;
          }
      }
    };
    $[6] = onDone;
    $[7] = t1;
  } else {
    t1 = $[7];
  }
  const onChange = t1;
  const t2 = tccState.accessibility ? `${figures.tick} granted` : `${figures.cross} not granted`;
  let t3;
  if ($[8] !== t2) {
    t3 = <Text>Accessibility:{" "}{t2}</Text>;
    $[8] = t2;
    $[9] = t3;
  } else {
    t3 = $[9];
  }
  const t4 = tccState.screenRecording ? `${figures.tick} granted` : `${figures.cross} not granted`;
  let t5;
  if ($[10] !== t4) {
    t5 = <Text>Screen Recording:{" "}{t4}</Text>;
    $[10] = t4;
    $[11] = t5;
  } else {
    t5 = $[11];
  }
  let t6;
  if ($[12] !== t3 || $[13] !== t5) {
    t6 = <Box flexDirection="column">{t3}{t5}</Box>;
    $[12] = t3;
    $[13] = t5;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  let t7;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Text dimColor={true}>Grant the missing permissions in System Settings, then select "Try again". macOS may require you to restart {PRODUCT_DISPLAY_NAME} after granting Screen Recording.</Text>;
    $[15] = t7;
  } else {
    t7 = $[15];
  }
  let t8;
  if ($[16] !== onChange || $[17] !== onDone || $[18] !== options) {
    t8 = <Select options={options} onChange={onChange} onCancel={onDone} />;
    $[16] = onChange;
    $[17] = onDone;
    $[18] = options;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  let t9;
  if ($[20] !== t6 || $[21] !== t8) {
    t9 = <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>{t6}{t7}{t8}</Box>;
    $[20] = t6;
    $[21] = t8;
    $[22] = t9;
  } else {
    t9 = $[22];
  }
  let t10;
  if ($[23] !== onDone || $[24] !== t9) {
    t10 = <Dialog title="Computer Use needs macOS permissions" onCancel={onDone}>{t9}</Dialog>;
    $[23] = onDone;
    $[24] = t9;
    $[25] = t10;
  } else {
    t10 = $[25];
  }
  return t10;
}

// ── App allowlist panel ───────────────────────────────────────────────────

type AppListOption = 'allow_all' | 'deny';
const SENTINEL_WARNING: Record<NonNullable<ReturnType<typeof getSentinelCategory>>, string> = {
  shell: 'equivalent to shell access',
  filesystem: 'can read/write any file',
  system_settings: 'can change system settings'
};
function ComputerUseAppListPanel(t0) {
  const $ = _c(48);
  const {
    request,
    onDone
  } = t0;
  let t1;
  if ($[0] !== request.apps) {
    t1 = () => new Set(request.apps.flatMap(_temp));
    $[0] = request.apps;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const [checked] = useState(t1);
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = ["clipboardRead", "clipboardWrite", "systemKeyCombos"];
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const ALL_FLAG_KEYS = t2;
  let t3;
  if ($[3] !== request.requestedFlags) {
    t3 = ALL_FLAG_KEYS.filter(k => request.requestedFlags[k]);
    $[3] = request.requestedFlags;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const requestedFlagKeys = t3;
  const t4 = checked.size;
  let t5;
  if ($[5] !== checked.size) {
    t5 = plural(checked.size, "app");
    $[5] = checked.size;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  const t6 = `Allow for this session (${t4} ${t5})`;
  let t7;
  if ($[7] !== t6) {
    t7 = {
      label: t6,
      value: "allow_all"
    };
    $[7] = t6;
    $[8] = t7;
  } else {
    t7 = $[8];
  }
  let t8;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = {
      label: <Text>Deny, and tell {PRODUCT_DISPLAY_NAME} what to do differently <Text bold={true}>(esc)</Text></Text>,
      value: "deny"
    };
    $[9] = t8;
  } else {
    t8 = $[9];
  }
  let t9;
  if ($[10] !== t7) {
    t9 = [t7, t8];
    $[10] = t7;
    $[11] = t9;
  } else {
    t9 = $[11];
  }
  const options = t9;
  let t10;
  if ($[12] !== checked || $[13] !== onDone || $[14] !== request.apps || $[15] !== requestedFlagKeys) {
    t10 = function respond(allow) {
      if (!allow) {
        onDone(DENY_ALL_RESPONSE);
        return;
      }
      const now = Date.now();
      const granted = request.apps.flatMap(a_0 => a_0.resolved && checked.has(a_0.resolved.bundleId) ? [{
        bundleId: a_0.resolved.bundleId,
        displayName: a_0.resolved.displayName,
        grantedAt: now
      }] : []);
      const denied = request.apps.filter(a_1 => !a_1.resolved || !checked.has(a_1.resolved.bundleId)).map(_temp2);
      const flags = {
        ...DEFAULT_GRANT_FLAGS,
        ...Object.fromEntries(requestedFlagKeys.map(_temp3))
      };
      onDone({
        granted,
        denied,
        flags
      });
    };
    $[12] = checked;
    $[13] = onDone;
    $[14] = request.apps;
    $[15] = requestedFlagKeys;
    $[16] = t10;
  } else {
    t10 = $[16];
  }
  const respond = t10;
  let t11;
  if ($[17] !== respond) {
    t11 = () => respond(false);
    $[17] = respond;
    $[18] = t11;
  } else {
    t11 = $[18];
  }
  let t12;
  if ($[19] !== request.reason) {
    t12 = request.reason ? <Text dimColor={true}>{request.reason}</Text> : null;
    $[19] = request.reason;
    $[20] = t12;
  } else {
    t12 = $[20];
  }
  let t13;
  if ($[21] !== checked || $[22] !== request.apps) {
    let t14;
    if ($[24] !== checked) {
      t14 = a_3 => {
        const resolved = a_3.resolved;
        if (!resolved) {
          return <Text key={a_3.requestedName} dimColor={true}>{"  "}{figures.circle} {a_3.requestedName}{" "}<Text dimColor={true}>(not installed)</Text></Text>;
        }
        if (a_3.alreadyGranted) {
          return <Text key={resolved.bundleId} dimColor={true}>{"  "}{figures.tick} {resolved.displayName}{" "}<Text dimColor={true}>(already granted)</Text></Text>;
        }
        const sentinel = getSentinelCategory(resolved.bundleId);
        const isChecked = checked.has(resolved.bundleId);
        return <Box key={resolved.bundleId} flexDirection="column"><Text>{"  "}{isChecked ? figures.circleFilled : figures.circle}{" "}{resolved.displayName}</Text>{sentinel ? <Text bold={true}>{"    "}{figures.warning} {SENTINEL_WARNING[sentinel]}</Text> : null}</Box>;
      };
      $[24] = checked;
      $[25] = t14;
    } else {
      t14 = $[25];
    }
    t13 = request.apps.map(t14);
    $[21] = checked;
    $[22] = request.apps;
    $[23] = t13;
  } else {
    t13 = $[23];
  }
  let t14;
  if ($[26] !== t13) {
    t14 = <Box flexDirection="column">{t13}</Box>;
    $[26] = t13;
    $[27] = t14;
  } else {
    t14 = $[27];
  }
  let t15;
  if ($[28] !== requestedFlagKeys) {
    t15 = requestedFlagKeys.length > 0 ? <Box flexDirection="column"><Text dimColor={true}>Also requested:</Text>{requestedFlagKeys.map(_temp4)}</Box> : null;
    $[28] = requestedFlagKeys;
    $[29] = t15;
  } else {
    t15 = $[29];
  }
  let t16;
  if ($[30] !== request.willHide) {
    t16 = request.willHide && request.willHide.length > 0 ? <Text dimColor={true}>{request.willHide.length} other{" "}{plural(request.willHide.length, "app")} will be hidden while {PRODUCT_DISPLAY_NAME} works.</Text> : null;
    $[30] = request.willHide;
    $[31] = t16;
  } else {
    t16 = $[31];
  }
  let t17;
  let t18;
  if ($[32] !== respond) {
    t17 = v => respond(v === "allow_all");
    t18 = () => respond(false);
    $[32] = respond;
    $[33] = t17;
    $[34] = t18;
  } else {
    t17 = $[33];
    t18 = $[34];
  }
  let t19;
  if ($[35] !== options || $[36] !== t17 || $[37] !== t18) {
    t19 = <Select options={options} onChange={t17} onCancel={t18} />;
    $[35] = options;
    $[36] = t17;
    $[37] = t18;
    $[38] = t19;
  } else {
    t19 = $[38];
  }
  let t20;
  if ($[39] !== t12 || $[40] !== t14 || $[41] !== t15 || $[42] !== t16 || $[43] !== t19) {
    t20 = <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>{t12}{t14}{t15}{t16}{t19}</Box>;
    $[39] = t12;
    $[40] = t14;
    $[41] = t15;
    $[42] = t16;
    $[43] = t19;
    $[44] = t20;
  } else {
    t20 = $[44];
  }
  let t21;
  if ($[45] !== t11 || $[46] !== t20) {
    t21 = <Dialog title="Computer Use wants to control these apps" onCancel={t11}>{t20}</Dialog>;
    $[45] = t11;
    $[46] = t20;
    $[47] = t21;
  } else {
    t21 = $[47];
  }
  return t21;
}
function _temp4(flag) {
  return <Text key={flag} dimColor={true}>{"  "}· {flag}</Text>;
}
function _temp3(k_0) {
  return [k_0, true] as const;
}
function _temp2(a_2) {
  return {
    bundleId: a_2.resolved?.bundleId ?? a_2.requestedName,
    reason: a_2.resolved ? "user_denied" as const : "not_installed" as const
  };
}
function _temp(a) {
  return a.resolved && !a.alreadyGranted ? [a.resolved.bundleId] : [];
}
