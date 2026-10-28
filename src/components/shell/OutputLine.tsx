import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Ansi, Text } from '../../ink.js';
import { createHyperlink } from '../../utils/hyperlink.js';
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js';
import { renderTruncatedContent } from '../../utils/terminal.js';
import { MessageResponse } from '../MessageResponse.js';
import { InVirtualListContext } from '../messageActions.js';
import { useExpandShellOutput } from './ExpandShellOutputContext.js';
export function tryFormatJson(line: string): string {
  try {
    const parsed = jsonParse(line);
    const stringified = jsonStringify(parsed);

    // Check if precision was lost during JSON round-trip
    // This happens when large integers exceed Number.MAX_SAFE_INTEGER
    // We normalize both strings by removing whitespace and unnecessary
    // escapes (\/ is valid but optional in JSON) for comparison
    const normalizedOriginal = line.replace(/\\\//g, '/').replace(/\s+/g, '');
    const normalizedStringified = stringified.replace(/\s+/g, '');
    if (normalizedOriginal !== normalizedStringified) {
      // Precision loss detected - return original line unformatted
      return line;
    }
    return jsonStringify(parsed, null, 2);
  } catch {
    return line;
  }
}
const MAX_JSON_FORMAT_LENGTH = 10_000;
export function tryJsonFormatContent(content: string): string {
  if (content.length > MAX_JSON_FORMAT_LENGTH) {
    return content;
  }
  const allLines = content.split('\n');
  return allLines.map(tryFormatJson).join('\n');
}

// Match http(s) URLs inside JSON string values. Conservative: no quotes,
// no whitespace, no trailing comma/brace that'd be JSON structure.
const URL_IN_JSON = /https?:\/\/[^\s"'<>\\]+/g;
export function linkifyUrlsInText(content: string): string {
  return content.replace(URL_IN_JSON, url => createHyperlink(url));
}
export function OutputLine(t0) {
  const $ = _c(11);
  const {
    content,
    verbose,
    isError,
    isWarning,
    linkifyUrls
  } = t0;
  const {
    columns
  } = useTerminalSize();
  const expandShellOutput = useExpandShellOutput();
  const inVirtualList = React.useContext(InVirtualListContext);
  const shouldShowFull = verbose || expandShellOutput;
  let t1;
  if ($[0] !== columns || $[1] !== content || $[2] !== inVirtualList || $[3] !== linkifyUrls || $[4] !== shouldShowFull) {
    bb0: {
      let formatted = tryJsonFormatContent(content);
      if (linkifyUrls) {
        formatted = linkifyUrlsInText(formatted);
      }
      if (shouldShowFull) {
        t1 = stripUnderlineAnsi(formatted);
        break bb0;
      }
      t1 = stripUnderlineAnsi(renderTruncatedContent(formatted, columns, inVirtualList));
    }
    $[0] = columns;
    $[1] = content;
    $[2] = inVirtualList;
    $[3] = linkifyUrls;
    $[4] = shouldShowFull;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  const formattedContent = t1;
  const color = isError ? "error" : isWarning ? "warning" : undefined;
  let t2;
  if ($[6] !== formattedContent) {
    t2 = <Ansi>{formattedContent}</Ansi>;
    $[6] = formattedContent;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  let t3;
  if ($[8] !== color || $[9] !== t2) {
    t3 = <MessageResponse><Text color={color}>{t2}</Text></MessageResponse>;
    $[8] = color;
    $[9] = t2;
    $[10] = t3;
  } else {
    t3 = $[10];
  }
  return t3;
}

/**
 * Underline ANSI codes in particular tend to leak out for some reason. I wasn't
 * able to figure out why, or why emitting a reset ANSI code wasn't enough to
 * prevent them from leaking. I also didn't want to strip all ANSI codes with
 * stripAnsi(), because we used to do that and people complained about losing
 * all formatting. So we just strip the underline ANSI codes specifically.
 */
export function stripUnderlineAnsi(content: string): string {
  return content.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[([0-9]+;)*4(;[0-9]+)*m|\u001b\[4(;[0-9]+)*m|\u001b\[([0-9]+;)*4m/g, '');
}
