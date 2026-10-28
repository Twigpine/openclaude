import { c as _c } from "react-compiler-runtime";
import React, { useRef, useState } from 'react';
import { Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { Box, Text } from '../../ink.js';
type Props = {
  onProceed: (signal: AbortSignal) => Promise<void>;
  onCancel: () => void;
};
export function UltrareviewOverageDialog(t0) {
  const $ = _c(15);
  const {
    onProceed,
    onCancel
  } = t0;
  const [isLaunching, setIsLaunching] = useState(false);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = new AbortController();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const abortControllerRef = useRef(t1);
  let t2;
  if ($[1] !== onCancel || $[2] !== onProceed) {
    t2 = value => {
      if (value === "proceed") {
        setIsLaunching(true);
        onProceed(abortControllerRef.current.signal).catch(() => setIsLaunching(false));
      } else {
        onCancel();
      }
    };
    $[1] = onCancel;
    $[2] = onProceed;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const handleSelect = t2;
  let t3;
  if ($[4] !== onCancel) {
    t3 = () => {
      abortControllerRef.current.abort();
      onCancel();
    };
    $[4] = onCancel;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const handleCancel = t3;
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [{
      label: "Proceed with Extra Usage billing",
      value: "proceed"
    }, {
      label: "Cancel",
      value: "cancel"
    }];
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  const options = t4;
  let t5;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text>Your free ultrareviews for this organization are used. Further reviews bill as Extra Usage (pay-per-use).</Text>;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  let t6;
  if ($[8] !== handleCancel || $[9] !== handleSelect || $[10] !== isLaunching) {
    t6 = <Box flexDirection="column" gap={1}>{t5}{isLaunching ? <Text color="background">Launching…</Text> : <Select options={options} onChange={handleSelect} onCancel={handleCancel} />}</Box>;
    $[8] = handleCancel;
    $[9] = handleSelect;
    $[10] = isLaunching;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  let t7;
  if ($[12] !== handleCancel || $[13] !== t6) {
    t7 = <Dialog title="Ultrareview billing" onCancel={handleCancel} color="background">{t6}</Dialog>;
    $[12] = handleCancel;
    $[13] = t6;
    $[14] = t7;
  } else {
    t7 = $[14];
  }
  return t7;
}
