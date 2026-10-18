/**
 * Runtime loading for optional, on-demand dependencies.
 *
 * Some provider SDKs and native helpers are NOT shipped in the default install
 * (see OPTIONAL_RUNTIME_EXTERNALS in scripts/externals.ts) — they are loaded
 * only when a provider/feature that needs them is actually used. We import them
 * through a `new Function` indirection so esbuild cannot see the specifier:
 * that keeps the package out of the CLI bundle AND prevents esbuild from
 * hoisting the package's own static imports (e.g. @anthropic-ai/bedrock-sdk's
 * static `@aws-sdk/client-bedrock-runtime` import) into the bundle, which would
 * otherwise make those packages required at startup for every user.
 */

// Hidden from esbuild's static analysis: resolved from node_modules at runtime.
const runtimeImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>

export class OptionalRuntimeModuleUnavailableError extends Error {
  constructor(
    readonly feature: string,
    readonly specifier: string,
  ) {
    super(
      `${feature} requires the "${specifier}" package, which is not installed. ` +
        `Install it with \`npm install ${specifier}\` (add \`-g\` if you installed the CLI globally) to enable it.`,
    )
    this.name = 'OptionalRuntimeModuleUnavailableError'
  }
}

export function isOptionalRuntimeModuleUnavailableError(
  error: unknown,
): error is OptionalRuntimeModuleUnavailableError {
  return error instanceof OptionalRuntimeModuleUnavailableError
}

/** Raw runtime import — rejects with the underlying error if the module is missing. */
export function importRuntimeModule(specifier: string): Promise<unknown> {
  return runtimeImport(specifier)
}

/**
 * True only when `error` is the resolver reporting that THIS specifier (not a
 * lookalike transitive package) could not be found. Node reports the unresolved
 * name quoted — `Cannot find package 'sharp' imported from ...` — so we match
 * the quoted token rather than a raw substring. A bare includes() would
 * misattribute a missing transitive package whose name merely contains ours
 * (`sharp` ⊂ `sharp-libvips`, `@aws-sdk/client-bedrock` ⊂
 * `@aws-sdk/client-bedrock-runtime`) and print an install hint for the wrong
 * package instead of surfacing the real failure.
 */
export function isMissingSpecifierError(
  error: unknown,
  specifier: string,
): boolean {
  const code = (error as { code?: string } | undefined)?.code
  if (code !== 'ERR_MODULE_NOT_FOUND') return false
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(`'${specifier}'`) || message.includes(`"${specifier}"`)
  )
}

/**
 * Import an optional runtime dependency. If the package itself is not installed,
 * throw a clear, actionable error naming the feature and the install command
 * instead of a cryptic ERR_MODULE_NOT_FOUND.
 *
 * The guard checks the error `code` AND that the failing specifier is the
 * package we asked for — so a genuine missing-package error is reported with
 * the install hint, while a broken transitive dependency inside an installed
 * package surfaces its real error rather than a misleading "not installed".
 */
export async function importOptionalRuntimeModule<T = unknown>(
  specifier: string,
  feature: string,
): Promise<T> {
  try {
    return (await runtimeImport(specifier)) as T
  } catch (e) {
    if (isMissingSpecifierError(e, specifier)) {
      // Context-neutral install hint: this helper backs both the globally
      // installed CLI and the project-local ./sdk consumers, so don't prescribe
      // `-g` (which is wrong for a local SDK install).
      throw new OptionalRuntimeModuleUnavailableError(feature, specifier)
    }
    throw e
  }
}
