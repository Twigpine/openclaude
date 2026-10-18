// src/integrations/index.ts
// Single loader entrypoint for descriptor modules.
// Runtime and tests must import this file before reading registry state.
//
// The generated descriptor catalog (~10k lines across 60+ modules) is NOT
// evaluated at import time. ensureIntegrationsLoaded() requires it on demand,
// and registry getters trigger it automatically via setRegistryLazyLoader, so
// startup paths that never read the registry skip the entire graph.

import type { AnthropicProxyDescriptor } from './descriptors.js'
import type { ProviderPreset } from './generated/integrationManifest.generated.js'
import {
  setRegistryLazyLoader,
  getAllAnthropicProxies,
  getAllBrands,
  getAllGateways,
  getAllModels,
  getAllVendors,
  getAnthropicProxy,
  getBrand,
  getBrandsForVendor,
  filterAvailableCatalogEntries,
  getCatalogEntriesForRoute,
  getCatalogForGateway,
  getCatalogForVendor,
  getGateway,
  getModel,
  getModelsForBrand,
  getModelsForGateway,
  getModelsForVendor,
  getVendor,
  registerAnthropicProxy,
  registerBrand,
  registerGateway,
  registerModel,
  registerVendor,
  validateIntegrationRegistry,
  _clearRegistryForTesting,
} from './registry.js'

let _loadingIntegrations = false

export function ensureIntegrationsLoaded(): void {
  // Reentrancy guard: the registration loops below read the registry, and a
  // read can fire the lazy-loader hook back into this function when it was
  // invoked explicitly while the hook was still armed.
  if (_loadingIntegrations) {
    return
  }
  _loadingIntegrations = true
  try {
    loadIntegrationArtifacts()
  } finally {
    _loadingIntegrations = false
  }
}

function loadIntegrationArtifacts(): void {
  // Lazy require so the descriptor graph is only evaluated on first use.
  // Bundled and unbundled runtimes both defer module init until this call
  // (same pattern as the lazy requires in main.tsx).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const artifacts =
    require('./generated/integrationArtifacts.generated.js') as typeof import('./generated/integrationArtifacts.generated.js')

  for (const vendor of artifacts.VENDOR_DESCRIPTORS) {
    if (!getVendor(vendor.id)) {
      registerVendor(vendor)
    }
  }

  for (const gateway of artifacts.GATEWAY_DESCRIPTORS) {
    if (!getGateway(gateway.id)) {
      registerGateway(gateway)
    }
  }

  for (const anthropicProxy of artifacts.ANTHROPIC_PROXY_DESCRIPTORS as readonly AnthropicProxyDescriptor[]) {
    if (!getAnthropicProxy(anthropicProxy.id)) {
      registerAnthropicProxy(anthropicProxy)
    }
  }

  for (const brand of artifacts.BRAND_DESCRIPTORS) {
    if (!getBrand(brand.id)) {
      registerBrand(brand)
    }
  }

  for (const modelGroup of artifacts.MODEL_DESCRIPTOR_GROUPS) {
    for (const model of modelGroup) {
      if (!getModel(model.id)) {
        registerModel(model)
      }
    }
  }
}

// Cheap side effect replacing the old eager ensureIntegrationsLoaded() call:
// the first registry read loads the catalog on demand.
setRegistryLazyLoader(ensureIntegrationsLoaded)

export {
  registerBrand,
  registerVendor,
  registerGateway,
  registerAnthropicProxy,
  registerModel,
  getBrand,
  getVendor,
  getGateway,
  getAnthropicProxy,
  getModel,
  getAllBrands,
  getAllVendors,
  getAllGateways,
  getAllAnthropicProxies,
  getAllModels,
  getCatalogForGateway,
  getCatalogForVendor,
  filterAvailableCatalogEntries,
  getCatalogEntriesForRoute,
  getModelsForBrand,
  getModelsForGateway,
  getModelsForVendor,
  getBrandsForVendor,
  validateIntegrationRegistry,
  _clearRegistryForTesting,
}

export { routeForPreset, vendorIdForPreset, gatewayIdForPreset } from './compatibility.js'
export { resolveProfileRoute } from './profileResolver.js'
export type { ResolvedProfileRoute } from './profileResolver.js'
export type { ProviderPreset }
export { PROVIDER_PRESET_MANIFEST } from './generated/integrationManifest.generated.js'
export {
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getRouteDescriptor,
  getRouteLabel,
  getRouteProviderTypeLabel,
  getTransportKindForRoute,
  isCloudflareBaseUrl,
  isLongcatBaseUrl,
  normalizeXiaomiMimoBaseUrl,
  resolveActiveRouteIdFromEnv,
  resolveRouteCredentialValue,
  resolveRouteIdFromBaseUrl,
  routeSupportsApiFormatSelection,
  routeSupportsAuthHeaders,
  routeSupportsCustomHeaders,
  routeShowsAuthHeader,
  routeShowsAuthHeaderValue,
  routeShowsCustomHeaders,
} from './routeMetadata.js'
export {
  getProviderPresetUiMetadata,
  ORDERED_PROVIDER_PRESETS,
} from './providerUiMetadata.js'
