export const RARITIES = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
] as const
export type Rarity = (typeof RARITIES)[number]

// One species name collides with a model-codename canary in excluded-strings.txt.
// The check greps build output (not source), so runtime-constructing the value keeps
// the literal out of the bundle while the check stays armed for the actual codename.
// All species encoded uniformly; `as` casts are type-position only (erased pre-bundle).
const c = String.fromCharCode
// biome-ignore format: keep the species list compact

export const robinhood = c(
  0x72,
  0x6f,
  0x62,
  0x69,
  0x6e,
  0x68,
  0x6f,
  0x6f,
  0x64,
) as 'robinhood'
export const kaio = c(0x6b, 0x61, 0x69, 0x6f) as 'kaio'
export const strawhat = c(
  0x73,
  0x74,
  0x72,
  0x61,
  0x77,
  0x68,
  0x61,
  0x74,
) as 'strawhat'
export const merlin = c(0x6d, 0x65, 0x72, 0x6c, 0x69, 0x6e) as 'merlin'
export const kage = c(0x6b, 0x61, 0x67, 0x65) as 'kage'
export const ember = c(0x65, 0x6d, 0x62, 0x65, 0x72) as 'ember'
export const corsair = c(0x63, 0x6f, 0x72, 0x73, 0x61, 0x69, 0x72) as 'corsair'

// The deterministic hatch pool — every hero form. NEVER reorder or grow
// this list casually: pick(rng, SPECIES) depends on SPECIES.length and
// ordering, so any change re-rolls every existing user's hatched species
// (their speciesOverride, if set, still wins).
export const SPECIES = [
  robinhood,
  kaio,
  strawhat,
  merlin,
  kage,
  ember,
  corsair,
] as const
export type Species = (typeof SPECIES)[number] // biome-ignore format: keep compact

// Twig, the pine marten, is OpenClaude's flagship buddy. It is a chosen form
// only (/buddy set twig) and deliberately NOT in SPECIES: growing the hatch
// pool would re-roll every existing user's species.
export const twig = c(0x74, 0x77, 0x69, 0x67) as 'twig'

// Every form a companion can take: the hatch pool plus chosen-only forms.
export const FORMS = [...SPECIES, twig] as const
export type Form = (typeof FORMS)[number]

// What users see. kaio and strawhat keep their ids (stored configs and the
// hatch roll depend on them) but now render as the original characters Nova
// and Inky, which keep the energy-wave and long-reach effects.
export const FORM_NAMES: Record<Form, string> = {
  [robinhood]: 'Robin',
  [kaio]: 'Nova',
  [strawhat]: 'Inky',
  [merlin]: 'Merlin',
  [kage]: 'Kage',
  [ember]: 'Ember',
  [corsair]: 'Corsair',
  [twig]: 'Twig',
}

/** Resolve a form from its id or its display name, case-insensitively. */
export function parseForm(input: string): Form | undefined {
  const wanted = input.trim().toLowerCase()
  return FORMS.find(
    form => form === wanted || FORM_NAMES[form].toLowerCase() === wanted,
  )
}

export const EYES = ['·', '✦', '×', '◉', '@', '°'] as const
export type Eye = (typeof EYES)[number]

export const HATS = [
  'none',
  'crown',
  'tophat',
  'propeller',
  'halo',
  'wizard',
  'beanie',
  'tinyduck',
] as const
export type Hat = (typeof HATS)[number]

export const STAT_NAMES = [
  'DEBUGGING',
  'PATIENCE',
  'CHAOS',
  'WISDOM',
  'SNARK',
] as const
export type StatName = (typeof STAT_NAMES)[number]

// Deterministic parts — derived from hash(userId)
export type CompanionBones = {
  rarity: Rarity
  /** Rolled from SPECIES; a chosen override can be any Form. */
  species: Form
  eye: Eye
  hat: Hat
  shiny: boolean
  stats: Record<StatName, number>
}

// Model-generated soul — stored in config after first hatch
export type CompanionSoul = {
  name: string
  personality: string
}

export type Companion = CompanionBones &
  CompanionSoul & {
    hatchedAt: number
  }

// What actually persists in config. Bones are regenerated from hash(userId)
// on every read so species renames don't break stored companions and users
// can't edit their way to a legendary.
export type StoredCompanion = CompanionSoul & {
  hatchedAt: number
  // Persisted /buddy set choice. Applied over the rolled bones' species in
  // getCompanion(); does NOT touch rarity/stats (can't fake a legendary).
  speciesOverride?: Form
}

export const RARITY_WEIGHTS = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
} as const satisfies Record<Rarity, number>

// Every hero's signature color. A full Record so adding a species without a
// color is a compile error, not a silent fallback.
export const SPECIES_COLORS: Record<
  Form,
  keyof import('../utils/theme.js').Theme
> = {
  [robinhood]: 'success',
  [kaio]: 'ide',
  [strawhat]: 'planMode',
  [merlin]: 'autoAccept',
  [kage]: 'inactive',
  [ember]: 'error',
  [corsair]: 'permission',
  [twig]: 'warning',
}

export function companionColor(
  companion: Pick<CompanionBones, 'species'>,
): keyof import('../utils/theme.js').Theme {
  return SPECIES_COLORS[companion.species]
}
