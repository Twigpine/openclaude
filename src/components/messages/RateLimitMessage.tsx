import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useState } from 'react';
import { extraUsage } from 'src/commands/extra-usage/index.js';
import { Box, Text } from 'src/ink.js';
import { useClaudeAiLimits } from 'src/services/claudeAiLimitsHook.js';
import { shouldProcessMockLimits } from 'src/services/rateLimitMocking.js'; // Used for /mock-limits command
import { getRateLimitTier, getSubscriptionType, isClaudeAISubscriber } from 'src/utils/auth.js';
import { hasClaudeAiBillingAccess } from 'src/utils/billing.js';
import { MessageResponse } from '../MessageResponse.js';
type UpsellParams = {
  shouldShowUpsell: boolean;
  isMax20x: boolean;
  isExtraUsageCommandEnabled: boolean;
  shouldAutoOpenRateLimitOptionsMenu: boolean;
  isTeamOrEnterprise: boolean;
  hasBillingAccess: boolean;
};
export function getUpsellMessage({
  shouldShowUpsell,
  isMax20x,
  isExtraUsageCommandEnabled,
  shouldAutoOpenRateLimitOptionsMenu,
  isTeamOrEnterprise,
  hasBillingAccess
}: UpsellParams): string | null {
  if (!shouldShowUpsell) return null;
  if (isMax20x) {
    if (isExtraUsageCommandEnabled) {
      return '/extra-usage to finish what you\u2019re working on.';
    }
    return '/login to switch to an API usage-billed account.';
  }
  if (shouldAutoOpenRateLimitOptionsMenu) {
    return 'Opening your options\u2026';
  }
  if (!isTeamOrEnterprise && !isExtraUsageCommandEnabled) {
    return '/upgrade to increase your usage limit.';
  }
  if (isTeamOrEnterprise) {
    if (!isExtraUsageCommandEnabled) return null;
    if (hasBillingAccess) {
      return '/extra-usage to finish what you\u2019re working on.';
    }
    return '/extra-usage to request more usage from your admin.';
  }
  return '/upgrade or /extra-usage to finish what you\u2019re working on.';
}
type RateLimitMessageProps = {
  text: string;
  onOpenRateLimitOptions?: () => void;
};
export function RateLimitMessage(t0) {
  const $ = _c(16);
  const {
    text,
    onOpenRateLimitOptions
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getSubscriptionType();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const subscriptionType = t1;
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = getRateLimitTier();
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const rateLimitTier = t2;
  const isTeamOrEnterprise = subscriptionType === "team" || subscriptionType === "enterprise";
  const isMax20x = rateLimitTier === "default_claude_max_20x";
  let t3;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = shouldProcessMockLimits() || isClaudeAISubscriber();
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  const shouldShowUpsell = t3;
  const canSeeRateLimitOptionsUpsell = shouldShowUpsell && !isMax20x;
  const [hasOpenedInteractiveMenu, setHasOpenedInteractiveMenu] = useState(false);
  const claudeAiLimits = useClaudeAiLimits();
  const isCurrentlyRateLimited = claudeAiLimits.status === "rejected" && claudeAiLimits.resetsAt !== undefined && !claudeAiLimits.isUsingOverage;
  const shouldAutoOpenRateLimitOptionsMenu = canSeeRateLimitOptionsUpsell && !hasOpenedInteractiveMenu && isCurrentlyRateLimited && onOpenRateLimitOptions;
  let t4;
  let t5;
  if ($[3] !== onOpenRateLimitOptions || $[4] !== shouldAutoOpenRateLimitOptionsMenu) {
    t4 = () => {
      if (shouldAutoOpenRateLimitOptionsMenu) {
        setHasOpenedInteractiveMenu(true);
        onOpenRateLimitOptions();
      }
    };
    t5 = [shouldAutoOpenRateLimitOptionsMenu, onOpenRateLimitOptions];
    $[3] = onOpenRateLimitOptions;
    $[4] = shouldAutoOpenRateLimitOptionsMenu;
    $[5] = t4;
    $[6] = t5;
  } else {
    t4 = $[5];
    t5 = $[6];
  }
  useEffect(t4, t5);
  let t6;
  bb0: {
    let t7;
    if ($[7] !== shouldAutoOpenRateLimitOptionsMenu) {
      t7 = getUpsellMessage({
        shouldShowUpsell,
        isMax20x,
        isExtraUsageCommandEnabled: extraUsage.isEnabled(),
        shouldAutoOpenRateLimitOptionsMenu: !!shouldAutoOpenRateLimitOptionsMenu,
        isTeamOrEnterprise,
        hasBillingAccess: hasClaudeAiBillingAccess()
      });
      $[7] = shouldAutoOpenRateLimitOptionsMenu;
      $[8] = t7;
    } else {
      t7 = $[8];
    }
    const message = t7;
    if (!message) {
      t6 = null;
      break bb0;
    }
    let t8;
    if ($[9] !== message) {
      t8 = <Text dimColor={true}>{message}</Text>;
      $[9] = message;
      $[10] = t8;
    } else {
      t8 = $[10];
    }
    t6 = t8;
  }
  const upsell = t6;
  let t7;
  if ($[11] !== text) {
    t7 = <Text color="error">{text}</Text>;
    $[11] = text;
    $[12] = t7;
  } else {
    t7 = $[12];
  }
  const t8 = hasOpenedInteractiveMenu ? null : upsell;
  let t9;
  if ($[13] !== t7 || $[14] !== t8) {
    t9 = <MessageResponse><Box flexDirection="column">{t7}{t8}</Box></MessageResponse>;
    $[13] = t7;
    $[14] = t8;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  return t9;
}
