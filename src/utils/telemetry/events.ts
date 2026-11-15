/**
 * User-facing OpenTelemetry logs exporter.
 *
 * Emits `claude_code.*` log events to the user's own OTLP collector when
 * CLAUDE_CODE_ENABLE_TELEMETRY=1 is set. With telemetry disabled every call
 * is a no-op and redactIfDisabled() returns '<REDACTED>'.
 *
 * Dependency-free: speaks OTLP/HTTP JSON directly rather than pulling in
 * the @opentelemetry SDK. Supported env vars match upstream's contract:
 *
 *   CLAUDE_CODE_ENABLE_TELEMETRY      master switch (required)
 *   OTEL_LOGS_EXPORTER                'otlp' (default) | 'console' | 'none'
 *   OTEL_EXPORTER_OTLP_ENDPOINT       base endpoint; '/v1/logs' is appended
 *   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT  full logs endpoint (takes precedence)
 *   OTEL_EXPORTER_OTLP_HEADERS        'k=v,k2=v2' headers
 *   OTEL_EXPORTER_OTLP_LOGS_HEADERS   logs-specific headers (precedence)
 *   OTEL_EXPORTER_OTLP_TIMEOUT        export request timeout ms (default 10000)
 *   OTEL_LOGS_EXPORT_INTERVAL         batch flush interval ms (default 5000)
 *   OTEL_RESOURCE_ATTRIBUTES          'k=v,k2=v2' resource attributes
 *   OTEL_LOG_USER_PROMPTS             include prompt text in user_prompt events
 */

import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { getProxyFetchOptions } from '../proxy.js'

export type OTelEventMetadata = {
	[key: string]: string | number | boolean | undefined
}

type OTelAttributeValue =
	| { stringValue: string }
	| { intValue: string }
	| { doubleValue: number }
	| { boolValue: boolean }

type OTelAttribute = { key: string; value: OTelAttributeValue }

type OTelLogRecord = {
	timeUnixNano: string
	severityNumber: number
	severityText: string
	body: { stringValue: string }
	attributes: OTelAttribute[]
}

const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_EXPORT_TIMEOUT_MS = 10000
const MAX_BUFFERED_RECORDS = 1000
const EVENT_NAME_PREFIX = 'claude_code.'
// severityNumber 9 = INFO per the OTel logs data model
const INFO_SEVERITY_NUMBER = 9

const pendingRecords: OTelLogRecord[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined
let droppedRecordCount = 0
let beforeExitHookInstalled = false

type LogsExporterKind = 'otlp' | 'console' | 'none'

function logsExporterKind(): LogsExporterKind {
	const raw = process.env.OTEL_LOGS_EXPORTER?.trim().toLowerCase()
	if (raw === 'console' || raw === 'none') return raw
	return 'otlp'
}

function otelLogsEndpoint(): string | undefined {
	const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
	if (logsEndpoint) return logsEndpoint
	const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, '')
	if (!base) return undefined
	return `${base}/v1/logs`
}

type ResolvedConfig = {
	enabled: boolean
	kind: LogsExporterKind
	endpoint: string | undefined
}

let resolvedConfig: ResolvedConfig | undefined

function otelConfig(): ResolvedConfig {
	if (resolvedConfig) return resolvedConfig
	const kind = logsExporterKind()
	const endpoint = kind === 'otlp' ? otelLogsEndpoint() : undefined
	resolvedConfig = {
		kind,
		endpoint,
		enabled:
			isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TELEMETRY) &&
			kind !== 'none' &&
			(kind === 'console' || endpoint !== undefined),
	}
	return resolvedConfig
}

export function isTelemetryEnabled(): boolean {
	return otelConfig().enabled
}

function logsFlushIntervalMs(): number {
	const parsed = Number(process.env.OTEL_LOGS_EXPORT_INTERVAL)
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_FLUSH_INTERVAL_MS
}

function otelExportTimeoutMs(): number {
	const parsed = Number(process.env.OTEL_EXPORTER_OTLP_TIMEOUT)
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_EXPORT_TIMEOUT_MS
}

function parseKeyValueList(raw: string | undefined): Record<string, string> {
	const result: Record<string, string> = {}
	if (!raw) return result
	for (const pair of raw.split(',')) {
		const eq = pair.indexOf('=')
		if (eq === -1) continue
		const key = pair.slice(0, eq).trim()
		if (!key) continue
		const value = pair.slice(eq + 1).trim()
		try {
			result[key] = decodeURIComponent(value)
		} catch {
			result[key] = value
		}
	}
	return result
}

function otelHeaders(): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		...parseKeyValueList(process.env.OTEL_EXPORTER_OTLP_HEADERS),
		...parseKeyValueList(process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
	}
}

function resourceAttributes(): OTelAttribute[] {
	return toAttributes({
		'service.name': 'openclaude',
		'service.version': MACRO.VERSION,
		...parseKeyValueList(process.env.OTEL_RESOURCE_ATTRIBUTES),
	})
}

function toAttributeValue(value: string | number | boolean): OTelAttributeValue {
	if (typeof value === 'boolean') return { boolValue: value }
	if (typeof value === 'number') {
		return Number.isInteger(value)
			? { intValue: String(value) }
			: { doubleValue: value }
	}
	return { stringValue: value }
}

function toAttributes(metadata: OTelEventMetadata): OTelAttribute[] {
	const attributes: OTelAttribute[] = []
	for (const [key, value] of Object.entries(metadata)) {
		if (value === undefined) continue
		attributes.push({ key, value: toAttributeValue(value) })
	}
	return attributes
}

let staticEventAttributes: OTelEventMetadata | undefined

function commonEventAttributes(): OTelEventMetadata {
	if (!staticEventAttributes) {
		staticEventAttributes = {
			'app.version': MACRO.VERSION,
			'os.type': process.platform,
			'host.arch': process.arch,
			'terminal.type': process.env.TERM_PROGRAM,
		}
	}
	return {
		'session.id': getSessionId(),
		...staticEventAttributes,
	}
}

function qualifiedEventName(eventName: string): string {
	return eventName.startsWith(EVENT_NAME_PREFIX)
		? eventName
		: `${EVENT_NAME_PREFIX}${eventName}`
}

function buildRecord(
	eventName: string,
	metadata: OTelEventMetadata,
): OTelLogRecord {
	const name = qualifiedEventName(eventName)
	return {
		timeUnixNano: String(BigInt(Date.now()) * 1000000n),
		severityNumber: INFO_SEVERITY_NUMBER,
		severityText: 'INFO',
		body: { stringValue: name },
		attributes: toAttributes({
			...commonEventAttributes(),
			'event.name': name,
			...metadata,
		}),
	}
}

export async function logOTelEvent(
	eventName: string,
	metadata: OTelEventMetadata = {},
): Promise<void> {
	const config = otelConfig()
	if (!config.enabled) return
	const record = buildRecord(eventName, metadata)

	if (config.kind === 'console') {
		// biome-ignore lint/suspicious/noConsole:: console exporter is an explicit user opt-in
		console.log(jsonLine(record))
		return
	}

	if (pendingRecords.length >= MAX_BUFFERED_RECORDS) {
		droppedRecordCount++
		return
	}
	pendingRecords.push(record)
	installFlushHooks()
	scheduleFlush()
}

function jsonLine(record: OTelLogRecord): string {
	const attributes: Record<string, string | number | boolean> = {}
	for (const attr of record.attributes) {
		const value = attr.value
		if ('stringValue' in value) attributes[attr.key] = value.stringValue
		else if ('intValue' in value) attributes[attr.key] = value.intValue
		else if ('doubleValue' in value) attributes[attr.key] = value.doubleValue
		else attributes[attr.key] = value.boolValue
	}
	return JSON.stringify({
		name: record.body.stringValue,
		time_unix_nano: record.timeUnixNano,
		attributes,
	})
}

let beforeExitFlush: (() => void) | undefined
let unregisterShutdownFlush: (() => void) | undefined

function installFlushHooks(): void {
	if (beforeExitHookInstalled) return
	beforeExitHookInstalled = true
	beforeExitFlush = () => {
		void flushOTelEvents()
	}
	process.once('beforeExit', beforeExitFlush)
	// beforeExit never fires on process.exit(), which every production exit
	// path takes (gracefulShutdown -> forceExit). The cleanup registry runs
	// inside gracefulShutdown under its budget, so it reaches the real exits.
	unregisterShutdownFlush = registerCleanup(() => flushOTelEvents())
}

function scheduleFlush(): void {
	if (flushTimer) return
	flushTimer = setTimeout(() => {
		flushTimer = undefined
		void flushOTelEvents()
	}, logsFlushIntervalMs())
	flushTimer.unref?.()
}

function buildOTelLogsPayload(records: OTelLogRecord[]): {
	resourceLogs: unknown[]
} {
	return {
		resourceLogs: [
			{
				resource: { attributes: resourceAttributes() },
				scopeLogs: [
					{
						scope: { name: 'openclaude', version: MACRO.VERSION },
						logRecords: records,
					},
				],
			},
		],
	}
}

export async function flushOTelEvents(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = undefined
	}
	const endpoint = otelConfig().endpoint
	const records = pendingRecords.splice(0, pendingRecords.length)
	if (records.length === 0) return
	if (!endpoint) {
		logForDebugging(
			`Dropping ${records.length} OTel log records: no OTLP endpoint configured`,
		)
		return
	}
	const timeout = createCombinedAbortSignal(undefined, {
		timeoutMs: otelExportTimeoutMs(),
	})
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: otelHeaders(),
			body: JSON.stringify(buildOTelLogsPayload(records)),
			signal: timeout.signal,
			...getProxyFetchOptions(),
		})
		if (!response.ok) {
			logForDebugging(`OTel logs export failed: HTTP ${response.status}`)
		}
	} catch (error) {
		logForDebugging(
			`Failed to export OTel logs: ${error instanceof Error ? error.message : String(error)}`,
		)
	} finally {
		timeout.cleanup()
	}
	if (droppedRecordCount > 0) {
		logForDebugging(
			`Dropped ${droppedRecordCount} OTel log records (buffer limit ${MAX_BUFFERED_RECORDS})`,
		)
		droppedRecordCount = 0
	}
}

export function redactIfDisabled(content: string): string {
	if (
		isTelemetryEnabled() &&
		isEnvTruthy(process.env.OTEL_LOG_USER_PROMPTS)
	) {
		return content
	}
	return '<REDACTED>'
}

export function resetOTelEventsForTesting(): void {
	pendingRecords.length = 0
	droppedRecordCount = 0
	beforeExitHookInstalled = false
	resolvedConfig = undefined
	staticEventAttributes = undefined
	if (beforeExitFlush) {
		process.off('beforeExit', beforeExitFlush)
		beforeExitFlush = undefined
	}
	if (unregisterShutdownFlush) {
		unregisterShutdownFlush()
		unregisterShutdownFlush = undefined
	}
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = undefined
	}
}
