/**
 * Report how a just-published npm version actually went out: whether it
 * carries a provenance attestation, and whether npm authenticated the publish
 * through trusted publishing (OIDC).
 *
 * Releases are meant to be tokenless and verifiable. The registry is the only
 * place that records whether a given version really was, so the release
 * workflow reads it back and puts the answer in the run summary.
 *
 * Usage: bun scripts/npm-publish-report.ts <package> <version>
 * Prints markdown bullets. Never fails the job: the publish is already done
 * and cannot be taken back.
 */

type PublishedVersionDoc = {
  _npmUser?: { trustedPublisher?: unknown }
  dist?: { attestations?: { provenance?: unknown } }
}

export type PublishReport = {
  lines: string[]
  hasProvenance: boolean
}

export function buildPublishReport(
  packageName: string,
  version: string,
  doc: PublishedVersionDoc,
): PublishReport {
  const hasProvenance = Boolean(doc.dist?.attestations?.provenance)
  const viaTrustedPublisher = Boolean(doc._npmUser?.trustedPublisher)
  return {
    hasProvenance,
    lines: [
      `- \`${packageName}@${version}\` provenance: ${hasProvenance ? 'yes' : 'MISSING'}`,
      `- \`${packageName}@${version}\` npm auth: ${viaTrustedPublisher ? 'trusted publisher (OIDC, no token)' : 'NOT a trusted publisher'}`,
    ],
  }
}

async function main(): Promise<void> {
  const [packageName, version] = process.argv.slice(2)
  if (!packageName || !version) {
    console.error('Usage: npm-publish-report.ts <package> <version>')
    process.exit(1)
  }

  try {
    const response = await fetch(
      `https://registry.npmjs.org/${packageName}/${version}`,
    )
    if (!response.ok) {
      console.log(`- \`${packageName}@${version}\` publish report unavailable (registry returned ${response.status})`)
      return
    }
    const report = buildPublishReport(
      packageName,
      version,
      (await response.json()) as PublishedVersionDoc,
    )
    for (const line of report.lines) console.log(line)
    if (!report.hasProvenance) {
      // GitHub Actions annotation; harmless noise anywhere else.
      console.log(`::warning::${packageName}@${version} was published without a provenance attestation`)
    }
  } catch (error) {
    console.log(`- \`${packageName}@${version}\` publish report unavailable (${error instanceof Error ? error.message : String(error)})`)
  }
}

if (import.meta.main) {
  await main()
}
