// Isolated module mocks keep hook/callback probes out of the shared test runner.
import { mock } from 'bun:test'
import * as React from 'react'
import type { AutoUpdaterResult } from '../../src/utils/autoUpdater.js'
import { withMockMacro } from '../../src/test/mockMacro.js'

const effects: Array<() => void> = []
const pending: Promise<void>[] = []
const installs: unknown[] = []
let detectionError: Error | undefined
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
mock.module('usehooks-ts', () => ({ useInterval: () => {} }))
mock.module('../../src/hooks/useUpdateNotification.js', () => ({ useUpdateNotification: () => null }))
mock.module('../../src/ink.js', () => ({ Box: () => null, Text: () => null }))
mock.module('../../src/services/analytics/index.js', () => ({ logEvent: () => {} }))
mock.module('../../src/utils/debug.js', () => ({ logForDebugging: () => {} }))
mock.module('../../src/utils/config.js', () => ({ isAutoUpdaterDisabled: () => false, getGlobalConfig: () => ({}) }))
mock.module('../../src/utils/settings/settings.js', () => ({ getInitialSettings: () => ({ autoUpdatesChannel: 'stable' }) }))
mock.module('../../src/utils/doctorDiagnostic.js', () => ({
  getCurrentInstallationType: async () => {
    if (detectionError) throw detectionError
    return 'npm-global'
  },
}))
mock.module('../../src/utils/nativeDistribution.js', () => ({ hasNativeDistribution: () => false }))
mock.module('../../src/utils/localInstaller.js', () => ({ localInstallationExists: async () => false, installOrUpdateClaudePackage: async () => 'success' }))
mock.module('../../src/utils/nativeInstaller/index.js', () => ({ removeInstalledSymlink: async () => {} }))
mock.module('../../src/utils/autoUpdater.js', () => ({
  UPDATE_RECOVERY_MESSAGE: 'Lock recovery required',
  getLatestVersion: async (channel: string) => (channel === 'stable' ? '0.33.1' : '0.34.0'),
  getMaxVersion: async () => undefined,
  installGlobalPackage: async (version?: string) => { installs.push(version); return 'success' },
  shouldSkipVersion: () => false,
}))

async function runCheck() {
  const updating: boolean[] = []
  const results: AutoUpdaterResult[] = []
  const { AutoUpdater } = await import('../../src/components/AutoUpdater.js')
  AutoUpdater({
    isUpdating: false,
    onChangeIsUpdating: value => { updating.push(value) },
    onAutoUpdaterResult: result => { results.push(result) },
    autoUpdaterResult: null,
    showSuccessMessage: false,
    verbose: false,
  })
  effects.splice(0).forEach(effect => effect())
  await Promise.all(pending.splice(0))
  return { updating, results }
}

try {
  await withMockMacro({ VERSION: '0.33.0', PACKAGE_URL: '@twigpine/openclaude' }, async () => {
    const stable = await runCheck()
    detectionError = new Error('detection failed')
    const failed = await runCheck()
    console.log(JSON.stringify({ installs, stable, failed }))
  })
} finally {
  mock.restore()
}
