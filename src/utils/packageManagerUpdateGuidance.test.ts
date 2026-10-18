import { describe, expect, test } from 'bun:test'
import type { PackageManager } from './nativeInstaller/packageManagers.js'
import { resolvePackageManagerUpdateGuidance } from './packageManagerUpdateGuidance.js'

const UPSTREAM_PACKAGE_URL = '@anthropic-ai/claude-code'
const OPENCLAUDE_PACKAGE_URL = '@twigpine/openclaude'

describe('resolvePackageManagerUpdateGuidance', () => {
  test.each([
    ['homebrew', 'Homebrew', 'brew upgrade claude-code'],
    ['winget', 'winget', 'winget upgrade Anthropic.ClaudeCode'],
    ['apk', 'apk', 'apk upgrade claude-code'],
  ] as const)(
    'preserves the upstream %s command only for the upstream package',
    (manager, managerName, command) => {
      expect(
        resolvePackageManagerUpdateGuidance(manager, UPSTREAM_PACKAGE_URL),
      ).toEqual({
        message: `OpenClaude is managed by ${managerName}. Use ${managerName} to update OpenClaude.`,
        managerName,
        command,
      })
    },
  )

  test.each(['homebrew', 'winget', 'apk'] as const)(
    'does not guess an upstream command for an OpenClaude %s install',
    manager => {
      const guidance = resolvePackageManagerUpdateGuidance(
        manager,
        OPENCLAUDE_PACKAGE_URL,
      )

      expect(guidance.command).toBeUndefined()
      expect(guidance.message).toContain('OpenClaude')
      expect(guidance.message.toLowerCase()).toContain(manager === 'homebrew' ? 'homebrew' : manager)
      expect(JSON.stringify(guidance)).not.toContain('brew upgrade claude-code')
      expect(JSON.stringify(guidance)).not.toContain('Anthropic.ClaudeCode')
      expect(JSON.stringify(guidance)).not.toContain('apk upgrade claude-code')
    },
  )

  test('does not guess a command for an unknown custom package URL', () => {
    expect(
      resolvePackageManagerUpdateGuidance('homebrew', '@example/custom-cli'),
    ).toEqual({
      message:
        'OpenClaude is managed by Homebrew. Use Homebrew to update OpenClaude.',
      managerName: 'Homebrew',
    })
  })

  test.each(['pacman', 'deb', 'rpm', 'mise', 'asdf', 'unknown'] as PackageManager[])(
    'uses safe generic guidance for %s',
    manager => {
      expect(
        resolvePackageManagerUpdateGuidance(manager, OPENCLAUDE_PACKAGE_URL),
      ).toEqual({
        message:
          'OpenClaude is managed by a package manager. Use your package manager to update OpenClaude.',
      })
    },
  )
})
