import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CURRENT_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME,
} from '../src/utils/packageRename.js'

// The @gitlawb -> @twigpine rename is wired across files that nothing else
// ties together. A mismatch between them only surfaces at release time, after
// the tag and GitHub Release already exist, so pin the contract here.

const ROOT = join(import.meta.dir, '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

test('package.json publishes under the current package name', () => {
  expect(JSON.parse(read('package.json')).name).toBe(CURRENT_PACKAGE_NAME)
})

// The final legacy-scope release is this same tree rebuilt after
// `npm pkg set name=…`. It only announces the move if the build bakes in the
// manifest name; a hardcoded name would ship it as a silent normal release.
test('the build bakes in the manifest name, not a hardcoded scope', () => {
  const defines = read('scripts/build.ts').match(/'MACRO\.PACKAGE_URL':[^\n]*/g) ?? []

  expect(defines.length).toBeGreaterThan(0)
  for (const define of defines) {
    expect(define).toContain('JSON.stringify(packageName)')
  }
})

test('the release workflow publishes and verifies the current package name', () => {
  expect(read('.github/workflows/release.yml')).toContain(
    `npm view ${CURRENT_PACKAGE_NAME}@latest version`,
  )
})

// Only meaningful while the one-time legacy job still exists; once it has
// shipped and been deleted there is nothing left to hold together, and this
// test should be deleted with it rather than the job restored.
test('while the final legacy-scope job exists, it is gated to a single release', () => {
  const workflow = read('.github/workflows/release.yml')
  if (!workflow.includes('publish-npm-legacy-scope:')) return

  expect(workflow).toContain(`npm pkg set name=${LEGACY_PACKAGE_NAME}`)
  expect(workflow).toContain(`npm view ${LEGACY_PACKAGE_NAME}@latest version`)
  // The gate is what makes it a hard stop: without it the job would publish
  // to the old name again on every later release.
  expect(workflow).toContain('legacy-scope-gate:')
  expect(workflow).toMatch(
    /publish-npm-legacy-scope:[\s\S]*?if: \$\{\{[^\n]*needs\.legacy-scope-gate\.outputs\.owed == 'true'/,
  )
})
