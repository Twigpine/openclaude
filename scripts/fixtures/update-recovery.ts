// Isolated consumer probe: real command callbacks/JSX, injected hooks and installer result.
import { mock } from 'bun:test'
import * as React from 'react'
import { withMockMacro } from '../../src/test/mockMacro.js'

let state: unknown
let settled = () => {}
let status: 'termination_uncertain' | 'install_failed' = 'termination_uncertain'
let element: React.ReactElement<unknown> | undefined
const effects: Array<() => void> = []
mock.module('react', () => ({ ...React,
  useState: () => [state, (next: unknown) => {
    state = next
    if (next && typeof next === 'object' && 'type' in next && next.type === 'error') settled()
  }],
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void) => { effects.push(effect) },
}))
mock.module('../../src/ink.js', () => ({ Box: () => null, Text: () => null,
  render: async (node: React.ReactElement<unknown>) => { element = node; return { unmount() {} } },
}))
mock.module('../../src/components/design-system/StatusIcon.js', () => ({ StatusIcon: () => null }))
mock.module('../../src/utils/debug.js', () => ({ logForDebugging() {} }))
mock.module('../../src/utils/config.js', () => ({ getGlobalConfig: () => ({ installMethod: 'global' }) }))
mock.module('../../src/utils/globalPackageManager.js', () => ({ detectGlobalPackageManager: async () => 'npm' }))
mock.module('../../src/utils/localInstaller.js', () => ({ installOrUpdateClaudePackage: async () => 'success' }))
mock.module('../../src/utils/nativeDistribution.js', () => ({ hasNativeDistribution: () => false }))
mock.module('../../src/utils/nativeInstaller/index.js', () => ({ installLatest: async () => ({}), removeInstalledSymlink: async () => {} }))
mock.module('../../src/utils/updateStrategy.js', () => ({ resolveUpdateStrategy: async () => ({ action: 'npm', method: 'global' }) }))
mock.module('../../src/utils/autoUpdater.js', () => ({ getLatestVersion: async () => '0.34.0',
  installGlobalPackage: async () => status, UPDATE_RECOVERY_MESSAGE: 'Lock recovery required',
}))

function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  return React.isValidElement<{ children?: React.ReactNode }>(node) ? text(node.props.children) : ''
}

try {
  await withMockMacro({ PACKAGE_URL: '@twigpine/openclaude', DISPLAY_VERSION: '0.33.0' }, async () => {
    const { call } = await import('../../src/commands/update/update.js')
    const results = []
    for (const next of ['termination_uncertain', 'install_failed'] as const) {
      status = next
      state = { type: 'checking' }
      effects.length = 0
      const changed = new Promise<void>(resolve => { settled = resolve })
      let completed = (_message: string) => {}
      const completion = new Promise<string>(resolve => { completed = resolve })
      await call(message => completed(message), undefined, '0.34.0')
      if (!element || typeof element.type !== 'function') throw new Error('Update component was not rendered')
      const component = element.type as React.FunctionComponent<unknown>
      await component(element.props)
      effects[0]!()
      await changed
      effects.length = 0
      const rendered = text(await component(element.props))
      effects.at(-1)!()
      const message = await completion
      results.push({ status, recovery: rendered.includes('Lock recovery required'),
        manual: rendered.includes('npm install -g'), recoveryOnDone: message.includes('Lock recovery required') })
    }
    console.log(JSON.stringify(results))
  })
} finally { mock.restore() }
