import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanProjectConventions } from './conventions.js'
import { initializeWiki } from './init.js'
import { getWikiPaths } from './paths.js'
import { scanAndSaveConventions, forceScanConventions } from './conventions.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

async function makeProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-conventions-'))
  tempDirs.push(dir)
  return dir
}

test('scanProjectConventions detects package.json conventions', async () => {
  const cwd = await makeProjectDir()
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      scripts: { test: 'bun test', build: 'bun run build.ts' },
      devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' },
    }),
    'utf8',
  )
  await writeFile(
    join(cwd, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        strict: true,
        jsx: 'react-jsx',
      },
    }),
    'utf8',
  )

  const result = await scanProjectConventions(cwd)

  expect(result.markdown).toContain('test-project')
  expect(result.markdown).toContain('Package Manager')
  expect(result.markdown).toContain('TypeScript Config')
  expect(result.markdown).toContain('ES2023')
  expect(result.markdown).toContain('vitest')
  expect(result.markdown).toContain('ESNext')
  expect(result.identity.name).toBe('test-project')
  expect(result.fingerprint).toHaveLength(16)
})

test('scanProjectConventions handles project with no config files', async () => {
  const cwd = await makeProjectDir()
  const result = await scanProjectConventions(cwd)

  // Should still return a markdown with the directory name
  expect(result.markdown).toBeTruthy()
  expect(result.sections).toHaveLength(0)
  expect(result.identity.name).toBeTruthy()
})

test('scanProjectConventions detects ESLint config', async () => {
  const cwd = await makeProjectDir()
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'lint-project',
    }),
    'utf8',
  )
  await writeFile(
    join(cwd, '.eslintrc.json'),
    JSON.stringify({
      extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
      plugins: ['@typescript-eslint'],
    }),
    'utf8',
  )

  const result = await scanProjectConventions(cwd)
  expect(result.markdown).toContain('ESLint Config')
})

test('scanAndSaveConventions creates conventions page in wiki', async () => {
  const cwd = await makeProjectDir()
  await initializeWiki(cwd)
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'wiki-project',
      scripts: { test: 'bun test' },
    }),
    'utf8',
  )

  const result = await scanAndSaveConventions(cwd)
  expect(result).not.toBeNull()
  expect(result!.markdown).toContain('wiki-project')
  expect(result!.fingerprint).toHaveLength(16)

  // Verify it was written to the wiki
  const paths = getWikiPaths(cwd)
  const wikiContent = await Bun.file(paths.conventionsFile).text()
  expect(wikiContent).toContain('wiki-project')
})

test('scanAndSaveConventions returns null on no change', async () => {
  const cwd = await makeProjectDir()
  await initializeWiki(cwd)
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'no-change',
      scripts: { test: 'bun test' },
    }),
    'utf8',
  )

  const first = await scanAndSaveConventions(cwd)
  expect(first).not.toBeNull()

  const second = await scanAndSaveConventions(cwd)
  expect(second).toBeNull()
})

test('forceScanConventions always returns result', async () => {
  const cwd = await makeProjectDir()
  await initializeWiki(cwd)
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'force-scan' }),
    'utf8',
  )

  const first = await forceScanConventions(cwd)
  expect(first).not.toBeNull()

  const second = await forceScanConventions(cwd)
  expect(second).not.toBeNull()
  expect(second.fingerprint).toBe(first.fingerprint)
})

// PR #1010 review fix #2: fingerprint must cover identity, not just config
// sections, or an identity-only change leaves conventions.md stale.
test('scanAndSaveConventions re-saves when only identity changes', async () => {
  const cwd = await makeProjectDir()
  await initializeWiki(cwd)
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'id-change', scripts: { test: 'bun test' } }),
    'utf8',
  )

  const first = await scanAndSaveConventions(cwd)
  expect(first).not.toBeNull()

  // Identity-only change: a new source file shifts the language counts, but no
  // scanned config section changes. The cache must still invalidate.
  await writeFile(join(cwd, 'main.py'), 'print(1)\n', 'utf8')

  const second = await scanAndSaveConventions(cwd)
  expect(second).not.toBeNull()
  expect(second!.fingerprint).not.toBe(first!.fingerprint)
})

// PR #1010 review fix #3: /wiki scan must not crash (ENOENT) before /wiki init.
test('forceScanConventions does not write cache or throw before /wiki init', async () => {
  const cwd = await makeProjectDir()
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'no-wiki' }),
    'utf8',
  )

  // Must not throw even though .openclaude/ does not exist.
  const result = await forceScanConventions(cwd)
  expect(result.saved).toBe(false)

  // The cache file must NOT have been created (its directory is missing).
  const { conventionsCacheFile } = getWikiPaths(cwd)
  expect(await Bun.file(conventionsCacheFile).exists()).toBe(false)
})

// PR #1010 integration fix #4: a saved scan reindexes so the conventions page
// is listed in the wiki index (the index pipeline post-dates the original PR).
test('scanAndSaveConventions reindexes so conventions appears in the wiki index', async () => {
  const cwd = await makeProjectDir()
  await initializeWiki(cwd)
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'indexed', scripts: { test: 'bun test' } }),
    'utf8',
  )

  const result = await scanAndSaveConventions(cwd)
  expect(result?.saved).toBe(true)

  const { indexFile } = getWikiPaths(cwd)
  const index = await Bun.file(indexFile).text()
  expect(index).toContain('Project Conventions')
})
