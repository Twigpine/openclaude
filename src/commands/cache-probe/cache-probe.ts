import { getSessionId } from '../../bootstrap/state.js'
import { firstUsableCredential } from '../../services/api/credentialPool.js'
import { resolveOpenAICredentialEnvState } from '../../utils/providerProfile.js'
import {
  isAzureStyleBaseUrl,
  resolveProviderRequest,
} from '../../services/api/providerConfig.js'
import type { LocalCommandCall } from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { COPILOT_HEADERS } from '../../services/github/deviceFlow.js'
import { hydrateGithubModelsTokenFromSecureStorage } from '../../utils/githubModelsCredentials.js'
import { getMainLoopModel } from '../../utils/model/model.js'

// Large system prompt (~6000 chars, ~1500 tokens) to cross the 1024-token cache threshold
const SYSTEM_PROMPT = [
  'You are a coding assistant. Answer concisely.',
  'CONTEXT: User is working on a TypeScript project with Bun runtime.',
  ...Array.from(
    { length: 80 },
    (_, i) =>
      `Rule ${i + 1}: Follow best practices for TypeScript including strict typing, error handling, testing, and clean code. Prefer explicit types over any. Use const assertions. Await all async operations.`,
  ),
].join('\n\n')

const USER_MESSAGE = 'Say "hello" and nothing else.'
const DELAY_MS = 3000

/**
 * Extract model family from a versioned model string.
 * e.g. "gpt-5.4-0626" → "gpt-5.4", "codex-mini-latest" → "codex-mini"
 */
function getModelFamily(model: string | undefined): string {
  if (!model) return 'unknown'
  return model
    .replace(/-\d{4,}$/, '')
    .replace(/-latest$/, '')
    .replace(/-preview$/, '')
}

/**
 * `prompt_cache_*` and `store` are OpenAI/Azure OpenAI request extensions.
 * This command sends requests directly (rather than through the OpenAI shim),
 * so descriptor-level `removeBodyFields` rules do not protect strict
 * compatible endpoints such as NVIDIA NIM.
 */
export function supportsCacheProbeFields(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'api.openai.com' ||
      hostname.endsWith('.api.openai.com') ||
      isAzureStyleBaseUrl(baseUrl, env)
  } catch {
    return false
  }
}


export function resolveCacheProbeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const credentialState = resolveOpenAICredentialEnvState(env)
  if (!credentialState.configured || !credentialState.envVar) {
    return ''
  }

  return firstUsableCredential(env[credentialState.envVar]) ?? ''
}

function resolveGithubCacheProbeApiKey(env: NodeJS.ProcessEnv): string {
  return (
    env.GITHUB_COPILOT_KEY?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim() ||
    ''
  )
}

export function resolveCacheProbeRequestApiKey(
  env: NodeJS.ProcessEnv = process.env,
  options?: { isGithub?: boolean },
): string {
  if (options?.isGithub) {
    const githubKey = resolveGithubCacheProbeApiKey(env)
    if (githubKey) {
      return githubKey
    }
  }

  return resolveCacheProbeApiKey(env)
}

function getField(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce((o: unknown, k: string) => (o != null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

interface ProbeResult {
  label: string
  status: number
  elapsed: number
  headers: Record<string, string>
  usage: Record<string, unknown> | null
  responseId: string | null
  error: string | null
}

async function sendProbe(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  label: string,
): Promise<ProbeResult> {
  const start = Date.now()
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch (err: unknown) {
    return {
      label,
      status: 0,
      elapsed: Date.now() - start,
      headers: {},
      usage: null,
      responseId: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const elapsed = Date.now() - start

  const respHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    respHeaders[key] = value
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    return {
      label,
      status: response.status,
      elapsed,
      headers: respHeaders,
      usage: null,
      responseId: null,
      error: errorBody,
    }
  }

  // Parse SSE stream for usage data
  const text = await response.text()
  let usage: Record<string, unknown> | null = null
  let responseId: string | null = null

  const isResponses = url.endsWith('/responses')
  for (const chunk of text.split('\n\n')) {
    const lines = chunk
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    if (isResponses) {
      const eventLine = lines.find((l) => l.startsWith('event: '))
      const dataLines = lines.filter((l) => l.startsWith('data: '))
      if (!eventLine || !dataLines.length) continue
      const event = eventLine.slice(7).trim()
      if (
        event === 'response.completed' ||
        event === 'response.incomplete'
      ) {
        try {
          const data = JSON.parse(
            dataLines.map((l) => l.slice(6)).join('\n'),
          )
          usage = (data?.response?.usage as Record<string, unknown>) ?? null
          responseId = (data?.response?.id as string) ?? null
        } catch {}
      }
    } else {
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') continue
        try {
          const data = JSON.parse(raw) as Record<string, unknown>
          if (data.usage) {
            usage = data.usage as Record<string, unknown>
            responseId = (data.id as string) ?? null
          }
        } catch {}
      }
    }
  }

  return { label, status: response.status, elapsed, headers: respHeaders, usage, responseId, error: null }
}

function formatResult(r: ProbeResult): string {
  const lines: string[] = [`--- ${r.label} ---`]
  if (r.error) {
    lines.push(`  ERROR (HTTP ${r.status}): ${r.error.slice(0, 200)}`)
    return lines.join('\n')
  }
  lines.push(`  HTTP ${r.status} — ${r.elapsed}ms`)
  if (r.responseId) lines.push(`  response.id: ${r.responseId}`)

  if (r.usage) {
    lines.push('  Usage:')
    lines.push(`    ${JSON.stringify(r.usage, null, 2).replace(/\n/g, '\n    ')}`)
  } else {
    lines.push('  Usage: null')
  }

  // Interesting headers
  for (const h of [
    'openai-processing-ms',
    'x-ratelimit-remaining',
    'x-ratelimit-limit',
    'x-ms-region',
    'x-github-request-id',
    'x-request-id',
  ]) {
    if (r.headers[h]) lines.push(`  ${h}: ${r.headers[h]}`)
  }
  return lines.join('\n')
}

export const call: LocalCommandCall = async (args) => {
  const parts = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const noKey = parts.includes('--no-key')
  const modelOverride = parts.find((p) => !p.startsWith('--')) || undefined
  const modelStr = modelOverride ?? getMainLoopModel()
  const request = resolveProviderRequest({ model: modelStr })
  const isGithub = isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)

  // Resolve API key the same way the active provider path does.
  if (isGithub) {
    hydrateGithubModelsTokenFromSecureStorage()
  }
  const apiKey = resolveCacheProbeRequestApiKey(process.env, { isGithub })

  if (!apiKey) {
    return {
      type: 'text',
      value:
        'No API key found. Make sure you are in an active OpenAI-compatible or GitHub Copilot session.\n' +
        'For GitHub Copilot: run /onboard-github first.\n' +
        'For OpenAI-compatible: set OPENAI_API_KEYS or OPENAI_API_KEY.',
    }
  }

  const useResponses =
    request.transport === 'codex_responses' ||
    request.transport === 'responses' ||
    request.transport === 'responses_compat'
  const endpoint = useResponses ? '/responses' : '/chat/completions'
  const url = `${request.baseUrl}${endpoint}`
  const family = getModelFamily(request.resolvedModel)
  const cacheKey = `${getSessionId()}:${family}`
  const includeCacheProbeFields =
    !noKey && supportsCacheProbeFields(request.baseUrl)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    originator: 'openclaude',
  }
  if (isGithub) {
    Object.assign(headers, COPILOT_HEADERS)
  }

  let body: Record<string, unknown>
  if (useResponses) {
    body = {
      model: request.resolvedModel,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{
            type: request.transport === 'responses_compat' ? 'text' : 'input_text',
            text: USER_MESSAGE,
          }],
        },
      ],
      stream: true,
      ...(includeCacheProbeFields
        ? {
            store: false,
            prompt_cache_key: cacheKey,
            prompt_cache_retention: '24h',
          }
        : {}),
    }
  } else {
    body = {
      model: request.resolvedModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_MESSAGE },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 20,
      ...(includeCacheProbeFields
        ? {
            store: false,
            prompt_cache_key: cacheKey,
          }
        : {}),
    }
  }

  // Log configuration
  const config = [
    `[cache-probe] Starting cache probe${!includeCacheProbeFields ? ' (cache params OMITTED)' : ''}`,
    `  model: ${request.resolvedModel} (family: ${family})`,
    `  transport: ${request.transport}`,
    `  endpoint: ${url}`,
    `  prompt_cache_key: ${includeCacheProbeFields ? cacheKey : 'NOT SENT'}`,
    `  store: ${includeCacheProbeFields ? 'false' : 'NOT SENT'}`,
    `  system prompt: ~${Math.round(SYSTEM_PROMPT.length / 4)} tokens`,
    `  delay between calls: ${DELAY_MS}ms`,
  ].join('\n')
  logForDebugging(config)

  // Call 1 — Cold
  const r1 = await sendProbe(url, headers, body, 'CALL 1 — Cold (no cache)')
  logForDebugging(`[cache-probe]\n${formatResult(r1)}`)

  if (r1.error) {
    return {
      type: 'text',
      value: `Cache probe failed on first call: HTTP ${r1.status}\n${r1.error.slice(0, 300)}\n\nFull details in debug log.`,
    }
  }

  // Wait
  await new Promise((r) => setTimeout(r, DELAY_MS))

  // Call 2 — Warm
  const r2 = await sendProbe(url, headers, body, 'CALL 2 — Warm (cache expected)')
  logForDebugging(`[cache-probe]\n${formatResult(r2)}`)

  // --- Comparison ---
  const fields = [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'prompt_tokens',
    'completion_tokens',
    'input_tokens_details.cached_tokens',
    'prompt_tokens_details.cached_tokens',
    'output_tokens_details.reasoning_tokens',
  ]

  const comparison: string[] = ['[cache-probe] COMPARISON']
  comparison.push(
    `  ${'Field'.padEnd(42)} ${'Call 1'.padStart(8)}  ${'Call 2'.padStart(8)}  ${'Delta'.padStart(8)}`,
  )
  comparison.push(`  ${'-'.repeat(72)}`)

  for (const f of fields) {
    const v1 = getField(r1.usage, f)
    const v2 = getField(r2.usage, f)
    if (v1 === undefined && v2 === undefined) continue
    const d =
      typeof v1 === 'number' && typeof v2 === 'number' ? v2 - v1 : ''
    comparison.push(
      `  ${f.padEnd(42)} ${String(v1 ?? '-').padStart(8)}  ${String(v2 ?? '-').padStart(8)}  ${String(d).padStart(8)}`,
    )
  }

  comparison.push('')
  comparison.push(
    `  Latency: ${r1.elapsed}ms → ${r2.elapsed}ms (${r2.elapsed - r1.elapsed > 0 ? '+' : ''}${r2.elapsed - r1.elapsed}ms)`,
  )

  // Header comparison
  for (const h of ['openai-processing-ms', 'x-ms-region', 'x-ratelimit-remaining']) {
    const v1 = r1.headers[h]
    const v2 = r2.headers[h]
    if (v1 || v2) {
      comparison.push(`  ${h}: ${v1 ?? '-'} → ${v2 ?? '-'}`)
    }
  }

  // Verdict
  const cached2 =
    (getField(r2.usage, 'input_tokens_details.cached_tokens') as number) ??
    (getField(r2.usage, 'prompt_tokens_details.cached_tokens') as number) ??
    0
  const input1 =
    ((r1.usage?.input_tokens ?? r1.usage?.prompt_tokens) as number) ?? 0
  const input2 =
    ((r2.usage?.input_tokens ?? r2.usage?.prompt_tokens) as number) ?? 0

  let verdict: string
  if (cached2 > 0) {
    const rate = input2 > 0 ? Math.round((cached2 / input2) * 100) : '?'
    verdict = `CACHE HIT: ${cached2} cached tokens (${rate}% of input)`
  } else if (input1 === 0 && input2 === 0) {
    verdict = 'INCONCLUSIVE: Server returns 0 input_tokens — cannot measure'
  } else if (r2.elapsed < r1.elapsed * 0.6 && input1 > 100) {
    verdict = `POSSIBLE SILENT CACHING: Call 2 was ${Math.round((1 - r2.elapsed / r1.elapsed) * 100)}% faster but no cached_tokens reported`
  } else {
    verdict = 'NO CACHE DETECTED'
  }

  comparison.push(`\n  Verdict: ${verdict}`)

  // --- Simulate what main's shim code does with this usage ---
  // codexShim.ts makeUsage() — used for Responses API (GPT-5+/Codex)
  function mainMakeUsage(u: unknown) {
    const rec = (u ?? {}) as Record<string, unknown>
    return {
      input_tokens: typeof rec.input_tokens === 'number' ? rec.input_tokens : 0,
      output_tokens: typeof rec.output_tokens === 'number' ? rec.output_tokens : 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,  // ← main hardcodes this to 0
    }
  }
  // openaiShim.ts convertChunkUsage() — used for Chat Completions
  function mainConvertChunkUsage(u: unknown) {
    const rec = (u ?? {}) as Record<string, unknown>
    const details = (rec.prompt_tokens_details ?? {}) as Record<string, unknown>
    return {
      input_tokens: typeof rec.prompt_tokens === 'number' ? rec.prompt_tokens : 0,
      output_tokens: typeof rec.completion_tokens === 'number' ? rec.completion_tokens : 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : 0,
    }
  }

  const shimFn = useResponses ? mainMakeUsage : mainConvertChunkUsage
  const shim1 = shimFn(r1.usage)
  const shim2 = shimFn(r2.usage)

  comparison.push('')
  comparison.push(`  --- What main's shim reports (${useResponses ? 'codexShim.makeUsage' : 'openaiShim.convertChunkUsage'}) ---`)
  comparison.push(`  Call 1: cache_read_input_tokens=${shim1.cache_read_input_tokens}`)
  comparison.push(`  Call 2: cache_read_input_tokens=${shim2.cache_read_input_tokens}`)
  if (useResponses && cached2 > 0) {
    comparison.push(`  BUG: Server returned ${cached2} cached tokens but main's makeUsage() drops it → reports 0`)
  } else if (!useResponses && shim2.cache_read_input_tokens > 0) {
    comparison.push(`  OK: Chat Completions path on main correctly reads cached_tokens`)
  }

  logForDebugging(comparison.join('\n'))

  // User-facing summary
  const mode = noKey ? ' (NO cache key sent)' : ''
  const shimLabel = useResponses ? 'codexShim.makeUsage()' : 'openaiShim.convertChunkUsage()'
  const summary = [
    `Cache Probe — ${request.resolvedModel} via ${useResponses ? 'Responses API' : 'Chat Completions'}${mode}`,
    '',
    `Call 1: ${r1.elapsed}ms, input=${input1}, cached=${(getField(r1.usage, 'input_tokens_details.cached_tokens') as number) ?? (getField(r1.usage, 'prompt_tokens_details.cached_tokens') as number) ?? 0}`,
    `Call 2: ${r2.elapsed}ms, input=${input2}, cached=${cached2}`,
    '',
    verdict,
    '',
    `What main's ${shimLabel} reports:`,
    `  Call 2 cache_read_input_tokens = ${shim2.cache_read_input_tokens}${useResponses && cached2 > 0 ? '  ← BUG: server sent ' + cached2 + ' but main drops it' : ''}`,
    '',
    'Full details written to debug log.',
  ].join('\n')

  return { type: 'text', value: summary }
}
