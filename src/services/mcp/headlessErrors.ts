import { getPluginErrorMessage, type PluginError } from '../../types/plugin.js'

/**
 * Build the stderr warning lines a headless (`-p`) session should emit for MCP
 * config errors.
 *
 * Interactive sessions surface these through the MCP error UI, but headless has
 * no such surface: a fatal managed-mcp.json fail-closes every file-based source
 * and, without this, the caller sees an empty server list with no reason why —
 * indistinguishable from an intentionally empty config. Returns [] when not
 * headless or when there is nothing to report, so the caller writes nothing.
 */
export function getHeadlessMcpConfigWarnings(
  isNonInteractiveSession: boolean,
  errors: PluginError[],
): string[] {
  if (!isNonInteractiveSession || errors.length === 0) {
    return []
  }
  return errors.map(error => `Warning: ${getPluginErrorMessage(error)}`)
}
