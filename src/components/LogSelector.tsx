import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import figures from 'figures';
import Fuse from 'fuse.js';
import React from 'react';
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useSearchInput } from '../hooks/useSearchInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { applyColor } from '../ink/colorize.js';
import type { Color } from '../ink/styles.js';
import { Box, Text, useInput, useTerminalFocus, useTheme } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { logEvent } from '../services/analytics/index.js';
import type { LogOption, SerializedMessage } from '../types/logs.js';
import { formatLogMetadata, truncateToWidth } from '../utils/format.js';
import { getWorktreePaths } from '../utils/getWorktreePaths.js';
import { getBranch } from '../utils/git.js';
import { getLogDisplayTitle } from '../utils/log.js';
import { getFirstMeaningfulUserMessageTextContent, getSessionIdFromLog, isCustomTitleEnabled, saveCustomTitle } from '../utils/sessionStorage.js';
import { getTheme } from '../utils/theme.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select, type OptionWithDescription } from './CustomSelect/select.js';
import { Byline } from './design-system/Byline.js';
import { Divider } from './design-system/Divider.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { SearchBox } from './SearchBox.js';
import { SessionPreview } from './SessionPreview.js';
import { Spinner } from './Spinner.js';
import { TagTabs } from './TagTabs.js';
import TextInput from './TextInput.js';
import { type TreeNode, TreeSelect } from './ui/TreeSelect.js';
type AgenticSearchState = {
  status: 'idle';
} | {
  status: 'searching';
} | {
  status: 'results';
  results: LogOption[];
  query: string;
} | {
  status: 'error';
  message: string;
};
export type LogSelectorProps = {
  logs: LogOption[];
  maxHeight?: number;
  forceWidth?: number;
  onCancel?: () => void;
  onSelect: (log: LogOption) => void;
  onDeleteRequest?: (log: LogOption) => void;
  isInputDisabled?: boolean;
  onLogsChanged?: () => void;
  onLoadMore?: (count: number) => void;
  initialSearchQuery?: string;
  showAllProjects?: boolean;
  onToggleAllProjects?: () => void;
  onAgenticSearch?: (query: string, logs: LogOption[], signal?: AbortSignal) => Promise<LogOption[]>;
};
type LogTreeNode = TreeNode<{
  log: LogOption;
  indexInFiltered: number;
}>;
export type ResumeLogGroup = {
  id: string;
  headerLog: LogOption;
  childLogs: LogOption[];
  logs: LogOption[];
  firstIndex: number;
};
type ViewMode = 'list' | 'preview' | 'rename' | 'search';
type DeepSearchResult = {
  log: LogOption;
  score?: number;
  searchableText: string;
};
type DeepSearchResults = {
  results: DeepSearchResult[];
  query: string;
};
type FilteredLogState = {
  filteredLogs: LogOption[];
  snippets: Map<LogOption, Snippet>;
};
const EMPTY_AGENTIC_RESULTS: LogOption[] = [];
function normalizeAndTruncateToWidth(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return truncateToWidth(normalized, maxWidth);
}

// Width of prefixes that TreeSelect will add
const PARENT_PREFIX_WIDTH = 2; // '▼ ' or '▶ '
const CHILD_PREFIX_WIDTH = 4; // '  ▸ '

// Deep search constants
const DEEP_SEARCH_MAX_MESSAGES = 2000;
const DEEP_SEARCH_CROP_SIZE = 1000;
const DEEP_SEARCH_MAX_TEXT_LENGTH = 50000; // Cap searchable text per session
const FUSE_THRESHOLD = 0.3;
const DATE_TIE_THRESHOLD_MS = 60 * 1000; // 1 minute - use relevance as tie-breaker within this window
const SNIPPET_CONTEXT_CHARS = 50; // Characters to show before/after match

type Snippet = {
  before: string;
  match: string;
  after: string;
};
function formatSnippet({
  before,
  match,
  after
}: Snippet, highlightColor: (text: string) => string): string {
  return chalk.dim(before) + highlightColor(match) + chalk.dim(after);
}
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Search failed';
}
function extractSnippet(text: string, query: string, contextChars: number): Snippet | null {
  // Find exact query occurrence (case-insensitive).
  // Note: Fuse does fuzzy matching, so this may miss some fuzzy matches.
  // This is acceptable for now - in the future we could use Fuse's includeMatches
  // option and work with the match indices directly.
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex === -1) return null;
  const matchEnd = matchIndex + query.length;
  const snippetStart = Math.max(0, matchIndex - contextChars);
  const snippetEnd = Math.min(text.length, matchEnd + contextChars);
  const beforeRaw = text.slice(snippetStart, matchIndex);
  const matchText = text.slice(matchIndex, matchEnd);
  const afterRaw = text.slice(matchEnd, snippetEnd);
  return {
    before: (snippetStart > 0 ? '…' : '') + beforeRaw.replace(/\s+/g, ' ').trimStart(),
    match: matchText.trim(),
    after: afterRaw.replace(/\s+/g, ' ').trimEnd() + (snippetEnd < text.length ? '…' : '')
  };
}
function buildLogLabel(log: LogOption, maxLabelWidth: number, options?: {
  isGroupHeader?: boolean;
  isChild?: boolean;
  forkCount?: number;
}): string {
  const {
    isGroupHeader = false,
    isChild = false,
    forkCount = 0
  } = options || {};

  // TreeSelect will add the prefix, so we just need to account for its width
  const prefixWidth = isGroupHeader && forkCount > 0 ? PARENT_PREFIX_WIDTH : isChild ? CHILD_PREFIX_WIDTH : 0;
  const sessionCountSuffix = isGroupHeader && forkCount > 0 ? ` (+${forkCount} other ${forkCount === 1 ? 'session' : 'sessions'})` : '';
  const sidechainSuffix = log.isSidechain ? ' (sidechain)' : '';
  const maxSummaryWidth = maxLabelWidth - prefixWidth - sidechainSuffix.length - sessionCountSuffix.length;
  const truncatedSummary = normalizeAndTruncateToWidth(getResumeLogDisplayTitle(log), maxSummaryWidth);
  return `${truncatedSummary}${sidechainSuffix}${sessionCountSuffix}`;
}
function buildLogMetadata(log: LogOption, options?: {
  isChild?: boolean;
  showProjectPath?: boolean;
}): string {
  const {
    isChild = false,
    showProjectPath = false
  } = options || {};
  // Match the child prefix width for proper alignment
  const childPadding = isChild ? '    ' : ''; // 4 spaces to match '  ▸ '
  const baseMetadata = formatLogMetadata(log);
  const projectSuffix = showProjectPath && log.projectPath ? ` · ${log.projectPath}` : '';
  return childPadding + baseMetadata + projectSuffix;
}
export function getResumeLogDisplayTitle(log: LogOption): string {
  const branchName = log.sessionBranch?.branchName?.trim()
  if (branchName) {
    const sessionTitle = log.agentName || log.customTitle
    if (sessionTitle) return getLogDisplayTitle(log)
    return branchName
  }
  return getLogDisplayTitle(log)
}
export function logMatchesResumePickerSearch(log: LogOption, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return true
  const displayedTitle = getResumeLogDisplayTitle(log).toLowerCase()
  const baseDisplayTitle = getLogDisplayTitle(log).toLowerCase()
  const branchName = (log.sessionBranch?.branchName || "").toLowerCase()
  const branch = (log.gitBranch || "").toLowerCase()
  const tag = (log.tag || "").toLowerCase()
  const prInfo = log.prNumber ? `pr #${log.prNumber} ${log.prRepository || ""}`.toLowerCase() : ""
  return displayedTitle.includes(query) || baseDisplayTitle.includes(query) || branchName.includes(query) || branch.includes(query) || tag.includes(query) || prInfo.includes(query)
}
export function shouldLoadMoreResumeLogs(options: {
  displayedLogCount: number;
  focusedIndex: number;
  visibleCount: number;
  visibleNodeCount: number;
}): boolean {
  const {
    displayedLogCount,
    focusedIndex,
    visibleCount,
    visibleNodeCount
  } = options
  const buffer = visibleCount * 2
  return visibleNodeCount < visibleCount || focusedIndex + buffer >= displayedLogCount
}
export function countVisibleResumeTreeRows(
  nodes: readonly TreeNode<unknown>[],
  options: {
    expandedGroupSessionIds: ReadonlySet<string>;
    forceExpanded: boolean;
  },
): number {
  const { expandedGroupSessionIds, forceExpanded } = options
  const isExpanded = (nodeId: string | number): boolean => {
    if (forceExpanded) return true
    const groupSessionId = typeof nodeId === "string" && nodeId.startsWith("group:") ? nodeId.slice(6) : null
    return groupSessionId ? expandedGroupSessionIds.has(groupSessionId) : false
  }
  const countNode = (node: TreeNode<unknown>): number => {
    const children = node.children ?? []
    if (children.length === 0 || !isExpanded(node.id)) return 1
    return 1 + children.reduce((count, child) => count + countNode(child), 0)
  }

  return nodes.reduce((count, node) => count + countNode(node), 0)
}
function findContainingGroupNode(nodes: LogTreeNode[], nodeId?: string | number): LogTreeNode | null {
  if (!nodeId) return null
  for (const node of nodes) {
    if (node.id === nodeId) return node
    if (node.children?.some(child => child.id === nodeId)) {
      return node
    }
  }
  return null
}
export function LogSelector(t0: LogSelectorProps) {
  const $ = _c(247);
  const {
    logs,
    maxHeight: t1,
    forceWidth,
    onCancel,
    onSelect,
    onDeleteRequest,
    isInputDisabled: t1a,
    onLogsChanged,
    onLoadMore,
    initialSearchQuery,
    showAllProjects: t2,
    onToggleAllProjects,
    onAgenticSearch
  } = t0;
  const maxHeight = t1 === undefined ? Infinity : t1;
  const showAllProjects = t2 === undefined ? false : t2;
  const isInputDisabled = t1a === undefined ? false : t1a;
  const terminalSize = useTerminalSize();
  const columns = forceWidth === undefined ? terminalSize.columns : forceWidth;
  const exitState = useExitOnCtrlCDWithKeybindings(onCancel);
  const isTerminalFocused = useTerminalFocus();
  let t3;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = isCustomTitleEnabled();
    $[0] = t3;
  } else {
    t3 = $[0];
  }
  const isResumeWithRenameEnabled = t3;
  const isDeepSearchEnabled = false;
  const [themeName] = useTheme();
  let t4;
  if ($[1] !== themeName) {
    t4 = getTheme(themeName);
    $[1] = themeName;
    $[2] = t4;
  } else {
    t4 = $[2];
  }
  const theme = t4;
  let t5;
  if ($[3] !== theme.warning) {
    t5 = text => applyColor(text, theme.warning as Color);
    $[3] = theme.warning;
    $[4] = t5;
  } else {
    t5 = $[4];
  }
  const highlightColor = t5;
  const isAgenticSearchEnabled = false;
  const [currentBranch, setCurrentBranch] = React.useState<string | null>(null);
  const [branchFilterEnabled, setBranchFilterEnabled] = React.useState(false);
  const [showAllWorktrees, setShowAllWorktrees] = React.useState(false);
  const [hasMultipleWorktrees, setHasMultipleWorktrees] = React.useState(false);
  let t6;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = getOriginalCwd();
    $[5] = t6;
  } else {
    t6 = $[5];
  }
  const currentCwd = t6;
  const [renameValue, setRenameValue] = React.useState("");
  const [renameCursorOffset, setRenameCursorOffset] = React.useState(0);
  let t7: Set<string>;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = new Set();
    $[6] = t7;
  } else {
    t7 = $[6];
  }
  const [expandedGroupSessionIds, setExpandedGroupSessionIds] = React.useState<Set<string>>(t7);
  const [focusedNode, setFocusedNode] = React.useState<LogTreeNode | null>(null);
  const [focusedIndex, setFocusedIndex] = React.useState(1);
  const [viewMode, setViewMode] = React.useState<ViewMode>("list");
  const [previewLog, setPreviewLog] = React.useState<LogOption | null>(null);
  const prevFocusedIdRef = React.useRef<string | null>(null);
  // Fresh-per-keypress view of the delete props for the memoized input
  // handler below (t53): reading via ref avoids adding new memo slots.
  const deleteUiRef = React.useRef({
    onDeleteRequest,
    isInputDisabled
  });
  React.useEffect(() => {
    deleteUiRef.current = {
      onDeleteRequest,
      isInputDisabled
    };
  });
  const [selectedTagIndex, setSelectedTagIndex] = React.useState(0);
  let t8: AgenticSearchState;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = {
      status: "idle"
    };
    $[7] = t8;
  } else {
    t8 = $[7];
  }
  const [agenticSearchState, setAgenticSearchState] = React.useState<AgenticSearchState>(t8);
  const [isAgenticSearchOptionFocused, setIsAgenticSearchOptionFocused] = React.useState(false);
  const agenticSearchAbortRef = React.useRef<AbortController | null>(null);
  const agenticResults = agenticSearchState.status === "results" ? agenticSearchState.results : EMPTY_AGENTIC_RESULTS;
  const agenticResultsQuery = agenticSearchState.status === "results" ? agenticSearchState.query : undefined;
  const t9 = viewMode === "search" && agenticSearchState.status !== "searching";
  let t10;
  let t11;
  let t12;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = () => {
      setViewMode("list");
      logEvent("tengu_session_search_toggled", {
        enabled: false
      });
    };
    t11 = () => {
      setViewMode("list");
      logEvent("tengu_session_search_toggled", {
        enabled: false
      });
    };
    t12 = ["n"];
    $[8] = t10;
    $[9] = t11;
    $[10] = t12;
  } else {
    t10 = $[8];
    t11 = $[9];
    t12 = $[10];
  }
  const t13 = initialSearchQuery || "";
  let t14;
  if ($[11] !== t13 || $[12] !== t9) {
    t14 = {
      isActive: t9,
      onExit: t10,
      onExitUp: t11,
      passthroughCtrlKeys: t12,
      initialQuery: t13
    };
    $[11] = t13;
    $[12] = t9;
    $[13] = t14;
  } else {
    t14 = $[13];
  }
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset
  } = useSearchInput(t14);
  const deferredSearchQuery = React.useDeferredValue(searchQuery);
  const [debouncedDeepSearchQuery, setDebouncedDeepSearchQuery] = React.useState("");
  let t15;
  let t16;
  if ($[14] !== deferredSearchQuery) {
    t15 = () => {
      if (!deferredSearchQuery) {
        setDebouncedDeepSearchQuery("");
        return;
      }
      const timeoutId = setTimeout(setDebouncedDeepSearchQuery, 300, deferredSearchQuery);
      return () => clearTimeout(timeoutId);
    };
    t16 = [deferredSearchQuery];
    $[14] = deferredSearchQuery;
    $[15] = t15;
    $[16] = t16;
  } else {
    t15 = $[15];
    t16 = $[16];
  }
  React.useEffect(t15, t16);
  const [deepSearchResults, setDeepSearchResults] = React.useState<DeepSearchResults | null>(null);
  const [isSearching, setIsSearching] = React.useState(false);
  let t17;
  let t18;
  if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
    t17 = () => {
      getBranch().then(branch => setCurrentBranch(branch));
      getWorktreePaths(currentCwd).then(paths => {
        setHasMultipleWorktrees(paths.length > 1);
      });
    };
    t18 = [currentCwd];
    $[17] = t17;
    $[18] = t18;
  } else {
    t17 = $[17];
    t18 = $[18];
  }
  React.useEffect(t17, t18);
  const searchableTextByLog = new Map<LogOption, string>(logs.map(_temp));
  let t19;
  t19 = null;
  let t20;
  if ($[19] !== logs) {
    t20 = getUniqueTags(logs);
    $[19] = logs;
    $[20] = t20;
  } else {
    t20 = $[20];
  }
  const uniqueTags = t20;
  const hasTags = uniqueTags.length > 0;
  let t21;
  if ($[21] !== hasTags || $[22] !== uniqueTags) {
    t21 = hasTags ? ["All", ...uniqueTags] : [];
    $[21] = hasTags;
    $[22] = uniqueTags;
    $[23] = t21;
  } else {
    t21 = $[23];
  }
  const tagTabs = t21;
  const effectiveTagIndex = tagTabs.length > 0 && selectedTagIndex < tagTabs.length ? selectedTagIndex : 0;
  const selectedTab = tagTabs[effectiveTagIndex];
  const tagFilter = selectedTab === "All" ? undefined : selectedTab;
  const tagTabsLines = hasTags ? 1 : 0;
  let filtered = logs;
  if (isResumeWithRenameEnabled) {
    let t22;
    if ($[24] !== logs) {
      t22 = logs.filter(_temp2);
      $[24] = logs;
      $[25] = t22;
    } else {
      t22 = $[25];
    }
    filtered = t22;
  }
  if (tagFilter !== undefined) {
    let t22;
    if ($[26] !== filtered || $[27] !== tagFilter) {
      let t23;
      if ($[29] !== tagFilter) {
        t23 = log_2 => log_2.tag === tagFilter;
        $[29] = tagFilter;
        $[30] = t23;
      } else {
        t23 = $[30];
      }
      t22 = filtered.filter(t23);
      $[26] = filtered;
      $[27] = tagFilter;
      $[28] = t22;
    } else {
      t22 = $[28];
    }
    filtered = t22;
  }
  if (branchFilterEnabled && currentBranch) {
    let t22;
    if ($[31] !== currentBranch || $[32] !== filtered) {
      let t23;
      if ($[34] !== currentBranch) {
        t23 = log_3 => log_3.gitBranch === currentBranch;
        $[34] = currentBranch;
        $[35] = t23;
      } else {
        t23 = $[35];
      }
      t22 = filtered.filter(t23);
      $[31] = currentBranch;
      $[32] = filtered;
      $[33] = t22;
    } else {
      t22 = $[33];
    }
    filtered = t22;
  }
  if (hasMultipleWorktrees && !showAllWorktrees) {
    let t22;
    if ($[36] !== filtered) {
      let t23;
      if ($[38] === Symbol.for("react.memo_cache_sentinel")) {
        t23 = log_4 => log_4.projectPath === currentCwd;
        $[38] = t23;
      } else {
        t23 = $[38];
      }
      t22 = filtered.filter(t23);
      $[36] = filtered;
      $[37] = t22;
    } else {
      t22 = $[37];
    }
    filtered = t22;
  }
  const baseFilteredLogs = filtered;
  let t22;
  bb0: {
    if (!searchQuery) {
      t22 = baseFilteredLogs;
      break bb0;
    }
    let t23;
    if ($[39] !== baseFilteredLogs || $[40] !== searchQuery) {
      t23 = baseFilteredLogs.filter(log_5 => logMatchesResumePickerSearch(log_5, searchQuery));
      $[39] = baseFilteredLogs;
      $[40] = searchQuery;
      $[41] = t23;
    } else {
      t23 = $[41];
    }
    t22 = t23;
  }
  const titleFilteredLogs = t22;
  let t23;
  let t24;
  if ($[42] !== debouncedDeepSearchQuery || $[43] !== deferredSearchQuery) {
    t23 = () => {
      if (false && deferredSearchQuery && deferredSearchQuery !== debouncedDeepSearchQuery) {
        setIsSearching(true);
      }
    };
    t24 = [deferredSearchQuery, debouncedDeepSearchQuery, false];
    $[42] = debouncedDeepSearchQuery;
    $[43] = deferredSearchQuery;
    $[44] = t23;
    $[45] = t24;
  } else {
    t23 = $[44];
    t24 = $[45];
  }
  React.useEffect(t23, t24);
  let t25;
  let t26;
  if ($[46] !== debouncedDeepSearchQuery) {
    t25 = () => {
      if (true || !debouncedDeepSearchQuery || true) {
        setDeepSearchResults(null);
        setIsSearching(false);
        return;
      }
      const timeoutId_0 = setTimeout(_temp5, 0, null, debouncedDeepSearchQuery, setDeepSearchResults, setIsSearching);
      return () => {
        clearTimeout(timeoutId_0);
      };
    };
    t26 = [debouncedDeepSearchQuery, null, false];
    $[46] = debouncedDeepSearchQuery;
    $[47] = t25;
    $[48] = t26;
  } else {
    t25 = $[47];
    t26 = $[48];
  }
  React.useEffect(t25, t26);
  let filtered_0: LogOption[];
  let snippetMap: Map<LogOption, Snippet>;
  if ($[49] !== debouncedDeepSearchQuery || $[50] !== deepSearchResults || $[51] !== titleFilteredLogs) {
    snippetMap = new Map();
    filtered_0 = titleFilteredLogs;
    if (deepSearchResults && debouncedDeepSearchQuery && deepSearchResults.query === debouncedDeepSearchQuery) {
      for (const result of deepSearchResults.results) {
        if (result.searchableText) {
          const snippet = extractSnippet(result.searchableText, debouncedDeepSearchQuery, SNIPPET_CONTEXT_CHARS);
          if (snippet) {
            snippetMap.set(result.log, snippet);
          }
        }
      }
      let t27;
      if ($[54] !== filtered_0) {
        t27 = new Set(filtered_0.map(_temp6));
        $[54] = filtered_0;
        $[55] = t27;
      } else {
        t27 = $[55];
      }
      const titleMatchIds = t27;
      let t28;
      if ($[56] !== deepSearchResults.results || $[57] !== filtered_0 || $[58] !== titleMatchIds) {
        let t29;
        if ($[60] !== titleMatchIds) {
          t29 = log_7 => !titleMatchIds.has(log_7.messages[0]?.uuid);
          $[60] = titleMatchIds;
          $[61] = t29;
        } else {
          t29 = $[61];
        }
        const transcriptOnlyMatches = deepSearchResults.results.map(_temp7).filter(t29);
        t28 = [...filtered_0, ...transcriptOnlyMatches];
        $[56] = deepSearchResults.results;
        $[57] = filtered_0;
        $[58] = titleMatchIds;
        $[59] = t28;
      } else {
        t28 = $[59];
      }
      filtered_0 = t28;
    }
    $[49] = debouncedDeepSearchQuery;
    $[50] = deepSearchResults;
    $[51] = titleFilteredLogs;
    $[52] = filtered_0;
    $[53] = snippetMap;
  } else {
    filtered_0 = $[52];
    snippetMap = $[53];
  }
  let t27: FilteredLogState;
  if ($[62] !== filtered_0 || $[63] !== snippetMap) {
    t27 = {
      filteredLogs: filtered_0,
      snippets: snippetMap
    };
    $[62] = filtered_0;
    $[63] = snippetMap;
    $[64] = t27;
  } else {
    t27 = $[64];
  }
  const {
    filteredLogs,
    snippets
  } = t27;
  let t28: LogOption[];
  bb1: {
    if (agenticSearchState.status === "results" && agenticSearchState.results.length > 0) {
      t28 = agenticSearchState.results;
      break bb1;
    }
    t28 = filteredLogs;
  }
  const displayedLogs = t28;
  const maxLabelWidth = Math.max(30, columns - 4);
  let t29: LogTreeNode[];
  bb2: {
    if (!isResumeWithRenameEnabled) {
      let t30;
      if ($[65] === Symbol.for("react.memo_cache_sentinel")) {
        t30 = [];
        $[65] = t30;
      } else {
        t30 = $[65];
      }
      t29 = t30;
      break bb2;
    }
    let t30;
    if ($[66] !== displayedLogs || $[67] !== highlightColor || $[68] !== maxLabelWidth || $[69] !== showAllProjects || $[70] !== snippets) {
      const sessionGroups = groupLogsByResumeBranch(displayedLogs);
      t30 = sessionGroups.map(group => {
        const latestLog = group.headerLog;
        const indexInFiltered = group.firstIndex;
        const snippet_0 = snippets.get(latestLog);
        const snippetStr = snippet_0 ? formatSnippet(snippet_0, highlightColor) : null;
        if (group.childLogs.length === 0) {
          const metadata = buildLogMetadata(latestLog, {
            showProjectPath: showAllProjects
          });
          return {
            id: `log:${group.id}:0`,
            value: {
              log: latestLog,
              indexInFiltered
            },
            label: buildLogLabel(latestLog, maxLabelWidth),
            description: snippetStr ? `${metadata}\n  ${snippetStr}` : metadata,
            dimDescription: true
          };
        }
        const forkCount = group.childLogs.length;
        const children = group.childLogs.map((log_8, index) => {
          const childIndexInFiltered = displayedLogs.indexOf(log_8);
          const childSnippet = snippets.get(log_8);
          const childSnippetStr = childSnippet ? formatSnippet(childSnippet, highlightColor) : null;
          const childMetadata = buildLogMetadata(log_8, {
            isChild: true,
            showProjectPath: showAllProjects
          });
          return {
            id: `log:${group.id}:${index + 1}`,
            value: {
              log: log_8,
              indexInFiltered: childIndexInFiltered
            },
            label: buildLogLabel(log_8, maxLabelWidth, {
              isChild: true
            }),
            description: childSnippetStr ? `${childMetadata}\n      ${childSnippetStr}` : childMetadata,
            dimDescription: true
          };
        });
        const parentMetadata = buildLogMetadata(latestLog, {
          showProjectPath: showAllProjects
        });
        return {
          id: `group:${group.id}`,
          value: {
            log: latestLog,
            indexInFiltered
          },
          label: buildLogLabel(latestLog, maxLabelWidth, {
            isGroupHeader: true,
            forkCount
          }),
          description: snippetStr ? `${parentMetadata}\n  ${snippetStr}` : parentMetadata,
          dimDescription: true,
          children
        };
      });
      $[66] = displayedLogs;
      $[67] = highlightColor;
      $[68] = maxLabelWidth;
      $[69] = showAllProjects;
      $[70] = snippets;
      $[71] = t30;
    } else {
      t30 = $[71];
    }
    t29 = t30;
  }
  const treeNodes = t29;
  let t30: OptionWithDescription<string>[];
  bb3: {
    if (isResumeWithRenameEnabled) {
      let t31;
      if ($[72] === Symbol.for("react.memo_cache_sentinel")) {
        t31 = [];
        $[72] = t31;
      } else {
        t31 = $[72];
      }
      t30 = t31;
      break bb3;
    }
    let t31;
    if ($[73] !== displayedLogs || $[74] !== highlightColor || $[75] !== maxLabelWidth || $[76] !== showAllProjects || $[77] !== snippets) {
      let t32;
      if ($[79] !== highlightColor || $[80] !== maxLabelWidth || $[81] !== showAllProjects || $[82] !== snippets) {
        t32 = (log_9, index_0) => {
          const rawSummary = getResumeLogDisplayTitle(log_9);
          const summaryWithSidechain = rawSummary + (log_9.isSidechain ? " (sidechain)" : "");
          const summary = normalizeAndTruncateToWidth(summaryWithSidechain, maxLabelWidth);
          const baseDescription = formatLogMetadata(log_9);
          const projectSuffix = showAllProjects && log_9.projectPath ? ` · ${log_9.projectPath}` : "";
          const snippet_1 = snippets.get(log_9);
          const snippetStr_0 = snippet_1 ? formatSnippet(snippet_1, highlightColor) : null;
          return {
            label: summary,
            description: snippetStr_0 ? `${baseDescription}${projectSuffix}\n  ${snippetStr_0}` : baseDescription + projectSuffix,
            dimDescription: true,
            value: index_0.toString()
          };
        };
        $[79] = highlightColor;
        $[80] = maxLabelWidth;
        $[81] = showAllProjects;
        $[82] = snippets;
        $[83] = t32;
      } else {
        t32 = $[83];
      }
      t31 = displayedLogs.map(t32);
      $[73] = displayedLogs;
      $[74] = highlightColor;
      $[75] = maxLabelWidth;
      $[76] = showAllProjects;
      $[77] = snippets;
      $[78] = t31;
    } else {
      t31 = $[78];
    }
    t30 = t31;
  }
  const flatOptions = t30;
  const focusedLog = focusedNode?.value.log ?? null;
  let t31;
  if ($[84] !== treeNodes || $[85] !== expandedGroupSessionIds || $[86] !== focusedNode?.id) {
    t31 = () => {
      if (!isResumeWithRenameEnabled || !focusedNode) {
        return "";
      }
      const groupNode = findContainingGroupNode(treeNodes, focusedNode.id);
      if (!groupNode?.children?.length || !String(groupNode.id).startsWith("group:")) {
        return "";
      }
      const groupId = String(groupNode.id).substring(6);
      const isExpanded = expandedGroupSessionIds.has(groupId);
      const isChildNode = focusedNode.id !== groupNode.id;
      if (isChildNode) {
        return "\u2190 to collapse";
      }
      return isExpanded ? "\u2190 to collapse" : "\u2192 to expand";
    };
    $[84] = treeNodes;
    $[85] = expandedGroupSessionIds;
    $[86] = focusedNode?.id;
    $[87] = t31;
  } else {
    t31 = $[87];
  }
  const getExpandCollapseHint = t31;
  let t32;
  if ($[88] !== focusedLog || $[89] !== onLogsChanged || $[90] !== renameValue) {
    t32 = async () => {
      const sessionId_1 = focusedLog ? getSessionIdFromLog(focusedLog) : undefined;
      if (!focusedLog || !sessionId_1) {
        setViewMode("list");
        setRenameValue("");
        return;
      }
      if (renameValue.trim()) {
        await saveCustomTitle(sessionId_1, renameValue.trim(), focusedLog.fullPath);
        if (isResumeWithRenameEnabled && onLogsChanged) {
          onLogsChanged();
        }
      }
      setViewMode("list");
      setRenameValue("");
    };
    $[88] = focusedLog;
    $[89] = onLogsChanged;
    $[90] = renameValue;
    $[91] = t32;
  } else {
    t32 = $[91];
  }
  const handleRenameSubmit = t32;
  let t33;
  if ($[92] === Symbol.for("react.memo_cache_sentinel")) {
    t33 = () => {
      setViewMode("list");
      logEvent("tengu_session_search_toggled", {
        enabled: false
      });
    };
    $[92] = t33;
  } else {
    t33 = $[92];
  }
  const exitSearchMode = t33;
  let t34;
  if ($[93] === Symbol.for("react.memo_cache_sentinel")) {
    t34 = () => {
      setViewMode("search");
      logEvent("tengu_session_search_toggled", {
        enabled: true
      });
    };
    $[93] = t34;
  } else {
    t34 = $[93];
  }
  const enterSearchMode = t34;
  let t35;
  if ($[94] !== logs || $[95] !== onAgenticSearch || $[96] !== searchQuery) {
    t35 = async () => {
      const runAgenticSearch = onAgenticSearch;
      if (!searchQuery.trim() || !runAgenticSearch || !isAgenticSearchEnabled) {
        return;
      }
      agenticSearchAbortRef.current?.abort();
      const abortController = new AbortController();
      agenticSearchAbortRef.current = abortController;
      setAgenticSearchState({
        status: "searching"
      });
      logEvent("tengu_agentic_search_started", {
        query_length: searchQuery.length
      });
      ;
      try {
        const results_0 = await runAgenticSearch(searchQuery, logs, abortController.signal);
        if (abortController.signal.aborted) {
          return;
        }
        setAgenticSearchState({
          status: "results",
          results: results_0,
          query: searchQuery
        });
        logEvent("tengu_agentic_search_completed", {
          query_length: searchQuery.length,
          results_count: results_0.length
        });
      } catch (t36) {
        const message = getErrorMessage(t36);
        if (abortController.signal.aborted) {
          return;
        }
        setAgenticSearchState({
          status: "error",
          message
        });
        logEvent("tengu_agentic_search_error", {
          query_length: searchQuery.length
        });
      }
    };
    $[94] = logs;
    $[95] = onAgenticSearch;
    $[96] = searchQuery;
    $[97] = t35;
  } else {
    t35 = $[97];
  }
  const handleAgenticSearch = t35;
  let t36;
  if ($[98] !== agenticResultsQuery || $[99] !== agenticSearchState.status || $[100] !== searchQuery) {
    t36 = () => {
      if (agenticSearchState.status !== "idle" && agenticSearchState.status !== "searching") {
        if (agenticSearchState.status === "results" && agenticSearchState.query !== searchQuery || agenticSearchState.status === "error") {
          setAgenticSearchState({
            status: "idle"
          });
        }
      }
    };
    $[98] = agenticResultsQuery;
    $[99] = agenticSearchState.status;
    $[100] = searchQuery;
    $[101] = t36;
  } else {
    t36 = $[101];
  }
  let t37;
  if ($[102] !== agenticSearchState || $[103] !== searchQuery) {
    t37 = [searchQuery, agenticSearchState];
    $[102] = agenticSearchState;
    $[103] = searchQuery;
    $[104] = t37;
  } else {
    t37 = $[104];
  }
  React.useEffect(t36, t37);
  let t38;
  let t39;
  if ($[105] === Symbol.for("react.memo_cache_sentinel")) {
    t38 = () => () => {
      agenticSearchAbortRef.current?.abort();
    };
    t39 = [];
    $[105] = t38;
    $[106] = t39;
  } else {
    t38 = $[105];
    t39 = $[106];
  }
  React.useEffect(t38, t39);
  const prevAgenticStatusRef = React.useRef(agenticSearchState.status);
  let t40;
  if ($[107] !== agenticSearchState.status || $[108] !== displayedLogs[0] || $[109] !== displayedLogs.length || $[110] !== treeNodes) {
    t40 = () => {
      const prevStatus = prevAgenticStatusRef.current;
      prevAgenticStatusRef.current = agenticSearchState.status;
      if (prevStatus === "searching" && agenticSearchState.status === "results") {
        if (isResumeWithRenameEnabled && treeNodes.length > 0) {
          setFocusedNode(treeNodes[0]);
        } else {
          if (!isResumeWithRenameEnabled && displayedLogs.length > 0) {
            const firstLog = displayedLogs[0];
            setFocusedNode({
              id: "0",
              value: {
                log: firstLog,
                indexInFiltered: 0
              },
              label: ""
            });
          }
        }
      }
    };
    $[107] = agenticSearchState.status;
    $[108] = displayedLogs[0];
    $[109] = displayedLogs.length;
    $[110] = treeNodes;
    $[111] = t40;
  } else {
    t40 = $[111];
  }
  let t41;
  if ($[112] !== agenticSearchState.status || $[113] !== displayedLogs || $[114] !== treeNodes) {
    t41 = [agenticSearchState.status, isResumeWithRenameEnabled, treeNodes, displayedLogs];
    $[112] = agenticSearchState.status;
    $[113] = displayedLogs;
    $[114] = treeNodes;
    $[115] = t41;
  } else {
    t41 = $[115];
  }
  React.useEffect(t40, t41);
  let t42;
  if ($[116] !== displayedLogs) {
    t42 = (value: string) => {
      const index_1 = parseInt(value, 10);
      const log_11 = displayedLogs[index_1];
      if (!log_11 || prevFocusedIdRef.current === index_1.toString()) {
        return;
      }
      prevFocusedIdRef.current = index_1.toString();
      setFocusedNode({
        id: index_1.toString(),
        value: {
          log: log_11,
          indexInFiltered: index_1
        },
        label: ""
      });
      setFocusedIndex(index_1 + 1);
    };
    $[116] = displayedLogs;
    $[117] = t42;
  } else {
    t42 = $[117];
  }
  const handleFlatOptionsSelectFocus = t42;
  let t43;
  if ($[118] !== displayedLogs) {
    t43 = (node: LogTreeNode) => {
      setFocusedNode(node);
      setFocusedIndex(node.value.indexInFiltered + 1);
    };
    $[118] = displayedLogs;
    $[119] = t43;
  } else {
    t43 = $[119];
  }
  const handleTreeSelectFocus = t43;
  let t44;
  if ($[120] === Symbol.for("react.memo_cache_sentinel")) {
    t44 = () => {
      agenticSearchAbortRef.current?.abort();
      setAgenticSearchState({
        status: "idle"
      });
      logEvent("tengu_agentic_search_cancelled", {});
    };
    $[120] = t44;
  } else {
    t44 = $[120];
  }
  const t45 = viewMode !== "preview" && agenticSearchState.status === "searching";
  let t46;
  if ($[121] !== t45) {
    t46 = {
      context: "Confirmation",
      isActive: t45
    };
    $[121] = t45;
    $[122] = t46;
  } else {
    t46 = $[122];
  }
  useKeybinding("confirm:no", t44, t46);
  let t47;
  if ($[123] === Symbol.for("react.memo_cache_sentinel")) {
    t47 = () => {
      setViewMode("list");
      setRenameValue("");
    };
    $[123] = t47;
  } else {
    t47 = $[123];
  }
  const t48 = viewMode === "rename" && agenticSearchState.status !== "searching";
  let t49;
  if ($[124] !== t48) {
    t49 = {
      context: "Settings",
      isActive: t48
    };
    $[124] = t48;
    $[125] = t49;
  } else {
    t49 = $[125];
  }
  useKeybinding("confirm:no", t47, t49);
  let t50;
  if ($[126] !== onCancel || $[127] !== setSearchQuery) {
    t50 = () => {
      setSearchQuery("");
      setIsAgenticSearchOptionFocused(false);
      onCancel?.();
    };
    $[126] = onCancel;
    $[127] = setSearchQuery;
    $[128] = t50;
  } else {
    t50 = $[128];
  }
  const t51 = viewMode !== "preview" && viewMode !== "rename" && viewMode !== "search" && isAgenticSearchOptionFocused && agenticSearchState.status !== "searching";
  let t52;
  if ($[129] !== t51) {
    t52 = {
      context: "Confirmation",
      isActive: t51
    };
    $[129] = t51;
    $[130] = t52;
  } else {
    t52 = $[130];
  }
  useKeybinding("confirm:no", t50, t52);
  let t53;
  if ($[131] !== agenticSearchState.status || $[132] !== branchFilterEnabled || $[133] !== focusedLog || $[134] !== handleAgenticSearch || $[135] !== hasMultipleWorktrees || $[136] !== hasTags || $[137] !== isAgenticSearchOptionFocused || $[138] !== onAgenticSearch || $[139] !== onToggleAllProjects || $[140] !== searchQuery || $[141] !== setSearchQuery || $[142] !== showAllProjects || $[143] !== showAllWorktrees || $[144] !== tagTabs || $[145] !== uniqueTags || $[146] !== viewMode) {
    t53 = (input, key) => {
      if (deleteUiRef.current.isInputDisabled) {
        return;
      }
      if (viewMode === "preview") {
        return;
      }
      if (agenticSearchState.status === "searching") {
        return;
      }
      if (viewMode === "rename") {} else {
        if (viewMode === "search") {
          if (input.toLowerCase() === "n" && key.ctrl) {
            exitSearchMode();
          } else {
            if (key.return || key.downArrow) {
              if (searchQuery.trim() && onAgenticSearch && false && agenticSearchState.status !== "results") {
                setIsAgenticSearchOptionFocused(true);
              }
            }
          }
        } else {
          if (isAgenticSearchOptionFocused) {
            if (key.return) {
              handleAgenticSearch();
              setIsAgenticSearchOptionFocused(false);
              return;
            } else {
              if (key.downArrow) {
                setIsAgenticSearchOptionFocused(false);
                return;
              } else {
                if (key.upArrow) {
                  setViewMode("search");
                  setIsAgenticSearchOptionFocused(false);
                  return;
                }
              }
            }
          }
          if (hasTags && key.tab) {
            const offset = key.shift ? -1 : 1;
            setSelectedTagIndex(prev => {
              const current = prev < tagTabs.length ? prev : 0;
              const newIndex = (current + tagTabs.length + offset) % tagTabs.length;
              const newTab = tagTabs[newIndex];
              logEvent("tengu_session_tag_filter_changed", {
                is_all: newTab === "All",
                tag_count: uniqueTags.length
              });
              return newIndex;
            });
            return;
          }
          const keyIsNotCtrlOrMeta = !key.ctrl && !key.meta;
          const lowerInput = input.toLowerCase();
          if (lowerInput === "a" && key.ctrl && onToggleAllProjects) {
            onToggleAllProjects();
            logEvent("tengu_session_all_projects_toggled", {
              enabled: !showAllProjects
            });
          } else {
            if (lowerInput === "b" && key.ctrl) {
              const newEnabled = !branchFilterEnabled;
              setBranchFilterEnabled(newEnabled);
              logEvent("tengu_session_branch_filter_toggled", {
                enabled: newEnabled
              });
            } else {
              if (lowerInput === "w" && key.ctrl && hasMultipleWorktrees) {
                const newValue = !showAllWorktrees;
                setShowAllWorktrees(newValue);
                logEvent("tengu_session_worktree_filter_toggled", {
                  enabled: newValue
                });
              } else {
                if (lowerInput === "/" && keyIsNotCtrlOrMeta) {
                  setViewMode("search");
                  logEvent("tengu_session_search_toggled", {
                    enabled: true
                  });
                } else {
                  if (lowerInput === "r" && key.ctrl && focusedLog) {
                    setViewMode("rename");
                    setRenameValue("");
                    logEvent("tengu_session_rename_started", {});
                  } else {
                    if (lowerInput === "v" && key.ctrl && focusedLog) {
                      setPreviewLog(focusedLog);
                      setViewMode("preview");
                      logEvent("tengu_session_preview_opened", {
                        messageCount: focusedLog.messageCount
                      });
                    } else {
                      if (key.delete && focusedLog) {
                        deleteUiRef.current.onDeleteRequest?.(focusedLog);
                        return;
                      }
                      if (focusedLog && keyIsNotCtrlOrMeta && input.length > 0 && !/^\s+$/.test(input)) {
                        setViewMode("search");
                        setSearchQuery(input);
                        logEvent("tengu_session_search_toggled", {
                          enabled: true
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };
    $[131] = agenticSearchState.status;
    $[132] = branchFilterEnabled;
    $[133] = focusedLog;
    $[134] = handleAgenticSearch;
    $[135] = hasMultipleWorktrees;
    $[136] = hasTags;
    $[137] = isAgenticSearchOptionFocused;
    $[138] = onAgenticSearch;
    $[139] = onToggleAllProjects;
    $[140] = searchQuery;
    $[141] = setSearchQuery;
    $[142] = showAllProjects;
    $[143] = showAllWorktrees;
    $[144] = tagTabs;
    $[145] = uniqueTags;
    $[146] = viewMode;
    $[147] = t53;
  } else {
    t53 = $[147];
  }
  let t54;
  if ($[148] === Symbol.for("react.memo_cache_sentinel")) {
    t54 = {
      isActive: true
    };
    $[148] = t54;
  } else {
    t54 = $[148];
  }
  useInput(t53, t54);
  let filterIndicators;
  if ($[149] !== branchFilterEnabled || $[150] !== currentBranch || $[151] !== hasMultipleWorktrees || $[152] !== showAllWorktrees) {
    filterIndicators = [];
    if (branchFilterEnabled && currentBranch) {
      filterIndicators.push(currentBranch);
    }
    if (hasMultipleWorktrees && !showAllWorktrees) {
      filterIndicators.push("current worktree");
    }
    $[149] = branchFilterEnabled;
    $[150] = currentBranch;
    $[151] = hasMultipleWorktrees;
    $[152] = showAllWorktrees;
    $[153] = filterIndicators;
  } else {
    filterIndicators = $[153];
  }
  const showAdditionalFilterLine = filterIndicators.length > 0 && viewMode !== "search";
  const headerLines = 8 + (showAdditionalFilterLine ? 1 : 0) + tagTabsLines;
  const visibleCount = Math.max(1, Math.floor((maxHeight - headerLines - 2) / 3));
  const loadMoreVisibleCount = isResumeWithRenameEnabled ? countVisibleResumeTreeRows(treeNodes, {
    expandedGroupSessionIds,
    forceExpanded: viewMode === "search" || branchFilterEnabled
  }) : displayedLogs.length;
  React.useEffect(() => {
    if (!onLoadMore) {
      return;
    }
    if (shouldLoadMoreResumeLogs({
      displayedLogCount: displayedLogs.length,
      focusedIndex,
      visibleCount,
      visibleNodeCount: loadMoreVisibleCount
    })) {
      onLoadMore(visibleCount * 3);
    }
  }, [displayedLogs.length, focusedIndex, loadMoreVisibleCount, onLoadMore, visibleCount]);
  if (logs.length === 0) {
    return null;
  }
  if (viewMode === "preview" && previewLog && isResumeWithRenameEnabled) {
    let t57;
    if ($[160] === Symbol.for("react.memo_cache_sentinel")) {
      t57 = () => {
        setViewMode("list");
        setPreviewLog(null);
      };
      $[160] = t57;
    } else {
      t57 = $[160];
    }
    let t58;
    if ($[161] !== onSelect || $[162] !== previewLog) {
      t58 = <SessionPreview log={previewLog} onExit={t57} onSelect={onSelect} />;
      $[161] = onSelect;
      $[162] = previewLog;
      $[163] = t58;
    } else {
      t58 = $[163];
    }
    return t58;
  }
  const t57 = maxHeight - 1;
  let t58;
  if ($[164] === Symbol.for("react.memo_cache_sentinel")) {
    t58 = <Box flexShrink={0}><Divider color="suggestion" /></Box>;
    $[164] = t58;
  } else {
    t58 = $[164];
  }
  let t59;
  if ($[165] === Symbol.for("react.memo_cache_sentinel")) {
    t59 = <Box flexShrink={0}><Text> </Text></Box>;
    $[165] = t59;
  } else {
    t59 = $[165];
  }
  let t60;
  if ($[166] !== columns || $[167] !== displayedLogs.length || $[168] !== effectiveTagIndex || $[169] !== focusedIndex || $[170] !== hasTags || $[171] !== showAllProjects || $[172] !== tagTabs || $[173] !== viewMode || $[174] !== visibleCount) {
    t60 = hasTags ? <TagTabs tabs={tagTabs} selectedIndex={effectiveTagIndex} availableWidth={columns} showAllProjects={showAllProjects} /> : <Box flexShrink={0}><Text bold={true} color="suggestion">Resume Session{viewMode === "list" && displayedLogs.length > visibleCount && <Text dimColor={true}>{" "}({focusedIndex} of {displayedLogs.length})</Text>}</Text></Box>;
    $[166] = columns;
    $[167] = displayedLogs.length;
    $[168] = effectiveTagIndex;
    $[169] = focusedIndex;
    $[170] = hasTags;
    $[171] = showAllProjects;
    $[172] = tagTabs;
    $[173] = viewMode;
    $[174] = visibleCount;
    $[175] = t60;
  } else {
    t60 = $[175];
  }
  const t61 = viewMode === "search";
  let t62;
  if ($[176] !== isTerminalFocused || $[177] !== searchCursorOffset || $[178] !== searchQuery || $[179] !== t61) {
    t62 = <SearchBox query={searchQuery} isFocused={t61} isTerminalFocused={isTerminalFocused} cursorOffset={searchCursorOffset} />;
    $[176] = isTerminalFocused;
    $[177] = searchCursorOffset;
    $[178] = searchQuery;
    $[179] = t61;
    $[180] = t62;
  } else {
    t62 = $[180];
  }
  let t63;
  if ($[181] !== filterIndicators || $[182] !== viewMode) {
    t63 = filterIndicators.length > 0 && viewMode !== "search" && <Box flexShrink={0} paddingLeft={2}><Text dimColor={true}><Byline>{filterIndicators}</Byline></Text></Box>;
    $[181] = filterIndicators;
    $[182] = viewMode;
    $[183] = t63;
  } else {
    t63 = $[183];
  }
  let t64;
  if ($[184] === Symbol.for("react.memo_cache_sentinel")) {
    t64 = <Box flexShrink={0}><Text> </Text></Box>;
    $[184] = t64;
  } else {
    t64 = $[184];
  }
  let t65;
  if ($[185] !== agenticSearchState.status) {
    t65 = agenticSearchState.status === "searching" && <Box paddingLeft={1} flexShrink={0}><Spinner /><Text> Searching…</Text></Box>;
    $[185] = agenticSearchState.status;
    $[186] = t65;
  } else {
    t65 = $[186];
  }
  let t66;
  if ($[187] !== agenticResults || $[188] !== agenticSearchState.status) {
    t66 = agenticSearchState.status === "results" && agenticResults.length > 0 && <Box paddingLeft={1} marginBottom={1} flexShrink={0}><Text dimColor={true} italic={true}>Claude found these results:</Text></Box>;
    $[187] = agenticResults;
    $[188] = agenticSearchState.status;
    $[189] = t66;
  } else {
    t66 = $[189];
  }
  let t67;
  if ($[190] !== agenticResults || $[191] !== agenticSearchState.status || $[192] !== filteredLogs) {
    t67 = agenticSearchState.status === "results" && agenticResults.length === 0 && filteredLogs.length === 0 && <Box paddingLeft={1} marginBottom={1} flexShrink={0}><Text dimColor={true} italic={true}>No matching sessions found.</Text></Box>;
    $[190] = agenticResults;
    $[191] = agenticSearchState.status;
    $[192] = filteredLogs;
    $[193] = t67;
  } else {
    t67 = $[193];
  }
  let t68;
  if ($[194] !== agenticSearchState.status || $[195] !== filteredLogs) {
    t68 = agenticSearchState.status === "error" && filteredLogs.length === 0 && <Box paddingLeft={1} marginBottom={1} flexShrink={0}><Text dimColor={true} italic={true}>No matching sessions found.</Text></Box>;
    $[194] = agenticSearchState.status;
    $[195] = filteredLogs;
    $[196] = t68;
  } else {
    t68 = $[196];
  }
  let t69;
  if ($[197] !== agenticSearchState.status || $[198] !== isAgenticSearchOptionFocused || $[199] !== onAgenticSearch || $[200] !== searchQuery) {
    t69 = Boolean(searchQuery.trim()) && onAgenticSearch && false && agenticSearchState.status !== "searching" && agenticSearchState.status !== "results" && agenticSearchState.status !== "error" && <Box flexShrink={0} flexDirection="column"><Box flexDirection="row" gap={1}><Text color={isAgenticSearchOptionFocused ? "suggestion" : undefined}>{isAgenticSearchOptionFocused ? figures.pointer : " "}</Text><Text color={isAgenticSearchOptionFocused ? "suggestion" : undefined} bold={isAgenticSearchOptionFocused}>Search deeply using Claude →</Text></Box><Box height={1} /></Box>;
    $[197] = agenticSearchState.status;
    $[198] = isAgenticSearchOptionFocused;
    $[199] = onAgenticSearch;
    $[200] = searchQuery;
    $[201] = t69;
  } else {
    t69 = $[201];
  }
  // isInputDisabled is read directly (not in the t70 dep list below):
  // the parent passes fresh onSelect/onLogsChanged identities every
  // render, so t70 already recomputes on the renders that flip the flag.
  let t70;
  if ($[202] !== agenticSearchState.status || $[203] !== branchFilterEnabled || $[204] !== columns || $[205] !== displayedLogs || $[206] !== expandedGroupSessionIds || $[207] !== flatOptions || $[208] !== focusedLog || $[209] !== focusedNode?.id || $[210] !== handleFlatOptionsSelectFocus || $[211] !== handleRenameSubmit || $[212] !== handleTreeSelectFocus || $[213] !== isAgenticSearchOptionFocused || $[214] !== onCancel || $[215] !== onSelect || $[216] !== renameCursorOffset || $[217] !== renameValue || $[218] !== treeNodes || $[219] !== viewMode || $[220] !== visibleCount) {
    t70 = agenticSearchState.status === "searching" ? null : viewMode === "rename" && focusedLog ? <Box paddingLeft={2} flexDirection="column"><Text bold={true}>Rename session:</Text><Box paddingTop={1}><TextInput value={renameValue} onChange={setRenameValue} onSubmit={handleRenameSubmit} placeholder={getResumeLogDisplayTitle(focusedLog) || "Enter new session name"} columns={columns} cursorOffset={renameCursorOffset} onChangeCursorOffset={setRenameCursorOffset} showCursor={true} /></Box></Box> : isResumeWithRenameEnabled ? <TreeSelect nodes={treeNodes} onSelect={node_0 => {
      onSelect(node_0.value.log);
    }} onFocus={handleTreeSelectFocus} onCancel={onCancel} focusNodeId={focusedNode?.id} visibleOptionCount={visibleCount} layout="expanded" isDisabled={viewMode === "search" || isAgenticSearchOptionFocused || isInputDisabled} hideIndexes={false} isNodeExpanded={nodeId => {
      if (viewMode === "search" || branchFilterEnabled) {
        return true;
      }
      const sessionId_2 = typeof nodeId === "string" && nodeId.startsWith("group:") ? nodeId.substring(6) : null;
      return sessionId_2 ? expandedGroupSessionIds.has(sessionId_2) : false;
    }} onExpand={nodeId_0 => {
      const sessionId_3 = typeof nodeId_0 === "string" && nodeId_0.startsWith("group:") ? nodeId_0.substring(6) : null;
      if (sessionId_3) {
        setExpandedGroupSessionIds(prev_0 => new Set(prev_0).add(sessionId_3));
        logEvent("tengu_session_group_expanded", {});
      }
    }} onCollapse={nodeId_1 => {
      const sessionId_4 = typeof nodeId_1 === "string" && nodeId_1.startsWith("group:") ? nodeId_1.substring(6) : null;
      if (sessionId_4) {
        setExpandedGroupSessionIds(prev_1 => {
          const newSet = new Set(prev_1);
          newSet.delete(sessionId_4);
          return newSet;
        });
      }
    }} onUpFromFirstItem={enterSearchMode} /> : <Select options={flatOptions} onChange={value_0 => {
      const itemIndex = parseInt(value_0, 10);
      const log_13 = displayedLogs[itemIndex];
      if (log_13) {
        onSelect(log_13);
      }
    }} visibleOptionCount={visibleCount} onCancel={onCancel} onFocus={handleFlatOptionsSelectFocus} defaultFocusValue={focusedNode?.id.toString()} layout="expanded" isDisabled={viewMode === "search" || isAgenticSearchOptionFocused || isInputDisabled} onUpFromFirstItem={enterSearchMode} />;
    $[202] = agenticSearchState.status;
    $[203] = branchFilterEnabled;
    $[204] = columns;
    $[205] = displayedLogs;
    $[206] = expandedGroupSessionIds;
    $[207] = flatOptions;
    $[208] = focusedLog;
    $[209] = focusedNode?.id;
    $[210] = handleFlatOptionsSelectFocus;
    $[211] = handleRenameSubmit;
    $[212] = handleTreeSelectFocus;
    $[213] = isAgenticSearchOptionFocused;
    $[214] = onCancel;
    $[215] = onSelect;
    $[216] = renameCursorOffset;
    $[217] = renameValue;
    $[218] = treeNodes;
    $[219] = viewMode;
    $[220] = visibleCount;
    $[221] = t70;
  } else {
    t70 = $[221];
  }
  let t71;
  if ($[222] !== agenticSearchState.status || $[223] !== currentBranch || $[224] !== exitState.keyName || $[225] !== exitState.pending || $[226] !== getExpandCollapseHint || $[227] !== hasMultipleWorktrees || $[228] !== isAgenticSearchOptionFocused || $[229] !== isSearching || $[230] !== onToggleAllProjects || $[231] !== showAllProjects || $[232] !== showAllWorktrees || $[233] !== viewMode) {
    t71 = <Box paddingLeft={2}>{exitState.pending ? <Text dimColor={true}>Press {exitState.keyName} again to exit</Text> : viewMode === "rename" ? <Text dimColor={true}><Byline><KeyboardShortcutHint shortcut="Enter" action="save" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text> : agenticSearchState.status === "searching" ? <Text dimColor={true}><Byline><Text>Searching with Claude…</Text><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text> : isAgenticSearchOptionFocused ? <Text dimColor={true}><Byline><KeyboardShortcutHint shortcut="Enter" action="search" /><KeyboardShortcutHint shortcut={"\u2193"} action="skip" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text> : viewMode === "search" ? <Text dimColor={true}><Byline><Text>{isSearching && false ? "Searching\u2026" : "Type to Search"}</Text><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="clear" /></Byline></Text> : <Text dimColor={true}><Byline>{onToggleAllProjects && <KeyboardShortcutHint shortcut="Ctrl+A" action={`show ${showAllProjects ? "current dir" : "all projects"}`} />}{currentBranch && <KeyboardShortcutHint shortcut="Ctrl+B" action="toggle branch" />}{hasMultipleWorktrees && <KeyboardShortcutHint shortcut="Ctrl+W" action={`show ${showAllWorktrees ? "current worktree" : "all worktrees"}`} />}<KeyboardShortcutHint shortcut="Ctrl+V" action="preview" /><KeyboardShortcutHint shortcut="Ctrl+R" action="rename" /><KeyboardShortcutHint shortcut="Del" action="delete" /><Text>Type to search</Text><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />{getExpandCollapseHint() && <Text>{getExpandCollapseHint()}</Text>}</Byline></Text>}</Box>;
    $[222] = agenticSearchState.status;
    $[223] = currentBranch;
    $[224] = exitState.keyName;
    $[225] = exitState.pending;
    $[226] = getExpandCollapseHint;
    $[227] = hasMultipleWorktrees;
    $[228] = isAgenticSearchOptionFocused;
    $[229] = isSearching;
    $[230] = onToggleAllProjects;
    $[231] = showAllProjects;
    $[232] = showAllWorktrees;
    $[233] = viewMode;
    $[234] = t71;
  } else {
    t71 = $[234];
  }
  let t72;
  if ($[235] !== t57 || $[236] !== t60 || $[237] !== t62 || $[238] !== t63 || $[239] !== t65 || $[240] !== t66 || $[241] !== t67 || $[242] !== t68 || $[243] !== t69 || $[244] !== t70 || $[245] !== t71) {
    t72 = <Box flexDirection="column" height={t57}>{t58}{t59}{t60}{t62}{t63}{t64}{t65}{t66}{t67}{t68}{t69}{t70}{t71}</Box>;
    $[235] = t57;
    $[236] = t60;
    $[237] = t62;
    $[238] = t63;
    $[239] = t65;
    $[240] = t66;
    $[241] = t67;
    $[242] = t68;
    $[243] = t69;
    $[244] = t70;
    $[245] = t71;
    $[246] = t72;
  } else {
    t72 = $[246];
  }
  return t72;
}

/**
 * Extracts searchable text content from a message.
 * Handles both string content and structured content blocks.
 */
function _temp7(r_0: DeepSearchResult): LogOption {
  return r_0.log;
}
function _temp6(log_6: LogOption): string | undefined {
  return log_6.messages[0]?.uuid;
}
function _temp5(fuseIndex_0, debouncedDeepSearchQuery_0, setDeepSearchResults_0, setIsSearching_0) {
  const results = fuseIndex_0.search(debouncedDeepSearchQuery_0);
  results.sort(_temp3);
  setDeepSearchResults_0({
    results: results.map(_temp4),
    query: debouncedDeepSearchQuery_0
  });
  setIsSearching_0(false);
}
function _temp4(r) {
  return {
    log: r.item.log,
    score: r.score,
    searchableText: r.item.searchableText
  };
}
function _temp3(a, b) {
  const aTime = new Date(a.item.log.modified).getTime();
  const bTime = new Date(b.item.log.modified).getTime();
  const timeDiff = bTime - aTime;
  if (Math.abs(timeDiff) > DATE_TIE_THRESHOLD_MS) {
    return timeDiff;
  }
  return (a.score ?? 1) - (b.score ?? 1);
}
function _temp2(log_1: LogOption): boolean {
  const currentSessionId = getSessionId();
  const logSessionId = getSessionIdFromLog(log_1);
  const isCurrentSession = currentSessionId && logSessionId === currentSessionId;
  if (isCurrentSession) {
    return true;
  }
  if (log_1.customTitle) {
    return true;
  }
  if (log_1.sessionBranch?.branchName?.trim()) {
    return true;
  }
  const fromMessages = getFirstMeaningfulUserMessageTextContent(log_1.messages);
  if (fromMessages) {
    return true;
  }
  if (log_1.firstPrompt || log_1.customTitle) {
    return true;
  }
  return false;
}
function _temp(log: LogOption): [LogOption, string] {
  return [log, buildSearchableText(log)];
}
function extractSearchableText(message: SerializedMessage): string {
  // Only extract from user and assistant messages that have content
  if (message.type !== 'user' && message.type !== 'assistant') {
    return '';
  }
  const content = 'message' in message ? message.message?.content : undefined;
  if (!content) return '';

  // Handle string content (simple messages)
  if (typeof content === 'string') {
    return content;
  }

  // Handle array of content blocks
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return block;
      if ('text' in block && typeof block.text === 'string') return block.text;
      return '';
      // we don't return thinking blocks and tool names here;
      // they're not useful for search, as they can add noise to the fuzzy matching
    }).filter(Boolean).join(' ');
  }
  return '';
}

/**
 * Builds searchable text for a log including messages, titles, summaries, and metadata.
 * Crops long transcripts to first/last N messages for performance.
 */
function buildSearchableText(log: LogOption): string {
  const searchableMessages = log.messages.length <= DEEP_SEARCH_MAX_MESSAGES ? log.messages : [...log.messages.slice(0, DEEP_SEARCH_CROP_SIZE), ...log.messages.slice(-DEEP_SEARCH_CROP_SIZE)];
  const messageText = searchableMessages.map(extractSearchableText).filter(Boolean).join(' ');
  const metadata = [getResumeLogDisplayTitle(log), log.customTitle, log.sessionBranch?.branchName, log.summary, log.firstPrompt, log.gitBranch, log.tag, log.prNumber ? `PR #${log.prNumber}` : undefined, log.prRepository].filter(Boolean).join(' ');
  const fullText = `${metadata} ${messageText}`.trim();
  return fullText.length > DEEP_SEARCH_MAX_TEXT_LENGTH ? fullText.slice(0, DEEP_SEARCH_MAX_TEXT_LENGTH) : fullText;
}
export function groupLogsByResumeBranch(filteredLogs: LogOption[]): ResumeLogGroup[] {
  type MutableGroup = {
    id: string;
    headerSessionId: string;
    logs: LogOption[];
    firstIndex: number;
  };

  const visibleSessionIds = new Set<string>();
  for (const log of filteredLogs) {
    const sessionId = getSessionIdFromLog(log);
    if (sessionId) visibleSessionIds.add(sessionId);
  }

  const groups = new Map<string, MutableGroup>();
  for (const [index, log] of filteredLogs.entries()) {
    const sessionId = getSessionIdFromLog(log);
    if (!sessionId) continue;

    const branch = log.sessionBranch;
    let headerSessionId = sessionId;
    if (branch?.rootSessionId && visibleSessionIds.has(branch.rootSessionId)) {
      headerSessionId = branch.rootSessionId;
    } else if (branch?.parentSessionId && visibleSessionIds.has(branch.parentSessionId)) {
      headerSessionId = branch.parentSessionId;
    }

    let group = groups.get(headerSessionId);
    if (!group) {
      group = {
        id: headerSessionId,
        headerSessionId,
        logs: [],
        firstIndex: index,
      };
      groups.set(headerSessionId, group);
    } else {
      group.firstIndex = Math.min(group.firstIndex, index);
    }
    group.logs.push(log);
  }

  return Array.from(groups.values()).map(group => {
    const headerLog =
      group.logs.find(log => getSessionIdFromLog(log) === group.headerSessionId) ??
      group.logs[0]!;
    const childLogs = group.logs.filter(log => log !== headerLog);
    return {
      id: group.id,
      headerLog,
      childLogs,
      logs: [headerLog, ...childLogs],
      firstIndex: group.firstIndex,
    };
  }).sort((a, b) => a.firstIndex - b.firstIndex);
}

/**
 * Get unique tags from a list of logs, sorted alphabetically
 */
function getUniqueTags(logs: LogOption[]): string[] {
  const tags = new Set<string>();
  for (const log of logs) {
    if (log.tag) {
      tags.add(log.tag);
    }
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}
