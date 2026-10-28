import { c as _c } from "react-compiler-runtime";
import { diffWordsWithSpace, type StructuredPatchHunk } from 'diff';
import * as React from 'react';
import type { ThemeName } from 'src/utils/theme.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, NoSelect, Text, useTheme, wrapText } from '../../ink.js';

/*
 * StructuredDiffFallback Component: Word-Level Diff Highlighting Example
 *
 * This component shows diff changes with word-level highlighting. Here's a walkthrough:
 *
 * Example:
 * ```
 * // Original code
 * function oldName(param) {
 *   return param.oldProperty;
 * }
 *
 * // Changed code
 * function newName(param) {
 *   return param.newProperty;
 * }
 * ```
 *
 * Processing flow:
 * 1. Component receives a patch with lines including '+' and '-' prefixes
 * 2. Lines are transformed into objects with type (add/remove/nochange)
 * 3. Related add/remove lines are paired (e.g., oldName with newName)
 * 4. Word-level diffing identifies specific changed parts:
 *    [
 *      { value: 'function ', added: undefined, removed: undefined },  // Common
 *      { value: 'oldName', removed: true },                           // Removed
 *      { value: 'newName', added: true },                             // Added
 *      { value: '(param) {', added: undefined, removed: undefined }   // Common
 *    ]
 * 5. Renders with enhanced highlighting:
 *    - Common parts are shown normally
 *    - Removed words get a darker red background
 *    - Added words get a darker green background
 *
 * This produces a visually clear diff where users can see exactly which words
 * changed rather than just which lines were modified.
 */

// Define DiffLine interface to be used throughout the file
interface DiffLine {
  code: string;
  type: 'add' | 'remove' | 'nochange';
  i: number;
  originalCode: string;
  wordDiff?: boolean; // Flag for word-level diffing
  matchedLine?: DiffLine;
}

// Line object type for internal functions
export interface LineObject {
  code: string;
  i: number;
  type: 'add' | 'remove' | 'nochange';
  originalCode: string;
  wordDiff?: boolean;
  matchedLine?: LineObject;
}

// Type for word-level diff parts
interface DiffPart {
  added?: boolean;
  removed?: boolean;
  value: string;
}
type Props = {
  patch: StructuredPatchHunk;
  dim: boolean;
  width: number;
};

// Threshold for when we show a full-line diff instead of word-level diffing
const CHANGE_THRESHOLD = 0.4;
export function StructuredDiffFallback(t0) {
  const $ = _c(10);
  const {
    patch,
    dim,
    width
  } = t0;
  const [theme] = useTheme();
  let t1;
  if ($[0] !== dim || $[1] !== patch.lines || $[2] !== patch.oldStart || $[3] !== theme || $[4] !== width) {
    t1 = formatDiff(patch.lines, patch.oldStart, width, dim, theme);
    $[0] = dim;
    $[1] = patch.lines;
    $[2] = patch.oldStart;
    $[3] = theme;
    $[4] = width;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  const diff = t1;
  let t2;
  if ($[6] !== diff) {
    t2 = diff.map(_temp);
    $[6] = diff;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  let t3;
  if ($[8] !== t2) {
    t3 = <Box flexDirection="column" flexGrow={1}>{t2}</Box>;
    $[8] = t2;
    $[9] = t3;
  } else {
    t3 = $[9];
  }
  return t3;
}

// Transform lines to line objects with type information
function _temp(node, i) {
  return <Box key={i}>{node}</Box>;
}
export function transformLinesToObjects(lines: string[]): LineObject[] {
  return lines.map(code => {
    if (code.startsWith('+')) {
      return {
        code: code.slice(1),
        i: 0,
        type: 'add',
        originalCode: code.slice(1)
      };
    }
    if (code.startsWith('-')) {
      return {
        code: code.slice(1),
        i: 0,
        type: 'remove',
        originalCode: code.slice(1)
      };
    }
    return {
      code: code.slice(1),
      i: 0,
      type: 'nochange',
      originalCode: code.slice(1)
    };
  });
}

// Group adjacent add/remove lines for word-level diffing
export function processAdjacentLines(lineObjects: LineObject[]): LineObject[] {
  const processedLines: LineObject[] = [];
  let i = 0;
  while (i < lineObjects.length) {
    const current = lineObjects[i];
    if (!current) {
      i++;
      continue;
    }

    // Find a sequence of remove followed by add (possible word-level diff candidates)
    if (current.type === 'remove') {
      const removeLines: LineObject[] = [current];
      let j = i + 1;

      // Collect consecutive remove lines
      while (j < lineObjects.length && lineObjects[j]?.type === 'remove') {
        const line = lineObjects[j];
        if (line) {
          removeLines.push(line);
        }
        j++;
      }

      // Check if there are add lines following the remove lines
      const addLines: LineObject[] = [];
      while (j < lineObjects.length && lineObjects[j]?.type === 'add') {
        const line = lineObjects[j];
        if (line) {
          addLines.push(line);
        }
        j++;
      }

      // If we have both remove and add lines, perform word-level diffing
      if (removeLines.length > 0 && addLines.length > 0) {
        // For word diffing, we'll compare each pair of lines or the closest available match
        const pairCount = Math.min(removeLines.length, addLines.length);

        // Add paired lines with word diff info
        for (let k = 0; k < pairCount; k++) {
          const removeLine = removeLines[k];
          const addLine = addLines[k];
          if (removeLine && addLine) {
            removeLine.wordDiff = true;
            addLine.wordDiff = true;

            // Store the matched pair for later word diffing
            removeLine.matchedLine = addLine;
            addLine.matchedLine = removeLine;
          }
        }

        // Add all remove lines (both paired and unpaired)
        processedLines.push(...removeLines.filter(Boolean));

        // Then add all add lines (both paired and unpaired)
        processedLines.push(...addLines.filter(Boolean));
        i = j; // Skip all the lines we've processed
      } else {
        // No matching add lines, just add the current remove line
        processedLines.push(current);
        i++;
      }
    } else {
      // Not a remove line, just add it
      processedLines.push(current);
      i++;
    }
  }
  return processedLines;
}

// Calculate word-level diffs between two text strings
export function calculateWordDiffs(oldText: string, newText: string): DiffPart[] {
  // Use diffWordsWithSpace instead of diffWords to preserve whitespace
  // This ensures spaces between tokens like > and { are preserved
  const result = diffWordsWithSpace(oldText, newText, {
    ignoreCase: false
  });
  return result;
}

// Process word-level diffs with manual wrapping support
function generateWordDiffElements(item: DiffLine, width: number, maxWidth: number, dim: boolean, overrideTheme?: ThemeName): React.ReactNode[] | null {
  const {
    type,
    i,
    wordDiff,
    matchedLine,
    originalCode
  } = item;
  if (!wordDiff || !matchedLine) {
    return null; // This function only handles word-level diff rendering
  }
  const removedLineText = type === 'remove' ? originalCode : matchedLine.originalCode;
  const addedLineText = type === 'remove' ? matchedLine.originalCode : originalCode;
  const wordDiffs = calculateWordDiffs(removedLineText, addedLineText);

  // Check if we should use word-level diffing
  const totalLength = removedLineText.length + addedLineText.length;
  const changedLength = wordDiffs.filter(part => part.added || part.removed).reduce((sum, part) => sum + part.value.length, 0);
  const changeRatio = changedLength / totalLength;
  if (changeRatio > CHANGE_THRESHOLD || dim) {
    return null; // Fall back to standard rendering for major changes
  }

  // Calculate available width for content
  const diffPrefix = type === 'add' ? '+' : '-';
  const diffPrefixWidth = diffPrefix.length;
  const availableContentWidth = Math.max(1, width - maxWidth - 1 - diffPrefixWidth);

  // Manually wrap the word diff parts with better space efficiency
  const wrappedLines: {
    content: React.ReactNode[];
    contentWidth: number;
  }[] = [];
  let currentLine: React.ReactNode[] = [];
  let currentLineWidth = 0;
  wordDiffs.forEach((part, partIndex) => {
    // Determine if this part should be shown for this line type
    let shouldShow = false;
    let partBgColor: 'diffAddedWord' | 'diffRemovedWord' | undefined;
    if (type === 'add') {
      if (part.added) {
        shouldShow = true;
        partBgColor = 'diffAddedWord';
      } else if (!part.removed) {
        shouldShow = true;
      }
    } else if (type === 'remove') {
      if (part.removed) {
        shouldShow = true;
        partBgColor = 'diffRemovedWord';
      } else if (!part.added) {
        shouldShow = true;
      }
    }
    if (!shouldShow) return;

    // Use wrapText to wrap this individual part if it's long
    const partWrapped = wrapText(part.value, availableContentWidth, 'wrap');
    const partLines = partWrapped.split('\n');
    partLines.forEach((partLine, lineIdx) => {
      if (!partLine) return;

      // Check if we need to start a new line
      if (lineIdx > 0 || currentLineWidth + stringWidth(partLine) > availableContentWidth) {
        if (currentLine.length > 0) {
          wrappedLines.push({
            content: [...currentLine],
            contentWidth: currentLineWidth
          });
          currentLine = [];
          currentLineWidth = 0;
        }
      }
      currentLine.push(<Text key={`part-${partIndex}-${lineIdx}`} backgroundColor={partBgColor}>
          {partLine}
        </Text>);
      currentLineWidth += stringWidth(partLine);
    });
  });
  if (currentLine.length > 0) {
    wrappedLines.push({
      content: currentLine,
      contentWidth: currentLineWidth
    });
  }

  // Render each wrapped line as a separate Text element
  return wrappedLines.map(({
    content,
    contentWidth
  }, lineIndex) => {
    const key = `${type}-${i}-${lineIndex}`;
    const lineBgColor = type === 'add' ? dim ? 'diffAddedDimmed' : 'diffAdded' : dim ? 'diffRemovedDimmed' : 'diffRemoved';
    const lineNum = lineIndex === 0 ? i : undefined;
    const lineNumStr = (lineNum !== undefined ? lineNum.toString().padStart(maxWidth) : ' '.repeat(maxWidth)) + ' ';
    // Calculate padding to fill the entire terminal width
    const usedWidth = lineNumStr.length + diffPrefixWidth + contentWidth;
    const padding = Math.max(0, width - usedWidth);
    return <Box key={key} flexDirection="row">
        <NoSelect fromLeftEdge>
          <Text color={overrideTheme ? 'text' : undefined} backgroundColor={lineBgColor} dimColor={dim}>
            {lineNumStr}
            {diffPrefix}
          </Text>
        </NoSelect>
        <Text color={overrideTheme ? 'text' : undefined} backgroundColor={lineBgColor} dimColor={dim}>
          {content}
          {' '.repeat(padding)}
        </Text>
      </Box>;
  });
}
function formatDiff(lines: string[], startingLineNumber: number, width: number, dim: boolean, overrideTheme?: ThemeName): React.ReactNode[] {
  // Ensure width is at least 1 to prevent rendering issues with very narrow terminals
  const safeWidth = Math.max(1, Math.floor(width));

  // Step 1: Transform lines to line objects with type information
  const lineObjects = transformLinesToObjects(lines);

  // Step 2: Group adjacent add/remove lines for word-level diffing
  const processedLines = processAdjacentLines(lineObjects);

  // Step 3: Number the diff lines
  const ls = numberDiffLines(processedLines, startingLineNumber);

  // Find max line number width for alignment
  const maxLineNumber = Math.max(...ls.map(({
    i
  }) => i), 0);
  const maxWidth = Math.max(maxLineNumber.toString().length + 1, 0);

  // Step 4: Render formatting
  return ls.flatMap((item): React.ReactNode[] => {
    const {
      type,
      code,
      i,
      wordDiff,
      matchedLine
    } = item;

    // Handle word-level diffing for add/remove pairs
    if (wordDiff && matchedLine) {
      const wordDiffElements = generateWordDiffElements(item, safeWidth, maxWidth, dim, overrideTheme);

      // word-diff might refuse (e.g. due to lines being substantially different) in which
      // case we'll fall through to normal renderin gbelow
      if (wordDiffElements !== null) {
        return wordDiffElements;
      }
    }

    // Standard rendering for lines without word diffing or as fallback
    // Calculate available width accounting for line number + space + diff prefix
    const diffPrefixWidth = 2; // "  " for unchanged, "+ " or "- " for changes
    const availableContentWidth = Math.max(1, safeWidth - maxWidth - 1 - diffPrefixWidth); // -1 for space after line number
    const wrappedText = wrapText(code, availableContentWidth, 'wrap');
    const wrappedLines = wrappedText.split('\n');
    return wrappedLines.map((line, lineIndex) => {
      const key = `${type}-${i}-${lineIndex}`;
      const lineNum = lineIndex === 0 ? i : undefined;
      const lineNumStr = (lineNum !== undefined ? lineNum.toString().padStart(maxWidth) : ' '.repeat(maxWidth)) + ' ';
      const sigil = type === 'add' ? '+' : type === 'remove' ? '-' : ' ';
      // Calculate padding to fill the entire terminal width
      const contentWidth = lineNumStr.length + 1 + stringWidth(line); // lineNum + sigil + code
      const padding = Math.max(0, safeWidth - contentWidth);
      const bgColor = type === 'add' ? dim ? 'diffAddedDimmed' : 'diffAdded' : type === 'remove' ? dim ? 'diffRemovedDimmed' : 'diffRemoved' : undefined;

      // Gutter (line number + sigil) is wrapped in <NoSelect> so fullscreen
      // text selection yields clean code. bgColor carries across both boxes
      // so the visual continuity (solid red/green bar) is unchanged.
      return <Box key={key} flexDirection="row">
          <NoSelect fromLeftEdge>
            {/* Line numbers always dim (mirrors color-diff addLineNumber) so
                the gutter recedes; the +/- sigil keeps full intensity. */}
            <Text color={overrideTheme ? 'text' : undefined} backgroundColor={bgColor} dimColor={true}>
              {lineNumStr}
              <Text dimColor={dim || type === 'nochange'}>{sigil}</Text>
            </Text>
          </NoSelect>
          <Text color={overrideTheme ? 'text' : undefined} backgroundColor={bgColor} dimColor={dim}>
            {line}
            {' '.repeat(padding)}
          </Text>
        </Box>;
    });
  });
}
export function numberDiffLines(diff: LineObject[], startLine: number): DiffLine[] {
  let i = startLine;
  const result: DiffLine[] = [];
  const queue = [...diff];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const {
      code,
      type,
      originalCode,
      wordDiff,
      matchedLine
    } = current;
    const line = {
      code,
      type,
      i,
      originalCode,
      wordDiff,
      matchedLine
    };

    // Update counters based on change type
    switch (type) {
      case 'nochange':
        i++;
        result.push(line);
        break;
      case 'add':
        i++;
        result.push(line);
        break;
      case 'remove':
        {
          result.push(line);
          let numRemoved = 0;
          while (queue[0]?.type === 'remove') {
            i++;
            const current = queue.shift()!;
            const {
              code,
              type,
              originalCode,
              wordDiff,
              matchedLine
            } = current;
            const line = {
              code,
              type,
              i,
              originalCode,
              wordDiff,
              matchedLine
            };
            result.push(line);
            numRemoved++;
          }
          i -= numRemoved;
          break;
        }
    }
  }
  return result;
}
