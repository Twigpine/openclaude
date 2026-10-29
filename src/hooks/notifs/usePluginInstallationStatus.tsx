import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useEffect } from 'react';
import { getIsRemoteMode } from '../../bootstrap/state.js';
import { useNotifications } from '../../context/notifications.js';
import { Text } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { logForDebugging } from '../../utils/debug.js';
import { plural } from '../../utils/stringUtils.js';
export function usePluginInstallationStatus() {
  const $ = _c(20);
  const {
    addNotification
  } = useNotifications();
  const installationStatus = useAppState(_temp);
  let t0;
  bb0: {
    if (!installationStatus) {
      let t1;
      if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = {
          totalFailed: 0,
          failedMarketplacesCount: 0,
          failedPluginsCount: 0
        };
        $[0] = t1;
      } else {
        t1 = $[0];
      }
      t0 = t1;
      break bb0;
    }
    let t1;
    if ($[1] !== installationStatus.marketplaces) {
      t1 = installationStatus.marketplaces.filter(_temp2);
      $[1] = installationStatus.marketplaces;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    const failedMarketplaces = t1;
    let t2;
    if ($[3] !== installationStatus.plugins) {
      t2 = installationStatus.plugins.filter(_temp3);
      $[3] = installationStatus.plugins;
      $[4] = t2;
    } else {
      t2 = $[4];
    }
    const failedPlugins = t2;
    const t3 = failedMarketplaces.length + failedPlugins.length;
    let t4;
    if ($[5] !== failedMarketplaces.length || $[6] !== failedPlugins.length || $[7] !== t3) {
      t4 = {
        totalFailed: t3,
        failedMarketplacesCount: failedMarketplaces.length,
        failedPluginsCount: failedPlugins.length
      };
      $[5] = failedMarketplaces.length;
      $[6] = failedPlugins.length;
      $[7] = t3;
      $[8] = t4;
    } else {
      t4 = $[8];
    }
    t0 = t4;
  }
  const {
    totalFailed,
    failedMarketplacesCount,
    failedPluginsCount
  } = t0;
  let t1;
  if ($[9] !== addNotification || $[10] !== failedMarketplacesCount || $[11] !== failedPluginsCount || $[12] !== installationStatus || $[13] !== totalFailed) {
    t1 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (!installationStatus) {
        logForDebugging("No installation status to monitor");
        return;
      }
      if (totalFailed === 0) {
        return;
      }
      logForDebugging(`Plugin installation status: ${failedMarketplacesCount} failed marketplaces, ${failedPluginsCount} failed plugins`);
      if (totalFailed === 0) {
        return;
      }
      logForDebugging(`Adding notification for ${totalFailed} failed installations`);
      addNotification({
        key: "plugin-install-failed",
        jsx: <><Text color="error">{totalFailed} {plural(totalFailed, "plugin")} failed to install</Text><Text dimColor={true}> · /plugin for details</Text></>,
        priority: "medium"
      });
    };
    $[9] = addNotification;
    $[10] = failedMarketplacesCount;
    $[11] = failedPluginsCount;
    $[12] = installationStatus;
    $[13] = totalFailed;
    $[14] = t1;
  } else {
    t1 = $[14];
  }
  let t2;
  if ($[15] !== addNotification || $[16] !== failedMarketplacesCount || $[17] !== failedPluginsCount || $[18] !== totalFailed) {
    t2 = [addNotification, totalFailed, failedMarketplacesCount, failedPluginsCount];
    $[15] = addNotification;
    $[16] = failedMarketplacesCount;
    $[17] = failedPluginsCount;
    $[18] = totalFailed;
    $[19] = t2;
  } else {
    t2 = $[19];
  }
  useEffect(t1, t2);
}
function _temp3(p) {
  return p.status === "failed";
}
function _temp2(m) {
  return m.status === "failed";
}
function _temp(s) {
  return s.plugins.installationStatus;
}
