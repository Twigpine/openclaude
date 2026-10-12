import React, { useEffect, useRef, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { StatusIcon } from '../../components/design-system/StatusIcon.js'
import { Box, render, Text } from '../../ink.js'
import {
  getLatestVersion,
  installGlobalPackage,
} from '../../utils/autoUpdater.js'
import {
  getGlobalConfig,
  type InstallMethod,
  type ReleaseChannel,
} from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { detectGlobalPackageManager } from '../../utils/globalPackageManager.js'
import { installOrUpdateClaudePackage } from '../../utils/localInstaller.js'
import { hasNativeDistribution } from '../../utils/nativeDistribution.js'
import {
  installLatest as installLatestNative,
  removeInstalledSymlink,
} from '../../utils/nativeInstaller/index.js'
import type { PackageManager } from '../../utils/nativeInstaller/packageManagers.js'
import { getPackageManagerUpdateGuidance } from '../../utils/packageManagerUpdateGuidance.js'
import { shouldRemoveInstalledSymlinkForNpmUpdate } from '../../utils/autoUpdaterRouting.js'
import { resolveUpdateStrategy } from '../../utils/updateStrategy.js'

const PACKAGE_URL = MACRO.PACKAGE_URL
const CURRENT_VERSION = MACRO.DISPLAY_VERSION

interface UpdateProps {
  onDone: (
    result: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  force: boolean
  target: string
}

type UpdateState =
  | { type: 'checking' }
  | { type: 'blocked'; reason: 'third-party-build' | 'development' }
  | { type: 'package-manager'; manager: PackageManager }
  | { type: 'no-package-manager' }
  | { type: 'up-to-date'; version: string }
  | { type: 'updating'; version: string; via: string }
  | { type: 'success'; version: string; via: string }
  | { type: 'error'; message: string }

export function PackageManagerUpdateGuidance({
  manager,
}: {
  manager: PackageManager
}): React.ReactNode {
  const guidance = getPackageManagerUpdateGuidance(manager)
  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <StatusIcon status="warning" withSpace />
        <Text color="warning">{guidance.message}</Text>
      </Box>
      {guidance.command && (
        <Box marginLeft={2}>
          <Text dimColor>To update, run: {guidance.command}</Text>
        </Box>
      )}
    </Box>
  )
}

export async function removeStaleNativeLauncherForNpmUpdate(deps: {
  getConfig?: () => { installMethod?: InstallMethod }
  hasNativeDistribution?: () => boolean
  removeInstalledSymlink?: () => Promise<void>
} = {}): Promise<boolean> {
  const config = (deps.getConfig ?? getGlobalConfig)()
  if (
    shouldRemoveInstalledSymlinkForNpmUpdate(
      config.installMethod,
      (deps.hasNativeDistribution ?? hasNativeDistribution)(),
    )
  ) {
    await (deps.removeInstalledSymlink ?? removeInstalledSymlink)()
    return true
  }
  return false
}

function Update({ onDone, force, target }: UpdateProps): React.ReactNode {
  const [state, setState] = useState<UpdateState>({ type: 'checking' })
  // Terminal states are entered once, but guard against a double-schedule —
  // matching the onDone-guard pattern used elsewhere (e.g. REPL's doneWasCalled).
  const doneScheduled = useRef(false)

  useEffect(() => {
    async function run() {
      try {
        // Route by how the running install is actually managed, so we never
        // shadow a native/package-manager/local install with a stray global
        // npm package (and so third-party upstream builds aren't replaced).
        const strategy = await resolveUpdateStrategy()
        logForDebugging(
          `Update: strategy=${JSON.stringify(strategy)} (force=${force}, target=${target})`,
        )

        if (strategy.action === 'blocked') {
          setState({ type: 'blocked', reason: strategy.reason })
          return
        }
        if (strategy.action === 'package-manager') {
          setState({ type: 'package-manager', manager: strategy.manager })
          return
        }

        const isChannel = target === 'latest' || target === 'stable'
        const channel: ReleaseChannel = target === 'stable' ? 'stable' : 'latest'

        if (strategy.action === 'native') {
          setState({
            type: 'updating',
            version: isChannel ? channel : target,
            via: 'native build',
          })
          const result = await installLatestNative(
            isChannel ? channel : target,
            force,
          )
          if (result.lockFailed) {
            setState({
              type: 'error',
              message:
                'Another install is in progress. Try again in a moment.',
            })
            return
          }
          if (!result.latestVersion) {
            setState({ type: 'error', message: 'Failed to check for updates.' })
            return
          }
          if (result.latestVersion === CURRENT_VERSION) {
            setState({ type: 'up-to-date', version: CURRENT_VERSION })
            return
          }
          setState({
            type: 'success',
            version: result.latestVersion,
            via: 'native build',
          })
          return
        }

        // strategy.action === 'npm' — update the local or global npm install.
        // Clear stale native launchers before any early success path so the
        // next `openclaude` resolves to the npm install we are updating.
        await removeStaleNativeLauncherForNpmUpdate()

        const via =
          strategy.method === 'global'
            ? await detectGlobalPackageManager()
            : 'local install'
        if (strategy.method === 'global' && !via) {
          setState({ type: 'no-package-manager' })
          return
        }

        const resolved = isChannel ? await getLatestVersion(channel) : target
        if (
          !force &&
          isChannel &&
          resolved &&
          resolved.trim() === CURRENT_VERSION.trim()
        ) {
          setState({ type: 'up-to-date', version: resolved })
          return
        }

        const display = resolved || target
        setState({ type: 'updating', version: display, via: via as string })

        // Reuse the shared installers: each holds the update lock, checks
        // permissions, cleans up old aliases, and records installMethod.
        const status =
          strategy.method === 'local'
            ? await installOrUpdateClaudePackage(
                channel,
                isChannel ? null : target,
              )
            : await installGlobalPackage(target === 'latest' ? null : target)

        switch (status) {
          case 'success':
            setState({ type: 'success', version: display, via: via as string })
            break
          case 'no_permissions':
            setState({
              type: 'error',
              message:
                'Insufficient permissions for the install. Re-run with the right permissions (e.g. sudo) or fix your install directory ownership.',
            })
            break
          case 'in_progress':
            setState({
              type: 'error',
              message:
                'Another update is already in progress. Try again in a moment.',
            })
            break
          default:
            setState({
              type: 'error',
              message: 'Install failed. Run with --debug for details.',
            })
        }
      } catch (error) {
        logForDebugging(`Update command failed: ${error}`, { level: 'error' })
        setState({ type: 'error', message: errorMessage(error) })
      }
    }
    void run()
  }, [force, target])

  useEffect(() => {
    if (doneScheduled.current || state.type === 'checking' || state.type === 'updating') {
      return
    }
    doneScheduled.current = true
    const { message, delay } = terminalDoneMessage(state)
    setTimeout(onDone, delay, message, { display: 'system' as const })
  }, [state, onDone])

  return (
    <Box flexDirection="column" marginTop={1}>
      {state.type === 'checking' && (
        <Text color="claude">
          Detecting installation type and checking for updates...
        </Text>
      )}

      {state.type === 'blocked' && (
        <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="warning" withSpace />
            <Text color="warning">
              {state.reason === 'development'
                ? 'Auto-update is unavailable for a development build.'
                : 'Auto-update is unavailable for third-party provider builds.'}
            </Text>
          </Box>
          {state.reason === 'development' && (
            <Box marginLeft={2}>
              <Text dimColor>
                Update from source: git pull && bun install && bun run build
              </Text>
            </Box>
          )}
          <Box marginLeft={2}>
            <Text dimColor>
              Or reinstall: npm install -g {PACKAGE_URL}@latest
            </Text>
          </Box>
        </Box>
      )}

      {state.type === 'package-manager' && (
        <PackageManagerUpdateGuidance manager={state.manager} />
      )}

      {state.type === 'no-package-manager' && (
        <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="error" withSpace />
            <Text color="error">No supported package manager found</Text>
          </Box>
          <Text dimColor>
            Install npm, pnpm, yarn, or bun, then run /update again.
          </Text>
        </Box>
      )}

      {state.type === 'up-to-date' && (
        <Box>
          <StatusIcon status="success" withSpace />
          <Text color="success">
            Already on the latest version ({state.version}).
          </Text>
        </Box>
      )}

      {state.type === 'updating' && (
        <Text color="claude">
          Updating OpenClaude to {state.version} via {state.via} (this may take a
          moment)...
        </Text>
      )}

      {state.type === 'success' && (
        <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="success" withSpace />
            <Text color="success" bold>
              OpenClaude updated to {state.version} via {state.via}!
            </Text>
          </Box>
          <Box marginLeft={2}>
            <Text dimColor>
              Restart OpenClaude for the new version to take effect.
            </Text>
          </Box>
        </Box>
      )}

      {state.type === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="error" withSpace />
            <Text color="error">Update failed</Text>
          </Box>
          <Text color="error">{state.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>
              You can update manually, e.g. npm install -g {PACKAGE_URL}@latest
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

// The user-visible system message + dwell time for each terminal state.
function terminalDoneMessage(state: UpdateState): {
  message: string
  delay: number
} {
  switch (state.type) {
    case 'success':
      return { message: 'OpenClaude updated successfully', delay: 3000 }
    case 'up-to-date':
      return { message: 'OpenClaude is already up to date', delay: 1500 }
    case 'blocked':
      return { message: 'Auto-update is unavailable for this build', delay: 3000 }
    case 'package-manager':
      return {
        message: 'OpenClaude is managed by a package manager',
        delay: 3000,
      }
    case 'no-package-manager':
      return { message: 'No supported package manager found', delay: 3000 }
    case 'error':
      return { message: 'OpenClaude update failed', delay: 4000 }
    default:
      return { message: '', delay: 0 }
  }
}

export async function call(
  onDone: (result: string, options?: { display?: CommandResultDisplay }) => void,
  _context: unknown,
  args: string,
): Promise<React.ReactNode> {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const force = tokens.includes('--force')
  const nonFlag = tokens.filter(token => !token.startsWith('--'))
  const target = nonFlag[0] || 'latest'

  const { unmount } = await render(
    <Update
      onDone={(result, options) => {
        unmount()
        onDone(result, options)
      }}
      force={force}
      target={target}
    />,
  )
  return null
}
