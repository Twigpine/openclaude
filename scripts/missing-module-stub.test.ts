import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')
const DIST = join(REPO_ROOT, 'dist/cli.mjs')

// Regression for Twigpine/openclaude#706. The bundled KAIROS dream skill
// (src/skills/bundled/dream.js, not mirrored) must not stub the real
// /dream slash command at src/commands/dream/dream.ts during bundling.
test('/dream command is present in the CLI bundle', () => {
  if (!existsSync(DIST)) {
    throw new Error(
      'dist/cli.mjs not found — run `bun run build` before this test',
    )
  }

  const bundle = readFileSync(DIST, 'utf-8')

  expect(bundle).toContain('consolidating memories')
  expect(bundle).not.toMatch(
    /missing-module-stub:.*commands\/dream\/dream\.js/,
  )
})

// Regression for the WebFetch SSRF guard. WebFetchTool passes the real
// ssrfGuardedLookup (src/utils/hooks/ssrfGuard.ts) as its DNS `lookup`. A
// string-literal import of that module inside
// src/__tests__/security-hardening.test.ts previously registered the specifier
// as missing, and the specifier-keyed resolver then replaced WebFetch's real
// import with a noop in dist/cli.mjs — silently disabling SSRF protection. The
// source-level test only reads src/tools/WebFetchTool/utils.ts, so it cannot
// catch a bundle-only regression; assert against the shipped bundle instead.
test('WebFetch binds the real ssrfGuardedLookup in the CLI bundle', () => {
  if (!existsSync(DIST)) {
    throw new Error(
      'dist/cli.mjs not found — run `bun run build` before this test',
    )
  }

  const bundle = readFileSync(DIST, 'utf-8')

  // The real guard's distinctive blocked-address error must be bundled...
  expect(bundle).toContain('private/link-local address')
  // ...and ssrfGuard must not have been replaced by a missing-module stub.
  expect(bundle).not.toMatch(/missing-module-stub:.*ssrfGuard/)
})

test('CLI bundle includes the real sandbox runtime instead of the native stub', () => {
  if (!existsSync(DIST)) {
    throw new Error(
      'dist/cli.mjs not found — run `bun run build` before this test',
    )
  }

  const bundle = readFileSync(DIST, 'utf-8')

  expect(bundle).not.toContain('native-stub:@anthropic-ai/sandbox-runtime')
  expect(bundle).toContain('bubblewrap (bwrap) not installed')
})
