import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { stringWidth } from '../../../ink/stringWidth.js';
import { Box, Text } from '../../../ink.js';
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { truncateToWidth } from '../../../utils/format.js';
type Props = {
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  hideSubmitTab?: boolean;
};
export function QuestionNavigationBar(t0) {
  const $ = _c(39);
  const {
    questions,
    currentQuestionIndex,
    answers,
    hideSubmitTab: t1
  } = t0;
  const hideSubmitTab = t1 === undefined ? false : t1;
  const {
    columns
  } = useTerminalSize();
  let t2;
  if ($[0] !== columns || $[1] !== currentQuestionIndex || $[2] !== hideSubmitTab || $[3] !== questions) {
    bb0: {
      const submitText = hideSubmitTab ? "" : ` ${figures.tick} Submit `;
      const fixedWidth = stringWidth("\u2190 ") + stringWidth(" \u2192") + stringWidth(submitText);
      const availableForTabs = columns - fixedWidth;
      if (availableForTabs <= 0) {
        let t3;
        if ($[5] !== currentQuestionIndex || $[6] !== questions) {
          let t4;
          if ($[8] !== currentQuestionIndex) {
            t4 = (q, index) => {
              const header = q?.header || `Q${index + 1}`;
              return index === currentQuestionIndex ? header.slice(0, 3) : "";
            };
            $[8] = currentQuestionIndex;
            $[9] = t4;
          } else {
            t4 = $[9];
          }
          t3 = questions.map(t4);
          $[5] = currentQuestionIndex;
          $[6] = questions;
          $[7] = t3;
        } else {
          t3 = $[7];
        }
        t2 = t3;
        break bb0;
      }
      const tabHeaders = questions.map(_temp);
      const idealWidths = tabHeaders.map(_temp2);
      const totalIdealWidth = idealWidths.reduce(_temp3, 0);
      if (totalIdealWidth <= availableForTabs) {
        t2 = tabHeaders;
        break bb0;
      }
      const currentHeader = tabHeaders[currentQuestionIndex] || "";
      const currentIdealWidth = 4 + stringWidth(currentHeader);
      const currentTabWidth = Math.min(currentIdealWidth, availableForTabs / 2);
      const remainingWidth = availableForTabs - currentTabWidth;
      const otherTabCount = questions.length - 1;
      const widthPerOtherTab = Math.max(6, Math.floor(remainingWidth / Math.max(otherTabCount, 1)));
      let t3;
      if ($[10] !== currentQuestionIndex || $[11] !== currentTabWidth || $[12] !== widthPerOtherTab) {
        t3 = (header_1, index_1) => {
          if (index_1 === currentQuestionIndex) {
            const maxTextWidth = currentTabWidth - 2 - 2;
            return truncateToWidth(header_1, maxTextWidth);
          } else {
            const maxTextWidth_0 = widthPerOtherTab - 2 - 2;
            return truncateToWidth(header_1, maxTextWidth_0);
          }
        };
        $[10] = currentQuestionIndex;
        $[11] = currentTabWidth;
        $[12] = widthPerOtherTab;
        $[13] = t3;
      } else {
        t3 = $[13];
      }
      t2 = tabHeaders.map(t3);
    }
    $[0] = columns;
    $[1] = currentQuestionIndex;
    $[2] = hideSubmitTab;
    $[3] = questions;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const tabDisplayTexts = t2;
  const hideArrows = questions.length === 1 && hideSubmitTab;
  let t3;
  if ($[14] !== currentQuestionIndex || $[15] !== hideArrows) {
    t3 = !hideArrows && <Text color={currentQuestionIndex === 0 ? "inactive" : undefined}>←{" "}</Text>;
    $[14] = currentQuestionIndex;
    $[15] = hideArrows;
    $[16] = t3;
  } else {
    t3 = $[16];
  }
  let t4;
  if ($[17] !== answers || $[18] !== currentQuestionIndex || $[19] !== questions || $[20] !== tabDisplayTexts) {
    let t5;
    if ($[22] !== answers || $[23] !== currentQuestionIndex || $[24] !== tabDisplayTexts) {
      t5 = (q_1, index_2) => {
        const isSelected = index_2 === currentQuestionIndex;
        const isAnswered = q_1?.question && !!answers[q_1.question];
        const checkbox = isAnswered ? figures.checkboxOn : figures.checkboxOff;
        const displayText = tabDisplayTexts[index_2] || q_1?.header || `Q${index_2 + 1}`;
        return <Box key={q_1?.question || `question-${index_2}`}>{isSelected ? <Text backgroundColor="permission" color="inverseText">{" "}{checkbox} {displayText}{" "}</Text> : <Text>{" "}{checkbox} {displayText}{" "}</Text>}</Box>;
      };
      $[22] = answers;
      $[23] = currentQuestionIndex;
      $[24] = tabDisplayTexts;
      $[25] = t5;
    } else {
      t5 = $[25];
    }
    t4 = questions.map(t5);
    $[17] = answers;
    $[18] = currentQuestionIndex;
    $[19] = questions;
    $[20] = tabDisplayTexts;
    $[21] = t4;
  } else {
    t4 = $[21];
  }
  let t5;
  if ($[26] !== currentQuestionIndex || $[27] !== hideSubmitTab || $[28] !== questions.length) {
    t5 = !hideSubmitTab && <Box key="submit">{currentQuestionIndex === questions.length ? <Text backgroundColor="permission" color="inverseText">{" "}{figures.tick} Submit{" "}</Text> : <Text> {figures.tick} Submit </Text>}</Box>;
    $[26] = currentQuestionIndex;
    $[27] = hideSubmitTab;
    $[28] = questions.length;
    $[29] = t5;
  } else {
    t5 = $[29];
  }
  let t6;
  if ($[30] !== currentQuestionIndex || $[31] !== hideArrows || $[32] !== questions.length) {
    t6 = !hideArrows && <Text color={currentQuestionIndex === questions.length ? "inactive" : undefined}>{" "}→</Text>;
    $[30] = currentQuestionIndex;
    $[31] = hideArrows;
    $[32] = questions.length;
    $[33] = t6;
  } else {
    t6 = $[33];
  }
  let t7;
  if ($[34] !== t3 || $[35] !== t4 || $[36] !== t5 || $[37] !== t6) {
    t7 = <Box flexDirection="row" marginBottom={1}>{t3}{t4}{t5}{t6}</Box>;
    $[34] = t3;
    $[35] = t4;
    $[36] = t5;
    $[37] = t6;
    $[38] = t7;
  } else {
    t7 = $[38];
  }
  return t7;
}
function _temp3(sum, w) {
  return sum + w;
}
function _temp2(header_0) {
  return 4 + stringWidth(header_0);
}
function _temp(q_0, index_0) {
  return q_0?.header || `Q${index_0 + 1}`;
}
