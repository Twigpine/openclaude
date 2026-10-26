import type { AppStateStore } from './AppState.js'
import {
  useAppState,
  useAppStateMaybeOutsideOfProvider,
  useAppStateStore,
  useSetAppState,
} from './AppState.js'

type Assert<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false

function assertAppStateHookTypes(): void {
  // JSON.parse models an untyped consumer at the public hook boundary.
  const anySelector = JSON.parse('null')

  const verbose = useAppState(state => state.verbose)
  type _VerboseIsBoolean = Assert<IsEqual<typeof verbose, boolean>>
  type _VerboseIsNotAny = Assert<IsAny<typeof verbose> extends false ? true : false>

  const anySelected = useAppState(anySelector)
  type _AnySelectorStaysAny = Assert<
    IsAny<typeof anySelected> extends true ? true : false
  >

  // @ts-expect-error Compatibility overload is reserved for compiler-erased `any` selectors.
  useAppState((state: { missing: string }) => state.missing)

  const maybeVerbose = useAppStateMaybeOutsideOfProvider(
    state => state.verbose,
  )
  type _MaybeVerboseIsOptionalBoolean = Assert<
    IsEqual<typeof maybeVerbose, boolean | undefined>
  >
  type _MaybeVerboseIsNotAny = Assert<
    IsAny<typeof maybeVerbose> extends false ? true : false
  >

  const maybeAnySelected = useAppStateMaybeOutsideOfProvider(anySelector)
  type _MaybeAnySelectorStaysAny = Assert<
    IsAny<typeof maybeAnySelected> extends true ? true : false
  >

  // @ts-expect-error Compatibility overload is reserved for compiler-erased `any` selectors.
  useAppStateMaybeOutsideOfProvider((state: { missing: string }) => state.missing)

  const setAppState = useSetAppState()
  type _SetAppStateIsStoreSetter = Assert<
    IsEqual<typeof setAppState, AppStateStore['setState']>
  >
  type _SetAppStateIsNotAny = Assert<
    IsAny<typeof setAppState> extends false ? true : false
  >

  const store = useAppStateStore()
  type _StoreIsAppStateStore = Assert<IsEqual<typeof store, AppStateStore>>
  type _StoreIsNotAny = Assert<IsAny<typeof store> extends false ? true : false>

  const additionalDirectoryKeys = useAppState(state =>
    Array.from(state.toolPermissionContext.additionalWorkingDirectories.keys()),
  )
  type _AdditionalDirectoryKeysAreStrings = Assert<
    IsEqual<typeof additionalDirectoryKeys, string[]>
  >
  type _AdditionalDirectoryKeysAreNotAny = Assert<
    IsAny<typeof additionalDirectoryKeys> extends false ? true : false
  >

  const hasActiveOverlay = useAppState(state =>
    state.activeOverlays.has('test-overlay'),
  )
  type _ActiveOverlayCheckIsBoolean = Assert<
    IsEqual<typeof hasActiveOverlay, boolean>
  >
  type _ActiveOverlayCheckIsNotAny = Assert<
    IsAny<typeof hasActiveOverlay> extends false ? true : false
  >

  const registeredToolNames = useAppState(state =>
    state.replContext
      ? Array.from(state.replContext.registeredTools.keys())
      : [],
  )
  type _RegisteredToolNamesAreStrings = Assert<
    IsEqual<typeof registeredToolNames, string[]>
  >
  type _RegisteredToolNamesAreNotAny = Assert<
    IsAny<typeof registeredToolNames> extends false ? true : false
  >

  void verbose
  void anySelected
  void maybeVerbose
  void maybeAnySelected
  void setAppState
  void store
  void additionalDirectoryKeys
  void hasActiveOverlay
  void registeredToolNames
}

void assertAppStateHookTypes
