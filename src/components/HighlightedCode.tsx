import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, type DOMElement, measureElement, NoSelect, Text, useTheme } from '../ink.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import sliceAnsi from '../utils/sliceAnsi.js';
import { countCharInString } from '../utils/stringUtils.js';
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js';
import { expectColorFile } from './StructuredDiff/colorDiff.js';
type Props = {
  code: string;
  filePath: string;
  width?: number;
  dim?: boolean;
};
const DEFAULT_WIDTH = 80;
export const HighlightedCode = memo(function HighlightedCode(t0: Props): React.ReactNode {
  const $ = _c(21);
  const {
    code,
    filePath,
    width,
    dim: t1
  } = t0;
  const dim = t1 === undefined ? false : t1;
  const ref = useRef<DOMElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(width || DEFAULT_WIDTH);
  const [theme] = useTheme();
  const settings = useSettings();
  const syntaxHighlightingDisabled = settings.syntaxHighlightingDisabled ?? false;
  let t2;
  bb0: {
    if (syntaxHighlightingDisabled) {
      t2 = null;
      break bb0;
    }
    let t3;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = expectColorFile();
      $[0] = t3;
    } else {
      t3 = $[0];
    }
    const ColorFile = t3;
    if (!ColorFile) {
      t2 = null;
      break bb0;
    }
    let t4;
    if ($[1] !== code || $[2] !== filePath) {
      t4 = new ColorFile(code, filePath);
      $[1] = code;
      $[2] = filePath;
      $[3] = t4;
    } else {
      t4 = $[3];
    }
    t2 = t4;
  }
  const colorFile = t2;
  let t3;
  let t4;
  if ($[4] !== width) {
    t3 = () => {
      if (!width && ref.current) {
        const {
          width: elementWidth
        } = measureElement(ref.current);
        if (elementWidth > 0) {
          setMeasuredWidth(elementWidth - 2);
        }
      }
    };
    t4 = [width];
    $[4] = width;
    $[5] = t3;
    $[6] = t4;
  } else {
    t3 = $[5];
    t4 = $[6];
  }
  useEffect(t3, t4);
  let t5;
  bb1: {
    if (colorFile === null) {
      t5 = null;
      break bb1;
    }
    let t6;
    if ($[7] !== colorFile || $[8] !== dim || $[9] !== measuredWidth || $[10] !== theme) {
      t6 = colorFile.render(theme, measuredWidth, dim);
      $[7] = colorFile;
      $[8] = dim;
      $[9] = measuredWidth;
      $[10] = theme;
      $[11] = t6;
    } else {
      t6 = $[11];
    }
    t5 = t6;
  }
  const lines = t5;
  let t6;
  bb2: {
    if (!isFullscreenEnvEnabled()) {
      t6 = 0;
      break bb2;
    }
    const lineCount = countCharInString(code, "\n") + 1;
    let t7;
    if ($[12] !== lineCount) {
      t7 = lineCount.toString();
      $[12] = lineCount;
      $[13] = t7;
    } else {
      t7 = $[13];
    }
    t6 = t7.length + 2;
  }
  const gutterWidth = t6;
  let t7;
  if ($[14] !== code || $[15] !== dim || $[16] !== filePath || $[17] !== gutterWidth || $[18] !== lines || $[19] !== syntaxHighlightingDisabled) {
    t7 = <Box ref={ref}>{lines ? <Box flexDirection="column">{lines.map((line, i) => gutterWidth > 0 ? <CodeLine key={i} line={line} gutterWidth={gutterWidth} /> : <Text key={i}><Ansi>{line}</Ansi></Text>)}</Box> : <HighlightedCodeFallback code={code} filePath={filePath} dim={dim} skipColoring={syntaxHighlightingDisabled} />}</Box>;
    $[14] = code;
    $[15] = dim;
    $[16] = filePath;
    $[17] = gutterWidth;
    $[18] = lines;
    $[19] = syntaxHighlightingDisabled;
    $[20] = t7;
  } else {
    t7 = $[20];
  }
  return t7;
});
function CodeLine(t0: {
  line: string;
  gutterWidth: number;
}): React.ReactNode {
  const $ = _c(13);
  const {
    line,
    gutterWidth
  } = t0;
  let t1;
  if ($[0] !== gutterWidth || $[1] !== line) {
    t1 = sliceAnsi(line, 0, gutterWidth);
    $[0] = gutterWidth;
    $[1] = line;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const gutter = t1;
  let t2;
  if ($[3] !== gutterWidth || $[4] !== line) {
    t2 = sliceAnsi(line, gutterWidth);
    $[3] = gutterWidth;
    $[4] = line;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const content = t2;
  let t3;
  if ($[6] !== gutter) {
    t3 = <NoSelect fromLeftEdge={true}><Text><Ansi>{gutter}</Ansi></Text></NoSelect>;
    $[6] = gutter;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  let t4;
  if ($[8] !== content) {
    t4 = <Text><Ansi>{content}</Ansi></Text>;
    $[8] = content;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  let t5;
  if ($[10] !== t3 || $[11] !== t4) {
    t5 = <Box flexDirection="row">{t3}{t4}</Box>;
    $[10] = t3;
    $[11] = t4;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  return t5;
}
