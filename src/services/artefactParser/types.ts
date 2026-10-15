/**
 * artefactParser — deep module for parsing build/test/deployment artefacts.
 *
 * A small interface hiding format-specific parsing complexity.
 * Callers get structured data without knowing the artefact format.
 */

// ============================================================================
// Public types (the interface surface)
// ============================================================================

/** Generic artefact identifier — what the caller knows about the input. */
export type ArtefactRef = {
  /** Local path, HTTP URL, or content-addressable reference. */
  source: string
  /** Optional hint to avoid format detection. */
  format?: ArtefactFormat
  /** Optional authentication for remote sources. */
  auth?: { type: 'bearer' | 'basic'; credentials: string }
}

/** Supported artefact formats. Extensible without breaking callers. */
export type ArtefactFormat =
  | 'junit-xml'
  | 'tap'
  | 'docker-image'
  | 'oci-manifest'
  | 'helm-chart'
  | 'kubernetes-manifest'
  | 'sbom-spdx'
  | 'sbom-cyclonedx'
  | 'conftest-policy'
  | 'cosign-attestation'
  | 'generic-json'
  | 'generic-yaml'

/** Result of parsing — always structured, never throws for expected formats. */
export type ParseResult<T = unknown> = {
  /** The parsed, validated data model. Shape depends on format. */
  data: T
  /** Format that was actually used (after detection). */
  format: ArtefactFormat
  /** Non-fatal issues encountered during parsing. */
  warnings: ParseWarning[]
  /** Provenance for reproducibility. */
  provenance: {
    source: string
    parsedAt: string
    parserVersion: string
  }
}

/** Non-fatal parsing issue. */
export type ParseWarning = {
  code: string
  message: string
  location?: { line: number; column: number }
}

/** Error when parsing fundamentally fails. */
export type ParseError = {
  code: 'UNSUPPORTED_FORMAT' | 'CORRUPT_INPUT' | 'SCHEMA_VIOLATION' | 'IO_ERROR' | 'AUTH_FAILED'
  message: string
  cause?: Error
  source: string
}

/** Options controlling parsing behaviour. */
export type ParseOptions = {
  /** Skip schema validation (faster, less safe). */
  validate?: boolean
  /** Maximum input size in bytes (default: 50MB). */
  maxSize?: number
  /** Custom format detectors to try first. */
  detectors?: FormatDetector[]
  /** Human-readable source label recorded in provenance (e.g. file path or URL). */
  sourceHint?: string
}

/** Format detection function — returns format or null if not matched. */
export type FormatDetector = (input: Uint8Array) => ArtefactFormat | null

// ============================================================================
// Format-specific data models (what parsers return in ParseResult.data)
// ============================================================================

/** JUnit / xUnit test results. */
export type JUnitReport = {
  testSuites: JUnitTestSuite[]
  totals: { tests: number; failures: number; errors: number; skipped: number; time: number }
}

export type JUnitTestSuite = {
  name: string
  tests: number
  failures: number
  errors: number
  skipped: number
  time: number
  testCases: JUnitTestCase[]
  properties?: Record<string, string>
}

export type JUnitTestCase = {
  name: string
  className?: string
  time: number
  status: 'passed' | 'failed' | 'error' | 'skipped'
  failure?: { message: string; type: string; content: string }
  systemOut?: string
  systemErr?: string
}

/** TAP (Test Anything Protocol) output. */
export type TapReport = {
  version: number
  tests: TapTest[]
  totals: { passed: number; failed: number; skipped: number; todo: number }
}

export type TapTest = {
  number: number
  ok: boolean
  name: string
  directive?: { type: 'skip' | 'todo'; reason: string }
  diagnostics?: TapDiagnostic[]
}

export type TapDiagnostic = {
  severity: 'error' | 'warning' | 'info'
  data: string
}

/** Docker / OCI image manifest. */
export type ImageManifest = {
  schemaVersion: 2
  mediaType: string
  config: ImageDescriptor
  layers: ImageDescriptor[]
  annotations?: Record<string, string>
}

export type ImageDescriptor = {
  mediaType: string
  size: number
  digest: string
  urls?: string[]
  annotations?: Record<string, string>
}

/** Helm chart metadata. */
export type HelmChart = {
  metadata: HelmMetadata
  values: Record<string, unknown>
  files: HelmFile[]
}

export type HelmMetadata = {
  name: string
  version: string
  appVersion?: string
  description?: string
  keywords?: string[]
  maintainers?: { name: string; email?: string; url?: string }[]
  sources?: string[]
  dependencies?: HelmDependency[]
}

export type HelmDependency = {
  name: string
  version: string
  repository?: string
  condition?: string
  tags?: string[]
  importValues?: string[]
  alias?: string
}

export type HelmFile = {
  path: string
  content: Uint8Array
}

/** Kubernetes manifest (generic). */
export type K8sManifest = {
  apiVersion: string
  kind: string
  metadata: K8sMetadata
  spec?: Record<string, unknown>
  items?: K8sManifest[] // for List types
}

export type K8sMetadata = {
  name: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  uid?: string
  resourceVersion?: string
  generation?: number
}

/** SBOM (Software Bill of Materials) — SPDX. */
export type SpdxDocument = {
  spdxVersion: string
  dataLicense: string
  spdxId: string
  name: string
  documentNamespace: string
  creationInfo: SpdxCreationInfo
  packages: SpdxPackage[]
  relationships: SpdxRelationship[]
}

export type SpdxCreationInfo = {
  created: string
  creators: string[]
  licenseListVersion?: string
}

export type SpdxPackage = {
  spdxId: string
  name: string
  version?: string
  downloadLocation: string
  filesAnalyzed: boolean
  licenseConcluded: string
  licenseDeclared: string
  copyrightText?: string
  externalRefs?: SpdxExternalRef[]
}

export type SpdxExternalRef = {
  referenceCategory: 'PACKAGE_MANAGER' | 'SECURITY' | 'OTHER'
  referenceType: string
  locator: string
}

export type SpdxRelationship = {
  spdxElementId: string
  relationshipType: 'DESCRIBES' | 'DEPENDS_ON' | 'CONTAINS' | 'DEPENDENCY_OF'
  relatedSpdxElement: string
}

/** SBOM — CycloneDX. */
export type CycloneDxBom = {
  bomFormat: 'CycloneDX'
  specVersion: string
  serialNumber: string
  version: number
  metadata: CycloneDxMetadata
  components?: CycloneDxComponent[]
  dependencies?: CycloneDxDependency[]
  services?: CycloneDxService[]
}

export type CycloneDxMetadata = {
  timestamp: string
  tools?: { name: string; version: string }[]
  component?: CycloneDxComponent
}

export type CycloneDxComponent = {
  type: 'library' | 'application' | 'framework' | 'container' | 'operating-system' | 'device' | 'firmware' | 'file'
  name: string
  version?: string
  purl?: string
  hashes?: { algorithm: string; value: string }[]
  licenses?: { license: { id: string } }[]
  externalReferences?: { type: string; url: string }[]
}

export type CycloneDxDependency = {
  ref: string
  dependsOn: string[]
}

export type CycloneDxService = {
  name: string
  version?: string
  description?: string
  endpoints?: string[]
  authenticated?: boolean
  xTrustBoundary?: boolean
  data?: { classification: string }[]
}

/** Conftest / OPA policy evaluation result. */
export type PolicyResult = {
  results: PolicyCheck[]
  summary: { pass: number; fail: number; warn: number; error: number }
}

export type PolicyCheck = {
  namespace: string
  rule: string
  message: string
  status: 'pass' | 'fail' | 'warn' | 'error'
  resource?: { apiVersion: string; kind: string; name: string; namespace?: string }
}

/** Cosign / Sigstore attestation. */
export type CosignAttestation = {
  payloadType: string
  payload: Uint8Array
  signatures: CosignSignature[]
  certificates?: CosignCertificate[]
}

export type CosignSignature = {
  sig: string
  keyId?: string
}

export type CosignCertificate = {
  cert: string
  chain?: string[]
}

/** Generic JSON/YAML — caller handles schema. */
export type GenericData = Record<string, unknown> | unknown[]

// ============================================================================
// The parser interface (what callers depend on)
// ============================================================================

/**
 * Core parser interface — small, stable, testable.
 *
 * Depth comes from: format detection, streaming parsing, schema validation,
 * error recovery, provenance tracking, all hidden behind this surface.
 */
export interface ArtefactParser {
  /**
   * Parse an artefact from a readable source.
   *
   * @param ref - Artefact reference (path, URL, or content ref)
   * @param options - Parsing options (validation, size limits, custom detectors)
   * @returns Structured result with data, format, warnings, provenance
   * @throws ParseError only for fundamental failures (IO, auth, corrupt)
   */
  parse<T = unknown>(ref: ArtefactRef, options?: ParseOptions): Promise<ParseResult<T>>

  /**
   * Parse from in-memory bytes (for already-loaded content).
   */
  parseBytes<T = unknown>(bytes: Uint8Array, options?: ParseOptions): Promise<ParseResult<T>>

  /**
   * Detect format without fully parsing.
   * Returns null if no detector matches.
   */
  detectFormat(bytes: Uint8Array): ArtefactFormat | null

  /**
   * List all supported formats.
   */
  supportedFormats(): readonly ArtefactFormat[]

  /**
   * Register a format adapter (for extension at startup).
   */
  registerAdapter(adapter: FormatAdapter): void
}

// ============================================================================
// Adapter interface (for format-specific implementations)
// ============================================================================

/**
 * Format-specific parser adapter.
 * One adapter per format — the seam where variation lives.
 */
export interface FormatAdapter<T = unknown> {
  /** The format this adapter handles. */
  readonly format: ArtefactFormat

  /** Media types / file extensions this adapter claims. */
  readonly mediaTypes: readonly string[]

  /** File extensions this adapter claims (without dot). */
  readonly extensions: readonly string[]

  /**
   * Quick detection — should be fast, no full parse.
   * Return true if this adapter can handle the input.
   */
  canParse(bytes: Uint8Array): boolean

  /**
   * Full parse — return structured data model.
   * Throw for unrecoverable errors; warnings go in result.
   */
  parse(bytes: Uint8Array, options: ParseOptions): Promise<{ data: T; warnings: ParseWarning[] }>

  /** Optional: validate already-parsed data. */
  validate?(data: T): ParseWarning[]
}

// ============================================================================
// Factory / registry (internal — not part of caller interface)
// ============================================================================

/**
 * Internal registry for adapters.
 * Not exported to callers — they only see ArtefactParser.
 */
export interface AdapterRegistry {
  register(adapter: FormatAdapter): void
  unregister(format: ArtefactFormat): void
  get(format: ArtefactFormat): FormatAdapter | undefined
  getForBytes(bytes: Uint8Array): FormatAdapter | undefined
  allFormats(): readonly ArtefactFormat[]
}