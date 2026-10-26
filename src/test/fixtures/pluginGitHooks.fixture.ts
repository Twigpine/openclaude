// Run only in a disposable process: real Git operations must not inherit module mocks.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock } from 'bun:test'

const root = process.argv[2]!
const scenario = process.argv[3]!
const upstream = join(root, 'upstream')
const dependency = join(root, 'dependency')
const target = join(root, 'target')
const marker = join(root, 'hook-ran')
const hooks = join(root, 'hooks')
mkdirSync(hooks)
for (const name of ['post-checkout', 'post-merge']) {
  writeFileSync(join(hooks, name), '#!/bin/sh\nprintf "hook ran\\n" >> "$PLUGIN_HOOK_MARKER"\n', { mode: 0o755 })
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
  })
  assert.equal(result.exitCode, 0, result.stderr.toString())
  return result.stdout.toString().trim()
}
function commit(cwd: string, message: string): void {
  git(cwd, 'add', '.')
  git(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message)
}
for (const repo of [upstream, dependency]) {
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
}
writeFileSync(join(dependency, 'value.txt'), 'dependency v1')
commit(dependency, 'first dependency')
mkdirSync(join(upstream, 'selected'))
mkdirSync(join(upstream, 'omitted'))
writeFileSync(join(upstream, 'selected', 'value.txt'), 'selected v1')
writeFileSync(join(upstream, 'omitted', 'value.txt'), 'omitted')
git(upstream, '-c', 'core.hooksPath=/dev/null', 'submodule', 'add', pathToFileURL(dependency).href, 'dependency')
commit(upstream, 'first marketplace')

// Positive control: the configured hook really runs during an ordinary checkout.
git(root, 'clone', pathToFileURL(upstream).href, join(root, 'control'))
assert.equal(readFileSync(marker, 'utf8'), 'hook ran\n')
rmSync(marker)

// Observe every production invocation while retaining the actual executor/Git.
const executor = { ...await import('../../utils/execFileNoThrow.js') }
const calls: string[][] = []
mock.module('../../utils/execFileNoThrow.js', () => ({
  ...executor,
  execFileNoThrowWithCwd: (...args: Parameters<typeof executor.execFileNoThrowWithCwd>) => {
    calls.push([...args[1]])
    return executor.execFileNoThrowWithCwd(...args)
  },
}))
const { gitClone, gitPull } = await import('../../utils/plugins/marketplaceManager.js')
const sparse = scenario === 'sparse' ? ['selected'] : undefined
const cloned = await gitClone(pathToFileURL(upstream).href, target, 'main', sparse)
assert.equal(cloned.code, 0, cloned.stderr)
assert.equal(readFileSync(join(target, 'selected', 'value.txt'), 'utf8'), 'selected v1')
assert.equal(existsSync(join(target, 'omitted', 'value.txt')), !sparse)
assert.equal(git(target, 'rev-parse', '--is-shallow-repository'), 'true')
assert.equal(existsSync(marker), false, 'plugin clone ran a configured hook')
if (!sparse) assert.equal(readFileSync(join(target, 'dependency', 'value.txt'), 'utf8'), 'dependency v1')

if (scenario.startsWith('pull')) {
  writeFileSync(join(dependency, 'value.txt'), 'dependency v2')
  commit(dependency, 'update dependency')
  git(join(upstream, 'dependency'), '-c', 'core.hooksPath=/dev/null', 'pull', '--ff-only')
  writeFileSync(join(upstream, 'selected', 'value.txt'), 'selected v2')
  commit(upstream, 'update marketplace')
  const pulled = await gitPull(target, scenario === 'pull-ref' ? 'main' : undefined)
  assert.equal(pulled.code, 0, pulled.stderr)
  assert.equal(readFileSync(join(target, 'selected', 'value.txt'), 'utf8'), 'selected v2')
  assert.equal(readFileSync(join(target, 'dependency', 'value.txt'), 'utf8'), 'dependency v2')
  assert.equal(existsSync(marker), false, 'plugin pull or submodule update ran a configured hook')
  assert(calls.some(args => args.includes('submodule') && args.includes('update')))
}
assert.equal(calls.length, scenario === 'normal' ? 1 : scenario === 'pull-ref' ? 5 : 3)
for (const args of calls) {
  assert(args.some((arg, i) => arg === '-c' && args[i + 1] === 'core.hooksPath=/dev/null'), JSON.stringify(args))
}
console.log(`verified ${scenario}: content, hooks, and ${calls.length} Git invocations`)
