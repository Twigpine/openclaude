import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { applyPermissionUpdate, persistPermissionUpdate } from 'src/utils/permissions/PermissionUpdate.js';
import type { PermissionUpdate, PermissionUpdateDestination } from 'src/utils/permissions/PermissionUpdateSchema.js';
import type { CommandResultDisplay } from '../../../commands.js';
import { Select, type OptionWithDescription } from '../../../components/CustomSelect/select.js';
import { PRODUCT_DISPLAY_NAME } from '../../../constants/product.js';
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useSearchInput } from '../../../hooks/useSearchInput.js';
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js';
import { Box, Text, useTerminalFocus } from '../../../ink.js';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { type AutoModeDenial, getAutoModeDenials } from '../../../utils/autoModeDenials.js';
import type { PermissionMode } from '../../../utils/permissions/PermissionMode.js';
import { permissionModeTitle } from '../../../utils/permissions/PermissionMode.js';
import type { PermissionBehavior, PermissionRule, PermissionRuleValue } from '../../../utils/permissions/PermissionRule.js';
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js';
import { applyPermissionModeChange } from '../../../utils/permissions/permissionSetup.js';
import { deletePermissionRule, getAllowRules, getAskRules, getDenyRules, permissionRuleSourceDisplayString } from '../../../utils/permissions/permissions.js';
import type { UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js';
import { jsonStringify } from '../../../utils/slowOperations.js';
import { Pane } from '../../design-system/Pane.js';
import { Tab, Tabs, useTabHeaderFocus, useTabsWidth } from '../../design-system/Tabs.js';
import { SearchBox } from '../../SearchBox.js';
import { usePermissionModeChangeRequest } from '../usePermissionModeChangeRequest.js';
import { AddPermissionRules } from './AddPermissionRules.js';
import { AddWorkspaceDirectory } from './AddWorkspaceDirectory.js';
import { PermissionModeTab } from './PermissionModeTab.js';
import { PermissionRuleDescription } from './PermissionRuleDescription.js';
import { PermissionRuleInput } from './PermissionRuleInput.js';
import type { ManageablePermissionMode } from './permissionModeOptions.js';
import { RecentDenialsTab } from './RecentDenialsTab.js';
import { RemoveWorkspaceDirectory } from './RemoveWorkspaceDirectory.js';
import { WorkspaceTab } from './WorkspaceTab.js';
type TabType = 'mode' | 'recent' | 'allow' | 'ask' | 'deny' | 'workspace';
type RuleTabType = Extract<TabType, 'allow' | 'ask' | 'deny'>;
type RuleOption = OptionWithDescription<string>;
type RulesOptionsResult = {
  options: RuleOption[];
  rulesByKey: Map<string, PermissionRule>;
};
type ValidatedRule = {
  ruleValue: PermissionRuleValue;
  ruleBehavior: PermissionBehavior;
};
type DenialState = {
  approved: Set<number>;
  retry: Set<number>;
  denials: readonly AutoModeDenial[];
};
type RuleSourceTextProps = {
  rule: PermissionRule;
};
function RuleSourceText(t0) {
  const $ = _c(4);
  const {
    rule
  } = t0;
  let t1;
  if ($[0] !== rule.source) {
    t1 = permissionRuleSourceDisplayString(rule.source);
    $[0] = rule.source;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const t2 = `From ${t1}`;
  let t3;
  if ($[2] !== t2) {
    t3 = <Text dimColor={true}>{t2}</Text>;
    $[2] = t2;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  return t3;
}

// Helper function to get the appropriate label for rule behavior
function getRuleBehaviorLabel(ruleBehavior: PermissionBehavior): string {
  switch (ruleBehavior) {
    case 'allow':
      return 'allowed';
    case 'deny':
      return 'denied';
    case 'ask':
      return 'ask';
  }
}

// Component for showing tool details and managing the interactive deletion workflow
type RuleDetailsProps = {
  rule: PermissionRule;
  onDelete: () => void;
  onCancel: () => void;
};
function RuleDetails(t0: RuleDetailsProps): React.ReactNode {
  const $ = _c(42);
  const {
    rule,
    onDelete,
    onCancel
  } = t0;
  const exitState = useExitOnCtrlCDWithKeybindings();
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      context: "Confirmation"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  useKeybinding("confirm:no", onCancel, t1);
  let t2;
  if ($[1] !== rule.ruleValue) {
    t2 = permissionRuleValueToString(rule.ruleValue);
    $[1] = rule.ruleValue;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== t2) {
    t3 = <Text bold={true}>{t2}</Text>;
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== rule.ruleValue) {
    t4 = <PermissionRuleDescription ruleValue={rule.ruleValue} />;
    $[5] = rule.ruleValue;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== rule) {
    t5 = <RuleSourceText rule={rule} />;
    $[7] = rule;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] !== t3 || $[10] !== t4 || $[11] !== t5) {
    t6 = <Box flexDirection="column" marginX={2}>{t3}{t4}{t5}</Box>;
    $[9] = t3;
    $[10] = t4;
    $[11] = t5;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  const ruleDescription = t6;
  let t7;
  if ($[13] !== exitState.keyName || $[14] !== exitState.pending) {
    t7 = <Box marginLeft={3}>{exitState.pending ? <Text dimColor={true}>Press {exitState.keyName} again to exit</Text> : <Text dimColor={true}>Esc to cancel</Text>}</Box>;
    $[13] = exitState.keyName;
    $[14] = exitState.pending;
    $[15] = t7;
  } else {
    t7 = $[15];
  }
  const footer = t7;
  if (rule.source === "policySettings") {
    let t8;
    if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
      t8 = <Text bold={true} color="permission">Rule details</Text>;
      $[16] = t8;
    } else {
      t8 = $[16];
    }
    let t9;
    if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
      t9 = <Text italic={true}>This rule is configured by managed settings and cannot be modified.{"\n"}Contact your system administrator for more information.</Text>;
      $[17] = t9;
    } else {
      t9 = $[17];
    }
    let t10;
    if ($[18] !== ruleDescription) {
      t10 = <Box flexDirection="column" gap={1} borderStyle="round" paddingLeft={1} paddingRight={1} borderColor="permission">{t8}{ruleDescription}{t9}</Box>;
      $[18] = ruleDescription;
      $[19] = t10;
    } else {
      t10 = $[19];
    }
    let t11;
    if ($[20] !== footer || $[21] !== t10) {
      t11 = <>{t10}{footer}</>;
      $[20] = footer;
      $[21] = t10;
      $[22] = t11;
    } else {
      t11 = $[22];
    }
    return t11;
  }
  let t8;
  if ($[23] !== rule.ruleBehavior) {
    t8 = getRuleBehaviorLabel(rule.ruleBehavior);
    $[23] = rule.ruleBehavior;
    $[24] = t8;
  } else {
    t8 = $[24];
  }
  let t9;
  if ($[25] !== t8) {
    t9 = <Text bold={true} color="error">Delete {t8} tool?</Text>;
    $[25] = t8;
    $[26] = t9;
  } else {
    t9 = $[26];
  }
  let t10;
  if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = <Text>Are you sure you want to delete this permission rule?</Text>;
    $[27] = t10;
  } else {
    t10 = $[27];
  }
  let t11;
  if ($[28] !== onCancel || $[29] !== onDelete) {
    t11 = _ => _ === "yes" ? onDelete() : onCancel();
    $[28] = onCancel;
    $[29] = onDelete;
    $[30] = t11;
  } else {
    t11 = $[30];
  }
  let t12;
  if ($[31] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = [{
      label: "Yes",
      value: "yes"
    }, {
      label: "No",
      value: "no"
    }];
    $[31] = t12;
  } else {
    t12 = $[31];
  }
  let t13;
  if ($[32] !== onCancel || $[33] !== t11) {
    t13 = <Select onChange={t11} onCancel={onCancel} options={t12} />;
    $[32] = onCancel;
    $[33] = t11;
    $[34] = t13;
  } else {
    t13 = $[34];
  }
  let t14;
  if ($[35] !== ruleDescription || $[36] !== t13 || $[37] !== t9) {
    t14 = <Box flexDirection="column" gap={1} borderStyle="round" paddingLeft={1} paddingRight={1} borderColor="error">{t9}{ruleDescription}{t10}{t13}</Box>;
    $[35] = ruleDescription;
    $[36] = t13;
    $[37] = t9;
    $[38] = t14;
  } else {
    t14 = $[38];
  }
  let t15;
  if ($[39] !== footer || $[40] !== t14) {
    t15 = <>{t14}{footer}</>;
    $[39] = footer;
    $[40] = t14;
    $[41] = t15;
  } else {
    t15 = $[41];
  }
  return t15;
}
type RulesTabContentProps = {
  options: RuleOption[];
  searchQuery: string;
  isSearchMode: boolean;
  isFocused: boolean;
  onSelect: (value: string) => void;
  onCancel: () => void;
  lastFocusedRuleKey: string | undefined;
  cursorOffset?: number;
  onHeaderFocusChange?: (focused: boolean) => void;
};

// Component for rendering rules tab content with full width support
function RulesTabContent(props: RulesTabContentProps): React.ReactNode {
  const $ = _c(26);
  const {
    options,
    searchQuery,
    isSearchMode,
    isFocused,
    onSelect,
    onCancel,
    lastFocusedRuleKey,
    cursorOffset,
    onHeaderFocusChange
  } = props;
  const tabWidth = useTabsWidth();
  const {
    headerFocused,
    focusHeader,
    blurHeader
  } = useTabHeaderFocus();
  let t0;
  let t1;
  if ($[0] !== blurHeader || $[1] !== headerFocused || $[2] !== isSearchMode) {
    t0 = () => {
      if (isSearchMode && headerFocused) {
        blurHeader();
      }
    };
    t1 = [isSearchMode, headerFocused, blurHeader];
    $[0] = blurHeader;
    $[1] = headerFocused;
    $[2] = isSearchMode;
    $[3] = t0;
    $[4] = t1;
  } else {
    t0 = $[3];
    t1 = $[4];
  }
  useEffect(t0, t1);
  let t2;
  let t3;
  if ($[5] !== headerFocused || $[6] !== onHeaderFocusChange) {
    t2 = () => {
      onHeaderFocusChange?.(headerFocused);
    };
    t3 = [headerFocused, onHeaderFocusChange];
    $[5] = headerFocused;
    $[6] = onHeaderFocusChange;
    $[7] = t2;
    $[8] = t3;
  } else {
    t2 = $[7];
    t3 = $[8];
  }
  useEffect(t2, t3);
  const t4 = isSearchMode && !headerFocused;
  let t5;
  if ($[9] !== cursorOffset || $[10] !== isFocused || $[11] !== searchQuery || $[12] !== t4 || $[13] !== tabWidth) {
    t5 = <Box marginBottom={1} flexDirection="column"><SearchBox query={searchQuery} isFocused={t4} isTerminalFocused={isFocused} width={tabWidth} cursorOffset={cursorOffset} /></Box>;
    $[9] = cursorOffset;
    $[10] = isFocused;
    $[11] = searchQuery;
    $[12] = t4;
    $[13] = tabWidth;
    $[14] = t5;
  } else {
    t5 = $[14];
  }
  const t6 = Math.min(10, options.length);
  const t7 = isSearchMode || headerFocused;
  let t8;
  if ($[15] !== focusHeader || $[16] !== lastFocusedRuleKey || $[17] !== onCancel || $[18] !== onSelect || $[19] !== options || $[20] !== t6 || $[21] !== t7) {
    t8 = <Select options={options} onChange={onSelect} onCancel={onCancel} visibleOptionCount={t6} isDisabled={t7} defaultFocusValue={lastFocusedRuleKey} onUpFromFirstItem={focusHeader} />;
    $[15] = focusHeader;
    $[16] = lastFocusedRuleKey;
    $[17] = onCancel;
    $[18] = onSelect;
    $[19] = options;
    $[20] = t6;
    $[21] = t7;
    $[22] = t8;
  } else {
    t8 = $[22];
  }
  let t9;
  if ($[23] !== t5 || $[24] !== t8) {
    t9 = <Box flexDirection="column">{t5}{t8}</Box>;
    $[23] = t5;
    $[24] = t8;
    $[25] = t9;
  } else {
    t9 = $[25];
  }
  return t9;
}

// Composes the subtitle + search + Select for a single allow/ask/deny tab.
type PermissionRulesTabProps = Omit<RulesTabContentProps, 'options' | 'onSelect'> & {
  tab: RuleTabType;
  getRulesOptions: (tab: RuleTabType, query?: string) => RulesOptionsResult;
  handleToolSelect: (selectedValue: string, tab: RuleTabType) => void;
};
function PermissionRulesTab(t0: PermissionRulesTabProps): React.ReactNode {
  const $ = _c(27);
  let T0;
  let T1;
  let handleToolSelect;
  let rulesProps;
  let t1;
  let t2;
  let t3;
  let t4;
  let tab;
  if ($[0] !== t0) {
    const {
      tab: t5,
      getRulesOptions,
      handleToolSelect: t6,
      ...t7
    } = t0;
    tab = t5;
    handleToolSelect = t6;
    rulesProps = t7;
    T1 = Box;
    t2 = "column";
    t3 = tab === "allow" ? 0 : undefined;
    let t8;
    if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
      t8 = {
        allow: `${PRODUCT_DISPLAY_NAME} won't ask before using allowed tools.`,
        ask: `${PRODUCT_DISPLAY_NAME} will always ask for confirmation before using these tools.`,
        deny: `${PRODUCT_DISPLAY_NAME} will always reject requests to use denied tools.`
      };
      $[10] = t8;
    } else {
      t8 = $[10];
    }
    const t9 = t8[tab];
    if ($[11] !== t9) {
      t4 = <Text>{t9}</Text>;
      $[11] = t9;
      $[12] = t4;
    } else {
      t4 = $[12];
    }
    T0 = RulesTabContent;
    t1 = getRulesOptions(tab, rulesProps.searchQuery);
    $[0] = t0;
    $[1] = T0;
    $[2] = T1;
    $[3] = handleToolSelect;
    $[4] = rulesProps;
    $[5] = t1;
    $[6] = t2;
    $[7] = t3;
    $[8] = t4;
    $[9] = tab;
  } else {
    T0 = $[1];
    T1 = $[2];
    handleToolSelect = $[3];
    rulesProps = $[4];
    t1 = $[5];
    t2 = $[6];
    t3 = $[7];
    t4 = $[8];
    tab = $[9];
  }
  let t5;
  if ($[13] !== handleToolSelect || $[14] !== tab) {
    t5 = v => handleToolSelect(v, tab);
    $[13] = handleToolSelect;
    $[14] = tab;
    $[15] = t5;
  } else {
    t5 = $[15];
  }
  let t6;
  if ($[16] !== T0 || $[17] !== rulesProps || $[18] !== t1.options || $[19] !== t5) {
    t6 = <T0 options={t1.options} onSelect={t5} {...rulesProps} />;
    $[16] = T0;
    $[17] = rulesProps;
    $[18] = t1.options;
    $[19] = t5;
    $[20] = t6;
  } else {
    t6 = $[20];
  }
  let t7;
  if ($[21] !== T1 || $[22] !== t2 || $[23] !== t3 || $[24] !== t4 || $[25] !== t6) {
    t7 = <T1 flexDirection={t2} flexShrink={t3}>{t4}{t6}</T1>;
    $[21] = T1;
    $[22] = t2;
    $[23] = t3;
    $[24] = t4;
    $[25] = t6;
    $[26] = t7;
  } else {
    t7 = $[26];
  }
  return t7;
}
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
    shouldQuery?: boolean;
    metaMessages?: string[];
  }) => void;
  initialTab?: TabType;
  onRetryDenials?: (commands: string[]) => void;
};
export function PermissionRuleList(t0: Props): React.ReactNode {
  const $ = _c(140);
  const {
    onExit,
    initialTab,
    onRetryDenials
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getAutoModeDenials();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const hasDenials = t1.length > 0;
  const defaultTab = initialTab ?? (hasDenials ? "recent" : "mode");
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = [];
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const [changes, setChanges] = useState<string[]>(t2);
  const toolPermissionContext = useAppState(_temp);
  const setAppState = useSetAppState();
  const isTerminalFocused = useTerminalFocus();
  let t3;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = {
      approved: new Set<number>(),
      retry: new Set<number>(),
      denials: [] as readonly AutoModeDenial[]
    };
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  const denialStateRef = useRef<DenialState>(t3);
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = s_0 => {
      denialStateRef.current = s_0;
    };
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  const handleDenialStateChange = t4;
  const [selectedRule, setSelectedRule] = useState<PermissionRule | undefined>(undefined);
  const [lastFocusedRuleKey, setLastFocusedRuleKey] = useState<string | undefined>(undefined);
  const [addingRuleToTab, setAddingRuleToTab] = useState<RuleTabType | null>(null);
  const [validatedRule, setValidatedRule] = useState<ValidatedRule | null>(null);
  const [isAddingWorkspaceDirectory, setIsAddingWorkspaceDirectory] = useState(false);
  const [removingDirectory, setRemovingDirectory] = useState<string | null>(null);
  const [modeMessage, setModeMessage] = useState<string | null>(null);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(true);
  const {
    dangerousModeDialog,
    isConfirmingDangerousMode,
    requestPermissionModeChange
  } = usePermissionModeChangeRequest();
  let t5;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = focused => {
      setHeaderFocused(focused);
    };
    $[4] = t5;
  } else {
    t5 = $[4];
  }
  const handleHeaderFocusChange = t5;
  let map: Map<string, PermissionRule>;
  if ($[5] !== toolPermissionContext) {
    map = new Map<string, PermissionRule>();
    getAllowRules(toolPermissionContext).forEach(rule => {
      map.set(jsonStringify(rule), rule);
    });
    $[5] = toolPermissionContext;
    $[6] = map;
  } else {
    map = $[6];
  }
  const allowRulesByKey = map;
  let map_0: Map<string, PermissionRule>;
  if ($[7] !== toolPermissionContext) {
    map_0 = new Map<string, PermissionRule>();
    getDenyRules(toolPermissionContext).forEach(rule_0 => {
      map_0.set(jsonStringify(rule_0), rule_0);
    });
    $[7] = toolPermissionContext;
    $[8] = map_0;
  } else {
    map_0 = $[8];
  }
  const denyRulesByKey = map_0;
  let map_1: Map<string, PermissionRule>;
  if ($[9] !== toolPermissionContext) {
    map_1 = new Map<string, PermissionRule>();
    getAskRules(toolPermissionContext).forEach(rule_1 => {
      map_1.set(jsonStringify(rule_1), rule_1);
    });
    $[9] = toolPermissionContext;
    $[10] = map_1;
  } else {
    map_1 = $[10];
  }
  const askRulesByKey = map_1;
  let t6;
  if ($[11] !== allowRulesByKey || $[12] !== askRulesByKey || $[13] !== denyRulesByKey) {
    t6 = (tab: RuleTabType, t7?: string): RulesOptionsResult => {
      const query = t7 === undefined ? "" : t7;
      const rulesByKey = (() => {
        switch (tab) {
          case "allow":
            {
              return allowRulesByKey;
            }
          case "deny":
            {
              return denyRulesByKey;
            }
          case "ask":
            {
              return askRulesByKey;
            }
        }
      })();
      const options: RuleOption[] = [];
      if (!query) {
        options.push({
          label: `Add a new rule${figures.ellipsis}`,
          value: "add-new-rule"
        });
      }
      const sortedRuleKeys = Array.from(rulesByKey.keys()).sort((a, b) => {
        const ruleA = rulesByKey.get(a);
        const ruleB = rulesByKey.get(b);
        if (ruleA && ruleB) {
          const ruleAString = permissionRuleValueToString(ruleA.ruleValue).toLowerCase();
          const ruleBString = permissionRuleValueToString(ruleB.ruleValue).toLowerCase();
          return ruleAString.localeCompare(ruleBString);
        }
        return 0;
      });
      const lowerQuery = query.toLowerCase();
      for (const ruleKey of sortedRuleKeys) {
        const rule_2 = rulesByKey.get(ruleKey);
        if (rule_2) {
          const ruleString = permissionRuleValueToString(rule_2.ruleValue);
          if (query && !ruleString.toLowerCase().includes(lowerQuery)) {
            continue;
          }
          options.push({
            label: ruleString,
            value: ruleKey
          });
        }
      }
      return {
        options,
        rulesByKey
      };
    };
    $[11] = allowRulesByKey;
    $[12] = askRulesByKey;
    $[13] = denyRulesByKey;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  const getRulesOptions = t6;
  const exitState = useExitOnCtrlCDWithKeybindings();
  const isSearchModeActive = !selectedRule && !addingRuleToTab && !validatedRule && !isAddingWorkspaceDirectory && !removingDirectory && !isConfirmingDangerousMode;
  const t7 = isSearchModeActive && isSearchMode;
  let t8;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = () => {
      setIsSearchMode(false);
    };
    $[15] = t8;
  } else {
    t8 = $[15];
  }
  let t9;
  if ($[16] !== t7) {
    t9 = {
      isActive: t7,
      onExit: t8
    };
    $[16] = t7;
    $[17] = t9;
  } else {
    t9 = $[17];
  }
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset
  } = useSearchInput(t9);
  let t10;
  if ($[18] !== isSearchMode || $[19] !== isSearchModeActive || $[20] !== setSearchQuery) {
    t10 = e => {
      if (!isSearchModeActive) {
        return;
      }
      if (isSearchMode) {
        return;
      }
      if (e.ctrl || e.meta) {
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setIsSearchMode(true);
        setSearchQuery("");
      } else {
        if (e.key.length === 1 && e.key !== "j" && e.key !== "k" && e.key !== "m" && e.key !== "i" && e.key !== "r" && e.key !== " ") {
          e.preventDefault();
          setIsSearchMode(true);
          setSearchQuery(e.key);
        }
      }
    };
    $[18] = isSearchMode;
    $[19] = isSearchModeActive;
    $[20] = setSearchQuery;
    $[21] = t10;
  } else {
    t10 = $[21];
  }
  const handleKeyDown = t10;
  let t11;
  if ($[22] !== getRulesOptions) {
    t11 = (selectedValue: string, tab_0: RuleTabType) => {
      const {
        rulesByKey: rulesByKey_0
      } = getRulesOptions(tab_0);
      if (selectedValue === "add-new-rule") {
        setAddingRuleToTab(tab_0);
        return;
      } else {
        setSelectedRule(rulesByKey_0.get(selectedValue));
        return;
      }
    };
    $[22] = getRulesOptions;
    $[23] = t11;
  } else {
    t11 = $[23];
  }
  const handleToolSelect = t11;
  let t12;
  if ($[24] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = () => {
      setAddingRuleToTab(null);
    };
    $[24] = t12;
  } else {
    t12 = $[24];
  }
  const handleRuleInputCancel = t12;
  let t13;
  if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
    t13 = (ruleValue: PermissionRuleValue, ruleBehavior: PermissionBehavior) => {
      setValidatedRule({
        ruleValue,
        ruleBehavior
      });
      setAddingRuleToTab(null);
    };
    $[25] = t13;
  } else {
    t13 = $[25];
  }
  const handleRuleInputSubmit = t13;
  let t14;
  if ($[26] === Symbol.for("react.memo_cache_sentinel")) {
    t14 = (rules: PermissionRule[], unreachable?: UnreachableRule[]) => {
      setValidatedRule(null);
      for (const rule_3 of rules) {
        setChanges(prev => [...prev, `Added ${rule_3.ruleBehavior} rule ${chalk.bold(permissionRuleValueToString(rule_3.ruleValue))}`]);
      }
      if (unreachable && unreachable.length > 0) {
        for (const u of unreachable) {
          const severity = u.shadowType === "deny" ? "blocked" : "shadowed";
          setChanges(prev_0 => [...prev_0, chalk.yellow(`${figures.warning} Warning: ${permissionRuleValueToString(u.rule.ruleValue)} is ${severity}`), chalk.dim(`  ${u.reason}`), chalk.dim(`  Fix: ${u.fix}`)]);
        }
      }
    };
    $[26] = t14;
  } else {
    t14 = $[26];
  }
  const handleAddRulesSuccess = t14;
  let t15;
  if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
    t15 = () => {
      setValidatedRule(null);
    };
    $[27] = t15;
  } else {
    t15 = $[27];
  }
  const handleAddRuleCancel = t15;
  let t16;
  if ($[28] === Symbol.for("react.memo_cache_sentinel")) {
    t16 = () => setIsAddingWorkspaceDirectory(true);
    $[28] = t16;
  } else {
    t16 = $[28];
  }
  const handleRequestAddDirectory = t16;
  let t17;
  if ($[29] === Symbol.for("react.memo_cache_sentinel")) {
    t17 = (path: string) => setRemovingDirectory(path);
    $[29] = t17;
  } else {
    t17 = $[29];
  }
  const handleRequestRemoveDirectory = t17;
  const handleModeChange = useCallback(async (mode_0: ManageablePermissionMode, options_0?: {
    skipPrompt?: boolean;
  }) => {
    if (mode_0 === toolPermissionContext.mode) {
      return;
    }
    setModeMessage(null);
    await requestPermissionModeChange({
      mode: mode_0,
      toolPermissionContext,
      allowSessionBypassPermissionsModeEnable: true,
      skipDangerousModePrompt: options_0?.skipPrompt,
      onApply: () => {
        setAppState(prev_0 => {
          const currentMode = prev_0.toolPermissionContext.mode;
          if (currentMode === mode_0) {
            return prev_0;
          }
          return {
            ...prev_0,
            toolPermissionContext: applyPermissionModeChange(prev_0.toolPermissionContext, mode_0)
          };
        });
        setChanges(prev_1 => [...prev_1, `Set permission mode to ${chalk.bold(permissionModeTitle(mode_0))} for this session`]);
      },
      onBlocked: error => {
        setModeMessage(error);
      }
    });
  }, [requestPermissionModeChange, setAppState, toolPermissionContext]);
  let tRulesCancel;
  if ($[122] !== changes || $[123] !== onExit || $[124] !== onRetryDenials) {
    tRulesCancel = () => {
      const s_1 = denialStateRef.current;
      const denialsFor = (set: Set<number>) => Array.from(set).map(idx => s_1.denials[idx]).filter(_temp2);
      const retryDenials = denialsFor(s_1.retry);
      if (retryDenials.length > 0) {
        const commands = retryDenials.map(_temp3);
        onRetryDenials?.(commands);
        onExit(undefined, {
          shouldQuery: true,
          metaMessages: [`Permission granted for: ${commands.join(", ")}. You may now retry ${commands.length === 1 ? "this command" : "these commands"} if you would like.`]
        });
        return;
      }
      const approvedDenials = denialsFor(s_1.approved);
      if (approvedDenials.length > 0 || changes.length > 0) {
        const approvedMsg = approvedDenials.length > 0 ? [`Approved ${approvedDenials.map(_temp4).join(", ")}`] : [];
        onExit([...approvedMsg, ...changes].join("\n"));
      } else {
        onExit("Permissions dialog dismissed", {
          display: "system"
        });
      }
    };
    $[122] = changes;
    $[123] = onExit;
    $[124] = onRetryDenials;
    $[125] = tRulesCancel;
  } else {
    tRulesCancel = $[125];
  }
  const handleRulesCancel = tRulesCancel;
  const settingsKeybindingActive = isSearchModeActive && !isSearchMode;
  let settingsKeybinding;
  if ($[126] !== settingsKeybindingActive) {
    settingsKeybinding = {
      context: "Settings",
      isActive: settingsKeybindingActive
    };
    $[126] = settingsKeybindingActive;
    $[127] = settingsKeybinding;
  } else {
    settingsKeybinding = $[127];
  }
  useKeybinding("confirm:no", handleRulesCancel, settingsKeybinding);
  let t21;
  if ($[36] !== getRulesOptions || $[37] !== selectedRule || $[38] !== setAppState || $[39] !== toolPermissionContext) {
    t21 = () => {
      if (!selectedRule) {
        return;
      }
      const {
        options: options_0
      } = getRulesOptions(selectedRule.ruleBehavior as TabType);
      const selectedKey = jsonStringify(selectedRule);
      const ruleKeys = options_0.filter(_temp5).map(_temp6);
      const currentIndex = ruleKeys.indexOf(selectedKey);
      let nextFocusKey;
      if (currentIndex !== -1) {
        if (currentIndex < ruleKeys.length - 1) {
          nextFocusKey = ruleKeys[currentIndex + 1];
        } else {
          if (currentIndex > 0) {
            nextFocusKey = ruleKeys[currentIndex - 1];
          }
        }
      }
      setLastFocusedRuleKey(nextFocusKey);
      deletePermissionRule({
        rule: selectedRule,
        initialContext: toolPermissionContext,
        setToolPermissionContext(toolPermissionContext_0) {
          setAppState(prev_1 => ({
            ...prev_1,
            toolPermissionContext: toolPermissionContext_0
          }));
        }
      });
      setChanges(prev_2 => [...prev_2, `Deleted ${selectedRule.ruleBehavior} rule ${chalk.bold(permissionRuleValueToString(selectedRule.ruleValue))}`]);
      setSelectedRule(undefined);
    };
    $[36] = getRulesOptions;
    $[37] = selectedRule;
    $[38] = setAppState;
    $[39] = toolPermissionContext;
    $[40] = t21;
  } else {
    t21 = $[40];
  }
  const handleDeleteRule = t21;
  if (selectedRule) {
    let t22;
    if ($[41] === Symbol.for("react.memo_cache_sentinel")) {
      t22 = () => setSelectedRule(undefined);
      $[41] = t22;
    } else {
      t22 = $[41];
    }
    let t23;
    if ($[42] !== handleDeleteRule || $[43] !== selectedRule) {
      t23 = <RuleDetails rule={selectedRule} onDelete={handleDeleteRule} onCancel={t22} />;
      $[42] = handleDeleteRule;
      $[43] = selectedRule;
      $[44] = t23;
    } else {
      t23 = $[44];
    }
    return t23;
  }
  if (addingRuleToTab) {
    let t22;
    if ($[45] !== addingRuleToTab) {
      t22 = <PermissionRuleInput onCancel={handleRuleInputCancel} onSubmit={handleRuleInputSubmit} ruleBehavior={addingRuleToTab} />;
      $[45] = addingRuleToTab;
      $[46] = t22;
    } else {
      t22 = $[46];
    }
    return t22;
  }
  if (validatedRule) {
    let t22;
    if ($[47] !== validatedRule.ruleValue) {
      t22 = [validatedRule.ruleValue];
      $[47] = validatedRule.ruleValue;
      $[48] = t22;
    } else {
      t22 = $[48];
    }
    let t23;
    if ($[49] !== setAppState) {
      t23 = toolPermissionContext_1 => {
        setAppState(prev_3 => ({
          ...prev_3,
          toolPermissionContext: toolPermissionContext_1
        }));
      };
      $[49] = setAppState;
      $[50] = t23;
    } else {
      t23 = $[50];
    }
    let t24;
    if ($[51] !== t22 || $[52] !== t23 || $[53] !== toolPermissionContext || $[54] !== validatedRule.ruleBehavior) {
      t24 = <AddPermissionRules onAddRules={handleAddRulesSuccess} onCancel={handleAddRuleCancel} ruleValues={t22} ruleBehavior={validatedRule.ruleBehavior} initialContext={toolPermissionContext} setToolPermissionContext={t23} />;
      $[51] = t22;
      $[52] = t23;
      $[53] = toolPermissionContext;
      $[54] = validatedRule.ruleBehavior;
      $[55] = t24;
    } else {
      t24 = $[55];
    }
    return t24;
  }
  if (isAddingWorkspaceDirectory) {
    let t22;
    if ($[56] !== setAppState || $[57] !== toolPermissionContext) {
      t22 = (path_0, remember) => {
        const destination: PermissionUpdateDestination = remember ? "localSettings" : "session";
        const permissionUpdate: PermissionUpdate = {
          type: "addDirectories" as const,
          directories: [path_0],
          destination
        };
        const updatedContext = applyPermissionUpdate(toolPermissionContext, permissionUpdate);
        setAppState(prev_4 => ({
          ...prev_4,
          toolPermissionContext: updatedContext
        }));
        if (remember) {
          persistPermissionUpdate(permissionUpdate);
        }
        setChanges(prev_5 => [...prev_5, `Added directory ${chalk.bold(path_0)} to workspace${remember ? " and saved to local settings" : " for this session"}`]);
        setIsAddingWorkspaceDirectory(false);
      };
      $[56] = setAppState;
      $[57] = toolPermissionContext;
      $[58] = t22;
    } else {
      t22 = $[58];
    }
    let t23;
    if ($[59] === Symbol.for("react.memo_cache_sentinel")) {
      t23 = () => setIsAddingWorkspaceDirectory(false);
      $[59] = t23;
    } else {
      t23 = $[59];
    }
    let t24;
    if ($[60] !== t22 || $[61] !== toolPermissionContext) {
      t24 = <AddWorkspaceDirectory onAddDirectory={t22} onCancel={t23} permissionContext={toolPermissionContext} />;
      $[60] = t22;
      $[61] = toolPermissionContext;
      $[62] = t24;
    } else {
      t24 = $[62];
    }
    return t24;
  }
  if (removingDirectory) {
    let t22;
    if ($[63] !== removingDirectory) {
      t22 = () => {
        setChanges(prev_6 => [...prev_6, `Removed directory ${chalk.bold(removingDirectory)} from workspace`]);
        setRemovingDirectory(null);
      };
      $[63] = removingDirectory;
      $[64] = t22;
    } else {
      t22 = $[64];
    }
    let t23;
    if ($[65] === Symbol.for("react.memo_cache_sentinel")) {
      t23 = () => setRemovingDirectory(null);
      $[65] = t23;
    } else {
      t23 = $[65];
    }
    let t24;
    if ($[66] !== setAppState) {
      t24 = toolPermissionContext_2 => {
        setAppState(prev_7 => ({
          ...prev_7,
          toolPermissionContext: toolPermissionContext_2
        }));
      };
      $[66] = setAppState;
      $[67] = t24;
    } else {
      t24 = $[67];
    }
    let t25;
    if ($[68] !== removingDirectory || $[69] !== t22 || $[70] !== t24 || $[71] !== toolPermissionContext) {
      t25 = <RemoveWorkspaceDirectory directoryPath={removingDirectory} onRemove={t22} onCancel={t23} permissionContext={toolPermissionContext} setPermissionContext={t24} />;
      $[68] = removingDirectory;
      $[69] = t22;
      $[70] = t24;
      $[71] = toolPermissionContext;
      $[72] = t25;
    } else {
      t25 = $[72];
    }
    return t25;
  }
  if (dangerousModeDialog) {
    return dangerousModeDialog;
  }
  let t22;
  if ($[73] !== getRulesOptions || $[74] !== handleRulesCancel || $[75] !== handleToolSelect || $[76] !== isSearchMode || $[77] !== isTerminalFocused || $[78] !== lastFocusedRuleKey || $[79] !== searchCursorOffset || $[80] !== searchQuery) {
    t22 = {
      searchQuery,
      isSearchMode,
      isFocused: isTerminalFocused,
      onCancel: handleRulesCancel,
      lastFocusedRuleKey,
      cursorOffset: searchCursorOffset,
      getRulesOptions,
      handleToolSelect,
      onHeaderFocusChange: handleHeaderFocusChange
    };
    $[73] = getRulesOptions;
    $[74] = handleRulesCancel;
    $[75] = handleToolSelect;
    $[76] = isSearchMode;
    $[77] = isTerminalFocused;
    $[78] = lastFocusedRuleKey;
    $[79] = searchCursorOffset;
    $[80] = searchQuery;
    $[81] = t22;
  } else {
    t22 = $[81];
  }
  const sharedRulesProps = t22;
  const isHidden = false;
  const t23 = !isSearchMode;
  let tModeTab;
  if ($[132] !== handleHeaderFocusChange || $[133] !== handleModeChange || $[134] !== handleRulesCancel || $[135] !== modeMessage || $[136] !== toolPermissionContext) {
    tModeTab = <Tab id="mode" title="Mode"><PermissionModeTab toolPermissionContext={toolPermissionContext} onSelectMode={handleModeChange} onCancel={handleRulesCancel} onHeaderFocusChange={handleHeaderFocusChange} statusMessage={modeMessage ?? undefined} /></Tab>;
    $[132] = handleHeaderFocusChange;
    $[133] = handleModeChange;
    $[134] = handleRulesCancel;
    $[135] = modeMessage;
    $[136] = toolPermissionContext;
    $[137] = tModeTab;
  } else {
    tModeTab = $[137];
  }
  let t24;
  if ($[82] === Symbol.for("react.memo_cache_sentinel")) {
    t24 = <Tab id="recent" title="Recently denied"><RecentDenialsTab onHeaderFocusChange={handleHeaderFocusChange} onStateChange={handleDenialStateChange} /></Tab>;
    $[82] = t24;
  } else {
    t24 = $[82];
  }
  let t25;
  if ($[83] !== sharedRulesProps) {
    t25 = <Tab id="allow" title="Allow"><PermissionRulesTab tab="allow" {...sharedRulesProps} /></Tab>;
    $[83] = sharedRulesProps;
    $[84] = t25;
  } else {
    t25 = $[84];
  }
  let t26;
  if ($[85] !== sharedRulesProps) {
    t26 = <Tab id="ask" title="Ask"><PermissionRulesTab tab="ask" {...sharedRulesProps} /></Tab>;
    $[85] = sharedRulesProps;
    $[86] = t26;
  } else {
    t26 = $[86];
  }
  let t27;
  if ($[87] !== sharedRulesProps) {
    t27 = <Tab id="deny" title="Deny"><PermissionRulesTab tab="deny" {...sharedRulesProps} /></Tab>;
    $[87] = sharedRulesProps;
    $[88] = t27;
  } else {
    t27 = $[88];
  }
  let t28;
  if ($[89] === Symbol.for("react.memo_cache_sentinel")) {
    t28 = <Text>{PRODUCT_DISPLAY_NAME} can read files in the workspace, and make edits when auto-accept edits is on.</Text>;
    $[89] = t28;
  } else {
    t28 = $[89];
  }
  let t29;
  if ($[90] !== onExit || $[91] !== toolPermissionContext) {
    t29 = <Tab id="workspace" title="Workspace"><Box flexDirection="column">{t28}<WorkspaceTab onExit={onExit} toolPermissionContext={toolPermissionContext} onRequestAddDirectory={handleRequestAddDirectory} onRequestRemoveDirectory={handleRequestRemoveDirectory} onHeaderFocusChange={handleHeaderFocusChange} /></Box></Tab>;
    $[90] = onExit;
    $[91] = toolPermissionContext;
    $[92] = t29;
  } else {
    t29 = $[92];
  }
  let t30;
  if ($[93] !== defaultTab || $[94] !== isHidden || $[95] !== t23 || $[96] !== t25 || $[97] !== t26 || $[98] !== t27 || $[99] !== t29 || $[138] !== t24 || $[139] !== tModeTab) {
    t30 = <Tabs title="Permissions:" color="permission" defaultTab={defaultTab} hidden={isHidden} initialHeaderFocused={!hasDenials} navFromContent={t23}>{tModeTab}{t24}{t25}{t26}{t27}{t29}</Tabs>;
    $[93] = defaultTab;
    $[94] = isHidden;
    $[95] = t23;
    $[96] = t25;
    $[97] = t26;
    $[98] = t27;
    $[99] = t29;
    $[138] = t24;
    $[139] = tModeTab;
    $[100] = t30;
  } else {
    t30 = $[100];
  }
  let t31;
  if ($[101] !== defaultTab || $[102] !== exitState.keyName || $[103] !== exitState.pending || $[104] !== headerFocused || $[105] !== isSearchMode) {
    t31 = <Box marginTop={1} paddingLeft={1}><Text dimColor={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : headerFocused ? <>←/→ tab switch · ↓ return · Esc cancel</> : isSearchMode ? <>Type to filter · Enter/↓ select · ↑ tabs · Esc clear</> : hasDenials && defaultTab === "recent" ? <>Enter approve · r retry · ↑↓ navigate · ←/→ switch · Esc cancel</> : <>↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel</>}</Text></Box>;
    $[101] = defaultTab;
    $[102] = exitState.keyName;
    $[103] = exitState.pending;
    $[104] = headerFocused;
    $[105] = isSearchMode;
    $[106] = t31;
  } else {
    t31 = $[106];
  }
  let t32;
  if ($[107] !== t30 || $[108] !== t31) {
    t32 = <Pane color="permission">{t30}{t31}</Pane>;
    $[107] = t30;
    $[108] = t31;
    $[109] = t32;
  } else {
    t32 = $[109];
  }
  let t33;
  if ($[110] !== handleKeyDown || $[111] !== t32) {
    t33 = <Box flexDirection="column" onKeyDown={handleKeyDown}>{t32}</Box>;
    $[110] = handleKeyDown;
    $[111] = t32;
    $[112] = t33;
  } else {
    t33 = $[112];
  }
  return t33;
}
function _temp6(opt_0) {
  return opt_0.value;
}
function _temp5(opt) {
  return opt.value !== "add-new-rule";
}
function _temp4(d_1) {
  return chalk.bold(d_1.display);
}
function _temp3(d_0) {
  return d_0.display;
}
function _temp2(d) {
  return d !== undefined;
}
function _temp(s) {
  return s.toolPermissionContext;
}
