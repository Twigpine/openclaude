import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  getSessionDangerousPermissionMode,
  getIsInteractive,
  getIsNonInteractiveSession,
} from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { isInBundledMode } from '../bundledMode.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'
import { jsonStringify } from '../slowOperations.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  getAllBrowserDataPaths,
  getAllNativeMessagingHostsDirs,
  getAllWindowsRegistryKeys,
  openInChrome,
} from './common.js'
import {
  createWrapperScript,
  resolveClaudeInChromeLaunches,
} from './launch.js'
import { getChromeSystemPrompt } from './prompt.js'
import { isChromeExtensionInstalledPortable } from './setupPortable.js'

const CHROME_EXTENSION_RECONNECT_URL = 'https://clau.de/chrome/reconnect'

const NATIVE_HOST_IDENTIFIER = 'com.anthropic.claude_code_browser_extension'
const NATIVE_HOST_MANIFEST_NAME = `${NATIVE_HOST_IDENTIFIER}.json`

export function shouldEnableClaudeInChrome(chromeFlag?: boolean): boolean {
  // Disable by default in non-interactive sessions (e.g., SDK, CI)
  if (getIsNonInteractiveSession() && chromeFlag !== true) {
    return false
  }

  // Check CLI flags
  if (chromeFlag === true) {
    return true
  }
  if (chromeFlag === false) {
    return false
  }

  // Check environment variables
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return true
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return false
  }

  // Check default config settings
  const config = getGlobalConfig()
  if (config.claudeInChromeDefaultEnabled !== undefined) {
    return config.claudeInChromeDefaultEnabled
  }

  return false
}

let shouldAutoEnable: boolean | undefined = undefined
let pendingClaudeInChromeSetup: Promise<void> | null = null

export function shouldAutoEnableClaudeInChrome(): boolean {
  if (shouldAutoEnable !== undefined) {
    return shouldAutoEnable
  }

  shouldAutoEnable =
    getIsInteractive() &&
    isChromeExtensionInstalled_CACHED_MAY_BE_STALE() &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_chrome_auto_enable', false)

  return shouldAutoEnable
}

export function waitForClaudeInChromeSetup(): Promise<void> {
  return pendingClaudeInChromeSetup ?? Promise.resolve()
}

/**
 * Setup Claude in Chrome MCP server and tools
 *
 * @returns MCP config and allowed tools, or throws an error if platform is unsupported
 */
export function setupClaudeInChrome(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: string
} {
  const isNativeBuild = isInBundledMode()
  const launches = resolveClaudeInChromeLaunches({ isNativeBuild })
  const allowedTools = BROWSER_TOOLS.map(
    tool => `mcp__claude-in-chrome__${tool.name}`,
  )

  const env: Record<string, string> = {}
  if (getSessionDangerousPermissionMode() === 'fullAccess') {
    env.CLAUDE_CHROME_PERMISSION_MODE = 'skip_all_permission_checks'
  }
  const hasEnv = Object.keys(env).length > 0

  // The manifest path cannot contain arguments, so both runtime modes need a
  // wrapper. Launch selection above keeps the native mode flag-only and gives
  // non-native mode the validated current CLI entrypoint.
  pendingClaudeInChromeSetup = createWrapperScript(launches.nativeHost)
    .then(manifestBinaryPath => {
      logForDebugging(
        `[Claude in Chrome] Setup launch configuration: ${jsonStringify(launches)}`,
      )
      if (
        isEnvTruthy(
          process.env.OPENCLAUDE_SKIP_CHROME_NATIVE_HOST_REGISTRATION,
        )
      ) {
        return
      }
      return installChromeNativeHostManifest(manifestBinaryPath)
    })
    .catch(e =>
      logForDebugging(
        `[Claude in Chrome] Failed to install native host: ${e}`,
        { level: 'error' },
      ),
    )

  return {
    mcpConfig: {
      [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command: launches.mcpServer.command,
        args: launches.mcpServer.args,
        scope: 'dynamic' as const,
        ...(hasEnv && { env }),
      },
    },
    allowedTools,
    systemPrompt: getChromeSystemPrompt(),
  }
}

/**
 * Get native messaging hosts directories for all supported browsers
 * Returns an array of directories where the native host manifest should be installed
 */
function getNativeMessagingHostsDirs(): string[] {
  const platform = getPlatform()

  if (platform === 'windows') {
    // Windows uses a single location with registry entries pointing to it
    const home = homedir()
    const appData = process.env.APPDATA || join(home, 'AppData', 'Local')
    return [join(appData, 'Claude Code', 'ChromeNativeHost')]
  }

  // macOS and Linux: return all browser native messaging directories
  return getAllNativeMessagingHostsDirs().map(({ path }) => path)
}

export async function installChromeNativeHostManifest(
  manifestBinaryPath: string,
): Promise<void> {
  const manifestDirs = getNativeMessagingHostsDirs()
  if (manifestDirs.length === 0) {
    throw Error('Claude in Chrome Native Host not supported on this platform')
  }

  const manifest = {
    name: NATIVE_HOST_IDENTIFIER,
    description: 'Claude Code Browser Extension Native Host',
    path: manifestBinaryPath,
    type: 'stdio',
    allowed_origins: [
      `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/`, // PROD_EXTENSION_ID
      ...(process.env.USER_TYPE === 'ant'
        ? [
            'chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/', // DEV_EXTENSION_ID
            'chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/', // ANT_EXTENSION_ID
          ]
        : []),
    ],
  }

  const manifestContent = jsonStringify(manifest, null, 2)
  let anyManifestUpdated = false

  // Install manifest to all browser directories
  for (const manifestDir of manifestDirs) {
    const manifestPath = join(manifestDir, NATIVE_HOST_MANIFEST_NAME)

    // Check if content matches to avoid unnecessary writes
    const existingContent = await readFile(manifestPath, 'utf-8').catch(
      () => null,
    )
    if (existingContent === manifestContent) {
      continue
    }

    try {
      await mkdir(manifestDir, { recursive: true })
      await writeFile(manifestPath, manifestContent)
      logForDebugging(
        `[Claude in Chrome] Installed native host manifest at: ${manifestPath}`,
      )
      anyManifestUpdated = true
    } catch (error) {
      // Log but don't fail - the browser might not be installed
      logForDebugging(
        `[Claude in Chrome] Failed to install manifest at ${manifestPath}: ${error}`,
      )
    }
  }

  // Windows requires registry entries pointing to the manifest for each browser
  if (getPlatform() === 'windows') {
    const manifestPath = join(manifestDirs[0]!, NATIVE_HOST_MANIFEST_NAME)
    registerWindowsNativeHosts(manifestPath)
  }

  // Restart the native host if we have rewritten any manifest
  if (anyManifestUpdated) {
    void isChromeExtensionInstalled().then(isInstalled => {
      if (isInstalled) {
        logForDebugging(
          `[Claude in Chrome] First-time install detected, opening reconnect page in browser`,
        )
        void openInChrome(CHROME_EXTENSION_RECONNECT_URL)
      } else {
        logForDebugging(
          `[Claude in Chrome] First-time install detected, but extension not installed, skipping reconnect`,
        )
      }
    })
  }
}

/**
 * Register the native host in Windows registry for all supported browsers
 */
function registerWindowsNativeHosts(manifestPath: string): void {
  const registryKeys = getAllWindowsRegistryKeys()

  for (const { browser, key } of registryKeys) {
    const fullKey = `${key}\\${NATIVE_HOST_IDENTIFIER}`
    // Use reg.exe to add the registry entry
    // https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
    void execFileNoThrowWithCwd('reg', [
      'add',
      fullKey,
      '/ve', // Set the default (unnamed) value
      '/t',
      'REG_SZ',
      '/d',
      manifestPath,
      '/f', // Force overwrite without prompt
    ]).then(result => {
      if (result.code === 0) {
        logForDebugging(
          `[Claude in Chrome] Registered native host for ${browser} in Windows registry: ${fullKey}`,
        )
      } else {
        logForDebugging(
          `[Claude in Chrome] Failed to register native host for ${browser} in Windows registry: ${result.stderr}`,
        )
      }
    })
  }
}

/**
 * Get cached value of whether Chrome extension is installed. Returns
 * from disk cache immediately, updates cache in background.
 *
 * Use this for sync/startup-critical paths where blocking on filesystem
 * access is not acceptable. The value may be stale if the cache hasn't
 * been updated recently.
 *
 * Only positive detections are persisted. A negative result from the
 * filesystem scan is not cached, because it may come from a machine that
 * shares ~/.openclaude.json but has no local Chrome (e.g. a remote dev
 * environment using the bridge), and caching it would permanently poison
 * auto-enable for every session on every machine that reads that config.
 */
function isChromeExtensionInstalled_CACHED_MAY_BE_STALE(): boolean {
  // Update cache in background without blocking
  void isChromeExtensionInstalled().then(isInstalled => {
    // Only persist positive detections — see docstring. The cost of a stale
    // `true` is one silent MCP connection attempt per session; the cost of a
    // stale `false` is auto-enable never working again without manual repair.
    if (!isInstalled) {
      return
    }
    const config = getGlobalConfig()
    if (config.cachedChromeExtensionInstalled !== isInstalled) {
      saveGlobalConfig(prev => ({
        ...prev,
        cachedChromeExtensionInstalled: isInstalled,
      }))
    }
  })

  // Return cached value immediately from disk
  const cached = getGlobalConfig().cachedChromeExtensionInstalled
  return cached ?? false
}

/**
 * Detects if the Claude in Chrome extension is installed by checking the Extensions
 * directory across all supported Chromium-based browsers and their profiles.
 *
 * @returns Object with isInstalled boolean and the browser where the extension was found
 */
export async function isChromeExtensionInstalled(): Promise<boolean> {
  const browserPaths = getAllBrowserDataPaths()
  if (browserPaths.length === 0) {
    logForDebugging(
      `[Claude in Chrome] Unsupported platform for extension detection: ${getPlatform()}`,
    )
    return false
  }
  return isChromeExtensionInstalledPortable(browserPaths, logForDebugging)
}
