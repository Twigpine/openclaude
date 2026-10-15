/**
 * artefactParser — implementation.
 *
 * Deep module: hides format detection, adapter registry, streaming, validation,
 * provenance, error recovery behind the ArtefactParser interface.
 */

import type {
  ArtefactParser,
  ArtefactRef,
  ArtefactFormat,
  ParseResult,
  ParseOptions,
  ParseError,
  ParseWarning,
  FormatAdapter,
  AdapterRegistry,
  GenericData,
  FormatDetector,
} from './types.js'

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024 // 50 MB
const PARSER_VERSION = '1.0.0'

// Shared encoder/decoder — avoids re-instantiating on every call
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ============================================================================
// Format detectors (shared, used by registry and custom detectors)
// ============================================================================

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  const pref = encoder.encode(prefix)
  if (bytes.length < pref.length) return false
  for (let i = 0; i < pref.length; i++) {
    if (bytes[i] !== pref[i]) return false
  }
  return true
}

function contains(bytes: Uint8Array, needle: string): boolean {
  const n = encoder.encode(needle)
  if (bytes.length < n.length) return false
  // Use native indexOf on the decoded string for O(n) average case
  const haystack = decoder.decode(bytes)
  const needleStr = decoder.decode(n)
  return haystack.includes(needleStr)
}

export const detectors = {
  junitXml(bytes: Uint8Array): ArtefactFormat | null {
    // More strict: must have both opening and closing testsuite/testsuites tags
    const text = new TextDecoder().decode(bytes.slice(0, 4096))
    return text.trimStart().startsWith('<?xml')
      && (text.includes('<testsuite') || text.includes('<testsuites'))
      && (text.includes('</testsuite>') || text.includes('</testsuites>'))
      ? 'junit-xml'
      : null
  },

  tap(bytes: Uint8Array): ArtefactFormat | null {
    const text = new TextDecoder().decode(bytes.slice(0, 1024))
    return text.match(/^TAP version \d+/m) ? 'tap' : null
  },

  dockerImage(bytes: Uint8Array): ArtefactFormat | null {
    return contains(bytes, 'manifest.json') && contains(bytes, 'Config') ? 'docker-image' : null
  },

  ociManifest(bytes: Uint8Array): ArtefactFormat | null {
    try {
      const text = new TextDecoder().decode(bytes)
      const obj = JSON.parse(text)
      return obj.schemaVersion === 2 && obj.mediaType?.startsWith('application/vnd.oci') ? 'oci-manifest' : null
    } catch {
      return null
    }
  },

  helmChart(bytes: Uint8Array): ArtefactFormat | null {
    return contains(bytes, 'Chart.yaml') && contains(bytes, 'apiVersion:') ? 'helm-chart' : null
  },

  kubernetesManifest(bytes: Uint8Array): ArtefactFormat | null {
    try {
      const text = decoder.decode(bytes)
      if (text.trim().startsWith('{')) {
        const obj = JSON.parse(text)
        if (!obj || typeof obj !== 'object') return null
        return (obj as Record<string, unknown>).apiVersion && (obj as Record<string, unknown>).kind ? 'kubernetes-manifest' : null
      }
      return text.includes('apiVersion:') && text.includes('kind:') ? 'kubernetes-manifest' : null
    } catch {
      return null
    }
  },

  spdx(bytes: Uint8Array): ArtefactFormat | null {
    try {
      const text = new TextDecoder().decode(bytes)
      const obj = JSON.parse(text)
      return obj.spdxVersion && obj.spdxId ? 'sbom-spdx' : null
    } catch {
      return null
    }
  },

  cyclonedx(bytes: Uint8Array): ArtefactFormat | null {
    try {
      const text = new TextDecoder().decode(bytes)
      const obj = JSON.parse(text)
      return obj.bomFormat === 'CycloneDX' && obj.specVersion ? 'sbom-cyclonedx' : null
    } catch {
      return null
    }
  },

  cosign(bytes: Uint8Array): ArtefactFormat | null {
    try {
      const text = new TextDecoder().decode(bytes)
      const obj = JSON.parse(text)
      return obj.payloadType && obj.payload && Array.isArray(obj.signatures) ? 'cosign-attestation' : null
    } catch {
      return null
    }
  },
} as const

// Type for detector map (format -> detector fn)
type DetectorMap = ReadonlyMap<ArtefactFormat, (bytes: Uint8Array) => boolean>

// ============================================================================
// Adapter registry (internal) — singleton shared across all parser instances
// ============================================================================

class AdapterRegistryImpl implements AdapterRegistry {
  private adapters = new Map<ArtefactFormat, FormatAdapter>()
  private mediaTypeIndex = new Map<string, FormatAdapter>()
  private extensionIndex = new Map<string, FormatAdapter>()
  private detectors: DetectorMap | null = null

  setDetectors(detectors: DetectorMap): void {
    this.detectors = detectors
  }

  hasDetectors(): boolean {
    return this.detectors !== null
  }

  register(adapter: FormatAdapter): void {
    this.adapters.set(adapter.format, adapter)
    for (const mt of adapter.mediaTypes) {
      this.mediaTypeIndex.set(mt.toLowerCase(), adapter)
    }
    for (const ext of adapter.extensions) {
      this.extensionIndex.set(ext.toLowerCase(), adapter)
    }
  }

  unregister(format: ArtefactFormat): void {
    const adapter = this.adapters.get(format)
    if (!adapter) return
    for (const mt of adapter.mediaTypes) this.mediaTypeIndex.delete(mt.toLowerCase())
    for (const ext of adapter.extensions) this.extensionIndex.delete(ext.toLowerCase())
    this.adapters.delete(format)
  }

  get(format: ArtefactFormat): FormatAdapter | undefined {
    return this.adapters.get(format)
  }

  getForBytes(bytes: Uint8Array): FormatAdapter | undefined {
    // Use shared detectors if available (more reliable than adapter.canParse)
    if (this.detectors) {
      for (const format of Array.from(this.detectors.keys())) {
        const detect = this.detectors.get(format)
        if (detect && detect(bytes)) {
          const adapter = this.adapters.get(format)
          if (adapter) return adapter
        }
      }
    }
    // Fallback to adapter.canParse
    for (const adapter of Array.from(this.adapters.values())) {
      if (adapter.canParse(bytes)) return adapter
    }
    return undefined
  }

  allFormats(): readonly ArtefactFormat[] {
    return Array.from(this.adapters.keys())
  }

  getByMediaType(mediaType: string): FormatAdapter | undefined {
    return this.mediaTypeIndex.get(mediaType.toLowerCase())
  }

  getByExtension(ext: string): FormatAdapter | undefined {
    return this.extensionIndex.get(ext.toLowerCase())
  }
}

// Singleton registry shared by all parser instances
const sharedRegistry = new AdapterRegistryImpl()

// ============================================================================
// Main parser implementation
// ============================================================================

export class ArtefactParserImpl implements ArtefactParser {
  private registry: AdapterRegistryImpl
  private customDetectors: FormatDetector[]

  constructor(options?: { detectors?: FormatDetector[] }) {
    this.registry = sharedRegistry
    this.customDetectors = options?.detectors ?? []
    // Initialize shared detectors once
    if (!sharedRegistry.hasDetectors()) {
      const detectorMap = new Map<ArtefactFormat, (bytes: Uint8Array) => boolean>()
      for (const [key, fn] of Object.entries(detectors)) {
        // Wrap detector to return boolean
        detectorMap.set(key as ArtefactFormat, (bytes: Uint8Array) => fn(bytes) !== null)
      }
      sharedRegistry.setDetectors(detectorMap)
    }
    // Adapters register themselves on import (see index.ts)
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  async parse<T = unknown>(ref: ArtefactRef, options?: ParseOptions): Promise<ParseResult<T>> {
    const bytes = await this.loadBytes(ref)
    return this.parseBytes<T>(bytes, { ...options, sourceHint: ref.source })
  }

  async parseBytes<T = unknown>(bytes: Uint8Array, options?: ParseOptions): Promise<ParseResult<T>> {
    const startedAt = new Date().toISOString()
    const source = options?.sourceHint ?? '<memory>'

    // Size check
    const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE
    if (bytes.length > maxSize) {
      throw this.makeError('CORRUPT_INPUT', `Input exceeds max size (${maxSize} bytes)`, source)
    }

    // Format detection
    const format = this.detectFormat(bytes)
    if (!format) {
      throw this.makeError('UNSUPPORTED_FORMAT', 'No parser found for input', source)
    }

    // Get adapter
    const adapter = this.registry.get(format)
    if (!adapter) {
      throw this.makeError('UNSUPPORTED_FORMAT', `No adapter registered for ${format}`, source)
    }

    // Parse
    let parseResult: { data: unknown; warnings: ParseWarning[] }
    try {
      parseResult = await adapter.parse(bytes, { validate: options?.validate ?? true })
    } catch (err) {
      if (err instanceof Error && err.name === 'ParseError') throw err
      throw this.makeError('CORRUPT_INPUT', `Parsing failed: ${err}`, source, err as Error)
    }

    // Optional validation
    const warnings = [...parseResult.warnings]
    if (options?.validate && adapter.validate) {
      warnings.push(...adapter.validate(parseResult.data as T))
    }

    return {
      data: parseResult.data as T,
      format,
      warnings,
      provenance: {
        source,
        parsedAt: startedAt,
        parserVersion: PARSER_VERSION,
      },
    }
  }

  detectFormat(bytes: Uint8Array): ArtefactFormat | null {
    // Custom detectors first
    for (const detector of this.customDetectors) {
      const fmt = detector(bytes)
      if (fmt) return fmt
    }
    // Then registry detectors
    const adapter = this.registry.getForBytes(bytes)
    return adapter?.format ?? null
  }

  supportedFormats(): readonly ArtefactFormat[] {
    return this.registry.allFormats()
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async loadBytes(ref: ArtefactRef): Promise<Uint8Array> {
    if (ref.source.startsWith('http://') || ref.source.startsWith('https://')) {
      return this.fetchRemote(ref.source, ref.auth)
    }
    // Local file
    const { readFile } = await import('node:fs/promises')
    return readFile(ref.source)
  }

  private async fetchRemote(url: string, auth?: ArtefactRef['auth']): Promise<Uint8Array> {
    const headers: Record<string, string> = {}
    if (auth) {
      if (auth.type === 'bearer') headers.Authorization = `Bearer ${auth.credentials}`
      else if (auth.type === 'basic') headers.Authorization = `Basic ${auth.credentials}`
    }
    const res = await fetch(url, { headers })
    if (!res.ok) {
      throw this.makeError('AUTH_FAILED', `HTTP ${res.status}: ${res.statusText}`, url)
    }
    const arrayBuffer = await res.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  }

  private makeError(
    code: ParseError['code'],
    message: string,
    source: string,
    cause?: Error
  ): ParseError {
    const err = new Error(message) as ParseError & Error
    err.name = 'ParseError'
    err.code = code
    err.message = message
    err.source = source
    err.cause = cause
    return err
  }

  // ---------------------------------------------------------------------------
  // Adapter registration (for adapters to call on import)
  // ---------------------------------------------------------------------------

  /** Register a format adapter. Called by adapter modules on import. */
  registerAdapter(adapter: FormatAdapter): void {
    this.registry.register(adapter)
  }
}

// ============================================================================
// Singleton instance (for convenience, not required)
// ============================================================================

let defaultParser: ArtefactParserImpl | null = null

export function getDefaultParser(): ArtefactParser {
  if (!defaultParser) defaultParser = new ArtefactParserImpl()
  return defaultParser
}

export function createParser(options?: { detectors?: FormatDetector[] }): ArtefactParser {
  return new ArtefactParserImpl(options)
}