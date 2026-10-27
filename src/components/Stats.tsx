import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import { plot as asciichart } from 'asciichart';
import chalk from 'chalk';
import figures from 'figures';
import React, { Suspense, use, useEffect, useMemo, useState } from 'react';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import type { CommandResultDisplay } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { applyColor } from '../ink/colorize.js';
import { stringWidth as getStringWidth } from '../ink/stringWidth.js';
import type { Color } from '../ink/styles.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow stats navigation
import { Ansi, Box, type Key, Text, useInput } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getGlobalConfig } from '../utils/config.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import { generateHeatmap } from '../utils/heatmap.js';
import { renderModelName } from '../utils/model/model.js';
import { copyAnsiToClipboard } from '../utils/screenshotClipboard.js';
import { aggregateClaudeCodeStatsForRange, type ClaudeCodeStats, type DailyModelTokens, type StatsDateRange } from '../utils/stats.js';
import { resolveThemeSetting } from '../utils/systemTheme.js';
import { getTheme, themeColorToAnsi } from '../utils/theme.js';
import { Pane } from './design-system/Pane.js';
import { Tab, Tabs, useTabHeaderFocus } from './design-system/Tabs.js';
import { Spinner } from './Spinner.js';
function formatPeakDay(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}
type Props = {
  onClose: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type StatsResult = {
  type: 'success';
  data: ClaudeCodeStats;
} | {
  type: 'error';
  message: string;
} | {
  type: 'empty';
};
type StatsTab = 'Overview' | 'Models';
type StatsCache = Partial<Record<StatsDateRange, ClaudeCodeStats>>;
type ModelUsageStats = ClaudeCodeStats['modelUsage'][string];
type ModelUsageEntry = [string, ModelUsageStats];
const DATE_RANGE_LABELS: Record<StatsDateRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time'
};
const DATE_RANGE_ORDER: StatsDateRange[] = ['all', '7d', '30d'];
function getNextDateRange(current: StatsDateRange): StatsDateRange {
  const currentIndex = DATE_RANGE_ORDER.indexOf(current);
  return DATE_RANGE_ORDER[(currentIndex + 1) % DATE_RANGE_ORDER.length]!;
}

/**
 * Creates a stats loading promise that never rejects.
 * Always loads all-time stats for the heatmap.
 */
function createAllTimeStatsPromise(): Promise<StatsResult> {
  return aggregateClaudeCodeStatsForRange('all').then((data): StatsResult => {
    if (!data || data.totalSessions === 0) {
      return {
        type: 'empty'
      };
    }
    return {
      type: 'success',
      data
    };
  }).catch((err): StatsResult => {
    const message = err instanceof Error ? err.message : 'Failed to load stats';
    return {
      type: 'error',
      message
    };
  });
}
export function Stats(t0: Props): React.ReactNode {
  const $ = _c(4);
  const {
    onClose
  } = t0;
  let t1: Promise<StatsResult>;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = createAllTimeStatsPromise();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const allTimePromise: Promise<StatsResult> = t1;
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Box marginTop={1}><Spinner /><Text> Loading your OpenClaude stats…</Text></Box>;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  let t3;
  if ($[2] !== onClose) {
    t3 = <Suspense fallback={t2}><StatsContent allTimePromise={allTimePromise} onClose={onClose} /></Suspense>;
    $[2] = onClose;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  return t3;
}
type StatsContentProps = {
  allTimePromise: Promise<StatsResult>;
  onClose: Props['onClose'];
};

/**
 * Inner component that uses React 19's use() to read the stats promise.
 * Suspends while loading all-time stats, then handles date range changes without suspending.
 */
function StatsContent(t0: StatsContentProps): React.ReactNode {
  const $ = _c(34);
  const {
    allTimePromise,
    onClose
  } = t0;
  const allTimeResult: StatsResult = use(allTimePromise);
  const [dateRange, setDateRange] = useState<StatsDateRange>("all");
  let t1: StatsCache;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {};
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [statsCache, setStatsCache] = useState<StatsCache>(t1);
  const [isLoadingFiltered, setIsLoadingFiltered] = useState(false);
  const [activeTab, setActiveTab] = useState<StatsTab>("Overview");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  let t2: React.EffectCallback;
  let t3: [StatsDateRange, StatsCache];
  if ($[1] !== dateRange || $[2] !== statsCache) {
    t2 = () => {
      if (dateRange === "all") {
        return;
      }
      if (statsCache[dateRange]) {
        return;
      }
      let cancelled = false;
      setIsLoadingFiltered(true);
      aggregateClaudeCodeStatsForRange(dateRange).then(data => {
        if (!cancelled) {
          setStatsCache(prev => ({
            ...prev,
            [dateRange]: data
          }));
          setIsLoadingFiltered(false);
        }
      }).catch(() => {
        if (!cancelled) {
          setIsLoadingFiltered(false);
        }
      });
      return () => {
        cancelled = true;
      };
    };
    t3 = [dateRange, statsCache];
    $[1] = dateRange;
    $[2] = statsCache;
    $[3] = t2;
    $[4] = t3;
  } else {
    t2 = $[3];
    t3 = $[4];
  }
  useEffect(t2, t3);
  const displayStats: ClaudeCodeStats | null = dateRange === "all" ? allTimeResult.type === "success" ? allTimeResult.data : null : statsCache[dateRange] ?? (allTimeResult.type === "success" ? allTimeResult.data : null);
  const allTimeStats: ClaudeCodeStats | null = allTimeResult.type === "success" ? allTimeResult.data : null;
  let t4;
  if ($[5] !== onClose) {
    t4 = () => {
      onClose("Stats dialog dismissed", {
        display: "system"
      });
    };
    $[5] = onClose;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  const handleClose = t4;
  let t5;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      context: "Confirmation"
    };
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  useKeybinding("confirm:no", handleClose, t5);
  let t6: (input: string, key: Key) => void;
  if ($[8] !== activeTab || $[9] !== dateRange || $[10] !== displayStats || $[11] !== onClose) {
    t6 = (input: string, key: Key) => {
      if (key.ctrl && (input === "c" || input === "d")) {
        onClose("Stats dialog dismissed", {
          display: "system"
        });
      }
      if (key.tab) {
        setActiveTab(_temp);
      }
      if (input === "r" && !key.ctrl && !key.meta) {
        setDateRange(getNextDateRange(dateRange));
      }
      if (key.ctrl && input === "s" && displayStats) {
        handleScreenshot(displayStats, activeTab, setCopyStatus);
      }
    };
    $[8] = activeTab;
    $[9] = dateRange;
    $[10] = displayStats;
    $[11] = onClose;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  useInput(t6);
  if (allTimeResult.type === "error") {
    let t7;
    if ($[13] !== allTimeResult.message) {
      t7 = <Box marginTop={1}><Text color="error">Failed to load stats: {allTimeResult.message}</Text></Box>;
      $[13] = allTimeResult.message;
      $[14] = t7;
    } else {
      t7 = $[14];
    }
    return t7;
  }
  if (allTimeResult.type === "empty") {
    let t7;
    if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
      t7 = <Box marginTop={1}><Text color="warning">No stats available yet. Start using OpenClaude!</Text></Box>;
      $[15] = t7;
    } else {
      t7 = $[15];
    }
    return t7;
  }
  if (!displayStats || !allTimeStats) {
    let t7;
    if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
      t7 = <Box marginTop={1}><Spinner /><Text> Loading stats…</Text></Box>;
      $[16] = t7;
    } else {
      t7 = $[16];
    }
    return t7;
  }
  let t7;
  if ($[17] !== allTimeStats || $[18] !== dateRange || $[19] !== displayStats || $[20] !== isLoadingFiltered) {
    t7 = <Tab title="Overview"><OverviewTab stats={displayStats} allTimeStats={allTimeStats} dateRange={dateRange} isLoading={isLoadingFiltered} /></Tab>;
    $[17] = allTimeStats;
    $[18] = dateRange;
    $[19] = displayStats;
    $[20] = isLoadingFiltered;
    $[21] = t7;
  } else {
    t7 = $[21];
  }
  let t8;
  if ($[22] !== dateRange || $[23] !== displayStats || $[24] !== isLoadingFiltered) {
    t8 = <Tab title="Models"><ModelsTab stats={displayStats} dateRange={dateRange} isLoading={isLoadingFiltered} /></Tab>;
    $[22] = dateRange;
    $[23] = displayStats;
    $[24] = isLoadingFiltered;
    $[25] = t8;
  } else {
    t8 = $[25];
  }
  let t9;
  if ($[26] !== t7 || $[27] !== t8) {
    t9 = <Box flexDirection="row" gap={1} marginBottom={1}><Tabs title="" color="claude" defaultTab="Overview">{t7}{t8}</Tabs></Box>;
    $[26] = t7;
    $[27] = t8;
    $[28] = t9;
  } else {
    t9 = $[28];
  }
  const t10 = copyStatus ? ` · ${copyStatus}` : "";
  let t11;
  if ($[29] !== t10) {
    t11 = <Box paddingLeft={2}><Text dimColor={true}>Esc to cancel · r to cycle dates · ctrl+s to copy{t10}</Text></Box>;
    $[29] = t10;
    $[30] = t11;
  } else {
    t11 = $[30];
  }
  let t12;
  if ($[31] !== t11 || $[32] !== t9) {
    t12 = <Pane color="claude">{t9}{t11}</Pane>;
    $[31] = t11;
    $[32] = t9;
    $[33] = t12;
  } else {
    t12 = $[33];
  }
  return t12;
}
function _temp(prev_0: StatsTab): StatsTab {
  return prev_0 === "Overview" ? "Models" : "Overview";
}
type DateRangeSelectorProps = {
  dateRange: StatsDateRange;
  isLoading: boolean;
};
function DateRangeSelector(t0: DateRangeSelectorProps): React.ReactNode {
  const $ = _c(9);
  const {
    dateRange,
    isLoading
  } = t0;
  let t1;
  if ($[0] !== dateRange) {
    t1 = DATE_RANGE_ORDER.map((range, i) => <Text key={range}>{i > 0 && <Text dimColor={true}> · </Text>}{range === dateRange ? <Text bold={true} color="claude">{DATE_RANGE_LABELS[range]}</Text> : <Text dimColor={true}>{DATE_RANGE_LABELS[range]}</Text>}</Text>);
    $[0] = dateRange;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1) {
    t2 = <Box>{t1}</Box>;
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== isLoading) {
    t3 = isLoading && <Spinner />;
    $[4] = isLoading;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] !== t2 || $[7] !== t3) {
    t4 = <Box marginBottom={1} gap={1}>{t2}{t3}</Box>;
    $[6] = t2;
    $[7] = t3;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  return t4;
}
function OverviewTab({
  stats,
  allTimeStats,
  dateRange,
  isLoading
}: {
  stats: ClaudeCodeStats;
  allTimeStats: ClaudeCodeStats;
  dateRange: StatsDateRange;
  isLoading: boolean;
}): React.ReactNode {
  const {
    columns: terminalWidth
  } = useTerminalSize();

  // Calculate favorite model and total tokens
  const modelEntries = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  const favoriteModel = modelEntries[0];
  const totalTokens = modelEntries.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens, 0);

  // Memoize the factoid so it doesn't change when switching tabs
  const factoid = useMemo(() => generateFunFactoid(stats, totalTokens), [stats, totalTokens]);

  // Calculate range days based on selected date range
  const rangeDays = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : stats.totalDays;

  // Compute shot stats data (internal-only, gated by feature flag)
  let shotStatsData: {
    avgShots: string;
    buckets: {
      label: string;
      count: number;
      pct: number;
    }[];
  } | null = null;
  if (feature('SHOT_STATS') && stats.shotDistribution) {
    const dist = stats.shotDistribution;
    const total = Object.values(dist).reduce((s, n) => s + n, 0);
    if (total > 0) {
      const totalShots = Object.entries(dist).reduce((s_0, [count, sessions]) => s_0 + parseInt(count, 10) * sessions, 0);
      const bucket = (min: number, max?: number) => Object.entries(dist).filter(([k]) => {
        const n_0 = parseInt(k, 10);
        return n_0 >= min && (max === undefined || n_0 <= max);
      }).reduce((s_1, [, v]) => s_1 + v, 0);
      const pct = (n_1: number) => Math.round(n_1 / total * 100);
      const b1 = bucket(1, 1);
      const b2_5 = bucket(2, 5);
      const b6_10 = bucket(6, 10);
      const b11 = bucket(11);
      shotStatsData = {
        avgShots: (totalShots / total).toFixed(1),
        buckets: [{
          label: '1-shot',
          count: b1,
          pct: pct(b1)
        }, {
          label: '2\u20135 shot',
          count: b2_5,
          pct: pct(b2_5)
        }, {
          label: '6\u201310 shot',
          count: b6_10,
          pct: pct(b6_10)
        }, {
          label: '11+ shot',
          count: b11,
          pct: pct(b11)
        }]
      };
    }
  }
  return <Box flexDirection="column" marginTop={1}>
      {/* Activity Heatmap - always shows all-time data */}
      {allTimeStats.dailyActivity.length > 0 && <Box flexDirection="column" marginBottom={1}>
          <Ansi>
            {generateHeatmap(allTimeStats.dailyActivity, {
          terminalWidth
        })}
          </Ansi>
        </Box>}

      {/* Date range selector */}
      <DateRangeSelector dateRange={dateRange} isLoading={isLoading} />

      {/* Section 1: Usage */}
      <Box flexDirection="row" gap={4} marginBottom={1}>
        <Box flexDirection="column" width={28}>
          {favoriteModel && <Text wrap="truncate">
              Favorite model:{' '}
              <Text color="claude" bold>
                {renderModelName(favoriteModel[0])}
              </Text>
            </Text>}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            Total tokens:{' '}
            <Text color="claude">{formatNumber(totalTokens)}</Text>
          </Text>
        </Box>
      </Box>

      {/* Section 2: Activity - Row 1: Sessions | Longest session */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            Sessions:{' '}
            <Text color="claude">{formatNumber(stats.totalSessions)}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          {stats.longestSession && <Text wrap="truncate">
              Longest session:{' '}
              <Text color="claude">
                {formatDuration(stats.longestSession.duration)}
              </Text>
            </Text>}
        </Box>
      </Box>

      {/* Row 2: Active days | Longest streak */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            Active days: <Text color="claude">{stats.activeDays}</Text>
            <Text color="subtle">/{rangeDays}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            Longest streak:{' '}
            <Text color="claude" bold>
              {stats.streaks.longestStreak}
            </Text>{' '}
            {stats.streaks.longestStreak === 1 ? 'day' : 'days'}
          </Text>
        </Box>
      </Box>

      {/* Row 3: Most active day | Current streak */}
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          {stats.peakActivityDay && <Text wrap="truncate">
              Most active day:{' '}
              <Text color="claude">{formatPeakDay(stats.peakActivityDay)}</Text>
            </Text>}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            Current streak:{' '}
            <Text color="claude" bold>
              {allTimeStats.streaks.currentStreak}
            </Text>{' '}
            {allTimeStats.streaks.currentStreak === 1 ? 'day' : 'days'}
          </Text>
        </Box>
      </Box>
      {/* Shot stats (internal-only) */}
      {shotStatsData && <>
          <Box marginTop={1}>
            <Text>Shot distribution</Text>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[0]!.label}:{' '}
                <Text color="claude">{shotStatsData.buckets[0]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[0]!.pct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[1]!.label}:{' '}
                <Text color="claude">{shotStatsData.buckets[1]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[1]!.pct}%)</Text>
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[2]!.label}:{' '}
                <Text color="claude">{shotStatsData.buckets[2]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[2]!.pct}%)</Text>
              </Text>
            </Box>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                {shotStatsData.buckets[3]!.label}:{' '}
                <Text color="claude">{shotStatsData.buckets[3]!.count}</Text>
                <Text color="subtle"> ({shotStatsData.buckets[3]!.pct}%)</Text>
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={4}>
            <Box flexDirection="column" width={28}>
              <Text wrap="truncate">
                Avg/session:{' '}
                <Text color="claude">{shotStatsData.avgShots}</Text>
              </Text>
            </Box>
          </Box>
        </>}

      {/* Fun factoid */}
      {factoid && <Box marginTop={1}>
          <Text color="suggestion">{factoid}</Text>
        </Box>}
    </Box>;
}

// Famous books and their approximate token counts (words * ~1.3)
// Sorted by tokens ascending for comparison logic
const BOOK_COMPARISONS = [{
  name: 'The Little Prince',
  tokens: 22000
}, {
  name: 'The Old Man and the Sea',
  tokens: 35000
}, {
  name: 'A Christmas Carol',
  tokens: 37000
}, {
  name: 'Animal Farm',
  tokens: 39000
}, {
  name: 'Fahrenheit 451',
  tokens: 60000
}, {
  name: 'The Great Gatsby',
  tokens: 62000
}, {
  name: 'Slaughterhouse-Five',
  tokens: 64000
}, {
  name: 'Brave New World',
  tokens: 83000
}, {
  name: 'The Catcher in the Rye',
  tokens: 95000
}, {
  name: "Harry Potter and the Philosopher's Stone",
  tokens: 103000
}, {
  name: 'The Hobbit',
  tokens: 123000
}, {
  name: '1984',
  tokens: 123000
}, {
  name: 'To Kill a Mockingbird',
  tokens: 130000
}, {
  name: 'Pride and Prejudice',
  tokens: 156000
}, {
  name: 'Dune',
  tokens: 244000
}, {
  name: 'Moby-Dick',
  tokens: 268000
}, {
  name: 'Crime and Punishment',
  tokens: 274000
}, {
  name: 'A Game of Thrones',
  tokens: 381000
}, {
  name: 'Anna Karenina',
  tokens: 468000
}, {
  name: 'Don Quixote',
  tokens: 520000
}, {
  name: 'The Lord of the Rings',
  tokens: 576000
}, {
  name: 'The Count of Monte Cristo',
  tokens: 603000
}, {
  name: 'Les Misérables',
  tokens: 689000
}, {
  name: 'War and Peace',
  tokens: 730000
}];

// Time equivalents for session durations
const TIME_COMPARISONS = [{
  name: 'a TED talk',
  minutes: 18
}, {
  name: 'an episode of The Office',
  minutes: 22
}, {
  name: 'listening to Abbey Road',
  minutes: 47
}, {
  name: 'a yoga class',
  minutes: 60
}, {
  name: 'a World Cup soccer match',
  minutes: 90
}, {
  name: 'a half marathon (average time)',
  minutes: 120
}, {
  name: 'the movie Inception',
  minutes: 148
}, {
  name: 'watching Titanic',
  minutes: 195
}, {
  name: 'a transatlantic flight',
  minutes: 420
}, {
  name: 'a full night of sleep',
  minutes: 480
}];
function generateFunFactoid(stats: ClaudeCodeStats, totalTokens: number): string {
  const factoids: string[] = [];
  if (totalTokens > 0) {
    const matchingBooks = BOOK_COMPARISONS.filter(book => totalTokens >= book.tokens);
    for (const book of matchingBooks) {
      const times = totalTokens / book.tokens;
      if (times >= 2) {
        factoids.push(`You've used ~${Math.floor(times)}x more tokens than ${book.name}`);
      } else {
        factoids.push(`You've used the same number of tokens as ${book.name}`);
      }
    }
  }
  if (stats.longestSession) {
    const sessionMinutes = stats.longestSession.duration / (1000 * 60);
    for (const comparison of TIME_COMPARISONS) {
      const ratio = sessionMinutes / comparison.minutes;
      if (ratio >= 2) {
        factoids.push(`Your longest session is ~${Math.floor(ratio)}x longer than ${comparison.name}`);
      }
    }
  }
  if (factoids.length === 0) {
    return '';
  }
  const randomIndex = Math.floor(Math.random() * factoids.length);
  return factoids[randomIndex]!;
}
type ModelsTabProps = {
  stats: ClaudeCodeStats;
  dateRange: StatsDateRange;
  isLoading: boolean;
};
function ModelsTab(t0: ModelsTabProps): React.ReactNode {
  const $ = _c(15);
  const {
    stats,
    dateRange,
    isLoading
  } = t0;
  const {
    headerFocused,
    focusHeader
  } = useTabHeaderFocus();
  const [scrollOffset, setScrollOffset] = useState(0);
  const {
    columns: terminalWidth
  } = useTerminalSize();
  const modelEntries: ModelUsageEntry[] = Object.entries(stats.modelUsage).sort(_temp7);
  const t1 = !headerFocused;
  let t2;
  if ($[0] !== t1) {
    t2 = {
      isActive: t1
    };
    $[0] = t1;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  useInput((_input, key) => {
    if (key.downArrow && scrollOffset < modelEntries.length - 4) {
      setScrollOffset(prev => Math.min(prev + 2, modelEntries.length - 4));
    }
    if (key.upArrow) {
      if (scrollOffset > 0) {
        setScrollOffset(_temp8);
      } else {
        focusHeader();
      }
    }
  }, t2);
  if (modelEntries.length === 0) {
    let t3;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Box><Text color="subtle">No model usage data available</Text></Box>;
      $[2] = t3;
    } else {
      t3 = $[2];
    }
    return t3;
  }
  const totalTokens = modelEntries.reduce(_temp9, 0);
  const chartOutput = generateTokenChart(stats.dailyModelTokens, modelEntries.map(_temp0), terminalWidth);
  const visibleModels = modelEntries.slice(scrollOffset, scrollOffset + 4);
  const midpoint = Math.ceil(visibleModels.length / 2);
  const leftModels = visibleModels.slice(0, midpoint);
  const rightModels = visibleModels.slice(midpoint);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < modelEntries.length - 4;
  const showScrollHint = modelEntries.length > 4;
  let t3;
  if ($[3] !== dateRange || $[4] !== isLoading) {
    t3 = <DateRangeSelector dateRange={dateRange} isLoading={isLoading} />;
    $[3] = dateRange;
    $[4] = isLoading;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const T0 = Box;
  const t5 = "column";
  const t6 = 36;
  const t8 = rightModels.map(t7 => {
    const [model_1, usage_1] = t7;
    return <ModelEntry key={model_1} model={model_1} usage={usage_1} totalTokens={totalTokens} />;
  });
  let t9;
  if ($[6] !== T0 || $[7] !== t8) {
    t9 = <T0 flexDirection={t5} width={t6}>{t8}</T0>;
    $[6] = T0;
    $[7] = t8;
    $[8] = t9;
  } else {
    t9 = $[8];
  }
  let t10;
  if ($[9] !== canScrollDown || $[10] !== canScrollUp || $[11] !== modelEntries || $[12] !== scrollOffset || $[13] !== showScrollHint) {
    t10 = showScrollHint && <Box marginTop={1}><Text color="subtle">{canScrollUp ? figures.arrowUp : " "}{" "}{canScrollDown ? figures.arrowDown : " "} {scrollOffset + 1}-{Math.min(scrollOffset + 4, modelEntries.length)} of{" "}{modelEntries.length} models (↑↓ to scroll)</Text></Box>;
    $[9] = canScrollDown;
    $[10] = canScrollUp;
    $[11] = modelEntries;
    $[12] = scrollOffset;
    $[13] = showScrollHint;
    $[14] = t10;
  } else {
    t10 = $[14];
  }
  return <Box flexDirection="column" marginTop={1}>{chartOutput && <Box flexDirection="column" marginBottom={1}><Text bold={true}>Tokens per Day</Text><Ansi>{chartOutput.chart}</Ansi><Text color="subtle">{chartOutput.xAxisLabels}</Text><Box>{chartOutput.legend.map(_temp1)}</Box></Box>}{t3}<Box flexDirection="row" gap={4}><Box flexDirection="column" width={36}>{leftModels.map(t4 => {
          const [model_0, usage_0] = t4;
          return <ModelEntry key={model_0} model={model_0} usage={usage_0} totalTokens={totalTokens} />;
        })}</Box>{t9}</Box>{t10}</Box>;
}
function _temp1(item: ChartLegend, i: number): React.ReactNode {
  return <Text key={item.model}>{i > 0 ? " \xB7 " : ""}<Ansi>{item.coloredBullet}</Ansi> {item.model}</Text>;
}
function _temp0(t0: ModelUsageEntry): string {
  const [model] = t0;
  return model;
}
function _temp9(sum: number, t0: ModelUsageEntry): number {
  const [, usage] = t0;
  return sum + usage.inputTokens + usage.outputTokens;
}
function _temp8(prev_0: number): number {
  return Math.max(prev_0 - 2, 0);
}
function _temp7(t0: ModelUsageEntry, t1: ModelUsageEntry): number {
  const [, a] = t0;
  const [, b] = t1;
  return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
}
type ModelEntryProps = {
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
  };
  totalTokens: number;
};
function ModelEntry(t0: ModelEntryProps): React.ReactNode {
  const $ = _c(21);
  const {
    model,
    usage,
    totalTokens
  } = t0;
  const modelTokens = usage.inputTokens + usage.outputTokens;
  const t1 = modelTokens / totalTokens * 100;
  let t2;
  if ($[0] !== t1) {
    t2 = t1.toFixed(1);
    $[0] = t1;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const percentage = t2;
  let t3;
  if ($[2] !== model) {
    t3 = renderModelName(model);
    $[2] = model;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  let t4;
  if ($[4] !== t3) {
    t4 = <Text bold={true}>{t3}</Text>;
    $[4] = t3;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] !== percentage) {
    t5 = <Text color="subtle">({percentage}%)</Text>;
    $[6] = percentage;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  let t6;
  if ($[8] !== t4 || $[9] !== t5) {
    t6 = <Text>{figures.bullet} {t4}{" "}{t5}</Text>;
    $[8] = t4;
    $[9] = t5;
    $[10] = t6;
  } else {
    t6 = $[10];
  }
  let t7;
  if ($[11] !== usage.inputTokens) {
    t7 = formatNumber(usage.inputTokens);
    $[11] = usage.inputTokens;
    $[12] = t7;
  } else {
    t7 = $[12];
  }
  let t8;
  if ($[13] !== usage.outputTokens) {
    t8 = formatNumber(usage.outputTokens);
    $[13] = usage.outputTokens;
    $[14] = t8;
  } else {
    t8 = $[14];
  }
  let t9;
  if ($[15] !== t7 || $[16] !== t8) {
    t9 = <Text color="subtle">{"  "}In: {t7} · Out:{" "}{t8}</Text>;
    $[15] = t7;
    $[16] = t8;
    $[17] = t9;
  } else {
    t9 = $[17];
  }
  let t10;
  if ($[18] !== t6 || $[19] !== t9) {
    t10 = <Box flexDirection="column">{t6}{t9}</Box>;
    $[18] = t6;
    $[19] = t9;
    $[20] = t10;
  } else {
    t10 = $[20];
  }
  return t10;
}
type ChartLegend = {
  model: string;
  coloredBullet: string; // Pre-colored bullet using chalk
};
type ChartOutput = {
  chart: string;
  legend: ChartLegend[];
  xAxisLabels: string;
};
function generateTokenChart(dailyTokens: DailyModelTokens[], models: string[], terminalWidth: number): ChartOutput | null {
  if (dailyTokens.length < 2 || models.length === 0) {
    return null;
  }

  // Y-axis labels take about 6 characters, plus some padding
  // Cap at ~52 to align with heatmap width (1 year of data)
  const yAxisWidth = 7;
  const availableWidth = terminalWidth - yAxisWidth;
  const chartWidth = Math.min(52, Math.max(20, availableWidth));

  // Distribute data across the available chart width
  let recentData: DailyModelTokens[];
  if (dailyTokens.length >= chartWidth) {
    // More data than space: take most recent N days
    recentData = dailyTokens.slice(-chartWidth);
  } else {
    // Less data than space: expand by repeating each point
    const repeatCount = Math.floor(chartWidth / dailyTokens.length);
    recentData = [];
    for (const day of dailyTokens) {
      for (let i = 0; i < repeatCount; i++) {
        recentData.push(day);
      }
    }
  }

  // Color palette for different models - use theme colors
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme));
  const colors = [themeColorToAnsi(theme.suggestion), themeColorToAnsi(theme.success), themeColorToAnsi(theme.warning)];

  // Prepare series data for each model
  const series: number[][] = [];
  const legend: ChartLegend[] = [];

  // Only show top 3 models to keep chart readable
  const topModels = models.slice(0, 3);
  for (let i = 0; i < topModels.length; i++) {
    const model = topModels[i]!;
    const data = recentData.map(day => day.tokensByModel[model] || 0);

    // Only include if there's actual data
    if (data.some(v => v > 0)) {
      series.push(data);
      // Use theme colors that match the chart
      const bulletColors = [theme.suggestion, theme.success, theme.warning];
      legend.push({
        model: renderModelName(model),
        coloredBullet: applyColor(figures.bullet, bulletColors[i % bulletColors.length] as Color)
      });
    }
  }
  if (series.length === 0) {
    return null;
  }
  const chart = asciichart(series, {
    height: 8,
    colors: colors.slice(0, series.length),
    format: (x: number) => {
      let label: string;
      if (x >= 1_000_000) {
        label = (x / 1_000_000).toFixed(1) + 'M';
      } else if (x >= 1_000) {
        label = (x / 1_000).toFixed(0) + 'k';
      } else {
        label = x.toFixed(0);
      }
      return label.padStart(6);
    }
  });

  // Generate x-axis labels with dates
  const xAxisLabels = generateXAxisLabels(recentData, recentData.length, yAxisWidth);
  return {
    chart,
    legend,
    xAxisLabels
  };
}
function generateXAxisLabels(data: DailyModelTokens[], _chartWidth: number, yAxisOffset: number): string {
  if (data.length === 0) return '';

  // Show 3-4 date labels evenly spaced, but leave room for last label
  const numLabels = Math.min(4, Math.max(2, Math.floor(data.length / 8)));
  // Don't use the very last position - leave room for the label text
  const usableLength = data.length - 6; // Reserve ~6 chars for last label (e.g., "Dec 7")
  const step = Math.floor(usableLength / (numLabels - 1)) || 1;
  const labelPositions: {
    pos: number;
    label: string;
  }[] = [];
  for (let i = 0; i < numLabels; i++) {
    const idx = Math.min(i * step, data.length - 1);
    const date = new Date(data[idx]!.date);
    const label = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
    labelPositions.push({
      pos: idx,
      label
    });
  }

  // Build the label string with proper spacing
  let result = ' '.repeat(yAxisOffset);
  let currentPos = 0;
  for (const {
    pos,
    label
  } of labelPositions) {
    const spaces = Math.max(1, pos - currentPos);
    result += ' '.repeat(spaces) + label;
    currentPos = pos + label.length;
  }
  return result;
}

// Screenshot functionality
async function handleScreenshot(stats: ClaudeCodeStats, activeTab: 'Overview' | 'Models', setStatus: (status: string | null) => void): Promise<void> {
  setStatus('copying…');
  const ansiText = renderStatsToAnsi(stats, activeTab);
  const result = await copyAnsiToClipboard(ansiText);
  setStatus(result.success ? 'copied!' : 'copy failed');

  // Clear status after 2 seconds
  setTimeout(setStatus, 2000, null);
}
function renderStatsToAnsi(stats: ClaudeCodeStats, activeTab: 'Overview' | 'Models'): string {
  const lines: string[] = [];
  if (activeTab === 'Overview') {
    lines.push(...renderOverviewToAnsi(stats));
  } else {
    lines.push(...renderModelsToAnsi(stats));
  }

  // Trim trailing empty lines
  while (lines.length > 0 && stripAnsi(lines[lines.length - 1]!).trim() === '') {
    lines.pop();
  }

  // Add "/stats" right-aligned on the last line
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1]!;
    const lastLineLen = getStringWidth(lastLine);
    // Use known content widths based on layout:
    // Overview: two-column stats = COL2_START(40) + COL2_LABEL_WIDTH(18) + max_value(~12) = 70
    // Models: chart width = 80
    const contentWidth = activeTab === 'Overview' ? 70 : 80;
    const statsLabel = '/stats';
    const padding = Math.max(2, contentWidth - lastLineLen - statsLabel.length);
    lines[lines.length - 1] = lastLine + ' '.repeat(padding) + chalk.gray(statsLabel);
  }
  return lines.join('\n');
}
function renderOverviewToAnsi(stats: ClaudeCodeStats): string[] {
  const lines: string[] = [];
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme));
  const h = (text: string) => applyColor(text, theme.claude as Color);

  // Two-column helper with fixed spacing
  // Column 1: label (18 chars) + value + padding to reach col 2
  // Column 2 starts at character position 40
  const COL1_LABEL_WIDTH = 18;
  const COL2_START = 40;
  const COL2_LABEL_WIDTH = 18;
  const row = (l1: string, v1: string, l2: string, v2: string): string => {
    // Build column 1: label + value
    const label1 = (l1 + ':').padEnd(COL1_LABEL_WIDTH);
    const col1PlainLen = label1.length + v1.length;

    // Calculate spaces needed between col1 value and col2 label
    const spaceBetween = Math.max(2, COL2_START - col1PlainLen);

    // Build column 2: label + value
    const label2 = (l2 + ':').padEnd(COL2_LABEL_WIDTH);

    // Assemble with colors applied to values only
    return label1 + h(v1) + ' '.repeat(spaceBetween) + label2 + h(v2);
  };

  // Heatmap - use fixed width for screenshot (56 = 52 weeks + 4 for day labels)
  if (stats.dailyActivity.length > 0) {
    lines.push(generateHeatmap(stats.dailyActivity, {
      terminalWidth: 56
    }));
    lines.push('');
  }

  // Calculate values
  const modelEntries = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  const favoriteModel = modelEntries[0];
  const totalTokens = modelEntries.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens, 0);

  // Row 1: Favorite model | Total tokens
  if (favoriteModel) {
    lines.push(row('Favorite model', renderModelName(favoriteModel[0]), 'Total tokens', formatNumber(totalTokens)));
  }
  lines.push('');

  // Row 2: Sessions | Longest session
  lines.push(row('Sessions', formatNumber(stats.totalSessions), 'Longest session', stats.longestSession ? formatDuration(stats.longestSession.duration) : 'N/A'));

  // Row 3: Current streak | Longest streak
  const currentStreakVal = `${stats.streaks.currentStreak} ${stats.streaks.currentStreak === 1 ? 'day' : 'days'}`;
  const longestStreakVal = `${stats.streaks.longestStreak} ${stats.streaks.longestStreak === 1 ? 'day' : 'days'}`;
  lines.push(row('Current streak', currentStreakVal, 'Longest streak', longestStreakVal));

  // Row 4: Active days | Peak hour
  const activeDaysVal = `${stats.activeDays}/${stats.totalDays}`;
  const peakHourVal = stats.peakActivityHour !== null ? `${stats.peakActivityHour}:00-${stats.peakActivityHour + 1}:00` : 'N/A';
  lines.push(row('Active days', activeDaysVal, 'Peak hour', peakHourVal));

  // Shot stats (internal-only)
  if (feature('SHOT_STATS') && stats.shotDistribution) {
    const dist = stats.shotDistribution;
    const totalWithShots = Object.values(dist).reduce((s, n) => s + n, 0);
    if (totalWithShots > 0) {
      const totalShots = Object.entries(dist).reduce((s, [count, sessions]) => s + parseInt(count, 10) * sessions, 0);
      const avgShots = (totalShots / totalWithShots).toFixed(1);
      const bucket = (min: number, max?: number) => Object.entries(dist).filter(([k]) => {
        const n = parseInt(k, 10);
        return n >= min && (max === undefined || n <= max);
      }).reduce((s, [, v]) => s + v, 0);
      const pct = (n: number) => Math.round(n / totalWithShots * 100);
      const fmtBucket = (count: number, p: number) => `${count} (${p}%)`;
      const b1 = bucket(1, 1);
      const b2_5 = bucket(2, 5);
      const b6_10 = bucket(6, 10);
      const b11 = bucket(11);
      lines.push('');
      lines.push('Shot distribution');
      lines.push(row('1-shot', fmtBucket(b1, pct(b1)), '2\u20135 shot', fmtBucket(b2_5, pct(b2_5))));
      lines.push(row('6\u201310 shot', fmtBucket(b6_10, pct(b6_10)), '11+ shot', fmtBucket(b11, pct(b11))));
      lines.push(`${'Avg/session:'.padEnd(COL1_LABEL_WIDTH)}${h(avgShots)}`);
    }
  }
  lines.push('');

  // Fun factoid
  const factoid = generateFunFactoid(stats, totalTokens);
  lines.push(h(factoid));
  lines.push(chalk.gray(`Stats from the last ${stats.totalDays} days`));
  return lines;
}
function renderModelsToAnsi(stats: ClaudeCodeStats): string[] {
  const lines: string[] = [];
  const modelEntries = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  if (modelEntries.length === 0) {
    lines.push(chalk.gray('No model usage data available'));
    return lines;
  }
  const favoriteModel = modelEntries[0];
  const totalTokens = modelEntries.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.outputTokens, 0);

  // Generate chart if we have data - use fixed width for screenshot
  const chartOutput = generateTokenChart(stats.dailyModelTokens, modelEntries.map(([model]) => model), 80 // Fixed width for screenshot
  );
  if (chartOutput) {
    lines.push(chalk.bold('Tokens per Day'));
    lines.push(chartOutput.chart);
    lines.push(chalk.gray(chartOutput.xAxisLabels));
    // Legend - use pre-colored bullets from chart output
    const legendLine = chartOutput.legend.map(item => `${item.coloredBullet} ${item.model}`).join(' · ');
    lines.push(legendLine);
    lines.push('');
  }

  // Summary
  lines.push(`${figures.star} Favorite: ${chalk.magenta.bold(renderModelName(favoriteModel?.[0] || ''))} · ${figures.circle} Total: ${chalk.magenta(formatNumber(totalTokens))} tokens`);
  lines.push('');

  // Model breakdown - only show top 3 for screenshot
  const topModels = modelEntries.slice(0, 3);
  for (const [model, usage] of topModels) {
    const modelTokens = usage.inputTokens + usage.outputTokens;
    const percentage = (modelTokens / totalTokens * 100).toFixed(1);
    lines.push(`${figures.bullet} ${chalk.bold(renderModelName(model))} ${chalk.gray(`(${percentage}%)`)}`);
    lines.push(chalk.dim(`  In: ${formatNumber(usage.inputTokens)} · Out: ${formatNumber(usage.outputTokens)}`));
  }
  return lines;
}
