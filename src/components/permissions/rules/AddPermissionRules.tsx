import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Select } from '../../../components/CustomSelect/select.js';
import { Box, Text } from '../../../ink.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import type { PermissionBehavior, PermissionRule, PermissionRuleValue } from '../../../utils/permissions/PermissionRule.js';
import { applyPermissionUpdate, persistPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js';
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js';
import { detectUnreachableRules, type UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js';
import { SandboxManager } from '../../../utils/sandbox/sandbox-adapter.js';
import { type EditableSettingSource, SOURCES } from '../../../utils/settings/constants.js';
import { getRelativeSettingsFilePathForSource } from '../../../utils/settings/settings.js';
import { getUserSettingsDisplayPath } from '../../../utils/openclaudeDisplayPaths.js';
import { plural } from '../../../utils/stringUtils.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { Dialog } from '../../design-system/Dialog.js';
import { PermissionRuleDescription } from './PermissionRuleDescription.js';
export function optionForPermissionSaveDestination(saveDestination: EditableSettingSource): OptionWithDescription {
  switch (saveDestination) {
    case 'localSettings':
      return {
        label: 'Project settings (local)',
        description: `Saved in ${getRelativeSettingsFilePathForSource('localSettings')}`,
        value: saveDestination
      };
    case 'projectSettings':
      return {
        label: 'Project settings',
        description: `Checked in at ${getRelativeSettingsFilePathForSource('projectSettings')}`,
        value: saveDestination
      };
    case 'userSettings':
      return {
        label: 'User settings',
        description: `Saved in ${getUserSettingsDisplayPath()}`,
        value: saveDestination
      };
  }
}
type Props = {
  onAddRules: (rules: PermissionRule[], unreachable?: UnreachableRule[]) => void;
  onCancel: () => void;
  ruleValues: PermissionRuleValue[];
  ruleBehavior: PermissionBehavior;
  initialContext: ToolPermissionContext;
  setToolPermissionContext: (newContext: ToolPermissionContext) => void;
};
export function AddPermissionRules(t0) {
  const $ = _c(26);
  const {
    onAddRules,
    onCancel,
    ruleValues,
    ruleBehavior,
    initialContext,
    setToolPermissionContext
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = SOURCES.map(optionForPermissionSaveDestination);
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const allOptions = t1;
  let t2;
  if ($[1] !== initialContext || $[2] !== onAddRules || $[3] !== onCancel || $[4] !== ruleBehavior || $[5] !== ruleValues || $[6] !== setToolPermissionContext) {
    t2 = selectedValue => {
      if (selectedValue === "cancel") {
        onCancel();
        return;
      } else {
        if ((SOURCES as readonly string[]).includes(selectedValue)) {
          const destination = selectedValue as EditableSettingSource;
          const updatedContext = applyPermissionUpdate(initialContext, {
            type: "addRules",
            rules: ruleValues,
            behavior: ruleBehavior,
            destination
          });
          persistPermissionUpdate({
            type: "addRules",
            rules: ruleValues,
            behavior: ruleBehavior,
            destination
          });
          setToolPermissionContext(updatedContext);
          const rules = ruleValues.map(ruleValue => ({
            ruleValue,
            ruleBehavior,
            source: destination
          }));
          const sandboxAutoAllowEnabled = SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled();
          const allUnreachable = detectUnreachableRules(updatedContext, {
            sandboxAutoAllowEnabled
          });
          const newUnreachable = allUnreachable.filter(u => ruleValues.some(rv => rv.toolName === u.rule.ruleValue.toolName && rv.ruleContent === u.rule.ruleValue.ruleContent));
          onAddRules(rules, newUnreachable.length > 0 ? newUnreachable : undefined);
        }
      }
    };
    $[1] = initialContext;
    $[2] = onAddRules;
    $[3] = onCancel;
    $[4] = ruleBehavior;
    $[5] = ruleValues;
    $[6] = setToolPermissionContext;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  const onSelect = t2;
  let t3;
  if ($[8] !== ruleValues.length) {
    t3 = plural(ruleValues.length, "rule");
    $[8] = ruleValues.length;
    $[9] = t3;
  } else {
    t3 = $[9];
  }
  const title = `Add ${ruleBehavior} permission ${t3}`;
  let t4;
  if ($[10] !== ruleValues) {
    t4 = ruleValues.map(_temp);
    $[10] = ruleValues;
    $[11] = t4;
  } else {
    t4 = $[11];
  }
  let t5;
  if ($[12] !== t4) {
    t5 = <Box flexDirection="column" paddingX={2}>{t4}</Box>;
    $[12] = t4;
    $[13] = t5;
  } else {
    t5 = $[13];
  }
  const t6 = ruleValues.length === 1 ? "Where should this rule be saved?" : "Where should these rules be saved?";
  let t7;
  if ($[14] !== t6) {
    t7 = <Text>{t6}</Text>;
    $[14] = t6;
    $[15] = t7;
  } else {
    t7 = $[15];
  }
  let t8;
  if ($[16] !== onSelect) {
    t8 = <Select options={allOptions} onChange={onSelect} />;
    $[16] = onSelect;
    $[17] = t8;
  } else {
    t8 = $[17];
  }
  let t9;
  if ($[18] !== t7 || $[19] !== t8) {
    t9 = <Box flexDirection="column" marginY={1}>{t7}{t8}</Box>;
    $[18] = t7;
    $[19] = t8;
    $[20] = t9;
  } else {
    t9 = $[20];
  }
  let t10;
  if ($[21] !== onCancel || $[22] !== t5 || $[23] !== t9 || $[24] !== title) {
    t10 = <Dialog title={title} onCancel={onCancel} color="permission">{t5}{t9}</Dialog>;
    $[21] = onCancel;
    $[22] = t5;
    $[23] = t9;
    $[24] = title;
    $[25] = t10;
  } else {
    t10 = $[25];
  }
  return t10;
}
function _temp(ruleValue_0) {
  return <Box flexDirection="column" key={permissionRuleValueToString(ruleValue_0)}><Text bold={true}>{permissionRuleValueToString(ruleValue_0)}</Text><PermissionRuleDescription ruleValue={ruleValue_0} /></Box>;
}
