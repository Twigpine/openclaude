// Hero companion facts, kept in sync with src/buddy/ (types.ts, buddy.tsx,
// actionEffects.ts). Sprites in /public/buddy/*.svg are generated from
// src/buddy/pixelSprites.ts — regenerate them rather than editing by hand.

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
    id: 'robinhood',
    name: 'robin hood',
    accent: '#489e4a',
    attack: 'arrow shot',
    attackDetail:
      'an arrow flies right-to-left across the footer toward your prompt and lands with an impact thunk.',
    flavor: 'dons the green hood',
  },
  {
    id: 'kaio',
    name: 'kaio',
    accent: '#ffdc50',
    attack: 'energy wave',
    attackDetail:
      'charges an orb, then releases a full-width energy beam — white-hot core, blue edge.',
    flavor: 'powers up — hair blazing gold',
  },
  {
    id: 'strawhat',
    name: 'strawhat',
    accent: '#e6c85a',
    attack: 'stretchy punch',
    attackDetail:
      'a rubber arm stretches all the way out, lands the hit mid-flight, and snaps back.',
    flavor: 'puts on the straw hat with a grin',
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
  { cmd: '/buddy set <hero>', desc: 'choose a form: robinhood, kaio, strawhat, merlin, kage, ember, corsair' },
  { cmd: '/buddy set random', desc: 'back to the form you originally rolled' },
  { cmd: '/buddy name <name>', desc: 'rename your companion (up to 20 characters)' },
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
