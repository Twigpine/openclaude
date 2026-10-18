/**
 * Validates that all package.json dependencies are accounted for
 * in the external lists or explicitly marked as intentionally bundled.
 *
 * Run as part of the build to catch missing externals early.
 */
import { readFileSync } from 'fs'
import { CLI_EXTERNALS, SDK_EXTERNALS, SDK_ONLY_EXTERNALS, INTENTIONALLY_BUNDLED, OPTIONAL_RUNTIME_EXTERNALS, RUNTIME_INDIRECTION_ONLY_EXTERNALS, TRANSITIVE_OPTIONAL_EXTERNALS } from './externals.js'
import {
  bundledExemptionFor,
  validateBundleExternals,
  validateInstallHygieneFields,
  validateIntentionallyBundled,
  validateOptionalPeers,
  validateOptionalRuntimeExternals,
  validateRuntimeDependencyContract,
} from './externalsValidation.js'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

// Runtime deps: shipped to users and resolved from node_modules at runtime.
// These must each be a genuine external (the bundle inlines everything else).
const runtimeDeps = new Set<string>([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
])
const peerDepNames = new Set(Object.keys(pkg.peerDependencies ?? {}))

// The bundled allowlist is scoped PER bundle. The CLI inlines every
// INTENTIONALLY_BUNDLED package. In the SDK the optional peers (react,
// @anthropic-ai/sdk, ...) are EXTERNAL — keyed on package.json's
// peerDependencies (an independent source of truth) so dropping one of them
// from SDK_EXTERNALS fails validation instead of silently passing.
const CLI_BUNDLED_EXEMPTION = bundledExemptionFor(INTENTIONALLY_BUNDLED, new Set())
const SDK_BUNDLED_EXEMPTION = bundledExemptionFor(INTENTIONALLY_BUNDLED, peerDepNames)

function report(result: { ok: boolean; errors: string[] }): boolean {
  for (const err of result.errors) console.error(`❌ ${err}`)
  return result.ok
}

const cliOk = report(
  validateBundleExternals('CLI bundle', runtimeDeps, CLI_EXTERNALS, CLI_BUNDLED_EXEMPTION),
)
const sdkOk = report(
  validateBundleExternals('SDK bundle', runtimeDeps, SDK_EXTERNALS, SDK_BUNDLED_EXEMPTION),
)
const intentionallyBundledOk = report(
  validateIntentionallyBundled(pkg, INTENTIONALLY_BUNDLED, SDK_ONLY_EXTERNALS),
)
const optionalPeersOk = report(validateOptionalPeers(pkg))
const optionalExternalsOk = report(
  validateOptionalRuntimeExternals(
    OPTIONAL_RUNTIME_EXTERNALS,
    CLI_EXTERNALS,
    SDK_EXTERNALS,
    RUNTIME_INDIRECTION_ONLY_EXTERNALS,
    pkg,
    TRANSITIVE_OPTIONAL_EXTERNALS,
  ),
)

// Surface external entries not declared in package.json (informational only).
for (const [name, externals] of [
  ['CLI bundle', CLI_EXTERNALS],
  ['SDK bundle', SDK_EXTERNALS],
] as const) {
  const optionalSet = new Set(OPTIONAL_RUNTIME_EXTERNALS)
  const extra = externals.filter(d => !runtimeDeps.has(d) && !optionalSet.has(d))
  if (extra.length > 0) {
    console.warn(`⚠️  ${name}: External entries not in package.json (may be ok): ${extra.join(', ')}`)
  }
}

const depContractOk = report(validateRuntimeDependencyContract(pkg))
const installHygieneOk = report(validateInstallHygieneFields(pkg))

const allOk =
  cliOk &&
  sdkOk &&
  intentionallyBundledOk &&
  optionalPeersOk &&
  optionalExternalsOk &&
  depContractOk &&
  installHygieneOk

if (allOk) {
  console.log(
    `✓ CLI/SDK externals + ${INTENTIONALLY_BUNDLED.length} bundled packages valid (devDependencies-only; SDK peers external & optional; optional externals never bundled).`,
  )
} else {
  console.error(`\n❌ External list validation failed. Fix scripts/externals.ts before committing.`)
  process.exit(1)
}

console.log('\n✓ All external lists valid.')

// ============================================================================
// Validate sdk.d.ts ↔ index.ts export drift
// ============================================================================

const SDK_DTS_PATH = 'src/entrypoints/sdk.d.ts'
const SDK_INDEX_PATH = 'src/entrypoints/sdk/index.ts'

function extractExportNames(filePath: string): Set<string> {
  const content = readFileSync(filePath, 'utf8')
  const names = new Set<string>()
  // Match: export { name1, name2 } / export type { name1 } / export class/function/interface/const/type Name
  for (const match of content.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim().split(/\s+as\s+/)[0].trim()
      if (trimmed) names.add(trimmed)
    }
  }
  for (const match of content.matchAll(
    /export\s+(?:type\s+)?(?:class|function|interface|const|type)\s+(\w+)/g,
  )) {
    names.add(match[1])
  }
  return names
}

const dtsExports = extractExportNames(SDK_DTS_PATH)
const indexExports = extractExportNames(SDK_INDEX_PATH)

const inDtsNotIndex = [...dtsExports].filter(n => !indexExports.has(n))
const inIndexNotDts = [...indexExports].filter(n => !dtsExports.has(n))

if (inDtsNotIndex.length > 0 || inIndexNotDts.length > 0) {
  console.error(`\n❌ SDK type declaration drift detected:`)
  if (inDtsNotIndex.length > 0) {
    console.error(`   In sdk.d.ts but not in index.ts:`)
    for (const name of inDtsNotIndex) console.error(`     - ${name}`)
  }
  if (inIndexNotDts.length > 0) {
    console.error(`   In index.ts but not in sdk.d.ts:`)
    for (const name of inIndexNotDts) console.error(`     - ${name}`)
  }
  console.error(`\n   Keep sdk.d.ts in sync with src/entrypoints/sdk/index.ts.`)
  process.exit(1)
}

console.log(`✓ SDK type declarations in sync (${dtsExports.size} exports match).`)
