import { hasDangerousSkipFlag, stripDangerousSkipFlags } from './dangerousSkipFlags.js'
import { hasPrintFlag } from './printFlag.js'

/**
 * Result of pre-parsing the flags of a `claude ssh …` invocation, before the
 * host/cwd positionals and the argv rewrite. Extracted from main.tsx so the
 * security-sensitive arity handling can be unit-tested.
 */
export interface SshFlagParse {
  local: boolean
  permissionMode: string | undefined
  dangerouslySkipPermissions: boolean
  /** Flags to forward to the remote CLI's initial spawn (e.g. --model <m>). */
  extraCliArgs: string[]
  /** `args` with every consumed flag removed; still starts with `ssh`. */
  remaining: string[]
}

/**
 * Pull SSH-relevant flags out of `rawCliArgs` (which starts with `ssh`).
 *
 * Recognized options are parsed in a single left-to-right arity-aware pass.
 * Value-taking flags consume the next token unconditionally — matching
 * commander's required-argument behavior — so a value that looks like a flag
 * (e.g. `--model --print` or `--permission-mode --local`) or even the `--`
 * delimiter itself (e.g. `--model --`) is never left in the remaining argv to
 * be misinterpreted by later guards. Every occurrence of a recognized option,
 * including equals forms, is consumed.
 *
 * A bare `--` that is not consumed as a value terminates option parsing: every
 * token at/after it is kept as positional input and is never parsed as a flag.
 */
export function parseSshFlags(rawCliArgs: readonly string[]): SshFlagParse {
  const args = [...rawCliArgs]
  let local = false
  let permissionMode: string | undefined
  let dangerouslySkipPermissions = false
  const extraCliArgs: string[] = []
  const remaining: string[] = []
  const trailing: string[] = []

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    // End-of-options marker: stop parsing, but only if it is not the value of
    // a preceding required option. Optional-value options never consume `--`.
    if (arg === '--') {
      trailing.push(...args.slice(i))
      break
    }

    if (arg === '--local') {
      local = true
      i++
      continue
    }

    if (arg === '-c' || arg === '--continue') {
      extraCliArgs.push('--continue')
      i++
      continue
    }

    if (arg === '--permission-mode') {
      const next = args[i + 1]
      if (next !== undefined) {
        permissionMode = next
        i += 2
      } else {
        remaining.push(arg)
        i++
      }
      continue
    }
    if (arg.startsWith('--permission-mode=')) {
      permissionMode = arg.slice('--permission-mode='.length)
      i++
      continue
    }

    if (arg === '--model') {
      const next = args[i + 1]
      if (next !== undefined) {
        extraCliArgs.push('--model', next)
        i += 2
      } else {
        remaining.push(arg)
        i++
      }
      continue
    }
    if (arg.startsWith('--model=')) {
      extraCliArgs.push('--model', arg.slice('--model='.length))
      i++
      continue
    }

    if (arg === '--fallback-model') {
      const next = args[i + 1]
      if (next !== undefined) {
        extraCliArgs.push('--fallback-model', next)
        i += 2
      } else {
        remaining.push(arg)
        i++
      }
      continue
    }
    if (arg.startsWith('--fallback-model=')) {
      extraCliArgs.push('--fallback-model', arg.slice('--fallback-model='.length))
      i++
      continue
    }

    if (arg === '--resume') {
      // Commander declares `--resume [value]`: a bare flag opens the resume
      // picker, and a value is used only when it is a non-option, non-`--`
      // token.
      const next = args[i + 1]
      if (next !== undefined && next !== '--' && !next.startsWith('-')) {
        extraCliArgs.push('--resume', next)
        i += 2
      } else {
        extraCliArgs.push('--resume')
        i++
      }
      continue
    }
    if (arg.startsWith('--resume=')) {
      // Equals form explicitly provides a value; keep it attached so the
      // optional-value semantics are preserved on the remote CLI. For example,
      // `--resume=--print` resumes a conversation named "--print"; it must not
      // be misinterpreted as enabling print mode.
      extraCliArgs.push(arg)
      i++
      continue
    }

    remaining.push(arg)
    i++
  }

  // Every value-taking flag has now consumed its value, so any remaining
  // dangerous-skip token is a genuine standalone bypass flag. Tokens after `--`
  // are positional and must not be considered.
  if (hasDangerousSkipFlag(remaining)) {
    dangerouslySkipPermissions = true
    const stripped = stripDangerousSkipFlags(remaining)
    remaining.length = 0
    remaining.push(...stripped)
  }

  return {
    local,
    permissionMode,
    dangerouslySkipPermissions,
    extraCliArgs,
    remaining: [...remaining, ...trailing],
  }
}

/**
 * After `parseSshFlags()` extracts host-independent flags into `extraCliArgs`, a
 * headless/print token can hide there as well as in the tail argv after host/cwd.
 * Centralize the SSH headless check so both scopes are covered with the same
 * arity-aware predicate.
 */
export function sshArgvImpliesHeadless(
  parsed: SshFlagParse,
  rest: string[],
): boolean {
  return hasPrintFlag(rest) || hasPrintFlag(parsed.extraCliArgs)
}
