import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getSponsoredTipsFrequency } from './sponsoredTips.js'
import {
  getSessionsSinceLastShown,
  getSessionsSinceLastSponsored,
  recordSponsoredTipShown,
  recordTipShown,
} from './tipHistory.js'
import { getRelevantTips } from './tipRegistry.js'
import { shouldShowEarningTip, buildEarningTip } from './gitlawbEarn.js'
import type { Tip, TipContext } from './types.js'

export function selectTipWithLongestTimeSinceShown(
  availableTips: Tip[],
): Tip | undefined {
  if (availableTips.length === 0) {
    return undefined
  }

  if (availableTips.length === 1) {
    return availableTips[0]
  }

  // Sort tips by sessions since last shown (descending) and take the first one
  // This is the tip that hasn't been shown for the longest time
  const tipsWithSessions = availableTips.map(tip => ({
    tip,
    sessions: getSessionsSinceLastShown(tip.id),
  }))

  tipsWithSessions.sort((a, b) => b.sessions - a.sessions)
  return tipsWithSessions[0]?.tip
}

/**
 * Decide whether this pick is eligible to show a sponsored tip.
 * Enforces a 1-in-N cap: a sponsored tip can only show if no sponsored tip
 * has been shown in the last N startups. Setting frequency to 0 disables.
 */
function isSponsoredSlotEligible(): boolean {
  const frequency = getSponsoredTipsFrequency()
  if (frequency === 0) return false
  return getSessionsSinceLastSponsored() >= frequency
}

export async function getTipToShowOnSpinner(
  context?: TipContext,
): Promise<Tip | undefined> {
  // Check if tips are disabled (default to true if not set)
  if (getSettings_DEPRECATED().spinnerTipsEnabled === false) {
    return undefined
  }

  // Opt-in earning users (`/ads on <code>`) see Twigpine sponsored tips on a
  // per-turn cadence, bypassing the per-startup sponsored gate — they opted in
  // to earn, so we surface (and credit) ads frequently rather than once a session.
  if (shouldShowEarningTip()) {
    return buildEarningTip()
  }

  const tips = await getRelevantTips(context)
  if (tips.length === 0) {
    return undefined
  }

  const sponsored = tips.filter(t => t.sponsor)
  const regular = tips.filter(t => !t.sponsor)

  // Sponsored slot first, gated by the 1-in-N cap. Falls back to regular
  // if no sponsored tip is currently eligible (e.g., cap not met, none relevant).
  if (sponsored.length > 0 && isSponsoredSlotEligible()) {
    const pick = selectTipWithLongestTimeSinceShown(sponsored)
    if (pick) return pick
  }

  return selectTipWithLongestTimeSinceShown(regular)
}

export function recordShownTip(tip: Tip): void {
  // Record in history
  recordTipShown(tip.id)
  if (tip.sponsor) {
    recordSponsoredTipShown()
  }

  // Log event for analytics
  logEvent('tengu_tip_shown', {
    tipIdLength:
      tip.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    cooldownSessions: tip.cooldownSessions,
  })
}
