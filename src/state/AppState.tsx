import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import React, { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { MailboxProvider } from '../context/mailbox.js';
import { useEffectEventCompat } from '../hooks/useEffectEventCompat.js';
import { useSettingsChange } from '../hooks/useSettingsChange.js';
import { logForDebugging } from '../utils/debug.js';
import { createDisabledBypassPermissionsContext, isBypassPermissionsModeDisabled } from '../utils/permissions/permissionSetup.js';
import { applySettingsChange } from '../utils/settings/applySettingsChange.js';
import type { SettingSource } from '../utils/settings/constants.js';
import { createStore } from './store.js';

// DCE: voice context is internal-only. External builds get a passthrough.
/* eslint-disable @typescript-eslint/no-require-imports */
const VoiceProvider: (props: {
  children: React.ReactNode;
}) => React.ReactNode = feature('VOICE_MODE') ? require('../context/voice.js').VoiceProvider : ({
  children
}) => children;

/* eslint-enable @typescript-eslint/no-require-imports */
import { type AppState, type AppStateStore, getDefaultAppState } from './AppStateStore.js';

// TODO: Remove these re-exports once all callers import directly from
// ./AppStateStore.js. Kept for back-compat during migration so .ts callers
// can incrementally move off the .tsx import and stop pulling React.
export { type AppState, type AppStateStore, type CompletionBoundary, getDefaultAppState, IDLE_SPECULATION_STATE, type SpeculationResult, type SpeculationState } from './AppStateStore.js';
export const AppStoreContext = React.createContext<AppStateStore | null>(null);
type IfAny<T, Y, N> = 0 extends 1 & T ? Y : N;
type Props = {
  children: React.ReactNode;
  initialState?: AppState;
  onChangeAppState?: (args: {
    newState: AppState;
    oldState: AppState;
  }) => void;
};
const HasAppStateContext = React.createContext<boolean>(false);
export function AppStateProvider(t0: Props): React.ReactNode {
  const $ = _c(13);
  const {
    children,
    initialState,
    onChangeAppState
  } = t0;
  const hasAppStateContext = useContext(HasAppStateContext);
  if (hasAppStateContext) {
    throw new Error("AppStateProvider can not be nested within another AppStateProvider");
  }
  let t1: () => AppStateStore;
  if ($[0] !== initialState || $[1] !== onChangeAppState) {
    t1 = () => createStore(initialState ?? getDefaultAppState(), onChangeAppState);
    $[0] = initialState;
    $[1] = onChangeAppState;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const [store] = useState<AppStateStore>(t1);
  let t2: () => void;
  if ($[3] !== store) {
    t2 = () => {
      const {
        toolPermissionContext
      } = store.getState();
      if (toolPermissionContext.isBypassPermissionsModeAvailable && isBypassPermissionsModeDisabled()) {
        logForDebugging("Disabling bypass permissions mode on mount (remote settings loaded before mount)");
        store.setState(_temp);
      }
    };
    $[3] = store;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  let t3: React.DependencyList;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = [];
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  useEffect(t2, t3);
  let t4: (source: SettingSource) => void;
  if ($[6] !== store.setState) {
    t4 = (source: SettingSource) => applySettingsChange(source, store.setState);
    $[6] = store.setState;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  const onSettingsChange = useEffectEventCompat(t4);
  useSettingsChange(onSettingsChange);
  let t5;
  if ($[8] !== children) {
    t5 = <MailboxProvider><VoiceProvider>{children}</VoiceProvider></MailboxProvider>;
    $[8] = children;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  let t6;
  if ($[10] !== store || $[11] !== t5) {
    t6 = <HasAppStateContext.Provider value={true}><AppStoreContext.Provider value={store}>{t5}</AppStoreContext.Provider></HasAppStateContext.Provider>;
    $[10] = store;
    $[11] = t5;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  return t6;
}
function _temp(prev: AppState): AppState {
  return {
    ...prev,
    toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext)
  };
}
function useAppStore(): AppStateStore {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new ReferenceError('useAppState/useSetAppState cannot be called outside of an <AppStateProvider />');
  }
  return store;
}

/**
 * Subscribe to a slice of AppState. Only re-renders when the selected value
 * changes (compared via Object.is).
 *
 * For multiple independent fields, call the hook multiple times:
 * ```
 * const verbose = useAppState(s => s.verbose)
 * const model = useAppState(s => s.mainLoopModel)
 * ```
 *
 * Do NOT return new objects from the selector -- Object.is will always see
 * them as changed. Instead, select an existing sub-object reference:
 * ```
 * const { text, promptId } = useAppState(s => s.promptSuggestion) // good
 * ```
 */
export function useAppState<T>(selector: (state: AppState) => T): T;
export function useAppState<T>(selector: IfAny<T, T, never>): T;
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore();
  const selectorRef = React.useRef<(state: AppState) => T>(selector);
  const storeRef = React.useRef<AppStateStore>(store);
  // Update refs during render so get() always calls the latest selector/store
  // without creating a new function identity that would trigger useSyncExternalStore
  // to re-sync and cause re-render loops.
  selectorRef.current = selector;
  storeRef.current = store;
  const get = React.useCallback((): T => {
    return selectorRef.current(storeRef.current.getState());
  }, []);
  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * Get the setAppState updater without subscribing to any state.
 * Returns a stable reference that never changes -- components using only
 * this hook will never re-render from state changes.
 */
export function useSetAppState(): AppStateStore['setState'] {
  return useAppStore().setState;
}

/**
 * Get the store directly (for passing getState/setState to non-React code).
 */
export function useAppStateStore(): AppStateStore {
  return useAppStore();
}
const NOOP_SUBSCRIBE: AppStateStore['subscribe'] = () => () => {};

/**
 * Safe version of useAppState that returns undefined if called outside of AppStateProvider.
 * Useful for components that may be rendered in contexts where AppStateProvider isn't available.
 */
export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T,
): T | undefined;
export function useAppStateMaybeOutsideOfProvider<T>(
  selector: IfAny<T, T, never>,
): T | undefined;
export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T,
): T | undefined {
  const store = useContext(AppStoreContext);
  const selectorRef = React.useRef<(state: AppState) => T>(selector);
  const storeRef = React.useRef<AppStateStore | null>(store);
  // Update refs during render so get() always calls the latest selector/store
  // without creating a new function identity.
  selectorRef.current = selector;
  storeRef.current = store;
  const get = React.useCallback((): T | undefined => {
    return storeRef.current ? selectorRef.current(storeRef.current.getState()) : undefined;
  }, []);
  return useSyncExternalStore(store ? store.subscribe : NOOP_SUBSCRIBE, get);
}
