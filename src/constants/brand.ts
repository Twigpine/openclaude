/**
 * OpenClaude brand identity — single source of truth for the product name,
 * tagline, accent color, and wordmark art used across the TUI.
 *
 * The accent is the twigpine orange. Theme entries derived from it MUST stay
 * in `rgb(r,g,b)` form (never hex): the spinner's shimmer/stall interpolation
 * parses theme values with `parseRGB`, which only matches `rgb(...)` strings.
 */

export const BRAND_NAME = 'OpenClaude'

export const BRAND_TAGLINE = 'Open terminal for any LLM'

/** twigpine orange (#ff7a1a) in the rgb() form required by theme consumers. */
export const BRAND_ACCENT_RGB = 'rgb(255,122,26)'

/**
 * Single-row wordmark, split so the two halves can be rendered in different
 * accent shades. Letter-spaced caps flanked by shade-gradient accents
 * (░ ▒ ▓ █ render correctly in Apple Terminal). Rendered as one centered row:
 *
 *   ░▒▓█ O P E N C L A U D E █▓▒░
 */
export const WORDMARK_ACCENT_LEFT = '░▒▓█'

export const WORDMARK_OPEN = 'O P E N'

export const WORDMARK_CLAUDE = 'C L A U D E'

export const WORDMARK_ACCENT_RIGHT = '█▓▒░'

/** Rendered width of the full wordmark row, including accents and gaps. */
export const WORDMARK_WIDTH =
  WORDMARK_ACCENT_LEFT.length +
  1 +
  WORDMARK_OPEN.length +
  1 +
  WORDMARK_CLAUDE.length +
  1 +
  WORDMARK_ACCENT_RIGHT.length
