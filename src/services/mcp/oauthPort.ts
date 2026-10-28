/**
 * OAuth redirect port helpers — extracted from auth.ts to break the
 * auth.ts ↔ xaaIdpLogin.ts circular dependency.
 */
import { randomInt } from 'crypto'
import { createServer } from 'http'
import { getPlatform } from '../../utils/platform.js'

// Windows dynamic port range 49152-65535 is reserved
const REDIRECT_PORT_RANGE =
  getPlatform() === 'windows'
    ? { min: 39152, max: 49151 }
    : { min: 49152, max: 65535 }
const REDIRECT_PORT_FALLBACK = 3118

/**
 * Builds a redirect URI on localhost with the given port and a fixed `/callback` path.
 *
 * RFC 8252 Section 7.3 (OAuth for Native Apps): loopback redirect URIs match any
 * port as long as the path matches.
 */
export function buildRedirectUri(
  port: number = REDIRECT_PORT_FALLBACK,
): string {
  return `http://localhost:${port}/callback`
}

function getMcpOAuthCallbackPort(): number | undefined {
  const rawPort = process.env.MCP_OAUTH_CALLBACK_PORT
  if (!rawPort || /[^0-9]/.test(rawPort)) return undefined
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

function probePort(port: number, host?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const testServer = createServer()
    testServer.once('error', reject)
    testServer.listen(port, host, () => {
      testServer.close(error => error ? reject(error) : resolve())
    })
  })
}

/**
 * Finds an available port in the specified range for OAuth redirect
 * Uses random selection for better security.
 * An invalid or unavailable MCP_OAUTH_CALLBACK_PORT falls back to random/fallback
 * selection, so the redirect URI can change. Providers requiring an exact
 * pre-registered redirect URI may reject that flow; keep their configured port free.
 */
export async function findAvailablePort(): Promise<number> {
  // First, try the configured port if specified
  const configuredPort = getMcpOAuthCallbackPort()
  if (configuredPort) {
    try {
      await probePort(configuredPort, '127.0.0.1')
      return configuredPort
    } catch {
      // The override is unavailable; use the usual random/fallback selection.
    }
  }

  // Preserve wildcard probes for random/fallback ports advertised as localhost.
  const { min, max } = REDIRECT_PORT_RANGE
  const range = max - min + 1
  const maxAttempts = Math.min(range, 100) // Don't try forever

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = randomInt(min, max + 1)

    try {
      await probePort(port)
      return port
    } catch {
      // Port in use, try another random port
      continue
    }
  }

  // If random selection failed, try the fallback port
  try {
    await probePort(REDIRECT_PORT_FALLBACK)
    return REDIRECT_PORT_FALLBACK
  } catch {
    throw new Error(`No available ports for OAuth redirect`)
  }
}
