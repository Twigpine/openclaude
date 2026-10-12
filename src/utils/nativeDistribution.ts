/**
 * True when this build ships its own native binary distribution, i.e. the
 * build-time `MACRO.NATIVE_PACKAGE_URL` define is set.
 *
 * OpenClaude (`@twigpine/openclaude`) is distributed only as an npm package and
 * sets `NATIVE_PACKAGE_URL` to `undefined` in both define blocks of
 * `scripts/build.ts`. Without this gate, the native installer inherited from
 * upstream downloads the first-party Claude Code binary from Anthropic's GCS
 * bucket, symlinks the launcher to it, and uninstalls the npm package the user
 * is actually running. Every native-installer surface (binary download,
 * launcher symlink, npm cleanup, native auto-update) must stay inert unless
 * this returns true.
 *
 * Bun's `define` inlines the member expression, so in npm-only builds the
 * guarded branches are statically dead and get stripped by DCE. Re-enabling
 * native installs later only requires setting `NATIVE_PACKAGE_URL` at build
 * time — no code changes.
 */
export function hasNativeDistribution(): boolean {
  return MACRO.NATIVE_PACKAGE_URL !== undefined
}
