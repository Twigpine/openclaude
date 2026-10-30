import chalk from 'chalk'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getLatestVersion,
  type InstallStatus,
  installGlobalPackage,
  UPDATE_RECOVERY_MESSAGE,
} from 'src/utils/autoUpdater.js'
import { regenerateCompletionCache } from 'src/utils/completionCache.js'
import {
  getGlobalConfig,
  type InstallMethod,
  type ReleaseChannel,
  saveGlobalConfig,
} from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getDoctorDiagnostic } from 'src/utils/doctorDiagnostic.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import {
  installOrUpdateClaudePackage,
  localInstallationExists,
} from 'src/utils/localInstaller.js'
import { hasNativeDistribution } from 'src/utils/nativeDistribution.js'
import {
  installLatest as installLatestNative,
  removeInstalledSymlink,
} from 'src/utils/nativeInstaller/index.js'
import {
  getPackageManager,
  type PackageManager,
} from 'src/utils/nativeInstaller/packageManagers.js'
import {
  getPackageManagerUpdateGuidance,
  type PackageManagerUpdateGuidance,
} from 'src/utils/packageManagerUpdateGuidance.js'
import { writeToStdout } from 'src/utils/process.js'
import { gte } from 'src/utils/semver.js'
import { shouldRemoveInstalledSymlinkForNpmUpdate } from 'src/utils/autoUpdaterRouting.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'
import {
  isThirdPartyBuildBlocked,
  planUpdate,
} from 'src/utils/updateStrategy.js'

export function getGlobalUpdateFailureHint(
  nativeDistributionAvailable: boolean = hasNativeDistribution(),
): string {
  return nativeDistributionAvailable
    ? 'Or consider using native installation with: openclaude install\n'
    : `Or update manually with:\n  npm install -g ${MACRO.PACKAGE_URL}@latest\n`
}

export async function writePackageManagerUpdateGuidance(
  manager: PackageManager,
  channel: ReleaseChannel,
  deps: {
    displayVersion?: string
    getGuidance?: (manager: PackageManager) => PackageManagerUpdateGuidance
    getLatestVersion?: (channel: ReleaseChannel) => Promise<string | null>
    write?: (value: string) => void
    bold?: (value: string) => string
  } = {},
): Promise<void> {
  const guidance = (deps.getGuidance ?? getPackageManagerUpdateGuidance)(manager)
  const displayVersion = deps.displayVersion ?? MACRO.DISPLAY_VERSION
  const write = deps.write ?? writeToStdout
  const bold = deps.bold ?? chalk.bold

  write('\n')
  write(`${guidance.message}\n`)

  if (!guidance.managerName) {
    return
  }

  const latest = await (deps.getLatestVersion ?? getLatestVersion)(channel)
  if (latest && !gte(displayVersion, latest)) {
    write(`Update available: ${displayVersion} → ${latest}\n`)
    if (guidance.command) {
      write('\n')
      write('To update, run:\n')
      write(bold(`  ${guidance.command}`) + '\n')
    }
  } else {
    write('OpenClaude is up to date!\n')
  }
}

export async function update() {
  // Block updates for third-party providers using upstream Anthropic builds.
  // The update mechanism downloads from the first-party distribution bucket,
  // which would silently replace the OpenClaude build with the upstream
  // Claude Code binary. However, builds with a custom PACKAGE_URL (like
  // OpenClaude's @twigpine/openclaude) are safe to self-update.
  if (isThirdPartyBuildBlocked()) {
    writeToStdout(
      chalk.yellow(
        `Auto-update is not available for third-party provider builds.\n`,
      ) +
        `Current version: ${MACRO.DISPLAY_VERSION}\n\n` +
        `To update, reinstall from npm:\n` +
        chalk.bold(`  npm install -g ${MACRO.PACKAGE_URL}@latest`) + '\n\n' +
        `Or, if you built from source, pull and rebuild:\n` +
        chalk.bold('  git pull && bun install && bun run build') + '\n',
    )
    await gracefulShutdown(0)
  }

  logEvent('tengu_update_check', {})
  writeToStdout(`Current version: ${MACRO.DISPLAY_VERSION}\n`)

  const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
  writeToStdout(`Checking for updates to ${channel} version...\n`)

  logForDebugging('update: Starting update check')

  // Run diagnostic to detect potential issues
  logForDebugging('update: Running diagnostic')
  const diagnostic = await getDoctorDiagnostic()
  logForDebugging(`update: Installation type: ${diagnostic.installationType}`)
  logForDebugging(
    `update: Config install method: ${diagnostic.configInstallMethod}`,
  )

  // Check for multiple installations
  if (diagnostic.multipleInstallations.length > 1) {
    writeToStdout('\n')
    writeToStdout(chalk.yellow('Warning: Multiple installations found') + '\n')
    for (const install of diagnostic.multipleInstallations) {
      const current =
        diagnostic.installationType === install.type
          ? ' (currently running)'
          : ''
      writeToStdout(`- ${install.type} at ${install.path}${current}\n`)
    }
  }

  // Display warnings if any exist
  if (diagnostic.warnings.length > 0) {
    writeToStdout('\n')
    for (const warning of diagnostic.warnings) {
      logForDebugging(`update: Warning detected: ${warning.issue}`)

      // Don't skip PATH warnings - they're always relevant
      // The user needs to know that 'which claude' points elsewhere
      logForDebugging(`update: Showing warning: ${warning.issue}`)

      writeToStdout(chalk.yellow(`Warning: ${warning.issue}\n`))

      writeToStdout(chalk.bold(`Fix: ${warning.fix}\n`))
    }
  }

  // Update config if installMethod is not set (but skip for package managers)
  const config = getGlobalConfig()
  if (
    !config.installMethod &&
    diagnostic.installationType !== 'package-manager'
  ) {
    writeToStdout('\n')
    writeToStdout('Updating configuration to track installation method...\n')
    let detectedMethod: 'local' | 'native' | 'global' | 'unknown' = 'unknown'

    // Map diagnostic installation type to config install method
    switch (diagnostic.installationType) {
      case 'npm-local':
        detectedMethod = 'local'
        break
      case 'native':
        detectedMethod = 'native'
        break
      case 'npm-global':
        detectedMethod = 'global'
        break
      default:
        detectedMethod = 'unknown'
    }

    saveGlobalConfig(current => ({
      ...current,
      installMethod: detectedMethod,
    }))
    writeToStdout(`Installation method set to: ${detectedMethod}\n`)
  }

  // Check if running from development build
  if (diagnostic.installationType === 'development') {
    writeToStdout('\n')
    writeToStdout(
      chalk.yellow('You are running a development build — auto-update is unavailable.') + '\n',
    )
    writeToStdout('To update, pull the latest source and rebuild:\n')
    writeToStdout(chalk.bold('  git pull && bun install && bun run build') + '\n')
    writeToStdout('\n')
    writeToStdout('Or reinstall from npm:\n')
    writeToStdout(chalk.bold(`  npm install -g ${MACRO.PACKAGE_URL}@latest`) + '\n')
    await gracefulShutdown(0)
  }

  // Check if running from a package manager
  if (diagnostic.installationType === 'package-manager') {
    const packageManager = await getPackageManager()
    await writePackageManagerUpdateGuidance(packageManager, channel)
    await gracefulShutdown(0)
  }

  // Check for config/reality mismatch (skip for package-manager installs)
  if (
    config.installMethod &&
    diagnostic.configInstallMethod !== 'not set' &&
    diagnostic.installationType !== 'package-manager'
  ) {
    const runningType = diagnostic.installationType
    const configExpects = diagnostic.configInstallMethod

    // Map installation types for comparison
    const typeMapping: Record<string, string> = {
      'npm-local': 'local',
      'npm-global': 'global',
      native: 'native',
      development: 'development',
      unknown: 'unknown',
    }

    const normalizedRunningType = typeMapping[runningType] || runningType

    if (
      normalizedRunningType !== configExpects &&
      configExpects !== 'unknown'
    ) {
      writeToStdout('\n')
      writeToStdout(chalk.yellow('Warning: Configuration mismatch') + '\n')
      writeToStdout(`Config expects: ${configExpects} installation\n`)
      writeToStdout(`Currently running: ${runningType}\n`)
      writeToStdout(
        chalk.yellow(
          `Updating the ${runningType} installation you are currently using`,
        ) + '\n',
      )

      // Update config to match reality
      saveGlobalConfig(current => ({
        ...current,
        installMethod: normalizedRunningType as InstallMethod,
      }))
      writeToStdout(
        `Config updated to reflect current installation method: ${normalizedRunningType}\n`,
      )
    }
  }

  // Handle native installation updates first. npm-only builds fall through to
  // the npm update path even when the running binary looks native — they have
  // no native distribution to update from.
  if (diagnostic.installationType === 'native' && hasNativeDistribution()) {
    logForDebugging(
      'update: Detected native installation, using native updater',
    )
    try {
      const result = await installLatestNative(channel, true)

      // Handle lock contention gracefully
      if (result.lockFailed) {
        const pidInfo = result.lockHolderPid
          ? ` (PID ${result.lockHolderPid})`
          : ''
        writeToStdout(
          chalk.yellow(
            `Another Claude process${pidInfo} is currently running. Please try again in a moment.`,
          ) + '\n',
        )
        await gracefulShutdown(0)
      }

      if (!result.latestVersion) {
        process.stderr.write('Failed to check for updates\n')
        await gracefulShutdown(1)
      }

      if (result.latestVersion === MACRO.DISPLAY_VERSION) {
        writeToStdout(
          chalk.green(`OpenClaude is up to date (${MACRO.DISPLAY_VERSION})`) + '\n',
        )
      } else {
        writeToStdout(
          chalk.green(
            `Successfully updated from ${MACRO.DISPLAY_VERSION} to version ${result.latestVersion}`,
          ) + '\n',
        )
        await regenerateCompletionCache()
      }
      await gracefulShutdown(0)
    } catch (error) {
      process.stderr.write('Error: Failed to install native update\n')
      process.stderr.write(String(error) + '\n')
      process.stderr.write('Try running "openclaude doctor" for diagnostics\n')
      await gracefulShutdown(1)
    }
  }

  // Fallback to existing JS/npm-based update logic
  // Remove native installer symlink since we're not using native installation
  // But only if user hasn't migrated to native installation
  if (
    shouldRemoveInstalledSymlinkForNpmUpdate(
      config.installMethod,
      hasNativeDistribution(),
    )
  ) {
    await removeInstalledSymlink()
  }

  logForDebugging('update: Checking npm registry for latest version')
  logForDebugging(`update: Package URL: ${MACRO.PACKAGE_URL}`)
  const npmTag = channel === 'stable' ? 'stable' : 'latest'
  const npmCommand = `npm view ${MACRO.PACKAGE_URL}@${npmTag} version`
  logForDebugging(`update: Running: ${npmCommand}`)
  const latestVersion = await getLatestVersion(channel)
  logForDebugging(
    `update: Latest version from npm: ${latestVersion || 'FAILED'}`,
  )

  if (!latestVersion) {
    logForDebugging('update: Failed to get latest version from npm registry')
    process.stderr.write(chalk.red('Failed to check for updates') + '\n')
    process.stderr.write('Unable to fetch latest version from npm registry\n')
    process.stderr.write('\n')
    process.stderr.write('Possible causes:\n')
    process.stderr.write('  • Network connectivity issues\n')
    process.stderr.write('  • npm registry is unreachable\n')
    process.stderr.write('  • Corporate proxy/firewall blocking npm\n')
    if (MACRO.PACKAGE_URL && !MACRO.PACKAGE_URL.startsWith('@anthropic')) {
      process.stderr.write(
        '  • Internal/development build not published to npm\n',
      )
    }
    process.stderr.write('\n')
    process.stderr.write('Try:\n')
    process.stderr.write('  • Check your internet connection\n')
    process.stderr.write('  • Run with --debug flag for more details\n')
    const packageName =
      MACRO.PACKAGE_URL ||
      (process.env.USER_TYPE === 'ant'
        ? '@anthropic-ai/claude-cli'
        : '@anthropic-ai/claude-code')
    process.stderr.write(
      `  • Manually check: npm view ${packageName} version\n`,
    )

    process.stderr.write('  • Check if you need to login: npm whoami\n')
    await gracefulShutdown(1)
  }

  // Check if versions match exactly, including any build metadata (like SHA)
  if (latestVersion === MACRO.DISPLAY_VERSION) {
    writeToStdout(
      chalk.green(`OpenClaude is up to date (${MACRO.DISPLAY_VERSION})`) + '\n',
    )
    await gracefulShutdown(0)
  }

  writeToStdout(
    `New version available: ${latestVersion} (current: ${MACRO.DISPLAY_VERSION})\n`,
  )
  writeToStdout('Installing update...\n')

  // Determine update method based on what's actually running
  let useLocalUpdate = false
  let updateMethodName = ''

  const strategy = planUpdate({
    thirdPartyBlocked: false,
    installationType: diagnostic.installationType,
    nativeDistributionAvailable: hasNativeDistribution(),
    packageManager: 'unknown',
    localInstallExists:
      diagnostic.installationType === 'unknown'
        ? await localInstallationExists()
        : false,
  })

  if (strategy.action === 'npm') {
    useLocalUpdate = strategy.method === 'local'
    updateMethodName = strategy.method
    if (diagnostic.installationType === 'unknown') {
      writeToStdout(
        chalk.yellow('Warning: Could not determine installation type') + '\n',
      )
      writeToStdout(
        `Attempting ${updateMethodName} update based on file detection...\n`,
      )
    }
  } else {
    process.stderr.write(
      `Error: Cannot update ${diagnostic.installationType} installation\n`,
    )
    await gracefulShutdown(1)
  }

  writeToStdout(`Using ${updateMethodName} installation update method...\n`)

  logForDebugging(`update: Update method determined: ${updateMethodName}`)
  logForDebugging(`update: useLocalUpdate: ${useLocalUpdate}`)

  let status: InstallStatus

  if (useLocalUpdate) {
    logForDebugging(
      'update: Calling installOrUpdateClaudePackage() for local update',
    )
    status = await installOrUpdateClaudePackage(channel)
  } else {
    logForDebugging('update: Calling installGlobalPackage() for global update')
    status = await installGlobalPackage(latestVersion)
  }

  logForDebugging(`update: Installation status: ${status}`)

  switch (status) {
    case 'success':
      writeToStdout(
        chalk.green(
          `Successfully updated from ${MACRO.DISPLAY_VERSION} to version ${latestVersion}`,
        ) + '\n',
      )
      await regenerateCompletionCache()
      break
    case 'no_permissions':
      process.stderr.write(
        'Error: Insufficient permissions to install update\n',
      )
      if (useLocalUpdate) {
        process.stderr.write('Try manually updating with:\n')
        process.stderr.write(
          `  cd ~/.openclaude/local && npm update ${MACRO.PACKAGE_URL}\n`,
        )
      } else {
        process.stderr.write('Try running with sudo or fix npm permissions\n')
        process.stderr.write(getGlobalUpdateFailureHint())
      }
      await gracefulShutdown(1)
      break
    case 'termination_uncertain':
      process.stderr.write(`Error: ${UPDATE_RECOVERY_MESSAGE}\n`)
      await gracefulShutdown(1)
      break
    case 'install_failed':
      process.stderr.write('Error: Failed to install update\n')
      if (useLocalUpdate) {
        process.stderr.write('Try manually updating with:\n')
        process.stderr.write(
          `  cd ~/.openclaude/local && npm update ${MACRO.PACKAGE_URL}\n`,
        )
      } else {
        process.stderr.write(getGlobalUpdateFailureHint())
      }
      await gracefulShutdown(1)
      break
    case 'in_progress':
      process.stderr.write(
        'Error: Could not acquire the update lock\n',
      )
      process.stderr.write('Wait for any active update to finish. For interrupted updates, see the README update-lock recovery instructions.\n')
      await gracefulShutdown(1)
      break
  }
  await gracefulShutdown(0)
}
