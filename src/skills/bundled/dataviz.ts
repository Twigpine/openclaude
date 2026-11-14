import { registerBundledSkill } from '../bundledSkills.js'

const VALIDATE_PALETTE_SCRIPT = `#!/usr/bin/env node
// Checks a color palette for WCAG contrast failures.
// Usage: node validate-palette.mjs <hex> [<hex> ...]
// Exit 0 when every pair passes AA (4.5:1 normal text, 3:1 large text).

const toSrgb = hex => {
  const h = hex.replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255)
}
const channel = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const luminance = hex => {
  const srgb = toSrgb(hex)
  if (!srgb) return null
  const [r, g, b] = srgb.map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node validate-palette.mjs <hex> [<hex> ...]')
  process.exit(2)
}
const invalid = args.filter(h => luminance(h) === null)
if (invalid.length) {
  console.error('invalid colors: ' + invalid.join(', '))
  process.exit(2)
}

let failed = 0
for (let i = 0; i < args.length; i++) {
  for (let j = i + 1; j < args.length; j++) {
    const r = ratio(luminance(args[i]), luminance(args[j]))
    const tag = r >= 4.5 ? 'AA ok' : r >= 3 ? 'large text only' : 'FAIL'
    if (r < 3) failed++
    console.log(args[i] + ' vs ' + args[j] + ': ' + r.toFixed(2) + ':1 ' + tag)
  }
}
process.exit(failed ? 1 : 0)
`

const DATAVIZ_PROMPT = `# Data visualization guidance

Help the user design charts and dashboards that communicate clearly.

## Chart selection

- Comparisons across categories: bar chart. Horizontal bars when labels are long.
- Change over time: line chart. Fewer than ~6 series; beyond that, small multiples or an interactive filter.
- Part-to-whole: stacked bar for a few segments; avoid pie charts beyond 3 slices and never for precise comparison.
- Distribution: histogram or box plot, not a table.
- Relationship between two numeric variables: scatter plot; add a trend line only when the relationship is real.
- Tables beat charts when exact values matter more than shape.

## Design rules

- Start value axes at zero for bar charts; line charts may crop but say so.
- Order categories meaningfully (sorted or logical), not alphabetically by default.
- Label directly where possible instead of relying on a legend.
- One message per chart. If a chart needs a paragraph to explain, split it.
- Round axis numbers; do not show more precision than the data supports.

## Color and accessibility

- Distinguish series by position or shape before color; color is the weakest channel.
- Text and data marks need WCAG AA contrast: 4.5:1 for normal text, 3:1 for large text and essential graphics.
- Never encode meaning with red/green alone (color-vision deficiency affects ~8% of men); pair with labels, icons, or patterns.
- Use a perceptually uniform sequence for continuous data; reserve red/green for actual good/bad semantics.

## Palette check

This skill ships a runnable validator. Run it with the palette's hex colors to check every pair for contrast failures:

\`node <skill-base-dir>/validate-palette.mjs "#1f77b4" "#ff7f0e" ...\`

Exit 0 means every pair clears AA-large-text (3:1); FAIL lines show pairs under 3:1. When it fails, adjust lightness or saturation and re-run.
`

export function registerDatavizSkill(): void {
  registerBundledSkill({
    name: 'dataviz',
    description:
      'Chart and dashboard design guidance, with a palette contrast validator.',
    descriptionKey: 'skills.dataviz.description',
    userInvocable: true,
    files: {
      'validate-palette.mjs': VALIDATE_PALETTE_SCRIPT,
    },
    async getPromptForCommand() {
      return [{ type: 'text', text: DATAVIZ_PROMPT }]
    },
  })
}
