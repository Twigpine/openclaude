/**
 * `--yolo` is registered as a native commander alias of
 * `--dangerously-skip-permissions`, so the pre-commander argv scanners and the
 * bypass safety notice must recognize either spelling.
 *
 * The SSH pre-parser strips every dangerous-skip token before forwarding the
 * remaining argv, using the shared helpers below instead of ad-hoc single-token
 * removal (which previously let a second token survive and silently re-enable
 * bypass).
 *
 * The direct-connect `cc://` rewrite deliberately does NOT strip the flag: it
 * removes only the `cc://` URL and leaves `--yolo` / `--dangerously-skip-permissions`
 * for commander to parse on the main command (interactive) or the internal `open`
 * subcommand (headless), so commander remains the single authority for option
 * arity and the `--` end-of-options marker.
 *
 * These scanners run BEFORE commander and detect the flag by presence alone.
 * That is deliberately an approximation — fully matching commander (which can
 * consume `--yolo` as a required option value, or a `--` as a variadic value)
 * would mean re-implementing commander's option-arity state machine, the exact
 * fragile simulation this feature was reworked to delete. So the helper simply
 * mirrors the long-standing behavior of the canonical `--dangerously-skip-
 * permissions` scanning: `--yolo` and the canonical flag behave identically,
 * no better and no worse.
 */

const DANGEROUS_SKIP_FLAGS = ['--dangerously-skip-permissions', '--yolo']

export function isDangerousSkipFlag(arg: string): boolean {
  return DANGEROUS_SKIP_FLAGS.includes(arg)
}

export function hasDangerousSkipFlag(argv: readonly string[]): boolean {
  return argv.some(isDangerousSkipFlag)
}

/** Returns a copy of `argv` with every dangerous-skip token removed. */
export function stripDangerousSkipFlags(argv: readonly string[]): string[] {
  return argv.filter(arg => !isDangerousSkipFlag(arg))
}
