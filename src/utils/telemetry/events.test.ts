import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { snapshotEnv } from '../../test/envSnapshot.js'
import { withMockMacro } from '../../test/mockMacro.js'
import {
	acquireSharedMutationLock,
	releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
	flushOTelEvents,
	isTelemetryEnabled,
	logOTelEvent,
	redactIfDisabled,
	resetOTelEventsForTesting,
} from './events.js'

const OTEL_ENV_VARS = [
	'CLAUDE_CODE_ENABLE_TELEMETRY',
	'OTEL_LOGS_EXPORTER',
	'OTEL_EXPORTER_OTLP_ENDPOINT',
	'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
	'OTEL_EXPORTER_OTLP_HEADERS',
	'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
	'OTEL_EXPORTER_OTLP_TIMEOUT',
	'OTEL_LOGS_EXPORT_INTERVAL',
	'OTEL_RESOURCE_ATTRIBUTES',
	'OTEL_LOG_USER_PROMPTS',
] as const

let restoreEnv: () => void
const originalFetch = globalThis.fetch

beforeEach(async () => {
	await acquireSharedMutationLock('utils/telemetry/events.test.ts')
	restoreEnv = snapshotEnv(OTEL_ENV_VARS, { clear: true })
	resetOTelEventsForTesting()
})

afterEach(() => {
	try {
		restoreEnv()
		globalThis.fetch = originalFetch
		resetOTelEventsForTesting()
	} finally {
		releaseSharedMutationLock()
	}
})

function enableOtlp(endpoint = 'http://collector.test:4318'): void {
	process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint
}

function capturedPayload(fetchMock: ReturnType<typeof mock>): {
	url: string
	headers: Record<string, string>
	body: {
		resourceLogs: Array<{
			scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }>
		}>
	}
} {
	const [input, init] = fetchMock.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	return {
		url: input,
		headers: init.headers as Record<string, string>,
		body: JSON.parse(init.body as string),
	}
}

describe('isTelemetryEnabled', () => {
	test('disabled with no env', () => {
		expect(isTelemetryEnabled()).toBe(false)
	})

	test('disabled with flag but no endpoint', () => {
		process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
		expect(isTelemetryEnabled()).toBe(false)
	})

	test('enabled with flag and endpoint', () => {
		enableOtlp()
		expect(isTelemetryEnabled()).toBe(true)
	})

	test('console exporter needs no endpoint', () => {
		process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
		process.env.OTEL_LOGS_EXPORTER = 'console'
		expect(isTelemetryEnabled()).toBe(true)
	})

	test('none exporter disables even with endpoint', () => {
		enableOtlp()
		process.env.OTEL_LOGS_EXPORTER = 'none'
		expect(isTelemetryEnabled()).toBe(false)
	})
})

describe('logOTelEvent', () => {
	test('emits nothing when telemetry is disabled', async () => {
		const fetchMock = mock(async () => new Response('{}'))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await logOTelEvent('user_prompt', { prompt: 'hi' })
		await flushOTelEvents()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('POSTs OTLP JSON to <endpoint>/v1/logs with claude_code prefix', async () => {
		enableOtlp()
		const fetchMock = mock(async () => new Response('{}'))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await withMockMacro({ VERSION: '1.2.3' }, async () => {
			await logOTelEvent('user_prompt', { prompt: 'hi', count: 2 })
			await flushOTelEvents()
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const { url, body } = capturedPayload(fetchMock)
		expect(url).toBe('http://collector.test:4318/v1/logs')
		const records = body.resourceLogs[0]!.scopeLogs[0]!.logRecords
		expect(records).toHaveLength(1)
		expect(records[0]!.body).toEqual({ stringValue: 'claude_code.user_prompt' })
		const attrs = Object.fromEntries(
			(
				records[0]!.attributes as Array<{
					key: string
					value: Record<string, unknown>
				}>
			).map(a => [a.key, Object.values(a.value)[0]]),
		)
		expect(attrs['event.name']).toBe('claude_code.user_prompt')
		expect(attrs.prompt).toBe('hi')
		expect(attrs.count).toBe('2') // intValue is a string per OTLP/JSON
		expect(attrs['session.id']).toBeDefined()
	})

	test('does not double-prefix a qualified event name', async () => {
		enableOtlp()
		const fetchMock = mock(async () => new Response('{}'))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await withMockMacro({ VERSION: '1.2.3' }, async () => {
			await logOTelEvent('claude_code.safety_event', { decision: 'deny' })
			await flushOTelEvents()
		})
		const { body } = capturedPayload(fetchMock)
		expect(body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.body).toEqual({
			stringValue: 'claude_code.safety_event',
		})
	})

	test('honors OTEL_EXPORTER_OTLP_LOGS_ENDPOINT and headers', async () => {
		process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
		process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
			'http://logs-only.test/v1/logs'
		process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer t, X-A=1'
		const fetchMock = mock(async () => new Response('{}'))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await withMockMacro({ VERSION: '1.2.3' }, async () => {
			await logOTelEvent('api_request', { model: 'm' })
			await flushOTelEvents()
		})
		const { url, headers } = capturedPayload(fetchMock)
		expect(url).toBe('http://logs-only.test/v1/logs')
		expect(headers.Authorization).toBe('Bearer t')
		expect(headers['X-A']).toBe('1')
	})

	test('a non-2xx collector response drops the batch without throwing', async () => {
		enableOtlp()
		const fetchMock = mock(
			async () => new Response('nope', { status: 500 }),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await withMockMacro({ VERSION: '1.2.3' }, async () => {
			await logOTelEvent('user_prompt', { prompt: 'hi' })
			await expect(flushOTelEvents()).resolves.toBeUndefined()
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	test('an unfinished response body is cancelled before cleanup', async () => {
		enableOtlp()
		let cancelled = false
		const body = new ReadableStream({
			start() {},
			cancel() {
				cancelled = true
			},
		})
		const fetchMock = mock(async () => new Response(body, { status: 200 }))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await withMockMacro({ VERSION: '1.2.3' }, async () => {
			await logOTelEvent('user_prompt', { prompt: 'hi' })
			await expect(flushOTelEvents()).resolves.toBeUndefined()
		})
		expect(cancelled).toBe(true)
	})

	test('a rejected fetch drops the batch without throwing', async () => {
		enableOtlp()
		const fetchMock = mock(async () => {
			throw new Error('connection refused')
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await withMockMacro({ VERSION: '1.2.3' }, async () => {
			await logOTelEvent('user_prompt', { prompt: 'hi' })
			await expect(flushOTelEvents()).resolves.toBeUndefined()
		})
	})

	test('the buffer caps at 1000 records', async () => {
		enableOtlp()
		const fetchMock = mock(async () => new Response('{}'))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		await withMockMacro({ VERSION: '1.2.3' }, async () => {
			for (let i = 0; i < 1005; i++) {
				await logOTelEvent('user_prompt', { n: i })
			}
			await flushOTelEvents()
		})
		const { body } = capturedPayload(fetchMock)
		expect(
			body.resourceLogs[0]!.scopeLogs[0]!.logRecords,
		).toHaveLength(1000)
	})

	test('console exporter writes a JSON line and skips fetch', async () => {
		process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
		process.env.OTEL_LOGS_EXPORTER = 'console'
		const fetchMock = mock(async () => new Response('{}'))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		const lines: string[] = []
		const originalLog = console.log
		console.log = (line: string) => lines.push(line)
		try {
			await withMockMacro({ VERSION: '1.2.3' }, async () => {
				await logOTelEvent('tool_result', { tool_name: 'Bash' })
			})
		} finally {
			console.log = originalLog
		}
		expect(fetchMock).not.toHaveBeenCalled()
		expect(lines).toHaveLength(1)
		const parsed = JSON.parse(lines[0]!)
		expect(parsed.name).toBe('claude_code.tool_result')
		expect(parsed.attributes.tool_name).toBe('Bash')
	})
})

describe('redactIfDisabled', () => {
	test('redacts when telemetry is off', () => {
		expect(redactIfDisabled('secret prompt')).toBe('<REDACTED>')
	})

	test('redacts when telemetry on but prompt logging off', () => {
		enableOtlp()
		expect(redactIfDisabled('secret prompt')).toBe('<REDACTED>')
	})

	test('returns content when telemetry and prompt logging are on', () => {
		enableOtlp()
		process.env.OTEL_LOG_USER_PROMPTS = '1'
		expect(redactIfDisabled('secret prompt')).toBe('secret prompt')
	})
})
