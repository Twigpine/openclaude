import { isInBundledMode } from 'src/utils/bundledMode.js'
import type { InstallationType } from 'src/utils/doctorDiagnostic.js'
import { getCurrentInstallationType } from 'src/utils/doctorDiagnostic.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { hasNativeDistribution } from 'src/utils/nativeDistribution.js'

const NPM_DEPRECATION_MESSAGE =
  'OpenClaude has switched from npm to the native installer. Run `openclaude install` or see https://github.com/Twigpine/openclaude#quick-start for more options.'

export async function getNpmDeprecationNotification(deps: {
  isBundledMode?: () => boolean
  installationChecksDisabled?: () => boolean
  getInstallationType?: () => Promise<InstallationType>
  hasNativeDistribution?: () => boolean
} = {}) {
  const isBundled = deps.isBundledMode ?? isInBundledMode
  const checksDisabled =
    deps.installationChecksDisabled ??
    (() => isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS))
  const getInstallationType =
    deps.getInstallationType ?? getCurrentInstallationType
  const nativeDistributionAvailable =
    deps.hasNativeDistribution ?? hasNativeDistribution

  if (isBundled() || checksDisabled() || !nativeDistributionAvailable()) {
    return null
  }

  const installationType = await getInstallationType()
  if (installationType === 'development') {
    return null
  }

  return {
    timeoutMs: 15000,
    key: 'npm-deprecation-warning',
    text: NPM_DEPRECATION_MESSAGE,
    color: 'warning' as const,
    priority: 'high' as const,
  }
}
