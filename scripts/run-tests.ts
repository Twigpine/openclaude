import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const shardOptions = args.filter(arg => arg.startsWith('--shards='))
const shards = shardOptions.length ? Number(shardOptions[0]!.slice('--shards='.length)) : 1
const timeoutOptions = args.filter(arg => arg.startsWith('--shard-timeout-ms='))
const timeoutMs = timeoutOptions.length ? Number(timeoutOptions[0]!.split('=')[1]) : 600_000
if (shardOptions.length > 1 || !Number.isSafeInteger(shards) || shards < 1 ||
    args.some(arg => arg === '--shard' || arg.startsWith('--shard='))) {
  throw new Error('Use one --shards=<positive integer> option; native --shard is not supported.')
}
if (timeoutOptions.length > 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
  throw new Error('Use one --shard-timeout-ms=<positive integer up to 2147483647> option.')
}
const testArgs = args.filter(arg => !arg.startsWith('--shards=') && !arg.startsWith('--shard-timeout-ms='))
// Bun can exit zero without finishing its suite if a test calls process.exit(0).
// Its JUnit report is written only when the runner finishes; require a fresh one.
const reportDir = await mkdtemp(join(tmpdir(), 'openclaude-test-report-'))
let exitCode = 0
let completed = 0
try {
  for (let shard = 1; shard <= shards; shard++) {
    const started = performance.now()
    console.error(`Starting test shard ${shard}/${shards} (deadline ${timeoutMs}ms).`)
    const reportPath = join(reportDir, `results-${shard}.xml`)
    // Bun 1.3.13's isolated globals leak pipe-backed stdio registrations on
    // Linux (oven-sh/bun#37968). Regular files avoid the epoll collision; the
    // parent relays their output without creating another pipe in the shard.
    const outputFiles: { fd: number; destination: number; position: number }[] = []
    let outputTimer: ReturnType<typeof setInterval> | undefined
    /** Relay each new log byte once without blocking shard deadline delivery. */
    const flushOutput = () => {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (const output of outputFiles) {
        const end = fstatSync(output.fd).size
        while (output.position < end) {
          const count = readSync(output.fd, buffer, 0, Math.min(buffer.length, end - output.position), output.position)
          if (count === 0) break
          // Do not block the watchdog when CI's log reader applies backpressure.
          const stream = output.destination === 1 ? process.stdout : process.stderr
          stream.write(Buffer.from(buffer.subarray(0, count)))
          output.position += count
        }
      }
    }
    try {
      if (process.platform === 'linux') {
        for (const destination of [1, 2]) {
          outputFiles.push({ fd: openSync(join(reportDir, `${shard}-${destination}.log`), 'w+'), destination, position: 0 })
        }
      }
      const child = Bun.spawn([
        process.execPath,
        'test',
        '--isolate',
        ...testArgs,
        ...(shards > 1 ? [`--shard=${shard}/${shards}`] : []),
        '--reporter=junit',
        `--reporter-outfile=${reportPath}`,
      ], {
        stdin: 'inherit',
        stdout: outputFiles[0]?.fd ?? 'inherit',
        stderr: outputFiles[1]?.fd ?? 'inherit',
        detached: process.platform !== 'win32',
      })
      // The deadline lives outside Bun's test process: a blocked synchronous test
      // or stuck runtime cleanup must not prevent the watchdog from firing.
      /** Force-stop the isolated shard and its subprocess group. */
      const kill = () => {
        if (process.platform === 'win32') {
          Bun.spawnSync(['taskkill', '/pid', String(child.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', timeout: 5_000 })
          child.kill('SIGKILL')
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
      }
      let timer: ReturnType<typeof setTimeout>
      let interrupted = false
      let stop: (code: number) => void
      const deadline = new Promise<number>(resolve => {
        /** Settle the watchdog after terminating and detaching the shard. */
        stop = code => { interrupted = true; kill(); child.unref(); resolve(code) }
        timer = setTimeout(() => {
          console.error(`Test shard ${shard}/${shards} timed out after ${timeoutMs}ms.`)
          stop(124)
        }, timeoutMs)
      })
      /** Preserve the conventional interrupt exit status after cleanup. */
      const onInterrupt = () => stop(130)
      /** Preserve the conventional termination exit status after cleanup. */
      const onTerminate = () => stop(143)
      /** Fail the run and stop its child if forwarding diagnostics fails. */
      const onOutputError = () => stop(1)
      process.once('SIGINT', onInterrupt)
      process.once('SIGTERM', onTerminate)
      process.stdout.on('error', onOutputError)
      process.stderr.on('error', onOutputError)
      if (outputFiles.length) {
        outputTimer = setInterval(() => {
          try { flushOutput() } catch { onOutputError() }
        }, 100)
      }
      const result = await Promise.race([child.exited, deadline]).finally(() => {
        clearTimeout(timer)
        process.off('SIGINT', onInterrupt)
        process.off('SIGTERM', onTerminate)
        process.stdout.off('error', onOutputError)
        process.stderr.off('error', onOutputError)
      })
      flushOutput()
      console.error(`Finished test shard ${shard}/${shards} in ${((performance.now() - started) / 1000).toFixed(1)}s (exit ${result}).`)
      if (interrupted) {
        exitCode = result
        break
      }
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
    } finally {
      clearInterval(outputTimer)
      try { flushOutput() } finally {
        for (const output of outputFiles) closeSync(output.fd)
      }
    }
  }
  if (shards > 1) console.error(`Completed ${completed}/${shards} test shards.`)
} finally {
  await rm(reportDir, { recursive: true, force: true })
}
process.exitCode = exitCode
