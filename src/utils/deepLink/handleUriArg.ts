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
  // Position-0 only: the OS protocol handler invokes
  // `claude --handle-uri <url>` as the first argument. An indexOf scan
  // would false-positive on `--handle-uri` appearing as another option's
  // operand, e.g. --system-prompt '--handle-uri'.
  if (argv[2] !== '--handle-uri' || !argv[3]) return undefined
  const { enableConfigs } = await import('../config.js')
  enableConfigs()
  const { handleDeepLinkUri } = await import('./protocolHandler.js')
  return handleDeepLinkUri(argv[3])
}
