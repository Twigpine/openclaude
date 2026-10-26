/** Verify the completion and failure markers in Bun's final JUnit report. */
export function testReportStatus(report: string): 'incomplete' | 'failed' | 'passed' {
  const summary = report.match(/<testsuites\b[^>]*>/)?.[0]
  if (!summary || !report.trimEnd().endsWith('</testsuites>')) return 'incomplete'
  return !/\bfailures="0"/.test(summary) || /<failure\b|<error\b/.test(report)
    ? 'failed'
    : 'passed'
}
