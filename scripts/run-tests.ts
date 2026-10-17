import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const shardOptions = args.filter(arg => arg.startsWith('--shards='))
const shards = shardOptions.length ? Number(shardOptions[0]!.slice('--shards='.length)) : 1
if (shardOptions.length > 1 || !Number.isSafeInteger(shards) || shards < 1 ||
    args.some(arg => arg === '--shard' || arg.startsWith('--shard='))) {
  throw new Error('Use one --shards=<positive integer> option; native --shard is not supported.')
}
const testArgs = args.filter(arg => !arg.startsWith('--shards='))
// Bun can exit zero without finishing its suite if a test calls process.exit(0).
// Its JUnit report is written only when the runner finishes; require a fresh one.
const reportDir = await mkdtemp(join(tmpdir(), 'openclaude-test-report-'))
let exitCode = 0
let completed = 0
try {
  for (let shard = 1; shard <= shards; shard++) {
    const reportPath = join(reportDir, `results-${shard}.xml`)
    const child = Bun.spawn([
      process.execPath,
      'test',
      '--isolate',
      ...testArgs,
      ...(shards > 1 ? [`--shard=${shard}/${shards}`] : []),
      '--reporter=junit',
      `--reporter-outfile=${reportPath}`,
    ], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    const result = await child.exited
    if (result !== 0 && exitCode === 0) exitCode = result
    const report = await readFile(reportPath, 'utf8').catch(() => '')
    const summary = report.match(/<testsuites\b[^>]*>/)?.[0]
    if (!summary || !report.trimEnd().endsWith('</testsuites>')) {
      console.error('Test runner exited without a complete JUnit report.')
      if (exitCode === 0) exitCode = 1
    } else {
      completed++
      if (!/\bfailures="0"/.test(summary) || /<failure\b|<error\b/.test(report)) {
        if (result === 0) console.error('Test runner reported failures despite exiting successfully.')
        if (exitCode === 0) exitCode = 1
      }
    }
  }
  if (shards > 1) console.error(`Completed ${completed}/${shards} test shards.`)
} finally {
  await rm(reportDir, { recursive: true, force: true })
}
process.exitCode = exitCode
