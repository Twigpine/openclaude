import { c as _c } from "react-compiler-runtime";
import { resolve as resolvePath } from 'path';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRegisterOverlay } from '../context/overlayContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Text } from '../ink.js';
import { logEvent } from '../services/analytics/index.js';
import { getCwd } from '../utils/cwd.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js';
import { highlightMatch } from '../utils/highlightMatch.js';
import { relativePath } from '../utils/permissions/filesystem.js';
import { readFileInRange } from '../utils/readFileInRange.js';
import { ripGrepStream } from '../utils/ripgrep.js';
import { FuzzyPicker } from './design-system/FuzzyPicker.js';
import { LoadingState } from './design-system/LoadingState.js';
type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};
type Match = {
  file: string;
  line: number;
  text: string;
};
type Preview = {
  file: string;
  line: number;
  content: string;
};
const VISIBLE_RESULTS = 12;
const DEBOUNCE_MS = 100;
const PREVIEW_CONTEXT_LINES = 4;
// rg -m is per-file; we also cap the parsed array to keep memory bounded.
const MAX_MATCHES_PER_FILE = 10;
const MAX_TOTAL_MATCHES = 500;

/**
 * Global Search dialog (ctrl+shift+f / cmd+shift+f).
 * Debounced ripgrep search across the workspace.
 */
export function GlobalSearchDialog(t0: Props) {
  const $ = _c(40);
  const {
    onDone,
    onInsert
  } = t0;
  useRegisterOverlay("global-search", true);
  const {
    columns,
    rows
  } = useTerminalSize();
  const previewOnRight = columns >= 140;
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14));
  let t1: Match[];
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [matches, setMatches] = useState<Match[]>(t1);
  const [truncated, setTruncated] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState<Match | undefined>(undefined);
  const [preview, setPreview] = useState<Preview | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  let t2;
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      abortRef.current?.abort();
    };
    t3 = [];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  useEffect(t2, t3);
  let t4;
  let t5;
  if ($[3] !== focused) {
    t4 = () => {
      if (!focused) {
        setPreview(null);
        return;
      }
      const controller = new AbortController();
      const absolute = resolvePath(getCwd(), focused.file);
      const start = Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1);
      readFileInRange(absolute, start, PREVIEW_CONTEXT_LINES * 2 + 1, undefined, controller.signal).then(r => {
        if (controller.signal.aborted) {
          return;
        }
        setPreview({
          file: focused.file,
          line: focused.line,
          content: r.content
        });
      }).catch(() => {
        if (controller.signal.aborted) {
          return;
        }
        setPreview({
          file: focused.file,
          line: focused.line,
          content: "(preview unavailable)"
        });
      });
      return () => controller.abort();
    };
    t5 = [focused];
    $[3] = focused;
    $[4] = t4;
    $[5] = t5;
  } else {
    t4 = $[4];
    t5 = $[5];
  }
  useEffect(t4, t5);
  let t6;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = (q: string) => {
      setQuery(q);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      abortRef.current?.abort();
      if (!q.trim()) {
        setMatches(_temp);
        setIsSearching(false);
        setTruncated(false);
        return;
      }
      const controller_0 = new AbortController();
      abortRef.current = controller_0;
      setIsSearching(true);
      setTruncated(false);
      const queryLower = q.toLowerCase();
      setMatches(m_0 => {
        const filtered = m_0.filter(match => match.text.toLowerCase().includes(queryLower));
        return filtered.length === m_0.length ? m_0 : filtered;
      });
      timeoutRef.current = setTimeout(_temp4, DEBOUNCE_MS, q, controller_0, setMatches, setTruncated, setIsSearching);
    };
    $[6] = t6;
  } else {
    t6 = $[6];
  }
  const handleQueryChange = t6;
  const listWidth = previewOnRight ? Math.floor((columns - 10) * 0.5) : columns - 8;
  const maxPathWidth = Math.max(20, Math.floor(listWidth * 0.4));
  const maxTextWidth = Math.max(20, listWidth - maxPathWidth - 4);
  const previewWidth = previewOnRight ? Math.max(40, columns - listWidth - 14) : columns - 6;
  let t7;
  if ($[7] !== matches.length || $[8] !== onDone) {
    t7 = (m_3: Match) => {
      const opened = openFileInExternalEditor(resolvePath(getCwd(), m_3.file), m_3.line);
      logEvent("tengu_global_search_select", {
        result_count: matches.length,
        opened_editor: opened
      });
      onDone();
    };
    $[7] = matches.length;
    $[8] = onDone;
    $[9] = t7;
  } else {
    t7 = $[9];
  }
  const handleOpen = t7;
  let t8;
  if ($[10] !== matches.length || $[11] !== onDone || $[12] !== onInsert) {
    t8 = (m_4: Match, mention: boolean) => {
      onInsert(mention ? `@${m_4.file}#L${m_4.line} ` : `${m_4.file}:${m_4.line} `);
      logEvent("tengu_global_search_insert", {
        result_count: matches.length,
        mention
      });
      onDone();
    };
    $[10] = matches.length;
    $[11] = onDone;
    $[12] = onInsert;
    $[13] = t8;
  } else {
    t8 = $[13];
  }
  const handleInsert = t8;
  const matchLabel = matches.length > 0 ? `${matches.length}${truncated ? "+" : ""} matches${isSearching ? "\u2026" : ""}` : " ";
  const t9 = previewOnRight ? "right" : "bottom";
  let t10;
  if ($[14] !== handleInsert) {
    t10 = {
      action: "mention",
      handler: (m_5: Match) => handleInsert(m_5, true)
    };
    $[14] = handleInsert;
    $[15] = t10;
  } else {
    t10 = $[15];
  }
  let t11;
  if ($[16] !== handleInsert) {
    t11 = {
      action: "insert path",
      handler: (m_6: Match) => handleInsert(m_6, false)
    };
    $[16] = handleInsert;
    $[17] = t11;
  } else {
    t11 = $[17];
  }
  let t12;
  if ($[18] !== isSearching) {
    t12 = (q_0: string) => isSearching ? "Searching\u2026" : q_0 ? "No matches" : "Type to search\u2026";
    $[18] = isSearching;
    $[19] = t12;
  } else {
    t12 = $[19];
  }
  let t13;
  if ($[20] !== maxPathWidth || $[21] !== maxTextWidth || $[22] !== query) {
    t13 = (m_7: Match, isFocused: boolean) => <Text color={isFocused ? "suggestion" : undefined}><Text dimColor={true}>{truncatePathMiddle(m_7.file, maxPathWidth)}:{m_7.line}</Text>{" "}{highlightMatch(truncateToWidth(m_7.text.trimStart(), maxTextWidth), query)}</Text>;
    $[20] = maxPathWidth;
    $[21] = maxTextWidth;
    $[22] = query;
    $[23] = t13;
  } else {
    t13 = $[23];
  }
  let t14;
  if ($[24] !== preview || $[25] !== previewWidth || $[26] !== query) {
    t14 = (m_8: Match) => preview !== null && preview.file === m_8.file && preview.line === m_8.line ? <><Text dimColor={true}>{truncatePathMiddle(m_8.file, previewWidth)}:{m_8.line}</Text>{preview.content.split("\n").map((line_0, i) => <Text key={i}>{highlightMatch(truncateToWidth(line_0, previewWidth), query)}</Text>)}</> : <LoadingState message={"Loading\u2026"} dimColor={true} />;
    $[24] = preview;
    $[25] = previewWidth;
    $[26] = query;
    $[27] = t14;
  } else {
    t14 = $[27];
  }
  let t15;
  if ($[28] !== handleOpen || $[29] !== matchLabel || $[30] !== matches || $[31] !== onDone || $[32] !== t10 || $[33] !== t11 || $[34] !== t12 || $[35] !== t13 || $[36] !== t14 || $[37] !== t9 || $[38] !== visibleResults) {
    t15 = <FuzzyPicker title="Global Search" placeholder={"Type to search\u2026"} items={matches} getKey={matchKey} visibleCount={visibleResults} direction="up" previewPosition={t9} onQueryChange={handleQueryChange} onFocus={setFocused} onSelect={handleOpen} onTab={t10} onShiftTab={t11} onCancel={onDone} emptyMessage={t12} matchLabel={matchLabel} selectAction="open in editor" renderItem={t13} renderPreview={t14} />;
    $[28] = handleOpen;
    $[29] = matchLabel;
    $[30] = matches;
    $[31] = onDone;
    $[32] = t10;
    $[33] = t11;
    $[34] = t12;
    $[35] = t13;
    $[36] = t14;
    $[37] = t9;
    $[38] = visibleResults;
    $[39] = t15;
  } else {
    t15 = $[39];
  }
  return t15;
}
function _temp4(
  query_0: string,
  controller_1: AbortController,
  setMatches_0: React.Dispatch<React.SetStateAction<Match[]>>,
  setTruncated_0: React.Dispatch<React.SetStateAction<boolean>>,
  setIsSearching_0: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const cwd = getCwd();
  let collected = 0;
  ripGrepStream(["-n", "--no-heading", "-i", "-m", String(MAX_MATCHES_PER_FILE), "-F", "-e", query_0], cwd, controller_1.signal, lines => {
    if (controller_1.signal.aborted) {
      return;
    }
    const parsed: Match[] = [];
    for (const line of lines) {
      const m_1 = parseRipgrepLine(line);
      if (!m_1) {
        continue;
      }
      const rel = relativePath(cwd, m_1.file);
      parsed.push({
        ...m_1,
        file: rel.startsWith("..") ? m_1.file : rel
      });
    }
    if (!parsed.length) {
      return;
    }
    collected = collected + parsed.length;
    setMatches_0(prev => {
      const seen = new Set(prev.map(matchKey));
      const fresh = parsed.filter(p => !seen.has(matchKey(p)));
      if (!fresh.length) {
        return prev;
      }
      const next = prev.concat(fresh);
      return next.length > MAX_TOTAL_MATCHES ? next.slice(0, MAX_TOTAL_MATCHES) : next;
    });
    if (collected >= MAX_TOTAL_MATCHES) {
      controller_1.abort();
      setTruncated_0(true);
      setIsSearching_0(false);
    }
  }).catch(_temp2).finally(() => {
    if (controller_1.signal.aborted) {
      return;
    }
    if (collected === 0) {
      setMatches_0(_temp3);
    }
    setIsSearching_0(false);
  });
}
function _temp3(m_2: Match[]): Match[] {
  return m_2.length ? [] : m_2;
}
function _temp2(): void {}
function _temp(m: Match[]): Match[] {
  return m.length ? [] : m;
}
function matchKey(m: Match): string {
  return `${m.file}:${m.line}`;
}

/**
 * Parse a ripgrep -n --no-heading output line: "path:line:text".
 * Windows paths may contain a drive letter ("C:\..."), so a simple split on
 * the first colon would mangle the path — use a regex that captures up to
 * the first :<digits>: instead.
 * @internal exported for testing
 */
export function parseRipgrepLine(line: string): Match | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  const [, file, lineStr, text] = m;
  const lineNum = Number(lineStr);
  if (!file || !Number.isFinite(lineNum)) return null;
  return {
    file,
    line: lineNum,
    text: text ?? ''
  };
}
