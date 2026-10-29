import { c as _c } from "react-compiler-runtime";
import type { Base64ImageSource, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import React, { Suspense, use, useRef, useState } from 'react';
import { useSettings } from '../../../hooks/useSettings.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { stringWidth } from '../../../ink/stringWidth.js';
import { useTheme } from '../../../ink.js';
import { useKeybindings } from '../../../keybindings/useKeybinding.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../../services/analytics/index.js';
import { useAppState } from '../../../state/AppState.js';
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { AskUserQuestionTool } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js';
import type { PastedContent } from '../../../utils/config.js';
import type { ImageDimensions } from '../../../utils/imageResizer.js';
import { maybeResizeAndDownsampleImageBlock } from '../../../utils/imageResizer.js';
import { cacheImagePath, storeImage } from '../../../utils/imageStore.js';
import { logError } from '../../../utils/log.js';
import { applyMarkdown } from '../../../utils/markdown.js';
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js';
import { getPlanFilePath } from '../../../utils/plans.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { QuestionView } from './QuestionView.js';
import { SubmitQuestionsView } from './SubmitQuestionsView.js';
import { useMultipleChoiceState } from './use-multiple-choice-state.js';
const MIN_CONTENT_HEIGHT = 12;
const MIN_CONTENT_WIDTH = 40;
// Lines used by chrome around the content area (nav bar, title, footer, help text, etc.)
const CONTENT_CHROME_OVERHEAD = 15;
export function AskUserQuestionPermissionRequest(props) {
  const $ = _c(4);
  const settings = useSettings();
  if (settings.syntaxHighlightingDisabled) {
    let t0;
    if ($[0] !== props) {
      t0 = <AskUserQuestionPermissionRequestBody {...props} highlight={null} />;
      $[0] = props;
      $[1] = t0;
    } else {
      t0 = $[1];
    }
    return t0;
  }
  let t0;
  if ($[2] !== props) {
    t0 = <Suspense fallback={<AskUserQuestionPermissionRequestBody {...props} highlight={null} />}><AskUserQuestionWithHighlight {...props} /></Suspense>;
    $[2] = props;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  return t0;
}
function AskUserQuestionWithHighlight(props) {
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
    t1 = <AskUserQuestionPermissionRequestBody {...props} highlight={highlight} />;
    $[1] = highlight;
    $[2] = props;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  return t1;
}
function AskUserQuestionPermissionRequestBody(t0) {
  const $ = _c(115);
  const {
    toolUseConfirm,
    onDone,
    onReject,
    highlight
  } = t0;
  let t1;
  if ($[0] !== toolUseConfirm.input) {
    t1 = AskUserQuestionTool.inputSchema.safeParse(toolUseConfirm.input);
    $[0] = toolUseConfirm.input;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const result = t1;
  let t2;
  if ($[2] !== result.data || $[3] !== result.success) {
    t2 = result.success ? result.data.questions || [] : [];
    $[2] = result.data;
    $[3] = result.success;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const questions = t2;
  const {
    rows: terminalRows
  } = useTerminalSize();
  const [theme] = useTheme();
  let maxHeight = 0;
  let maxWidth = 0;
  const maxAllowedHeight = Math.max(MIN_CONTENT_HEIGHT, terminalRows - CONTENT_CHROME_OVERHEAD);
  if ($[5] !== highlight || $[6] !== maxAllowedHeight || $[7] !== maxHeight || $[8] !== maxWidth || $[9] !== questions || $[10] !== theme) {
    for (const q of questions) {
      const hasPreview = q.options.some(_temp);
      if (hasPreview) {
        const maxPreviewContentLines = Math.max(1, maxAllowedHeight - 11);
        let maxPreviewBoxHeight = 0;
        for (const opt_0 of q.options) {
          if (opt_0.preview) {
            const rendered = applyMarkdown(opt_0.preview, theme, highlight);
            const previewLines = rendered.split("\n");
            const isTruncated = previewLines.length > maxPreviewContentLines;
            const displayedLines = isTruncated ? maxPreviewContentLines : previewLines.length;
            maxPreviewBoxHeight = Math.max(maxPreviewBoxHeight, displayedLines + (isTruncated ? 1 : 0) + 2);
            for (const line of previewLines) {
              maxWidth = Math.max(maxWidth, stringWidth(line));
            }
          }
        }
        const rightPanelHeight = maxPreviewBoxHeight + 2;
        const leftPanelHeight = q.options.length + 2;
        const sideByHeight = Math.max(leftPanelHeight, rightPanelHeight);
        maxHeight = Math.max(maxHeight, sideByHeight + 7);
      } else {
        maxHeight = Math.max(maxHeight, q.options.length + 3 + 7);
      }
    }
    $[5] = highlight;
    $[6] = maxAllowedHeight;
    $[7] = maxHeight;
    $[8] = maxWidth;
    $[9] = questions;
    $[10] = theme;
    $[11] = maxHeight;
  } else {
    maxHeight = $[11];
  }
  const t3 = Math.min(Math.max(maxHeight, MIN_CONTENT_HEIGHT), maxAllowedHeight);
  const t4 = Math.max(maxWidth, MIN_CONTENT_WIDTH);
  let t5;
  if ($[12] !== t3 || $[13] !== t4) {
    t5 = {
      globalContentHeight: t3,
      globalContentWidth: t4
    };
    $[12] = t3;
    $[13] = t4;
    $[14] = t5;
  } else {
    t5 = $[14];
  }
  const {
    globalContentHeight,
    globalContentWidth
  } = t5;
  const metadataSource = result.success ? result.data.metadata?.source : undefined;
  let t6;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = {};
    $[15] = t6;
  } else {
    t6 = $[15];
  }
  const [pastedContentsByQuestion, setPastedContentsByQuestion] = useState(t6);
  const nextPasteIdRef = useRef(0);
  let t7;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = function onImagePaste(questionText, base64Image, mediaType, filename, dimensions, _sourcePath) {
      nextPasteIdRef.current = nextPasteIdRef.current + 1;
      const pasteId = nextPasteIdRef.current;
      const newContent: PastedContent = {
        id: pasteId,
        type: "image",
        content: base64Image,
        mediaType: mediaType || "image/png",
        filename: filename || "Pasted image",
        dimensions
      };
      cacheImagePath(newContent);
      storeImage(newContent);
      setPastedContentsByQuestion(prev => ({
        ...prev,
        [questionText]: {
          ...(prev[questionText] ?? {}),
          [pasteId]: newContent
        }
      }));
    };
    $[16] = t7;
  } else {
    t7 = $[16];
  }
  const onImagePaste = t7;
  let t8;
  if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = (questionText_0, id) => {
      setPastedContentsByQuestion(prev_0 => {
        const questionContents = {
          ...(prev_0[questionText_0] ?? {})
        };
        delete questionContents[id];
        return {
          ...prev_0,
          [questionText_0]: questionContents
        };
      });
    };
    $[17] = t8;
  } else {
    t8 = $[17];
  }
  const onRemoveImage = t8;
  let t9;
  if ($[18] !== pastedContentsByQuestion) {
    t9 = Object.values(pastedContentsByQuestion).flatMap(_temp2).filter(_temp3);
    $[18] = pastedContentsByQuestion;
    $[19] = t9;
  } else {
    t9 = $[19];
  }
  const allImageAttachments = t9;
  const toolPermissionContextMode = useAppState(_temp4);
  const isInPlanMode = toolPermissionContextMode === "plan";
  let t10;
  if ($[20] !== isInPlanMode) {
    t10 = isInPlanMode ? getPlanFilePath() : undefined;
    $[20] = isInPlanMode;
    $[21] = t10;
  } else {
    t10 = $[21];
  }
  const planFilePath = t10;
  const state = useMultipleChoiceState();
  const {
    currentQuestionIndex,
    answers,
    questionStates,
    isInTextInput,
    nextQuestion,
    prevQuestion,
    updateQuestionState,
    setAnswer,
    setTextInputMode
  } = state;
  const currentQuestion = currentQuestionIndex < (questions?.length || 0) ? questions?.[currentQuestionIndex] : null;
  const isInSubmitView = currentQuestionIndex === (questions?.length || 0);
  let t11;
  if ($[22] !== answers || $[23] !== questions) {
    t11 = questions?.every(q_0 => q_0?.question && !!answers[q_0.question]) ?? false;
    $[22] = answers;
    $[23] = questions;
    $[24] = t11;
  } else {
    t11 = $[24];
  }
  const allQuestionsAnswered = t11;
  const hideSubmitTab = questions.length === 1 && !questions[0]?.multiSelect;
  let t12;
  if ($[25] !== isInPlanMode || $[26] !== metadataSource || $[27] !== onDone || $[28] !== onReject || $[29] !== questions.length || $[30] !== toolUseConfirm) {
    t12 = () => {
      if (metadataSource) {
        logEvent("tengu_ask_user_question_rejected", {
          source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          questionCount: questions.length,
          isInPlanMode,
          interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled()
        });
      }
      onDone();
      onReject();
      toolUseConfirm.onReject();
    };
    $[25] = isInPlanMode;
    $[26] = metadataSource;
    $[27] = onDone;
    $[28] = onReject;
    $[29] = questions.length;
    $[30] = toolUseConfirm;
    $[31] = t12;
  } else {
    t12 = $[31];
  }
  const handleCancel = t12;
  let t13;
  if ($[32] !== allImageAttachments || $[33] !== answers || $[34] !== isInPlanMode || $[35] !== metadataSource || $[36] !== onDone || $[37] !== questions || $[38] !== toolUseConfirm) {
    t13 = async () => {
      const questionsWithAnswers = questions.map(q_1 => {
        const answer = answers[q_1.question];
        if (answer) {
          return `- "${q_1.question}"\n  Answer: ${answer}`;
        }
        return `- "${q_1.question}"\n  (No answer provided)`;
      }).join("\n");
      const feedback = `The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.

    Questions asked:\n${questionsWithAnswers}`;
      if (metadataSource) {
        logEvent("tengu_ask_user_question_respond_to_claude", {
          source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          questionCount: questions.length,
          isInPlanMode,
          interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled()
        });
      }
      const imageBlocks = await convertImagesToBlocks(allImageAttachments);
      onDone();
      toolUseConfirm.onReject(feedback, imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined);
    };
    $[32] = allImageAttachments;
    $[33] = answers;
    $[34] = isInPlanMode;
    $[35] = metadataSource;
    $[36] = onDone;
    $[37] = questions;
    $[38] = toolUseConfirm;
    $[39] = t13;
  } else {
    t13 = $[39];
  }
  const handleRespondToClaude = t13;
  let t14;
  if ($[40] !== allImageAttachments || $[41] !== answers || $[42] !== isInPlanMode || $[43] !== metadataSource || $[44] !== onDone || $[45] !== questions || $[46] !== toolUseConfirm) {
    t14 = async () => {
      const questionsWithAnswers_0 = questions.map(q_2 => {
        const answer_0 = answers[q_2.question];
        if (answer_0) {
          return `- "${q_2.question}"\n  Answer: ${answer_0}`;
        }
        return `- "${q_2.question}"\n  (No answer provided)`;
      }).join("\n");
      const feedback_0 = `The user has indicated they have provided enough answers for the plan interview.
Stop asking clarifying questions and proceed to finish the plan with the information you have.

Questions asked and answers provided:\n${questionsWithAnswers_0}`;
      if (metadataSource) {
        logEvent("tengu_ask_user_question_finish_plan_interview", {
          source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          questionCount: questions.length,
          isInPlanMode,
          interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled()
        });
      }
      const imageBlocks_0 = await convertImagesToBlocks(allImageAttachments);
      onDone();
      toolUseConfirm.onReject(feedback_0, imageBlocks_0 && imageBlocks_0.length > 0 ? imageBlocks_0 : undefined);
    };
    $[40] = allImageAttachments;
    $[41] = answers;
    $[42] = isInPlanMode;
    $[43] = metadataSource;
    $[44] = onDone;
    $[45] = questions;
    $[46] = toolUseConfirm;
    $[47] = t14;
  } else {
    t14 = $[47];
  }
  const handleFinishPlanInterview = t14;
  let t15;
  if ($[48] !== allImageAttachments || $[49] !== isInPlanMode || $[50] !== metadataSource || $[51] !== onDone || $[52] !== questionStates || $[53] !== questions || $[54] !== toolUseConfirm) {
    t15 = async answersToSubmit => {
      if (metadataSource) {
        logEvent("tengu_ask_user_question_accepted", {
          source: metadataSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          questionCount: questions.length,
          answerCount: Object.keys(answersToSubmit).length,
          isInPlanMode,
          interviewPhaseEnabled: isInPlanMode && isPlanModeInterviewPhaseEnabled()
        });
      }
      const annotations = {};
      for (const q_3 of questions) {
        const answer_1 = answersToSubmit[q_3.question];
        const notes = questionStates[q_3.question]?.textInputValue;
        const selectedOption = answer_1 ? q_3.options.find(opt_1 => opt_1.label === answer_1) : undefined;
        const preview = selectedOption?.preview;
        if (preview || notes?.trim()) {
          annotations[q_3.question] = {
            ...(preview && {
              preview
            }),
            ...(notes?.trim() && {
              notes: notes.trim()
            })
          };
        }
      }
      const updatedInput = {
        ...toolUseConfirm.input,
        answers: answersToSubmit,
        ...(Object.keys(annotations).length > 0 && {
          annotations
        })
      };
      const contentBlocks = await convertImagesToBlocks(allImageAttachments);
      onDone();
      toolUseConfirm.onAllow(updatedInput, [], undefined, contentBlocks && contentBlocks.length > 0 ? contentBlocks : undefined);
    };
    $[48] = allImageAttachments;
    $[49] = isInPlanMode;
    $[50] = metadataSource;
    $[51] = onDone;
    $[52] = questionStates;
    $[53] = questions;
    $[54] = toolUseConfirm;
    $[55] = t15;
  } else {
    t15 = $[55];
  }
  const submitAnswers = t15;
  let t16;
  if ($[56] !== answers || $[57] !== pastedContentsByQuestion || $[58] !== questions.length || $[59] !== setAnswer || $[60] !== submitAnswers) {
    t16 = (questionText_1, label, textInput, t17) => {
      const shouldAdvance = t17 === undefined ? true : t17;
      let answer_2;
      const isMultiSelect = Array.isArray(label);
      if (isMultiSelect) {
        answer_2 = label.join(", ");
      } else {
        if (textInput) {
          const questionImages = Object.values(pastedContentsByQuestion[questionText_1] ?? {}).filter(_temp5);
          answer_2 = questionImages.length > 0 ? `${textInput} (Image attached)` : textInput;
        } else {
          if (label === "__other__") {
            const questionImages_0 = Object.values(pastedContentsByQuestion[questionText_1] ?? {}).filter(_temp6);
            answer_2 = questionImages_0.length > 0 ? "(Image attached)" : label;
          } else {
            answer_2 = label;
          }
        }
      }
      const isSingleQuestion = questions.length === 1;
      if (!isMultiSelect && isSingleQuestion && shouldAdvance) {
        const updatedAnswers = {
          ...answers,
          [questionText_1]: answer_2
        };
        submitAnswers(updatedAnswers).catch(logError);
        return;
      }
      setAnswer(questionText_1, answer_2, shouldAdvance);
    };
    $[56] = answers;
    $[57] = pastedContentsByQuestion;
    $[58] = questions.length;
    $[59] = setAnswer;
    $[60] = submitAnswers;
    $[61] = t16;
  } else {
    t16 = $[61];
  }
  const handleQuestionAnswer = t16;
  let t17;
  if ($[62] !== answers || $[63] !== handleCancel || $[64] !== submitAnswers) {
    t17 = function handleFinalResponse(value) {
      if (value === "cancel") {
        handleCancel();
        return;
      }
      if (value === "submit") {
        submitAnswers(answers).catch(logError);
      }
    };
    $[62] = answers;
    $[63] = handleCancel;
    $[64] = submitAnswers;
    $[65] = t17;
  } else {
    t17 = $[65];
  }
  const handleFinalResponse = t17;
  const maxIndex = hideSubmitTab ? (questions?.length || 1) - 1 : questions?.length || 0;
  let t18;
  if ($[66] !== currentQuestionIndex || $[67] !== prevQuestion) {
    t18 = () => {
      if (currentQuestionIndex > 0) {
        prevQuestion();
      }
    };
    $[66] = currentQuestionIndex;
    $[67] = prevQuestion;
    $[68] = t18;
  } else {
    t18 = $[68];
  }
  const handleTabPrev = t18;
  let t19;
  if ($[69] !== currentQuestionIndex || $[70] !== maxIndex || $[71] !== nextQuestion) {
    t19 = () => {
      if (currentQuestionIndex < maxIndex) {
        nextQuestion();
      }
    };
    $[69] = currentQuestionIndex;
    $[70] = maxIndex;
    $[71] = nextQuestion;
    $[72] = t19;
  } else {
    t19 = $[72];
  }
  const handleTabNext = t19;
  let t20;
  if ($[73] !== handleTabNext || $[74] !== handleTabPrev) {
    t20 = {
      "tabs:previous": handleTabPrev,
      "tabs:next": handleTabNext
    };
    $[73] = handleTabNext;
    $[74] = handleTabPrev;
    $[75] = t20;
  } else {
    t20 = $[75];
  }
  const t21 = !(isInTextInput && !isInSubmitView);
  let t22;
  if ($[76] !== t21) {
    t22 = {
      context: "Tabs",
      isActive: t21
    };
    $[76] = t21;
    $[77] = t22;
  } else {
    t22 = $[77];
  }
  useKeybindings(t20, t22);
  if (currentQuestion) {
    let t23;
    if ($[78] !== currentQuestion.question) {
      t23 = (base64, mediaType_0, filename_0, dims, path) => onImagePaste(currentQuestion.question, base64, mediaType_0, filename_0, dims, path);
      $[78] = currentQuestion.question;
      $[79] = t23;
    } else {
      t23 = $[79];
    }
    let t24;
    if ($[80] !== currentQuestion.question || $[81] !== pastedContentsByQuestion) {
      t24 = pastedContentsByQuestion[currentQuestion.question] ?? {};
      $[80] = currentQuestion.question;
      $[81] = pastedContentsByQuestion;
      $[82] = t24;
    } else {
      t24 = $[82];
    }
    let t25;
    if ($[83] !== currentQuestion.question) {
      t25 = id_0 => onRemoveImage(currentQuestion.question, id_0);
      $[83] = currentQuestion.question;
      $[84] = t25;
    } else {
      t25 = $[84];
    }
    let t26;
    if ($[85] !== answers || $[86] !== currentQuestion || $[87] !== currentQuestionIndex || $[88] !== globalContentHeight || $[89] !== globalContentWidth || $[90] !== handleCancel || $[91] !== handleFinishPlanInterview || $[92] !== handleQuestionAnswer || $[93] !== handleRespondToClaude || $[94] !== handleTabNext || $[95] !== handleTabPrev || $[96] !== hideSubmitTab || $[97] !== nextQuestion || $[98] !== planFilePath || $[99] !== questionStates || $[100] !== questions || $[101] !== setTextInputMode || $[102] !== t23 || $[103] !== t24 || $[104] !== t25 || $[105] !== updateQuestionState) {
      t26 = <><QuestionView question={currentQuestion} questions={questions} currentQuestionIndex={currentQuestionIndex} answers={answers} questionStates={questionStates} hideSubmitTab={hideSubmitTab} minContentHeight={globalContentHeight} minContentWidth={globalContentWidth} planFilePath={planFilePath} onUpdateQuestionState={updateQuestionState} onAnswer={handleQuestionAnswer} onTextInputFocus={setTextInputMode} onCancel={handleCancel} onSubmit={nextQuestion} onTabPrev={handleTabPrev} onTabNext={handleTabNext} onRespondToClaude={handleRespondToClaude} onFinishPlanInterview={handleFinishPlanInterview} onImagePaste={t23} pastedContents={t24} onRemoveImage={t25} /></>;
      $[85] = answers;
      $[86] = currentQuestion;
      $[87] = currentQuestionIndex;
      $[88] = globalContentHeight;
      $[89] = globalContentWidth;
      $[90] = handleCancel;
      $[91] = handleFinishPlanInterview;
      $[92] = handleQuestionAnswer;
      $[93] = handleRespondToClaude;
      $[94] = handleTabNext;
      $[95] = handleTabPrev;
      $[96] = hideSubmitTab;
      $[97] = nextQuestion;
      $[98] = planFilePath;
      $[99] = questionStates;
      $[100] = questions;
      $[101] = setTextInputMode;
      $[102] = t23;
      $[103] = t24;
      $[104] = t25;
      $[105] = updateQuestionState;
      $[106] = t26;
    } else {
      t26 = $[106];
    }
    return t26;
  }
  if (isInSubmitView) {
    let t23;
    if ($[107] !== allQuestionsAnswered || $[108] !== answers || $[109] !== currentQuestionIndex || $[110] !== globalContentHeight || $[111] !== handleFinalResponse || $[112] !== questions || $[113] !== toolUseConfirm.permissionResult) {
      t23 = <><SubmitQuestionsView questions={questions} currentQuestionIndex={currentQuestionIndex} answers={answers} allQuestionsAnswered={allQuestionsAnswered} permissionResult={toolUseConfirm.permissionResult} minContentHeight={globalContentHeight} onFinalResponse={handleFinalResponse} /></>;
      $[107] = allQuestionsAnswered;
      $[108] = answers;
      $[109] = currentQuestionIndex;
      $[110] = globalContentHeight;
      $[111] = handleFinalResponse;
      $[112] = questions;
      $[113] = toolUseConfirm.permissionResult;
      $[114] = t23;
    } else {
      t23 = $[114];
    }
    return t23;
  }
  return null;
}
function _temp6(c_1) {
  return c_1.type === "image";
}
function _temp5(c_0) {
  return c_0.type === "image";
}
function _temp4(s) {
  return s.toolPermissionContext.mode;
}
function _temp3(c) {
  return c.type === "image";
}
function _temp2(contents) {
  return Object.values(contents);
}
function _temp(opt) {
  return opt.preview;
}
async function convertImagesToBlocks(images: PastedContent[]): Promise<ImageBlockParam[] | undefined> {
  if (images.length === 0) return undefined;
  return Promise.all(images.map(async img => {
    const block: ImageBlockParam = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: (img.mediaType || 'image/png') as Base64ImageSource['media_type'],
        data: img.content
      }
    };
    const resized = await maybeResizeAndDownsampleImageBlock(block);
    return resized.block;
  }));
}
