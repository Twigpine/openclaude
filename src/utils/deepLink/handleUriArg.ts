import { feature } from 'bun:bundle'

/**
 * Handle `claude --handle-uri <url>` invocations from the OS protocol
 * handler. Returns the exit code when a URI was dispatched, or
 * undefined when the flag is off or no URI argument is present. This
 * runs before full init since it only needs to parse the URI and open
 * a terminal.
 */
export async function handleUriArgIfEnabled(
  argv: string[],
): Promise<number | undefined> {
  if (!feature('LODESTONE')) return undefined
  // Position-0 only in user-arg space: the OS protocol handler invokes
  // `<exec> --handle-uri <url>` as the first argument, so the flag sits at
  // argv[1] for a native binary and at argv[2] for a node + launcher pair.
  // An indexOf scan would false-positive on `--handle-uri` appearing as
  // another option's operand, e.g. --system-prompt '--handle-uri'.
  const base =
    argv[2] === '--handle-uri' ? 2 : argv[1] === '--handle-uri' ? 1 : -1
  if (base < 0 || !argv[base + 1]) return undefined
  const { enableConfigs } = await import('../config.js')
  enableConfigs()
  const { handleDeepLinkUri } = await import('./protocolHandler.js')
  return handleDeepLinkUri(argv[base + 1])
}
