import { describe, expect, test } from 'bun:test'
import { withMockMacro } from 'src/test/mockMacro.js'
import {
  CURRENT_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME,
  PACKAGE_SWITCH_COMMANDS,
} from './packageRename.js'
import type { StatusNoticeContext } from './statusNoticeDefinitions.js'
import { statusNoticeDefinitions } from './statusNoticeDefinitions.js'
import { renderToString } from './staticRender.js'

// The final build published under the pre-rename package name is the only
// build that should tell users the package moved.

const context: StatusNoticeContext = {
  config: {} as StatusNoticeContext['config'],
  memoryFiles: [],
}

function packageRenamedNotice() {
  const notice = statusNoticeDefinitions.find(n => n.id === 'package-renamed')
  expect(notice).toBeDefined()
  return notice!
}

describe('package renamed notice', () => {
  test('is active only for the legacy-scope build', () => {
    withMockMacro({ PACKAGE_URL: LEGACY_PACKAGE_NAME }, () => {
      expect(packageRenamedNotice().isActive(context)).toBe(true)
    })
    withMockMacro({ PACKAGE_URL: CURRENT_PACKAGE_NAME }, () => {
      expect(packageRenamedNotice().isActive(context)).toBe(false)
    })
  })

  test('shows where the package moved and the switch commands in order', async () => {
    const output = await renderToString(
      packageRenamedNotice().render(context),
      100,
    )

    expect(output).toContain(`OpenClaude has moved to ${CURRENT_PACKAGE_NAME}.`)
    const [uninstall, install] = PACKAGE_SWITCH_COMMANDS
    expect(output).toContain(uninstall!)
    expect(output).toContain(install!)
    expect(output.indexOf(uninstall!)).toBeLessThan(output.indexOf(install!))
    expect(output).toContain('bun, pnpm or yarn')
  })
})
