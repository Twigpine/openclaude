/**
 * No-Telemetry Build Plugin for OpenClaude
 *
 * Replaces phone-home, internal-only, and deleted-Anthropics-internal modules
 * with no-op stubs at compile time. Zero runtime cost, zero network calls.
 *
 * Analytics and telemetry modules have been replaced at the source level and
 * no longer need build-time stubs. This plugin now only covers:
 *
 *   - Plugin fetch telemetry
 *   - Transcript / feedback sharing
 *   - Internal employee logging
 *   - Deleted Anthropic-internal modules (dump prompts, undercover, protobuf stubs)
 *
 * This file is NOT tracked upstream — merge conflicts are impossible.
 * Only build.ts needs a one-line import + one-line array entry.
 */

import type { BunPlugin } from 'bun'

// Module path (relative to src/, without extension) → stub source
const stubs: Record<string, string> = {

	// ─── Plugin fetch telemetry (not the marketplace itself) ───────

	'utils/plugins/fetchTelemetry': `
export function logPluginFetch() {}
export function classifyFetchError() { return 'disabled'; }
`,

	// ─── Transcript / feedback sharing ─────────────────────────────

	'components/FeedbackSurvey/submitTranscriptShare': `
export async function submitTranscriptShare() { return { success: false }; }
`,

	// ─── Internal employee logging (not needed in the external build) ─────

	'services/internalLogging': `
export async function logPermissionContextForAnts() {}
export const getContainerId = async () => null;
`,

	// ─── Deleted Anthropic-internal modules ───────────────────────────────

	'services/api/dumpPrompts': `
export function createDumpPromptsFetch() { return undefined; }
export function getDumpPromptsPath() { return ''; }
export function getLastApiRequests() { return []; }
export function clearApiRequestCache() {}
export function clearDumpState() {}
export function clearAllDumpState() {}
export function addApiRequestToCache() {}
`,

	'utils/undercover': `
export function isUndercover() { return false; }
export function getUndercoverInstructions() { return ''; }
export function shouldShowUndercoverAutoNotice() { return false; }
`,

	'types/generated/events_mono/claude_code/v1/claude_code_internal_event': `
export const ClaudeCodeInternalEvent = {
  fromJSON: value => value,
  toJSON: value => value,
  create: value => value ?? {},
  fromPartial: value => value ?? {},
};
`,

	'types/generated/events_mono/growthbook/v1/growthbook_experiment_event': `
export const GrowthbookExperimentEvent = {
  fromJSON: value => value,
  toJSON: value => value,
  create: value => value ?? {},
  fromPartial: value => value ?? {},
};
`,

	'types/generated/events_mono/common/v1/auth': `
export const PublicApiAuth = {
  fromJSON: value => value,
  toJSON: value => value,
  create: value => value ?? {},
  fromPartial: value => value ?? {},
};
`,

	'types/generated/google/protobuf/timestamp': `
export const Timestamp = {
  fromJSON: value => value,
  toJSON: value => value,
  create: value => value ?? {},
  fromPartial: value => value ?? {},
};
`,
}

function escapeForResolvedPathRegex(modulePath: string): string {
	return modulePath
		.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
		.replace(/\//g, '[/\\\\]')
}

export const noTelemetryPlugin: BunPlugin = {
	name: 'no-telemetry',
	setup(build) {
		for (const [modulePath, contents] of Object.entries(stubs)) {
			// Build regex that matches the resolved file path on any OS
			// e.g. "services/analytics/growthbook" → /services[/\\]analytics[/\\]growthbook\.(ts|js)$/
			const escaped = escapeForResolvedPathRegex(modulePath)
			const filter = new RegExp(`${escaped}\\.(ts|js)$`)

			build.onLoad({ filter }, () => ({
				contents,
				loader: 'js',
			}))
		}

		console.log(`  🔇 no-telemetry: stubbed ${Object.keys(stubs).length} modules`)
	},
}