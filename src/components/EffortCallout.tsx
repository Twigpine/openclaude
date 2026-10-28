import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useRef } from 'react';
import { Box, Text } from '../ink.js';
import { isMaxSubscriber, isProSubscriber, isTeamSubscriber } from '../utils/auth.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import type { EffortLevel } from '../utils/effort.js';
import { convertEffortValueToLevel, getDefaultEffortForModel, getOpusDefaultEffortConfig, toPersistableEffort } from '../utils/effort.js';
import { parseUserSpecifiedModel } from '../utils/model/model.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';
import { effortLevelToSymbol } from './EffortIndicator.js';
import { PermissionDialog } from './permissions/PermissionDialog.js';
type EffortCalloutSelection = EffortLevel | undefined | 'dismiss';
type Props = {
  model: string;
  onDone: (selection: EffortCalloutSelection) => void;
};
const AUTO_DISMISS_MS = 30_000;
export function EffortCallout(t0) {
  const $ = _c(18);
  const {
    model,
    onDone
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getOpusDefaultEffortConfig();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const defaultEffortConfig = t1;
  const onDoneRef = useRef(onDone);
  let t2;
  if ($[1] !== onDone) {
    t2 = () => {
      onDoneRef.current = onDone;
    };
    $[1] = onDone;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  useEffect(t2);
  let t3;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = () => {
      onDoneRef.current("dismiss");
    };
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const handleCancel = t3;
  let t4;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [];
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  useEffect(_temp, t4);
  let t5;
  let t6;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = () => {
      const timeoutId = setTimeout(handleCancel, AUTO_DISMISS_MS);
      return () => clearTimeout(timeoutId);
    };
    t6 = [handleCancel];
    $[5] = t5;
    $[6] = t6;
  } else {
    t5 = $[5];
    t6 = $[6];
  }
  useEffect(t5, t6);
  let t7;
  if ($[7] !== model) {
    const defaultEffort = getDefaultEffortForModel(model);
    t7 = defaultEffort ? convertEffortValueToLevel(defaultEffort) : "high";
    $[7] = model;
    $[8] = t7;
  } else {
    t7 = $[8];
  }
  const defaultLevel = t7;
  let t8;
  if ($[9] !== defaultLevel) {
    t8 = value => {
      const effortLevel = value === defaultLevel ? undefined : value;
      updateSettingsForSource("userSettings", {
        effortLevel: toPersistableEffort(effortLevel)
      });
      onDoneRef.current(value);
    };
    $[9] = defaultLevel;
    $[10] = t8;
  } else {
    t8 = $[10];
  }
  const handleSelect = t8;
  let t9;
  if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
    t9 = [{
      label: <EffortOptionLabel level="medium" text="Medium (recommended)" />,
      value: "medium"
    }, {
      label: <EffortOptionLabel level="high" text="High" />,
      value: "high"
    }, {
      label: <EffortOptionLabel level="low" text="Low" />,
      value: "low"
    }];
    $[11] = t9;
  } else {
    t9 = $[11];
  }
  const options = t9;
  let t10;
  if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = <Box marginBottom={1} flexDirection="column"><Text>{defaultEffortConfig.dialogDescription}</Text></Box>;
    $[12] = t10;
  } else {
    t10 = $[12];
  }
  let t11;
  if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = <EffortIndicatorSymbol level="low" />;
    $[13] = t11;
  } else {
    t11 = $[13];
  }
  let t12;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = <EffortIndicatorSymbol level="medium" />;
    $[14] = t12;
  } else {
    t12 = $[14];
  }
  let t13;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t13 = <Box marginBottom={1}><Text dimColor={true}>{t11} low {"\xB7"}{" "}{t12} medium {"\xB7"}{" "}<EffortIndicatorSymbol level="high" /> high</Text></Box>;
    $[15] = t13;
  } else {
    t13 = $[15];
  }
  let t14;
  if ($[16] !== handleSelect) {
    t14 = <PermissionDialog title={defaultEffortConfig.dialogTitle}><Box flexDirection="column" paddingX={2} paddingY={1}>{t10}{t13}<Select options={options} onChange={handleSelect} onCancel={handleCancel} /></Box></PermissionDialog>;
    $[16] = handleSelect;
    $[17] = t14;
  } else {
    t14 = $[17];
  }
  return t14;
}
function _temp() {
  markV2Dismissed();
}
function EffortIndicatorSymbol(t0) {
  const $ = _c(4);
  const {
    level
  } = t0;
  let t1;
  if ($[0] !== level) {
    t1 = effortLevelToSymbol(level);
    $[0] = level;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1) {
    t2 = <Text color="suggestion">{t1}</Text>;
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  return t2;
}
function EffortOptionLabel(t0) {
  const $ = _c(5);
  const {
    level,
    text
  } = t0;
  let t1;
  if ($[0] !== level) {
    t1 = <EffortIndicatorSymbol level={level} />;
    $[0] = level;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1 || $[3] !== text) {
    t2 = <>{t1} {text}</>;
    $[2] = t1;
    $[3] = text;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  return t2;
}

/**
 * Check whether to show the effort callout.
 *
 * Audience:
 * - Pro: already had medium default; show unless they saw v1 (effortCalloutDismissed)
 * - Max/Team: getting medium via tengu_grey_step2 config; show when enabled
 * - Everyone else: mark as dismissed so it never shows
 */
// Recent Opus models that get the medium-effort default and therefore the
// callout. The default Opus is now 4.8, so it must be covered alongside 4.7/4.6.
// Exported as a pure predicate so the regression can be tested deterministically
// without mocking the subscriber/config gates (see EffortCallout.modelGate.test).
export function effortCalloutCoversModel(model: string): boolean {
  const parsed = parseUserSpecifiedModel(model).toLowerCase();
  return (
    parsed.includes('opus-4-8') ||
    parsed.includes('opus-4-7') ||
    parsed.includes('opus-4-6')
  );
}

export function shouldShowEffortCallout(model: string): boolean {
  if (!effortCalloutCoversModel(model)) {
    return false;
  }
  const config = getGlobalConfig();
  if (config.effortCalloutV2Dismissed) return false;

  // Don't show to brand-new users — they never knew the old default, so this
  // isn't a change for them. Mark as dismissed so it stays suppressed.
  if (config.numStartups <= 1) {
    markV2Dismissed();
    return false;
  }

  // Pro users already had medium default before this PR. Show the new copy,
  // but skip if they already saw the v1 dialog — no point nagging twice.
  if (isProSubscriber()) {
    if (config.effortCalloutDismissed) {
      markV2Dismissed();
      return false;
    }
    return getOpusDefaultEffortConfig().enabled;
  }

  // Max/Team are the target of the tengu_grey_step2 config.
  // Don't mark dismissed when config is disabled — they should see the dialog
  // once it's enabled for them.
  if (isMaxSubscriber() || isTeamSubscriber()) {
    return getOpusDefaultEffortConfig().enabled;
  }

  // Everyone else (free tier, API key, non-subscribers): not in scope.
  markV2Dismissed();
  return false;
}
function markV2Dismissed(): void {
  saveGlobalConfig(current => {
    if (current.effortCalloutV2Dismissed) return current;
    return {
      ...current,
      effortCalloutV2Dismissed: true
    };
  });
}
