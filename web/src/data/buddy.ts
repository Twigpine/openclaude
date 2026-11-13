// Hero companion facts, kept in sync with src/buddy/ (types.ts, buddy.tsx,
// actionEffects.ts). Sprites in /public/buddy/*.svg are rendered from the
// hero art in src/buddy/heroArt.ts at full scale — regenerate them rather
// than editing by hand. `id` is the form id (the SVG file name); `name` is
// what /buddy set accepts and what users see.

export interface BuddyHero {
  id: string
  name: string
  accent: string
  /** what happens when you press Enter */
  attack: string
  attackDetail: string
  /** flavor line shown when you /buddy set this form */
  flavor: string
}

export const heroes: BuddyHero[] = [
  {
    id: 'twig',
    name: 'twig',
    accent: '#a8744c',
    attack: 'acorn lob',
    attackDetail:
      'the pine marten flagship winds up and lobs an acorn across the footer at your prompt.',
    flavor: 'curls up its tail and grins',
  },
  {
    id: 'robinhood',
    name: 'robin',
    accent: '#489e4a',
    attack: 'arrow shot',
    attackDetail:
      'an arrow flies right-to-left across the footer toward your prompt and lands with an impact thunk.',
    flavor: 'dons the green hood',
  },
  {
    id: 'kaio',
    name: 'nova',
    accent: '#a5dcff',
    attack: 'energy wave',
    attackDetail:
      'the little astronaut charges an orb, then releases a full-width energy beam — white-hot core, blue edge.',
    flavor: 'seals the helmet and powers up the visor',
  },
  {
    id: 'strawhat',
    name: 'inky',
    accent: '#7fd6c2',
    attack: 'long-reach punch',
    attackDetail:
      'the octopus stretches one tentacle all the way out, lands the hit mid-flight, and snaps back.',
    flavor: 'wiggles all five tentacles',
  },
  {
    id: 'merlin',
    name: 'merlin',
    accent: '#a573e6',
    attack: 'sparkle stream',
    attackDetail:
      'a twinkling comet of sparkles streams from the star-tipped staff and ends in a starburst.',
    flavor: 'raises the star-tipped staff',
  },
  {
    id: 'kage',
    name: 'kage',
    accent: '#c8cdd2',
    attack: 'shuriken throw',
    attackDetail:
      'a steel shuriken spins across the screen, cycling glyphs every 80 milliseconds.',
    flavor: 'melts into the shadows',
  },
  {
    id: 'ember',
    name: 'ember',
    accent: '#eb5a3c',
    attack: 'dragon fire',
    attackDetail:
      'breathes a cone of fire with a real heat gradient — hot core, cooling tail, scorch-out.',
    flavor: 'puffs a proud little smoke ring',
  },
  {
    id: 'corsair',
    name: 'corsair',
    accent: '#d6a83c',
    attack: 'cannon shot',
    attackDetail:
      'fires a cannonball that arcs across the footer trailing smoke.',
    flavor: 'tips the tricorn',
  },
]

export const buddyCommands = [
  { cmd: '/buddy', desc: 'hatch your companion on first run; pet them after that' },
  { cmd: '/buddy status', desc: 'who they are — name, rarity, form, personality' },
  { cmd: '/buddy set <hero>', desc: 'choose a form: twig, robin, merlin, kage, corsair, ember, nova, inky' },
  { cmd: '/buddy set random', desc: 'back to the form you originally rolled' },
  { cmd: '/buddy name <name>', desc: 'rename your companion (up to 20 characters)' },
  { cmd: '/buddy dance', desc: 'a few seconds of dancing, just because' },
  { cmd: '/buddy mute', desc: 'hide the buddy and silence all animations' },
  { cmd: '/buddy unmute', desc: 'bring them back' },
]

export const rarities = [
  { name: 'common', weight: '60%' },
  { name: 'uncommon', weight: '25%' },
  { name: 'rare', weight: '10%' },
  { name: 'epic', weight: '4%' },
  { name: 'legendary', weight: '1%' },
]

export const statNames = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK']
