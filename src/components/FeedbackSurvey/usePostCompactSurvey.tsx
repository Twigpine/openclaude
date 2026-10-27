import { c as _c } from "react-compiler-runtime";
import { useEffect, useRef, useState } from 'react';
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js';
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { shouldUseSessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js';
import type { Message } from '../../types/message.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isCompactBoundaryMessage } from '../../utils/messages.js';
import { useSurveyState } from './useSurveyState.js';
import type { FeedbackSurveyResponse } from './utils.js';
const HIDE_THANKS_AFTER_MS = 3000;
const POST_COMPACT_SURVEY_GATE = 'tengu_post_compact_survey';
const SURVEY_PROBABILITY = 0.2; // Show survey 20% of the time after compaction

function hasMessageAfterBoundary(messages: Message[], boundaryUuid: string): boolean {
  const boundaryIndex = messages.findIndex(msg => msg.uuid === boundaryUuid);
  if (boundaryIndex === -1) {
    return false;
  }

  // Check if there's a user or assistant message after the boundary
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg && (msg.type === 'user' || msg.type === 'assistant')) {
      return true;
    }
  }
  return false;
}
export function usePostCompactSurvey(messages, isLoading, t0, t1) {
  const $ = _c(23);
  const hasActivePrompt = t0 === undefined ? false : t0;
  let t2;
  if ($[0] !== t1) {
    t2 = t1 === undefined ? {} : t1;
    $[0] = t1;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const {
    enabled: t3
  } = t2;
  const enabled = t3 === undefined ? true : t3;
  const [gateEnabled, setGateEnabled] = useState<boolean | null>(null);
  let t4;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = new Set();
    $[2] = t4;
  } else {
    t4 = $[2];
  }
  const seenCompactBoundaries = useRef(t4);
  const pendingCompactBoundaryUuid = useRef<string | null>(null);
  const onOpen = _temp;
  const onSelect = _temp2;
  let t5;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      hideThanksAfterMs: HIDE_THANKS_AFTER_MS,
      onOpen,
      onSelect
    };
    $[3] = t5;
  } else {
    t5 = $[3];
  }
  const {
    state,
    lastResponse,
    open,
    handleSelect
  } = useSurveyState(t5);
  let t6;
  let t7;
  if ($[4] !== enabled) {
    t6 = () => {
      if (!enabled) {
        return;
      }
      setGateEnabled(checkStatsigFeatureGate_CACHED_MAY_BE_STALE(POST_COMPACT_SURVEY_GATE));
    };
    t7 = [enabled];
    $[4] = enabled;
    $[5] = t6;
    $[6] = t7;
  } else {
    t6 = $[5];
    t7 = $[6];
  }
  useEffect(t6, t7);
  let t8;
  if ($[7] !== messages) {
    t8 = new Set<string>(messages.filter(_temp3).map(_temp4));
    $[7] = messages;
    $[8] = t8;
  } else {
    t8 = $[8];
  }
  const currentCompactBoundaries: Set<string> = t8;
  let t10;
  let t9;
  if ($[9] !== currentCompactBoundaries || $[10] !== enabled || $[11] !== gateEnabled || $[12] !== hasActivePrompt || $[13] !== isLoading || $[14] !== messages || $[15] !== open || $[16] !== state) {
    t9 = () => {
      if (!enabled) {
        return;
      }
      if (state !== "closed" || isLoading) {
        return;
      }
      if (hasActivePrompt) {
        return;
      }
      if (gateEnabled !== true) {
        return;
      }
      if (isFeedbackSurveyDisabled()) {
        return;
      }
      if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)) {
        return;
      }
      if (pendingCompactBoundaryUuid.current !== null) {
        if (hasMessageAfterBoundary(messages, pendingCompactBoundaryUuid.current)) {
          pendingCompactBoundaryUuid.current = null;
          if (Math.random() < SURVEY_PROBABILITY) {
            open();
          }
          return;
        }
      }
      const newBoundaries = Array.from(currentCompactBoundaries).filter(uuid => !seenCompactBoundaries.current.has(uuid));
      if (newBoundaries.length > 0) {
        seenCompactBoundaries.current = new Set(currentCompactBoundaries);
        pendingCompactBoundaryUuid.current = newBoundaries[newBoundaries.length - 1];
      }
    };
    t10 = [enabled, currentCompactBoundaries, state, isLoading, hasActivePrompt, gateEnabled, messages, open];
    $[9] = currentCompactBoundaries;
    $[10] = enabled;
    $[11] = gateEnabled;
    $[12] = hasActivePrompt;
    $[13] = isLoading;
    $[14] = messages;
    $[15] = open;
    $[16] = state;
    $[17] = t10;
    $[18] = t9;
  } else {
    t10 = $[17];
    t9 = $[18];
  }
  useEffect(t9, t10);
  let t11;
  if ($[19] !== handleSelect || $[20] !== lastResponse || $[21] !== state) {
    t11 = {
      state,
      lastResponse,
      handleSelect
    };
    $[19] = handleSelect;
    $[20] = lastResponse;
    $[21] = state;
    $[22] = t11;
  } else {
    t11 = $[22];
  }
  return t11;
}
function _temp4(msg_0) {
  return msg_0.uuid;
}
function _temp3(msg) {
  return isCompactBoundaryMessage(msg);
}
function _temp2(appearanceId_0, selected) {
  const smCompactionEnabled_0 = shouldUseSessionMemoryCompaction();
  logEvent("tengu_post_compact_survey_event", {
    event_type: "responded" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id: appearanceId_0 as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    response: selected as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    session_memory_compaction_enabled: smCompactionEnabled_0 as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  }
function _temp(appearanceId) {
  const smCompactionEnabled = shouldUseSessionMemoryCompaction();
  logEvent("tengu_post_compact_survey_event", {
    event_type: "appeared" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    session_memory_compaction_enabled: smCompactionEnabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  }
