import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useEffect, useState } from 'react';
import { PRODUCT_DISPLAY_NAME } from '../constants/product.js';
import { getAllOutputStyles, OUTPUT_STYLE_CONFIG, type OutputStyleConfig } from '../constants/outputStyles.js';
import { Box, Text } from '../ink.js';
import type { OutputStyle } from '../utils/config.js';
import { getCwd } from '../utils/cwd.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
const DEFAULT_OUTPUT_STYLE_LABEL = 'Default';
const DEFAULT_OUTPUT_STYLE_DESCRIPTION = `${PRODUCT_DISPLAY_NAME} completes coding tasks efficiently and provides concise responses`;
function mapConfigsToOptions(styles: {
  [styleName: string]: OutputStyleConfig | null;
}): OptionWithDescription[] {
  return Object.entries(styles).map(([style, config]) => ({
    label: config?.name ?? DEFAULT_OUTPUT_STYLE_LABEL,
    value: style,
    description: config?.description ?? DEFAULT_OUTPUT_STYLE_DESCRIPTION
  }));
}
export type OutputStylePickerProps = {
  initialStyle: OutputStyle;
  onComplete: (style: OutputStyle) => void;
  onCancel: () => void;
  isStandaloneCommand?: boolean;
};
export function OutputStylePicker(t0) {
  const $ = _c(16);
  const {
    initialStyle,
    onComplete,
    onCancel,
    isStandaloneCommand
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [styleOptions, setStyleOptions] = useState(t1);
  const [isLoading, setIsLoading] = useState(true);
  let t2;
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      getAllOutputStyles(getCwd()).then(allStyles => {
        const options = mapConfigsToOptions(allStyles);
        setStyleOptions(options);
        setIsLoading(false);
      }).catch(() => {
        const builtInOptions = mapConfigsToOptions(OUTPUT_STYLE_CONFIG);
        setStyleOptions(builtInOptions);
        setIsLoading(false);
      });
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
  if ($[3] !== onComplete) {
    t4 = style => {
      const outputStyle = style as OutputStyle;
      onComplete(outputStyle);
    };
    $[3] = onComplete;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  const handleStyleSelect = t4;
  const t5 = !isStandaloneCommand;
  const t6 = !isStandaloneCommand;
  let t7;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Box marginTop={1}><Text dimColor={true}>This changes how OpenClaude communicates with you</Text></Box>;
    $[5] = t7;
  } else {
    t7 = $[5];
  }
  let t8;
  if ($[6] !== handleStyleSelect || $[7] !== initialStyle || $[8] !== isLoading || $[9] !== styleOptions) {
    t8 = <Box flexDirection="column" gap={1}>{t7}{isLoading ? <Text dimColor={true}>Loading output styles…</Text> : <Select options={styleOptions} onChange={handleStyleSelect} visibleOptionCount={10} defaultValue={initialStyle} />}</Box>;
    $[6] = handleStyleSelect;
    $[7] = initialStyle;
    $[8] = isLoading;
    $[9] = styleOptions;
    $[10] = t8;
  } else {
    t8 = $[10];
  }
  let t9;
  if ($[11] !== onCancel || $[12] !== t5 || $[13] !== t6 || $[14] !== t8) {
    t9 = <Dialog title="Preferred output style" onCancel={onCancel} hideInputGuide={t5} hideBorder={t6}>{t8}</Dialog>;
    $[11] = onCancel;
    $[12] = t5;
    $[13] = t6;
    $[14] = t8;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  return t9;
}
