import { c as _c } from "react-compiler-runtime";
/**
 * HooksConfigMenu is a read-only browser for configured hooks.
 *
 * Users can drill into each hook event, see configured matchers and hooks
 * (of any type: command, prompt, agent, http), and view individual hook
 * details. To add or modify hooks, users should edit settings.json directly
 * or ask Claude — the menu directs them there.
 *
 * The menu is read-only because the old editing UI only supported
 * command-type hooks and duplicating the settings.json editing surface
 * in-menu for all four types would be a maintenance burden.
 */
import * as React from 'react';
import { useState } from 'react';
import { PRODUCT_DISPLAY_NAME } from '../../constants/product.js';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import { useAppState, useAppStateStore } from 'src/state/AppState.js';
import type { CommandResultDisplay } from '../../commands.js';
import { useSettingsChange } from '../../hooks/useSettingsChange.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getHookEventMetadata, getHooksForMatcher, getMatcherMetadata, getSortedMatchersForEvent, groupHooksByEventAndMatcher } from '../../utils/hooks/hooksConfigManager.js';
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { getSettings_DEPRECATED, getSettingsForSource } from '../../utils/settings/settings.js';
import { plural } from '../../utils/stringUtils.js';
import { Dialog } from '../design-system/Dialog.js';
import { SelectEventMode } from './SelectEventMode.js';
import { SelectHookMode } from './SelectHookMode.js';
import { SelectMatcherMode } from './SelectMatcherMode.js';
import { ViewHookMode } from './ViewHookMode.js';
type Props = {
  toolNames: string[];
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type ModeState = {
  mode: 'select-event';
} | {
  mode: 'select-matcher';
  event: HookEvent;
} | {
  mode: 'select-hook';
  event: HookEvent;
  matcher: string;
} | {
  mode: 'view-hook';
  event: HookEvent;
  hook: IndividualHookConfig;
};
type HooksByEventAndMatcher = Record<
  HookEvent,
  Record<string, IndividualHookConfig[]>
>;
export function HooksConfigMenu(t0) {
  const $ = _c(100);
  const {
    toolNames,
    onExit
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      mode: "select-event"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [modeState, setModeState] = useState(t1);
  const [disabledByPolicy, setDisabledByPolicy] = useState(_temp);
  const [restrictedByPolicy, setRestrictedByPolicy] = useState(_temp2);
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = source => {
      if (source === "policySettings") {
        const settings_0 = getSettings_DEPRECATED();
        const hooksDisabled_0 = settings_0?.disableAllHooks === true;
        setDisabledByPolicy(hooksDisabled_0 && getSettingsForSource("policySettings")?.disableAllHooks === true);
        setRestrictedByPolicy(getSettingsForSource("policySettings")?.allowManagedHooksOnly === true);
      }
    };
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  useSettingsChange(t2);
  const mode = modeState.mode;
  const selectedEvent = "event" in modeState ? modeState.event : "PreToolUse";
  const selectedMatcher = "matcher" in modeState ? modeState.matcher : null;
  const mcp = useAppState(_temp3);
  const appStateStore = useAppStateStore();
  let t3;
  if ($[2] !== mcp.tools || $[3] !== toolNames) {
    t3 = [...toolNames, ...mcp.tools.map(_temp4)];
    $[2] = mcp.tools;
    $[3] = toolNames;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const combinedToolNames = t3;
  let t4;
  if ($[5] !== appStateStore || $[6] !== combinedToolNames) {
    t4 = groupHooksByEventAndMatcher(appStateStore.getState(), combinedToolNames);
    $[5] = appStateStore;
    $[6] = combinedToolNames;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  const hooksByEventAndMatcher: HooksByEventAndMatcher = t4;
  let t5;
  if ($[8] !== hooksByEventAndMatcher || $[9] !== selectedEvent) {
    t5 = getSortedMatchersForEvent(hooksByEventAndMatcher, selectedEvent);
    $[8] = hooksByEventAndMatcher;
    $[9] = selectedEvent;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  const sortedMatchersForSelectedEvent = t5;
  let t6;
  if ($[11] !== hooksByEventAndMatcher || $[12] !== selectedEvent || $[13] !== selectedMatcher) {
    t6 = getHooksForMatcher(hooksByEventAndMatcher, selectedEvent, selectedMatcher);
    $[11] = hooksByEventAndMatcher;
    $[12] = selectedEvent;
    $[13] = selectedMatcher;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  const hooksForSelectedMatcher = t6;
  let t7;
  if ($[15] !== onExit) {
    t7 = () => {
      onExit("Hooks dialog dismissed", {
        display: "system"
      });
    };
    $[15] = onExit;
    $[16] = t7;
  } else {
    t7 = $[16];
  }
  const handleExit = t7;
  const t8 = mode === "select-event";
  let t9;
  if ($[17] !== t8) {
    t9 = {
      context: "Confirmation",
      isActive: t8
    };
    $[17] = t8;
    $[18] = t9;
  } else {
    t9 = $[18];
  }
  useKeybinding("confirm:no", handleExit, t9);
  let t10;
  if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = () => {
      setModeState({
        mode: "select-event"
      });
    };
    $[19] = t10;
  } else {
    t10 = $[19];
  }
  const t11 = mode === "select-matcher";
  let t12;
  if ($[20] !== t11) {
    t12 = {
      context: "Confirmation",
      isActive: t11
    };
    $[20] = t11;
    $[21] = t12;
  } else {
    t12 = $[21];
  }
  useKeybinding("confirm:no", t10, t12);
  let t13;
  if ($[22] !== combinedToolNames || $[23] !== modeState) {
    t13 = () => {
      if ("event" in modeState) {
        if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
          setModeState({
            mode: "select-matcher",
            event: modeState.event
          });
        } else {
          setModeState({
            mode: "select-event"
          });
        }
      }
    };
    $[22] = combinedToolNames;
    $[23] = modeState;
    $[24] = t13;
  } else {
    t13 = $[24];
  }
  const t14 = mode === "select-hook";
  let t15;
  if ($[25] !== t14) {
    t15 = {
      context: "Confirmation",
      isActive: t14
    };
    $[25] = t14;
    $[26] = t15;
  } else {
    t15 = $[26];
  }
  useKeybinding("confirm:no", t13, t15);
  let t16;
  if ($[27] !== modeState) {
    t16 = () => {
      if (modeState.mode === "view-hook") {
        const {
          event,
          hook
        } = modeState;
        setModeState({
          mode: "select-hook",
          event,
          matcher: hook.matcher || ""
        });
      }
    };
    $[27] = modeState;
    $[28] = t16;
  } else {
    t16 = $[28];
  }
  const t17 = mode === "view-hook";
  let t18;
  if ($[29] !== t17) {
    t18 = {
      context: "Confirmation",
      isActive: t17
    };
    $[29] = t17;
    $[30] = t18;
  } else {
    t18 = $[30];
  }
  useKeybinding("confirm:no", t16, t18);
  let t19;
  if ($[31] !== combinedToolNames) {
    t19 = getHookEventMetadata(combinedToolNames);
    $[31] = combinedToolNames;
    $[32] = t19;
  } else {
    t19 = $[32];
  }
  const hookEventMetadata = t19;
  const settings_1 = getSettings_DEPRECATED();
  const hooksDisabled_1 = settings_1?.disableAllHooks === true;
  let t20;
  if ($[33] !== hooksByEventAndMatcher) {
    const byEvent: Partial<Record<HookEvent, number>> = {};
    let total = 0;
    for (const [event_0, matchers] of Object.entries(hooksByEventAndMatcher)) {
      const eventCount = Object.values(matchers).reduce(_temp5, 0);
      byEvent[event_0 as HookEvent] = eventCount;
      total = total + eventCount;
    }
    t20 = {
      hooksByEvent: byEvent,
      totalHooksCount: total
    };
    $[33] = hooksByEventAndMatcher;
    $[34] = t20;
  } else {
    t20 = $[34];
  }
  const {
    hooksByEvent,
    totalHooksCount
  } = t20;
  if (hooksDisabled_1) {
    let t21;
    if ($[35] === Symbol.for("react.memo_cache_sentinel")) {
      t21 = <Text bold={true}>disabled</Text>;
      $[35] = t21;
    } else {
      t21 = $[35];
    }
    const t22 = disabledByPolicy && " by a managed settings file";
    let t23;
    if ($[36] !== totalHooksCount) {
      t23 = <Text bold={true}>{totalHooksCount}</Text>;
      $[36] = totalHooksCount;
      $[37] = t23;
    } else {
      t23 = $[37];
    }
    let t24;
    if ($[38] !== totalHooksCount) {
      t24 = plural(totalHooksCount, "hook");
      $[38] = totalHooksCount;
      $[39] = t24;
    } else {
      t24 = $[39];
    }
    let t25;
    if ($[40] !== totalHooksCount) {
      t25 = plural(totalHooksCount, "is", "are");
      $[40] = totalHooksCount;
      $[41] = t25;
    } else {
      t25 = $[41];
    }
    let t26;
    if ($[42] !== t22 || $[43] !== t23 || $[44] !== t24 || $[45] !== t25) {
      t26 = <Text>All hooks are currently {t21}{t22}. You have{" "}{t23} configured{" "}{t24} that{" "}{t25} not running.</Text>;
      $[42] = t22;
      $[43] = t23;
      $[44] = t24;
      $[45] = t25;
      $[46] = t26;
    } else {
      t26 = $[46];
    }
    let t27;
    let t28;
    let t29;
    let t30;
    if ($[47] === Symbol.for("react.memo_cache_sentinel")) {
      t27 = <Box marginTop={1}><Text dimColor={true}>When hooks are disabled:</Text></Box>;
      t28 = <Text dimColor={true}>· No hook commands will execute</Text>;
      t29 = <Text dimColor={true}>· StatusLine will not be displayed</Text>;
      t30 = <Text dimColor={true}>· Tool operations will proceed without hook validation</Text>;
      $[47] = t27;
      $[48] = t28;
      $[49] = t29;
      $[50] = t30;
    } else {
      t27 = $[47];
      t28 = $[48];
      t29 = $[49];
      t30 = $[50];
    }
    let t31;
    if ($[51] !== t26) {
      t31 = <Box flexDirection="column">{t26}{t27}{t28}{t29}{t30}</Box>;
      $[51] = t26;
      $[52] = t31;
    } else {
      t31 = $[52];
    }
    let t32;
    if ($[53] !== disabledByPolicy) {
      t32 = !disabledByPolicy && <Text dimColor={true}>To re-enable hooks, remove "disableAllHooks" from settings.json or ask {PRODUCT_DISPLAY_NAME}.</Text>;
      $[53] = disabledByPolicy;
      $[54] = t32;
    } else {
      t32 = $[54];
    }
    let t33;
    if ($[55] !== t31 || $[56] !== t32) {
      t33 = <Box flexDirection="column" gap={1}>{t31}{t32}</Box>;
      $[55] = t31;
      $[56] = t32;
      $[57] = t33;
    } else {
      t33 = $[57];
    }
    let t34;
    if ($[58] !== handleExit || $[59] !== t33) {
      t34 = <Dialog title="Hook Configuration - Disabled" onCancel={handleExit} inputGuide={_temp6}>{t33}</Dialog>;
      $[58] = handleExit;
      $[59] = t33;
      $[60] = t34;
    } else {
      t34 = $[60];
    }
    return t34;
  }
  switch (modeState.mode) {
    case "select-event":
      {
        let t21;
        if ($[61] !== combinedToolNames) {
          t21 = event_2 => {
            if (getMatcherMetadata(event_2, combinedToolNames) !== undefined) {
              setModeState({
                mode: "select-matcher",
                event: event_2
              });
            } else {
              setModeState({
                mode: "select-hook",
                event: event_2,
                matcher: ""
              });
            }
          };
          $[61] = combinedToolNames;
          $[62] = t21;
        } else {
          t21 = $[62];
        }
        let t22;
        if ($[63] !== handleExit || $[64] !== hookEventMetadata || $[65] !== hooksByEvent || $[66] !== restrictedByPolicy || $[67] !== t21 || $[68] !== totalHooksCount) {
          t22 = <SelectEventMode hookEventMetadata={hookEventMetadata} hooksByEvent={hooksByEvent} totalHooksCount={totalHooksCount} restrictedByPolicy={restrictedByPolicy} onSelectEvent={t21} onCancel={handleExit} />;
          $[63] = handleExit;
          $[64] = hookEventMetadata;
          $[65] = hooksByEvent;
          $[66] = restrictedByPolicy;
          $[67] = t21;
          $[68] = totalHooksCount;
          $[69] = t22;
        } else {
          t22 = $[69];
        }
        return t22;
      }
    case "select-matcher":
      {
        const t21 = hookEventMetadata[modeState.event];
        let t22;
        if ($[70] !== modeState.event) {
          t22 = matcher => {
            setModeState({
              mode: "select-hook",
              event: modeState.event,
              matcher
            });
          };
          $[70] = modeState.event;
          $[71] = t22;
        } else {
          t22 = $[71];
        }
        let t23;
        if ($[72] === Symbol.for("react.memo_cache_sentinel")) {
          t23 = () => {
            setModeState({
              mode: "select-event"
            });
          };
          $[72] = t23;
        } else {
          t23 = $[72];
        }
        let t24;
        if ($[73] !== hooksByEventAndMatcher || $[74] !== modeState.event || $[75] !== sortedMatchersForSelectedEvent || $[76] !== t21.description || $[77] !== t22) {
          t24 = <SelectMatcherMode selectedEvent={modeState.event} matchersForSelectedEvent={sortedMatchersForSelectedEvent} hooksByEventAndMatcher={hooksByEventAndMatcher} eventDescription={t21.description} onSelect={t22} onCancel={t23} />;
          $[73] = hooksByEventAndMatcher;
          $[74] = modeState.event;
          $[75] = sortedMatchersForSelectedEvent;
          $[76] = t21.description;
          $[77] = t22;
          $[78] = t24;
        } else {
          t24 = $[78];
        }
        return t24;
      }
    case "select-hook":
      {
        const t21 = hookEventMetadata[modeState.event];
        let t22;
        if ($[79] !== modeState.event) {
          t22 = hook_1 => {
            setModeState({
              mode: "view-hook",
              event: modeState.event,
              hook: hook_1
            });
          };
          $[79] = modeState.event;
          $[80] = t22;
        } else {
          t22 = $[80];
        }
        let t23;
        if ($[81] !== combinedToolNames || $[82] !== modeState.event) {
          t23 = () => {
            if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
              setModeState({
                mode: "select-matcher",
                event: modeState.event
              });
            } else {
              setModeState({
                mode: "select-event"
              });
            }
          };
          $[81] = combinedToolNames;
          $[82] = modeState.event;
          $[83] = t23;
        } else {
          t23 = $[83];
        }
        let t24;
        if ($[84] !== hooksForSelectedMatcher || $[85] !== modeState.event || $[86] !== modeState.matcher || $[87] !== t21 || $[88] !== t22 || $[89] !== t23) {
          t24 = <SelectHookMode selectedEvent={modeState.event} selectedMatcher={modeState.matcher} hooksForSelectedMatcher={hooksForSelectedMatcher} hookEventMetadata={t21} onSelect={t22} onCancel={t23} />;
          $[84] = hooksForSelectedMatcher;
          $[85] = modeState.event;
          $[86] = modeState.matcher;
          $[87] = t21;
          $[88] = t22;
          $[89] = t23;
          $[90] = t24;
        } else {
          t24 = $[90];
        }
        return t24;
      }
    case "view-hook":
      {
        const t21 = modeState.hook;
        let t22;
        if ($[91] !== combinedToolNames || $[92] !== modeState.event) {
          t22 = getMatcherMetadata(modeState.event, combinedToolNames);
          $[91] = combinedToolNames;
          $[92] = modeState.event;
          $[93] = t22;
        } else {
          t22 = $[93];
        }
        const t23 = t22 !== undefined;
        let t24;
        if ($[94] !== modeState) {
          t24 = () => {
            const {
              event: event_1,
              hook: hook_0
            } = modeState;
            setModeState({
              mode: "select-hook",
              event: event_1,
              matcher: hook_0.matcher || ""
            });
          };
          $[94] = modeState;
          $[95] = t24;
        } else {
          t24 = $[95];
        }
        let t25;
        if ($[96] !== modeState.hook || $[97] !== t23 || $[98] !== t24) {
          t25 = <ViewHookMode selectedHook={t21} eventSupportsMatcher={t23} onCancel={t24} />;
          $[96] = modeState.hook;
          $[97] = t23;
          $[98] = t24;
          $[99] = t25;
        } else {
          t25 = $[99];
        }
        return t25;
      }
  }
}
function _temp6() {
  return <Text>Esc to close</Text>;
}
function _temp5(sum: number, hooks: IndividualHookConfig[]): number {
  return sum + hooks.length;
}
function _temp4(tool) {
  return tool.name;
}
function _temp3(s) {
  return s.mcp;
}
function _temp2() {
  return getSettingsForSource("policySettings")?.allowManagedHooksOnly === true;
}
function _temp() {
  const settings = getSettings_DEPRECATED();
  const hooksDisabled = settings?.disableAllHooks === true;
  return hooksDisabled && getSettingsForSource("policySettings")?.disableAllHooks === true;
}
