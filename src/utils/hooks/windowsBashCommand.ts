export function getWindowsBashHookCommand(command: string): string {
  let offset = 0
  while (true) {
    // Read the command word after any assignments, not a .sh argument or a
    // script inside a compound command. Keep the original quoting intact.
    const rest = command.slice(offset)
    const match = rest.match(
      /^\s*((?:[^\s"'\\;&|<>()`]|\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*')+)(?=\s|[;&|<>]|$)/,
    )
    const word = match?.[1]
    if (!match || !word || word.startsWith('#')) return command

    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(word)) {
      // Expansions can contain their own words and quotes. Leave those commands
      // untouched rather than mistake part of an assignment for the executable.
      if (/\$[({]|`/.test(word)) return command
      const separator = rest.slice(match[0].length).match(/^(?:[ \t]|\\\n)+/)?.[0]
      if (!separator) return command
      offset += match[0].length + separator.length
      // A newline ends an assignment-only command, unlike spaces and tabs.
      if (/^[\r\n]/.test(command.slice(offset))) return command
      continue
    }
    if (/^\s*\(\s*\)/.test(rest.trimStart().slice(word.length))) return command

    // Require a literal suffix, not .sh inside a parameter expansion such as
    // "${HOOK_COMMAND:-./hook.sh}" whose actual executable is unknown here.
    //
    // Case-insensitive, because the thing being worked around is not: Windows
    // picks a file handler by extension without regard to case, so hook.SH
    // opens in an editor exactly as hook.sh would. Without the flag such a
    // hook never ran and failed silently.
    return /\.sh["']?$/i.test(word)
      ? `${command.slice(0, offset)}bash ${rest}`
      : command
  }
}
