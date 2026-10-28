import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '../../components/design-system/Byline.js';
import { Pane } from '../../components/design-system/Pane.js';
import { Tab, Tabs } from '../../components/design-system/Tabs.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { PluginError } from '../../types/plugin.js';
import { errorMessage } from '../../utils/errors.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { loadMarketplacesWithGracefulDegradation } from '../../utils/plugins/marketplaceHelpers.js';
import { loadKnownMarketplacesConfig, removeMarketplaceSource } from '../../utils/plugins/marketplaceManager.js';
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js';
import type { EditableSettingSource } from '../../utils/settings/constants.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { AddMarketplace } from './AddMarketplace.js';
import { BrowseMarketplace } from './BrowseMarketplace.js';
import { DiscoverPlugins } from './DiscoverPlugins.js';
import { ManageMarketplaces } from './ManageMarketplaces.js';
import { ManagePlugins } from './ManagePlugins.js';
import { formatErrorMessage, getErrorGuidance } from './PluginErrors.js';
import { type ParsedCommand, parsePluginArgs } from './parseArgs.js';
import type { PluginSettingsProps, ViewState } from './types.js';
import { ValidatePlugin } from './ValidatePlugin.js';
type TabId = 'discover' | 'installed' | 'marketplaces' | 'errors';
type MarketplaceLoadFailure = {
  name: string;
  error: string;
};
type ErrorsTabContentProps = {
  setViewState: (state: ViewState) => void;
  setActiveTab: (tab: TabId) => void;
  markPluginsChanged: () => void | Promise<void>;
};
function MarketplaceList(t0: Pick<PluginSettingsProps, 'onComplete'>): React.ReactNode {
  const $ = _c(4);
  const {
    onComplete
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onComplete) {
    t1 = () => {
      const loadList = async function loadList() {
        ;
        try {
          const config = await loadKnownMarketplacesConfig();
          const names = Object.keys(config);
          if (names.length === 0) {
            onComplete("No marketplaces configured");
          } else {
            onComplete(`Configured marketplaces:\n${names.map(_temp).join("\n")}`);
          }
        } catch (t3) {
          const err = t3;
          onComplete(`Error loading marketplaces: ${errorMessage(err)}`);
        }
      };
      loadList();
    };
    t2 = [onComplete];
    $[0] = onComplete;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  useEffect(t1, t2);
  let t3;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text>Loading marketplaces...</Text>;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  return t3;
}
function _temp(n) {
  return `  • ${n}`;
}
function McpRedirectBanner() {
  return null;
}
type ErrorRowAction = {
  kind: 'navigate';
  tab: TabId;
  viewState: ViewState;
} | {
  kind: 'remove-extra-marketplace';
  name: string;
  sources: Array<{
    source: EditableSettingSource;
    scope: string;
  }>;
} | {
  kind: 'remove-installed-marketplace';
  name: string;
} | {
  kind: 'managed-only';
  name: string;
} | {
  kind: 'none';
};
type ErrorRow = {
  label: string;
  message: string;
  guidance?: string | null;
  action: ErrorRowAction;
  scope?: string;
};

/**
 * Determine which settings sources define an extraKnownMarketplace entry.
 * Returns the editable sources (user/project/local) and whether policy also has it.
 */
function getExtraMarketplaceSourceInfo(name: string): {
  editableSources: Array<{
    source: EditableSettingSource;
    scope: string;
  }>;
  isInPolicy: boolean;
} {
  const editableSources: Array<{
    source: EditableSettingSource;
    scope: string;
  }> = [];
  const sourcesToCheck = [{
    source: 'userSettings' as const,
    scope: 'user'
  }, {
    source: 'projectSettings' as const,
    scope: 'project'
  }, {
    source: 'localSettings' as const,
    scope: 'local'
  }];
  for (const {
    source,
    scope
  } of sourcesToCheck) {
    const settings = getSettingsForSource(source);
    if (settings?.extraKnownMarketplaces?.[name]) {
      editableSources.push({
        source,
        scope
      });
    }
  }
  const policySettings = getSettingsForSource('policySettings');
  const isInPolicy = Boolean(policySettings?.extraKnownMarketplaces?.[name]);
  return {
    editableSources,
    isInPolicy
  };
}
function buildMarketplaceAction(name: string): ErrorRowAction {
  const {
    editableSources,
    isInPolicy
  } = getExtraMarketplaceSourceInfo(name);
  if (editableSources.length > 0) {
    return {
      kind: 'remove-extra-marketplace',
      name,
      sources: editableSources
    };
  }
  if (isInPolicy) {
    return {
      kind: 'managed-only',
      name
    };
  }

  // Marketplace is in known_marketplaces.json but not in extraKnownMarketplaces
  // (e.g. previously installed manually) — route to ManageMarketplaces
  return {
    kind: 'navigate',
    tab: 'marketplaces',
    viewState: {
      type: 'manage-marketplaces',
      targetMarketplace: name,
      action: 'remove'
    }
  };
}
function buildPluginAction(pluginName: string): ErrorRowAction {
  return {
    kind: 'navigate',
    tab: 'installed',
    viewState: {
      type: 'manage-plugins',
      targetPlugin: pluginName,
      action: 'uninstall'
    }
  };
}
const TRANSIENT_ERROR_TYPES = new Set(['git-auth-failed', 'git-timeout', 'network-error']);
function isTransientError(error: PluginError): boolean {
  return TRANSIENT_ERROR_TYPES.has(error.type);
}

/**
 * Extract the plugin name from a PluginError, checking explicit fields first,
 * then falling back to the source field (format: "pluginName@marketplace").
 */
function getPluginNameFromError(error: PluginError): string | undefined {
  if ('pluginId' in error && error.pluginId) return error.pluginId;
  if ('plugin' in error && error.plugin) return error.plugin;
  // Fallback: source often contains "pluginName@marketplace"
  if (error.source.includes('@')) return error.source.split('@')[0];
  return undefined;
}
function buildErrorRows(failedMarketplaces: Array<{
  name: string;
  error?: string;
}>, extraMarketplaceErrors: PluginError[], pluginLoadingErrors: PluginError[], otherErrors: PluginError[], brokenInstalledMarketplaces: Array<{
  name: string;
  error: string;
}>, transientErrors: PluginError[], pluginScopes: Map<string, string>): ErrorRow[] {
  const rows: ErrorRow[] = [];

  // --- Transient errors at the top (restart to retry) ---
  for (const error of transientErrors) {
    const pluginName = 'pluginId' in error ? error.pluginId : 'plugin' in error ? error.plugin : undefined;
    rows.push({
      label: pluginName ?? error.source,
      message: formatErrorMessage(error),
      guidance: 'Restart to retry loading plugins',
      action: {
        kind: 'none'
      }
    });
  }

  // --- Marketplace errors ---
  // Track shown marketplace names to avoid duplicates across sources
  const shownMarketplaceNames = new Set<string>();
  for (const m of failedMarketplaces) {
    shownMarketplaceNames.add(m.name);
    const action = buildMarketplaceAction(m.name);
    const sourceInfo = getExtraMarketplaceSourceInfo(m.name);
    const scope = sourceInfo.isInPolicy ? 'managed' : sourceInfo.editableSources[0]?.scope;
    rows.push({
      label: m.name,
      message: m.error ?? 'Installation failed',
      guidance: action.kind === 'managed-only' ? 'Managed by your organization — contact your admin' : undefined,
      action,
      scope
    });
  }
  for (const e of extraMarketplaceErrors) {
    const marketplace = 'marketplace' in e ? e.marketplace : e.source;
    if (shownMarketplaceNames.has(marketplace)) continue;
    shownMarketplaceNames.add(marketplace);
    const action = buildMarketplaceAction(marketplace);
    const sourceInfo = getExtraMarketplaceSourceInfo(marketplace);
    const scope = sourceInfo.isInPolicy ? 'managed' : sourceInfo.editableSources[0]?.scope;
    rows.push({
      label: marketplace,
      message: formatErrorMessage(e),
      guidance: action.kind === 'managed-only' ? 'Managed by your organization — contact your admin' : getErrorGuidance(e),
      action,
      scope
    });
  }

  // Installed marketplaces that fail to load data (from known_marketplaces.json)
  for (const m of brokenInstalledMarketplaces) {
    if (shownMarketplaceNames.has(m.name)) continue;
    shownMarketplaceNames.add(m.name);
    rows.push({
      label: m.name,
      message: m.error,
      action: {
        kind: 'remove-installed-marketplace',
        name: m.name
      }
    });
  }

  // --- Plugin errors ---
  const shownPluginNames = new Set<string>();
  for (const error of pluginLoadingErrors) {
    const pluginName = getPluginNameFromError(error);
    if (pluginName && shownPluginNames.has(pluginName)) continue;
    if (pluginName) shownPluginNames.add(pluginName);
    const marketplace = 'marketplace' in error ? error.marketplace : undefined;
    // Try pluginId@marketplace format first, then just pluginName
    const scope = pluginName ? pluginScopes.get(error.source) ?? pluginScopes.get(pluginName) : undefined;
    rows.push({
      label: pluginName ? marketplace ? `${pluginName} @ ${marketplace}` : pluginName : error.source,
      message: formatErrorMessage(error),
      guidance: getErrorGuidance(error),
      action: pluginName ? buildPluginAction(pluginName) : {
        kind: 'none'
      },
      scope
    });
  }

  // --- Other errors (non-marketplace, non-plugin-specific) ---
  for (const error of otherErrors) {
    rows.push({
      label: error.source,
      message: formatErrorMessage(error),
      guidance: getErrorGuidance(error),
      action: {
        kind: 'none'
      }
    });
  }
  return rows;
}

/**
 * Remove a marketplace from extraKnownMarketplaces in the given settings sources,
 * and also remove any associated enabled plugins.
 */
function removeExtraMarketplace(name: string, sources: Array<{
  source: EditableSettingSource;
}>): void {
  for (const {
    source
  } of sources) {
    const settings = getSettingsForSource(source);
    if (!settings) continue;
    const updates: Record<string, unknown> = {};

    // Remove from extraKnownMarketplaces
    if (settings.extraKnownMarketplaces?.[name]) {
      updates.extraKnownMarketplaces = {
        ...settings.extraKnownMarketplaces,
        [name]: undefined
      };
    }

    // Remove associated enabled plugins (format: "plugin@marketplace")
    if (settings.enabledPlugins) {
      const suffix = `@${name}`;
      let removedPlugins = false;
      const updatedPlugins: Record<string, boolean | string[] | undefined> = {
        ...settings.enabledPlugins
      };
      for (const pluginId in updatedPlugins) {
        if (pluginId.endsWith(suffix)) {
          updatedPlugins[pluginId] = undefined;
          removedPlugins = true;
        }
      }
      if (removedPlugins) {
        updates.enabledPlugins = updatedPlugins;
      }
    }
    if (Object.keys(updates).length > 0) {
      updateSettingsForSource(source, updates);
    }
  }
}
function ErrorsTabContent(t0: ErrorsTabContentProps): React.ReactNode {
  const $ = _c(26);
  const {
    setViewState,
    setActiveTab,
    markPluginsChanged
  } = t0;
  const errors = useAppState(_temp2);
  const installationStatus = useAppState(_temp3);
  const setAppState = useSetAppState();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [] as MarketplaceLoadFailure[];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [marketplaceLoadFailures, setMarketplaceLoadFailures] = useState<MarketplaceLoadFailure[]>(t1);
  let t2;
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      (async () => {
        try {
          const config = await loadKnownMarketplacesConfig();
          const {
            failures
          } = await loadMarketplacesWithGracefulDegradation(config);
          setMarketplaceLoadFailures(failures);
        } catch {}
      })();
    };
    t3 = [];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  useEffect(t2, t3);
  const failedMarketplaces = installationStatus.marketplaces.filter(_temp4);
  const failedMarketplaceNames = new Set(failedMarketplaces.map(_temp5));
  const transientErrors = errors.filter(isTransientError);
  const extraMarketplaceErrors = errors.filter(e => (e.type === "marketplace-not-found" || e.type === "marketplace-load-failed" || e.type === "marketplace-blocked-by-policy") && !failedMarketplaceNames.has(e.marketplace));
  const pluginLoadingErrors = errors.filter(_temp6);
  const otherErrors = errors.filter(_temp7);
  const pluginScopes = getPluginEditableScopes();
  const rows = buildErrorRows(failedMarketplaces, extraMarketplaceErrors, pluginLoadingErrors, otherErrors, marketplaceLoadFailures, transientErrors, pluginScopes);
  let t4;
  if ($[3] !== setViewState) {
    t4 = () => {
      setViewState({
        type: "menu"
      });
    };
    $[3] = setViewState;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  let t5;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      context: "Confirmation"
    };
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  useKeybinding("confirm:no", t4, t5);
  const handleSelect = () => {
    const row = rows[selectedIndex];
    if (!row) {
      return;
    }
    const {
      action
    } = row;
    bb77: switch (action.kind) {
      case "navigate":
        {
          setActiveTab(action.tab);
          setViewState(action.viewState);
          break bb77;
        }
      case "remove-extra-marketplace":
        {
          const scopes = action.sources.map(_temp8).join(", ");
          removeExtraMarketplace(action.name, action.sources);
          clearAllCaches();
          setAppState(prev_0 => ({
            ...prev_0,
            plugins: {
              ...prev_0.plugins,
              errors: prev_0.plugins.errors.filter(e_2 => !("marketplace" in e_2 && e_2.marketplace === action.name)),
              installationStatus: {
                ...prev_0.plugins.installationStatus,
                marketplaces: prev_0.plugins.installationStatus.marketplaces.filter(m_1 => m_1.name !== action.name)
              }
            }
          }));
          setActionMessage(`${figures.tick} Removed "${action.name}" from ${scopes} settings`);
          markPluginsChanged();
          break bb77;
        }
      case "remove-installed-marketplace":
        {
          (async () => {
            ;
            try {
              await removeMarketplaceSource(action.name);
              clearAllCaches();
              setMarketplaceLoadFailures(prev => prev.filter(f => f.name !== action.name));
              setActionMessage(`${figures.tick} Removed marketplace "${action.name}"`);
              markPluginsChanged();
            } catch (t6) {
              const err = t6;
              setActionMessage(`Failed to remove "${action.name}": ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
          break bb77;
        }
      case "managed-only":
        {
          break bb77;
        }
      case "none":
    }
  };
  let t7;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = () => setSelectedIndex(_temp9);
    $[6] = t7;
  } else {
    t7 = $[6];
  }
  const t8 = rows.length > 0;
  let t9;
  if ($[7] !== t8) {
    t9 = {
      context: "Select",
      isActive: t8
    };
    $[7] = t8;
    $[8] = t9;
  } else {
    t9 = $[8];
  }
  useKeybindings({
    "select:previous": t7,
    "select:next": () => setSelectedIndex(prev_2 => Math.min(rows.length - 1, prev_2 + 1)),
    "select:accept": handleSelect
  }, t9);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1));
  if (clampedIndex !== selectedIndex) {
    setSelectedIndex(clampedIndex);
  }
  const selectedAction = rows[clampedIndex]?.action;
  const hasAction = selectedAction && selectedAction.kind !== "none" && selectedAction.kind !== "managed-only";
  if (rows.length === 0) {
    let t10;
    if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
      t10 = <Box marginLeft={1}><Text dimColor={true}>No plugin errors</Text></Box>;
      $[9] = t10;
    } else {
      t10 = $[9];
    }
    let t11;
    if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
      t11 = <Box flexDirection="column">{t10}<Box marginTop={1}><Text dimColor={true} italic={true}><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" /></Text></Box></Box>;
      $[10] = t11;
    } else {
      t11 = $[10];
    }
    return t11;
  }
  const T0 = Box;
  const t10 = "column";
  let t11;
  if ($[11] !== clampedIndex) {
    t11 = (row_0, idx) => {
      const isSelected = idx === clampedIndex;
      return <Box key={idx} marginLeft={1} flexDirection="column" marginBottom={1}><Text><Text color={isSelected ? "suggestion" : "error"}>{isSelected ? figures.pointer : figures.cross}{" "}</Text><Text bold={isSelected}>{row_0.label}</Text>{row_0.scope && <Text dimColor={true}> ({row_0.scope})</Text>}</Text><Box marginLeft={3}><Text color="error">{row_0.message}</Text></Box>{row_0.guidance && <Box marginLeft={3}><Text dimColor={true} italic={true}>{row_0.guidance}</Text></Box>}</Box>;
    };
    $[11] = clampedIndex;
    $[12] = t11;
  } else {
    t11 = $[12];
  }
  const t12 = rows.map(t11);
  let t13;
  if ($[13] !== actionMessage) {
    t13 = actionMessage && <Box marginTop={1} marginLeft={1}><Text color="claude">{actionMessage}</Text></Box>;
    $[13] = actionMessage;
    $[14] = t13;
  } else {
    t13 = $[14];
  }
  let t14;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t14 = <ConfigurableShortcutHint action="select:previous" context="Select" fallback={"\u2191"} description="navigate" />;
    $[15] = t14;
  } else {
    t14 = $[15];
  }
  let t15;
  if ($[16] !== hasAction) {
    t15 = hasAction && <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="resolve" />;
    $[16] = hasAction;
    $[17] = t15;
  } else {
    t15 = $[17];
  }
  let t16;
  if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
    t16 = <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />;
    $[18] = t16;
  } else {
    t16 = $[18];
  }
  let t17;
  if ($[19] !== t15) {
    t17 = <Box marginTop={1}><Text dimColor={true} italic={true}><Byline>{t14}{t15}{t16}</Byline></Text></Box>;
    $[19] = t15;
    $[20] = t17;
  } else {
    t17 = $[20];
  }
  let t18;
  if ($[21] !== T0 || $[22] !== t12 || $[23] !== t13 || $[24] !== t17) {
    t18 = <T0 flexDirection={t10}>{t12}{t13}{t17}</T0>;
    $[21] = T0;
    $[22] = t12;
    $[23] = t13;
    $[24] = t17;
    $[25] = t18;
  } else {
    t18 = $[25];
  }
  return t18;
}
function _temp9(prev_1) {
  return Math.max(0, prev_1 - 1);
}
function _temp8(s_1) {
  return s_1.scope;
}
function _temp7(e_1) {
  if (isTransientError(e_1)) {
    return false;
  }
  if (e_1.type === "marketplace-not-found" || e_1.type === "marketplace-load-failed" || e_1.type === "marketplace-blocked-by-policy") {
    return false;
  }
  return getPluginNameFromError(e_1) === undefined;
}
function _temp6(e_0) {
  if (isTransientError(e_0)) {
    return false;
  }
  if (e_0.type === "marketplace-not-found" || e_0.type === "marketplace-load-failed" || e_0.type === "marketplace-blocked-by-policy") {
    return false;
  }
  return getPluginNameFromError(e_0) !== undefined;
}
function _temp5(m_0) {
  return m_0.name;
}
function _temp4(m) {
  return m.status === "failed";
}
function _temp3(s_0) {
  return s_0.plugins.installationStatus;
}
function _temp2(s) {
  return s.plugins.errors;
}
function getInitialViewState(parsedCommand: ParsedCommand): ViewState {
  switch (parsedCommand.type) {
    case 'help':
      return {
        type: 'help'
      };
    case 'validate':
      return {
        type: 'validate',
        path: parsedCommand.path
      };
    case 'install':
      if (parsedCommand.marketplace) {
        return {
          type: 'browse-marketplace',
          targetMarketplace: parsedCommand.marketplace,
          targetPlugin: parsedCommand.plugin
        };
      }
      if (parsedCommand.plugin) {
        return {
          type: 'discover-plugins',
          targetPlugin: parsedCommand.plugin
        };
      }
      return {
        type: 'discover-plugins'
      };
    case 'manage':
      return {
        type: 'manage-plugins'
      };
    case 'uninstall':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'uninstall'
      };
    case 'enable':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'enable'
      };
    case 'disable':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'disable'
      };
    case 'marketplace':
      if (parsedCommand.action === 'list') {
        return {
          type: 'marketplace-list'
        };
      }
      if (parsedCommand.action === 'add') {
        return {
          type: 'add-marketplace',
          initialValue: parsedCommand.target
        };
      }
      if (parsedCommand.action === 'remove') {
        return {
          type: 'manage-marketplaces',
          targetMarketplace: parsedCommand.target,
          action: 'remove'
        };
      }
      if (parsedCommand.action === 'update') {
        return {
          type: 'manage-marketplaces',
          targetMarketplace: parsedCommand.target,
          action: 'update'
        };
      }
      return {
        type: 'marketplace-menu'
      };
    case 'menu':
    default:
      // Default to discover view showing all plugins
      return {
        type: 'discover-plugins'
      };
  }
}
function getInitialTab(viewState: ViewState): TabId {
  if (viewState.type === 'manage-plugins') return 'installed';
  if (viewState.type === 'manage-marketplaces') return 'marketplaces';
  return 'discover';
}
export function PluginSettings(t0: PluginSettingsProps): React.ReactNode {
  const $ = _c(75);
  const {
    onComplete,
    args,
    showMcpRedirectMessage
  } = t0;
  let parsedCommand;
  let t1;
  if ($[0] !== args) {
    parsedCommand = parsePluginArgs(args);
    t1 = getInitialViewState(parsedCommand);
    $[0] = args;
    $[1] = parsedCommand;
    $[2] = t1;
  } else {
    parsedCommand = $[1];
    t1 = $[2];
  }
  const initialViewState = t1 as ViewState;
  const [viewState, setViewState] = useState<ViewState>(initialViewState);
  let t2;
  if ($[3] !== initialViewState) {
    t2 = getInitialTab(initialViewState);
    $[3] = initialViewState;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const [activeTab, setActiveTab] = useState<TabId>(t2 as TabId);
  const [inputValue, setInputValue] = useState(viewState.type === "add-marketplace" ? viewState.initialValue || "" : "");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [childSearchActive, setChildSearchActive] = useState(false);
  const setAppState = useSetAppState();
  const pluginErrorCount = useAppState(_temp0);
  const errorsTabTitle = pluginErrorCount > 0 ? `Errors (${pluginErrorCount})` : "Errors";
  const exitState = useExitOnCtrlCDWithKeybindings();
  const cliMode = parsedCommand.type === "marketplace" && parsedCommand.action === "add" && parsedCommand.target !== undefined;
  let t3;
  if ($[5] !== setAppState) {
    t3 = () => {
      setAppState(_temp1);
    };
    $[5] = setAppState;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  const markPluginsChanged = t3;
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = tabId => {
      const tab = tabId as TabId;
      setActiveTab(tab);
      setError(null);
      bb37: switch (tab) {
        case "discover":
          {
            setViewState({
              type: "discover-plugins"
            });
            break bb37;
          }
        case "installed":
          {
            setViewState({
              type: "manage-plugins"
            });
            break bb37;
          }
        case "marketplaces":
          {
            setViewState({
              type: "manage-marketplaces"
            });
            break bb37;
          }
        case "errors":
      }
    };
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  const handleTabChange = t4;
  let t5;
  let t6;
  if ($[8] !== onComplete || $[9] !== result || $[10] !== viewState.type) {
    t5 = () => {
      if (viewState.type === "menu" && !result) {
        onComplete();
      }
    };
    t6 = [viewState.type, result, onComplete];
    $[8] = onComplete;
    $[9] = result;
    $[10] = viewState.type;
    $[11] = t5;
    $[12] = t6;
  } else {
    t5 = $[11];
    t6 = $[12];
  }
  useEffect(t5, t6);
  let t7;
  let t8;
  if ($[13] !== activeTab || $[14] !== viewState.type) {
    t7 = () => {
      if (viewState.type === "browse-marketplace" && activeTab !== "discover") {
        setActiveTab("discover");
      }
    };
    t8 = [viewState.type, activeTab];
    $[13] = activeTab;
    $[14] = viewState.type;
    $[15] = t7;
    $[16] = t8;
  } else {
    t7 = $[15];
    t8 = $[16];
  }
  useEffect(t7, t8);
  let t9;
  if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
    t9 = () => {
      setActiveTab("marketplaces");
      setViewState({
        type: "manage-marketplaces"
      });
      setInputValue("");
      setError(null);
    };
    $[17] = t9;
  } else {
    t9 = $[17];
  }
  const handleAddMarketplaceEscape = t9;
  const t10 = viewState.type === "add-marketplace";
  let t11;
  if ($[18] !== t10) {
    t11 = {
      context: "Settings",
      isActive: t10
    };
    $[18] = t10;
    $[19] = t11;
  } else {
    t11 = $[19];
  }
  useKeybinding("confirm:no", handleAddMarketplaceEscape, t11);
  let t12;
  let t13;
  if ($[20] !== onComplete || $[21] !== result) {
    t12 = () => {
      if (result) {
        onComplete(result);
      }
    };
    t13 = [result, onComplete];
    $[20] = onComplete;
    $[21] = result;
    $[22] = t12;
    $[23] = t13;
  } else {
    t12 = $[22];
    t13 = $[23];
  }
  useEffect(t12, t13);
  let t14;
  let t15;
  if ($[24] !== onComplete || $[25] !== viewState.type) {
    t14 = () => {
      if (viewState.type === "help") {
        onComplete();
      }
    };
    t15 = [viewState.type, onComplete];
    $[24] = onComplete;
    $[25] = viewState.type;
    $[26] = t14;
    $[27] = t15;
  } else {
    t14 = $[26];
    t15 = $[27];
  }
  useEffect(t14, t15);
  if (viewState.type === "help") {
    let t16;
    if ($[28] === Symbol.for("react.memo_cache_sentinel")) {
      t16 = <Box flexDirection="column"><Text bold={true}>Plugin Command Usage:</Text><Text> </Text><Text dimColor={true}>Installation:</Text><Text> /plugin install - Browse and install plugins</Text><Text>{" "}{"/plugin install <marketplace> - Install from specific marketplace"}</Text><Text>{" /plugin install <plugin> - Install specific plugin"}</Text><Text>{" "}{"/plugin install <plugin>@<market> - Install plugin from marketplace"}</Text><Text> </Text><Text dimColor={true}>Management:</Text><Text> /plugin manage - Manage installed plugins</Text><Text>{" /plugin enable <plugin> - Enable a plugin"}</Text><Text>{" /plugin disable <plugin> - Disable a plugin"}</Text><Text>{" /plugin uninstall <plugin> - Uninstall a plugin"}</Text><Text> </Text><Text dimColor={true}>Marketplaces:</Text><Text> /plugin marketplace - Marketplace management menu</Text><Text> /plugin marketplace add - Add a marketplace</Text><Text>{" "}{"/plugin marketplace add <path/url> - Add marketplace directly"}</Text><Text> /plugin marketplace update - Update marketplaces</Text><Text>{" "}{"/plugin marketplace update <name> - Update specific marketplace"}</Text><Text> /plugin marketplace remove - Remove a marketplace</Text><Text>{" "}{"/plugin marketplace remove <name> - Remove specific marketplace"}</Text><Text> /plugin marketplace list - List all marketplaces</Text><Text> </Text><Text dimColor={true}>Validation:</Text><Text>{" "}{"/plugin validate <path> - Validate a manifest file or directory"}</Text><Text> </Text><Text dimColor={true}>Other:</Text><Text> /plugin - Main plugin menu</Text><Text> /plugin help - Show this help</Text><Text> /plugins - Alias for /plugin</Text></Box>;
      $[28] = t16;
    } else {
      t16 = $[28];
    }
    return t16;
  }
  if (viewState.type === "validate") {
    let t16;
    if ($[29] !== onComplete || $[30] !== viewState.path) {
      t16 = <ValidatePlugin onComplete={onComplete} path={viewState.path} />;
      $[29] = onComplete;
      $[30] = viewState.path;
      $[31] = t16;
    } else {
      t16 = $[31];
    }
    return t16;
  }
  if (viewState.type === "marketplace-menu") {
    setViewState({
      type: "menu"
    });
    return null;
  }
  if (viewState.type === "marketplace-list") {
    let t16;
    if ($[32] !== onComplete) {
      t16 = <MarketplaceList onComplete={onComplete} />;
      $[32] = onComplete;
      $[33] = t16;
    } else {
      t16 = $[33];
    }
    return t16;
  }
  if (viewState.type === "add-marketplace") {
    let t16;
    if ($[34] !== cliMode || $[35] !== cursorOffset || $[36] !== error || $[37] !== inputValue || $[38] !== markPluginsChanged || $[39] !== result) {
      t16 = <AddMarketplace inputValue={inputValue} setInputValue={setInputValue} cursorOffset={cursorOffset} setCursorOffset={setCursorOffset} error={error} setError={setError} result={result} setResult={setResult} setViewState={setViewState} onAddComplete={markPluginsChanged} cliMode={cliMode} />;
      $[34] = cliMode;
      $[35] = cursorOffset;
      $[36] = error;
      $[37] = inputValue;
      $[38] = markPluginsChanged;
      $[39] = result;
      $[40] = t16;
    } else {
      t16 = $[40];
    }
    return t16;
  }
  let t16;
  if ($[41] !== activeTab || $[42] !== showMcpRedirectMessage) {
    t16 = showMcpRedirectMessage && activeTab === "installed" ? <McpRedirectBanner /> : undefined;
    $[41] = activeTab;
    $[42] = showMcpRedirectMessage;
    $[43] = t16;
  } else {
    t16 = $[43];
  }
  const browseMarketplaceTarget = viewState.type === "browse-marketplace" ? viewState.targetMarketplace : undefined;
  const pluginTarget = viewState.type === "browse-marketplace" || viewState.type === "discover-plugins" ? viewState.targetPlugin : undefined;
  let t17;
  if ($[44] !== browseMarketplaceTarget || $[45] !== error || $[46] !== markPluginsChanged || $[47] !== pluginTarget || $[48] !== result || $[49] !== viewState.type) {
    t17 = <Tab id="discover" title="Discover">{viewState.type === "browse-marketplace" ? <BrowseMarketplace error={error} setError={setError} result={result} setResult={setResult} setViewState={setViewState} onInstallComplete={markPluginsChanged} targetMarketplace={browseMarketplaceTarget} targetPlugin={pluginTarget} /> : <DiscoverPlugins error={error} setError={setError} result={result} setResult={setResult} setViewState={setViewState} onInstallComplete={markPluginsChanged} onSearchModeChange={setChildSearchActive} targetPlugin={pluginTarget} />}</Tab>;
    $[44] = browseMarketplaceTarget;
    $[45] = error;
    $[46] = markPluginsChanged;
    $[47] = pluginTarget;
    $[48] = result;
    $[49] = viewState.type;
    $[50] = t17;
  } else {
    t17 = $[50];
  }
  const t18 = viewState.type === "manage-plugins" ? viewState.targetPlugin : undefined;
  const t19 = viewState.type === "manage-plugins" ? viewState.targetMarketplace : undefined;
  const t20 = viewState.type === "manage-plugins" ? viewState.action : undefined;
  let t21;
  if ($[51] !== markPluginsChanged || $[52] !== t18 || $[53] !== t19 || $[54] !== t20) {
    t21 = <Tab id="installed" title="Installed"><ManagePlugins setViewState={setViewState} setResult={setResult} onManageComplete={markPluginsChanged} onSearchModeChange={setChildSearchActive} targetPlugin={t18} targetMarketplace={t19} action={t20} /></Tab>;
    $[51] = markPluginsChanged;
    $[52] = t18;
    $[53] = t19;
    $[54] = t20;
    $[55] = t21;
  } else {
    t21 = $[55];
  }
  const t22 = viewState.type === "manage-marketplaces" ? viewState.targetMarketplace : undefined;
  const t23 = viewState.type === "manage-marketplaces" ? viewState.action : undefined;
  let t24;
  if ($[56] !== error || $[57] !== exitState || $[58] !== markPluginsChanged || $[59] !== t22 || $[60] !== t23) {
    t24 = <Tab id="marketplaces" title="Marketplaces"><ManageMarketplaces setViewState={setViewState} error={error} setError={setError} setResult={setResult} exitState={exitState} onManageComplete={markPluginsChanged} targetMarketplace={t22} action={t23} /></Tab>;
    $[56] = error;
    $[57] = exitState;
    $[58] = markPluginsChanged;
    $[59] = t22;
    $[60] = t23;
    $[61] = t24;
  } else {
    t24 = $[61];
  }
  let t25;
  if ($[62] !== markPluginsChanged) {
    t25 = <ErrorsTabContent setViewState={setViewState} setActiveTab={setActiveTab} markPluginsChanged={markPluginsChanged} />;
    $[62] = markPluginsChanged;
    $[63] = t25;
  } else {
    t25 = $[63];
  }
  let t26;
  if ($[64] !== errorsTabTitle || $[65] !== t25) {
    t26 = <Tab id="errors" title={errorsTabTitle}>{t25}</Tab>;
    $[64] = errorsTabTitle;
    $[65] = t25;
    $[66] = t26;
  } else {
    t26 = $[66];
  }
  let t27;
  if ($[67] !== activeTab || $[68] !== childSearchActive || $[69] !== t16 || $[70] !== t17 || $[71] !== t21 || $[72] !== t24 || $[73] !== t26) {
    t27 = <Pane color="suggestion"><Tabs title="Plugins" selectedTab={activeTab} onTabChange={handleTabChange} color="suggestion" disableNavigation={childSearchActive} banner={t16}>{t17}{t21}{t24}{t26}</Tabs></Pane>;
    $[67] = activeTab;
    $[68] = childSearchActive;
    $[69] = t16;
    $[70] = t17;
    $[71] = t21;
    $[72] = t24;
    $[73] = t26;
    $[74] = t27;
  } else {
    t27 = $[74];
  }
  return t27;
}
function _temp1(prev) {
  return prev.plugins.needsRefresh ? prev : {
    ...prev,
    plugins: {
      ...prev.plugins,
      needsRefresh: true
    }
  };
}
function _temp0(s) {
  let count = s.plugins.errors.length;
  for (const m of s.plugins.installationStatus.marketplaces) {
    if (m.status === "failed") {
      count++;
    }
  }
  return count;
}
