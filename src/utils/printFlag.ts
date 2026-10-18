/**
 * Detects the boolean `-p, --print` flag in raw argv using the root command's
 * actual boolean spelling: exactly `-p` or `--print`.
 *
 * The scan is option-arity-aware so tokens consumed as values by preceding
 * value-taking options are not mistaken for the print flag. Required-value and
 * variadic options consume the next token unconditionally (including flag-like
 * values and the `--` delimiter), matching Commander's behavior. Optional-value
 * options consume the next token only when it is not a flag and not `--`.
 *
 * This intentionally mirrors Commander's consumption rules closely enough for
 * the pre-commander startup routing decisions (direct-connect headless rewrite,
 * SSH headless rejection, and the SIGINT handler) without re-implementing the
 * full program parser.
 */

// Options registered on the root command that take a required value. The next
// token is always their value, even if it looks like a flag or is `--`.
const REQUIRED_VALUE_OPTIONS = new Set([
  '--debug-file',
  '--heartbeat',
  '--output-format',
  '--json-schema',
  '--max-thinking-tokens',
  '--max-turns',
  '--max-budget-usd',
  '--task-budget',
  '--thinking',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--permission-mode',
  '--model',
  '--provider',
  '--effort',
  '--agent',
  '--fallback-model',
  '--workload',
  '--settings',
  '--name',
  '-n',
  '--agents',
  '--setting-sources',
  '--session-id',
  '--plugin-dir',
  '--provider-env-file',
  '--deep-link-repo',
  '--deep-link-last-fetch',
  '--resume-session-at',
  '--rewind-files',
  '--prefill',
  '--permission-prompt-tool',
  '--input-format',
  '--agent-id',
  '--agent-name',
  '--agent-type',
  '--agent-color',
  '--team-name',
  '--parent-session-id',
  '--teammate-mode',
  '--advisor',
  '--messaging-socket-path',
  '--sdk-url',
])

// Variadic options consume their first value unconditionally, then keep
// consuming consecutive non-flag values. The first value may therefore be a
// flag or `--`, matching Commander's behavior.
const VARIADIC_OPTIONS = new Set([
  '--add-dir',
  '--mcp-config',
  '--file',
  '--tools',
  '--allowed-tools',
  '--allowedTools',
  '--disallowed-tools',
  '--disallowedTools',
  '--betas',
  '--channels',
  '--dangerously-load-development-channels',
])

// Options that take an optional value. They consume the next token only when
// it does not start with `-` and is not `--`, so a following flag remains
// available for its own parsing.
const OPTIONAL_VALUE_OPTIONS = new Set(['--debug', '-d', '--resume', '-r', '--from-pr', '--worktree', '-w', '--teleport', '--remote', '--remote-control', '--rc'])

function optionName(arg: string): string {
  const eq = arg.indexOf('=')
  return eq === -1 ? arg : arg.slice(0, eq)
}

function optionalValueOptionWidth(
  arg: string,
  next: string | undefined,
): 1 | 2 {
  if (arg.includes('=')) return 1
  return next !== undefined && next !== '--' && !next.startsWith('-') ? 2 : 1
}

function isPrintFlag(arg: string): boolean {
  // The root command registers `-p, --print` as a boolean. Only the exact
  // spellings are valid; `--print=prompt` and `-pprompt` are rejected by the
  // root command parser.
  return arg === '-p' || arg === '--print'
}

/**
 * Find an exact root command path without mistaking option values for
 * positional command tokens. The shared option tables keep early entrypoint
 * routing aligned with Commander's value-consumption rules.
 */
export function findRootCommandPathIndex(
  argv: readonly string[],
  commandPath: readonly string[],
): number {
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === '--') return -1

    const name = optionName(arg)
    if (REQUIRED_VALUE_OPTIONS.has(name)) {
      i += arg.includes('=') ? 1 : 2
      continue
    }
    if (VARIADIC_OPTIONS.has(name)) {
      if (arg.includes('=')) {
        i++
      } else {
        i += 2
        while (
          i < argv.length &&
          !argv[i]!.startsWith('-') &&
          argv[i] !== '--'
        ) {
          i++
        }
      }
      continue
    }
    if (OPTIONAL_VALUE_OPTIONS.has(name)) {
      i += optionalValueOptionWidth(arg, argv[i + 1])
      continue
    }
    if (arg.startsWith('-')) {
      i++
      continue
    }

    return commandPath.every((token, offset) => argv[i + offset] === token)
      ? i
      : -1
  }
  return -1
}

const MODEL_OWNING_SUBCOMMANDS = [
  ['aimlapi', 'topup'],
  ['auto-mode', 'critique'],
] as const

/**
 * Slice argv before the first nested command that owns its own `--model`.
 * Root `--model` / `--provider` model preflight must not steal that nested flag.
 */
export function argsBeforeModelOwningSubcommand(
  args: readonly string[],
): string[] {
  let cutoff = args.length
  for (const [command, subcommand] of MODEL_OWNING_SUBCOMMANDS) {
    const index = findRootCommandPathIndex(
      args.slice(0, cutoff),
      [command, subcommand],
    )
    if (index !== -1) cutoff = index
  }
  return args.slice(0, cutoff)
}

/** Resolve the final real occurrence of a root option through the same arity scan. */
export function parseRootOptionValue(
  argv: readonly string[],
  option: string,
): string | undefined {
  let value: string | undefined
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === '--') break

    const name = optionName(arg)
    if (name === option) {
      if (arg.includes('=')) {
        value = arg.slice(arg.indexOf('=') + 1) || undefined
        i++
      } else {
        const next = argv[i + 1]
        value = !next || next.startsWith('--') ? undefined : next
        i += 2
      }
      continue
    }
    if (REQUIRED_VALUE_OPTIONS.has(name)) {
      i += arg.includes('=') ? 1 : 2
      continue
    }
    if (VARIADIC_OPTIONS.has(name)) {
      if (arg.includes('=')) {
        i++
      } else {
        i += 2
        while (
          i < argv.length &&
          !argv[i]!.startsWith('-') &&
          argv[i] !== '--'
        ) {
          i++
        }
      }
      continue
    }
    if (OPTIONAL_VALUE_OPTIONS.has(name)) {
      i += optionalValueOptionWidth(arg, argv[i + 1])
      continue
    }
    i++
  }
  return value
}

export function hasPrintFlag(argv: readonly string[]): boolean {
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === '--') break

    const name = optionName(arg)

    if (REQUIRED_VALUE_OPTIONS.has(name)) {
      // Inline value (`--model=foo`) stays in this token. Otherwise the next
      // token is consumed as the value, even if it is `--` or another flag.
      i += arg.includes('=') ? 1 : 2
      continue
    }

    if (VARIADIC_OPTIONS.has(name)) {
      if (arg.includes('=')) {
        i++
      } else {
        // First variadic value is consumed unconditionally (flag or `--` is
        // allowed); after that, only non-flag values are consumed.
        i += 2
        while (
          i < argv.length &&
          !argv[i]!.startsWith('-') &&
          argv[i] !== '--'
        ) {
          i++
        }
      }
      continue
    }

    if (OPTIONAL_VALUE_OPTIONS.has(name)) {
      i += optionalValueOptionWidth(arg, argv[i + 1])
      continue
    }

    if (isPrintFlag(arg)) {
      return true
    }

    i++
  }
  return false
}
