import type { SettingsJson } from '../../utils/settings/types.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { parseModelFlagValue } from '../../utils/cliArgs.js'
import { argsBeforeModelOwningSubcommand } from '../../utils/printFlag.js'
import { resolveRouteIdFromBaseUrl } from '../../integrations/routeMetadata.js'

/**
 * Provider override resolved from agent routing config.
 * When present, the API client should use these instead of global env vars.
 */
export interface ProviderOverride {
  /** Model name to send to the API (e.g. "deepseek-chat", "gpt-4o") */
  model: string
  /** OpenAI-compatible base URL */
  baseURL: string
  /** API key for this provider */
  apiKey: string
}

/** A model-only route: reuse the session's current provider, just change the model. */
export type AgentModelOnly = { model: string }

/** A resolved agent route — a full cross-provider override or a model-only swap. */
export type AgentRoute = ProviderOverride | AgentModelOnly

/** Narrow an AgentRoute to a full cross-provider ProviderOverride. */
export function isProviderOverride(route: AgentRoute): route is ProviderOverride {
  return 'apiKey' in route && 'baseURL' in route
}

export interface AgentRunModelRouting {
  mainLoopModel: string
  providerOverride?: ProviderOverride
}

type AgentModelConfig = NonNullable<SettingsJson['agentModels']>[string]

const PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'NVIDIA_NIM',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
  'MISTRAL_MODEL',
  'MISTRAL_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_FORMAT',
  'OPENAI_AZURE_STYLE',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
] as const

/**
 * Normalize an agent identifier for case-insensitive, hyphen/underscore-agnostic matching.
 */
function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

function toAgentRoute(
  configuredModelKey: string,
  modelConfig: AgentModelConfig | undefined,
): AgentRoute | null {
  if (!modelConfig) return null

  const model = modelConfig.model?.trim() || configuredModelKey
  const baseURL = modelConfig.base_url?.trim()
  const apiKey = modelConfig.api_key?.trim()

  // Model-only route: no credentials → reuse the active provider, swap the model.
  if (!baseURL && !apiKey) return { model }

  // Misconfiguration: a cross-provider route needs BOTH endpoint and key.
  if (!baseURL || !apiKey) {
    console.error(
      `[agentRouting] Warning: agentModels entry "${configuredModelKey}" has only one of base_url/api_key; both are required for cross-provider routing. Skipping this route.`,
    )
    return null
  }

  return { model, baseURL, apiKey }
}

/**
 * Look up agent.routing by name or subagent_type, then resolve via agent.models.
 *
 * Priority: name > subagentType > "default" > null (use global provider)
 */
export function resolveAgentProvider(
  name: string | undefined,
  subagentType: string | undefined,
  settings: SettingsJson | null,
): AgentRoute | null {
  if (!settings) return null

  const routing = settings.agentRouting
  const models = settings.agentModels
  if (!routing || !models) return null

  // Build normalized lookup from routing config.
  // Warn on duplicate normalized keys (e.g. "explore-agent" and "explore_agent"
  // both normalize to "exploreagent") to prevent silent shadowing.
  const normalizedRouting = new Map<string, string>()
  for (const [key, value] of Object.entries(routing)) {
    const nk = normalize(key)
    if (normalizedRouting.has(nk)) {
      console.error(
        `[agentRouting] Warning: routing key "${key}" collides with an existing key after normalization (both map to "${nk}"). First entry wins.`,
      )
    }
    if (!normalizedRouting.has(nk)) {
      normalizedRouting.set(nk, value)
    }
  }

  // Try name first, then subagentType, then "default"
  const candidates = [name, subagentType, 'default'].filter(Boolean) as string[]
  let modelName: string | undefined

  for (const candidate of candidates) {
    const match = normalizedRouting.get(normalize(candidate))
    if (match) {
      modelName = match
      break
    }
  }

  if (!modelName) return null

  return toAgentRoute(modelName, models[modelName])
}

/**
 * Resolve an agent route directly from a requested model name (cross-provider or model-only).
 * Checks for an exact match in agentModels. Does not fuzzy match or normalize case.
 */
export function resolveAgentModelProvider(
  modelName: string | undefined,
  settings: SettingsJson | null,
): AgentRoute | null {
  if (!settings || !settings.agentModels || !modelName) return null

  const trimmedModelName = modelName.trim()
  return toAgentRoute(trimmedModelName, settings.agentModels[trimmedModelName])
}

/**
 * Resolve a model-only route's model to what should actually run. A bare
 * built-in alias ("sonnet"/"haiku"/"opus"/"inherit") is sent through the same
 * provider-aware path as the agent model selector (getAgentModel), so on
 * non-Claude-native providers it inherits the parent model instead of being
 * sent literally and failing with a provider "model not found". A real model id
 * (a configured agentModels key for the active provider) passes through as-is.
 */
export function resolveModelOnlyModel(
  model: string,
  parentModel: string,
  permissionMode?: PermissionMode,
): string {
  if (model === 'inherit' || isModelAlias(model)) {
    return getAgentModel(model, parentModel, undefined, permissionMode)
  }
  return model
}

export function resolveAgentRunModelRouting({
  resolvedAgentModel,
  parentModel,
  toolSpecifiedModel,
  agentName,
  subagentType,
  agentDefinitionModel,
  settings,
  permissionMode,
}: {
  resolvedAgentModel: string
  parentModel: string
  toolSpecifiedModel?: string
  agentName?: string
  subagentType?: string
  agentDefinitionModel?: string
  settings: SettingsJson | null
  permissionMode?: PermissionMode
}): AgentRunModelRouting {
  const toolRequestedModel = toolSpecifiedModel?.trim()
  if (toolRequestedModel) {
    // Tool-specified models are explicit. If the request is not a configured
    // agentModels key, preserve getAgentModel() alias/inherit/custom-ID behavior
    // instead of falling through to persistent agentRouting.
    const route = resolveAgentModelProvider(toolRequestedModel, settings)
    if (!route) return { mainLoopModel: resolvedAgentModel }
    if (isProviderOverride(route)) {
      return { mainLoopModel: route.model, providerOverride: route }
    }
    return {
      mainLoopModel: resolveModelOnlyModel(route.model, parentModel, permissionMode),
    }
  }

  const route =
    resolveAgentProvider(agentName, subagentType, settings) ??
    resolveAgentModelProvider(agentDefinitionModel, settings)
  if (!route) return { mainLoopModel: resolvedAgentModel }
  if (isProviderOverride(route)) {
    return { mainLoopModel: route.model, providerOverride: route }
  }
  return {
    mainLoopModel: resolveModelOnlyModel(route.model, parentModel, permissionMode),
  }
}

/**
 * Whether the org model allowlist must be enforced for a resolved agent run.
 * Enforce whenever routing changed the model: a cross-provider override is set,
 * or a model-only route changed the effective model from what getAgentModel()
 * resolved. An unchanged inherited model was already vetted upstream.
 */
export function shouldEnforceModelAllowlist(
  resolvedAgentModel: string,
  effectiveModel: string,
  hasProviderOverride: boolean,
): boolean {
  return hasProviderOverride || effectiveModel !== resolvedAgentModel
}

/**
 * Resolve provider routing for a teammate that will run as its own CLI process.
 *
 * Pane/window teammates do not enter runAgent() in the parent process. They
 * become the child process's main loop, so the child startup path must resolve
 * the same configured agentModels route from its CLI identity.
 */
export function resolveOutOfProcessTeammateProvider({
  cliModel,
  agentName,
  agentType,
  agentDefinitionModel,
  settings,
}: {
  cliModel?: string
  agentName?: string
  agentType?: string
  agentDefinitionModel?: string
  settings: SettingsJson | null
}): ProviderOverride | null {
  const requestedModel = cliModel?.trim()
  if (requestedModel) {
    const route = resolveAgentModelProvider(requestedModel, settings)
    return route && isProviderOverride(route) ? route : null
  }

  const route =
    resolveAgentProvider(agentName, agentType, settings) ??
    resolveAgentModelProvider(agentDefinitionModel, settings)
  return route && isProviderOverride(route) ? route : null
}

/**
 * Resolve the model a pane/window teammate should run when its configured route
 * is model-only (no cross-provider override). The provider twin above filters to
 * ProviderOverride, so model-only routes the menu writes (e.g. agentRouting set
 * to a plain agentModels key) are dropped and the teammate inherits the parent.
 * This returns that route's provider-aware model so the spawn path can apply it.
 * Mirrors resolveAgentRunModelRouting's lookup order (tool model, then agent
 * name/type, then agent-definition model). Returns undefined when there is no
 * model-only route, so the caller keeps the inherit-parent default.
 */
export function resolveOutOfProcessTeammateModelOnly({
  cliModel,
  agentName,
  agentType,
  agentDefinitionModel,
  parentModel,
  permissionMode,
  settings,
}: {
  cliModel?: string
  agentName?: string
  agentType?: string
  agentDefinitionModel?: string
  parentModel: string
  permissionMode?: PermissionMode
  settings: SettingsJson | null
}): string | undefined {
  const requestedModel = cliModel?.trim()
  if (requestedModel) {
    const route = resolveAgentModelProvider(requestedModel, settings)
    return route && !isProviderOverride(route)
      ? resolveModelOnlyModel(route.model, parentModel, permissionMode)
      : undefined
  }

  const route =
    resolveAgentProvider(agentName, agentType, settings) ??
    resolveAgentModelProvider(agentDefinitionModel, settings)
  return route && !isProviderOverride(route)
    ? resolveModelOnlyModel(route.model, parentModel, permissionMode)
    : undefined
}

export function resolveOutOfProcessTeammateProviderFromCliArgs(
  args: readonly string[],
  settings: SettingsJson | null,
): ProviderOverride | null {
  if (hasCliFlag(args, '--provider')) return null

  const agentName = parseCliFlag(args, '--agent-name')
  const teamName = parseCliFlag(args, '--team-name')
  if (!agentName || !teamName) return null

  return resolveOutOfProcessTeammateProvider({
    cliModel: parseModelFlagValue(argsBeforeModelOwningSubcommand(args)),
    agentName,
    agentType: parseCliFlag(args, '--agent-type'),
    settings,
  })
}

function hasCliFlag(args: readonly string[], flag: string): boolean {
  return args.some(arg => arg === flag || arg.startsWith(`${flag}=`))
}

function parseCliFlag(args: readonly string[], flag: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1)
      return value || undefined
    }
  }
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  if (!value || value.startsWith('--')) return undefined
  return value
}

/**
 * Apply an agentModels provider override to a child process environment.
 *
 * agentModels entries are OpenAI-compatible routes. Clear competing route
 * selectors and stale model/endpoint/header knobs first because provider
 * detection gives several selectors higher priority than CLAUDE_CODE_USE_OPENAI.
 */
export function applyAgentProviderOverrideToEnv(
  providerOverride: ProviderOverride,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  for (const key of PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE) {
    delete env[key]
  }

  env.CLAUDE_CODE_USE_OPENAI = '1'
  env.OPENAI_MODEL = providerOverride.model
  env.OPENAI_BASE_URL = providerOverride.baseURL
  env.OPENAI_API_KEY = providerOverride.apiKey
  if (resolveRouteIdFromBaseUrl(providerOverride.baseURL) === 'commandcode') {
    env.CMD_API_KEY = providerOverride.apiKey
  }
}
