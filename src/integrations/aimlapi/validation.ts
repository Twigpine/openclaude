import {
  DEFAULT_AMOUNT_USD_MINOR,
  MAX_AMOUNT_USD_MINOR,
  MIN_AMOUNT_USD_MINOR,
} from './config.js'

/**
 * Parse a whole-USD top-up amount into backend minor units (cents), enforcing
 * the same bounds the backend DTO does. An empty value falls back to the default
 * so the guided flow can offer a sensible amount without prompting.
 */
export function parseAimlapiAmountUsd(amountUsd: string | undefined): number {
  if (!amountUsd?.trim()) return DEFAULT_AMOUNT_USD_MINOR
  const normalized = amountUsd.trim()
  const dollars = Number(normalized)
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new Error(`Invalid amount: "${amountUsd}". Pass a positive number of USD.`)
  }
  // Only accept a plain decimal with at most two fractional digits. This rejects
  // scientific notation (e.g. "20.001e0"), signs, and sub-cent precision that
  // Number() would otherwise silently round into a wrong charge.
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Invalid amount: "${amountUsd}". Pass a valid USD amount.`)
  }
  const minor = Math.round(dollars * 100)
  if (minor < MIN_AMOUNT_USD_MINOR) {
    throw new Error(`Minimum top-up is $${MIN_AMOUNT_USD_MINOR / 100}.`)
  }
  if (minor > MAX_AMOUNT_USD_MINOR) {
    throw new Error(`Maximum top-up is $${MAX_AMOUNT_USD_MINOR / 100}.`)
  }
  return minor
}

/**
 * Lightweight email shape check for the passwordless flow: one `@`, a dotted
 * domain with a sane alphabetic TLD. The backend is the source of truth; this
 * only avoids an obvious round-trip on a malformed address.
 */
export function isValidAimlapiEmail(value: string): boolean {
  const email = value.trim()
  const match = /^[^\s@]+@([^\s@]+)$/.exec(email)
  if (!match) return false
  const domain = match[1]
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return false
  }
  const labels = domain.split('.')
  const tld = labels.at(-1) ?? ''
  return labels.length >= 2 && /^[A-Za-z]{2,}$/.test(tld)
}

/**
 * The passwordless sign-in code is documented and issued as a 6-digit
 * numeric string. Rejecting anything else locally — empty, non-numeric,
 * short, long — avoids an obvious round trip to verifySignInCode for input
 * that can never succeed, and keeps that contract in one place instead of
 * being reimplemented (and able to drift) at each entry point.
 */
export function isValidAimlapiSignInCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim())
}
