import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  AnthropicProxyDescriptor,
  BrandDescriptor,
  GatewayDescriptor,
  ModelDescriptor,
  ProviderPresetMetadata,
  VendorDescriptor,
} from './descriptors.js'

type RouteDescriptor =
  | VendorDescriptor
  | GatewayDescriptor
  | AnthropicProxyDescriptor

type RouteModule = {
  kind: 'vendor' | 'gateway' | 'anthropic-proxy'
  descriptor: RouteDescriptor
  importName: string
  importPath: string
}

type BrandModule = {
  descriptor: BrandDescriptor
  importName: string
  importPath: string
}

type ModelModule = {
  descriptors: ModelDescriptor[]
  importName: string
  importPath: string
}

type LoadedIntegrationModules = {
  routeModules: RouteModule[]
  brandModules: BrandModule[]
  modelModules: ModelModule[]
}

type GeneratedArtifact = {
  path: string
  content: string
}

type GenerateIntegrationArtifactsOptions = {
  repoRoot?: string
}

const PRESET_DESCRIPTION_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const INTEGRATIONS_DIR = ['src', 'integrations'] as const
const GENERATED_DIR = [...INTEGRATIONS_DIR, 'generated'] as const
const GENERATED_ARTIFACT_PATH = [...GENERATED_DIR, 'integrationArtifacts.generated.ts'] as const
const GENERATED_MANIFEST_PATH = [...GENERATED_DIR, 'integrationManifest.generated.ts'] as const

const VENDOR_DIR = 'vendors'
const GATEWAY_DIR = 'gateways'
const ANTHROPIC_PROXY_DIR = 'anthropicProxies'
const BRAND_DIR = 'brands'
const MODEL_DIR = 'models'

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

function isDescriptorFile(fileName: string): boolean {
  return (
    fileName.endsWith('.ts') &&
    !fileName.endsWith('.d.ts') &&
    !fileName.endsWith('.test.ts') &&
    !fileName.endsWith('.models.ts') &&
    fileName !== 'index.ts'
  )
}

function toImportIdentifier(prefix: string, fileName: string): string {
  const baseName = fileName.replace(/\.ts$/, '')
  const words = `${prefix}-${baseName}`
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
  const [first = 'descriptor', ...rest] = words

  return [
    first.toLowerCase(),
    ...rest.map(word => word[0]!.toUpperCase() + word.slice(1).toLowerCase()),
  ].join('')
}

async function loadDefaultExport<T>(absolutePath: string): Promise<T> {
  const module = await import(pathToFileURL(absolutePath).href)

  if (!('default' in module)) {
    throw new Error(`Expected default export in ${absolutePath}`)
  }

  return module.default as T
}

async function loadDescriptorModules(
  repoRoot: string,
): Promise<LoadedIntegrationModules> {
  const integrationsRoot = path.join(repoRoot, ...INTEGRATIONS_DIR)
  const routeModules: RouteModule[] = []
  const brandModules: BrandModule[] = []
  const modelModules: ModelModule[] = []

  const routeSpecs = [
    { kind: 'vendor' as const, directory: VENDOR_DIR, prefix: 'vendor' },
    { kind: 'gateway' as const, directory: GATEWAY_DIR, prefix: 'gateway' },
    {
      kind: 'anthropic-proxy' as const,
      directory: ANTHROPIC_PROXY_DIR,
      prefix: 'anthropicProxy',
    },
  ]

  for (const spec of routeSpecs) {
    const directoryPath = path.join(integrationsRoot, spec.directory)
    const entries = await fs.readdir(directoryPath).catch(() => [])
    const files = entries.filter(isDescriptorFile).sort()

    for (const fileName of files) {
      const absolutePath = path.join(directoryPath, fileName)
      const descriptor = await loadDefaultExport<RouteDescriptor>(absolutePath)

      routeModules.push({
        kind: spec.kind,
        descriptor,
        importName: toImportIdentifier(spec.prefix, fileName),
        importPath: `../${spec.directory}/${fileName.replace(/\.ts$/, '.js')}`,
      })
    }
  }

  const brandDirectory = path.join(integrationsRoot, BRAND_DIR)
  const brandFiles = (await fs.readdir(brandDirectory)).filter(isDescriptorFile).sort()
  for (const fileName of brandFiles) {
    const absolutePath = path.join(brandDirectory, fileName)
    brandModules.push({
      descriptor: await loadDefaultExport<BrandDescriptor>(absolutePath),
      importName: toImportIdentifier('brand', fileName),
      importPath: `../${BRAND_DIR}/${fileName.replace(/\.ts$/, '.js')}`,
    })
  }

  const modelDirectory = path.join(integrationsRoot, MODEL_DIR)
  const modelFiles = (await fs.readdir(modelDirectory)).filter(isDescriptorFile).sort()
  for (const fileName of modelFiles) {
    const absolutePath = path.join(modelDirectory, fileName)
    modelModules.push({
      descriptors: await loadDefaultExport<ModelDescriptor[]>(absolutePath),
      importName: toImportIdentifier('model', fileName),
      importPath: `../${MODEL_DIR}/${fileName.replace(/\.ts$/, '.js')}`,
    })
  }

  return { routeModules, brandModules, modelModules }
}

function toGeneratedValue(value: unknown, indent = 0): string {
  const currentIndent = ' '.repeat(indent)
  const nextIndent = ' '.repeat(indent + 2)

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]'
    }

    return `[\n${value
      .map(entry => `${nextIndent}${toGeneratedValue(entry, indent + 2)}`)
      .join(',\n')}\n${currentIndent}]`
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    if (entries.length === 0) {
      return '{}'
    }

    return `{\n${entries
      .map(
        ([key, entry]) =>
          `${nextIndent}${JSON.stringify(key)}: ${toGeneratedValue(entry, indent + 2)}`,
      )
      .join(',\n')}\n${currentIndent}}`
  }

  return JSON.stringify(value)
}

function buildPresetManifestEntry(
  routeModule: RouteModule,
  preset: ProviderPresetMetadata,
): Record<string, unknown> {
  return {
    preset: preset.id,
    routeKind: routeModule.kind,
    routeId: routeModule.descriptor.id,
    vendorId:
      routeModule.kind === 'vendor'
        ? routeModule.descriptor.id
        : preset.vendorId,
    gatewayId:
      routeModule.kind === 'gateway'
        ? routeModule.descriptor.id
        : undefined,
    description: preset.description,
    label: preset.label,
    name: preset.name,
    apiKeyEnvVars: preset.apiKeyEnvVars,
    baseUrlEnvVars: preset.baseUrlEnvVars,
    modelEnvVars: preset.modelEnvVars,
    fallbackBaseUrl: preset.fallbackBaseUrl,
    fallbackModel: preset.fallbackModel,
    badge: preset.badge,
  }
}

function compareProviderPresetEntries(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftPreset = String(left.preset)
  const rightPreset = String(right.preset)

  if (leftPreset === rightPreset) {
    return 0
  }

  // Keep the primary guided providers at the top of setup: Twigpine
  // Opengateway first, aimlapi.com second, then the native Anthropic option.
  if (leftPreset === 'gitlawb-opengateway') {
    return -1
  }
  if (rightPreset === 'gitlawb-opengateway') {
    return 1
  }

  if (leftPreset === 'aimlapi') {
    return -1
  }
  if (rightPreset === 'aimlapi') {
    return 1
  }

  if (leftPreset === 'anthropic') {
    return -1
  }
  if (rightPreset === 'anthropic') {
    return 1
  }

  // Keep the generic custom endpoints together at the end of the picker,
  // with the Anthropic-native option after the OpenAI-compatible one.
  if (leftPreset === 'custom-anthropic') {
    return 1
  }
  if (rightPreset === 'custom-anthropic') {
    return -1
  }

  if (leftPreset === 'custom') return 1
  if (rightPreset === 'custom') return -1

  const descriptionDelta = PRESET_DESCRIPTION_COLLATOR.compare(
    String(left.description),
    String(right.description),
  )
  if (descriptionDelta !== 0) {
    return descriptionDelta
  }

  return PRESET_DESCRIPTION_COLLATOR.compare(leftPreset, rightPreset)
}

function validatePresetMetadata(routeModules: RouteModule[]): void {
  const presetIds = new Map<string, string>()
  const routeIds = new Set(routeModules.map(routeModule => routeModule.descriptor.id))
  const vendorIds = new Set(
    routeModules
      .filter(routeModule => routeModule.kind === 'vendor')
      .map(routeModule => routeModule.descriptor.id),
  )

  for (const routeModule of routeModules) {
    const { descriptor, kind } = routeModule
    const preset = descriptor.preset

    if (!preset) {
      continue
    }

    if (!preset.id.trim()) {
      throw new Error(`Route "${descriptor.id}" opted into presets with an empty preset id.`)
    }
    if (!preset.description.trim()) {
      throw new Error(
        `Route "${descriptor.id}" opted into presets without a preset description.`,
      )
    }

    const duplicateOwner = presetIds.get(preset.id)
    if (duplicateOwner) {
      throw new Error(
        `Duplicate preset id "${preset.id}" defined by routes "${duplicateOwner}" and "${descriptor.id}".`,
      )
    }
    presetIds.set(preset.id, descriptor.id)

    const requiresApiKey =
      descriptor.setup.requiresAuth && descriptor.setup.authMode === 'api-key'
    const effectiveApiKeyEnvVars =
      preset.apiKeyEnvVars ?? descriptor.setup.credentialEnvVars ?? []
    if (requiresApiKey && effectiveApiKeyEnvVars.length === 0) {
      throw new Error(
        `Preset route "${descriptor.id}" requires API-key auth but does not declare any credential env vars.`,
      )
    }

    const hasDefaultBaseUrl =
      'defaultBaseUrl' in descriptor && typeof descriptor.defaultBaseUrl === 'string'
        ? descriptor.defaultBaseUrl.trim().length > 0
        : false
    if (!hasDefaultBaseUrl && !preset.fallbackBaseUrl) {
      throw new Error(
        `Preset route "${descriptor.id}" must provide a defaultBaseUrl or preset.fallbackBaseUrl.`,
      )
    }

    const defaultModelValue =
      'defaultModel' in descriptor ? descriptor.defaultModel : undefined
    const hasCatalogDefaultModel =
      (descriptor.catalog?.models?.find(model => model.default) ??
        descriptor.catalog?.models?.[0]) !== undefined
    const hasDefaultModel =
      typeof defaultModelValue === 'string'
        ? defaultModelValue.trim().length > 0
        : hasCatalogDefaultModel
    if (!hasDefaultModel && !preset.fallbackModel) {
      throw new Error(
        `Preset route "${descriptor.id}" must provide a defaultModel or preset.fallbackModel.`,
      )
    }
    if (
      defaultModelValue !== undefined &&
      descriptor.catalog?.models?.some(model => model.default)
    ) {
      throw new Error(
        `Preset route "${descriptor.id}" must use defaultModel instead of catalog default flags.`,
      )
    }

    if (kind !== 'vendor') {
      if (!preset.vendorId?.trim()) {
        throw new Error(
          `Preset route "${descriptor.id}" must declare preset.vendorId because it is not a direct vendor.`,
        )
      }
      if (!vendorIds.has(preset.vendorId)) {
        throw new Error(
          `Preset route "${descriptor.id}" references missing preset.vendorId "${preset.vendorId}".`,
        )
      }
    }

    if (!routeIds.has(descriptor.id)) {
      throw new Error(`Preset route "${descriptor.id}" is not part of the known route set.`)
    }
  }
}

function renderIntegrationManifest(
  loadedModules: LoadedIntegrationModules,
): string {
  const presetManifest = loadedModules.routeModules
    .filter(routeModule => routeModule.descriptor.preset)
    .map(routeModule => buildPresetManifestEntry(routeModule, routeModule.descriptor.preset!))
    .sort(compareProviderPresetEntries)

  const orderedProviderPresets = presetManifest.map(entry => entry.preset)

  const fileSections = [
    '// This file is auto-generated by scripts/generate-integrations-artifacts.ts.',
    '// Do not edit it by hand; update the descriptor modules and regenerate instead.',
    '//',
    '// Plain-data preset manifest, split from integrationArtifacts.generated.ts so',
    '// manifest consumers (preset lookup, provider UI metadata) do not evaluate the',
    '// full descriptor module graph at startup.',
    '',
    "import type { ProviderPresetManifestEntry } from '../descriptors.js'",
    '',
    `export const PROVIDER_PRESET_MANIFEST = ${toGeneratedValue(presetManifest)} as const satisfies readonly ProviderPresetManifestEntry[]`,
    "export type ProviderPreset = (typeof PROVIDER_PRESET_MANIFEST)[number]['preset']",
    `export const ORDERED_PROVIDER_PRESETS = ${toGeneratedValue(orderedProviderPresets)} as const`,
  ]

  return `${fileSections.join('\n')}\n`
}

function renderIntegrationArtifacts(
  loadedModules: LoadedIntegrationModules,
): string {
  validatePresetMetadata(loadedModules.routeModules)

  const vendorModules = loadedModules.routeModules
    .filter(routeModule => routeModule.kind === 'vendor')
    .sort((left, right) => left.importPath.localeCompare(right.importPath))
  const gatewayModules = loadedModules.routeModules
    .filter(routeModule => routeModule.kind === 'gateway')
    .sort((left, right) => left.importPath.localeCompare(right.importPath))
  const anthropicProxyModules = loadedModules.routeModules
    .filter(routeModule => routeModule.kind === 'anthropic-proxy')
    .sort((left, right) => left.importPath.localeCompare(right.importPath))
  const brandModules = [...loadedModules.brandModules].sort((left, right) =>
    left.importPath.localeCompare(right.importPath),
  )
  const modelModules = [...loadedModules.modelModules].sort((left, right) =>
    left.importPath.localeCompare(right.importPath),
  )

  const importLines = [
    ...vendorModules.map(module => `import ${module.importName} from '${module.importPath}'`),
    ...gatewayModules.map(module => `import ${module.importName} from '${module.importPath}'`),
    ...anthropicProxyModules.map(
      module => `import ${module.importName} from '${module.importPath}'`,
    ),
    ...brandModules.map(module => `import ${module.importName} from '${module.importPath}'`),
    ...modelModules.map(module => `import ${module.importName} from '${module.importPath}'`),
  ]

  const allModelDescriptors = loadedModules.modelModules.flatMap(m => m.descriptors)
  const uniqueKeys = new Set(allModelDescriptors.map(m => `${m.id}::${m.vendorId}`))
  if (allModelDescriptors.length > uniqueKeys.size) {
    throw new Error(
      `Duplicate model (id, vendorId) pairs detected: ${allModelDescriptors.length} entries, ${uniqueKeys.size} unique.`,
    )
  }

  const fileSections = [
    '// This file is auto-generated by scripts/generate-integrations-artifacts.ts.',
    '// Do not edit it by hand; update the descriptor modules and regenerate instead.',
    '//',
    '// Evaluating this module loads every descriptor module. Import it lazily',
    '// (via ensureIntegrationsLoaded) so startup does not pay for the full graph.',
    '',
    "import type { AnthropicProxyDescriptor, BrandDescriptor, GatewayDescriptor, ModelDescriptor, VendorDescriptor } from '../descriptors.js'",
    ...importLines,
    '',
    `export const VENDOR_DESCRIPTORS = [${vendorModules.map(module => module.importName).join(', ')}] as const satisfies readonly VendorDescriptor[]`,
    `export const GATEWAY_DESCRIPTORS = [${gatewayModules.map(module => module.importName).join(', ')}] as const satisfies readonly GatewayDescriptor[]`,
    `export const ANTHROPIC_PROXY_DESCRIPTORS = [${anthropicProxyModules.map(module => module.importName).join(', ')}] as const satisfies readonly AnthropicProxyDescriptor[]`,
    `export const BRAND_DESCRIPTORS = [${brandModules.map(module => module.importName).join(', ')}] as const satisfies readonly BrandDescriptor[]`,
    `export const MODEL_DESCRIPTOR_GROUPS = [${modelModules.map(module => module.importName).join(', ')}] as const satisfies readonly (readonly ModelDescriptor[])[]`,
    'export const MODEL_DESCRIPTORS = MODEL_DESCRIPTOR_GROUPS.flat() satisfies readonly ModelDescriptor[]',
    '',
    "export { PROVIDER_PRESET_MANIFEST, ORDERED_PROVIDER_PRESETS } from './integrationManifest.generated.js'",
    "export type { ProviderPreset } from './integrationManifest.generated.js'",
  ]

  return `${fileSections.join('\n')}\n`
}

export async function generateIntegrationArtifacts(
  options: GenerateIntegrationArtifactsOptions = {},
): Promise<GeneratedArtifact[]> {
  const repoRoot = options.repoRoot ?? path.resolve(path.join(import.meta.dir, '..', '..'))
  const loadedModules = await loadDescriptorModules(repoRoot)

  return [
    {
      path: path.join(repoRoot, ...GENERATED_MANIFEST_PATH),
      content: renderIntegrationManifest(loadedModules),
    },
    {
      path: path.join(repoRoot, ...GENERATED_ARTIFACT_PATH),
      content: renderIntegrationArtifacts(loadedModules),
    },
  ]
}

export async function writeIntegrationArtifacts(
  options: GenerateIntegrationArtifactsOptions = {},
): Promise<GeneratedArtifact[]> {
  const artifacts = await generateIntegrationArtifacts(options)

  await fs.mkdir(path.join(options.repoRoot ?? path.resolve(path.join(import.meta.dir, '..', '..')), ...GENERATED_DIR), {
    recursive: true,
  })

  for (const artifact of artifacts) {
    await fs.writeFile(artifact.path, artifact.content, 'utf8')
  }

  return artifacts
}

export async function generatedIntegrationArtifactsAreCurrent(
  options: GenerateIntegrationArtifactsOptions = {},
): Promise<boolean> {
  const artifacts = await generateIntegrationArtifacts(options)

  for (const artifact of artifacts) {
    const existing = await fs.readFile(artifact.path, 'utf8').catch(() => '')
    if (normalizeLineEndings(existing) !== normalizeLineEndings(artifact.content)) {
      return false
    }
  }

  return true
}
