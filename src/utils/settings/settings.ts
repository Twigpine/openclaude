import { feature } from 'bun:bundle'
import mergeWith from 'lodash-es/mergeWith.js'
import { dirname, join, resolve } from 'path'
import { z } from 'zod/v4'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getUseCoworkPlugins,
} from '../../bootstrap/state.js'
import { getRemoteManagedSettingsSyncFromCache } from '../../services/remoteManagedSettings/syncCacheState.js'
import { uniq } from '../array.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { getErrnoCode, isENOENT } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { safeParseJSON } from '../json.js'
import { stripBOM } from '../jsonRead.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { clone, jsonParse, jsonStringify } from '../slowOperations.js'
import { profileCheckpoint } from '../startupProfiler.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from './constants.js'
import { markInternalWrite } from './internalWrites.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from './managedPath.js'
import { getHkcuSettings, getMdmSettings } from './mdm/settings.js'
import {
  getCachedParsedFile,
  getCachedSettingsForSource,
  getPluginSettingsBase,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settingsCache.js'
import { withSettingsFileTransactionSync } from './settingsFileTransaction.js'
import { type SettingsJson, SettingsSchema } from './types.js'
import {
  filterInvalidModelPricing,
  filterInvalidPermissionRules,
  formatZodError,
  type SettingsWithErrors,
  type ValidationError,
} from './validation.js'

/**
 * Get the path to the managed settings file based on the current platform
 */
function getManagedSettingsFilePath(): string {
  return join(getManagedFilePath(), 'managed-settings.json')
}

/**
 * Load file-based managed settings: managed-settings.json + managed-settings.d/*.json.
 *
 * managed-settings.json is merged first (lowest precedence / base), then drop-in
 * files are sorted alphabetically and merged on top (higher precedence, later
 * files win). This matches the systemd/sudoers drop-in convention: the base
 * file provides defaults, drop-ins customize. Separate teams can ship
 * independent policy fragments (e.g. 10-otel.json, 20-security.json) without
 * coordinating edits to a single admin-owned file.
 *
 * Exported for testing.
 */
export function loadManagedFileSettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const errors: ValidationError[] = []
  let merged: SettingsJson = {}
  let found = false

  const { settings, errors: baseErrors } = parseSettingsFile(
    getManagedSettingsFilePath(),
  )
  errors.push(...baseErrors)
  if (settings && Object.keys(settings).length > 0) {
    merged = mergeWith(merged, settings, settingsMergeCustomizer)
    found = true
  }

  const dropInDir = getManagedSettingsDropInDir()
  try {
    const entries = getFsImplementation()
      .readdirSync(dropInDir)
      .filter(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
      .map(d => d.name)
      .sort()
    for (const name of entries) {
      const { settings, errors: fileErrors } = parseSettingsFile(
        join(dropInDir, name),
      )
      errors.push(...fileErrors)
      if (settings && Object.keys(settings).length > 0) {
        merged = mergeWith(merged, settings, settingsMergeCustomizer)
        found = true
      }
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logError(e)
    }
  }

  return { settings: found ? merged : null, errors }
}

/**
 * Check which file-based managed settings sources are present.
 * Used by /status to show "(file)", "(drop-ins)", or "(file + drop-ins)".
 */
export function getManagedFileSettingsPresence(): {
  hasBase: boolean
  hasDropIns: boolean
} {
  const { settings: base } = parseSettingsFile(getManagedSettingsFilePath())
  const hasBase = !!base && Object.keys(base).length > 0

  let hasDropIns = false
  const dropInDir = getManagedSettingsDropInDir()
  try {
    hasDropIns = getFsImplementation()
      .readdirSync(dropInDir)
      .some(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
  } catch {
    // dir doesn't exist
  }

  return { hasBase, hasDropIns }
}

/**
 * Handles file system errors appropriately
 * @param error The error to handle
 * @param path The file path that caused the error
 */
function handleFileSystemError(error: unknown, path: string): void {
  if (
    typeof error === 'object' &&
    error &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    logForDebugging(
      `Broken symlink or missing file encountered for settings.json at path: ${path}`,
    )
  } else {
    logError(error)
  }
}

/**
 * Parses a settings file into a structured format
 * @param path The path to the permissions file
 * @param source The source of the settings (optional, for error reporting)
 * @returns Parsed settings data and validation errors
 */
export function parseSettingsFile(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const cached = getCachedParsedFile(path)
  if (cached) {
    // Clone so callers (e.g. mergeWith in getSettingsForSourceUncached,
    // updateSettingsForSource) can't mutate the cached entry.
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: cached.errors,
    }
  }
  const result = parseSettingsFileUncached(path)
  setCachedParsedFile(path, result)
  // Clone the first return too — the caller may mutate before
  // another caller reads the same cache entry.
  return {
    settings: result.settings ? clone(result.settings) : null,
    errors: result.errors,
  }
}

function parseSettingsFileUncached(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), path)
    const content = readFileSync(resolvedPath)

    if (content.trim() === '') {
      return { settings: {}, errors: [] }
    }

    const data = safeParseJSON(content, false)

    // Filter invalid permission rules before schema validation so one bad
    // rule doesn't cause the entire settings file to be rejected.
    const ruleWarnings = filterInvalidPermissionRules(data, path)
    const modelPricingWarnings = filterInvalidModelPricing(data, path)

    const result = SettingsSchema().safeParse(data)

    if (!result.success) {
      const errors = formatZodError(result.error, path)
      return {
        settings: null,
        errors: [...ruleWarnings, ...modelPricingWarnings, ...errors],
      }
    }

    return {
      settings: result.data,
      errors: [...ruleWarnings, ...modelPricingWarnings],
    }
  } catch (error) {
    handleFileSystemError(error, path)
    return { settings: null, errors: [] }
  }
}

/**
 * Get the absolute path to the associated file root for a given settings source
 * (e.g. for $PROJ_DIR/.openclaude/settings.json, returns $PROJ_DIR)
 * @param source The source of the settings
 * @returns The root path of the settings file
 */
export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return resolve(getClaudeConfigHomeDir())
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings': {
      return resolve(getOriginalCwd())
    }
    case 'flagSettings': {
      const path = getFlagSettingsPath()
      return path ? dirname(resolve(path)) : resolve(getOriginalCwd())
    }
  }
}

/**
 * Get the user settings filename based on cowork mode.
 * Returns 'cowork_settings.json' when in cowork mode, 'settings.json' otherwise.
 *
 * Priority:
 * 1. Session state (set by CLI flag --cowork)
 * 2. Environment variable CLAUDE_CODE_USE_COWORK_PLUGINS
 * 3. Default: 'settings.json'
 */
function getUserSettingsFilePath(): string {
  if (
    getUseCoworkPlugins() ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)
  ) {
    return 'cowork_settings.json'
  }
  return 'settings.json'
}

export function getSettingsFilePathForSource(
  source: SettingSource,
): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(
        getSettingsRootPathForSource(source),
        getUserSettingsFilePath(),
      )
    case 'projectSettings':
    case 'localSettings': {
      return join(
        getSettingsRootPathForSource(source),
        getRelativeSettingsFilePathForSource(source),
      )
    }
    case 'policySettings':
      return getManagedSettingsFilePath()
    case 'flagSettings': {
      return getFlagSettingsPath()
    }
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  switch (source) {
    case 'projectSettings':
      return '.openclaude/settings.json'
    case 'localSettings':
      return '.openclaude/settings.local.json'
  }
}

export function getSettingsForSource(
  source: SettingSource,
): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) return cached
  const result = getSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, result)
  return result
}

function getSettingsForSourceUncached(
  source: SettingSource,
): SettingsJson | null {
  // For policySettings: first source wins (remote > HKLM/plist > file > HKCU)
  if (source === 'policySettings') {
    const remoteSettings = getRemoteManagedSettingsSyncFromCache()
    if (remoteSettings && Object.keys(remoteSettings).length > 0) {
      return remoteSettings
    }

    const mdmResult = getMdmSettings()
    if (Object.keys(mdmResult.settings).length > 0) {
      return mdmResult.settings
    }

    const { settings: fileSettings } = loadManagedFileSettings()
    if (fileSettings) {
      return fileSettings
    }

    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0) {
      return hkcu.settings
    }

    return null
  }

  const settingsFilePath = getSettingsFilePathForSource(source)
  const { settings: fileSettings } = settingsFilePath
    ? parseSettingsFile(settingsFilePath)
    : { settings: null }

  // For flagSettings, merge in any inline settings set via the SDK
  if (source === 'flagSettings') {
    const inlineSettings = getFlagSettingsInline()
    if (inlineSettings) {
      const parsed = SettingsSchema().safeParse(inlineSettings)
      if (parsed.success) {
        return mergeWith(
          fileSettings || {},
          parsed.data,
          settingsMergeCustomizer,
        ) as SettingsJson
      }
    }
  }

  return fileSettings
}

/**
 * Get the origin of the highest-priority active policy settings source.
 * Uses "first source wins" — returns the first source that has content.
 * Priority: remote > plist/hklm > file (managed-settings.json) > hkcu
 */
export function getPolicySettingsOrigin():
  | 'remote'
  | 'plist'
  | 'hklm'
  | 'file'
  | 'hkcu'
  | null {
  // 1. Remote (highest)
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    return 'remote'
  }

  // 2. Admin-only MDM (HKLM / macOS plist)
  const mdmResult = getMdmSettings()
  if (Object.keys(mdmResult.settings).length > 0) {
    return getPlatform() === 'macos' ? 'plist' : 'hklm'
  }

  // 3. managed-settings.json + managed-settings.d/ (file-based, requires admin)
  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) {
    return 'file'
  }

  // 4. HKCU (lowest — user-writable)
  const hkcu = getHkcuSettings()
  if (Object.keys(hkcu.settings).length > 0) {
    return 'hkcu'
  }

  return null
}

/**
 * Merges `settings` into the existing settings for `source` using lodash mergeWith.
 *
 * To delete a key from a record field (e.g. enabledPlugins, extraKnownMarketplaces),
 * set it to `undefined` — do NOT use `delete`. mergeWith only detects deletion when
 * the key is present with an explicit `undefined` value.
 */
export function updateSettingsForSource(
  source: EditableSettingSource,
  settings: SettingsJson,
): { error: Error | null } {
  if (
    (source as unknown) === 'policySettings' ||
    (source as unknown) === 'flagSettings'
  ) {
    return { error: null }
  }

  // Create the folder if needed
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return { error: null }
  }

  try {
    const validationError = withSettingsFileTransactionSync(
      filePath,
      targetPath => {
        // The transaction merge base must bypass both process-local settings
        // caches so a peer's completed update cannot be overwritten.
        let existingSettings = parseSettingsFileUncached(targetPath).settings

        // If validation failed, distinguish syntax errors from schema-invalid
        // objects whose unknown fields still need to survive the merge.
        if (!existingSettings) {
          let content: string | null = null
          try {
            content = readFileSync(targetPath)
          } catch (e) {
            if (!isENOENT(e)) throw e
            // File doesn't exist — fall through to merge with empty settings.
          }
          if (content !== null) {
            let rawData: unknown
            try {
              rawData = jsonParse(stripBOM(content))
            } catch (parseError) {
              logError(parseError)
              return new Error(
                `Invalid JSON syntax in settings file at ${filePath}`,
              )
            }
            if (
              rawData === null ||
              typeof rawData !== 'object' ||
              Array.isArray(rawData)
            ) {
              return new Error(
                `Invalid settings document at ${filePath}: expected a JSON object`,
              )
            }
            existingSettings = rawData as SettingsJson
            logForDebugging(
              `Using raw settings from ${filePath} due to validation failure`,
            )
          }
        }

        const updatedSettings = mergeWith(
          existingSettings || {},
          settings,
          (
            _objValue: unknown,
            srcValue: unknown,
            key: string | number | symbol,
            object: Record<string | number | symbol, unknown>,
          ) => {
            // Handle undefined as deletion
            if (srcValue === undefined && object && typeof key === 'string') {
              delete object[key]
              return undefined
            }
            // For arrays, always replace with the provided array
            // This puts the responsibility on the caller to compute the desired final state
            if (Array.isArray(srcValue)) {
              return srcValue
            }
            // For non-arrays, let lodash handle the default merge behavior
            return undefined
          },
        )

        writeFileSyncAndFlush_DEPRECATED(
          targetPath,
          jsonStringify(updatedSettings, null, 2) + '\n',
        )
        markInternalWrite(filePath)
        resetSettingsCache()
        return null
      },
    )
    if (validationError) return { error: validationError }

    if (source === 'localSettings' || source === 'projectSettings') {
      // Okay to add to gitignore async without awaiting
      const relativePath = getRelativeSettingsFilePathForSource(source)
      if (source === 'localSettings') {
        void addFileGlobRuleToGitignore(relativePath, getOriginalCwd())
      }
      void addFileGlobRuleToGitignore(
        `${relativePath}.lock*`,
        getOriginalCwd(),
      )
    }
  } catch (e) {
    const error = new Error(`Failed to update settings at ${filePath}: ${e}`)
    logError(error)
    return { error }
  }

  return { error: null }
}

/**
 * Custom merge function for structured settings values.
 */
function mergeArrays<T>(targetArray: T[], sourceArray: T[]): T[] {
  return uniq([...targetArray, ...sourceArray])
}

/**
 * Custom merge function for lodash mergeWith when merging settings.
 * Arrays are concatenated and deduplicated. Model-pricing maps preserve
 * arbitrary exact keys and replace complete entries. Other values use default
 * lodash merge behavior.
 * Exported for testing.
 */
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
  key?: PropertyKey,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)
  }
  if (
    key === 'modelPricing' &&
    typeof srcValue === 'object' &&
    srcValue !== null &&
    !Array.isArray(srcValue)
  ) {
    // Model ids are arbitrary strings, including Object.prototype names.
    // Copy into a null-prototype map so mergeWith cannot interpret them as
    // structure. Replace each complete higher-priority entry atomically: a
    // missing optional webSearchRequests field must use its documented
    // default, not inherit a lower-priority source's value.
    const merged = Object.create(null) as Record<string, unknown>
    if (
      typeof objValue === 'object' &&
      objValue !== null &&
      !Array.isArray(objValue)
    ) {
      for (const [model, entry] of Object.entries(objValue)) {
        merged[model] = entry
      }
    }
    for (const [model, entry] of Object.entries(srcValue)) {
      merged[model] = entry
    }
    return merged
  }
  // Return undefined to let lodash handle default merge behavior
  return undefined
}

/**
 * Get a list of setting keys from managed settings for logging purposes.
 * For certain nested settings (permissions, sandbox, hooks), expands to show
 * one level of nesting (e.g., "permissions.allow"). For other settings,
 * returns only the top-level key.
 *
 * @param settings The settings object to extract keys from
 * @returns Sorted array of key paths
 */
export function getManagedSettingsKeysForLogging(
  settings: SettingsJson,
): string[] {
  // Use .strip() to get only valid schema keys
  const validSettings = SettingsSchema().strip().parse(settings) as Record<
    string,
    unknown
  >
  const keysToExpand = ['permissions', 'sandbox', 'hooks']
  const allKeys: string[] = []

  // Define valid nested keys for each nested setting we expand
  const validNestedKeys: Record<string, Set<string>> = {
    permissions: new Set([
      'allow',
      'deny',
      'ask',
      'defaultMode',
      'disableBypassPermissionsMode',
      'allowBypassPermissionsMode',
      ...(feature('TRANSCRIPT_CLASSIFIER') ? ['disableAutoMode'] : []),
      'additionalDirectories',
    ]),
    sandbox: new Set([
      'enabled',
      'failIfUnavailable',
      'allowUnsandboxedCommands',
      'network',
      'filesystem',
      'ignoreViolations',
      'excludedCommands',
      'autoAllowBashIfSandboxed',
      'enableWeakerNestedSandbox',
      'enableWeakerNetworkIsolation',
      'ripgrep',
    ]),
    // For hooks, we use z.record with enum keys, so we validate separately
    hooks: new Set([
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'UserPromptSubmit',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'TeammateIdle',
      'TaskCreated',
      'TaskCompleted',
    ]),
  }

  for (const key of Object.keys(validSettings)) {
    if (
      keysToExpand.includes(key) &&
      validSettings[key] &&
      typeof validSettings[key] === 'object'
    ) {
      // Expand nested keys for these special settings (one level deep only)
      const nestedObj = validSettings[key] as Record<string, unknown>
      const validKeys = validNestedKeys[key]

      if (validKeys) {
        for (const nestedKey of Object.keys(nestedObj)) {
          // Only include known valid nested keys
          if (validKeys.has(nestedKey)) {
            allKeys.push(`${key}.${nestedKey}`)
          }
        }
      }
    } else {
      // For other settings, just use the top-level key
      allKeys.push(key)
    }
  }

  return allKeys.sort()
}

function isSettingsLoadInProgress(): boolean {
  return (
    (globalThis as Record<string, unknown>)[
      '__openclaudeSettingsLoadInProgress'
    ] === true
  )
}

function setSettingsLoadInProgress(value: boolean): void {
  ;(globalThis as Record<string, unknown>)[
    '__openclaudeSettingsLoadInProgress'
  ] = value
}

/**
 * Load settings from disk without using cache
 * This is the original implementation that actually reads from files
 */
function loadSettingsFromDisk(): SettingsWithErrors {
  // Prevent recursive calls to loadSettingsFromDisk
  if (isSettingsLoadInProgress()) {
    return { settings: {}, errors: [] }
  }

  const startTime = Date.now()
  profileCheckpoint('loadSettingsFromDisk_start')
  logForDiagnosticsNoPII('info', 'settings_load_started')

  setSettingsLoadInProgress(true)
  try {
    // Start with plugin settings as the lowest priority base.
    // All file-based sources (user, project, local, flag, policy) override these.
    // Plugin settings only contain allowlisted keys (e.g., agent) that are valid SettingsJson fields.
    const pluginSettings = getPluginSettingsBase()
    let mergedSettings: SettingsJson = {}
    if (pluginSettings) {
      mergedSettings = mergeWith(
        mergedSettings,
        pluginSettings,
        settingsMergeCustomizer,
      )
    }
    const allErrors: ValidationError[] = []
    const seenErrors = new Set<string>()
    const seenFiles = new Set<string>()

    // Merge settings from each source in priority order with deep merging
    for (const source of getEnabledSettingSources()) {
      // policySettings: "first source wins" — use the highest-priority source
      // that has content. Priority: remote > HKLM/plist > managed-settings.json > HKCU
      if (source === 'policySettings') {
        let policySettings: SettingsJson | null = null
        const policyErrors: ValidationError[] = []

        // 1. Remote (highest priority)
        const remoteSettings = getRemoteManagedSettingsSyncFromCache()
        if (remoteSettings && Object.keys(remoteSettings).length > 0) {
          const result = SettingsSchema().safeParse(remoteSettings)
          if (result.success) {
            policySettings = result.data
          } else {
            // Remote exists but is invalid — surface errors even as we fall through
            policyErrors.push(
              ...formatZodError(result.error, 'remote managed settings'),
            )
          }
        }

        // 2. Admin-only MDM (HKLM / macOS plist)
        if (!policySettings) {
          const mdmResult = getMdmSettings()
          if (Object.keys(mdmResult.settings).length > 0) {
            policySettings = mdmResult.settings
          }
          policyErrors.push(...mdmResult.errors)
        }

        // 3. managed-settings.json + managed-settings.d/ (file-based, requires admin)
        if (!policySettings) {
          const { settings, errors } = loadManagedFileSettings()
          if (settings) {
            policySettings = settings
          }
          policyErrors.push(...errors)
        }

        // 4. HKCU (lowest — user-writable, only if nothing above exists)
        if (!policySettings) {
          const hkcu = getHkcuSettings()
          if (Object.keys(hkcu.settings).length > 0) {
            policySettings = hkcu.settings
          }
          policyErrors.push(...hkcu.errors)
        }

        // Merge the winning policy source into the settings chain
        if (policySettings) {
          mergedSettings = mergeWith(
            mergedSettings,
            policySettings,
            settingsMergeCustomizer,
          )
        }
        for (const error of policyErrors) {
          const errorKey = `${error.file}:${error.path}:${error.message}`
          if (!seenErrors.has(errorKey)) {
            seenErrors.add(errorKey)
            allErrors.push(error)
          }
        }

        continue
      }

      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolvedPath = resolve(filePath)

        // Skip if we've already loaded this file from another source
        if (!seenFiles.has(resolvedPath)) {
          seenFiles.add(resolvedPath)

          const { settings, errors } = parseSettingsFile(filePath)

          // Add unique errors (deduplication)
          for (const error of errors) {
            const errorKey = `${error.file}:${error.path}:${error.message}`
            if (!seenErrors.has(errorKey)) {
              seenErrors.add(errorKey)
              allErrors.push(error)
            }
          }

          if (settings) {
            mergedSettings = mergeWith(
              mergedSettings,
              settings,
              settingsMergeCustomizer,
            )
          }
        }
      }

      // For flagSettings, also merge any inline settings set via the SDK
      if (source === 'flagSettings') {
        const inlineSettings = getFlagSettingsInline()
        if (inlineSettings) {
          const parsed = SettingsSchema().safeParse(inlineSettings)
          if (parsed.success) {
            mergedSettings = mergeWith(
              mergedSettings,
              parsed.data,
              settingsMergeCustomizer,
            )
          }
        }
      }
    }

    logForDiagnosticsNoPII('info', 'settings_load_completed', {
      duration_ms: Date.now() - startTime,
      source_count: seenFiles.size,
      error_count: allErrors.length,
    })

    return { settings: mergedSettings, errors: allErrors }
  } finally {
    setSettingsLoadInProgress(false)
  }
}

/**
 * Get merged settings from all sources in priority order
 * Settings are merged from lowest to highest priority:
 * userSettings -> projectSettings -> localSettings -> policySettings
 *
 * This function returns a snapshot of settings at the time of call.
 * For React components, prefer using useSettings() hook for reactive updates
 * when settings change on disk.
 *
 * Uses session-level caching to avoid repeated file I/O.
 * Cache is invalidated when settings files change via resetSettingsCache().
 *
 * @returns Merged settings from all available sources (always returns at least empty object)
 */
export function getInitialSettings(): SettingsJson {
  const { settings } = getSettingsWithErrors()
  return settings || {}
}

/**
 * @deprecated Use getInitialSettings() instead. Keep this as a function
 * declaration so cyclic test-only module graphs never observe it in TDZ.
 */
export function getSettings_DEPRECATED(): SettingsJson {
  return getInitialSettings()
}

export type SettingsWithSources = {
  effective: SettingsJson
  /** Ordered low-to-high priority — later entries override earlier ones. */
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

/**
 * Get the effective merged settings alongside the raw per-source settings,
 * in merge-priority order. Only includes sources that are enabled and have
 * non-empty content.
 *
 * Always reads fresh from disk — resets the session cache so that `effective`
 * and `sources` are consistent even if the change detector hasn't fired yet.
 */
export function getSettingsWithSources(): SettingsWithSources {
  // Reset both caches so getSettingsForSource (per-source cache) and
  // getInitialSettings (session cache) agree on the current disk state.
  resetSettingsCache()
  const sources: SettingsWithSources['sources'] = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings && Object.keys(settings).length > 0) {
      sources.push({ source, settings })
    }
  }
  return { effective: getInitialSettings(), sources }
}

/**
 * Get merged settings and validation errors from all sources
 * This function now uses session-level caching to avoid repeated file I/O.
 * Settings changes require Claude Code restart, so cache is valid for entire session.
 * @returns Merged settings and all validation errors encountered
 */
export function getSettingsWithErrors(): SettingsWithErrors {
  // Use cached result if available
  const cached = getSessionSettingsCache()
  if (cached !== null) {
    return cached
  }

  // Load from disk and cache the result
  const result = loadSettingsFromDisk()
  profileCheckpoint('loadSettingsFromDisk_end')
  setSessionSettingsCache(result)
  return result
}

/**
 * Check if any raw settings file contains a specific key, regardless of validation.
 * This is useful for detecting user intent even when settings validation fails.
 * For example, if a user set cleanupPeriodDays but has validation errors elsewhere,
 * we can detect they explicitly configured cleanup and skip cleanup rather than
 * falling back to defaults.
 */
/**
 * Returns true if any trusted settings source has accepted the bypass
 * permissions mode dialog. projectSettings is intentionally excluded —
 * a malicious project could otherwise auto-bypass the dialog (RCE risk).
 */
export function hasSkipDangerousModePermissionPrompt(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('localSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('flagSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('policySettings')?.skipDangerousModePermissionPrompt
  )
}

/**
 * Returns true if any trusted settings source has accepted the full access
 * mode dialog. This is intentionally separate from bypass permissions because
 * fullAccess skips an additional hard safety-check layer.
 */
export function hasSkipFullAccessModePermissionPrompt(): boolean {
  return !!(
    getSettingsForSource('userSettings')
      ?.skipFullAccessModePermissionPrompt ||
    getSettingsForSource('localSettings')
      ?.skipFullAccessModePermissionPrompt ||
    getSettingsForSource('flagSettings')
      ?.skipFullAccessModePermissionPrompt ||
    getSettingsForSource('policySettings')
      ?.skipFullAccessModePermissionPrompt
  )
}

/**
 * Returns true if any trusted settings source has enabled bypass permissions
 * mode availability. projectSettings is intentionally excluded — a malicious
 * project could otherwise enable bypass mode (security risk).
 */
export function hasAllowBypassPermissionsMode(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.permissions
      ?.allowBypassPermissionsMode ||
    getSettingsForSource('localSettings')?.permissions
      ?.allowBypassPermissionsMode ||
    getSettingsForSource('flagSettings')?.permissions
      ?.allowBypassPermissionsMode ||
    getSettingsForSource('policySettings')?.permissions
      ?.allowBypassPermissionsMode
  )
}

/**
 * Returns true if any trusted settings source has accepted the auto
 * mode opt-in dialog. projectSettings is intentionally excluded —
 * a malicious project could otherwise auto-bypass the dialog (RCE risk).
 */
export function hasAutoModeOptIn(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const user = getSettingsForSource('userSettings')?.skipAutoPermissionPrompt
    const local =
      getSettingsForSource('localSettings')?.skipAutoPermissionPrompt
    const flag = getSettingsForSource('flagSettings')?.skipAutoPermissionPrompt
    const policy =
      getSettingsForSource('policySettings')?.skipAutoPermissionPrompt
    const result = !!(user || local || flag || policy)
    logForDebugging(
      `[auto-mode] hasAutoModeOptIn=${result} skipAutoPermissionPrompt: user=${user} local=${local} flag=${flag} policy=${policy}`,
    )
    return result
  }
  return false
}

/**
 * Returns whether plan mode should use auto mode semantics. Default true
 * (opt-out). Returns false if any trusted source explicitly sets false.
 * projectSettings is excluded so a malicious project can't control this.
 */
export function getUseAutoModeDuringPlan(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      getSettingsForSource('policySettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('flagSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('userSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('localSettings')?.useAutoModeDuringPlan !== false
    )
  }
  return true
}

/**
 * Returns the merged autoMode config from trusted settings sources.
 * Only available when TRANSCRIPT_CLASSIFIER is active; returns undefined otherwise.
 * projectSettings is intentionally excluded — a malicious project could
 * otherwise inject classifier allow/deny rules (RCE risk).
 */
export function getAutoModeConfig():
  | { allow?: string[]; soft_deny?: string[]; environment?: string[] }
  | undefined {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const schema = z.object({
      allow: z.array(z.string()).optional(),
      soft_deny: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      environment: z.array(z.string()).optional(),
    })

    const allow: string[] = []
    const soft_deny: string[] = []
    const environment: string[] = []

    for (const source of [
      'userSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      const settings = getSettingsForSource(source)
      if (!settings) continue
      const result = schema.safeParse(
        (settings as Record<string, unknown>).autoMode,
      )
      if (result.success) {
        if (result.data.allow) allow.push(...result.data.allow)
        if (result.data.soft_deny) soft_deny.push(...result.data.soft_deny)
        if (process.env.USER_TYPE === 'ant') {
          if (result.data.deny) soft_deny.push(...result.data.deny)
        }
        if (result.data.environment)
          environment.push(...result.data.environment)
      }
    }

    if (allow.length > 0 || soft_deny.length > 0 || environment.length > 0) {
      return {
        ...(allow.length > 0 && { allow }),
        ...(soft_deny.length > 0 && { soft_deny }),
        ...(environment.length > 0 && { environment }),
      }
    }
  }
  return undefined
}

export function rawSettingsContainsKey(key: string): boolean {
  for (const source of getEnabledSettingSources()) {
    // Skip policySettings - we only care about user-configured settings
    if (source === 'policySettings') {
      continue
    }

    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) {
      continue
    }

    try {
      const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
      const content = readFileSync(resolvedPath)
      if (!content.trim()) {
        continue
      }

      const rawData = safeParseJSON(content, false)
      if (rawData && typeof rawData === 'object' && key in rawData) {
        return true
      }
    } catch (error) {
      // File not found is expected - not all settings files exist
      // Other errors (permissions, I/O) should be tracked
      handleFileSystemError(error, filePath)
    }
  }

  return false
}
