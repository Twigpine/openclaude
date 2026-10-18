// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { getCatalogEntriesForRoute } from '../../integrations/index.js'
import {
  getTransportKindForRoute,
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
} from '../../integrations/routeMetadata.js'
import {
  getAdditionalModelOptionsCacheScope,
  resolveProviderRequest,
} from '../../services/api/providerConfig.js'
import {
  isClaudeAISubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getModelStrings } from './modelStrings.js'
import { getModelPricingString } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import {
  getAPIProvider,
  isCustomAnthropicProvider,
  isFirstPartyAnthropicBaseUrl,
  isFirstPartyAnthropicProvider,
} from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isOpus1mMergeEnabled,
  getOpus46PricingSuffix,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext } from '../context.js'
import { getGlobalConfig } from '../config.js'
import {
  getActiveOpenAIModelOptionsCache,
  getActiveProviderProfile,
  getProfileModelOptions,
  getProviderProfiles,
} from '../providerProfiles.js'
import { getCachedOllamaModelOptions, isOllamaProvider } from './ollamaModels.js'
import { getCachedNvidiaNimModelOptions, isNvidiaNimProvider } from './nvidiaNimModels.js'
import { getCachedMiniMaxModelOptions, isMiniMaxProvider } from './minimaxModels.js'
import { getCachedXiaomiMimoModelOptions, isXiaomiMimoProvider } from './xiaomi-mimoModels.js'
import { getAntModels } from './antModels.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
  /**
   * When set, selecting this option also activates the named provider profile
   * before switching the main-loop model. Encoded into `value` as a
   * `SWITCH_PROFILE_VALUE_PREFIX`-prefixed string so the picker's `value`
   * channel stays a plain string; consumers must call `parseSwitchProfileValue`
   * on `value` (or read `switchToProfileId` directly) before treating it as a
   * model setting. Used to surface inactive `providerProfiles` from the
   * `/model` picker (issue #1119).
   */
  switchToProfileId?: string
}

/**
 * Prefix encoded into `ModelOption.value` for options that, when selected,
 * should activate a different provider profile before applying the model.
 * Format: `${SWITCH_PROFILE_VALUE_PREFIX}<profileId>:<model>`. Two profiles can
 * legally expose the same model string under different base URLs, so the
 * profile id is part of the value to keep options unique.
 */
export const SWITCH_PROFILE_VALUE_PREFIX = '__switch_profile__:'

export type ParsedSwitchProfileValue = {
  profileId: string
  model: string
}

export function parseSwitchProfileValue(
  value: ModelSetting,
): ParsedSwitchProfileValue | null {
  if (typeof value !== 'string' || !value.startsWith(SWITCH_PROFILE_VALUE_PREFIX)) {
    return null
  }
  const tail = value.slice(SWITCH_PROFILE_VALUE_PREFIX.length)
  const sep = tail.indexOf(':')
  if (sep <= 0 || sep === tail.length - 1) {
    return null
  }
  return {
    profileId: tail.slice(0, sep),
    model: tail.slice(sep + 1),
  }
}

export function encodeSwitchProfileValue(profileId: string, model: string): string {
  return `${SWITCH_PROFILE_VALUE_PREFIX}${profileId}:${model}`
}

/**
 * Resolve the cross-profile switch marker (`switchToProfileId`) for a selected
 * picker value from the PRESENTED options list — the authority for whether the
 * selection is a genuine profile switch (#1119/#1164). Only a single option
 * with that value is authoritative: if two options share the value (a literal
 * custom model id colliding with an encoded switch value), the Select cannot
 * tell them apart, so the selection is ambiguous and resolves to `undefined`
 * rather than letting the literal borrow another option's marker.
 */
export function resolveSelectedSwitchProfileId(
  options: ReadonlyArray<Pick<ModelOption, 'value' | 'switchToProfileId'>>,
  selectedValue: ModelSetting,
): string | undefined {
  const matches = options.filter(option => option.value === selectedValue)
  return matches.length === 1 ? matches[0]!.switchToProfileId : undefined
}

function getScopedAdditionalModelOptions(): ModelOption[] {
  const config = getGlobalConfig()
  const activeScope = getAdditionalModelOptionsCacheScope()

  if (!activeScope) {
    return []
  }

  if (config.additionalModelOptionsCacheScope !== undefined) {
    return config.additionalModelOptionsCacheScope === activeScope
      ? (config.additionalModelOptionsCache ?? [])
      : []
  }

  return activeScope === 'firstParty'
    ? (config.additionalModelOptionsCache ?? [])
    : []
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  const is3P = !isFirstPartyAnthropicProvider()
  const currentDefaultModel =
    isCustomAnthropicProvider() && process.env.ANTHROPIC_MODEL
      ? process.env.ANTHROPIC_MODEL
      : getDefaultMainLoopModelSetting()

  if (process.env.USER_TYPE === 'ant' && !is3P) {
    const currentModel = renderDefaultModelSetting(currentDefaultModel)
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`,
    }
  }

  if (is3P) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model (currently ${renderDefaultModelSetting(currentDefaultModel)})`,
    }
  }

  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(currentDefaultModel)})${getPricingSuffix(getDefaultSonnetModel())}`,
  }
}

function getPricingSuffix(model: string): string {
  if (!isFirstPartyAnthropicProvider()) return ''
  const pricing = getModelPricingString(model)
  return pricing ? ` · ${pricing}` : ''
}

function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  // When a 3P user has a custom sonnet model string, show it directly
  if (is3P && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel)
    return {
      value: 'sonnet',
      label:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`,
    }
  }
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getSonnet46Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet46 : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.6 · Best for everyday tasks${getPricingSuffix(getModelStrings().sonnet46)}`,
    descriptionForModel:
      'Sonnet 4.6 - best for everyday tasks. Generally recommended for most coding tasks',
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // When a 3P user has a custom opus model string, show it directly
  if (is3P && customOpusModel) {
    const is1m = has1mContext(customOpusModel)
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description:
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`,
    }
  }
}

function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version',
  }
}

function getOpus48Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus48 : 'opus',
    label: 'Opus',
    description: `Opus 4.8 · Most capable for complex work${getOpus46PricingSuffix(fastMode, getModelStrings().opus48)}`,
    descriptionForModel: 'Opus 4.8 - most capable for complex work',
  }
}

function getOpus47Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus47 : 'opus',
    label: 'Opus',
    description: `Opus 4.7 · Most capable for complex work${getOpus46PricingSuffix(fastMode, getModelStrings().opus47)}`,
    descriptionForModel: 'Opus 4.7 - most capable for complex work',
  }
}

function getOpus46Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus46 : 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work${getOpus46PricingSuffix(fastMode, getModelStrings().opus46)}`,
    descriptionForModel: 'Opus 4.6 - most capable for complex work',
  }
}

export function getSonnet46_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet46 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 for long sessions${getPricingSuffix(getModelStrings().sonnet46)}`,
    descriptionForModel:
      'Sonnet 4.6 with 1M context window - for long sessions with large codebases',
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  // 3P pins Opus 4.6; first-party resolves the `opus` alias to the current
  // default (Opus 4.8), so the label must follow the provider.
  const opusName = is3P ? 'Opus 4.6' : 'Opus 4.8'
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `${opusName} for long sessions${getOpus46PricingSuffix(fastMode, is3P ? getModelStrings().opus46 : getModelStrings().opus48)}`,
    descriptionForModel: `${opusName} with 1M context window - for long sessions with large codebases`,
  }
}

function getCustomHaikuOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  // When a 3P user has a custom haiku model string, show it directly
  if (is3P && customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description:
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`,
    }
  }
}

function getHaiku45Option(): ModelOption {
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${getPricingSuffix(getModelStrings().haiku45)}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

function getHaiku35Option(): ModelOption {
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${getPricingSuffix(getModelStrings().haiku35)}`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel()
  return haikuModel === getModelStrings().haiku45
    ? getHaiku45Option()
    : getHaiku35Option()
}

function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.8 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true, getModelStrings().opus48) : ''}`,
  }
}

export function getMaxSonnet46_1MOption(): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 with 1M context${billingInfo}${getPricingSuffix(getModelStrings().sonnet46)}`,
  }
}

export function getMaxOpus46_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.8 with 1M context${billingInfo}${getOpus46PricingSuffix(fastMode, getModelStrings().opus48)}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus46 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `${is3P ? 'Opus 4.6' : 'Opus 4.8'} with 1M context · Most capable for complex work${!is3P && fastMode ? getOpus46PricingSuffix(fastMode, getModelStrings().opus48) : ''}`,
    descriptionForModel:
      `${is3P ? 'Opus 4.6' : 'Opus 4.8'} with 1M context - most capable for complex work`,
  }
}

const MaxSonnet46Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 4.6 · Best for everyday tasks',
}

const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 4.8 in plan mode, Sonnet 4.6 otherwise',
  }
}

function getCodexPlanOption(): ModelOption {
  return {
    value: 'gpt-5.5',
    label: 'gpt-5.5',
    description: 'GPT-5.5 on the Codex backend with high reasoning',
  }
}

function getCodexSparkOption(): ModelOption {
  return {
    value: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
    description: 'GPT-5.3 Codex Spark on the Codex backend for fast tool loops',
  }
}

function getCodexModelOptions(): ModelOption[] {
  return [
    {
      value: 'gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      description: 'GPT-5.6 Sol · Flagship for complex work, high reasoning',
    },
    {
      value: 'gpt-5.6-terra',
      label: 'gpt-5.6-terra',
      description: 'GPT-5.6 Terra · Balanced everyday workhorse',
    },
    {
      value: 'gpt-5.6-luna',
      label: 'gpt-5.6-luna',
      description: 'GPT-5.6 Luna · Fast and cost-effective',
    },
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      description: 'GPT-5.5 with high reasoning',
    },
    {
      value: 'gpt-5.4',
      label: 'gpt-5.4',
      description: 'GPT-5.4 with high reasoning',
    },
    {
      value: 'gpt-5.3-codex',
      label: 'gpt-5.3-codex',
      description: 'GPT-5.3 Codex with high reasoning',
    },
    {
      value: 'gpt-5.3-codex-spark',
      label: 'gpt-5.3-codex-spark',
      description: 'GPT-5.3 Codex Spark for fast tool loops',
    },
    {
      value: 'codexspark',
      label: 'codexspark',
      description: 'GPT-5.3 Codex Spark alias for fast tool loops',
    },
    {
      value: 'gpt-5.2-codex',
      label: 'gpt-5.2-codex',
      description: 'GPT-5.2 Codex with high reasoning',
    },
    {
      value: 'gpt-5.1-codex-max',
      label: 'gpt-5.1-codex-max',
      description: 'GPT-5.1 Codex Max for deep reasoning',
    },
    {
      value: 'gpt-5.1-codex-mini',
      label: 'gpt-5.1-codex-mini',
      description: 'GPT-5.1 Codex Mini - faster, cheaper',
    },
    {
      value: 'gpt-5.5-mini',
      label: 'gpt-5.5-mini',
      description: 'GPT-5.5 Mini - faster, cheaper',
    },
    {
      value: 'gpt-5.4-mini',
      label: 'gpt-5.4-mini',
      description: 'GPT-5.4 Mini - faster, cheaper',
    },
  ]
}

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.

import { getAllCopilotModels } from './copilotModels.js'

function getCopilotModelOptions(): ModelOption[] {
  return getAllCopilotModels().map(m => ({
    value: m.id,
    label: m.name,
    description: `${m.family}${m.reasoning ? ' · Reasoning' : ''}${m.tool_call ? ' · Tool call' : ''} · ${Math.round(m.limit.context / 1000)}K context`,
  }))
}

function getModelOptionsBase(fastMode = false): ModelOption[] {
  // When a provider profile's env is applied, collect its models so they
  // can be appended to the picker options below.
  // We check PROFILE_ENV_APPLIED to avoid the ?? profiles[0] fallback in
  // getActiveProviderProfile which would affect users with inactive profiles.
  //
  // Hoisted above the local OpenAI-compatible early returns (Ollama and the
  // route-catalog scope) because users with a local profile active still need
  // the unified `/model` switcher to surface every other configured profile —
  // otherwise they have to round-trip through `/provider` (issue #1119).
  const profileEnvApplied = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1'
  const profileModelOptions: ModelOption[] = []
  let activeProfileId: string | undefined
  if (profileEnvApplied) {
    const activeProfile = getActiveProviderProfile()
    if (activeProfile) {
      activeProfileId = activeProfile.id
      const models = getProfileModelOptions(activeProfile)
      profileModelOptions.push(...models)
    }
  }

  // Inactive provider profile options. Surfaces each configured-but-inactive
  // provider profile's models in the picker so users can switch active provider
  // + model from `/model` instead of having to round-trip through `/provider`
  // (issue #1119). Only built when the active profile env is applied so we
  // don't expose this affordance to users who haven't opted into the
  // multi-profile workflow.
  const inactiveProfileOptions: ModelOption[] = profileEnvApplied
    ? getInactiveProviderProfileOptions(activeProfileId)
    : []

  if (getAPIProvider() === 'github') {
    return [
      getDefaultOptionForUser(fastMode),
      ...getCopilotModelOptions(),
      ...inactiveProfileOptions,
    ]
  }

  // When using Ollama, show models from the Ollama server instead of Claude models
  if (getAPIProvider() === 'openai' && isOllamaProvider()) {
    const defaultOption = getDefaultOptionForUser(fastMode)
    const ollamaModels = getCachedOllamaModelOptions()
    if (ollamaModels.length > 0) {
      return [defaultOption, ...ollamaModels, ...inactiveProfileOptions]
    }
    // Fallback: if models not yet fetched, show current model instead of Claude models
    const currentModel = getUserSpecifiedModelSetting() ?? getInitialMainLoopModel()
    if (currentModel != null) {
      return [
        defaultOption,
        {
          value: currentModel,
          label: currentModel,
          description: 'Currently configured Ollama model',
        },
        ...inactiveProfileOptions,
      ]
    }
    return [defaultOption, ...inactiveProfileOptions]
  }

  // When using NVIDIA NIM, show models from the NVIDIA catalog
  if (isNvidiaNimProvider()) {
    const defaultOption = getDefaultOptionForUser(fastMode)
    const nvidiaModels = getCachedNvidiaNimModelOptions()
    if (nvidiaModels.length > 0) {
      return [defaultOption, ...nvidiaModels, ...inactiveProfileOptions]
    }
    return [defaultOption, ...inactiveProfileOptions]
  }

  // When using MiniMax, show models from the MiniMax catalog
  if (isMiniMaxProvider()) {
    const defaultOption = getDefaultOptionForUser(fastMode)
    const minimaxModels = getCachedMiniMaxModelOptions()
    if (minimaxModels.length > 0) {
      return [defaultOption, ...minimaxModels, ...inactiveProfileOptions]
    }
    return [defaultOption, ...inactiveProfileOptions]
  }

  // When using Xiaomi MiMo, show models from the MiMo catalog
  if (isXiaomiMimoProvider()) {
    const defaultOption = getDefaultOptionForUser(fastMode)
    const xiaomiMimoModels = getCachedXiaomiMimoModelOptions()
    if (xiaomiMimoModels.length > 0) {
      return [defaultOption, ...xiaomiMimoModels, ...inactiveProfileOptions]
    }
    return [defaultOption, ...inactiveProfileOptions]
  }

  const activeProfile = getActiveProviderProfile()
  const activeRouteId = resolveActiveRouteIdFromEnv(process.env, {
    activeProfileProvider: activeProfile?.provider,
    activeProfileBaseUrl: activeProfile?.baseUrl,
  })
  if (getTransportKindForRoute(activeRouteId ?? '') === 'anthropic-proxy') {
    const directEnvOption =
      profileModelOptions.length === 0 && process.env.ANTHROPIC_MODEL
        ? [{
            value: process.env.ANTHROPIC_MODEL,
            label: process.env.ANTHROPIC_MODEL,
            description: 'Custom Anthropic-compatible endpoint',
          }]
        : []
    return [
      getDefaultOptionForUser(fastMode),
      ...profileModelOptions,
      ...directEnvOption,
      ...inactiveProfileOptions,
    ]
  }

  if (process.env.USER_TYPE === 'ant') {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[internal] ${m.label} (${m.model})`,
    }))

    return [
      getDefaultOptionForUser(),
      ...antModelOptions,
      getMergedOpus1MOption(fastMode),
      getSonnet46Option(),
      getSonnet46_1MOption(),
      getHaiku45Option(),
      ...inactiveProfileOptions,
    ]
  }

  if (isClaudeAISubscriber()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: Opus is default, show Sonnet as alternative
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      if (!isOpus1mMergeEnabled() && checkOpus1mAccess()) {
        premiumOptions.push(getMaxOpus46_1MOption(fastMode))
      }

      premiumOptions.push(MaxSonnet46Option)
      if (checkSonnet1mAccess()) {
        premiumOptions.push(getMaxSonnet46_1MOption())
      }

      premiumOptions.push(MaxHaiku45Option)
      premiumOptions.push(...inactiveProfileOptions)
      return premiumOptions
    }

    // Pro/Team Standard/Enterprise users: Sonnet is default, show Opus as alternative
    const standardOptions = [getDefaultOptionForUser(fastMode)]
    if (checkSonnet1mAccess()) {
      standardOptions.push(getMaxSonnet46_1MOption())
    }

    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption(fastMode))
      if (checkOpus1mAccess()) {
        standardOptions.push(getMaxOpus46_1MOption(fastMode))
      }
    }

    standardOptions.push(MaxHaiku45Option)
    standardOptions.push(...inactiveProfileOptions)
    return standardOptions
  }

  // Local OpenAI-compatible / route-catalog scope. Inactive-profile options are
  // appended here too so the unified `/model` switcher still surfaces every
  // other configured profile while a local/route profile is active (#1119).
  const activeRouteCatalogOptions = getActiveOpenAIRouteCatalogOptions()
  const openAIModelOptionsScope = getAdditionalModelOptionsCacheScope()
  if (
    activeRouteCatalogOptions.length > 0 ||
    openAIModelOptionsScope?.startsWith('openai:')
  ) {
    const activeOpenAIOptions = activeProfile
      ? getActiveOpenAIModelOptionsCache()
      : []
    const scopedOptions = openAIModelOptionsScope?.startsWith('openai:')
      ? getScopedAdditionalModelOptions()
      : []
    const sourceOptions = activeOpenAIOptions.length > 0
      ? activeOpenAIOptions
      : scopedOptions
    return [
      getDefaultOptionForUser(fastMode),
      ...mergeModelOptionsByNormalizedValue(
        sourceOptions,
        activeRouteCatalogOptions,
      ),
      ...inactiveProfileOptions,
    ]
  }

  // PAYG 1P API: Default (Sonnet) + Sonnet 1M + Opus 4.8 + Opus 4.7 + Opus 4.6 + Opus 1M + Haiku
  if (getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    if (checkSonnet1mAccess()) {
      payg1POptions.push(getSonnet46_1MOption())
    }
    if (isOpus1mMergeEnabled()) {
      payg1POptions.push(getMergedOpus1MOption(fastMode))
    } else {
      payg1POptions.push(getOpus48Option(fastMode))
      payg1POptions.push(getOpus47Option(fastMode))
      payg1POptions.push(getOpus46Option(fastMode))
      if (checkOpus1mAccess()) {
        payg1POptions.push(getOpus46_1MOption(fastMode))
      }
    }
    payg1POptions.push(getHaiku45Option())
    payg1POptions.push(...profileModelOptions)
    payg1POptions.push(...inactiveProfileOptions)
    return payg1POptions
  }

  // PAYG 3P: Default (Sonnet 4.5) + Sonnet (3P custom) or Sonnet 4.6/1M + Opus (3P custom) or Opus 4.1/Opus 4.6/Opus1M + Haiku + Opus 4.1
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  // Add Codex models for openai and codex providers
  if (getAPIProvider() === 'openai' || getAPIProvider() === 'codex') {
    payg3pOptions.push(...getCodexModelOptions())
  }

  const customSonnet = getCustomSonnetOption()
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet)
  } else {
    // Add Sonnet 4.6 since Sonnet 4.5 is the default
    payg3pOptions.push(getSonnet46Option())
    if (checkSonnet1mAccess()) {
      payg3pOptions.push(getSonnet46_1MOption())
    }
  }

  const customOpus = getCustomOpusOption()
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus)
  } else {
    // Add Opus 4.1, Opus 4.7, Opus 4.6 and Opus 4.6 1M
    // Opus 4.8 is intentionally omitted here until 3P rollout is active;
    // getDefaultOpusModel() keeps non-first-party usage on Opus 4.7.
    payg3pOptions.push(getOpus41Option()) // This is the default opus
    payg3pOptions.push(getOpus47Option(fastMode))
    payg3pOptions.push(getOpus46Option(fastMode))
    if (checkOpus1mAccess()) {
      payg3pOptions.push(getOpus46_1MOption(fastMode))
    }
  }
  const customHaiku = getCustomHaikuOption()
  if (customHaiku !== undefined) {
    payg3pOptions.push(customHaiku)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  payg3pOptions.push(...profileModelOptions)
  payg3pOptions.push(...inactiveProfileOptions)
  return payg3pOptions
}

/**
 * Build picker options for each provider profile that is NOT currently active.
 * Selecting one of these activates the profile (swapping `OPENAI_BASE_URL` /
 * `OPENAI_API_KEY` / etc. via `setActiveProviderProfile`) and then sets the
 * main-loop model to the chosen entry — the equivalent of `/provider` followed
 * by `/model`, but in one step. See issue #1119.
 */
export function getInactiveProviderProfileOptions(
  activeProfileId: string | undefined,
): ModelOption[] {
  const profiles = getProviderProfiles()
  const options: ModelOption[] = []
  for (const profile of profiles) {
    if (profile.id === activeProfileId) {
      continue
    }
    const baseOptions = getProfileModelOptions(profile)
    for (const baseOption of baseOptions) {
      const modelValue =
        typeof baseOption.value === 'string' ? baseOption.value : ''
      if (!modelValue) {
        continue
      }
      options.push({
        value: encodeSwitchProfileValue(profile.id, modelValue),
        label: `${modelValue} · ${profile.name}`,
        description: `Switch to ${profile.name} (${profile.baseUrl})`,
        switchToProfileId: profile.id,
      })
    }
  }
  return options
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (canonical.includes('claude-opus-4')) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

function normalizeRouteModelOptionKey(model: string): string {
  return model.trim().split('?', 1)[0]?.trim().toLowerCase() ?? ''
}

function getActiveOpenAIRouteId(): string | null {
  const openAIFlag = process.env.CLAUDE_CODE_USE_OPENAI?.trim().toLowerCase()
  if (!openAIFlag || ['0', 'false', 'no', 'off'].includes(openAIFlag)) {
    return null
  }

  const scope = getAdditionalModelOptionsCacheScope()
  if (scope?.startsWith('openai:')) {
    const partitionIndex = scope.lastIndexOf(':')
    if (partitionIndex > 'openai:'.length) {
      const baseUrl = scope.slice('openai:'.length, partitionIndex)
      return resolveRouteIdFromBaseUrl(baseUrl)
    }
  }

  return resolveRouteIdFromBaseUrl(resolveProviderRequest().baseUrl)
}

function mergeModelOptionsByNormalizedValue(
  primaryOptions: ModelOption[],
  additionalOptions: ModelOption[],
): ModelOption[] {
  const merged: ModelOption[] = []
  const seen = new Set<string>()

  for (const option of [...primaryOptions, ...additionalOptions]) {
    if (typeof option.value !== 'string') {
      continue
    }

    const value = option.value.trim()
    const key = normalizeRouteModelOptionKey(value)
    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    merged.push({
      ...option,
      value,
    })
  }

  return merged
}

/**
 * ApiNames that appear more than once in the catalog (case-insensitive, after
 * trimming). Computed once up front so `getCatalogOptionValue` is O(1) per
 * entry instead of re-scanning the whole catalog for every entry — catalogs
 * with hundreds of models (e.g. Fireworks) would otherwise make this O(n²).
 */
function getDuplicateCatalogApiNames(
  entries: readonly { apiName: string }[],
): Set<string> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const key = entry.apiName.trim().toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const duplicates = new Set<string>()
  for (const [key, count] of counts) {
    if (count > 1) {
      duplicates.add(key)
    }
  }
  return duplicates
}

function getCatalogOptionValue(entry: { id: string; apiName: string }, duplicateApiNames: Set<string>): string {
  const apiName = entry.apiName.trim()
  const duplicateApiName = duplicateApiNames.has(apiName.toLowerCase())
  return duplicateApiName ? entry.id.trim() : apiName
}

function getActiveOpenAIRouteCatalogOptions(): ModelOption[] {
  const routeId = getActiveOpenAIRouteId()
  if (!routeId) {
    return []
  }

  const entries = getCatalogEntriesForRoute(routeId)
  const duplicateApiNames = getDuplicateCatalogApiNames(entries)
  return entries.flatMap(entry => {
    const value = getCatalogOptionValue(entry, duplicateApiNames)
    if (!value) {
      return []
    }

    return [{
      value,
      label: entry.label ?? value,
      description: entry.apiName,
    }]
  })
}

/**
 * Route-catalog lookup state for one `getModelOptions()` build. Resolving the
 * route id, fetching its catalog entries, and computing the duplicate-apiName
 * set are all O(catalog size) — rebuilding them for every check would make
 * builds with several catalog lookups (env custom model, each scoped
 * additional option, the active custom model) repeatedly rescan the whole
 * catalog. Built once per options build and shared across all lookups.
 */
type RouteCatalogContext = {
  entries: ReturnType<typeof getCatalogEntriesForRoute>
  duplicateApiNames: Set<string>
}

function getRouteCatalogContext(): RouteCatalogContext | null {
  const routeId = getActiveOpenAIRouteId()
  if (!routeId) {
    return null
  }
  const entries = getCatalogEntriesForRoute(routeId)
  return {
    entries,
    duplicateApiNames: getDuplicateCatalogApiNames(entries),
  }
}

function findRouteCatalogOption(
  context: RouteCatalogContext | null,
  value: ModelSetting,
): ModelOption | null {
  if (!context || typeof value !== 'string') {
    return null
  }

  const normalizedValue = normalizeRouteModelOptionKey(value)
  if (!normalizedValue) {
    return null
  }

  const catalogEntry = context.entries.find(entry =>
    normalizeRouteModelOptionKey(entry.apiName) === normalizedValue ||
    normalizeRouteModelOptionKey(entry.id) === normalizedValue ||
    (entry.aliases ?? []).some(
      alias => normalizeRouteModelOptionKey(alias) === normalizedValue,
    ),
  )
  if (!catalogEntry) {
    return null
  }

  return {
    value: getCatalogOptionValue(catalogEntry, context.duplicateApiNames),
    label: catalogEntry.label ?? catalogEntry.apiName,
    description: catalogEntry.apiName,
  }
}

/**
 * True when `value` (or its canonical route-catalog entry) already appears in
 * `options`. The catalog lookup is hoisted out of the per-option loop — with
 * large static catalogs (e.g. Fireworks' ~280 entries) the previous
 * `options.some(optionMatchesModel)` re-ran the catalog scan for every option,
 * making each `getModelOptions()` call O(n²) and the `/model` picker lag on
 * every keystroke.
 */
function hasOptionValue(
  options: ModelOption[],
  value: ModelSetting,
  getRouteCatalogContext: () => RouteCatalogContext | null,
): boolean {
  if (options.some(option => option.value === value)) {
    return true
  }
  const catalogOption = findRouteCatalogOption(getRouteCatalogContext(), value)
  return (
    catalogOption !== null &&
    options.some(option => option.value === catalogOption.value)
  )
}

export function getModelOptions(fastMode = false): ModelOption[] {
  if (getAPIProvider() === 'github') {
    return filterModelOptionsByAllowlist(getModelOptionsBase(fastMode))
  }

  const options = getModelOptionsBase(fastMode)

  // Route-catalog lookup state is built once per options build (on first use)
  // and shared by every catalog check below, so repeated lookups — the env
  // custom model, each scoped additional option, and the active custom model —
  // don't each rescan the full catalog and rebuild the duplicate-apiName set.
  let routeCatalogContextBuilt = false
  let routeCatalogContext: RouteCatalogContext | null = null
  const getSharedRouteCatalogContext = (): RouteCatalogContext | null => {
    if (!routeCatalogContextBuilt) {
      routeCatalogContextBuilt = true
      routeCatalogContext = getRouteCatalogContext()
    }
    return routeCatalogContext
  }

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !hasOptionValue(options, envCustomModel, getSharedRouteCatalogContext)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getScopedAdditionalModelOptions()) {
    const catalogOption = findRouteCatalogOption(
      getSharedRouteCatalogContext(),
      opt.value,
    )
    const nextOption = catalogOption ? { ...opt, ...catalogOption } : opt
    if (
      !hasOptionValue(options, nextOption.value, getSharedRouteCatalogContext)
    ) {
      options.push(nextOption)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (
    customModel === null ||
    hasOptionValue(options, customModel, getSharedRouteCatalogContext)
  ) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'gpt-5.5') {
    return filterModelOptionsByAllowlist([...options, getCodexPlanOption()])
  } else if (customModel === 'gpt-5.3-codex-spark') {
    return filterModelOptionsByAllowlist([...options, getCodexSparkOption()])
  }

  // Persisted Codex model while a non-Codex provider is active (the Codex
  // options were not appended above): surface the curated option instead
  // of a generic "Custom model" entry, mirroring the gpt-5.5/spark cases
  // for every Codex picker model. Match on the [1m]-stripped base so a
  // tagged pick still gets its curated entry, but keep the persisted value
  // on the option so selection matching stays exact.
  const customCodexBase = customModel.replace(/\[1m]$/i, '')
  const customCodexOption = getCodexModelOptions().find(
    opt => opt.value === customCodexBase,
  )
  if (customCodexOption) {
    return filterModelOptionsByAllowlist([
      ...options,
      customCodexBase === customModel
        ? customCodexOption
        : { ...customCodexOption, value: customModel },
    ])
  }
  if (customModel === 'opus' && getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()) {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    const catalogOption = findRouteCatalogOption(
      getSharedRouteCatalogContext(),
      customModel,
    )
    if (catalogOption) {
      options.push(catalogOption)
      return filterModelOptionsByAllowlist(options)
    }

    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  const filtered = !settings.availableModels
    ? options // No restrictions
    : options.filter(opt => {
        if (opt.value === null) {
          return true
        }
        // Cross-profile options carry an encoded
        // `__switch_profile__:<id>:<model>` value; evaluate the allowlist
        // against the decoded target model so an allowed model is not dropped
        // just because of the switch wrapper. Only decode genuine switch
        // options — identified by the `switchToProfileId` marker, not the raw
        // string prefix — so a normal custom model id that happens to start with
        // `__switch_profile__:` is checked verbatim rather than mis-parsed.
        const effectiveModel =
          opt.switchToProfileId !== undefined
            ? parseSwitchProfileValue(opt.value)?.model ?? opt.value
            : opt.value
        return isModelAllowed(effectiveModel)
      })

  // Select state uses option values as identity keys. If two entries share the
  // same value (e.g. provider-specific aliases collapsing to one model ID),
  // navigation/focus can become inconsistent and appear as duplicate rendering.
  const seen = new Set<string>()
  return filtered.filter(opt => {
    const key = String(opt.value)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}
