import { c as _c } from "react-compiler-runtime";
import React, { type Ref, useEffect, useRef, useState } from 'react';
import type { Except } from 'type-fest';
import type { DOMElement } from '../dom.js';
import type { ClickEvent } from '../events/click-event.js';
import type { FocusEvent } from '../events/focus-event.js';
import type { KeyboardEvent } from '../events/keyboard-event.js';
import type { Styles } from '../styles.js';
import Box from './Box.js';
type ButtonState = {
  focused: boolean;
  hovered: boolean;
  active: boolean;
};
export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>;
  /**
   * Called when the button is activated via Enter, Space, or click.
   */
  onAction: () => void;
  /**
   * Tab order index. Defaults to 0 (in tab order).
   * Set to -1 for programmatically focusable only.
   */
  tabIndex?: number;
  /**
   * Focus this button when it mounts.
   */
  autoFocus?: boolean;
  /**
   * Render prop receiving the interactive state. Use this to
   * style children based on focus/hover/active — Button itself
   * is intentionally unstyled.
   *
   * If not provided, children render as-is (no state-dependent styling).
   */
  children: ((state: ButtonState) => React.ReactNode) | React.ReactNode;
};
function Button(t0) {
  const $ = _c(30);
  let autoFocus;
  let children;
  let onAction;
  let ref;
  let style;
  let t1;
  if ($[0] !== t0) {
    ({
      onAction,
      tabIndex: t1,
      autoFocus,
      children,
      ref,
      ...style
    } = t0);
    $[0] = t0;
    $[1] = autoFocus;
    $[2] = children;
    $[3] = onAction;
    $[4] = ref;
    $[5] = style;
    $[6] = t1;
  } else {
    autoFocus = $[1];
    children = $[2];
    onAction = $[3];
    ref = $[4];
    style = $[5];
    t1 = $[6];
  }
  const tabIndex = t1 === undefined ? 0 : t1;
  const [isFocused, setIsFocused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const activeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  let t2;
  let t3;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => () => {
      if (activeTimer.current) {
        clearTimeout(activeTimer.current);
      }
    };
    t3 = [];
    $[7] = t2;
    $[8] = t3;
  } else {
    t2 = $[7];
    t3 = $[8];
  }
  useEffect(t2, t3);
  let t4;
  if ($[9] !== onAction) {
    t4 = e => {
      if (e.key === "return" || e.key === " ") {
        e.preventDefault();
        setIsActive(true);
        onAction();
        if (activeTimer.current) {
          clearTimeout(activeTimer.current);
        }
        activeTimer.current = setTimeout(_temp, 100, setIsActive);
      }
    };
    $[9] = onAction;
    $[10] = t4;
  } else {
    t4 = $[10];
  }
  const handleKeyDown = t4;
  let t5;
  if ($[11] !== onAction) {
    t5 = _e => {
      onAction();
    };
    $[11] = onAction;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  const handleClick = t5;
  let t6;
  if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = _e_0 => setIsFocused(true);
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  const handleFocus = t6;
  let t7;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = _e_1 => setIsFocused(false);
    $[14] = t7;
  } else {
    t7 = $[14];
  }
  const handleBlur = t7;
  let t8;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = () => setIsHovered(true);
    $[15] = t8;
  } else {
    t8 = $[15];
  }
  const handleMouseEnter = t8;
  let t9;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t9 = () => setIsHovered(false);
    $[16] = t9;
  } else {
    t9 = $[16];
  }
  const handleMouseLeave = t9;
  let t10;
  if ($[17] !== children || $[18] !== isActive || $[19] !== isFocused || $[20] !== isHovered) {
    const state = {
      focused: isFocused,
      hovered: isHovered,
      active: isActive
    };
    t10 = typeof children === "function" ? children(state) : children;
    $[17] = children;
    $[18] = isActive;
    $[19] = isFocused;
    $[20] = isHovered;
    $[21] = t10;
  } else {
    t10 = $[21];
  }
  const content = t10;
  let t11;
  if ($[22] !== autoFocus || $[23] !== content || $[24] !== handleClick || $[25] !== handleKeyDown || $[26] !== ref || $[27] !== style || $[28] !== tabIndex) {
    t11 = <Box ref={ref} tabIndex={tabIndex} autoFocus={autoFocus} onKeyDown={handleKeyDown} onClick={handleClick} onFocus={handleFocus} onBlur={handleBlur} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...style}>{content}</Box>;
    $[22] = autoFocus;
    $[23] = content;
    $[24] = handleClick;
    $[25] = handleKeyDown;
    $[26] = ref;
    $[27] = style;
    $[28] = tabIndex;
    $[29] = t11;
  } else {
    t11 = $[29];
  }
  return t11;
}
function _temp(setter) {
  return setter(false);
}
export default Button;
export type { ButtonState };
