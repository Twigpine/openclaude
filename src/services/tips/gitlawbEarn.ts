import { color } from '../../components/design-system/color.js'
import { getGlobalConfig } from '../../utils/config.js'
import { confirmTip, fetchNextTip } from '../ads.js'
import { renderSponsorLink } from './tipLink.js'
import type { Tip, TipContext, TipSponsor } from './types.js'

/**
 * Twigpine earning tips. Unlike the static partner sponsored tips (which show at
 * most once per session, gated by a per-startup counter), these target the
 * opt-in earning user who ran `/ads on <code>`: they appear on a per-TURN
 * cadence and credit opengateway credits each time one is shown.
 */
const TWIGPINE: TipSponsor = {
  name: 'Twigpine',
  url: 'https://twigpine.com',
  label: 'Sponsored',
}

// Show an earning ad on every Nth tip slot (per turn). Tunable so an earning
// user can dial it up (1 = every turn) or down. Frequent by default — they opted in.
const DEFAULT_TIP_EVERY = 2
const MAX_CONFIRM_DELAY_MS = 30_000

/** Earning is on only when the user ran `/ads on <code>` (enabled + a code). */
export function adsEarningEnabled(): boolean {
  const ads = getGlobalConfig().ads
  return Boolean(ads?.enabled && ads.earnCode)
}

function tipEvery(): number {
  const raw = Number(process.env.OPENCLAUDE_ADS_TIP_EVERY ?? DEFAULT_TIP_EVERY)
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : DEFAULT_TIP_EVERY
}

// Per-session pick counter (resets each process start).
let pickCounter = 0

/**
 * Whether this tip slot should be a Twigpine earning ad. Called once per turn by
 * getTipToShowOnSpinner; returns true on every Nth eligible call. Does NOT
 * increment (or do anything) when earning is off, so non-opted-in users and the
 * existing tip tests are unaffected.
 */
export function shouldShowEarningTip(): boolean {
  if (!adsEarningEnabled()) return false
  pickCounter += 1
  return pickCounter % tipEvery() === 0
}

/** Test seam: reset the per-session cadence counter. */
export function resetEarningCadenceForTesting(): void {
  pickCounter = 0
}

function renderEarningTip(
  body: string,
  ctx: TipContext,
  earning: boolean,
  ad?: { name?: string; link?: string },
): string {
  const green = color('success', ctx.theme)
  const label = earning ? 'Sponsored +credits' : 'Sponsored'
  // Attribute to the real advertiser and point at the ad's click URL (the
  // partner's tracker — that's what records the click and pays us). Fall back to
  // Twigpine only for the static no-ad line.
  const sponsor = ad?.name?.trim() || TWIGPINE.name
  // Never point a third-party advertiser's name at the Twigpine URL: for a real
  // ad use only its own click URL (no link if it's missing), and reserve the
  // Twigpine fallback for the static no-ad line.
  const adLink = ad?.link?.trim()
  const linkUrl = earning ? adLink : adLink || TWIGPINE.url
  // Make the advertiser name a clickable hyperlink to its click URL instead of
  // printing the (often very long) tracker URL inline. Clicks still hit the
  // tracker, so attribution/payout are unchanged.
  const { display, trailing } = renderSponsorLink(sponsor, linkUrl)
  const badge = green(`${label} · ${display}`)
  return `${badge} — ${green(body)}${trailing}`
}

/**
 * The Twigpine earning tip. content() fetches a real impression from the ads
 * service and schedules a confirm after the dwell so the viewer is credited for
 * seeing it. Any fetch/confirm failure degrades silently to a static line — ads
 * must never break or block the host CLI. (Confirm fires ~dwell after the tip is
 * picked; the fully attention-tied model is the server-side Tier-2 design.)
 */
export function buildEarningTip(): Tip {
  return {
    id: 'gitlawb-earn',
    sponsor: TWIGPINE,
    cooldownSessions: 0,
    isRelevant: async () => adsEarningEnabled(),
    content: async (ctx: TipContext) => {
      const fallback = 'Earn opengateway credits while you code — twigpine.com'
      const code = getGlobalConfig().ads?.earnCode
      if (!code) return renderEarningTip(fallback, ctx, false)

      // Pass the viewer's latest prompt for contextual ad matching. Enabling
      // sponsored tips disclosed this sharing; ads.ts sanitizes it first.
      // fetchNextTip is contractually non-throwing (it catches everything and
      // returns null), so no try/catch is needed at this call site.
      const tip = await fetchNextTip(code, 'openclaude', ctx.latestUserMessage)
      // A malformed/empty ad payload must not render a blank line and then
      // credit a never-seen ad — degrade to the static fallback instead.
      if (!tip || !tip.text.trim()) return renderEarningTip(fallback, ctx, false)

      const delay = Math.max(0, Math.min(tip.dwellMs, MAX_CONFIRM_DELAY_MS))
      // unref'd so this best-effort confirm never keeps a short-lived CLI run
      // alive for up to the dwell window.
      const timer = setTimeout(() => {
        void confirmTip(code, tip.token).catch(() => {})
      }, delay)
      ;(timer as { unref?: () => void }).unref?.()

      return renderEarningTip(tip.text, ctx, true, { name: tip.name, link: tip.link })
    },
  }
}
