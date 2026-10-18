/**
 * Minimal interactive prompts backed by Node's built-in readline - no extra
 * dependency. Used by the AI/ML API top-up flow to collect credentials when
 * they are not supplied via flags/env.
 */

import { createInterface, type Interface } from 'node:readline'

function assertInteractive(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      'No interactive terminal available. Provide --email (or AIMLAPI_EMAIL) and, for an ' +
        'existing account, the sign-in code via --code-stdin.',
    )
  }
}

export async function promptText(
  question: string,
  opts: { defaultValue?: string } = {},
): Promise<string> {
  assertInteractive()
  const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : ''
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question}${suffix}: `, resolve)
    })
    const trimmed = answer.trim()
    return trimmed || opts.defaultValue || ''
  } finally {
    rl.close()
  }
}

/** Prompt for a secret without echoing keystrokes to the terminal. */
export async function promptHidden(question: string): Promise<string> {
  assertInteractive()
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  }) as Interface & { _writeToOutput?: (chunk: string) => void }

  // Mask everything except the prompt itself.
  let muted = false
  rl._writeToOutput = (chunk: string): void => {
    if (muted) {
      process.stdout.write('*')
    } else {
      process.stdout.write(chunk)
    }
  }

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question}: `, resolve)
      muted = true
    })
    process.stdout.write('\n')
    return answer
  } finally {
    rl.close()
  }
}
