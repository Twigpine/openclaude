import memoize from 'lodash-es/memoize.js'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { which } from './which.js'

export type GlobalPackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

// All package managers we know how to drive a global install with.
const ALL_PACKAGE_MANAGERS: GlobalPackageManager[] = [
  'npm',
  'yarn',
  'pnpm',
  'bun',
]

// Order used when path-based detection is inconclusive. npm first because it is
// the documented install method; bun next because we ship a Bun-built binary.
const FALLBACK_PRIORITY: GlobalPackageManager[] = ['npm', 'bun', 'pnpm', 'yarn']

/**
 * Build the argv (after the binary name) to globally install `spec`
 * (e.g. "@twigpine/openclaude@latest") with the given package manager.
 */
export function getGlobalInstallArgs(
  pm: GlobalPackageManager,
  spec: string,
): string[] {
  switch (pm) {
    case 'npm':
      return ['install', '-g', spec]
    case 'pnpm':
      return ['add', '-g', spec]
    case 'bun':
      return ['add', '-g', spec]
    case 'yarn':
      // Classic yarn syntax; yarn berry aliases `global add` to the same effect
      // for the documented openclaude install path.
      return ['global', 'add', spec]
  }
}

/** True when `child` is the same path as, or nested inside, `parent`. */
function isUnder(child: string, parent: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  const withSep = p.endsWith(sep) ? p : p + sep
  return c === p || c.startsWith(withSep)
}

/**
 * Pure decision: given the running binary's path and each candidate package
 * manager's global root, return the PM whose root contains the binary. When
 * several roots match (one nested inside another) the most specific — longest —
 * root wins, so npm's broad global dir never shadows pnpm/bun/yarn. Returns null
 * when no root contains the path.
 */
export function selectOwningPackageManager(
  selfPath: string,
  candidates: ReadonlyArray<{ pm: GlobalPackageManager; root: string }>,
): GlobalPackageManager | null {
  let best: { pm: GlobalPackageManager; rootLen: number } | null = null
  for (const { pm, root } of candidates) {
    if (!root) continue
    const rootLen = resolve(root).length
    if (isUnder(selfPath, root) && (!best || rootLen > best.rootLen)) {
      best = { pm, rootLen }
    }
  }
  return best?.pm ?? null
}

/**
 * Pure fallback selection when path-based detection is inconclusive. Prefers bun
 * when we're executing under the Bun runtime, otherwise the first available PM
 * by FALLBACK_PRIORITY. Returns null only when nothing is available.
 */
export function pickFallbackPackageManager(
  available: ReadonlyArray<GlobalPackageManager>,
  runningUnderBun: boolean,
): GlobalPackageManager | null {
  if (available.length === 0) {
    return null
  }
  if (runningUnderBun && available.includes('bun')) {
    return 'bun'
  }
  for (const pm of FALLBACK_PRIORITY) {
    if (available.includes(pm)) {
      return pm
    }
  }
  return available[0] ?? null
}

async function isAvailable(pm: GlobalPackageManager): Promise<boolean> {
  return Boolean(await which(pm))
}

/**
 * Resolve a package manager's global `node_modules` directory, where globally
 * installed packages live. Returns null when the command fails or is unknown.
 */
async function getGlobalRoot(
  pm: GlobalPackageManager,
): Promise<string | null> {
  // Run from $HOME so a project-local .npmrc / .bunfig.toml can't redirect us.
  const opts = { cwd: homedir(), timeout: 15_000 }
  try {
    switch (pm) {
      case 'npm': {
        const r = await execFileNoThrowWithCwd('npm', ['root', '-g'], opts)
        return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
      }
      case 'pnpm': {
        const r = await execFileNoThrowWithCwd('pnpm', ['root', '-g'], opts)
        return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
      }
      case 'yarn': {
        // Classic yarn only; Yarn Berry (v2+) removed `yarn global`, so this
        // returns null for Berry installs and detection falls back via
        // pickFallbackPackageManager — acceptable degradation, as Berry has no
        // classic global install for us to own anyway.
        const r = await execFileNoThrowWithCwd('yarn', ['global', 'dir'], opts)
        return r.code === 0 && r.stdout.trim()
          ? join(r.stdout.trim(), 'node_modules')
          : null
      }
      case 'bun': {
        // Bun has no `root -g`; its global packages live under BUN_INSTALL.
        const bunInstall = process.env.BUN_INSTALL || join(homedir(), '.bun')
        return join(bunInstall, 'install', 'global', 'node_modules')
      }
    }
  } catch (error) {
    logForDebugging(`getGlobalRoot(${pm}) failed: ${error}`)
    return null
  }
}

async function resolveRealPath(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

/**
 * Detect which package manager owns the currently running OpenClaude install.
 *
 * Strategy:
 *  1. Resolve the real path of the running binary (following the bin symlink
 *     into the package manager's global node_modules).
 *  2. Match it against each available PM's global root via
 *     {@link selectOwningPackageManager}.
 *  3. If nothing matches, fall back via {@link pickFallbackPackageManager}.
 *
 * Memoized — detection spawns several subprocesses and the answer is stable for
 * the life of the process. Returns null only when none of npm/yarn/pnpm/bun are
 * installed.
 */
export const detectGlobalPackageManager = memoize(
  async (): Promise<GlobalPackageManager | null> => {
    // Availability probes and the self-path lookup are independent subprocess
    // calls — run them concurrently so detection cost is bounded by the slowest
    // probe rather than the sum of all of them.
    const [availabilityFlags, selfPath] = await Promise.all([
      Promise.all(ALL_PACKAGE_MANAGERS.map(isAvailable)),
      process.argv[1]
        ? resolveRealPath(process.argv[1])
        : Promise.resolve(null),
    ])
    const available = ALL_PACKAGE_MANAGERS.filter((_, i) => availabilityFlags[i])
    if (available.length === 0) {
      return null
    }

    if (selfPath) {
      // Resolve each available manager's global root concurrently too; the most
      // specific match wins regardless of order (see selectOwningPackageManager).
      const candidates = (
        await Promise.all(
          available.map(async pm => {
            const root = await getGlobalRoot(pm)
            return root ? { pm, root: await resolveRealPath(root) } : null
          }),
        )
      ).filter(
        (candidate): candidate is { pm: GlobalPackageManager; root: string } =>
          candidate !== null,
      )

      const owner = selectOwningPackageManager(selfPath, candidates)
      if (owner) {
        logForDebugging(`Detected install owner package manager: ${owner}`)
        return owner
      }
    }

    const fallback = pickFallbackPackageManager(
      available,
      typeof Bun !== 'undefined',
    )
    if (fallback) {
      logForDebugging(`Falling back to package manager: ${fallback}`)
    }
    return fallback
  },
)
