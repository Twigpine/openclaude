import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import { extname } from 'path';
import React, { Suspense, use } from 'react';
import { Ansi, Text } from '../../ink.js';
import { getCliHighlightPromise } from '../../utils/cliHighlight.js';
import { logForDebugging } from '../../utils/debug.js';
import { convertLeadingTabsToSpaces } from '../../utils/file.js';
import { hashPair } from '../../utils/hash.js';
type Props = {
  code: string;
  filePath: string;
  dim?: boolean;
  skipColoring?: boolean;
};

// Module-level highlight cache — hl.highlight() is the hot cost on virtual-
// scroll remounts. useMemo doesn't survive unmount→remount. Keyed by hash
// of code+language and Chalk level to avoid retaining full source strings (#24180 RSS fix).
const HL_CACHE_MAX = 500;
const hlCache = new Map<string, string>();
function cachedHighlight(hl: NonNullable<Awaited<ReturnType<typeof getCliHighlightPromise>>>, code: string, language: string): string {
  const key = `${chalk.level}:${hashPair(language, code)}`;
  const hit = hlCache.get(key);
  if (hit !== undefined) {
    hlCache.delete(key);
    hlCache.set(key, hit);
    return hit;
  }
  const out = hl.highlight(code, {
    language
  });
  if (hlCache.size >= HL_CACHE_MAX) {
    const first = hlCache.keys().next().value;
    if (first !== undefined) hlCache.delete(first);
  }
  hlCache.set(key, out);
  return out;
}
export function HighlightedCodeFallback(t0: Props): React.ReactNode {
  const $ = _c(20);
  const {
    code,
    filePath,
    dim: t1,
    skipColoring: t2
  } = t0;
  const dim = t1 === undefined ? false : t1;
  const skipColoring = t2 === undefined ? false : t2;
  let t3;
  if ($[0] !== code) {
    t3 = convertLeadingTabsToSpaces(code);
    $[0] = code;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  const codeWithSpaces = t3;
  if (skipColoring) {
    let t4;
    if ($[2] !== codeWithSpaces) {
      t4 = <Ansi>{codeWithSpaces}</Ansi>;
      $[2] = codeWithSpaces;
      $[3] = t4;
    } else {
      t4 = $[3];
    }
    let t5;
    if ($[4] !== dim || $[5] !== t4) {
      t5 = <Text dimColor={dim}>{t4}</Text>;
      $[4] = dim;
      $[5] = t4;
      $[6] = t5;
    } else {
      t5 = $[6];
    }
    return t5;
  }
  let t4;
  if ($[7] !== filePath) {
    t4 = extname(filePath).slice(1);
    $[7] = filePath;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const language = t4;
  let t5;
  if ($[9] !== codeWithSpaces) {
    t5 = <Ansi>{codeWithSpaces}</Ansi>;
    $[9] = codeWithSpaces;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  let t6;
  if ($[11] !== codeWithSpaces || $[12] !== language) {
    t6 = <Highlighted codeWithSpaces={codeWithSpaces} language={language} />;
    $[11] = codeWithSpaces;
    $[12] = language;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  let t7;
  if ($[14] !== t5 || $[15] !== t6) {
    t7 = <Suspense fallback={t5}>{t6}</Suspense>;
    $[14] = t5;
    $[15] = t6;
    $[16] = t7;
  } else {
    t7 = $[16];
  }
  let t8;
  if ($[17] !== dim || $[18] !== t7) {
    t8 = <Text dimColor={dim}>{t7}</Text>;
    $[17] = dim;
    $[18] = t7;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  return t8;
}
function Highlighted(t0: {
  codeWithSpaces: string;
  language: string;
}): React.ReactNode {
  const $ = _c(10);
  const {
    codeWithSpaces,
    language
  } = t0;
  let t1: ReturnType<typeof getCliHighlightPromise>;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getCliHighlightPromise();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const hl = use(t1);
  let t2;
  if ($[1] !== codeWithSpaces || $[2] !== hl || $[3] !== language) {
    bb0: {
      if (!hl) {
        t2 = codeWithSpaces;
        break bb0;
      }
      let highlightLang = "markdown";
      if (language) {
        if (hl.supportsLanguage(language)) {
          highlightLang = language;
        } else {
          logForDebugging(`Language not supported while highlighting code, falling back to markdown: ${language}`);
        }
      }
      ;
      try {
        t2 = cachedHighlight(hl, codeWithSpaces, highlightLang);
      } catch (t3) {
        const e = t3;
        if (e instanceof Error && e.message.includes("Unknown language")) {
          logForDebugging(`Language not supported while highlighting code, falling back to markdown: ${e}`);
          let t4;
          if ($[5] !== codeWithSpaces || $[6] !== hl) {
            t4 = cachedHighlight(hl, codeWithSpaces, "markdown");
            $[5] = codeWithSpaces;
            $[6] = hl;
            $[7] = t4;
          } else {
            t4 = $[7];
          }
          t2 = t4;
          break bb0;
        }
        t2 = codeWithSpaces;
      }
    }
    $[1] = codeWithSpaces;
    $[2] = hl;
    $[3] = language;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const out = t2;
  let t3;
  if ($[8] !== out) {
    t3 = <Ansi>{out}</Ansi>;
    $[8] = out;
    $[9] = t3;
  } else {
    t3 = $[9];
  }
  return t3;
}
