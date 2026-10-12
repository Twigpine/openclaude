/**
 * The npm package moved from the `@gitlawb` scope to `@twigpine`.
 *
 * Shipped builds have no working auto-updater (scripts/no-telemetry-plugin.ts
 * stubs it out), so people update by re-running the install command by hand —
 * and anyone doing that from habit, shell history or an old tutorial still
 * types the old name. `npm deprecate` on the old package warns them at that
 * moment; the single final release published under the old name (the
 * `publish-npm-legacy-scope` job in `.github/workflows/release.yml`) is what
 * they land on, and it keeps telling them where the package went. Nothing is
 * published to the old scope after that.
 *
 * There is deliberately no in-place migration. Both packages own the
 * `openclaude` bin, so npm refuses to install one over the other (EEXIST), and
 * forcing it lets a later uninstall of the old package delete the shared bin.
 * The only safe order is "uninstall old, then install new", run by the user.
 */
export const LEGACY_PACKAGE_NAME = '@gitlawb/openclaude'
export const CURRENT_PACKAGE_NAME = '@twigpine/openclaude'

export const PACKAGE_RENAMED_HEADLINE = `OpenClaude has moved to ${CURRENT_PACKAGE_NAME}.`
export const PACKAGE_RENAMED_DETAIL = `${LEGACY_PACKAGE_NAME} is no longer updated. To keep getting updates, quit OpenClaude and run:`

/** Order matters: installing the new package first fails with EEXIST. */
export const PACKAGE_SWITCH_COMMANDS: readonly string[] = [
  `npm uninstall -g ${LEGACY_PACKAGE_NAME}`,
  `npm install -g ${CURRENT_PACKAGE_NAME}@latest`,
]

/** The commands above only fit an npm global install. */
export const PACKAGE_SWITCH_OTHER_MANAGERS =
  'Installed with bun, pnpm or yarn? Use its global remove and add commands instead.'

/** The whole note as plain text, for surfaces that take a single string. */
export function getPackageRenamedMessage(): string {
  return [
    PACKAGE_RENAMED_HEADLINE,
    PACKAGE_RENAMED_DETAIL,
    ...PACKAGE_SWITCH_COMMANDS.map(command => `  ${command}`),
    PACKAGE_SWITCH_OTHER_MANAGERS,
  ].join('\n')
}

export function isLegacyPackageName(packageName: string | undefined): boolean {
  return packageName === LEGACY_PACKAGE_NAME
}

/** True when this build was published under the pre-rename package name. */
export function isLegacyPackageBuild(): boolean {
  return isLegacyPackageName(MACRO.PACKAGE_URL)
}
