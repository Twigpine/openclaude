import { c as _c } from "react-compiler-runtime";
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useIsInsideModal, useModalScrollRef } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import ScrollBox from '../../ink/components/ScrollBox.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import type { Theme } from '../../utils/theme.js';
type TabsProps = {
  children: Array<React.ReactElement<TabProps>>;
  title?: string;
  color?: keyof Theme;
  defaultTab?: string;
  hidden?: boolean;
  useFullWidth?: boolean;
  /** Controlled mode: current selected tab id/title */
  selectedTab?: string;
  /** Controlled mode: callback when tab changes */
  onTabChange?: (tabId: string) => void;
  /** Optional banner to display below tabs header */
  banner?: React.ReactNode;
  /** Disable keyboard navigation (e.g. when a child component handles arrow keys) */
  disableNavigation?: boolean;
  /**
   * Initial focus state for the tab header row. Defaults to true (header
   * focused, nav always works). Keep the default for Select/list content —
   * those only use up/down so there's no conflict; pass
   * isDisabled={headerFocused} to the Select instead. Only set false when
   * content actually binds left/right/tab (e.g. enum cycling), and show a
   * "↑ tabs" footer hint — without it tabs look broken.
   */
  initialHeaderFocused?: boolean;
  /**
   * Fixed height for the content area. When set, all tabs render within the
   * same height (overflow hidden) so switching tabs doesn't cause layout
   * shifts. Shorter tabs get whitespace; taller tabs are clipped.
   */
  contentHeight?: number;
  /**
   * Let Tab/←/→ switch tabs from focused content. Opt-in since some
   * content uses those keys; pass a reactive boolean to cede them when
   * needed. Switching from content focuses the header.
   */
  navFromContent?: boolean;
};
type TabsContextValue = {
  selectedTab: string | undefined;
  width: number | undefined;
  headerFocused: boolean;
  focusHeader: () => void;
  blurHeader: () => void;
  registerOptIn: () => () => void;
};
const TabsContext = createContext<TabsContextValue>({
  selectedTab: undefined,
  width: undefined,
  // Default for components rendered outside a Tabs (tests, standalone):
  // content has focus, focusHeader is a no-op.
  headerFocused: false,
  focusHeader: () => {},
  blurHeader: () => {},
  registerOptIn: () => () => {}
});
export function Tabs(t0) {
  const $ = _c(25);
  const {
    title,
    color,
    defaultTab,
    children,
    hidden,
    useFullWidth,
    selectedTab: controlledSelectedTab,
    onTabChange,
    banner,
    disableNavigation,
    initialHeaderFocused: t1,
    contentHeight,
    navFromContent: t2
  } = t0;
  const initialHeaderFocused = t1 === undefined ? true : t1;
  const navFromContent = t2 === undefined ? false : t2;
  const {
    columns: terminalWidth
  } = useTerminalSize();
  const tabs = children.map(_temp);
  const defaultTabIndex = defaultTab ? tabs.findIndex(tab => defaultTab === tab[0]) : 0;
  const isControlled = controlledSelectedTab !== undefined;
  const [internalSelectedTab, setInternalSelectedTab] = useState(defaultTabIndex !== -1 ? defaultTabIndex : 0);
  const controlledTabIndex = isControlled ? tabs.findIndex(tab_0 => tab_0[0] === controlledSelectedTab) : -1;
  const selectedTabIndex = isControlled ? controlledTabIndex !== -1 ? controlledTabIndex : 0 : internalSelectedTab;
  const modalScrollRef = useModalScrollRef();
  const [headerFocused, setHeaderFocused] = useState(initialHeaderFocused);
  let t3;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = () => setHeaderFocused(true);
    $[0] = t3;
  } else {
    t3 = $[0];
  }
  const focusHeader = t3;
  let t4;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = () => setHeaderFocused(false);
    $[1] = t4;
  } else {
    t4 = $[1];
  }
  const blurHeader = t4;
  const [optInCount, setOptInCount] = useState(0);
  let t5;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = () => {
      setOptInCount(_temp2);
      return () => setOptInCount(_temp3);
    };
    $[2] = t5;
  } else {
    t5 = $[2];
  }
  const registerOptIn = t5;
  const optedIn = optInCount > 0;
  const handleTabChange = offset => {
    const newIndex = (selectedTabIndex + tabs.length + offset) % tabs.length;
    const newTabId = tabs[newIndex]?.[0];
    if (isControlled && onTabChange && newTabId) {
      onTabChange(newTabId);
    } else {
      setInternalSelectedTab(newIndex);
    }
    setHeaderFocused(true);
  };
  const t6 = !hidden && !disableNavigation && headerFocused;
  let t7;
  if ($[3] !== t6) {
    t7 = {
      context: "Tabs",
      isActive: t6
    };
    $[3] = t6;
    $[4] = t7;
  } else {
    t7 = $[4];
  }
  useKeybindings({
    "tabs:next": () => handleTabChange(1),
    "tabs:previous": () => handleTabChange(-1)
  }, t7);
  let t8;
  if ($[5] !== headerFocused || $[6] !== hidden || $[7] !== optedIn) {
    t8 = e => {
      if (!headerFocused || !optedIn || hidden) {
        return;
      }
      if (e.key === "down") {
        e.preventDefault();
        setHeaderFocused(false);
      }
    };
    $[5] = headerFocused;
    $[6] = hidden;
    $[7] = optedIn;
    $[8] = t8;
  } else {
    t8 = $[8];
  }
  const handleKeyDown = t8;
  const t9 = navFromContent && !headerFocused && optedIn && !hidden && !disableNavigation;
  let t10;
  if ($[9] !== t9) {
    t10 = {
      context: "Tabs",
      isActive: t9
    };
    $[9] = t9;
    $[10] = t10;
  } else {
    t10 = $[10];
  }
  useKeybindings({
    "tabs:next": () => {
      handleTabChange(1);
      setHeaderFocused(true);
    },
    "tabs:previous": () => {
      handleTabChange(-1);
      setHeaderFocused(true);
    }
  }, t10);
  const titleWidth = title ? stringWidth(title) + 1 : 0;
  const tabsWidth = tabs.reduce(_temp4, 0);
  const usedWidth = titleWidth + tabsWidth;
  const spacerWidth = useFullWidth ? Math.max(0, terminalWidth - usedWidth) : 0;
  const contentWidth = useFullWidth ? terminalWidth : undefined;
  const T0 = Box;
  const t11 = "column";
  const t12 = 0;
  const t13 = true;
  const t14 = modalScrollRef ? 0 : undefined;
  const t15 = !hidden && <Box key={`${selectedTabIndex}-${headerFocused ? "focused" : "blurred"}`} flexDirection="row" gap={1} flexShrink={modalScrollRef ? 0 : undefined}>{title !== undefined && <Text bold={true} color={color}>{title}</Text>}{tabs.map((t16, i) => {
      const [id, title_0] = t16;
      const isCurrent = selectedTabIndex === i;
      const hasColorCursor = color && isCurrent && headerFocused;
      return <Text key={id} backgroundColor={hasColorCursor ? color : undefined} color={hasColorCursor ? "inverseText" : undefined} inverse={isCurrent && !hasColorCursor} bold={isCurrent}>{" "}{title_0}{" "}</Text>;
    })}{spacerWidth > 0 && <Text>{" ".repeat(spacerWidth)}</Text>}</Box>;
  let t17;
  if ($[11] !== children || $[12] !== contentHeight || $[13] !== contentWidth || $[14] !== hidden || $[15] !== modalScrollRef || $[16] !== selectedTabIndex) {
    t17 = modalScrollRef ? <Box width={contentWidth} marginTop={hidden ? 0 : 1} flexShrink={0}><ScrollBox key={selectedTabIndex} ref={modalScrollRef} flexDirection="column" flexShrink={0}>{children}</ScrollBox></Box> : <Box width={contentWidth} marginTop={hidden ? 0 : 1} height={contentHeight} overflowY={contentHeight !== undefined ? "hidden" : undefined}>{children}</Box>;
    $[11] = children;
    $[12] = contentHeight;
    $[13] = contentWidth;
    $[14] = hidden;
    $[15] = modalScrollRef;
    $[16] = selectedTabIndex;
    $[17] = t17;
  } else {
    t17 = $[17];
  }
  let t18;
  if ($[18] !== T0 || $[19] !== banner || $[20] !== handleKeyDown || $[21] !== t14 || $[22] !== t15 || $[23] !== t17) {
    t18 = <T0 flexDirection={t11} tabIndex={t12} autoFocus={t13} onKeyDown={handleKeyDown} flexShrink={t14}>{t15}{banner}{t17}</T0>;
    $[18] = T0;
    $[19] = banner;
    $[20] = handleKeyDown;
    $[21] = t14;
    $[22] = t15;
    $[23] = t17;
    $[24] = t18;
  } else {
    t18 = $[24];
  }
  return <TabsContext.Provider value={{
    selectedTab: tabs[selectedTabIndex][0],
    width: contentWidth,
    headerFocused,
    focusHeader,
    blurHeader,
    registerOptIn
  }}>{t18}</TabsContext.Provider>;
}
function _temp4(sum, t0) {
  const [, tabTitle] = t0;
  return sum + (tabTitle ? stringWidth(tabTitle) : 0) + 2 + 1;
}
function _temp3(n_0) {
  return n_0 - 1;
}
function _temp2(n) {
  return n + 1;
}
function _temp(child) {
  return [child.props.id ?? child.props.title, child.props.title];
}
type TabProps = {
  title: string;
  id?: string;
  children: React.ReactNode;
};
export function Tab(t0) {
  const $ = _c(4);
  const {
    title,
    id,
    children
  } = t0;
  const {
    selectedTab,
    width
  } = useContext(TabsContext);
  const insideModal = useIsInsideModal();
  if (selectedTab !== (id ?? title)) {
    return null;
  }
  const t1 = insideModal ? 0 : undefined;
  let t2;
  if ($[0] !== children || $[1] !== t1 || $[2] !== width) {
    t2 = <Box width={width} flexShrink={t1}>{children}</Box>;
    $[0] = children;
    $[1] = t1;
    $[2] = width;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  return t2;
}
export function useTabsWidth() {
  const {
    width
  } = useContext(TabsContext);
  return width;
}

/**
 * Opt into header-focus gating. Returns the current header focus state and a
 * callback to hand focus back to the tab row. For a Select, pass
 * `isDisabled={headerFocused}` and `onUpFromFirstItem={focusHeader}`; keep the
 * parent Tabs' initialHeaderFocused at its default so tab/←/→ work on mount.
 *
 * Calling this hook registers a ↓-blurs-header opt-in on mount. Don't call it
 * above an early return that renders static text — ↓ will blur the header with
 * no onUpFromFirstItem to recover. Split the component so the hook only runs
 * when the Select renders.
 */
export function useTabHeaderFocus() {
  const $ = _c(6);
  const {
    headerFocused,
    focusHeader,
    blurHeader,
    registerOptIn
  } = useContext(TabsContext);
  let t0;
  if ($[0] !== registerOptIn) {
    t0 = [registerOptIn];
    $[0] = registerOptIn;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  useEffect(registerOptIn, t0);
  let t1;
  if ($[2] !== blurHeader || $[3] !== focusHeader || $[4] !== headerFocused) {
    t1 = {
      headerFocused,
      focusHeader,
      blurHeader
    };
    $[2] = blurHeader;
    $[3] = focusHeader;
    $[4] = headerFocused;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  return t1;
}
