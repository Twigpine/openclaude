import { describe, expect, test } from 'bun:test'
import { withMockMacro } from 'src/test/mockMacro.js'
import {
  CURRENT_PACKAGE_NAME,
  getPackageRenamedMessage,
  isLegacyPackageBuild,
  isLegacyPackageName,
  LEGACY_PACKAGE_NAME,
  PACKAGE_SWITCH_COMMANDS,
} from './packageRename.js'

describe('isLegacyPackageName', () => {
  test('matches only the pre-rename package name', () => {
    expect(isLegacyPackageName(LEGACY_PACKAGE_NAME)).toBe(true)
    expect(isLegacyPackageName(CURRENT_PACKAGE_NAME)).toBe(false)
    expect(isLegacyPackageName('@example/custom-cli')).toBe(false)
    expect(isLegacyPackageName(undefined)).toBe(false)
  })
})

describe('isLegacyPackageBuild', () => {
  test('follows the package name baked into the build', () => {
    withMockMacro({ PACKAGE_URL: LEGACY_PACKAGE_NAME }, () => {
      expect(isLegacyPackageBuild()).toBe(true)
    })
    withMockMacro({ PACKAGE_URL: CURRENT_PACKAGE_NAME }, () => {
      expect(isLegacyPackageBuild()).toBe(false)
    })
  })
})

describe('PACKAGE_SWITCH_COMMANDS', () => {
  // Both packages own the `openclaude` bin. Installing the new one first fails
  // with EEXIST, and forcing it lets the later uninstall delete the shared
  // bin, so the uninstall has to come first.
  test('uninstalls the old package before installing the new one', () => {
    expect(PACKAGE_SWITCH_COMMANDS).toEqual([
      `npm uninstall -g ${LEGACY_PACKAGE_NAME}`,
      `npm install -g ${CURRENT_PACKAGE_NAME}@latest`,
    ])
  })
})

describe('getPackageRenamedMessage', () => {
  test('carries the headline, both commands in order, and the other-managers hint', () => {
    const message = getPackageRenamedMessage()
    const [uninstall, install] = PACKAGE_SWITCH_COMMANDS

    expect(message).toContain(`OpenClaude has moved to ${CURRENT_PACKAGE_NAME}.`)
    expect(message.indexOf(uninstall!)).toBeGreaterThan(-1)
    expect(message.indexOf(uninstall!)).toBeLessThan(message.indexOf(install!))
    expect(message).toContain('bun, pnpm or yarn')
  })
})

