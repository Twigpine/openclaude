import { c as _c } from "react-compiler-runtime";
import React, { Suspense, use } from 'react';
import { useSettings } from '../../../hooks/useSettings.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { stringWidth } from '../../../ink/stringWidth.js';
import { Ansi, Box, Text, useTheme } from '../../../ink.js';
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js';
import { applyMarkdown } from '../../../utils/markdown.js';
import sliceAnsi from '../../../utils/sliceAnsi.js';
type PreviewBoxProps = {
  /** The preview content to display. Markdown is rendered with syntax highlighting
   * for code blocks (```ts, ```py, etc.). Also supports plain multi-line text. */
  content: string;
  /** Maximum number of lines to display before truncating. @default 20 */
  maxLines?: number;
  /** Minimum height (in lines) for the preview box. Content will be padded if shorter. */
  minHeight?: number;
  /** Minimum width for the preview box. @default 40 */
  minWidth?: number;
  /** Maximum width available for this box (e.g., the container width). */
  maxWidth?: number;
};
const BOX_CHARS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤'
};

/**
 * A bordered monospace box for displaying preview content.
 * Truncates content that exceeds maxLines with an indicator.
 * The parent component should pass maxLines based on its available height budget.
 */
export function PreviewBox(props) {
  const $ = _c(4);
  const settings = useSettings();
  if (settings.syntaxHighlightingDisabled) {
    let t0;
    if ($[0] !== props) {
      t0 = <PreviewBoxBody {...props} highlight={null} />;
      $[0] = props;
      $[1] = t0;
    } else {
      t0 = $[1];
    }
    return t0;
  }
  let t0;
  if ($[2] !== props) {
    t0 = <Suspense fallback={<PreviewBoxBody {...props} highlight={null} />}><PreviewBoxWithHighlight {...props} /></Suspense>;
    $[2] = props;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  return t0;
}
function PreviewBoxWithHighlight(props) {
  const $ = _c(4);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = getCliHighlightPromise();
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const highlight = use(t0);
  let t1;
  if ($[1] !== highlight || $[2] !== props) {
    t1 = <PreviewBoxBody {...props} highlight={highlight} />;
    $[1] = highlight;
    $[2] = props;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  return t1;
}
function PreviewBoxBody(t0) {
  const $ = _c(34);
  const {
    content,
    maxLines,
    minHeight,
    minWidth: t1,
    maxWidth,
    highlight
  } = t0;
  const minWidth = t1 === undefined ? 40 : t1;
  const {
    columns: terminalWidth
  } = useTerminalSize();
  const [theme] = useTheme();
  const effectiveMaxWidth = maxWidth ?? terminalWidth - 4;
  const effectiveMaxLines = maxLines ?? 20;
  let t2;
  if ($[0] !== content || $[1] !== highlight || $[2] !== theme) {
    t2 = applyMarkdown(content, theme, highlight);
    $[0] = content;
    $[1] = highlight;
    $[2] = theme;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const rendered = t2;
  let T0;
  let bottomBorder;
  let t3;
  let t4;
  let t5;
  let truncationBar;
  if ($[4] !== effectiveMaxLines || $[5] !== effectiveMaxWidth || $[6] !== minHeight || $[7] !== minWidth || $[8] !== rendered) {
    const contentLines = rendered.split("\n");
    const isTruncated = contentLines.length > effectiveMaxLines;
    const truncatedLines = isTruncated ? contentLines.slice(0, effectiveMaxLines) : contentLines;
    const effectiveMinHeight = Math.min(minHeight ?? 0, effectiveMaxLines);
    const paddingNeeded = Math.max(0, effectiveMinHeight - truncatedLines.length - (isTruncated ? 1 : 0));
    const lines = paddingNeeded > 0 ? [...truncatedLines, ...Array(paddingNeeded).fill("")] : truncatedLines;
    const contentWidth = Math.max(minWidth, ...lines.map(_temp));
    const boxWidth = Math.min(contentWidth + 4, effectiveMaxWidth);
    const innerWidth = boxWidth - 4;
    let t6;
    if ($[15] !== boxWidth) {
      t6 = BOX_CHARS.horizontal.repeat(boxWidth - 2);
      $[15] = boxWidth;
      $[16] = t6;
    } else {
      t6 = $[16];
    }
    const topBorder = `${BOX_CHARS.topLeft}${t6}${BOX_CHARS.topRight}`;
    let t7;
    if ($[17] !== boxWidth) {
      t7 = BOX_CHARS.horizontal.repeat(boxWidth - 2);
      $[17] = boxWidth;
      $[18] = t7;
    } else {
      t7 = $[18];
    }
    bottomBorder = `${BOX_CHARS.bottomLeft}${t7}${BOX_CHARS.bottomRight}`;
    truncationBar = isTruncated ? (() => {
      const hiddenCount = contentLines.length - effectiveMaxLines;
      const label = `${BOX_CHARS.horizontal.repeat(3)} \u2702 ${BOX_CHARS.horizontal.repeat(3)} ${hiddenCount} lines hidden `;
      const labelWidth = stringWidth(label);
      const fillWidth = Math.max(0, boxWidth - 2 - labelWidth);
      return `${BOX_CHARS.teeLeft}${label}${BOX_CHARS.horizontal.repeat(fillWidth)}${BOX_CHARS.teeRight}`;
    })() : null;
    T0 = Box;
    t3 = "column";
    if ($[19] !== topBorder) {
      t4 = <Text dimColor={true}>{topBorder}</Text>;
      $[19] = topBorder;
      $[20] = t4;
    } else {
      t4 = $[20];
    }
    let t8;
    if ($[21] !== innerWidth) {
      t8 = (line_0, index) => {
        const lineWidth = stringWidth(line_0);
        const displayLine = lineWidth > innerWidth ? sliceAnsi(line_0, 0, innerWidth) : line_0;
        const padding = " ".repeat(Math.max(0, innerWidth - stringWidth(displayLine)));
        return <Box key={index} flexDirection="row"><Text dimColor={true}>{BOX_CHARS.vertical} </Text><Ansi>{displayLine}</Ansi><Text dimColor={true}>{padding} {BOX_CHARS.vertical}</Text></Box>;
      };
      $[21] = innerWidth;
      $[22] = t8;
    } else {
      t8 = $[22];
    }
    t5 = lines.map(t8);
    $[4] = effectiveMaxLines;
    $[5] = effectiveMaxWidth;
    $[6] = minHeight;
    $[7] = minWidth;
    $[8] = rendered;
    $[9] = T0;
    $[10] = bottomBorder;
    $[11] = t3;
    $[12] = t4;
    $[13] = t5;
    $[14] = truncationBar;
  } else {
    T0 = $[9];
    bottomBorder = $[10];
    t3 = $[11];
    t4 = $[12];
    t5 = $[13];
    truncationBar = $[14];
  }
  let t6;
  if ($[23] !== truncationBar) {
    t6 = truncationBar && <Text color="warning">{truncationBar}</Text>;
    $[23] = truncationBar;
    $[24] = t6;
  } else {
    t6 = $[24];
  }
  let t7;
  if ($[25] !== bottomBorder) {
    t7 = <Text dimColor={true}>{bottomBorder}</Text>;
    $[25] = bottomBorder;
    $[26] = t7;
  } else {
    t7 = $[26];
  }
  let t8;
  if ($[27] !== T0 || $[28] !== t3 || $[29] !== t4 || $[30] !== t5 || $[31] !== t6 || $[32] !== t7) {
    t8 = <T0 flexDirection={t3}>{t4}{t5}{t6}{t7}</T0>;
    $[27] = T0;
    $[28] = t3;
    $[29] = t4;
    $[30] = t5;
    $[31] = t6;
    $[32] = t7;
    $[33] = t8;
  } else {
    t8 = $[33];
  }
  return t8;
}
function _temp(line) {
  return stringWidth(line);
}
