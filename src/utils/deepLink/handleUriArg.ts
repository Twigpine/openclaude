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
  const idx = argv.indexOf('--handle-uri')
  if (idx === -1 || !argv[idx + 1]) return undefined
  const { enableConfigs } = await import('../config.js')
  enableConfigs()
  const { handleDeepLinkUri } = await import('./protocolHandler.js')
  return handleDeepLinkUri(argv[idx + 1]!)
}
