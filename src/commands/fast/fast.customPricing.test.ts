import { test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FIXTURE_TIMEOUT_MS = 60_000

test(
  '/model and /fast price strings use the exact custom price',
  () => {
    const fixture = resolve(
      repoRoot,
      'src/test/fixtures/customPricingDisplay.fixture.tsx',
    )
    const result = spawnSync(process.execPath, [fixture], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: FIXTURE_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(
        [
          `Fixture exited with status ${result.status ?? 'unknown'}.`,
          result.stdout.trim(),
          result.stderr.trim(),
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
    }
  },
  { timeout: FIXTURE_TIMEOUT_MS + 5_000 },
)
