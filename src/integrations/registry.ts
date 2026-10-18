// src/integrations/registry.ts
// Registry implementation: stores descriptors, provides lookup, and validates integrity.

import type {
  AnthropicProxyDescriptor,
  BrandDescriptor,
  GatewayDescriptor,
  ModelCatalogEntry,
  ModelDescriptor,
  RegistryValidationResult,
  VendorDescriptor,
} from './descriptors.js'

const _brands = new Map<string, BrandDescriptor>()
const _vendors = new Map<string, VendorDescriptor>()
const _gateways = new Map<string, GatewayDescriptor>()
const _anthropicProxies = new Map<string, AnthropicProxyDescriptor>()
const _models = new Map<string, ModelDescriptor>()

// ---------------------------------------------------------------------------
// Lazy loading
// ---------------------------------------------------------------------------
// The descriptor catalog (~10k lines of generated vendor/gateway/model data)
// is expensive to evaluate, so index.ts registers a loader here instead of
// populating the registry at import time. The first read-side call runs it;
// register* intentionally does NOT (the loader itself registers, and test
// fixtures must be able to register into an empty registry).

let _lazyLoader: (() => void) | null = null
let _lazyLoaderRunning = false

export function setRegistryLazyLoader(loader: () => void): void {
  _lazyLoader = loader
}

function ensureLoaded(): void {
  // Re-entrancy guard: the loader registers descriptors, and registration can
  // itself reach a read getter; skip while it's running so we don't recurse.
  if (!_lazyLoader || _lazyLoaderRunning) {
    return
  }
  const loader = _lazyLoader
  _lazyLoaderRunning = true
  try {
    loader()
    // Clear only after the loader succeeds, so a failed lazy import or
    // descriptor registration retries on the next read instead of leaving the
    // registry permanently empty/partial.
    _lazyLoader = null
  } finally {
    _lazyLoaderRunning = false
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBrand(d: BrandDescriptor): void {
  if (_brands.has(d.id)) {
    throw new Error(`Duplicate brand id: ${d.id}`)
  }
  _brands.set(d.id, d)
}

export function registerVendor(d: VendorDescriptor): void {
  if (_vendors.has(d.id)) {
    throw new Error(`Duplicate vendor id: ${d.id}`)
  }
  _vendors.set(d.id, d)
}

export function registerGateway(d: GatewayDescriptor): void {
  if (_gateways.has(d.id)) {
    throw new Error(`Duplicate gateway id: ${d.id}`)
  }
  _gateways.set(d.id, d)
}

export function registerAnthropicProxy(d: AnthropicProxyDescriptor): void {
  if (_anthropicProxies.has(d.id)) {
    throw new Error(`Duplicate anthropic proxy id: ${d.id}`)
  }
  _anthropicProxies.set(d.id, d)
}

export function registerModel(d: ModelDescriptor): void {
  if (_models.has(d.id)) {
    throw new Error(`Duplicate model id: ${d.id}`)
  }
  _models.set(d.id, d)
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getBrand(id: string): BrandDescriptor | undefined {
  ensureLoaded()
  return _brands.get(id)
}

export function getVendor(id: string): VendorDescriptor | undefined {
  ensureLoaded()
  return _vendors.get(id)
}

export function getGateway(id: string): GatewayDescriptor | undefined {
  ensureLoaded()
  return _gateways.get(id)
}

export function getAnthropicProxy(id: string): AnthropicProxyDescriptor | undefined {
  ensureLoaded()
  return _anthropicProxies.get(id)
}

export function getModel(id: string): ModelDescriptor | undefined {
  ensureLoaded()
  return _models.get(id)
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export function getAllBrands(): BrandDescriptor[] {
  ensureLoaded()
  return Array.from(_brands.values())
}

export function getAllVendors(): VendorDescriptor[] {
  ensureLoaded()
  return Array.from(_vendors.values())
}

export function getAllGateways(): GatewayDescriptor[] {
  ensureLoaded()
  return Array.from(_gateways.values())
}

export function getAllAnthropicProxies(): AnthropicProxyDescriptor[] {
  ensureLoaded()
  return Array.from(_anthropicProxies.values())
}

export function getAllModels(): ModelDescriptor[] {
  ensureLoaded()
  return Array.from(_models.values())
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

export function getCatalogForGateway(gatewayId: string): import('./descriptors.js').ModelCatalogConfig | undefined {
  ensureLoaded()
  return _gateways.get(gatewayId)?.catalog
}

export function getCatalogForVendor(vendorId: string): import('./descriptors.js').ModelCatalogConfig | undefined {
  ensureLoaded()
  return _vendors.get(vendorId)?.catalog
}

/**
 * True when a catalog entry should currently be exposed: not `hidden`, and
 * not past its `availableUntil` expiry. An unparseable `availableUntil`
 * fails open so a typo can't silently drop a model.
 */
function catalogEntryAvailable(entry: ModelCatalogEntry, now: Date): boolean {
  if (entry.hidden) return false
  if (entry.availableUntil !== undefined) {
    const cutoff = Date.parse(entry.availableUntil)
    if (Number.isFinite(cutoff) && now.getTime() >= cutoff) return false
  }
  return true
}

/**
 * Drop `hidden` and expired (`availableUntil`) entries. Every surface that
 * turns catalog entries into something selectable — route resolution here,
 * the /model picker's static path, and static+discovery merges — must pass
 * through this filter, or an expired entry resurfaces on that surface.
 */
export function filterAvailableCatalogEntries(
  entries: ModelCatalogEntry[],
  now: Date = new Date(),
): ModelCatalogEntry[] {
  return entries.filter(entry => catalogEntryAvailable(entry, now))
}

export function getCatalogEntriesForRoute(
  routeId: string,
  now: Date = new Date(),
): ModelCatalogEntry[] {
  ensureLoaded()
  const gateway = _gateways.get(routeId)
  const models =
    gateway?.catalog?.models ?? _vendors.get(routeId)?.catalog?.models
  if (!models) return []
  return filterAvailableCatalogEntries(models, now)
}

export function getModelsForBrand(brandId: string): ModelDescriptor[] {
  ensureLoaded()
  return getAllModels().filter(m => m.brandId === brandId)
}

export function getModelsForGateway(gatewayId: string): ModelDescriptor[] {
  ensureLoaded()
  const entries = getCatalogEntriesForRoute(gatewayId)
  return entries
    .map(e => {
      if (e.modelDescriptorId) {
        return getModel(e.modelDescriptorId)
      }
      return undefined
    })
    .filter((m): m is ModelDescriptor => m !== undefined)
}

export function getModelsForVendor(vendorId: string): ModelDescriptor[] {
  ensureLoaded()
  const entries = getCatalogEntriesForRoute(vendorId)
  return entries
    .map(e => {
      if (e.modelDescriptorId) {
        return getModel(e.modelDescriptorId)
      }
      return undefined
    })
    .filter((m): m is ModelDescriptor => m !== undefined)
}

export function getBrandsForVendor(vendorId: string): BrandDescriptor[] {
  ensureLoaded()
  return getAllBrands().filter(b => b.canonicalVendorId === vendorId)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateIntegrationRegistry(): RegistryValidationResult {
  ensureLoaded()
  const errors: string[] = []
  const warnings: string[] = []
  const allVendors = getAllVendors()
  const allGateways = getAllGateways()
  const allAnthropicProxies = getAllAnthropicProxies()
  const allRoutes: Array<
    VendorDescriptor | GatewayDescriptor | AnthropicProxyDescriptor
  > = [...allVendors, ...allGateways, ...allAnthropicProxies]

  // Helper: check duplicates within a map
  function checkDuplicates<T extends { id: string }>(
    items: T[],
    kind: string,
  ): void {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.id)) {
        errors.push(`Duplicate ${kind} id: ${item.id}`)
      }
      seen.add(item.id)
    }
  }

  checkDuplicates(getAllBrands(), 'brand')
  checkDuplicates(allVendors, 'vendor')
  checkDuplicates(allGateways, 'gateway')
  checkDuplicates(allAnthropicProxies, 'anthropic-proxy')
  checkDuplicates(getAllModels(), 'model')

  const presetOwners = new Map<string, string>()
  const vendorIds = new Set(allVendors.map(vendor => vendor.id))

  for (const route of allRoutes) {
    const preset = route.preset
    if (!preset) {
      continue
    }

    const presetId = preset.id.trim()
    if (!presetId) {
      errors.push(`Route "${route.id}" opted into presets with an empty preset id`)
      continue
    }

    const existingOwner = presetOwners.get(presetId)
    if (existingOwner) {
      errors.push(
        `Duplicate preset id "${presetId}" defined by routes "${existingOwner}" and "${route.id}"`,
      )
    } else {
      presetOwners.set(presetId, route.id)
    }

    if (!preset.description.trim()) {
      errors.push(
        `Route "${route.id}" opted into presets without a preset description`,
      )
    }

    const effectiveApiKeyEnvVars =
      preset.apiKeyEnvVars ?? route.setup.credentialEnvVars ?? []
    if (
      route.setup.requiresAuth &&
      route.setup.authMode === 'api-key' &&
      effectiveApiKeyEnvVars.length === 0
    ) {
      errors.push(
        `Preset route "${route.id}" requires API-key auth but does not declare any credential env vars`,
      )
    }

    const hasDefaultBaseUrl =
      'defaultBaseUrl' in route &&
      typeof route.defaultBaseUrl === 'string' &&
      route.defaultBaseUrl.trim().length > 0
    if (!hasDefaultBaseUrl && !preset.fallbackBaseUrl) {
      errors.push(
        `Preset route "${route.id}" must provide a defaultBaseUrl or preset.fallbackBaseUrl`,
      )
    }

    const defaultModelValue =
      'defaultModel' in route ? route.defaultModel : undefined
    const hasCatalogDefaultModel =
      (route.catalog?.models?.find(model => model.default) ??
        route.catalog?.models?.[0]) !== undefined
    const hasDefaultModel =
      typeof defaultModelValue === 'string'
        ? defaultModelValue.trim().length > 0
        : hasCatalogDefaultModel
    if (!hasDefaultModel && !preset.fallbackModel) {
      errors.push(
        `Preset route "${route.id}" must provide a defaultModel or preset.fallbackModel`,
      )
    }

    if (!vendorIds.has(route.id)) {
      if (!preset.vendorId?.trim()) {
        errors.push(
          `Preset route "${route.id}" must declare preset.vendorId because it is not a direct vendor`,
        )
      } else if (!vendorIds.has(preset.vendorId)) {
        errors.push(
          `Preset route "${route.id}" references missing preset.vendorId "${preset.vendorId}"`,
        )
      }
    }
  }

  // Validate catalog entries on gateways and vendors
  const routes: Array<{ id: string; catalog?: import('./descriptors.js').ModelCatalogConfig }> = [
    ...allGateways.map(g => ({ id: g.id, catalog: g.catalog })),
    ...allVendors.map(v => ({ id: v.id, catalog: v.catalog })),
  ]

  for (const route of routes) {
    if (!route.catalog) continue

    const catalog = route.catalog
    const entryIds = new Set<string>()
    let defaultCount = 0
    const routeDescriptor = _gateways.get(route.id) ?? _vendors.get(route.id)
    const explicitDefaultModel =
      routeDescriptor &&
      'defaultModel' in routeDescriptor &&
      routeDescriptor.defaultModel !== undefined

    for (const entry of catalog.models ?? []) {
      // Duplicate entry ids within route
      if (entryIds.has(entry.id)) {
        errors.push(`Duplicate catalog entry id "${entry.id}" in route "${route.id}"`)
      }
      entryIds.add(entry.id)

      // modelDescriptorId must point to existing shared model
      if (entry.modelDescriptorId && !_models.has(entry.modelDescriptorId)) {
        errors.push(
          `Catalog entry "${entry.id}" in route "${route.id}" references missing model descriptor "${entry.modelDescriptorId}"`,
        )
      }

      // Count defaults
      if (entry.default) {
        defaultCount++
        if (explicitDefaultModel) {
          errors.push(
            `Catalog entry "${entry.id}" in route "${route.id}" must not set default because the route defines defaultModel`,
          )
        }
      }
    }

    // Static catalog must have models or be explicitly empty
    if (catalog.source === 'static' && (catalog.models?.length ?? 0) === 0) {
      // Allow explicitly empty only if there's a discovery config or explicit marker
      // For now, warn if truly empty with no discovery
      if (!catalog.discovery) {
        warnings.push(`Static catalog for route "${route.id}" has no models and no discovery config`)
      }
    }

    if (catalog.source === 'dynamic' && (catalog.models?.length ?? 0) > 0) {
      errors.push(
        `Dynamic catalog for route "${route.id}" must use source "hybrid" when declaring curated models`,
      )
    }

    // Multiple defaults check
    if (defaultCount > 1) {
      warnings.push(`Route "${route.id}" has ${defaultCount} default catalog entries`)
    }

    // Unsupported transport/config combinations
    if (routeDescriptor?.transportConfig.kind !== 'openai-compatible') {
      for (const entry of catalog.models ?? []) {
        if (entry.transportOverrides?.openaiShim) {
          errors.push(
            `Catalog entry "${entry.id}" in route "${route.id}" has openaiShim overrides but route transport is "${routeDescriptor?.transportConfig.kind}"`,
          )
        }
      }
    }
  }

  // Validate usage metadata delegates
  for (const gateway of allGateways) {
    if (gateway.usage?.delegateToVendorId && !_vendors.has(gateway.usage.delegateToVendorId)) {
      errors.push(
        `Gateway "${gateway.id}" delegates usage to missing vendor "${gateway.usage.delegateToVendorId}"`,
      )
    }
    if (gateway.usage?.delegateToGatewayId && !_gateways.has(gateway.usage.delegateToGatewayId)) {
      errors.push(
        `Gateway "${gateway.id}" delegates usage to missing gateway "${gateway.usage.delegateToGatewayId}"`,
      )
    }
  }

  for (const vendor of allVendors) {
    if (vendor.usage?.delegateToVendorId && !_vendors.has(vendor.usage.delegateToVendorId)) {
      errors.push(
        `Vendor "${vendor.id}" delegates usage to missing vendor "${vendor.usage.delegateToVendorId}"`,
      )
    }
    if (vendor.usage?.delegateToGatewayId && !_gateways.has(vendor.usage.delegateToGatewayId)) {
      errors.push(
        `Vendor "${vendor.id}" delegates usage to missing gateway "${vendor.usage.delegateToGatewayId}"`,
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Test helpers (clear registry state between tests)
// ---------------------------------------------------------------------------

export function _clearRegistryForTesting(): void {
  // Also drop the lazy loader: after an explicit clear, tests expect reads to
  // see only fixtures they register (call ensureIntegrationsLoaded() to reload
  // the real catalog).
  _lazyLoader = null
  _lazyLoaderRunning = false
  _brands.clear()
  _vendors.clear()
  _gateways.clear()
  _anthropicProxies.clear()
  _models.clear()
}
