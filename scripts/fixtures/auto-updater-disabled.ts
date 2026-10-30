// Isolated module mocks keep hook/callback probes out of the shared test runner.
import { mock } from 'bun:test'
import * as React from 'react'
import { withMockMacro } from '../../src/test/mockMacro.js'

const effects: Array<() => void> = []
const pending: Promise<void>[] = []
let interval: () => Promise<void>
let disabled = true
let latest = 0
let maximum = 0
mock.module('react', () => ({
  ...React,
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void) => { effects.push(effect) },
  useCallback: (callback: () => Promise<void>) => () => {
    const result = callback()
    pending.push(result)
    return result
  },
}))
mock.module('usehooks-ts', () => ({ useInterval: (callback: () => Promise<void>) => { interval = callback } }))
mock.module('../../src/hooks/useUpdateNotification.js', () => ({ useUpdateNotification: () => null }))
mock.module('../../src/ink.js', () => ({ Box: () => null, Text: () => null }))
mock.module('../../src/services/analytics/index.js', () => ({ logEvent: () => {} }))
mock.module('../../src/utils/debug.js', () => ({ logForDebugging: () => {} }))
mock.module('../../src/utils/config.js', () => ({ isAutoUpdaterDisabled: () => disabled, getGlobalConfig: () => ({}) }))
mock.module('../../src/utils/settings/settings.js', () => ({ getInitialSettings: () => ({ autoUpdatesChannel: 'stable' }) }))
mock.module('../../src/utils/doctorDiagnostic.js', () => ({ getCurrentInstallationType: async () => 'npm-global' }))
mock.module('../../src/utils/localInstaller.js', () => ({ localInstallationExists: async () => false, installOrUpdateClaudePackage: async () => 'success' }))
mock.module('../../src/utils/nativeInstaller/index.js', () => ({ removeInstalledSymlink: async () => {} }))
mock.module('../../src/utils/autoUpdater.js', () => ({
  UPDATE_RECOVERY_MESSAGE: 'Lock recovery required',
  getLatestVersion: async () => { latest++; return '0.33.0' },
  getMaxVersion: async () => { maximum++; return undefined },
  installGlobalPackage: async () => { throw new Error('Unexpected automatic install') },
  shouldSkipVersion: () => false,
}))

try {
  const { AutoUpdater } = await import('../../src/components/AutoUpdater.js')
  await withMockMacro({ VERSION: '0.33.0', PACKAGE_URL: '@twigpine/openclaude' }, async () => {
    AutoUpdater({ isUpdating: false, onChangeIsUpdating: () => {}, onAutoUpdaterResult: () => {}, autoUpdaterResult: null, showSuccessMessage: false, verbose: false })
    effects.forEach(effect => effect())
    await Promise.all(pending)
    const initial = { latest, maximum }
    await interval!()
    const timer = { latest, maximum }
    disabled = false
    await interval!()
    const text = (node: React.ReactNode): string => {
      if (Array.isArray(node)) return node.map(text).join('')
      if (typeof node === 'string') return node
      return React.isValidElement<{ children?: React.ReactNode }>(node) ? text(node.props.children) : ''
    }
    const notice = (status: 'termination_uncertain' | 'install_failed') => text(AutoUpdater({
      isUpdating: false, onChangeIsUpdating: () => {}, onAutoUpdaterResult: () => {},
      autoUpdaterResult: { version: '0.34.0', status }, showSuccessMessage: false, verbose: false,
    }))
    const recovery = notice('termination_uncertain')
    const ordinary = notice('install_failed')
    console.log(JSON.stringify({ initial, timer, enabled: { latest, maximum },
      recoveryNotice: recovery.includes('Lock recovery required') && !recovery.includes('npm i -g'),
      ordinaryNotice: ordinary.includes('npm i -g @twigpine/openclaude@latest'),
    }))
  })
} finally {
  mock.restore()
}
