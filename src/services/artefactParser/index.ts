/**
 * artefactParser — public entry point.
 *
 * Deep module interface:
 * - Callers import { createParser, type ArtefactParser, type ParseResult, ... } from './artefactParser'
 * - Implementation details (adapters, registry, detectors) are internal
 * - Adding a new format = add one adapter file, import it here
 */

// Import adapters FIRST to trigger auto-registration on the shared registry
import './adapters/junit.js'

export {
  // Core interface
  type ArtefactParser,
  type ArtefactRef,
  type ArtefactFormat,
  type ParseResult,
  type ParseOptions,
  type ParseError,
  type ParseWarning,
  type FormatDetector,

  // Format-specific data models
  type JUnitReport,
  type JUnitTestSuite,
  type JUnitTestCase,
  type TapReport,
  type TapTest,
  type TapDiagnostic,
  type ImageManifest,
  type ImageDescriptor,
  type HelmChart,
  type HelmMetadata,
  type HelmDependency,
  type HelmFile,
  type K8sManifest,
  type K8sMetadata,
  type SpdxDocument,
  type SpdxCreationInfo,
  type SpdxPackage,
  type SpdxExternalRef,
  type SpdxRelationship,
  type CycloneDxBom,
  type CycloneDxMetadata,
  type CycloneDxComponent,
  type CycloneDxDependency,
  type CycloneDxService,
  type PolicyResult,
  type PolicyCheck,
  type CosignAttestation,
  type CosignSignature,
  type CosignCertificate,
  type GenericData,

  // Adapter interface (for extension, not typical callers)
  type FormatAdapter,
  type AdapterRegistry,
} from './types.js'

export {
  // Factory functions
  createParser,
  getDefaultParser,

  // Detectors (for custom detection logic)
  detectors,
} from './parser.js'

// TODO: Add more adapters as needed:
// import './adapters/tap.js'
// import './adapters/oci.js'
// import './adapters/helm.js'
// import './adapters/k8s.js'
// import './adapters/spdx.js'
// import './adapters/cyclonedx.js'
// import './adapters/cosign.js'