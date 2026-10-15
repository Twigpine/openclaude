/**
 * Built-in Plugin Initialization
 *
 * Initializes built-in plugins that ship with the CLI and appear in the
 * /plugin UI for users to enable/disable.
 *
 * Not all bundled features should be built-in plugins — use this for
 * features that users should be able to explicitly enable/disable. For
 * features with complex setup or automatic-enabling logic (e.g.
 * claude-in-chrome), use src/skills/bundled/ instead.
 *
 * To add a new built-in plugin:
 * 1. Import its registerXPlugin() helper from the plugin module here
 * 2. Call that helper from initBuiltinPlugins()
 */

import { registerKarpathyGuidelinesPlugin } from './karpathyGuidelines.js'
import { registerMemlawbPlugin } from './memlawb.js'

/**
 * Initialize built-in plugins. Called during CLI startup.
 */
export function initBuiltinPlugins(): void {
  registerKarpathyGuidelinesPlugin()
  registerMemlawbPlugin()
}
