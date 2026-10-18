import { c as _c } from "react-compiler-runtime";
import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { FAST_MODE_MODEL_DISPLAY, isFastModeAvailable, isFastModeCooldown, isFastModeEnabled } from 'src/utils/fastMode.js';
import { Box, Text } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { convertEffortValueToLevel, type EffortLevel, getAvailableEffortLevels, getDefaultEffortForModel, modelSupportsEffort, modelSupportsMaxEffort, resolvePickerEffortPersistence, toPersistableEffort } from '../utils/effort.js';
import { isModelAllowed } from '../utils/model/modelAllowlist.js';
import { getDefaultMainLoopModel, type ModelSetting, modelDisplayString, parseUserSpecifiedModel } from '../utils/model/model.js';
import { getModelOptions, SWITCH_PROFILE_VALUE_PREFIX, type ModelOption, parseSwitchProfileValue, resolveSelectedSwitchProfileId } from '../utils/model/modelOptions.js';
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Pane } from './design-system/Pane.js';
import { effortLevelToSymbol } from './EffortIndicator.js';
export type ModelPickerDiscoveryState = {
  message: string;
  tone?: 'info' | 'success' | 'warning' | 'error';
};
export type Props = {
  initial: string | null;
  sessionModel?: ModelSetting;
  /**
   * `switchToProfileId` is the marker of the selected cross-profile option
   * (issue #1119). It is defined only when the picked option is a genuine
   * "switch profile" entry, so consumers must gate profile activation on this
   * marker rather than re-parsing the encoded value — a literal custom model id
   * that merely starts with `__switch_profile__:` arrives with it undefined.
   */
  onSelect: (
    model: string | null,
    effort: EffortLevel | undefined,
    switchToProfileId?: string,
  ) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  showFastModeNotice?: boolean;
  /** Overrides the dim header line below "Select model". */
  headerText?: string;
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .openclaude/settings.json via
   * install.ts) and should not leak to the user's global ~/.openclaude/settings.json.
   */
  skipSettingsWrite?: boolean;
  optionsOverride?: ModelOption[];
  discoveryState?: ModelPickerDiscoveryState;
  onRefresh?: () => void;
  /**
   * Allow cross-profile "switch profile" options (issue #1119) to appear in the
   * list. These carry an encoded `__switch_profile__:<id>:<model>` value that
   * only the `/model` command's onSelect knows how to activate. Inline pickers
   * (prompt hotkey, Settings) that write the raw value to `mainLoopModel` must
   * leave this off so they never surface an option they cannot honor.
   */
  allowProfileSwitch?: boolean;
};
const NO_PREFERENCE = '__NO_PREFERENCE__';
function normalizeModelPickerValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function optionMatchesPickerValue(option: ModelOption, value: string): boolean {
  const optionKey = normalizeModelPickerValue(option.value);
  const valueKey = normalizeModelPickerValue(value);
  return optionKey !== null && valueKey !== null && optionKey === valueKey;
}

function resolvePickerOptionValue(options: ModelOption[], value: string): string | undefined {
  const optionValue = options.find(option => optionMatchesPickerValue(option, value))?.value;
  return typeof optionValue === 'string' ? optionValue : undefined;
}
function mapDiscoveryToneToColor(tone: ModelPickerDiscoveryState['tone']): 'error' | 'warning' | 'success' | 'subtle' {
  switch (tone) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'success':
      return 'success';
    case 'info':
    default:
      return 'subtle';
  }
}
export function ModelPicker(t0) {
  const $ = _c(84);
  const {
    initial,
    sessionModel,
    onSelect,
    onCancel,
    isStandaloneCommand,
    showFastModeNotice,
    headerText,
    skipSettingsWrite,
    optionsOverride,
    discoveryState,
    onRefresh,
    allowProfileSwitch
  } = t0;
  const setAppState = useSetAppState();
  const exitState = useExitOnCtrlCDWithKeybindings();
  const initialValue = initial === null ? NO_PREFERENCE : initial;
  const isFastMode = useAppState(_temp);
  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const effortValue = useAppState(_temp2);
  let t1;
  if ($[0] !== effortValue) {
    t1 = effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined;
    $[0] = effortValue;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const [effort, setEffort] = useState(t1);
  const t2 = isFastMode ?? false;
  let t3;
  if ($[2] !== t2) {
    t3 = getModelOptions(t2);
    $[2] = t2;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const modelOptionsBase = optionsOverride ?? t3;
  // Cross-profile switch options can only be honored by the /model command's
  // onSelect, which decodes the value and activates the target profile. Strip
  // them for inline pickers (allowProfileSwitch falsy) so a hotkey/Settings
  // selection never writes the raw `__switch_profile__:...` value as a model.
  // Key on the `switchToProfileId` marker, not the raw value prefix, so a real
  // custom model id that merely starts with `__switch_profile__:` is not hidden.
  const modelOptions = allowProfileSwitch
    ? modelOptionsBase
    : modelOptionsBase.filter(opt => opt.switchToProfileId === undefined);
  let t4;
  bb0: {
    if (initial !== null && isModelAllowed(initial) && !modelOptions.some(opt => optionMatchesPickerValue(opt, initial))) {
      let t5;
      if ($[4] !== initial) {
        t5 = modelDisplayString(initial);
        $[4] = initial;
        $[5] = t5;
      } else {
        t5 = $[5];
      }
      let t6;
      if ($[6] !== initial || $[7] !== t5) {
        t6 = {
          value: initial,
          label: t5,
          description: "Current model"
        };
        $[6] = initial;
        $[7] = t5;
        $[8] = t6;
      } else {
        t6 = $[8];
      }
      let t7;
      if ($[9] !== modelOptions || $[10] !== t6) {
        t7 = [...modelOptions, t6];
        $[9] = modelOptions;
        $[10] = t6;
        $[11] = t7;
      } else {
        t7 = $[11];
      }
      t4 = t7;
      break bb0;
    }
    t4 = modelOptions;
  }
  const optionsWithInitial = t4;
  let t5;
  if ($[12] !== optionsWithInitial) {
    t5 = optionsWithInitial.map(_temp3);
    $[12] = optionsWithInitial;
    $[13] = t5;
  } else {
    t5 = $[13];
  }
  const selectOptions = t5;
  let t6;
  if ($[14] !== initialValue || $[15] !== selectOptions) {
    t6 = selectOptions.find(_ => optionMatchesPickerValue(_, initialValue))?.value ?? selectOptions[0]?.value ?? undefined;
    $[14] = initialValue;
    $[15] = selectOptions;
    $[16] = t6;
  } else {
    t6 = $[16];
  }
  const initialFocusValue = t6;
  const [focusedValue, setFocusedValue] = useState(initialFocusValue ?? initialValue);
  const visibleCount = Math.min(10, selectOptions.length);
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount);
  let t7;
  if ($[17] !== focusedValue || $[18] !== selectOptions) {
    t7 = selectOptions.find(opt_1 => opt_1.value === focusedValue)?.label;
    $[17] = focusedValue;
    $[18] = selectOptions;
    $[19] = t7;
  } else {
    t7 = $[19];
  }
  const focusedModelName = t7;
  let focusedSupportsEffort;
  let t8;
  if ($[20] !== focusedValue) {
    const focusedModel = resolveOptionModel(focusedValue);
    focusedSupportsEffort = focusedModel ? modelSupportsEffort(focusedModel) : false;
    t8 = focusedModel ? modelSupportsMaxEffort(focusedModel) : false;
    $[20] = focusedValue;
    $[21] = focusedSupportsEffort;
    $[22] = t8;
  } else {
    focusedSupportsEffort = $[21];
    t8 = $[22];
  }
  const focusedSupportsMax = t8;
  const focusedAvailableLevels: EffortLevel[] = (() => {
    const focusedModel = resolveOptionModel(focusedValue);
    return focusedModel ? getAvailableEffortLevels(focusedModel) : [];
  })();
  let t9;
  if ($[23] !== focusedValue) {
    t9 = getDefaultEffortLevelForOption(focusedValue);
    $[23] = focusedValue;
    $[24] = t9;
  } else {
    t9 = $[24];
  }
  const focusedDefaultEffort = t9;
  const displayEffort = focusedAvailableLevels.includes(effort) ? effort : "high";
  let t10;
  if ($[25] !== effortValue || $[26] !== hasToggledEffort || $[83] !== selectOptions) {
    t10 = value => {
      const selectedValue = resolvePickerOptionValue(selectOptions, value) ?? value;
      setFocusedValue(selectedValue);
      if (!hasToggledEffort && effortValue === undefined) {
        setEffort(getDefaultEffortLevelForOption(selectedValue));
      }
    };
    $[25] = effortValue;
    $[26] = hasToggledEffort;
    $[83] = selectOptions;
    $[27] = t10;
  } else {
    t10 = $[27];
  }
  const handleFocus = t10;
  let t11;
  if ($[28] !== focusedDefaultEffort || $[29] !== focusedSupportsEffort || $[30] !== focusedSupportsMax || $[31] !== focusedAvailableLevels) {
    t11 = direction => {
      if (!focusedSupportsEffort) {
        return;
      }
      setEffort(prev => cycleEffortLevel(prev ?? focusedDefaultEffort, direction, focusedAvailableLevels));
      setHasToggledEffort(true);
    };
    $[28] = focusedDefaultEffort;
    $[29] = focusedSupportsEffort;
    $[30] = focusedSupportsMax;
    $[31] = focusedAvailableLevels;
    $[32] = t11;
  } else {
    t11 = $[32];
  }
  const handleCycleEffort = t11;
  const t12 = {
    "modelPicker:decreaseEffort": () => handleCycleEffort("left"),
    "modelPicker:increaseEffort": () => handleCycleEffort("right"),
    ...(onRefresh ? {
      "modelPicker:refresh": () => onRefresh()
    } : {})
  };
  let t13;
  if ($[34] === Symbol.for("react.memo_cache_sentinel")) {
    t13 = {
      context: "ModelPicker"
    };
    $[34] = t13;
  } else {
    t13 = $[34];
  }
  useKeybindings(t12, t13);
  let t14;
  if ($[35] !== effort || $[36] !== hasToggledEffort || $[37] !== onSelect || $[38] !== setAppState || $[39] !== skipSettingsWrite || $[46] !== focusedAvailableLevels || $[47] !== focusedDefaultEffort || $[48] !== selectOptions) {
    t14 = function handleSelect(value_0) {
      const selectedValue = resolvePickerOptionValue(selectOptions, value_0) ?? value_0;
      const selectedModel = resolveOptionModel(selectedValue);
      if (selectedValue !== NO_PREFERENCE && selectedModel && !isModelAllowed(selectedModel)) {
        onSelect(selectedValue === NO_PREFERENCE ? null : selectedValue, undefined);
        return;
      }
      // Clamp effort to a value in the focused model's available levels so
      // emitted/persisted values are always valid for the picked model
      // (e.g. toggled 'xhigh' then picked a model that doesn't support it).
      const clampedEffort = focusedAvailableLevels.includes(effort) ? effort : focusedDefaultEffort;
      logEvent("tengu_model_command_menu_effort", {
        effort: clampedEffort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      if (!skipSettingsWrite) {
        const effortLevel = resolvePickerEffortPersistence(clampedEffort, getDefaultEffortLevelForOption(selectedValue), getSettingsForSource("userSettings")?.effortLevel, hasToggledEffort);
        const persistable = toPersistableEffort(effortLevel);
        if (persistable !== undefined) {
          updateSettingsForSource("userSettings", {
            effortLevel: persistable
          });
        }
        setAppState(prev_0 => ({
          ...prev_0,
          effortValue: effortLevel
        }));
      }
      const selectedEffort = hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? clampedEffort : undefined;
      if (selectedValue === NO_PREFERENCE) {
        onSelect(null, selectedEffort);
        return;
      }
      // Thread the presented option's cross-profile marker (issue #1119) so the
      // /model command activates a provider only for a genuine switch option,
      // never for a literal custom id that merely starts with the prefix.
      // selectOptions is the actual presented list (already captured in this
      // memo's deps) and its entries spread the source ModelOption's
      // `switchToProfileId`. If two options share the selected value (a literal
      // custom id colliding with an encoded switch value), the selection is
      // ambiguous — the Select cannot tell them apart — so treat it as NOT a
      // switch rather than letting the literal borrow another option's marker.
      const selectedSwitchProfileId = resolveSelectedSwitchProfileId(selectOptions, selectedValue);
      onSelect(selectedValue, selectedEffort, selectedSwitchProfileId);
    };
    $[35] = effort;
    $[36] = hasToggledEffort;
    $[37] = onSelect;
    $[38] = setAppState;
    $[39] = skipSettingsWrite;
    $[46] = focusedAvailableLevels;
    $[47] = focusedDefaultEffort;
    $[48] = selectOptions;
    $[40] = t14;
  } else {
    t14 = $[40];
  }
  const handleSelect = t14;
  let t15;
  if ($[41] === Symbol.for("react.memo_cache_sentinel")) {
    t15 = <Text color="remember" bold={true}>Select model</Text>;
    $[41] = t15;
  } else {
    t15 = $[41];
  }
  const t16 = headerText ?? "Switch between Claude models. Applies to this session and future OpenClaude sessions. For other/previous model names, specify with --model.";
  let t17;
  if ($[42] !== t16) {
    t17 = <Text dimColor={true}>{t16}</Text>;
    $[42] = t16;
    $[43] = t17;
  } else {
    t17 = $[43];
  }
  let t18;
  if ($[44] !== sessionModel) {
    t18 = sessionModel && <Text dimColor={true}>Currently using {modelDisplayString(sessionModel)} for this session (set by plan mode). Selecting a model will undo this.</Text>;
    $[44] = sessionModel;
    $[45] = t18;
  } else {
    t18 = $[45];
  }
  const refreshHint = onRefresh ? <ConfigurableShortcutHint action="modelPicker:refresh" context="ModelPicker" fallback="r" description="refresh models" /> : null;
  const discoveryLine = discoveryState ? <Text color={mapDiscoveryToneToColor(discoveryState.tone)}>{discoveryState.message}{refreshHint ? <Text color="subtle"> {" "}· {refreshHint}</Text> : null}</Text> : refreshHint ? <Text dimColor={true}>{refreshHint}</Text> : null;
  const t19 = <Box marginBottom={1} flexDirection="column">{t15}{t17}{t18}{discoveryLine}</Box>;
  const t20 = onCancel ?? _temp4;
  let t21;
  if ($[49] !== handleFocus || $[50] !== handleSelect || $[51] !== initialFocusValue || $[52] !== selectOptions || $[53] !== t20 || $[54] !== visibleCount) {
    t21 = <Box flexDirection="column"><Select defaultValue={initialFocusValue} defaultFocusValue={initialFocusValue} options={selectOptions} onChange={handleSelect} onFocus={handleFocus} onCancel={t20} visibleOptionCount={visibleCount} /></Box>;
    $[49] = handleFocus;
    $[50] = handleSelect;
    $[51] = initialFocusValue;
    $[52] = selectOptions;
    $[53] = t20;
    $[54] = visibleCount;
    $[56] = t21;
  } else {
    t21 = $[56];
  }
  let t22;
  if ($[57] !== hiddenCount) {
    t22 = hiddenCount > 0 && <Box paddingLeft={3}><Text dimColor={true}>and {hiddenCount} more…</Text></Box>;
    $[57] = hiddenCount;
    $[58] = t22;
  } else {
    t22 = $[58];
  }
  let t23;
  if ($[59] !== t21 || $[60] !== t22) {
    t23 = <Box flexDirection="column" marginBottom={1}>{t21}{t22}</Box>;
    $[59] = t21;
    $[60] = t22;
    $[61] = t23;
  } else {
    t23 = $[61];
  }
  let t24;
  if ($[62] !== displayEffort || $[63] !== focusedDefaultEffort || $[64] !== focusedModelName || $[65] !== focusedSupportsEffort) {
    t24 = <Box marginBottom={1} flexDirection="column">{focusedSupportsEffort ? <Text dimColor={true}><EffortLevelIndicator effort={displayEffort} />{" "}{capitalize(displayEffort)} effort{displayEffort === focusedDefaultEffort ? " (default)" : ""}{" "}<Text color="subtle">← → to adjust</Text></Text> : <Text color="subtle"><EffortLevelIndicator effort={undefined} /> Effort not supported{focusedModelName ? ` for ${focusedModelName}` : ""}</Text>}</Box>;
    $[62] = displayEffort;
    $[63] = focusedDefaultEffort;
    $[64] = focusedModelName;
    $[65] = focusedSupportsEffort;
    $[66] = t24;
  } else {
    t24 = $[66];
  }
  let t25;
  if ($[67] !== showFastModeNotice) {
    t25 = isFastModeEnabled() ? showFastModeNotice ? <Box marginBottom={1}><Text dimColor={true}>Fast mode is <Text bold={true}>ON</Text> and available with{" "}{FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models turn off fast mode.</Text></Box> : isFastModeAvailable() && !isFastModeCooldown() ? <Box marginBottom={1}><Text dimColor={true}>Use <Text bold={true}>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).</Text></Box> : null : null;
    $[67] = showFastModeNotice;
    $[68] = t25;
  } else {
    t25 = $[68];
  }
  let t26;
  if ($[69] !== t19 || $[70] !== t23 || $[71] !== t24 || $[72] !== t25) {
    t26 = <Box flexDirection="column">{t19}{t23}{t24}{t25}</Box>;
    $[69] = t19;
    $[70] = t23;
    $[71] = t24;
    $[72] = t25;
    $[73] = t26;
  } else {
    t26 = $[73];
  }
  let t27;
  if ($[74] !== exitState || $[75] !== isStandaloneCommand || $[76] !== refreshHint) {
    t27 = isStandaloneCommand && <Text dimColor={true} italic={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : <Byline><KeyboardShortcutHint shortcut="Enter" action="confirm" />{refreshHint}<ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" /></Byline>}</Text>;
    $[74] = exitState;
    $[75] = isStandaloneCommand;
    $[76] = refreshHint;
    $[82] = t27;
  } else {
    t27 = $[82];
  }
  let t28;
  if ($[77] !== t26 || $[78] !== t27) {
    t28 = <Box flexDirection="column">{t26}{t27}</Box>;
    $[77] = t26;
    $[78] = t27;
    $[79] = t28;
  } else {
    t28 = $[79];
  }
  const content = t28;
  if (!isStandaloneCommand) {
    return content;
  }
  let t29;
  if ($[80] !== content) {
    t29 = <Pane color="permission">{content}</Pane>;
    $[80] = content;
    $[81] = t29;
  } else {
    t29 = $[81];
  }
  return t29;
}
function _temp4() {}
function _temp3(opt_0) {
  return {
    ...opt_0,
    value: opt_0.value === null ? NO_PREFERENCE : opt_0.value
  };
}
function _temp2(s_0) {
  return s_0.effortValue;
}
function _temp(s) {
  return isFastModeEnabled() ? s.fastMode : false;
}
// A picker value is a genuine cross-profile switch only when the option with
// that exact value carries the `switchToProfileId` marker. A literal custom
// model id that merely starts with `__switch_profile__:` is a plain option with
// no marker and must NOT be decoded — otherwise the display resolver would
// strip a real model id down to its `:`-tail. getModelOptions() is the
// authority for the switch options (they only appear in the base list, never in
// a discovery override, and discovered ids never carry the prefix). If two
// options share the value (a literal id colliding with an encoded switch
// value), the match is ambiguous, so require exactly one option and treat that
// lone option's marker as authoritative.
//
// Values that don't start with the switch prefix can never match a switch
// option (switch values are always prefix-encoded), so short-circuit before
// rebuilding the full getModelOptions() list — this runs on every render and
// every focus change while the picker is open, and the rebuild is the dominant
// cost with large model catalogs (e.g. hundreds of discovered/catalogued
// models).
export function isGenuineSwitchProfileValue(value: string): boolean {
  if (!value.startsWith(SWITCH_PROFILE_VALUE_PREFIX)) {
    return false
  }
  return resolveSelectedSwitchProfileId(getModelOptions(), value) !== undefined;
}
function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === NO_PREFERENCE) return getDefaultMainLoopModel();
  // Cross-profile entries from /model encode the picker value as
  // `__switch_profile__:<profileId>:<model>`. Effort / display logic needs
  // the bare target model id (e.g. `gpt-5.4`) — otherwise
  // `modelSupportsEffort` sees the prefixed string and reports
  // "Effort not supported" even for reasoning-capable models. Decode only when
  // the value is a genuine marker-backed switch option, not any prefixed id.
  const switched = isGenuineSwitchProfileValue(value)
    ? parseSwitchProfileValue(value)
    : null;
  return parseUserSpecifiedModel(switched ? switched.model : value);
}
function EffortLevelIndicator(t0) {
  const $ = _c(5);
  const {
    effort
  } = t0;
  const t1 = effort ? "claude" : "subtle";
  const t2 = effort ?? "low";
  let t3;
  if ($[0] !== t2) {
    t3 = effortLevelToSymbol(t2);
    $[0] = t2;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  let t4;
  if ($[2] !== t1 || $[3] !== t3) {
    t4 = <Text color={t1}>{t3}</Text>;
    $[2] = t1;
    $[3] = t3;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  return t4;
}
function cycleEffortLevel(current: EffortLevel, direction: 'left' | 'right', levels: EffortLevel[]): EffortLevel {
  // If the current level isn't in the cycle (e.g. 'max' after switching to a
  // non-max model), clamp to 'high'.
  const idx = levels.indexOf(current);
  const currentIndex = idx !== -1 ? idx : levels.indexOf('high');
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!;
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]!;
  }
}
function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel();
  const defaultValue = getDefaultEffortForModel(resolved);
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high';
}
