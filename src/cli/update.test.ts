import { describe, expect, test } from 'bun:test'
import { withMockMacro } from 'src/test/mockMacro.js'
import {
  getGlobalUpdateFailureHint,
  writePackageManagerUpdateGuidance,
  writePackageRenamedNote,
} from './update.js'

describe('getGlobalUpdateFailureHint', () => {
  test('points npm-only builds at npm instead of the native installer', () => {
    withMockMacro({ PACKAGE_URL: '@twigpine/openclaude' }, () => {
      expect(getGlobalUpdateFailureHint(false)).toContain(
        'npm install -g @twigpine/openclaude@latest',
      )
      expect(getGlobalUpdateFailureHint(false)).not.toContain(
        'openclaude install',
      )
    })
  })

  test('preserves native installer guidance for native-capable builds', () => {
    expect(getGlobalUpdateFailureHint(true)).toBe(
      'Or consider using native installation with: openclaude install\n',
    )
  })
})

describe('writePackageManagerUpdateGuidance', () => {
  test.each([
    ['@anthropic-ai/claude-code', true],
    ['@twigpine/openclaude', false],
    ['@example/custom-cli', false],
  ] as const)(
    'uses the runtime package identity for %s',
    async (packageUrl, expectsUpstreamCommand) => {
      let output = ''

      await withMockMacro({ PACKAGE_URL: packageUrl }, async () => {
        await writePackageManagerUpdateGuidance('homebrew', 'latest', {
          displayVersion: '1.0.0',
          getLatestVersion: async () => '2.0.0',
          write: value => {
            output += value
          },
          bold: value => value,
        })
      })

      expect(output).toContain(
        'OpenClaude is managed by Homebrew. Use Homebrew to update OpenClaude.',
      )
      expect(output).toContain('Update available: 1.0.0 → 2.0.0')
      if (expectsUpstreamCommand) {
        expect(output).toContain('brew upgrade claude-code')
      } else {
        expect(output).not.toContain('brew upgrade claude-code')
        expect(output).not.toContain('Anthropic.ClaudeCode')
        expect(output).not.toContain('apk upgrade claude-code')
      }
    },
  )
})

describe('writePackageRenamedNote', () => {
  function capture(packageUrl: string): { output: string; wrote: boolean } {
    let output = ''
    const wrote = withMockMacro({ PACKAGE_URL: packageUrl }, () =>
      writePackageRenamedNote({
        write: value => {
          output += value
        },
        bold: value => value,
        yellow: value => value,
      }),
    )
    return { output, wrote }
  }

  test('tells legacy-scope installs where the package moved', () => {
    const { output, wrote } = capture('@gitlawb/openclaude')

    // update() stops after the note when this is true.
    expect(wrote).toBe(true)
    expect(output).toContain('OpenClaude has moved to @twigpine/openclaude.')
    // Uninstall first: installing the new package over the old one fails.
    expect(output.indexOf('npm uninstall -g @gitlawb/openclaude')).toBeGreaterThan(-1)
    expect(output.indexOf('npm uninstall -g @gitlawb/openclaude')).toBeLessThan(
      output.indexOf('npm install -g @twigpine/openclaude@latest'),
    )
    // The npm commands are wrong for other global package managers; say so.
    expect(output).toContain('bun, pnpm or yarn')
  })

  test('writes nothing and lets the update proceed for the current package', () => {
    expect(capture('@twigpine/openclaude')).toEqual({ output: '', wrote: false })
  })
})
