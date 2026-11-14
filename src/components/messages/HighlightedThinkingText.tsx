import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useContext } from 'react';
import { useQueuedMessage } from '../../context/QueuedMessageContext.js';
import { Box, Text } from '../../ink.js';
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js';
import { findThinkingTriggerPositions, getRainbowColor, isUltrathinkKeywordArmed } from '../../utils/thinking.js';
import { MessageActionsSelectedContext } from '../messageActions.js';
type Props = {
  text: string;
  useBriefLayout?: boolean;
  timestamp?: string;
};
export function HighlightedThinkingText(t0) {
  const $ = _c(31);
  const {
    text,
    useBriefLayout,
    timestamp
  } = t0;
  const isQueued = useQueuedMessage()?.isQueued ?? false;
  const isSelected = useContext(MessageActionsSelectedContext);
  const pointerColor = isSelected ? "suggestion" : "subtle";
  if (useBriefLayout) {
    let t1;
    if ($[0] !== timestamp) {
      t1 = timestamp ? formatBriefTimestamp(timestamp) : "";
      $[0] = timestamp;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    const ts = t1;
    const t2 = isQueued ? "subtle" : "briefLabelYou";
    let t3;
    if ($[2] !== t2) {
      t3 = <Text color={t2}>You</Text>;
      $[2] = t2;
      $[3] = t3;
    } else {
      t3 = $[3];
    }
    let t4;
    if ($[4] !== ts) {
      t4 = ts ? <Text dimColor={true}> {ts}</Text> : null;
      $[4] = ts;
      $[5] = t4;
    } else {
      t4 = $[5];
    }
    let t5;
    if ($[6] !== t3 || $[7] !== t4) {
      t5 = <Box flexDirection="row">{t3}{t4}</Box>;
      $[6] = t3;
      $[7] = t4;
      $[8] = t5;
    } else {
      t5 = $[8];
    }
    const t6 = isQueued ? "subtle" : "text";
    let t7;
    if ($[9] !== t6 || $[10] !== text) {
      t7 = <Text color={t6}>{text}</Text>;
      $[9] = t6;
      $[10] = text;
      $[11] = t7;
    } else {
      t7 = $[11];
    }
    let t8;
    if ($[12] !== t5 || $[13] !== t7) {
      t8 = <Box flexDirection="column" paddingLeft={2}>{t5}{t7}</Box>;
      $[12] = t5;
      $[13] = t7;
      $[14] = t8;
    } else {
      t8 = $[14];
    }
    return t8;
  }
  let parts;
  let t1;
  if ($[15] !== pointerColor || $[16] !== text) {
    t1 = Symbol.for("react.early_return_sentinel");
    bb0: {
      const triggers = isUltrathinkKeywordArmed() ? findThinkingTriggerPositions(text) : [];
      if (triggers.length === 0) {
        let t2;
        if ($[19] !== pointerColor) {
          t2 = <Text color={pointerColor}>{figures.pointer} </Text>;
          $[19] = pointerColor;
          $[20] = t2;
        } else {
          t2 = $[20];
        }
        let t3;
        if ($[21] !== text) {
          t3 = <Text color="text">{text}</Text>;
          $[21] = text;
          $[22] = t3;
        } else {
          t3 = $[22];
        }
        let t4;
        if ($[23] !== t2 || $[24] !== t3) {
          t4 = <Text>{t2}{t3}</Text>;
          $[23] = t2;
          $[24] = t3;
          $[25] = t4;
        } else {
          t4 = $[25];
        }
        t1 = t4;
        break bb0;
      }
      parts = [];
      let cursor = 0;
      for (const t of triggers) {
        if (t.start > cursor) {
          parts.push(<Text key={`plain-${cursor}`} color="text">{text.slice(cursor, t.start)}</Text>);
        }
        for (let i = t.start; i < t.end; i++) {
          parts.push(<Text key={`rb-${i}`} color={getRainbowColor(i - t.start)}>{text[i]}</Text>);
        }
        cursor = t.end;
      }
      if (cursor < text.length) {
        parts.push(<Text key={`plain-${cursor}`} color="text">{text.slice(cursor)}</Text>);
      }
    }
    $[15] = pointerColor;
    $[16] = text;
    $[17] = parts;
    $[18] = t1;
  } else {
    parts = $[17];
    t1 = $[18];
  }
  if (t1 !== Symbol.for("react.early_return_sentinel")) {
    return t1;
  }
  let t2;
  if ($[26] !== pointerColor) {
    t2 = <Text color={pointerColor}>{figures.pointer} </Text>;
    $[26] = pointerColor;
    $[27] = t2;
  } else {
    t2 = $[27];
  }
  let t3;
  if ($[28] !== parts || $[29] !== t2) {
    t3 = <Text>{t2}{parts}</Text>;
    $[28] = parts;
    $[29] = t2;
    $[30] = t3;
  } else {
    t3 = $[30];
  }
  return t3;
}
