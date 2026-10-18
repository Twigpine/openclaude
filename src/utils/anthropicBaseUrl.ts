/**
 * Loopback hostnames a first-party proxy may bind to. Restricting the allowlist
 * to these is what guarantees an OAuth session can never be forwarded off the
 * machine: a non-loopback base URL is never treated as first-party no matter
 * what the allowlist says.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost'])

/**
 * Strip the brackets Node's URL parser keeps around an IPv6 hostname
 * (`http://[::1]` -> `[::1]`) and lower-case it, so `[::1]` and `localhost`
 * compare against the allowlist consistently.
 */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHost(hostname))
}

/**
 * Split one `host[:port]` allowlist entry into its parts. IPv6 must be written
 * in bracket form (`[::1]` or `[::1]:8080`) to be unambiguous; a bare `::1`
 * (which carries no port) is accepted too, but `::1:8080` cannot be told apart
 * from an address and is treated as a host with no port.
 */
function parseAllowlistEntry(entry: string): { host: string; port?: string } {
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (bracketed) {
    return { host: normalizeHost(bracketed[1]), port: bracketed[2] }
  }
  // More than one colon and no brackets: an unbracketed IPv6 address, no port.
  if ((entry.match(/:/g)?.length ?? 0) > 1) {
    return { host: normalizeHost(entry) }
  }
  const colon = entry.indexOf(':')
  if (colon >= 0) {
    return {
      host: normalizeHost(entry.slice(0, colon)),
      port: entry.slice(colon + 1),
    }
  }
  return { host: normalizeHost(entry) }
}

/**
 * Whether `url` matches an opt-in loopback proxy allowlist.
 *
 * The allowlist is a comma-separated list of `host[:port]` entries. It is
 * honored only when the base URL itself points at a loopback host, and only
 * loopback entries within it are considered -- both checks are redundant on
 * purpose, so a misconfigured non-loopback entry can never widen first-party
 * status to an off-machine host. A port on an entry must match exactly; an
 * entry with no port matches any port on that host.
 */
function matchesLoopbackProxyAllowlist(
  url: URL,
  rawAllowlist: string | undefined,
): boolean {
  if (!rawAllowlist || !isLoopbackHost(url.hostname)) return false

  const urlHost = normalizeHost(url.hostname)
  // Compare against the effective port: Node leaves `url.port` empty for the
  // scheme default, so an explicit `127.0.0.1:80` entry must still match
  // `http://127.0.0.1`.
  const urlPort = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const raw of rawAllowlist.split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    const { host, port } = parseAllowlistEntry(entry)
    if (!LOOPBACK_HOSTNAMES.has(host) || host !== urlHost) continue
    if (port !== undefined && port !== urlPort) continue
    return true
  }
  return false
}

/**
 * Whether the configured `ANTHROPIC_BASE_URL` should be treated as first-party
 * Anthropic (subscription/OAuth) rather than a custom API-key provider.
 *
 * Returns true if unset (default API) or a canonical `https://api.anthropic.com`
 * endpoint on its default port. It can also be extended with an opt-in,
 * loopback-only allowlist so a signed-in session survives running the CLI
 * through a local transparent proxy (compression, inspection, caching) that
 * forwards auth headers to Anthropic unchanged:
 *
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:47821
 *   ANTHROPIC_FIRST_PARTY_PROXY_HOSTS=127.0.0.1:47821
 *
 * Only loopback hosts are ever honored, so the token cannot leave the machine.
 * Without the allowlist the behavior is unchanged.
 */
export function isFirstPartyAnthropicBaseUrlForEnv(
  processEnv: NodeJS.ProcessEnv,
): boolean {
  const baseUrl = processEnv.ANTHROPIC_BASE_URL
  if (!baseUrl) return true

  try {
    const url = new URL(baseUrl)

    // A first-party endpoint is always a bare http(s) origin. Embedded
    // credentials (`https://user:pass@host`) or any other scheme are never
    // treated as first-party, so an OAuth session can't be attached to them.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false

    const allowedHosts = ['api.anthropic.com']
    if (processEnv.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    if (
      url.protocol === 'https:' &&
      allowedHosts.includes(url.hostname) &&
      (url.port === '' || url.port === '443')
    ) {
      return true
    }

    return matchesLoopbackProxyAllowlist(
      url,
      processEnv.ANTHROPIC_FIRST_PARTY_PROXY_HOSTS,
    )
  } catch {
    return false
  }
}
