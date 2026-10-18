/**
 * Stub-leak detection helpers for the SDK barrel.
 *
 * The esbuild sdk-missing-stub plugin marks every build stub with
 * `__stub: true`. Core SDK modules (QueryEngine, getTools, init) must never
 * resolve to a stub at runtime — if one does, a TUI/CLI dependency leaked into
 * the SDK bundle. These helpers are split out of the SDK entry point so the
 * real detection path can be unit-tested directly with stub-shaped fixtures
 * (the entry point only runs the check as an import side effect).
 */

export type CriticalImport = {
  name: string
  get: () => Record<string, unknown> | undefined
}

/**
 * Invoke `fn`, swallowing a throw and returning undefined. The throw we care
 * about is a TDZ ReferenceError from a circular import that left the binding
 * uninitialized at call time (#1287). TDZ is a different bug class than a stub
 * leak: an uninitialized binding can't carry `__stub: true`, so treat the
 * access failure as "nothing to check here" instead of crashing the detector.
 */
export function safelyAccess<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * Throw an explicit SDK init error if any critical import resolved to a build
 * stub (`__stub: true`). Accessors that throw (TDZ) or resolve to undefined are
 * skipped without short-circuiting the loop, so a real stub on a later import
 * is still caught.
 */
export function checkCriticalImportsForStubs(
  criticalImports: CriticalImport[],
): void {
  for (const { name, get } of criticalImports) {
    const mod = get()
    if (mod && '__stub' in mod && mod.__stub === true) {
      throw new Error(
        `SDK init error: "${name}" resolved to a build stub at runtime. ` +
          `This means a TUI/CLI dependency leaked into the SDK bundle. ` +
          `Report this at https://github.com/Twigpine/openclaude/issues`,
      )
    }
  }
}
