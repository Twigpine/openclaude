import { describe, expect, test } from 'bun:test'
import {
  type GlobalPackageManager,
  getGlobalInstallArgs,
  pickFallbackPackageManager,
  selectOwningPackageManager,
} from './globalPackageManager.js'

describe('getGlobalInstallArgs', () => {
  const spec = '@twigpine/openclaude@latest'
  const cases: Array<[GlobalPackageManager, string[]]> = [
    ['npm', ['install', '-g', spec]],
    ['pnpm', ['add', '-g', spec]],
    ['bun', ['add', '-g', spec]],
    ['yarn', ['global', 'add', spec]],
  ]
  for (const [pm, expected] of cases) {
    test(`${pm} builds the right global install argv`, () => {
      expect(getGlobalInstallArgs(pm, spec)).toEqual(expected)
    })
  }

  test('passes an explicit version spec through unchanged', () => {
    expect(getGlobalInstallArgs('npm', '@twigpine/openclaude@1.2.3')).toEqual([
      'install',
      '-g',
      '@twigpine/openclaude@1.2.3',
    ])
  })
})

describe('selectOwningPackageManager', () => {
  test('returns null when no candidate root contains the binary', () => {
    expect(
      selectOwningPackageManager('/home/u/.bun/install/global/node_modules/x', [
        { pm: 'npm', root: '/usr/local/lib/node_modules' },
        { pm: 'pnpm', root: '/home/u/.local/share/pnpm/global/5/node_modules' },
      ]),
    ).toBeNull()
  })

  test('returns null for empty candidate list', () => {
    expect(selectOwningPackageManager('/anything', [])).toBeNull()
  })

  test('matches the package manager whose root contains the binary', () => {
    expect(
      selectOwningPackageManager(
        '/home/u/.local/share/pnpm/global/5/node_modules/@twigpine/openclaude/cli.js',
        [
          { pm: 'npm', root: '/usr/local/lib/node_modules' },
          {
            pm: 'pnpm',
            root: '/home/u/.local/share/pnpm/global/5/node_modules',
          },
        ],
      ),
    ).toBe('pnpm')
  })

  test('most specific (longest) root wins when roots are nested', () => {
    // npm's root is a parent of bun's here; bun must win because its root is
    // the more specific match.
    expect(
      selectOwningPackageManager('/opt/pm/node_modules/bun/global/openclaude', [
        { pm: 'npm', root: '/opt/pm/node_modules' },
        { pm: 'bun', root: '/opt/pm/node_modules/bun/global' },
      ]),
    ).toBe('bun')
  })

  test('treats an exact path match as owned', () => {
    expect(
      selectOwningPackageManager('/usr/local/lib/node_modules', [
        { pm: 'npm', root: '/usr/local/lib/node_modules' },
      ]),
    ).toBe('npm')
  })

  test('does not match a sibling directory sharing a prefix', () => {
    // "/a/node_modules-other" must not be considered under "/a/node_modules".
    expect(
      selectOwningPackageManager('/a/node_modules-other/openclaude/cli.js', [
        { pm: 'npm', root: '/a/node_modules' },
      ]),
    ).toBeNull()
  })

  test('ignores candidates with an empty root', () => {
    expect(
      selectOwningPackageManager('/usr/lib/node_modules/openclaude', [
        { pm: 'yarn', root: '' },
        { pm: 'npm', root: '/usr/lib/node_modules' },
      ]),
    ).toBe('npm')
  })
})

describe('pickFallbackPackageManager', () => {
  test('returns null when nothing is available', () => {
    expect(pickFallbackPackageManager([], false)).toBeNull()
    expect(pickFallbackPackageManager([], true)).toBeNull()
  })

  test('prefers bun when running under the Bun runtime and bun is available', () => {
    expect(pickFallbackPackageManager(['npm', 'bun'], true)).toBe('bun')
  })

  test('does not force bun when not running under Bun', () => {
    expect(pickFallbackPackageManager(['npm', 'bun'], false)).toBe('npm')
  })

  test('falls back to priority order when bun is unavailable under Bun', () => {
    expect(pickFallbackPackageManager(['pnpm', 'yarn'], true)).toBe('pnpm')
  })

  test('honours FALLBACK_PRIORITY (npm > bun > pnpm > yarn)', () => {
    expect(pickFallbackPackageManager(['yarn', 'pnpm', 'bun'], false)).toBe(
      'bun',
    )
    expect(pickFallbackPackageManager(['yarn', 'pnpm'], false)).toBe('pnpm')
    expect(pickFallbackPackageManager(['yarn'], false)).toBe('yarn')
  })
})
