// src/utils/visionUtils.ts
// Vision capability detection for the active model.
//
// `supportsVision` is declared on every model descriptor but currently has no
// runtime consumer. This module is the single source of truth for "can this
// model see images?" queries. Mirrors the `isPDFSupported()` pattern in
// `pdfUtils.ts` so existing call sites stay uniform.

import {
  ensureIntegrationsLoaded,
  getAllGateways,
  getAllModels,
  getAllVendors,
  getCatalogEntriesForRoute,
  getModel,
  resolveRouteIdFromBaseUrl,
} from '../integrations/index.js'
import { getMainLoopModel } from './model/model.js'

export const VISION_NOT_SUPPORTED_ERROR_CODE = 10

// Common image extensions — kept here (rather than reading from FileReadTool)
// so the gate is testable in isolation, without depending on the FileReadTool
// module getting mocked by other tests (e.g. `compact.test.ts`).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

function normalizedName(value: string): string {
  return value.trim().toLowerCase()
}

function hasModelNamePrefix(modelApiName: string, registeredName: string): boolean {
  const trimmedName = registeredName.trim()
  if (!trimmedName) return false
  if (!modelApiName.startsWith(trimmedName)) return false

  const next = modelApiName[trimmedName.length]
  return next === undefined || next === ':' || next === '/' || next === '@'
}

function isCatalogScopedRuntimeDescriptor(
  descriptor: ReturnType<typeof getModel> | undefined,
): boolean {
  return descriptor?.runtimeMetadataScope === 'catalog'
}

function findModelDescriptorFromCatalog(
  modelApiName: string,
  routeId?: string,
) {
  const normalized = normalizedName(modelApiName)
  const includeAliases = routeId !== undefined
  const routeIds =
    routeId !== undefined
      ? [routeId]
      : [
          ...new Set([
            ...getAllGateways().map(route => route.id),
            ...getAllVendors().map(route => route.id),
          ]),
        ]

  for (const routeId of routeIds) {
    const entry = getCatalogEntriesForRoute(routeId).find(candidate => {
      return (
        normalizedName(candidate.apiName) === normalized ||
        normalizedName(candidate.id) === normalized ||
        (includeAliases &&
          (candidate.aliases ?? []).some(alias => normalizedName(alias) === normalized))
      )
    })
    if (entry?.modelDescriptorId) {
      const descriptor = getModel(entry.modelDescriptorId)
      if (descriptor) return descriptor
    }
  }

  return undefined
}

/**
 * Find the model descriptor for a given API name, matching across
 * `id`, `defaultModel`, and any `providerModelMap` entries.
 *
 * Returns undefined when the model isn't in the registry — callers should
 * treat unknown models as vision-capable (fail-open) so custom / non-registered
 * providers don't regress. The post-flight error surface
 * (`vision_not_supported` in `openaiErrorClassification.ts`) handles the case
 * where an unknown model still rejects image-bearing requests.
 */
export function findModelDescriptorForApiName(modelApiName: string | undefined) {
  return findModelDescriptorForApiNameWithRoute(modelApiName)
}

export function findModelDescriptorForApiNameWithRoute(
  modelApiName: string | undefined,
  routeId?: string,
) {
  const trimmed = modelApiName?.trim()
  if (!trimmed) return undefined

  ensureIntegrationsLoaded()

  if (routeId !== undefined) {
    const routeCatalogDescriptor = findModelDescriptorFromCatalog(trimmed, routeId)
    if (routeCatalogDescriptor) return routeCatalogDescriptor
  }

  const direct = getModel(trimmed)
  if (direct && !isCatalogScopedRuntimeDescriptor(direct)) return direct

  const catalogDescriptor = findModelDescriptorFromCatalog(trimmed)
  if (
    catalogDescriptor &&
    !isCatalogScopedRuntimeDescriptor(catalogDescriptor)
  ) {
    return catalogDescriptor
  }

  const normalized = normalizedName(trimmed)
  const models = getAllModels()

  const candidates = models
    .filter(model => !isCatalogScopedRuntimeDescriptor(model))
    .map(model => ({
      model,
      names: [
        model.id,
        model.defaultModel,
        ...Object.values(model.providerModelMap ?? {}),
      ].filter((value): value is string => Boolean(value?.trim())),
    }))
    .sort((left, right) => {
      const leftLongest = Math.max(
        ...left.names.map(name => name.length),
        0,
      )
      const rightLongest = Math.max(
        ...right.names.map(name => name.length),
        0,
      )
      return rightLongest - leftLongest
    })

  for (const candidate of candidates) {
    if (candidate.names.some(name => trimmed === name.trim())) {
      return candidate.model
    }
  }
  for (const candidate of candidates) {
    if (candidate.names.some(name => hasModelNamePrefix(trimmed, name))) {
      return candidate.model
    }
  }
  for (const candidate of candidates) {
    if (
      candidate.names.some(name => {
        const lowered = normalizedName(name)
        return normalized === lowered || hasModelNamePrefix(normalized, lowered)
      })
    ) {
      return candidate.model
    }
  }
  return undefined
}

/**
 * Returns true when the given (or currently-active) model is registered as
 * supporting image/vision inputs. Returns true (fail-open) for unknown models
 * so providers outside the registry continue to receive images until they
 * reject them — at which point the post-flight error classifier surfaces an
 * actionable `vision_not_supported` message instead of the raw API error.
 */
export function isVisionSupported(
  model?: string,
  options?: { routeId?: string; baseUrl?: string },
): boolean {
  const target = model ?? getMainLoopModel()
  const routeId =
    options?.routeId ?? resolveRouteIdFromBaseUrl(options?.baseUrl) ?? undefined
  const descriptor = findModelDescriptorForApiNameWithRoute(target, routeId)
  if (!descriptor) return true
  return descriptor.capabilities?.supportsVision === true
}

/**
 * Pre-flight vision check for a file read. Returns a refusal when the file
 * is an image and the active model is registered as not supporting vision
 * inputs (e.g. Xiaomi Mimo V2.5 Pro / Flash, Llama, Mistral). Returns null
 * when the file is non-image OR the model supports vision OR the model is
 * unknown (fail-open).
 *
 * Extracted into `visionUtils.ts` (rather than living inside `FileReadTool`)
 * so it can be unit-tested without depending on the FileReadTool module —
 * which is mocked by other test files (e.g. `compact.test.ts`) and would
 * otherwise leave this gate un-tested in the full suite (issue #1421).
 */
export function checkVisionCapabilityForFile(
  filePath: string,
  mainLoopModel: string,
  options?: { routeId?: string; baseUrl?: string },
):
  | { result: false; message: string; errorCode: number }
  | { result: true } {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.') + 1)
  if (!IMAGE_EXTENSIONS.has(ext)) return { result: true }
  if (isVisionSupported(mainLoopModel, options)) return { result: true }
  return {
    result: false,
    message: `The active model (${mainLoopModel}) does not support image inputs. To analyze this file, use a text-based tool (e.g. the Bash tool with \`file\`, \`identify\`, or an OCR command), or run /model to switch to a vision-capable model.`,
    errorCode: VISION_NOT_SUPPORTED_ERROR_CODE,
  }
}
