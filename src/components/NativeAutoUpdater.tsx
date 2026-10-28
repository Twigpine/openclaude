import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { logError } from 'src/utils/log.js';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '../ink.js';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { installLatest } from '../utils/nativeInstaller/index.js';
import { getInitialSettings } from '../utils/settings/settings.js';

/**
 * Categorize error messages for analytics
 */
function getErrorType(errorMessage: string): string {
  if (errorMessage.includes('timeout')) {
    return 'timeout';
  }
  if (errorMessage.includes('Checksum mismatch')) {
    return 'checksum_mismatch';
  }
  if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
    return 'not_found';
  }
  if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
    return 'permission_denied';
  }
  if (errorMessage.includes('ENOSPC')) {
    return 'disk_full';
  }
  if (errorMessage.includes('npm')) {
    return 'npm_error';
  }
  if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
    return 'network_error';
  }
  return 'unknown';
}
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
type NativeAutoUpdaterVersions = {
  current?: string | null;
  latest?: string | null;
};
export function shouldRenderNativeAutoUpdater(autoUpdaterResult: AutoUpdaterResult | null, isUpdating: boolean, versions: NativeAutoUpdaterVersions): boolean {
  const hasUpdateResult = autoUpdaterResult?.status === 'success' || autoUpdaterResult?.status === 'install_failed';
  const hasVersionInfo = !!versions.current && !!versions.latest;
  return hasUpdateResult || (isUpdating && hasVersionInfo);
}
export function NativeAutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    current?: string | null;
    latest?: string | null;
  }>({});
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);
  const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest';

  // Track latest isUpdating value in a ref so the memoized checkForUpdates
  // callback always sees the current value without changing callback identity
  // (which would re-trigger the initial-check useEffect below and cause
  // repeated downloads on remount — the upstream trigger for #22413).
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;
  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }
    if (isAutoUpdaterDisabled()) {
      return;
    }
    onChangeIsUpdating(true);
    const startTime = Date.now();

    // Log the start of an auto-update check for funnel analysis
    logEvent('tengu_native_auto_updater_start', {});
    try {
      const result = await installLatest(channel);
      const currentVersion = MACRO.VERSION;
      const latencyMs = Date.now() - startTime;

      // Handle lock contention gracefully - just return without treating as error
      if (result.lockFailed) {
        logEvent('tengu_native_auto_updater_lock_contention', {
          latency_ms: latencyMs
        });
        return; // Silently skip this update check, will try again later
      }

      // Update versions for display
      setVersions({
        current: currentVersion,
        latest: result.latestVersion
      });
      if (result.wasUpdated) {
        logEvent('tengu_native_auto_updater_success', {
          latency_ms: latencyMs
        });
        onAutoUpdaterResult({
          version: result.latestVersion,
          status: 'success'
        });
      } else {
        // Already up to date
        logEvent('tengu_native_auto_updater_up_to_date', {
          latency_ms: latencyMs
        });
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError(error);
      const errorType = getErrorType(errorMessage);
      logEvent('tengu_native_auto_updater_fail', {
        latency_ms: latencyMs,
        error_timeout: errorType === 'timeout',
        error_checksum: errorType === 'checksum_mismatch',
        error_not_found: errorType === 'not_found',
        error_permission: errorType === 'permission_denied',
        error_disk_full: errorType === 'disk_full',
        error_npm: errorType === 'npm_error',
        error_network: errorType === 'network_error'
      });
      onAutoUpdaterResult({
        version: null,
        status: 'install_failed'
      });
    } finally {
      onChangeIsUpdating(false);
    }
    // isUpdating intentionally omitted from deps; we read isUpdatingRef
    // instead so the guard is always current without changing callback
    // identity (which would re-trigger the initial-check useEffect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: isUpdating read via ref
  }, [onAutoUpdaterResult, channel]);

  // Initial check
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // Check every 30 minutes
  useInterval(checkForUpdates, 30 * 60 * 1000);
  // Show the component when:
  // - there's an update result to display (success/error), or
  // - actively checking and we have version info to show
  const shouldRender = shouldRenderNativeAutoUpdater(autoUpdaterResult, isUpdating, versions);
  if (!shouldRender) {
    return null;
  }
  return <Box flexDirection="row" gap={1}>
      {verbose && <Text dimColor wrap="truncate">
          current: {versions.current} &middot; {channel}: {versions.latest}
        </Text>}
      {isUpdating ? <Box>
          <Text dimColor wrap="truncate">
            Checking for updates
          </Text>
        </Box> : autoUpdaterResult?.status === 'success' && showSuccessMessage && updateSemver && <Text color="success" wrap="truncate">
            ✓ Update installed · Restart to update
          </Text>}
      {autoUpdaterResult?.status === 'install_failed' && <Text color="error" wrap="truncate">
          ✗ Auto-update failed &middot; Try <Text bold>/status</Text>
        </Text>}
    </Box>;
}
