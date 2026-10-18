import { Command as CommanderCommand } from '@commander-js/extra-typings'
import { createInterface } from 'node:readline'

import {
  DEFAULT_MODEL,
  MAX_AMOUNT_USD_MINOR,
  MIN_AMOUNT_USD_MINOR,
} from '../integrations/aimlapi/config.js'
import type { AimlapiTopupOptions } from '../integrations/aimlapi/topup.js'

type AimlapiTopupHandler = (options: AimlapiTopupOptions) => Promise<void>
type LoadAimlapiTopupHandler = () => Promise<AimlapiTopupHandler>

const loadAimlapiTopupHandler: LoadAimlapiTopupHandler = async () => {
  const { aimlapiTopup } = await import('./handlers/aimlapi.js')
  return aimlapiTopup
}

/**
 * Read exactly one line from stdin for --code-stdin: a noninteractive way to
 * supply the passwordless sign-in code that never touches argv (visible to
 * other local users via shell history and the process list, e.g. `ps` /
 * `/proc/<pid>/cmdline`) or an env var (visible via `/proc/<pid>/environ`).
 * Stops at the first line rather than draining to EOF, so a caller piping
 * more than one value is not silently read past its intended input.
 */
async function readOneLineFromStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin })
  try {
    for await (const line of rl) {
      return line.trim()
    }
    return ''
  } finally {
    rl.close()
  }
}

/**
 * Register the `aimlapi` command group (`topup`). The handler is lazily imported
 * so the heavy top-up flow only loads when the subcommand actually runs; tests
 * inject `loadHandler` to capture the parsed options without touching the network.
 */
export function registerAimlapiCommand(
  program: CommanderCommand,
  loadHandler: LoadAimlapiTopupHandler = loadAimlapiTopupHandler,
): CommanderCommand {
  const aimlapi = program
    .command('aimlapi')
    .description('AI/ML API (aimlapi.com) — top up balance and configure the provider')
  aimlapi
    .command('topup')
    .description(
      'Use passwordless sign-in, open AI/ML API top-up, then configure OpenClaude',
    )
    .option('--email <email>', 'AI/ML API account email (or AIMLAPI_EMAIL env)')
    .option(
      '--code <code>',
      'Deprecated: 6-digit code for an existing account, as a plain argument. This ' +
        'exposes it to shell history and the process list (`ps`, /proc/<pid>/cmdline) on ' +
        'the local machine. Prefer --code-stdin for scripts, or the interactive prompt.',
    )
    .option(
      '--code-stdin',
      'Read the 6-digit code for an existing account from stdin (one line) instead of ' +
        '--code, so it never appears in this process\'s argv/`ps` output. Whether it also ' +
        'avoids shell history depends on how you feed stdin (e.g. a file avoids it; ' +
        '`echo code | ...` does not).',
    )
    .option(
      '--amount <usd>',
      `Top-up amount in USD (min ${MIN_AMOUNT_USD_MINOR / 100}, max ${MAX_AMOUNT_USD_MINOR / 100})`,
    )
    .option('--auto-top-up', 'Enable automatic top-up at checkout')
    .option(
      '--model <model>',
      'Default model id written into the provider profile',
      DEFAULT_MODEL,
    )
    .option('--no-open', 'Do not auto-open the browser; print the payment URL instead')
    .action(async opts => {
      if (opts.code) {
        process.stderr.write(
          'Warning: --code exposes the sign-in code via shell history and the process ' +
            'list. Use --code-stdin for scripts, or omit it to be prompted instead.\n',
        )
      }
      const code = opts.codeStdin ? await readOneLineFromStdin() : opts.code
      const handler = await loadHandler()
      await handler({
        email: opts.email,
        code,
        amountUsd: opts.amount,
        autoTopUp: opts.autoTopUp,
        model: opts.model,
        noOpen: opts.open === false,
      })
    })

  return aimlapi
}
