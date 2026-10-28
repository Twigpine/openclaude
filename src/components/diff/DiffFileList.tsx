import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React from 'react';
import type { DiffFile } from '../../hooks/useDiffData.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { truncateStartToWidth } from '../../utils/format.js';
import { plural } from '../../utils/stringUtils.js';
const MAX_VISIBLE_FILES = 5;
type Props = {
  files: DiffFile[];
  selectedIndex: number;
};
export function DiffFileList(t0) {
  const $ = _c(36);
  const {
    files,
    selectedIndex
  } = t0;
  const {
    columns
  } = useTerminalSize();
  let t1;
  bb0: {
    if (files.length === 0 || files.length <= MAX_VISIBLE_FILES) {
      let t2;
      if ($[0] !== files.length) {
        t2 = {
          startIndex: 0,
          endIndex: files.length
        };
        $[0] = files.length;
        $[1] = t2;
      } else {
        t2 = $[1];
      }
      t1 = t2;
      break bb0;
    }
    let start = Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE_FILES / 2));
    let end = start + MAX_VISIBLE_FILES;
    if (end > files.length) {
      end = files.length;
      start = Math.max(0, end - MAX_VISIBLE_FILES);
    }
    let t2;
    if ($[2] !== end || $[3] !== start) {
      t2 = {
        startIndex: start,
        endIndex: end
      };
      $[2] = end;
      $[3] = start;
      $[4] = t2;
    } else {
      t2 = $[4];
    }
    t1 = t2;
  }
  const {
    startIndex,
    endIndex
  } = t1;
  if (files.length === 0) {
    let t2;
    if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Text dimColor={true}>No changed files</Text>;
      $[5] = t2;
    } else {
      t2 = $[5];
    }
    return t2;
  }
  let T0;
  let hasMoreBelow;
  let needsPagination;
  let t2;
  let t3;
  let t4;
  if ($[6] !== columns || $[7] !== endIndex || $[8] !== files || $[9] !== selectedIndex || $[10] !== startIndex) {
    const visibleFiles = files.slice(startIndex, endIndex);
    const hasMoreAbove = startIndex > 0;
    hasMoreBelow = endIndex < files.length;
    needsPagination = files.length > MAX_VISIBLE_FILES;
    const maxPathWidth = Math.max(20, columns - 16 - 3 - 4);
    T0 = Box;
    t2 = "column";
    if ($[17] !== hasMoreAbove || $[18] !== needsPagination || $[19] !== startIndex) {
      t3 = needsPagination && <Text dimColor={true}>{hasMoreAbove ? ` ↑ ${startIndex} more ${plural(startIndex, "file")}` : " "}</Text>;
      $[17] = hasMoreAbove;
      $[18] = needsPagination;
      $[19] = startIndex;
      $[20] = t3;
    } else {
      t3 = $[20];
    }
    let t5;
    if ($[21] !== maxPathWidth || $[22] !== selectedIndex || $[23] !== startIndex) {
      t5 = (file, index) => <FileItem key={file.path} file={file} isSelected={startIndex + index === selectedIndex} maxPathWidth={maxPathWidth} />;
      $[21] = maxPathWidth;
      $[22] = selectedIndex;
      $[23] = startIndex;
      $[24] = t5;
    } else {
      t5 = $[24];
    }
    t4 = visibleFiles.map(t5);
    $[6] = columns;
    $[7] = endIndex;
    $[8] = files;
    $[9] = selectedIndex;
    $[10] = startIndex;
    $[11] = T0;
    $[12] = hasMoreBelow;
    $[13] = needsPagination;
    $[14] = t2;
    $[15] = t3;
    $[16] = t4;
  } else {
    T0 = $[11];
    hasMoreBelow = $[12];
    needsPagination = $[13];
    t2 = $[14];
    t3 = $[15];
    t4 = $[16];
  }
  let t5;
  if ($[25] !== endIndex || $[26] !== files.length || $[27] !== hasMoreBelow || $[28] !== needsPagination) {
    t5 = needsPagination && <Text dimColor={true}>{hasMoreBelow ? ` ↓ ${files.length - endIndex} more ${plural(files.length - endIndex, "file")}` : " "}</Text>;
    $[25] = endIndex;
    $[26] = files.length;
    $[27] = hasMoreBelow;
    $[28] = needsPagination;
    $[29] = t5;
  } else {
    t5 = $[29];
  }
  let t6;
  if ($[30] !== T0 || $[31] !== t2 || $[32] !== t3 || $[33] !== t4 || $[34] !== t5) {
    t6 = <T0 flexDirection={t2}>{t3}{t4}{t5}</T0>;
    $[30] = T0;
    $[31] = t2;
    $[32] = t3;
    $[33] = t4;
    $[34] = t5;
    $[35] = t6;
  } else {
    t6 = $[35];
  }
  return t6;
}
function FileItem(t0) {
  const $ = _c(14);
  const {
    file,
    isSelected,
    maxPathWidth
  } = t0;
  let t1;
  if ($[0] !== file.path || $[1] !== maxPathWidth) {
    t1 = truncateStartToWidth(file.path, maxPathWidth);
    $[0] = file.path;
    $[1] = maxPathWidth;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const displayPath = t1;
  const pointer = isSelected ? figures.pointer + " " : "  ";
  const line = `${pointer}${displayPath}`;
  const t2 = isSelected ? "background" : undefined;
  let t3;
  if ($[3] !== isSelected || $[4] !== line || $[5] !== t2) {
    t3 = <Text bold={isSelected} color={t2} inverse={isSelected}>{line}</Text>;
    $[3] = isSelected;
    $[4] = line;
    $[5] = t2;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Box flexGrow={1} />;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] !== file || $[9] !== isSelected) {
    t5 = <FileStats file={file} isSelected={isSelected} />;
    $[8] = file;
    $[9] = isSelected;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  let t6;
  if ($[11] !== t3 || $[12] !== t5) {
    t6 = <Box flexDirection="row">{t3}{t4}{t5}</Box>;
    $[11] = t3;
    $[12] = t5;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  return t6;
}
function FileStats(t0) {
  const $ = _c(20);
  const {
    file,
    isSelected
  } = t0;
  if (file.isUntracked) {
    const t1 = !isSelected;
    let t2;
    if ($[0] !== t1) {
      t2 = <Text dimColor={t1} italic={true}>untracked</Text>;
      $[0] = t1;
      $[1] = t2;
    } else {
      t2 = $[1];
    }
    return t2;
  }
  if (file.isBinary) {
    const t1 = !isSelected;
    let t2;
    if ($[2] !== t1) {
      t2 = <Text dimColor={t1} italic={true}>Binary file</Text>;
      $[2] = t1;
      $[3] = t2;
    } else {
      t2 = $[3];
    }
    return t2;
  }
  if (file.isLargeFile) {
    const t1 = !isSelected;
    let t2;
    if ($[4] !== t1) {
      t2 = <Text dimColor={t1} italic={true}>Large file modified</Text>;
      $[4] = t1;
      $[5] = t2;
    } else {
      t2 = $[5];
    }
    return t2;
  }
  let t1;
  if ($[6] !== file.linesAdded || $[7] !== isSelected) {
    t1 = file.linesAdded > 0 && <Text color="diffAddedWord" bold={isSelected}>+{file.linesAdded}</Text>;
    $[6] = file.linesAdded;
    $[7] = isSelected;
    $[8] = t1;
  } else {
    t1 = $[8];
  }
  const t2 = file.linesAdded > 0 && file.linesRemoved > 0 && " ";
  let t3;
  if ($[9] !== file.linesRemoved || $[10] !== isSelected) {
    t3 = file.linesRemoved > 0 && <Text color="diffRemovedWord" bold={isSelected}>-{file.linesRemoved}</Text>;
    $[9] = file.linesRemoved;
    $[10] = isSelected;
    $[11] = t3;
  } else {
    t3 = $[11];
  }
  let t4;
  if ($[12] !== file.isTruncated || $[13] !== isSelected) {
    t4 = file.isTruncated && <Text dimColor={!isSelected}> (truncated)</Text>;
    $[12] = file.isTruncated;
    $[13] = isSelected;
    $[14] = t4;
  } else {
    t4 = $[14];
  }
  let t5;
  if ($[15] !== t1 || $[16] !== t2 || $[17] !== t3 || $[18] !== t4) {
    t5 = <Text>{t1}{t2}{t3}{t4}</Text>;
    $[15] = t1;
    $[16] = t2;
    $[17] = t3;
    $[18] = t4;
    $[19] = t5;
  } else {
    t5 = $[19];
  }
  return t5;
}
