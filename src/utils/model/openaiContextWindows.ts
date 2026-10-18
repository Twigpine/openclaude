/**
 * Runtime overrides for OpenAI-compatible model limits.
 *
 * Built-in model limits, including legacy aliases, live in
 * src/integrations/models. These helpers preserve the documented JSON env
 * override path for custom/private deployments and a `modelLimits` settings
 * map for the same effect via settings.json.
 *
 * This module only produces the *override candidates* (exact/prefix env-var
 * matches and the settings `modelLimits` match); it does not decide the overall
 * precedence. The authoritative runtime chain — exact env override, then the
 * built-in catalog, then the prefix env override, then settings `modelLimits`,
 * then the discovery cache, then the descriptor default — is applied by
 * resolveModelRuntimeLimits in integrations/runtimeMetadata.ts. Keep precedence
 * changes there, not duplicated here.
 */

import { getInitialSettings } from '../settings/settings.js'

type LimitEnvVar =
  | 'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS'
  | 'CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS'

export type OpenAILimitOverrideMatches = {
  // Exact env-var override match.
  exact?: number
  // settings.json `modelLimits` match (exact or prefix). Just a candidate here;
  // its position in the overall precedence is decided by resolveModelRuntimeLimits
  // (integrations/runtimeMetadata.ts), which applies settings after the exact and
  // prefix env overrides and catalog, but before the discovery cache.
  settings?: number
  // Prefix env-var override match.
  prefix?: number
}

type SettingsLimitKey = 'contextWindow' | 'maxOutputTokens'

function readExternalLimits(
  envVarName: LimitEnvVar,
  processEnv: NodeJS.ProcessEnv,
): Record<string, number> {
  const raw = processEnv[envVarName]
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'number' &&
            Number.isFinite(entry[1]) &&
            entry[1] > 0,
        )
        .map(([key, value]): [string, number] => [key.trim(), value])
        .filter(([key]) => key.length > 0),
    )
  } catch {
    return {}
  }
}

function lookupExactByKey(
  entries: Record<string, number>,
  key: string | undefined,
): number | undefined {
  const normalizedKey = key?.trim()
  if (!normalizedKey) {
    return undefined
  }

  return entries[normalizedKey] ?? entries[normalizedKey.toLowerCase()]
}

function lookupPrefixByKey(
  entries: Record<string, number>,
  key: string | undefined,
): number | undefined {
  const normalizedKey = key?.trim()
  if (!normalizedKey) {
    return undefined
  }

  const prefixKey = Object.keys(entries)
    .sort((left, right) => right.length - left.length)
    .find(entryKey => normalizedKey.startsWith(entryKey))

  return prefixKey ? entries[prefixKey] : undefined
}

function getOpenAIBaseUrlHost(processEnv: NodeJS.ProcessEnv): string | undefined {
  const baseUrl =
    processEnv.OPENAI_BASE_URL?.trim() || processEnv.OPENAI_API_BASE?.trim()
  if (!baseUrl) {
    return undefined
  }

  try {
    return new URL(baseUrl).host
  } catch {
    return undefined
  }
}

function lookupByModel(
  entries: Record<string, number>,
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): OpenAILimitOverrideMatches {
  const modelName = model?.trim() || processEnv.OPENAI_MODEL?.trim()
  const baseUrlHost = getOpenAIBaseUrlHost(processEnv)
  const hostQualifiedModel =
    baseUrlHost && modelName ? `${baseUrlHost}:${modelName}` : undefined

  // Match precedence, high to low: host-qualified exact, bare exact,
  // host-qualified prefix, bare prefix. Within each match kind a host-qualified
  // key (`<host>:<model>`) beats the bare key, so the same model name can carry
  // a different limit per endpoint via a host-qualified EXACT key. An exact
  // match always beats a prefix — including a host-qualified prefix — so a
  // precise `gpt-4o` entry is not overridden by an `api.foo.com:gpt-4` prefix
  // that only matches a different, shorter model name. (Consumers read
  // `exact ?? prefix`.)
  return {
    exact:
      lookupExactByKey(entries, hostQualifiedModel) ??
      lookupExactByKey(entries, modelName),
    prefix:
      lookupPrefixByKey(entries, hostQualifiedModel) ??
      lookupPrefixByKey(entries, modelName),
  }
}

function lookupExternalLimitMatches(
  envVarName: LimitEnvVar,
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): OpenAILimitOverrideMatches {
  return lookupByModel(
    readExternalLimits(envVarName, processEnv),
    model,
    processEnv,
  )
}

function lookupExternalLimit(
  envVarName: LimitEnvVar,
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): number | undefined {
  const matches = lookupExternalLimitMatches(envVarName, model, processEnv)
  return matches.exact ?? matches.prefix
}

function readSettingsLimits(key: SettingsLimitKey): Record<string, number> {
  let limits: unknown
  try {
    limits = getInitialSettings().modelLimits
  } catch {
    return {}
  }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return {}
  }
  const result: Record<string, number> = {}
  for (const [modelName, entry] of Object.entries(limits)) {
    if (!entry || typeof entry !== 'object') continue
    const value = (entry as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const trimmed = modelName.trim()
      if (trimmed.length > 0) {
        result[trimmed] = value
      }
    }
  }
  return result
}

function lookupSettingsLimit(
  key: SettingsLimitKey,
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): number | undefined {
  const matches = lookupByModel(readSettingsLimits(key), model, processEnv)
  return matches.exact ?? matches.prefix
}

export function getOpenAIContextWindow(
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return (
    lookupExternalLimit(
      'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
      model,
      processEnv,
    ) ?? lookupSettingsLimit('contextWindow', model, processEnv)
  )
}

export function getOpenAIContextWindowMatches(
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): OpenAILimitOverrideMatches {
  return {
    ...lookupExternalLimitMatches(
      'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
      model,
      processEnv,
    ),
    settings: lookupSettingsLimit('contextWindow', model, processEnv),
  }
}

export function getOpenAIMaxOutputTokens(
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return (
    lookupExternalLimit(
      'CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS',
      model,
      processEnv,
    ) ?? lookupSettingsLimit('maxOutputTokens', model, processEnv)
  )
}

export function getOpenAIMaxOutputTokenMatches(
  model: string | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): OpenAILimitOverrideMatches {
  return {
    ...lookupExternalLimitMatches(
      'CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS',
      model,
      processEnv,
    ),
    settings: lookupSettingsLimit('maxOutputTokens', model, processEnv),
  }
}
