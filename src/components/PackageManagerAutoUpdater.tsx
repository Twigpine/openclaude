import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import { useInterval } from 'usehooks-ts';
import { Text } from '../ink.js';
import { type AutoUpdaterResult, getLatestVersionFromGcs, getMaxVersion, shouldSkipVersion } from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { getPackageManager, type PackageManager } from '../utils/nativeInstaller/packageManagers.js';
import { getPackageManagerUpdateGuidance } from '../utils/packageManagerUpdateGuidance.js';
import { gt, gte } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function PackageManagerUpdateAvailableNotice({ manager }: { manager: PackageManager }) {
  const guidance = getPackageManagerUpdateGuidance(manager);
  return <Text color="warning" wrap="truncate">Update available! {guidance.message}{guidance.command && <> Run: <Text bold={true}>{guidance.command}</Text></>}</Text>;
}
export function PackageManagerAutoUpdater(t0) {
  const $ = _c(10);
  const {
    verbose
  } = t0;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [packageManager, setPackageManager] = useState("unknown");
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = async () => {
      if (isAutoUpdaterDisabled()) {
        return;
      }
      const [channel, pm] = await Promise.all([Promise.resolve(getInitialSettings()?.autoUpdatesChannel ?? "latest"), getPackageManager()]);
      setPackageManager(pm);
      let latest = await getLatestVersionFromGcs(channel);
      const maxVersion = await getMaxVersion();
      if (maxVersion && latest && gt(latest, maxVersion)) {
        logForDebugging(`PackageManagerAutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latest} to ${maxVersion}`);
        if (gte(MACRO.VERSION, maxVersion)) {
          logForDebugging(`PackageManagerAutoUpdater: current version ${MACRO.VERSION} is already at or above maxVersion ${maxVersion}, skipping update`);
          setUpdateAvailable(false);
          return;
        }
        latest = maxVersion;
      }
      const hasUpdate = latest && !gte(MACRO.VERSION, latest) && !shouldSkipVersion(latest);
      setUpdateAvailable(!!hasUpdate);
      if (hasUpdate) {
        logForDebugging(`PackageManagerAutoUpdater: Update available ${MACRO.VERSION} -> ${latest}`);
      }
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const checkForUpdates = t1;
  let t2;
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      checkForUpdates();
    };
    t3 = [checkForUpdates];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  React.useEffect(t2, t3);
  useInterval(checkForUpdates, 1800000);
  if (!updateAvailable) {
    return null;
  }
  let t4;
  if ($[3] !== verbose) {
    t4 = verbose && <Text dimColor={true} wrap="truncate">currentVersion: {MACRO.VERSION}</Text>;
    $[3] = verbose;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  let t5;
  if ($[5] !== packageManager) {
    t5 = <PackageManagerUpdateAvailableNotice manager={packageManager as PackageManager} />;
    $[5] = packageManager;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  let t6;
  if ($[7] !== t4 || $[8] !== t5) {
    t6 = <>{t4}{t5}</>;
    $[7] = t4;
    $[8] = t5;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  return t6;
}
