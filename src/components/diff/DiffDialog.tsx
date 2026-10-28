import { c as _c } from "react-compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import React, { useEffect, useRef, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { type DiffData, useDiffData } from '../../hooks/useDiffData.js';
import { type TurnDiff, useTurnDiffs } from '../../hooks/useTurnDiffs.js';
import { Box, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { Message } from '../../types/message.js';
import { plural } from '../../utils/stringUtils.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { DiffDetailView } from './DiffDetailView.js';
import { DiffFileList } from './DiffFileList.js';
type Props = {
  messages: Message[];
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type ViewMode = 'list' | 'detail';
type DiffSource = {
  type: 'current';
} | {
  type: 'turn';
  turn: TurnDiff;
};
function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files = Array.from(turn.files.values()).map(f => ({
    path: f.filePath,
    linesAdded: f.linesAdded,
    linesRemoved: f.linesRemoved,
    isBinary: false,
    isLargeFile: false,
    isTruncated: false,
    isNewFile: f.isNewFile
  })).sort((a, b) => a.path.localeCompare(b.path));
  const hunks = new Map<string, StructuredPatchHunk[]>();
  for (const f of turn.files.values()) {
    hunks.set(f.filePath, f.hunks);
  }
  return {
    stats: {
      filesCount: turn.stats.filesChanged,
      linesAdded: turn.stats.linesAdded,
      linesRemoved: turn.stats.linesRemoved
    },
    files,
    hunks,
    loading: false
  };
}
export function DiffDialog(t0) {
  const $ = _c(73);
  const {
    messages,
    onDone
  } = t0;
  const gitDiffData = useDiffData();
  const turnDiffs = useTurnDiffs(messages);
  const [viewMode, setViewMode] = useState("list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sourceIndex, setSourceIndex] = useState(0);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      type: "current"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== turnDiffs) {
    t2 = [t1, ...turnDiffs.map(_temp)];
    $[1] = turnDiffs;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const sources = t2;
  const currentSource = sources[sourceIndex];
  const currentTurn = currentSource?.type === "turn" ? currentSource.turn : null;
  let t3;
  if ($[3] !== currentTurn || $[4] !== gitDiffData) {
    t3 = currentTurn ? turnDiffToDiffData(currentTurn) : gitDiffData;
    $[3] = currentTurn;
    $[4] = gitDiffData;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const diffData = t3;
  const selectedFile = diffData.files[selectedIndex];
  let t4;
  if ($[6] !== diffData.hunks || $[7] !== selectedFile) {
    t4 = selectedFile ? diffData.hunks.get(selectedFile.path) || [] : [];
    $[6] = diffData.hunks;
    $[7] = selectedFile;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const selectedHunks = t4;
  let t5;
  let t6;
  if ($[9] !== sourceIndex || $[10] !== sources.length) {
    t5 = () => {
      if (sourceIndex >= sources.length) {
        setSourceIndex(Math.max(0, sources.length - 1));
      }
    };
    t6 = [sources.length, sourceIndex];
    $[9] = sourceIndex;
    $[10] = sources.length;
    $[11] = t5;
    $[12] = t6;
  } else {
    t5 = $[11];
    t6 = $[12];
  }
  useEffect(t5, t6);
  const prevSourceIndex = useRef(sourceIndex);
  let t7;
  let t8;
  if ($[13] !== sourceIndex) {
    t7 = () => {
      if (prevSourceIndex.current !== sourceIndex) {
        setSelectedIndex(0);
        prevSourceIndex.current = sourceIndex;
      }
    };
    t8 = [sourceIndex];
    $[13] = sourceIndex;
    $[14] = t7;
    $[15] = t8;
  } else {
    t7 = $[14];
    t8 = $[15];
  }
  useEffect(t7, t8);
  useRegisterOverlay("diff-dialog", true);
  let t10;
  let t9;
  if ($[16] !== sources.length || $[17] !== viewMode) {
    t9 = () => {
      if (viewMode === "detail") {
        setViewMode("list");
      } else {
        if (viewMode === "list" && sources.length > 1) {
          setSourceIndex(_temp2);
        }
      }
    };
    t10 = () => {
      if (viewMode === "list" && sources.length > 1) {
        setSourceIndex(prev_0 => Math.min(sources.length - 1, prev_0 + 1));
      }
    };
    $[16] = sources.length;
    $[17] = viewMode;
    $[18] = t10;
    $[19] = t9;
  } else {
    t10 = $[18];
    t9 = $[19];
  }
  let t11;
  if ($[20] !== viewMode) {
    t11 = () => {
      if (viewMode === "detail") {
        setViewMode("list");
      }
    };
    $[20] = viewMode;
    $[21] = t11;
  } else {
    t11 = $[21];
  }
  let t12;
  if ($[22] !== selectedFile || $[23] !== viewMode) {
    t12 = () => {
      if (viewMode === "list" && selectedFile) {
        setViewMode("detail");
      }
    };
    $[22] = selectedFile;
    $[23] = viewMode;
    $[24] = t12;
  } else {
    t12 = $[24];
  }
  let t13;
  if ($[25] !== viewMode) {
    t13 = () => {
      if (viewMode === "list") {
        setSelectedIndex(_temp3);
      }
    };
    $[25] = viewMode;
    $[26] = t13;
  } else {
    t13 = $[26];
  }
  let t14;
  if ($[27] !== diffData.files.length || $[28] !== viewMode) {
    t14 = () => {
      if (viewMode === "list") {
        setSelectedIndex(prev_2 => Math.min(diffData.files.length - 1, prev_2 + 1));
      }
    };
    $[27] = diffData.files.length;
    $[28] = viewMode;
    $[29] = t14;
  } else {
    t14 = $[29];
  }
  let t15;
  if ($[30] !== t10 || $[31] !== t11 || $[32] !== t12 || $[33] !== t13 || $[34] !== t14 || $[35] !== t9) {
    t15 = {
      "diff:previousSource": t9,
      "diff:nextSource": t10,
      "diff:back": t11,
      "diff:viewDetails": t12,
      "diff:previousFile": t13,
      "diff:nextFile": t14
    };
    $[30] = t10;
    $[31] = t11;
    $[32] = t12;
    $[33] = t13;
    $[34] = t14;
    $[35] = t9;
    $[36] = t15;
  } else {
    t15 = $[36];
  }
  let t16;
  if ($[37] === Symbol.for("react.memo_cache_sentinel")) {
    t16 = {
      context: "DiffDialog"
    };
    $[37] = t16;
  } else {
    t16 = $[37];
  }
  useKeybindings(t15, t16);
  let t17;
  if ($[38] !== diffData.stats) {
    t17 = diffData.stats ? <Text dimColor={true}>{diffData.stats.filesCount} {plural(diffData.stats.filesCount, "file")}{" "}changed{diffData.stats.linesAdded > 0 && <Text color="diffAddedWord"> +{diffData.stats.linesAdded}</Text>}{diffData.stats.linesRemoved > 0 && <Text color="diffRemovedWord"> -{diffData.stats.linesRemoved}</Text>}</Text> : null;
    $[38] = diffData.stats;
    $[39] = t17;
  } else {
    t17 = $[39];
  }
  const subtitle = t17;
  const headerTitle = currentTurn ? `Turn ${currentTurn.turnIndex}` : "Uncommitted changes";
  const headerSubtitle = currentTurn ? currentTurn.userPromptPreview ? `"${currentTurn.userPromptPreview}"` : "" : "(git diff HEAD)";
  let t18;
  if ($[40] !== sourceIndex || $[41] !== sources) {
    t18 = sources.length > 1 ? <Box>{sourceIndex > 0 && <Text dimColor={true}>◀ </Text>}{sources.map((source, i) => {
        const isSelected = i === sourceIndex;
        const label = source.type === "current" ? "Current" : `T${source.turn.turnIndex}`;
        return <Text key={i} dimColor={!isSelected} bold={isSelected}>{i > 0 ? " \xB7 " : ""}{label}</Text>;
      })}{sourceIndex < sources.length - 1 && <Text dimColor={true}> ▶</Text>}</Box> : null;
    $[40] = sourceIndex;
    $[41] = sources;
    $[42] = t18;
  } else {
    t18 = $[42];
  }
  const sourceSelector = t18;
  const dismissShortcut = useShortcutDisplay("diff:dismiss", "DiffDialog", "esc");
  let t19;
  bb0: {
    if (diffData.loading) {
      t19 = "Loading diff\u2026";
      break bb0;
    }
    if (currentTurn) {
      t19 = "No file changes in this turn";
      break bb0;
    }
    if (diffData.stats && diffData.stats.filesCount > 0 && diffData.files.length === 0) {
      t19 = "Too many files to display details";
      break bb0;
    }
    t19 = "Working tree is clean";
  }
  const emptyMessage = t19;
  let t20;
  if ($[43] !== headerSubtitle) {
    t20 = headerSubtitle && <Text dimColor={true}> {headerSubtitle}</Text>;
    $[43] = headerSubtitle;
    $[44] = t20;
  } else {
    t20 = $[44];
  }
  let t21;
  if ($[45] !== headerTitle || $[46] !== t20) {
    t21 = <Text>{headerTitle}{t20}</Text>;
    $[45] = headerTitle;
    $[46] = t20;
    $[47] = t21;
  } else {
    t21 = $[47];
  }
  const title = t21;
  let t22;
  if ($[48] !== onDone || $[49] !== viewMode) {
    t22 = function handleCancel() {
      if (viewMode === "detail") {
        setViewMode("list");
      } else {
        onDone("Diff dialog dismissed", {
          display: "system"
        });
      }
    };
    $[48] = onDone;
    $[49] = viewMode;
    $[50] = t22;
  } else {
    t22 = $[50];
  }
  const handleCancel = t22;
  let t23;
  if ($[51] !== dismissShortcut || $[52] !== sources.length || $[53] !== viewMode) {
    t23 = exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : viewMode === "list" ? <Byline>{sources.length > 1 && <Text>←/→ source</Text>}<Text>↑/↓ select</Text><Text>Enter view</Text><Text>{dismissShortcut} close</Text></Byline> : <Byline><Text>← back</Text><Text>{dismissShortcut} close</Text></Byline>;
    $[51] = dismissShortcut;
    $[52] = sources.length;
    $[53] = viewMode;
    $[54] = t23;
  } else {
    t23 = $[54];
  }
  let t24;
  if ($[55] !== diffData.files || $[56] !== emptyMessage || $[57] !== selectedFile?.isBinary || $[58] !== selectedFile?.isLargeFile || $[59] !== selectedFile?.isTruncated || $[60] !== selectedFile?.isUntracked || $[61] !== selectedFile?.path || $[62] !== selectedHunks || $[63] !== selectedIndex || $[64] !== viewMode) {
    t24 = diffData.files.length === 0 ? <Box marginTop={1}><Text dimColor={true}>{emptyMessage}</Text></Box> : viewMode === "list" ? <Box flexDirection="column" marginTop={1}><DiffFileList files={diffData.files} selectedIndex={selectedIndex} /></Box> : <Box flexDirection="column" marginTop={1}><DiffDetailView filePath={selectedFile?.path || ""} hunks={selectedHunks} isLargeFile={selectedFile?.isLargeFile} isBinary={selectedFile?.isBinary} isTruncated={selectedFile?.isTruncated} isUntracked={selectedFile?.isUntracked} /></Box>;
    $[55] = diffData.files;
    $[56] = emptyMessage;
    $[57] = selectedFile?.isBinary;
    $[58] = selectedFile?.isLargeFile;
    $[59] = selectedFile?.isTruncated;
    $[60] = selectedFile?.isUntracked;
    $[61] = selectedFile?.path;
    $[62] = selectedHunks;
    $[63] = selectedIndex;
    $[64] = viewMode;
    $[65] = t24;
  } else {
    t24 = $[65];
  }
  let t25;
  if ($[66] !== handleCancel || $[67] !== sourceSelector || $[68] !== subtitle || $[69] !== t23 || $[70] !== t24 || $[71] !== title) {
    t25 = <Dialog title={title} onCancel={handleCancel} color="background" inputGuide={t23}>{sourceSelector}{subtitle}{t24}</Dialog>;
    $[66] = handleCancel;
    $[67] = sourceSelector;
    $[68] = subtitle;
    $[69] = t23;
    $[70] = t24;
    $[71] = title;
    $[72] = t25;
  } else {
    t25 = $[72];
  }
  return t25;
}
function _temp3(prev_1) {
  return Math.max(0, prev_1 - 1);
}
function _temp2(prev) {
  return Math.max(0, prev - 1);
}
function _temp(turn) {
  return {
    type: "turn",
    turn
  };
}
