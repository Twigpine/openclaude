import { c as _c } from "react-compiler-runtime";
import { Text } from '../ink.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel';
type Props = {
  currentVersion: string;
  onChoice: (choice: ChannelDowngradeChoice) => void;
};

/**
 * Dialog shown when switching from latest to stable channel.
 * Allows user to choose whether to downgrade or stay on current version.
 */
export function ChannelDowngradeDialog(t0: Props) {
  const $ = _c(17);
  const {
    currentVersion,
    onChoice
  } = t0;
  let t1;
  if ($[0] !== onChoice) {
    t1 = function handleSelect(value: ChannelDowngradeChoice) {
      onChoice(value);
    };
    $[0] = onChoice;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const handleSelect = t1;
  let t2;
  if ($[2] !== onChoice) {
    t2 = function handleCancel() {
      onChoice("cancel");
    };
    $[2] = onChoice;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const handleCancel = t2;
  let t3;
  if ($[4] !== currentVersion) {
    t3 = <Text>The stable channel may have an older version than what you&apos;re currently running ({currentVersion}).</Text>;
    $[4] = currentVersion;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text dimColor={true}>How would you like to handle this?</Text>;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      label: "Allow possible downgrade to stable version",
      value: "downgrade" as ChannelDowngradeChoice
    };
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  const t6 = `Stay on current version (${currentVersion}) until stable catches up`;
  let t7;
  if ($[8] !== t6) {
    t7 = [t5, {
      label: t6,
      value: "stay" as ChannelDowngradeChoice
    }];
    $[8] = t6;
    $[9] = t7;
  } else {
    t7 = $[9];
  }
  let t8;
  if ($[10] !== handleSelect || $[11] !== t7) {
    t8 = <Select options={t7} onChange={handleSelect} />;
    $[10] = handleSelect;
    $[11] = t7;
    $[12] = t8;
  } else {
    t8 = $[12];
  }
  let t9;
  if ($[13] !== handleCancel || $[14] !== t3 || $[15] !== t8) {
    t9 = <Dialog title="Switch to Stable Channel" onCancel={handleCancel} color="permission" hideBorder={true} hideInputGuide={true}>{t3}{t4}{t8}</Dialog>;
    $[13] = handleCancel;
    $[14] = t3;
    $[15] = t8;
    $[16] = t9;
  } else {
    t9 = $[16];
  }
  return t9;
}
