/**
 * No-op GrowthBook stub — all feature gates return false / default values,
 * all config lookups return the provided default, and initialization is a no-op.
 *
 * OpenClaude does not phone home. This module replaces the original
 * analytics-driven GrowthBook client with a local-only implementation that
 * reads feature flags from ~/.openclaude/feature-flags.json for developer overrides.
 *
 * Priority: OPENCLAUDE_FEATURE_FLAGS_FILE env > CLAUDE_FEATURE_FLAGS_FILE env > ~/.openclaude/feature-flags.json > defaultValue
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── Open-build feature flag overrides ───────────────────────────────────
// Only keys that DIFFER from upstream belong here — these are runtime gates
// that should be enabled in the open build regardless of upstream defaults.
const _openBuildDefaults: Record<string, unknown> = {
	tengu_sedge_lantern: true, // AWAY_SUMMARY — "while you were away" recap
	tengu_hive_evidence: true, // VERIFICATION_AGENT — read-only test/verification agent
	tengu_passport_quail: true, // EXTRACT_MEMORIES — enable memory extraction
	tengu_coral_fern: true, // EXTRACT_MEMORIES — enable memory search in past context
}

let _flags: Record<string, unknown> | null | undefined = undefined

function _loadFlags(): void {
	if (_flags !== undefined) return
	try {
		const flagsPath =
			process.env.OPENCLAUDE_FEATURE_FLAGS_FILE ||
			process.env.CLAUDE_FEATURE_FLAGS_FILE ||
			join(homedir(), '.openclaude', 'feature-flags.json')
		const parsed = JSON.parse(readFileSync(flagsPath, 'utf-8'))
		_flags =
			parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
	} catch {
		_flags = null
	}
}

function _getFlagValue<T>(key: string, defaultValue: T): T {
	_loadFlags()
	if (_flags != null && Object.hasOwn(_flags as object, key))
		return (_flags as Record<string, unknown>)[key] as T
	if (Object.hasOwn(_openBuildDefaults, key))
		return _openBuildDefaults[key] as T
	return defaultValue
}

/** User attributes shape — kept for type compatibility. */
export type GrowthBookUserAttributes = {
	id: string
	sessionId: string
	deviceID: string
	platform: 'win32' | 'darwin' | 'linux'
	apiBaseUrlHost?: string
	organizationUUID?: string
	accountUUID?: string
	userType?: string
	subscriptionType?: string
	rateLimitTier?: string
	firstTokenTime?: number
	email?: string
	appVersion?: string
	github?: unknown
}

/** No-op: no background refresh to subscribe to. The listener is never invoked. */
export function onGrowthBookRefresh(_listener?: () => void): void {}

/** Returns false — no env overrides when GrowthBook is disabled. */
export function hasGrowthBookEnvOverride(_feature: string): boolean {
	return false
}

/** Returns the flags object from local file, or `{}` if absent. */
export function getAllGrowthBookFeatures(): Record<string, unknown> {
	_loadFlags()
	return _flags || {}
}

/** Returns `{}` — no config overrides. */
export function getGrowthBookConfigOverrides(): Record<string, unknown> {
	return {}
}

/** No-op — nothing to override. */
export function setGrowthBookConfigOverride(
	_key: string,
	_value: unknown,
): void {}

/** No-op — nothing to clear. */
export function clearGrowthBookConfigOverrides(): void {}

/** Returns `undefined` — no API base URL override. */
export function getApiBaseUrlHost(): string | undefined {
	return undefined
}

/** No-op initialization — GrowthBook client is never created. */
export function initializeGrowthBook(): void {}

/** Returns the default value — feature flags resolve from local file or default. */
export function getFeatureValue_DEPRECATED<T>(
	_featureName: string,
	defaultValue: T,
): T {
	return _getFlagValue(_featureName, defaultValue)
}

/** Returns the default value — feature flags resolve from local file or default. */
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
	_featureName: string,
	defaultValue: T,
): T {
	return _getFlagValue(_featureName, defaultValue)
}

/** Returns the default value — feature flags resolve from local file or default. */
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
	_featureName: string,
	defaultValue: T,
	// Refresh interval accepted for callsite compatibility; this local-file
	// shim has no background refresh, so the value is unused.
	_refreshIntervalMs?: number,
): T {
	return _getFlagValue(_featureName, defaultValue)
}

/** Resolves gate from local feature flags file, defaults to false. */
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
	gateName: string,
): boolean {
	return Boolean(_getFlagValue(gateName, false))
}

/**
 * Always returns false — security restriction gates must not be overridable
 * via local flags, as they protect bypass-permissions mode.
 */
export async function checkSecurityRestrictionGate(
	_gateName: string,
): Promise<boolean> {
	return false
}

/** Resolves gate from local feature flags file, defaults to false. */
export async function checkGate_CACHED_OR_BLOCKING(
	gateName: string,
): Promise<boolean> {
	return Boolean(_getFlagValue(gateName, false))
}

/** No-op — nothing to refresh. */
export function refreshGrowthBookAfterAuthChange(): void {}

/** Resets cached flags so the file is re-read on next access. */
export function resetGrowthBook(): void {
	_flags = undefined
}

/** Resets cached flags so the file is re-read on next access. */
export async function refreshGrowthBookFeatures(): Promise<void> {
	_flags = undefined
}

/** No-op — no periodic refresh to set up. */
export function setupPeriodicGrowthBookRefresh(): void {}

/** No-op — no periodic refresh to stop. */
export function stopPeriodicGrowthBookRefresh(): void {}

/** Returns the default value — dynamic configs resolve from local file or default. */
export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
	_configName: string,
	defaultValue: T,
): Promise<T> {
	return _getFlagValue(_configName, defaultValue)
}

/** Returns the default value — dynamic configs resolve from local file or default. */
export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
	_configName: string,
	defaultValue: T,
): T {
	return _getFlagValue(_configName, defaultValue)
}
