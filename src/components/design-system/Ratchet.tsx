import { c as _c } from "react-compiler-runtime";
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTerminalViewport } from '../../ink/hooks/use-terminal-viewport.js';
import { Box, type DOMElement, measureElement } from '../../ink.js';
type Props = {
  children: React.ReactNode;
  lock?: 'always' | 'offscreen';
};
export function Ratchet(t0) {
  const $ = _c(10);
  const {
    children,
    lock: t1
  } = t0;
  const lock = t1 === undefined ? "always" : t1;
  const [viewportRef, t2] = useTerminalViewport();
  const {
    isVisible
  } = t2;
  const {
    rows
  } = useTerminalSize();
  const innerRef = useRef(null);
  const maxHeight = useRef(0);
  const [minHeight, setMinHeight] = useState(0);
  let t3;
  if ($[0] !== viewportRef) {
    t3 = el => {
      viewportRef(el);
    };
    $[0] = viewportRef;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  const outerRef = t3;
  const engaged = lock === "always" || !isVisible;
  let t4;
  if ($[2] !== rows) {
    t4 = () => {
      if (!innerRef.current) {
        return;
      }
      const {
        height
      } = measureElement(innerRef.current);
      if (height > maxHeight.current) {
        maxHeight.current = Math.min(height, rows);
        setMinHeight(maxHeight.current);
      }
    };
    $[2] = rows;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  useLayoutEffect(t4);
  const t5 = engaged ? minHeight : undefined;
  let t6;
  if ($[4] !== children) {
    t6 = <Box ref={innerRef} flexDirection="column">{children}</Box>;
    $[4] = children;
    $[5] = t6;
  } else {
    t6 = $[5];
  }
  let t7;
  if ($[6] !== outerRef || $[7] !== t5 || $[8] !== t6) {
    t7 = <Box minHeight={t5} ref={outerRef}>{t6}</Box>;
    $[6] = outerRef;
    $[7] = t5;
    $[8] = t6;
    $[9] = t7;
  } else {
    t7 = $[9];
  }
  return t7;
}
