import { c as _c } from "react-compiler-runtime";
import React, { createContext, useSyncExternalStore } from 'react';
import { getTerminalFocused, getTerminalFocusState, subscribeTerminalFocus, type TerminalFocusState } from '../terminal-focus-state.js';
export type { TerminalFocusState };
export type TerminalFocusContextProps = {
  readonly isTerminalFocused: boolean;
  readonly terminalFocusState: TerminalFocusState;
};
const TerminalFocusContext = createContext<TerminalFocusContextProps>({
  isTerminalFocused: true,
  terminalFocusState: 'unknown'
});

// eslint-disable-next-line custom-rules/no-top-level-side-effects
TerminalFocusContext.displayName = 'TerminalFocusContext';

// Separate component so App.tsx doesn't re-render on focus changes.
// Children are a stable prop reference, so they don't re-render either —
// only components that consume the context will re-render.
export function TerminalFocusProvider(t0) {
  const $ = _c(6);
  const {
    children
  } = t0;
  const isTerminalFocused = useSyncExternalStore(subscribeTerminalFocus, getTerminalFocused);
  const terminalFocusState = useSyncExternalStore(subscribeTerminalFocus, getTerminalFocusState);
  let t1;
  if ($[0] !== isTerminalFocused || $[1] !== terminalFocusState) {
    t1 = {
      isTerminalFocused,
      terminalFocusState
    };
    $[0] = isTerminalFocused;
    $[1] = terminalFocusState;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const value = t1;
  let t2;
  if ($[3] !== children || $[4] !== value) {
    t2 = <TerminalFocusContext.Provider value={value}>{children}</TerminalFocusContext.Provider>;
    $[3] = children;
    $[4] = value;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  return t2;
}
export default TerminalFocusContext;
