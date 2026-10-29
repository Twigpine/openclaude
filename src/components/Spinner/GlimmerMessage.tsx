import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { stringWidth } from '../../ink/stringWidth.js';
import { Text, useTheme } from '../../ink.js';
import { getGraphemeSegmenter } from '../../utils/intl.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import type { SpinnerMode } from './types.js';
import { interpolateColor, parseRGB, toRGBColor } from './utils.js';
type Props = {
  message: string;
  mode: SpinnerMode;
  messageColor: keyof Theme;
  glimmerIndex: number;
  flashOpacity: number;
  shimmerColor: keyof Theme;
  stalledIntensity?: number;
};
const ERROR_RED = {
  r: 171,
  g: 43,
  b: 63
};
export function GlimmerMessage(t0) {
  const $ = _c(75);
  const {
    message,
    mode,
    messageColor,
    glimmerIndex,
    flashOpacity,
    shimmerColor,
    stalledIntensity: t1
  } = t0;
  const stalledIntensity = t1 === undefined ? 0 : t1;
  const [themeName] = useTheme();
  let messageWidth;
  let segments;
  let t2;
  if ($[0] !== flashOpacity || $[1] !== message || $[2] !== messageColor || $[3] !== mode || $[4] !== shimmerColor || $[5] !== stalledIntensity || $[6] !== themeName) {
    t2 = Symbol.for("react.early_return_sentinel");
    bb0: {
      const theme = getTheme(themeName);
      let segs;
      if ($[10] !== message) {
        segs = [];
        for (const {
          segment
        } of getGraphemeSegmenter().segment(message)) {
          segs.push({
            segment,
            width: stringWidth(segment)
          });
        }
        $[10] = message;
        $[11] = segs;
      } else {
        segs = $[11];
      }
      let t3;
      if ($[12] !== message) {
        t3 = stringWidth(message);
        $[12] = message;
        $[13] = t3;
      } else {
        t3 = $[13];
      }
      let t4;
      if ($[14] !== segs || $[15] !== t3) {
        t4 = {
          segments: segs,
          messageWidth: t3
        };
        $[14] = segs;
        $[15] = t3;
        $[16] = t4;
      } else {
        t4 = $[16];
      }
      ({
        segments,
        messageWidth
      } = t4);
      if (!message) {
        t2 = null;
        break bb0;
      }
      if (stalledIntensity > 0) {
        const baseColorStr = theme[messageColor];
        const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
        if (baseRGB) {
          const interpolated = interpolateColor(baseRGB, ERROR_RED, stalledIntensity);
          const color = toRGBColor(interpolated);
          let t5;
          if ($[17] !== color) {
            t5 = <Text color={color}> </Text>;
            $[17] = color;
            $[18] = t5;
          } else {
            t5 = $[18];
          }
          t2 = <><Text color={color}>{message}</Text>{t5}</>;
          break bb0;
        }
        const color_0 = stalledIntensity > 0.5 ? "error" : messageColor;
        let t5;
        if ($[19] !== color_0 || $[20] !== message) {
          t5 = <Text color={color_0}>{message}</Text>;
          $[19] = color_0;
          $[20] = message;
          $[21] = t5;
        } else {
          t5 = $[21];
        }
        let t6;
        if ($[22] !== color_0) {
          t6 = <Text color={color_0}> </Text>;
          $[22] = color_0;
          $[23] = t6;
        } else {
          t6 = $[23];
        }
        let t7;
        if ($[24] !== t5 || $[25] !== t6) {
          t7 = <>{t5}{t6}</>;
          $[24] = t5;
          $[25] = t6;
          $[26] = t7;
        } else {
          t7 = $[26];
        }
        t2 = t7;
        break bb0;
      }
      if (mode === "tool-use") {
        const baseColorStr_0 = theme[messageColor];
        const shimmerColorStr = theme[shimmerColor];
        const baseRGB_0 = baseColorStr_0 ? parseRGB(baseColorStr_0) : null;
        const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null;
        if (baseRGB_0 && shimmerRGB) {
          const interpolated_0 = interpolateColor(baseRGB_0, shimmerRGB, flashOpacity);
          const t5 = <Text color={toRGBColor(interpolated_0)}>{message}</Text>;
          let t6;
          if ($[27] !== messageColor) {
            t6 = <Text color={messageColor}> </Text>;
            $[27] = messageColor;
            $[28] = t6;
          } else {
            t6 = $[28];
          }
          let t7;
          if ($[29] !== t5 || $[30] !== t6) {
            t7 = <>{t5}{t6}</>;
            $[29] = t5;
            $[30] = t6;
            $[31] = t7;
          } else {
            t7 = $[31];
          }
          t2 = t7;
          break bb0;
        }
        const color_1 = flashOpacity > 0.5 ? shimmerColor : messageColor;
        let t5;
        if ($[32] !== color_1 || $[33] !== message) {
          t5 = <Text color={color_1}>{message}</Text>;
          $[32] = color_1;
          $[33] = message;
          $[34] = t5;
        } else {
          t5 = $[34];
        }
        let t6;
        if ($[35] !== messageColor) {
          t6 = <Text color={messageColor}> </Text>;
          $[35] = messageColor;
          $[36] = t6;
        } else {
          t6 = $[36];
        }
        let t7;
        if ($[37] !== t5 || $[38] !== t6) {
          t7 = <>{t5}{t6}</>;
          $[37] = t5;
          $[38] = t6;
          $[39] = t7;
        } else {
          t7 = $[39];
        }
        t2 = t7;
        break bb0;
      }
    }
    $[0] = flashOpacity;
    $[1] = message;
    $[2] = messageColor;
    $[3] = mode;
    $[4] = shimmerColor;
    $[5] = stalledIntensity;
    $[6] = themeName;
    $[7] = messageWidth;
    $[8] = segments;
    $[9] = t2;
  } else {
    messageWidth = $[7];
    segments = $[8];
    t2 = $[9];
  }
  if (t2 !== Symbol.for("react.early_return_sentinel")) {
    return t2;
  }
  const shimmerStart = glimmerIndex - 1;
  const shimmerEnd = glimmerIndex + 1;
  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    let t3;
    if ($[40] !== message || $[41] !== messageColor) {
      t3 = <Text color={messageColor}>{message}</Text>;
      $[40] = message;
      $[41] = messageColor;
      $[42] = t3;
    } else {
      t3 = $[42];
    }
    let t4;
    if ($[43] !== messageColor) {
      t4 = <Text color={messageColor}> </Text>;
      $[43] = messageColor;
      $[44] = t4;
    } else {
      t4 = $[44];
    }
    let t5;
    if ($[45] !== t3 || $[46] !== t4) {
      t5 = <>{t3}{t4}</>;
      $[45] = t3;
      $[46] = t4;
      $[47] = t5;
    } else {
      t5 = $[47];
    }
    return t5;
  }
  const clampedStart = Math.max(0, shimmerStart);
  let colPos = 0;
  let before = "";
  let shim = "";
  let after = "";
  if ($[48] !== after || $[49] !== before || $[50] !== clampedStart || $[51] !== colPos || $[52] !== segments || $[53] !== shim || $[54] !== shimmerEnd) {
    for (const {
      segment: segment_0,
      width
    } of segments) {
      if (colPos + width <= clampedStart) {
        before = before + segment_0;
      } else {
        if (colPos > shimmerEnd) {
          after = after + segment_0;
        } else {
          shim = shim + segment_0;
        }
      }
      colPos = colPos + width;
    }
    $[48] = after;
    $[49] = before;
    $[50] = clampedStart;
    $[51] = colPos;
    $[52] = segments;
    $[53] = shim;
    $[54] = shimmerEnd;
    $[55] = before;
    $[56] = after;
    $[57] = shim;
    $[58] = colPos;
  } else {
    before = $[55];
    after = $[56];
    shim = $[57];
  }
  let t3;
  if ($[59] !== before || $[60] !== messageColor) {
    t3 = before && <Text color={messageColor}>{before}</Text>;
    $[59] = before;
    $[60] = messageColor;
    $[61] = t3;
  } else {
    t3 = $[61];
  }
  let t4;
  if ($[62] !== shim || $[63] !== shimmerColor) {
    t4 = <Text color={shimmerColor}>{shim}</Text>;
    $[62] = shim;
    $[63] = shimmerColor;
    $[64] = t4;
  } else {
    t4 = $[64];
  }
  let t5;
  if ($[65] !== after || $[66] !== messageColor) {
    t5 = after && <Text color={messageColor}>{after}</Text>;
    $[65] = after;
    $[66] = messageColor;
    $[67] = t5;
  } else {
    t5 = $[67];
  }
  let t6;
  if ($[68] !== messageColor) {
    t6 = <Text color={messageColor}> </Text>;
    $[68] = messageColor;
    $[69] = t6;
  } else {
    t6 = $[69];
  }
  let t7;
  if ($[70] !== t3 || $[71] !== t4 || $[72] !== t5 || $[73] !== t6) {
    t7 = <>{t3}{t4}{t5}{t6}</>;
    $[70] = t3;
    $[71] = t4;
    $[72] = t5;
    $[73] = t6;
    $[74] = t7;
  } else {
    t7 = $[74];
  }
  return t7;
}
