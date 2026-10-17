import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import {
  ModelPicker,
  type ModelPickerDiscoveryState,
} from '../../components/ModelPicker.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  clearDiscoveryCache,
  getCachedModels,
  isCacheStale,
  parseDurationString,
} from '../../integrations/discoveryCache.js'
import type { ModelCatalogConfig } from '../../integrations/descriptors.js'
import { filterAvailableCatalogEntries } from '../../integrations/index.js'
import {
  discoverModelsForRoute,
  getDiscoveryCacheKey,
  resolveDiscoveryRequestOptions,
} from '../../integrations/discoveryService.js'
import { getCommandcodeChatCompletionsModelError } from '../../integrations/gateways/commandcode.js'
import {
  getRouteDescriptor,
  isNativeVendorCatalogRoute,
  resolveRouteCredentialValue,
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
} from '../../integrations/routeMetadata.js'
import { resolveProfileRoute } from '../../integrations/profileResolver.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  getAdditionalModelOptionsCacheScope,
  resolveProviderRequest,
} from '../../services/api/providerConfig.js'
import { firstUsableCredential } from '../../services/api/credentialPool.js'
import type { ProviderProfile } from '../../utils/config.js'
import type { AppState } from '../../state/AppState.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  type EffortLevel,
  getEffortEnvOverride,
  resolveAppliedEffort,
} from '../../utils/effort.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from '../../utils/model/check1mAccess.js'
import {
  getDefaultOptionForUser,
  getInactiveProviderProfileOptions,
  parseSwitchProfileValue,
  type ModelOption,
} from '../../utils/model/modelOptions.js'
import { buildRouteCatalogModelOptions, mergeRouteCatalogEntries } from '../../utils/model/routeCatalogOptions.js'
import { discoverOpenAICompatibleModelOptions } from '../../utils/model/openaiModelDiscovery.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { getLocalOpenAICompatibleProviderLabel } from '../../utils/providerDiscovery.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { parseCustomHeadersEnv } from '../../utils/providerCustomHeaders.js'
import {
  getActiveOpenAIRouteModelOptionsCache,
  getActiveProviderProfile,
  getConfiguredProfileModelOptions,
  getProviderProfiles,
  setActiveOpenAIRouteModelOptionsCache,
  setActiveOpenAIModelOptionsCache,
  setActiveProviderProfile,
} from '../../utils/providerProfiles.js'
import { parseModelList } from '../../utils/providerModels.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export type ProviderProfileModelPickerMode = 'auto' | 'profile' | 'provider'
export type ResolvedProviderProfileModelSurface = 'profile' | 'provider'

type ModelDiscoveryContext =
  | {
      kind: 'descriptor'
      autoRefresh: boolean
      canRefresh: boolean
      discoveryState?: ModelPickerDiscoveryState
      profileModelSurface: ResolvedProviderProfileModelSurface
      optionsOverride: ModelOption[]
      routeId: string
      routeDefaultModel?: string
      routeLabel: string
    }
  | {
      kind: 'legacy-openai'
      autoRefresh: boolean
      canRefresh: boolean
      discoveryState?: ModelPickerDiscoveryState
      optionsOverride: ModelOption[]
      profileModelSurface: ResolvedProviderProfileModelSurface
      routeId: string
      routeLabel: string
    }

function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return model === null ? `${rendered} (default)` : rendered
}

function haveSameModelOptions(left: ModelOption[], right: ModelOption[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((option, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      option.value === other.value &&
      option.label === other.label &&
      option.description === other.description &&
      option.descriptionForModel === other.descriptionForModel
    )
  })
}

function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  return options.filter(option => {
    if (option.value === null) {
      return true
    }
    return typeof option.value === 'string'
      ? isModelAllowed(option.value)
      : true
  })
}

function modelOptionKey(option: ModelOption): string | null {
  const value = typeof option.value === 'string' ? option.value.trim() : ''
  return value ? value.toLowerCase() : null
}

function mergeProfileListFirst(
  routeOptions: ModelOption[],
  profileOptions: ModelOption[],
): ModelOption[] {
  const routeOptionsByValue = new Map(
    routeOptions.flatMap(option => {
      const key = modelOptionKey(option)
      return key ? [[key, option] as const] : []
    }),
  )
  const merged: ModelOption[] = []
  const seen = new Set<string>()

  for (const option of profileOptions) {
    const key = modelOptionKey(option)
    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    merged.push(routeOptionsByValue.get(key) ?? option)
  }

  return merged
}

function mergeProviderCatalogFirst(
  routeOptions: ModelOption[],
  profileOptions: ModelOption[],
): ModelOption[] {
  const merged: ModelOption[] = []
  const seen = new Set<string>()

  for (const option of routeOptions) {
    const key = modelOptionKey(option)
    if (key) {
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
    }
    merged.push(option)
  }

  for (const option of profileOptions) {
    const key = modelOptionKey(option)
    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    merged.push(option)
  }

  return merged
}

function getProviderProfileModelPickerMode(): ProviderProfileModelPickerMode {
  const mode = getInitialSettings().providerProfileModelPickerMode
  return mode === 'profile' || mode === 'provider' || mode === 'auto'
    ? mode
    : 'auto'
}

export function resolveProviderProfileModelSurface(options: {
  activeProfile?: ProviderProfile | null
  routeId?: string
  settingsMode?: ProviderProfileModelPickerMode
}): ResolvedProviderProfileModelSurface {
  if (options.settingsMode === 'profile') {
    return 'profile'
  }
  if (options.settingsMode === 'provider') {
    return 'provider'
  }

  if (options.routeId && isNativeVendorCatalogRoute(options.routeId)) {
    return 'provider'
  }

  const explicitProfileModelCount = options.activeProfile
    ? parseModelList(options.activeProfile.model).length
    : 0

  return explicitProfileModelCount > 1 ? 'profile' : 'provider'
}

function getActiveProfileRouteId(activeProfile: ProviderProfile): string {
  return (
    resolveRouteIdFromBaseUrl(activeProfile.baseUrl) ??
    resolveProfileRoute(activeProfile.provider).routeId
  )
}

function isActiveProfileAppliedToRoute(
  activeProfile: ProviderProfile,
  routeId: string,
): boolean {
  return (
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1' &&
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID ===
      activeProfile.id &&
    getActiveProfileRouteId(activeProfile) === routeId
  )
}

export function mergeActiveProfileModelOptions(
  routeId: string,
  routeOptions: ModelOption[],
  options?: {
    profileModelSurface?: ResolvedProviderProfileModelSurface
  },
): ModelOption[] {
  const activeProfile = getActiveProviderProfile()
  if (!activeProfile) {
    return filterModelOptionsByAllowlist(routeOptions)
  }

  if (!isActiveProfileAppliedToRoute(activeProfile, routeId)) {
    return filterModelOptionsByAllowlist(routeOptions)
  }

  const profileOptions = getConfiguredProfileModelOptions(activeProfile)
  if (profileOptions.length === 0) {
    return filterModelOptionsByAllowlist(routeOptions)
  }

  const surface =
    options?.profileModelSurface ??
    resolveProviderProfileModelSurface({
      activeProfile,
      routeId,
      settingsMode: getProviderProfileModelPickerMode(),
    })
  const merged =
    surface === 'provider'
      ? mergeProviderCatalogFirst(routeOptions, profileOptions)
      : mergeProfileListFirst(routeOptions, profileOptions)

  return filterModelOptionsByAllowlist(merged)
}

function getActiveRouteId(): string | null {
  const activeProfile = getActiveProviderProfile()
  return resolveActiveRouteIdFromEnv(process.env, {
    activeProfileProvider: activeProfile?.provider,
  })
}

function getLegacyOpenAIOptionsOverride(options: {
  profileModelSurface: ResolvedProviderProfileModelSurface
  routeId: string
}): ModelOption[] {
  const scopedOptions = getActiveOpenAIRouteModelOptionsCache()
  const activeProfile = getActiveProviderProfile()
  if (
    !activeProfile ||
    !isActiveProfileAppliedToRoute(activeProfile, options.routeId)
  ) {
    return filterModelOptionsByAllowlist([
      getDefaultOptionForUser(),
      ...scopedOptions,
    ])
  }

  return mergeActiveProfileModelOptions(
    options.routeId,
    scopedOptions,
    {
      profileModelSurface: options.profileModelSurface,
    },
  )
}

// The picker renders `optionsOverride ?? getModelOptions()`. getModelOptions()
// appends inactive-profile switch entries (issue #1119) when a provider profile
// env is applied, but the discovery/refresh override lists are built from
// mergeActiveProfileModelOptions, which only merges the ACTIVE profile's route
// models. Without re-appending here, the unified `/model` switcher disappears
// for descriptor-backed and legacy OpenAI-compatible discovery contexts
// (OpenRouter/Kimi/MiniMax, refreshed local profiles). Mirror getModelOptions()
// so any override list carries the same inactive-profile switch options.
function withInactiveProfileSwitchOptions(
  options: ModelOption[],
): ModelOption[] {
  if (process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED !== '1') {
    return options
  }
  const activeProfile = getActiveProviderProfile()
  const switchOptions = getInactiveProviderProfileOptions(activeProfile?.id)
  if (switchOptions.length === 0) {
    return options
  }
  const present = new Set(
    options.flatMap(option =>
      typeof option.value === 'string' ? [option.value] : [],
    ),
  )
  const additions = switchOptions.filter(option => {
    if (typeof option.value !== 'string' || present.has(option.value)) {
      return false
    }
    // Apply the org allowlist to the decoded target model, mirroring
    // getModelOptions()'s allowlist pass, so a restricted switch target is not
    // surfaced. handleSelect re-checks this before activating regardless.
    const target =
      option.switchToProfileId !== undefined
        ? parseSwitchProfileValue(option.value)?.model ?? option.value
        : option.value
    return isModelAllowed(target)
  })
  return additions.length > 0 ? [...options, ...additions] : options
}

async function getOpenAIDiscoveryRequestOptions(
  routeId?: string | null,
  options?: { refreshXaiOAuth?: boolean },
): Promise<{
  apiKey?: string
  cacheKey?: string
  baseUrl?: string
  headers?: Record<string, string>
}> {
  const request = resolveProviderRequest({
    model: process.env.OPENAI_MODEL,
    baseUrl:
      process.env.OPENAI_BASE_URL?.trim() ||
      process.env.OPENAI_API_BASE?.trim(),
  })

  return resolveDiscoveryRequestOptions(routeId ?? 'custom', {
    apiKey: firstUsableCredential(
      resolveRouteCredentialValue({
        routeId,
        baseUrl: request.baseUrl,
        processEnv: process.env,
      }),
    ),
    baseUrl: request.baseUrl,
    headers: parseCustomHeadersEnv(process.env.ANTHROPIC_CUSTOM_HEADERS),
  }, options)
}

// Reconciles fast-mode state when /model picks a new target — both the regular
// switch path and the cross-profile switch path (#1119 / jatmn review) call
// this so a latched fastMode never carries past a model that can't support it.
// Pure: returns the result and lets callers apply state mutations.
export type FastModeReconcileResult = 'on' | 'off' | 'unchanged'

export function reconcileFastModeForSwitch(
  targetModel: string | null,
  isFastModeOn: boolean,
): FastModeReconcileResult {
  if (!isFastModeEnabled()) return 'unchanged'
  clearFastModeCooldown()
  if (!isFastModeSupportedByModel(targetModel) && isFastModeOn) {
    return 'off'
  }
  if (
    isFastModeSupportedByModel(targetModel) &&
    isFastModeAvailable() &&
    isFastModeOn
  ) {
    return 'on'
  }
  return 'unchanged'
}

export function shouldAutoRefreshRouteCatalog(options: {
  catalog: ModelCatalogConfig
  hasCachedModels: boolean
  staticEntryCount: number
  stale: boolean
}): boolean {
  const needsInitialDiscovery =
    !options.hasCachedModels && options.staticEntryCount === 0

  switch (options.catalog.discoveryRefreshMode) {
    case 'manual':
      return needsInitialDiscovery
    case 'on-open':
      return true
    case 'startup':
      return needsInitialDiscovery
    case 'background-if-stale':
    default:
      return options.stale || !options.hasCachedModels
  }
}

async function loadDescriptorDiscoveryContext(
  routeId: string,
): Promise<ModelDiscoveryContext | null> {
  const descriptor = getRouteDescriptor(routeId)
  const catalog = descriptor?.catalog
  if (!descriptor || !catalog) {
    return null
  }

  if (routeId === 'custom') {
    return null
  }

  const routeLabel = descriptor.label
  const routeDefaultModel =
    'defaultModel' in descriptor ? descriptor.defaultModel : undefined
  const activeProfile = getActiveProviderProfile()
  const profileModelSurface = resolveProviderProfileModelSurface({
    activeProfile,
    routeId,
    settingsMode: getProviderProfileModelPickerMode(),
  })
  // Availability-filter the static entries (hidden / availableUntil) — this
  // path reads the descriptor's catalog directly, so it must apply the same
  // filter as getCatalogEntriesForRoute or an expired time-boxed entry
  // (e.g. a closed free window) stays selectable in the picker. The RAW list
  // is kept alongside: the static+discovery merge below dedupes by apiName
  // with static entries winning, so the expired static entry must still be
  // present there to block a cached discovery duplicate (which would carry
  // no availableUntil marker and survive the post-merge filter).
  const rawStaticEntries = catalog.models ?? []
  const staticEntries = filterAvailableCatalogEntries(rawStaticEntries)
  const trafficRestricted = isEssentialTrafficOnly()
  const canRefresh = Boolean(
    catalog.discovery && catalog.allowManualRefresh && !trafficRestricted,
  )

  if (!catalog.discovery) {
    if (staticEntries.length === 0) {
      return null
    }

    const routeOptions = buildRouteCatalogModelOptions(
      routeLabel,
      staticEntries,
      routeDefaultModel,
    )

    return {
      kind: 'descriptor',
      autoRefresh: false,
      canRefresh,
      profileModelSurface,
      optionsOverride: mergeActiveProfileModelOptions(routeId, routeOptions, {
        profileModelSurface,
      }),
      routeId,
      routeDefaultModel,
      routeLabel,
    }
  }

  const ttlMs = parseDurationString(catalog.discoveryCacheTtl ?? 0)
  const discoveryOptions = await getOpenAIDiscoveryRequestOptions(routeId, {
    refreshXaiOAuth: false,
  })
  const cacheKey = getDiscoveryCacheKey(routeId, discoveryOptions)
  const cached = await getCachedModels(cacheKey, ttlMs, { includeStale: true })
  const stale = await isCacheStale(cacheKey, ttlMs)
  const autoRefresh = shouldAutoRefreshRouteCatalog({
    catalog,
    hasCachedModels: cached !== null,
    staticEntryCount: staticEntries.length,
    stale,
  }) && !trafficRestricted
  // Merge the RAW static list (see above), then filter: the expired static
  // entry wins the apiName dedup against any cached discovery duplicate, and
  // the post-merge filter removes it — so neither copy survives. Filtering
  // after the merge also covers discovery entries carrying their own
  // hidden/availableUntil markers (mapModel).
  const mergedEntries = filterAvailableCatalogEntries(
    mergeRouteCatalogEntries(rawStaticEntries, cached?.models ?? []),
  )

  let discoveryState: ModelPickerDiscoveryState | undefined

  if (cached?.error && mergedEntries.length > 0) {
    discoveryState = {
      message: `Showing cached ${routeLabel} models. Last refresh failed: ${cached.error.message}`,
      tone: 'warning',
    }
  } else if (autoRefresh) {
    discoveryState = {
      message: `Checking ${routeLabel} models…`,
      tone: 'info',
    }
  }

  const routeOptions = buildRouteCatalogModelOptions(
    routeLabel,
    mergedEntries,
    routeDefaultModel,
  )

  return {
    kind: 'descriptor',
    autoRefresh,
    canRefresh,
    discoveryState,
    profileModelSurface,
    optionsOverride: mergeActiveProfileModelOptions(routeId, routeOptions, {
      profileModelSurface,
    }),
    routeId,
    routeDefaultModel,
    routeLabel,
  }
}

async function loadModelDiscoveryContext(): Promise<ModelDiscoveryContext | null> {
  const routeId = getActiveRouteId()
  if (routeId && routeId !== 'anthropic') {
    const descriptorContext = await loadDescriptorDiscoveryContext(routeId)
    if (descriptorContext) {
      return descriptorContext
    }
  }

  if (getAdditionalModelOptionsCacheScope()?.startsWith('openai:')) {
    const { baseUrl } = await getOpenAIDiscoveryRequestOptions()
    const activeProfile = getActiveProviderProfile()
    const legacyRouteId = routeId ?? 'custom'
    const profileModelSurface = resolveProviderProfileModelSurface({
      activeProfile,
      routeId: legacyRouteId,
      settingsMode: getProviderProfileModelPickerMode(),
    })
    return {
      kind: 'legacy-openai',
      autoRefresh: !isEssentialTrafficOnly(),
      canRefresh: !isEssentialTrafficOnly(),
      optionsOverride: getLegacyOpenAIOptionsOverride({
        profileModelSurface,
        routeId: legacyRouteId,
      }),
      profileModelSurface,
      routeId: legacyRouteId,
      routeLabel: getLocalOpenAICompatibleProviderLabel(baseUrl),
    }
  }

  return null
}

function descriptorDiscoveryStateForResult(options: {
  changed: boolean
  manual: boolean
  result: Awaited<ReturnType<typeof discoverModelsForRoute>>
  routeLabel: string
}): ModelPickerDiscoveryState {
  const { changed, manual, result, routeLabel } = options

  if (!result) {
    return {
      message: `Could not load model metadata for ${routeLabel}.`,
      tone: 'error',
    }
  }

  if (result.source === 'stale-cache' && result.error) {
    return {
      message: `Refresh failed for ${routeLabel}. Showing cached models: ${result.error.message}`,
      tone: 'warning',
    }
  }

  if (result.source === 'error' && result.error) {
    return {
      message: `Could not refresh ${routeLabel} models: ${result.error.message}`,
      tone: 'error',
    }
  }

  if (!changed) {
    return {
      message: manual
        ? `No changes found for ${routeLabel}.`
        : `${routeLabel} models are up to date.`,
      tone: 'success',
    }
  }

  return {
    message: manual
      ? `Updated ${routeLabel} models.`
      : `Loaded fresh ${routeLabel} models.`,
    tone: 'success',
  }
}

function legacyDiscoveryStateForOptions(options: {
  changed: boolean
  failed?: boolean
  manual: boolean
  routeLabel: string
}): ModelPickerDiscoveryState {
  const { changed, failed, manual, routeLabel } = options

  if (failed) {
    return {
      message: `Could not refresh ${routeLabel} models.`,
      tone: 'warning',
    }
  }

  if (!changed) {
    return {
      message: manual
        ? `No changes found for ${routeLabel}.`
        : `${routeLabel} models are up to date.`,
      tone: 'success',
    }
  }

  return {
    message: manual
      ? `Updated ${routeLabel} models.`
      : `Loaded fresh ${routeLabel} models.`,
    tone: 'success',
  }
}

function ModelPickerWrapper({
  discoveryContext,
  onDone,
}: {
  discoveryContext: ModelDiscoveryContext | null
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const mainLoopModel = useAppState((s: AppState) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(
    (s: AppState) => s.mainLoopModelForSession,
  )
  const isFastMode = useAppState((s: AppState) => s.fastMode)
  const setAppState = useSetAppState()
  const [optionsOverride, setOptionsOverride] = React.useState<ModelOption[] | undefined>(
    discoveryContext && 'optionsOverride' in discoveryContext
      ? discoveryContext.optionsOverride
      : undefined,
  )
  const [discoveryState, setDiscoveryState] =
    React.useState<ModelPickerDiscoveryState | undefined>(
      discoveryContext?.discoveryState,
    )

  const handleCancel = () => {
    logEvent('tengu_model_command_menu', {
      action: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    onDone(`Kept model as ${chalk.bold(renderModelLabel(mainLoopModel))}`, {
      display: 'system',
    })
  }

  const handleSelect = (
    model: string | null,
    effort: EffortLevel | undefined,
    switchToProfileId?: string,
  ) => {
    // Cross-profile switch from /model picker (issue #1119). The composite
    // value carries the profile id; activate that profile first so subsequent
    // requests use the new OPENAI_BASE_URL / OPENAI_API_KEY, then drop down to
    // the regular model-switch path with the bare model string.
    //
    // Only treat the value as a switch when the SELECTED OPTION carried the
    // `switchToProfileId` marker (threaded here by the picker) — not merely
    // because the value parses as `__switch_profile__:<profileId>:<model>` for
    // an existing profile. A real custom model id such as
    // `__switch_profile__:profile_openai:gpt-5-mini` (where `profile_openai`
    // happens to exist) is a plain option with no marker, and must be applied
    // as a literal model rather than activating the provider. Cross-check the
    // decoded profile id against the threaded marker and a real configured
    // profile before switching.
    const decodedSwitch = parseSwitchProfileValue(model)
    const switchTarget =
      decodedSwitch &&
      switchToProfileId === decodedSwitch.profileId &&
      getProviderProfiles().some(p => p.id === decodedSwitch.profileId)
        ? decodedSwitch
        : null
    if (switchTarget) {
      // Apply the org allowlist to the decoded target model, not the composite
      // value, so a permitted cross-profile model is not wrongly rejected.
      if (!isModelAllowed(switchTarget.model)) {
        onDone(
          `Model '${switchTarget.model}' is not available. Your organization restricts model selection.`,
          { display: 'system' },
        )
        return
      }
      // Run the same fast-mode reconciliation as the regular switch path —
      // otherwise a user with fastMode latched on Anthropic would carry the
      // latched state into the new profile even when its model can't support
      // it (jatmn review, #1119). This MUST run before setActiveProviderProfile:
      // reconcileFastModeForSwitch gates on isFastModeEnabled(), which reads the
      // *active* provider, so once the target profile is activated it reflects
      // the new (fast-mode-less) provider and short-circuits to 'unchanged',
      // leaving fastMode latched on.
      const switchFastMode = reconcileFastModeForSwitch(
        switchTarget.model,
        isFastMode ?? false,
      )

      const activated = setActiveProviderProfile(switchTarget.profileId)
      if (!activated) {
        onDone(`Could not activate provider profile "${switchTarget.profileId}".`, {
          display: 'system',
        })
        return
      }
      logEvent('tengu_model_command_menu', {
        action: 'switch_profile' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        from_model: String(mainLoopModel) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        to_model: String(switchTarget.model) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      setAppState(prev => ({
        ...prev,
        mainLoopModel: switchTarget.model,
        mainLoopModelForSession: null,
      }))

      // Re-evaluate fast mode AFTER activation: the pre-activation reconcile
      // gates on the *source* provider, so its 'on' result can be stale when
      // the target provider can't actually run fast mode (e.g. switching from
      // first-party to a third-party OpenAI-compatible profile whose model name
      // still passes the source-side support check). isFastModeEnabled() now
      // reflects the target provider, so force fastMode off whenever it is no
      // longer genuinely supported (jatmn review, #1119).
      const fastModeSupportedNow =
        isFastModeEnabled() &&
        isFastModeSupportedByModel(switchTarget.model) &&
        isFastModeAvailable()
      const shouldTurnFastModeOff =
        (isFastMode ?? false) &&
        (switchFastMode === 'off' || !fastModeSupportedNow)

      if (shouldTurnFastModeOff) {
        setAppState(prev => ({ ...prev, fastMode: false }))
      }

      let switchMessage = `Switched to ${chalk.bold(activated.name)} · model ${chalk.bold(switchTarget.model)}`
      // Mirror the regular switch confirmation so a cross-profile selection
      // surfaces the same cost-impacting feedback: the selected effort and the
      // `Billed as extra usage` notice (jatmn review, #1119). The picker already
      // decodes effort for switch values, so omitting it here would silently
      // hide reasoning/extra-usage information the direct model path shows.
      if (effort !== undefined) {
        switchMessage += ` with ${chalk.bold(effort)} effort`
      }
      const crossProfileFastModeOn =
        (isFastMode ?? false) && fastModeSupportedNow && !shouldTurnFastModeOff
      if (shouldTurnFastModeOff) {
        switchMessage += ' · Fast mode OFF'
      } else if (crossProfileFastModeOn) {
        switchMessage += ' · Fast mode ON'
      }
      if (
        isBilledAsExtraUsage(
          switchTarget.model,
          crossProfileFastModeOn,
          isOpus1mMergeEnabled(),
        )
      ) {
        switchMessage += ' · Billed as extra usage'
      }
      onDone(switchMessage)
      return
    }

    if (model && !isModelAllowed(model)) {
      onDone(
        `Model '${model}' is not available. Your organization restricts model selection.`,
        { display: 'system' },
      )
      return
    }

    const commandcodeModelError = getActiveCommandcodeModelError(model)
    if (commandcodeModelError) {
      onDone(commandcodeModelError, { display: 'system' })
      return
    }

    logEvent('tengu_model_command_menu', {
      action: String(model) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model: String(mainLoopModel) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: String(model) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
    }))

    let message = `Set model to ${chalk.bold(renderModelLabel(model))}`
    if (effort !== undefined) {
      message += ` with ${chalk.bold(effort)} effort`
    }

    const fastModeResult = reconcileFastModeForSwitch(model, isFastMode ?? false)
    if (fastModeResult === 'off') {
      setAppState(prev => ({
        ...prev,
        fastMode: false,
      }))
    }
    const wasFastModeToggledOn: boolean | undefined =
      fastModeResult === 'on'
        ? true
        : fastModeResult === 'off'
        ? false
        : undefined
    if (fastModeResult === 'on') {
      message += ' · Fast mode ON'
    }

    if (
      isBilledAsExtraUsage(
        model,
        wasFastModeToggledOn === true,
        isOpus1mMergeEnabled(),
      )
    ) {
      message += ' · Billed as extra usage'
    }
    if (wasFastModeToggledOn === false) {
      message += ' · Fast mode OFF'
    }

    onDone(message)
  }

  async function refreshAvailableModels(manual: boolean): Promise<void> {
    if (!discoveryContext) {
      return
    }

    setDiscoveryState({
      message: manual
        ? `Refreshing ${discoveryContext.routeLabel} models…`
        : `Checking ${discoveryContext.routeLabel} models…`,
      tone: 'info',
    })

    if (discoveryContext.kind === 'descriptor') {
      const discoveryOptions = await getOpenAIDiscoveryRequestOptions(
        discoveryContext.routeId,
      )
      if (manual) {
        await clearDiscoveryCache(
          getDiscoveryCacheKey(
            discoveryContext.routeId,
            discoveryOptions,
          ),
        )
      }

      const result = await discoverModelsForRoute(
        discoveryContext.routeId,
        {
          ...discoveryOptions,
          forceRefresh: true,
        },
      )

      const nextOptions = mergeActiveProfileModelOptions(
        discoveryContext.routeId,
        buildRouteCatalogModelOptions(
          discoveryContext.routeLabel,
          result?.models ?? [],
          discoveryContext.routeDefaultModel,
        ),
        {
          profileModelSurface: discoveryContext.profileModelSurface,
        },
      )
      const changed = !haveSameModelOptions(optionsOverride ?? [], nextOptions)

      setOptionsOverride(nextOptions)
      setDiscoveryState(
        descriptorDiscoveryStateForResult({
          changed,
          manual,
          result,
          routeLabel: discoveryContext.routeLabel,
        }),
      )
      return
    }

    try {
      const discoveredOptions = await discoverOpenAICompatibleModelOptions()
      if (discoveredOptions.length === 0) {
        setDiscoveryState(
          legacyDiscoveryStateForOptions({
            changed: false,
            failed: true,
            manual,
            routeLabel: discoveryContext.routeLabel,
          }),
        )
        return
      }

      const currentRawOptions = getActiveOpenAIRouteModelOptionsCache()
      const activeProfile = getActiveProviderProfile()
      const profileApplied = Boolean(
        activeProfile &&
          isActiveProfileAppliedToRoute(
            activeProfile,
            discoveryContext.routeId,
          ),
      )
      const nextOptions = profileApplied
        ? mergeActiveProfileModelOptions(
            discoveryContext.routeId,
            discoveredOptions,
            {
              profileModelSurface: discoveryContext.profileModelSurface,
            },
          )
        : filterModelOptionsByAllowlist([
            getDefaultOptionForUser(),
            ...discoveredOptions,
          ])
      const changed =
        !haveSameModelOptions(optionsOverride ?? currentRawOptions, nextOptions)
      const rawChanged =
        !haveSameModelOptions(currentRawOptions, discoveredOptions)

      if (rawChanged) {
        setActiveOpenAIRouteModelOptionsCache(discoveredOptions)
        if (profileApplied) {
          setActiveOpenAIModelOptionsCache(discoveredOptions)
        }
      }
      setOptionsOverride(nextOptions)

      setDiscoveryState(
        legacyDiscoveryStateForOptions({
          changed,
          manual,
          routeLabel: discoveryContext.routeLabel,
        }),
      )
    } catch {
      setDiscoveryState(
        legacyDiscoveryStateForOptions({
          changed: false,
          failed: true,
          manual,
          routeLabel: discoveryContext.routeLabel,
        }),
      )
    }
  }

  React.useEffect(() => {
    if (!discoveryContext?.autoRefresh) {
      return
    }

    void refreshAvailableModels(false)
    // We only want the initial auto-refresh for the loaded context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ModelPicker
      initial={mainLoopModel}
      sessionModel={mainLoopModelForSession}
      onSelect={handleSelect}
      onCancel={handleCancel}
      isStandaloneCommand
      allowProfileSwitch
      showFastModeNotice={
        isFastModeEnabled() &&
        isFastMode &&
        isFastModeSupportedByModel(mainLoopModel) &&
        isFastModeAvailable()
      }
      optionsOverride={
        optionsOverride
          ? withInactiveProfileSwitchOptions(optionsOverride)
          : undefined
      }
      discoveryState={discoveryState}
      onRefresh={
        discoveryContext?.canRefresh
          ? () => {
              void refreshAvailableModels(true)
            }
          : undefined
      }
    />
  )
}

function SetModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const isFastMode = useAppState((s: AppState) => s.fastMode)
  const setAppState = useSetAppState()
  const model = args === 'default' ? null : args

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(
          `Model '${model}' is not available. Your organization restricts model selection.`,
          {
            display: 'system',
          },
        )
        return
      }

      if (model && isOpus1mUnavailable(model)) {
        onDone(
          'Opus with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
          {
            display: 'system',
          },
        )
        return
      }
      if (model && isSonnet1mUnavailable(model)) {
        onDone(
          'Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
          {
            display: 'system',
          },
        )
        return
      }

      if (!model) {
        setModel(null)
        return
      }

      const commandcodeModelError = getActiveCommandcodeModelError(model)
      if (commandcodeModelError) {
        onDone(commandcodeModelError, {
          display: 'system',
        })
        return
      }

      if (isKnownAlias(model)) {
        setModel(model)
        return
      }

      try {
        const { valid, error } = await validateModel(model)
        if (valid) {
          setModel(model)
        } else {
          onDone(error || `Model '${model}' not found`, {
            display: 'system',
          })
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, {
          display: 'system',
        })
      }
    }

    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null,
      }))

      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))}`
      let wasFastModeToggledOn: boolean | undefined

      if (isFastModeEnabled()) {
        clearFastModeCooldown()
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev => ({
            ...prev,
            fastMode: false,
          }))
          wasFastModeToggledOn = false
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ' · Fast mode ON'
          wasFastModeToggledOn = true
        }
      }

      if (
        isBilledAsExtraUsage(
          modelValue,
          wasFastModeToggledOn === true,
          isOpus1mMergeEnabled(),
        )
      ) {
        message += ' · Billed as extra usage'
      }
      if (wasFastModeToggledOn === false) {
        message += ' · Fast mode OFF'
      }

      onDone(message)
    }

    void handleModelChange()
  }, [isFastMode, model, onDone, setAppState])

  return null
}

function getActiveCommandcodeModelError(
  model: string | null | undefined,
): string | null {
  if (!model || resolveActiveRouteIdFromEnv(process.env) !== 'commandcode') {
    return null
  }
  return getCommandcodeChatCompletionsModelError(model)
}

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(
    model.toLowerCase().trim(),
  )
}

function isOpus1mUnavailable(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    !checkOpus1mAccess() &&
    !isOpus1mMergeEnabled() &&
    normalized.includes('opus') &&
    normalized.includes('[1m]')
  )
}

function isSonnet1mUnavailable(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    !checkSonnet1mAccess() &&
    (normalized.includes('sonnet[1m]') ||
      normalized.includes('sonnet-4-6[1m]'))
  )
}

function ShowModelAndClose({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const mainLoopModel = useAppState((s: AppState) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(
    (s: AppState) => s.mainLoopModelForSession,
  )
  const effortValue = useAppState((s: AppState) => s.effortValue)
  const displayModel = renderModelLabel(mainLoopModel)
  const activeModel =
    mainLoopModelForSession ?? mainLoopModel ?? getDefaultMainLoopModelSetting()
  const effectiveEffort = resolveAppliedEffort(
    activeModel,
    effortValue,
  )
  const effortEnvOverride = getEffortEnvOverride()
  const effortInfo =
    effectiveEffort !== undefined
      ? ` (effort: ${effectiveEffort})`
      : effortEnvOverride === null
        ? ' (effort: auto)'
        : ''

  if (mainLoopModelForSession) {
    onDone(
      `Current model: ${chalk.bold(renderModelLabel(mainLoopModelForSession))} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`,
    )
  } else {
    onDone(`Current model: ${displayModel}${effortInfo}`)
  }

  return null
}

async function refreshModelsAndSummarize(): Promise<string> {
  const discoveryContext = await loadModelDiscoveryContext()

  if (!discoveryContext) {
    return 'The active provider does not support runtime model discovery refresh.'
  }

  if (!discoveryContext.canRefresh) {
    return isEssentialTrafficOnly()
      ? 'Model discovery refresh is disabled while nonessential traffic is disabled.'
      : `${discoveryContext.routeLabel} uses a static model catalog; no refresh is needed.`
  }

  if (discoveryContext.kind === 'descriptor') {
    const discoveryOptions = await getOpenAIDiscoveryRequestOptions(
      discoveryContext.routeId,
    )
    await clearDiscoveryCache(
      getDiscoveryCacheKey(
        discoveryContext.routeId,
        discoveryOptions,
      ),
    )
    const result = await discoverModelsForRoute(discoveryContext.routeId, {
      ...discoveryOptions,
      forceRefresh: true,
    })
    const nextOptions = mergeActiveProfileModelOptions(
      discoveryContext.routeId,
      buildRouteCatalogModelOptions(
        discoveryContext.routeLabel,
        result?.models ?? [],
        discoveryContext.routeDefaultModel,
      ),
      {
        profileModelSurface: discoveryContext.profileModelSurface,
      },
    )
    const changed = !haveSameModelOptions(
      discoveryContext.optionsOverride,
      nextOptions,
    )

    return descriptorDiscoveryStateForResult({
      changed,
      manual: true,
      result,
      routeLabel: discoveryContext.routeLabel,
    }).message
  }

  try {
    const discoveredOptions = await discoverOpenAICompatibleModelOptions()
    if (discoveredOptions.length === 0) {
      return legacyDiscoveryStateForOptions({
        changed: false,
        failed: true,
        manual: true,
        routeLabel: discoveryContext.routeLabel,
      }).message
    }

    const currentRawOptions = getActiveOpenAIRouteModelOptionsCache()
    const activeProfile = getActiveProviderProfile()
    const profileApplied = Boolean(
      activeProfile &&
        isActiveProfileAppliedToRoute(activeProfile, discoveryContext.routeId),
    )
    const nextOptions = profileApplied
      ? mergeActiveProfileModelOptions(
          discoveryContext.routeId,
          discoveredOptions,
          {
            profileModelSurface: discoveryContext.profileModelSurface,
          },
        )
      : filterModelOptionsByAllowlist([
          getDefaultOptionForUser(),
          ...discoveredOptions,
        ])
    const changed =
      !haveSameModelOptions(
        discoveryContext.optionsOverride ?? currentRawOptions,
        nextOptions,
      )
    const rawChanged =
      !haveSameModelOptions(currentRawOptions, discoveredOptions)

    if (rawChanged) {
      setActiveOpenAIRouteModelOptionsCache(discoveredOptions)
      if (profileApplied) {
        setActiveOpenAIModelOptionsCache(discoveredOptions)
      }
    }

    return legacyDiscoveryStateForOptions({
      changed,
      manual: true,
      routeLabel: discoveryContext.routeLabel,
    }).message
  } catch {
    return legacyDiscoveryStateForOptions({
      changed: false,
      failed: true,
      manual: true,
      routeLabel: discoveryContext.routeLabel,
    }).message
  }
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmedArgs = args?.trim() || ''

  if (COMMON_INFO_ARGS.includes(trimmedArgs)) {
    logEvent('tengu_model_command_inline_help', {
      args: trimmedArgs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <ShowModelAndClose onDone={onDone} />
  }

  if (COMMON_HELP_ARGS.includes(trimmedArgs)) {
    onDone(
      'Run /model to open the model selection menu, /model refresh to reload provider models, or /model [modelName] to set the model.',
      {
        display: 'system',
      },
    )
    return
  }

  if (trimmedArgs === 'refresh') {
    onDone(await refreshModelsAndSummarize(), {
      display: 'system',
    })
    return
  }

  if (trimmedArgs) {
    logEvent('tengu_model_command_inline', {
      args: trimmedArgs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <SetModelAndClose args={trimmedArgs} onDone={onDone} />
  }

  const discoveryContext = await loadModelDiscoveryContext()
  return <ModelPickerWrapper discoveryContext={discoveryContext} onDone={onDone} />
}
