#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const MIN_WARM_RUNS = 20
const DEFAULT_WARM_RUNS = 30
const DEFAULT_COLD_RUNS = 10
const REPO_ROOT = join(import.meta.dirname, '..')
const LAUNCHER_PATH = join(REPO_ROOT, 'bin', 'openclaude')
const BUNDLE_PATH = join(REPO_ROOT, 'dist', 'cli.mjs')
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
).version
const EXPECTED_VERSION_OUTPUT = `${PACKAGE_VERSION} (OpenClaude)`

function readPositiveInteger(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const parsed = Number.parseInt(process.argv[index + 1] ?? '', 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const warmRuns = readPositiveInteger('--warm-runs', DEFAULT_WARM_RUNS)
const coldRuns = readPositiveInteger('--cold-runs', DEFAULT_COLD_RUNS)
if (warmRuns < MIN_WARM_RUNS) {
  throw new Error(`--warm-runs must be at least ${MIN_WARM_RUNS}`)
}
if (typeof nodeModule.enableCompileCache !== 'function') {
  throw new Error(`Node ${process.version} does not expose module.enableCompileCache; the benchmark requires Node >=22.8.0`)
}
if (!existsSync(BUNDLE_PATH) || !statSync(BUNDLE_PATH).isFile()) {
  throw new Error('dist/cli.mjs is missing; run `bun run build` first')
}

const scratch = mkdtempSync(join(tmpdir(), 'openclaude-startup-benchmark-'))

function childEnv(tempRoot, cacheMode) {
  mkdirSync(tempRoot, { recursive: true })
  const env = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    OPENCLAUDE_CONFIG_DIR: join(scratch, 'config'),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
  }
  delete env.NODE_COMPILE_CACHE
  delete env.NODE_DISABLE_COMPILE_CACHE
  delete env.OPENCLAUDE_HEAP_RELAUNCHED
  delete env.OPENCLAUDE_DISABLE_HEAP_RELAUNCH

  if (cacheMode === 'disabled') {
    env.NODE_DISABLE_COMPILE_CACHE = '1'
  } else if (cacheMode === 'environment') {
    env.NODE_COMPILE_CACHE = join(tempRoot, 'node-compile-cache')
  }
  return env
}

function sample(target, tempRoot, cacheMode) {
  const path = target === 'launcher' ? LAUNCHER_PATH : BUNDLE_PATH
  const env = childEnv(tempRoot, cacheMode)
  const started = performance.now()
  const result = spawnSync(process.execPath, [path, '--version'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  const elapsedMs = performance.now() - started
  if (
    result.status !== 0
    || result.stdout.trim() !== EXPECTED_VERSION_OUTPUT
    || result.stderr !== ''
  ) {
    throw new Error(`benchmark command failed: ${JSON.stringify({
      target,
      cacheMode,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    })}`)
  }
  return elapsedMs
}

function percentile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const median = percentile(sorted, 0.5)
  const deviations = sorted
    .map(value => Math.abs(value - median))
    .sort((a, b) => a - b)
  const p25 = percentile(sorted, 0.25)
  const p75 = percentile(sorted, 0.75)
  return {
    samples: sorted.length,
    medianMs: Number(median.toFixed(1)),
    p25Ms: Number(p25.toFixed(1)),
    p75Ms: Number(p75.toFixed(1)),
    iqrMs: Number((p75 - p25).toFixed(1)),
    madMs: Number(percentile(deviations, 0.5).toFixed(1)),
    minMs: Number(sorted[0].toFixed(1)),
    maxMs: Number(sorted.at(-1).toFixed(1)),
  }
}

function measureWarmPair(target, enabledCacheMode, prefix) {
  const enabledRoot = join(scratch, `${prefix}-enabled`)
  const disabledRoot = join(scratch, `${prefix}-disabled`)
  const populationMs = sample(target, enabledRoot, enabledCacheMode)
  const firstWarmupMs = sample(target, enabledRoot, enabledCacheMode)
  const enabled = []
  const disabled = []

  for (let index = 0; index < warmRuns; index++) {
    if (index % 2 === 0) {
      disabled.push(sample(target, disabledRoot, 'disabled'))
      enabled.push(sample(target, enabledRoot, enabledCacheMode))
    } else {
      enabled.push(sample(target, enabledRoot, enabledCacheMode))
      disabled.push(sample(target, disabledRoot, 'disabled'))
    }
  }

  return {
    cachePopulationMs: Number(populationMs.toFixed(1)),
    firstWarmupMs: Number(firstWarmupMs.toFixed(1)),
    disabled: summarize(disabled),
    enabledWarm: summarize(enabled),
  }
}

function measureColdLauncher() {
  const samples = []
  for (let index = 0; index < coldRuns; index++) {
    samples.push(sample('launcher', join(scratch, `launcher-cold-${index}`), 'default'))
  }
  return summarize(samples)
}

function comparison(disabled, enabled) {
  const savedMs = disabled.medianMs - enabled.medianMs
  return {
    savedMs: Number(savedMs.toFixed(1)),
    improvementPercent: Number((savedMs / disabled.medianMs * 100).toFixed(1)),
  }
}

try {
  const launcher = measureWarmPair('launcher', 'default', 'launcher-warm')
  const launcherCold = measureColdLauncher()
  const directBundle = measureWarmPair('bundle', 'environment', 'bundle-warm')
  const gitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  const gitCommit = gitResult.status === 0 && typeof gitResult.stdout === 'string'
    ? gitResult.stdout.trim() || 'unknown'
    : 'unknown'

  console.log(JSON.stringify({
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      bundleBytes: statSync(BUNDLE_PATH).size,
      commit: gitCommit,
    },
    methodology: {
      coldRuns,
      warmRuns,
      separateProcesses: true,
      coldDefinition: 'empty Node compile-cache root; filesystem caches are not flushed',
      launcherEnabledMode: 'zero-argument launcher API with default cache location under isolated temp roots',
      launcherDisabledMode: 'NODE_DISABLE_COMPILE_CACHE=1',
      directBundleRole: 'secondary diagnostic using NODE_COMPILE_CACHE for explicit activation',
      performanceThresholdEnforced: false,
    },
    launcher: {
      compileCacheCold: launcherCold,
      ...launcher,
      comparison: comparison(launcher.disabled, launcher.enabledWarm),
    },
    directBundle: {
      ...directBundle,
      comparison: comparison(directBundle.disabled, directBundle.enabledWarm),
    },
  }, null, 2))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
