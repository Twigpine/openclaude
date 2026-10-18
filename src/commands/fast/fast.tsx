import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import type { CommandResultDisplay, LocalJSXCommandContext } from '../../commands.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { FastIcon, getFastIconString } from '../../components/FastIcon.js';
import { useSettings } from '../../hooks/useSettings.js';
import { Box, Link, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { type AppState, useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { clearFastModeCooldown, FAST_MODE_MODEL_DISPLAY, getFastModeModel, getFastModeRuntimeState, getFastModeUnavailableReason, isFastModeEnabled, isFastModeSupportedByModel, prefetchFastModeStatus } from '../../utils/fastMode.js';
import { formatDuration } from '../../utils/format.js';
import { getDefaultOpusModel } from '../../utils/model/model.js';
import { getModelPricingString } from '../../utils/modelCost.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
function applyFastMode(enable: boolean, setAppState: (f: (prev: AppState) => AppState) => void): void {
  clearFastModeCooldown();
  updateSettingsForSource('userSettings', {
    fastMode: enable ? true : undefined
  });
  if (enable) {
    setAppState(prev => {
      // Only switch model if current model doesn't support fast mode
      const needsModelSwitch = !isFastModeSupportedByModel(prev.mainLoopModel);
      return {
        ...prev,
        ...(needsModelSwitch ? {
          mainLoopModel: getFastModeModel(),
          mainLoopModelForSession: null
        } : {}),
        fastMode: true
      };
    });
  } else {
    setAppState(prev => ({
      ...prev,
      fastMode: false
    }));
  }
}
export function FastModePicker(t0) {
  const $ = _c(30);
  const {
    onDone,
    unavailableReason
  } = t0;
  const model = useAppState(_temp);
  const initialFastMode = useAppState(_temp2);
  const setAppState = useSetAppState();
  useSettings();
  const [enableFastMode, setEnableFastMode] = useState(initialFastMode ?? false);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getFastModeRuntimeState();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const runtimeState = t1;
  const isCooldown = runtimeState.status === "cooldown";
  const isUnavailable = unavailableReason !== null;
  // Settings are reloadable while the process is running, so do not pin this
  // external-store-derived price in the compiler memo cache.
  const pricing = getModelPricingString(getDefaultOpusModel(), {
    speed: 'fast'
  }) ?? '';
  let t3;
  if ($[2] !== enableFastMode || $[3] !== isUnavailable || $[4] !== model || $[5] !== onDone || $[6] !== setAppState) {
    t3 = function handleConfirm() {
      if (isUnavailable) {
        return;
      }
      applyFastMode(enableFastMode, setAppState);
      logEvent("tengu_fast_mode_toggled", {
        enabled: enableFastMode,
        source: "picker" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      if (enableFastMode) {
        const fastIcon = getFastIconString(enableFastMode);
        const modelUpdated = !isFastModeSupportedByModel(model) ? ` · model set to ${FAST_MODE_MODEL_DISPLAY}` : "";
        const confirmationPricing = getModelPricingString(getDefaultOpusModel(), {
          speed: 'fast'
        }) ?? '';
        onDone(`${fastIcon} Fast mode ON${modelUpdated} · ${confirmationPricing}`);
      } else {
        setAppState(_temp3);
        onDone("Fast mode OFF");
      }
    };
    $[2] = enableFastMode;
    $[3] = isUnavailable;
    $[4] = model;
    $[5] = onDone;
    $[6] = setAppState;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  const handleConfirm = t3;
  let t4;
  if ($[8] !== initialFastMode || $[9] !== isUnavailable || $[10] !== onDone || $[11] !== setAppState) {
    t4 = function handleCancel() {
      if (isUnavailable) {
        if (initialFastMode) {
          applyFastMode(false, setAppState);
        }
        onDone("Fast mode OFF", {
          display: "system"
        });
        return;
      }
      const message = initialFastMode ? `${getFastIconString()} Kept Fast mode ON` : "Kept Fast mode OFF";
      onDone(message, {
        display: "system"
      });
    };
    $[8] = initialFastMode;
    $[9] = isUnavailable;
    $[10] = onDone;
    $[11] = setAppState;
    $[12] = t4;
  } else {
    t4 = $[12];
  }
  const handleCancel = t4;
  let t5;
  if ($[13] !== isUnavailable) {
    t5 = function handleToggle() {
      if (isUnavailable) {
        return;
      }
      setEnableFastMode(_temp4);
    };
    $[13] = isUnavailable;
    $[14] = t5;
  } else {
    t5 = $[14];
  }
  const handleToggle = t5;
  let t6;
  if ($[15] !== handleConfirm || $[16] !== handleToggle) {
    t6 = {
      "confirm:yes": handleConfirm,
      "confirm:nextField": handleToggle,
      "confirm:next": handleToggle,
      "confirm:previous": handleToggle,
      "confirm:cycleMode": handleToggle,
      "confirm:toggle": handleToggle
    };
    $[15] = handleConfirm;
    $[16] = handleToggle;
    $[17] = t6;
  } else {
    t6 = $[17];
  }
  let t7;
  if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = {
      context: "Confirmation"
    };
    $[18] = t7;
  } else {
    t7 = $[18];
  }
  useKeybindings(t6, t7);
  let t8;
  if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = <Text><FastIcon cooldown={isCooldown} /> Fast mode (research preview)</Text>;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  const title = t8;
  let t9;
  if ($[20] !== isUnavailable) {
    t9 = exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : isUnavailable ? <Text>Esc to cancel</Text> : <Text>Tab to toggle · Enter to confirm · Esc to cancel</Text>;
    $[20] = isUnavailable;
    $[21] = t9;
  } else {
    t9 = $[21];
  }
  // Pricing comes from the reloadable settings cache, so keep the rendered
  // value out of the compiler memo cache as well as the confirmation callback.
  const t10 = unavailableReason ? <Box marginLeft={2}><Text color="error">{unavailableReason}</Text></Box> : <><Box flexDirection="column" gap={0} marginLeft={2}><Box flexDirection="row" gap={2}><Text bold={true}>Fast mode</Text><Text color={enableFastMode ? "fastMode" : undefined} bold={enableFastMode}>{enableFastMode ? "ON " : "OFF"}</Text><Text dimColor={true}>{pricing}</Text></Box></Box>{isCooldown && runtimeState.status === "cooldown" && <Box marginLeft={2}><Text color="warning">{runtimeState.reason === "overloaded" ? "Fast mode overloaded and is temporarily unavailable" : "You've hit your fast limit"}{" \xB7 resets in "}{formatDuration(runtimeState.resetAt - Date.now(), {
          hideTrailingZeros: true
        })}</Text></Box>}</>;
  let t11;
  if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = <Text dimColor={true}>Learn more:{" "}<Link url="https://code.claude.com/docs/en/fast-mode">https://code.claude.com/docs/en/fast-mode</Link></Text>;
    $[25] = t11;
  } else {
    t11 = $[25];
  }
  let t12;
  if ($[26] !== handleCancel || $[27] !== t10 || $[28] !== t9) {
    t12 = <Dialog title={title} subtitle={`High-speed mode for ${FAST_MODE_MODEL_DISPLAY}. Billed as extra usage at a premium rate. Separate rate limits apply.`} onCancel={handleCancel} color="fastMode" inputGuide={t9}>{t10}{t11}</Dialog>;
    $[26] = handleCancel;
    $[27] = t10;
    $[28] = t9;
    $[29] = t12;
  } else {
    t12 = $[29];
  }
  return t12;
}
function _temp4(prev_0) {
  return !prev_0;
}
function _temp3(prev) {
  return {
    ...prev,
    fastMode: false
  };
}
function _temp2(s_0) {
  return s_0.fastMode;
}
function _temp(s) {
  return s.mainLoopModel;
}
export async function handleFastModeShortcut(enable: boolean, getAppState: () => AppState, setAppState: (f: (prev: AppState) => AppState) => void): Promise<string> {
  const unavailableReason = getFastModeUnavailableReason();
  if (unavailableReason) {
    return `Fast mode unavailable: ${unavailableReason}`;
  }
  const {
    mainLoopModel
  } = getAppState();
  applyFastMode(enable, setAppState);
  logEvent('tengu_fast_mode_toggled', {
    enabled: enable,
    source: 'shortcut' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  if (enable) {
    const fastIcon = getFastIconString(true);
    const modelUpdated = !isFastModeSupportedByModel(mainLoopModel) ? ` · model set to ${FAST_MODE_MODEL_DISPLAY}` : '';
    const pricing = getModelPricingString(getDefaultOpusModel(), {
      speed: 'fast'
    }) ?? '';
    return `${fastIcon} Fast mode ON${modelUpdated} · ${pricing}`;
  } else {
    return `Fast mode OFF`;
  }
}
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args?: string): Promise<React.ReactNode | null> {
  if (!isFastModeEnabled()) {
    return null;
  }

  // Fetch org fast mode status before showing the picker. We must know
  // whether the org has disabled fast mode before allowing any toggle.
  // If a startup prefetch is already in flight, this awaits it.
  await prefetchFastModeStatus();
  const arg = args?.trim().toLowerCase();
  if (arg === 'on' || arg === 'off') {
    const result = await handleFastModeShortcut(arg === 'on', context.getAppState, context.setAppState);
    onDone(result);
    return null;
  }
  const unavailableReason = getFastModeUnavailableReason();
  logEvent('tengu_fast_mode_picker_shown', {
    unavailable_reason: (unavailableReason ?? '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  return <FastModePicker onDone={onDone} unavailableReason={unavailableReason} />;
}
