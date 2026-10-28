import { c as _c } from "react-compiler-runtime";
import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Pane } from '../../components/design-system/Pane.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
type Platform = 'ios' | 'android';
type Props = {
  onDone: () => void;
};
const PLATFORMS: Record<Platform, {
  url: string;
}> = {
  ios: {
    url: 'https://apps.apple.com/app/claude-by-anthropic/id6473753684'
  },
  android: {
    url: 'https://play.google.com/store/apps/details?id=com.anthropic.claude'
  }
};
function MobileQRCode(t0) {
  const $ = _c(52);
  const {
    onDone
  } = t0;
  const [platform, setPlatform] = useState("ios");
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      ios: "",
      android: ""
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [qrCodes, setQrCodes] = useState(t1);
  const {
    url
  } = PLATFORMS[platform];
  const qrCode = qrCodes[platform];
  let t2;
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      const generateQRCodes = async function generateQRCodes() {
        const [ios, android] = await Promise.all([qrToString(PLATFORMS.ios.url, {
          type: "utf8",
          errorCorrectionLevel: "L"
        }), qrToString(PLATFORMS.android.url, {
          type: "utf8",
          errorCorrectionLevel: "L"
        })]);
        setQrCodes({
          ios,
          android
        });
      };
      generateQRCodes().catch(_temp);
    };
    t3 = [];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  useEffect(t2, t3);
  let t4;
  if ($[3] !== onDone) {
    t4 = () => {
      onDone();
    };
    $[3] = onDone;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  const handleClose = t4;
  let t5;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      context: "Confirmation"
    };
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  useKeybinding("confirm:no", handleClose, t5);
  let t6;
  if ($[6] !== onDone) {
    t6 = function handleKeyDown(e) {
      if (e.key === "q" || e.ctrl && e.key === "c") {
        e.preventDefault();
        onDone();
        return;
      }
      if (e.key === "tab" || e.key === "left" || e.key === "right") {
        e.preventDefault();
        setPlatform(_temp2);
      }
    };
    $[6] = onDone;
    $[7] = t6;
  } else {
    t6 = $[7];
  }
  const handleKeyDown = t6;
  let T0;
  let T1;
  let t10;
  let t11;
  let t12;
  let t13;
  let t7;
  let t8;
  let t9;
  if ($[8] !== handleKeyDown || $[9] !== qrCode) {
    const lines = qrCode.split("\n").filter(_temp3);
    T1 = Pane;
    T0 = Box;
    t7 = "column";
    t8 = 0;
    t9 = true;
    t10 = handleKeyDown;
    if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
      t11 = <Text> </Text>;
      t12 = <Text> </Text>;
      $[19] = t11;
      $[20] = t12;
    } else {
      t11 = $[19];
      t12 = $[20];
    }
    t13 = lines.map(_temp4);
    $[8] = handleKeyDown;
    $[9] = qrCode;
    $[10] = T0;
    $[11] = T1;
    $[12] = t10;
    $[13] = t11;
    $[14] = t12;
    $[15] = t13;
    $[16] = t7;
    $[17] = t8;
    $[18] = t9;
  } else {
    T0 = $[10];
    T1 = $[11];
    t10 = $[12];
    t11 = $[13];
    t12 = $[14];
    t13 = $[15];
    t7 = $[16];
    t8 = $[17];
    t9 = $[18];
  }
  let t14;
  let t15;
  if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
    t14 = <Text> </Text>;
    t15 = <Text> </Text>;
    $[21] = t14;
    $[22] = t15;
  } else {
    t14 = $[21];
    t15 = $[22];
  }
  const t16 = platform === "ios";
  const t17 = platform === "ios";
  let t18;
  if ($[23] !== t16 || $[24] !== t17) {
    t18 = <Text bold={t16} underline={t17}>iOS</Text>;
    $[23] = t16;
    $[24] = t17;
    $[25] = t18;
  } else {
    t18 = $[25];
  }
  let t19;
  if ($[26] === Symbol.for("react.memo_cache_sentinel")) {
    t19 = <Text dimColor={true}>{" / "}</Text>;
    $[26] = t19;
  } else {
    t19 = $[26];
  }
  const t20 = platform === "android";
  const t21 = platform === "android";
  let t22;
  if ($[27] !== t20 || $[28] !== t21) {
    t22 = <Text bold={t20} underline={t21}>Android</Text>;
    $[27] = t20;
    $[28] = t21;
    $[29] = t22;
  } else {
    t22 = $[29];
  }
  let t23;
  if ($[30] !== t18 || $[31] !== t22) {
    t23 = <Text>{t18}{t19}{t22}</Text>;
    $[30] = t18;
    $[31] = t22;
    $[32] = t23;
  } else {
    t23 = $[32];
  }
  let t24;
  if ($[33] === Symbol.for("react.memo_cache_sentinel")) {
    t24 = <Text dimColor={true}>(tab to switch, esc to close)</Text>;
    $[33] = t24;
  } else {
    t24 = $[33];
  }
  let t25;
  if ($[34] !== t23) {
    t25 = <Box flexDirection="row" gap={2}>{t23}{t24}</Box>;
    $[34] = t23;
    $[35] = t25;
  } else {
    t25 = $[35];
  }
  let t26;
  if ($[36] !== url) {
    t26 = <Text dimColor={true}>{url}</Text>;
    $[36] = url;
    $[37] = t26;
  } else {
    t26 = $[37];
  }
  let t27;
  if ($[38] !== T0 || $[39] !== t10 || $[40] !== t11 || $[41] !== t12 || $[42] !== t13 || $[43] !== t25 || $[44] !== t26 || $[45] !== t7 || $[46] !== t8 || $[47] !== t9) {
    t27 = <T0 flexDirection={t7} tabIndex={t8} autoFocus={t9} onKeyDown={t10}>{t11}{t12}{t13}{t14}{t15}{t25}{t26}</T0>;
    $[38] = T0;
    $[39] = t10;
    $[40] = t11;
    $[41] = t12;
    $[42] = t13;
    $[43] = t25;
    $[44] = t26;
    $[45] = t7;
    $[46] = t8;
    $[47] = t9;
    $[48] = t27;
  } else {
    t27 = $[48];
  }
  let t28;
  if ($[49] !== T1 || $[50] !== t27) {
    t28 = <T1>{t27}</T1>;
    $[49] = T1;
    $[50] = t27;
    $[51] = t28;
  } else {
    t28 = $[51];
  }
  return t28;
}
function _temp4(line_0, i) {
  return <Text key={i}>{line_0}</Text>;
}
function _temp3(line) {
  return line.length > 0;
}
function _temp2(prev) {
  return prev === "ios" ? "android" : "ios";
}
function _temp() {}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <MobileQRCode onDone={onDone} />;
}
