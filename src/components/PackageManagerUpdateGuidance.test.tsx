import { describe, expect, test } from 'bun:test'
import React from 'react'
import { withMockMacro } from '../test/mockMacro.js'
import { renderToString } from '../utils/staticRender.js'

const forbiddenCommands = [
  'brew upgrade claude-code',
  'Anthropic.ClaudeCode',
  'apk upgrade claude-code',
]

describe('package-manager update surfaces', () => {
  async function renderSurfaces(
    manager: 'homebrew' | 'winget' | 'apk',
    packageUrl: string,
  ): Promise<{ slash: string; passive: string }> {
    return withMockMacro({ PACKAGE_URL: packageUrl }, async () => {
      const [{ PackageManagerUpdateGuidance }, { PackageManagerUpdateAvailableNotice }] =
        await Promise.all([
          import(`../commands/update/update.js?slash=${Math.random()}`),
          import(`./PackageManagerAutoUpdater.js?passive=${Math.random()}`),
        ])

      const slash = await renderToString(
        <PackageManagerUpdateGuidance manager={manager} />,
        200,
      )
      const passive = await renderToString(
        <PackageManagerUpdateAvailableNotice manager={manager} />,
        200,
      )

      return { slash, passive }
    })
  }

  test.each([
    ['homebrew', 'Homebrew'],
    ['winget', 'winget'],
    ['apk', 'apk'],
  ] as const)(
    'slash and passive %s surfaces render the same safe OpenClaude guidance',
    async (manager, managerName) => {
      const { slash, passive } = await renderSurfaces(
        manager,
        '@twigpine/openclaude',
      )
      const sharedGuidance = `OpenClaude is managed by ${managerName}. Use ${managerName} to update OpenClaude.`

      expect(slash).toContain(sharedGuidance)
      expect(passive).toContain(sharedGuidance)
      for (const command of forbiddenCommands) {
        expect(slash).not.toContain(command)
        expect(passive).not.toContain(command)
      }
    },
  )

  test.each([
    ['homebrew', 'brew upgrade claude-code'],
    ['winget', 'winget upgrade Anthropic.ClaudeCode'],
    ['apk', 'apk upgrade claude-code'],
  ] as const)(
    'slash and passive %s surfaces preserve the upstream command',
    async (manager, command) => {
      const { slash, passive } = await renderSurfaces(
        manager,
        '@anthropic-ai/claude-code',
      )

      expect(slash).toContain(command)
      expect(passive).toContain(command)
    },
  )
})
