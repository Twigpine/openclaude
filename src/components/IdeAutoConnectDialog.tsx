import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { Text } from '../ink.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { isSupportedTerminal } from '../utils/ide.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
type IdeAutoConnectDialogProps = {
  onComplete: () => void;
};
export function IdeAutoConnectDialog(t0) {
  const $ = _c(9);
  const {
    onComplete
  } = t0;
  let t1;
  if ($[0] !== onComplete) {
    t1 = async value => {
      const autoConnect = value === "yes";
      saveGlobalConfig(current => ({
        ...current,
        autoConnectIde: autoConnect,
        hasIdeAutoConnectDialogBeenShown: true
      }));
      onComplete();
    };
    $[0] = onComplete;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const handleSelect = t1;
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = [{
      label: "Yes",
      value: "yes"
    }, {
      label: "No",
      value: "no"
    }];
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const options = t2;
  let t3;
  if ($[3] !== handleSelect) {
    t3 = <Select options={options} onChange={handleSelect} defaultValue="yes" />;
    $[3] = handleSelect;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text dimColor={true}>You can also configure this in /config or with the --ide flag</Text>;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] !== onComplete || $[7] !== t3) {
    t5 = <Dialog title="Do you wish to enable auto-connect to IDE?" color="ide" onCancel={onComplete}>{t3}{t4}</Dialog>;
    $[6] = onComplete;
    $[7] = t3;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  return t5;
}
export function shouldShowAutoConnectDialog(): boolean {
  const config = getGlobalConfig();
  return !isSupportedTerminal() && config.autoConnectIde !== true && config.hasIdeAutoConnectDialogBeenShown !== true;
}
type IdeDisableAutoConnectDialogProps = {
  onComplete: (disableAutoConnect: boolean) => void;
};
export function IdeDisableAutoConnectDialog(t0) {
  const $ = _c(10);
  const {
    onComplete
  } = t0;
  let t1;
  if ($[0] !== onComplete) {
    t1 = value => {
      const disableAutoConnect = value === "yes";
      if (disableAutoConnect) {
        saveGlobalConfig(_temp);
      }
      onComplete(disableAutoConnect);
    };
    $[0] = onComplete;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const handleSelect = t1;
  let t2;
  if ($[2] !== onComplete) {
    t2 = () => {
      onComplete(false);
    };
    $[2] = onComplete;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const handleCancel = t2;
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = [{
      label: "No",
      value: "no"
    }, {
      label: "Yes",
      value: "yes"
    }];
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const options = t3;
  let t4;
  if ($[5] !== handleSelect) {
    t4 = <Select options={options} onChange={handleSelect} defaultValue="no" />;
    $[5] = handleSelect;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== handleCancel || $[8] !== t4) {
    t5 = <Dialog title="Do you wish to disable auto-connect to IDE?" subtitle="You can also configure this in /config" onCancel={handleCancel} color="ide">{t4}</Dialog>;
    $[7] = handleCancel;
    $[8] = t4;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
function _temp(current) {
  return {
    ...current,
    autoConnectIde: false
  };
}
export function shouldShowDisableAutoConnectDialog(): boolean {
  const config = getGlobalConfig();
  return !isSupportedTerminal() && config.autoConnectIde === true;
}
