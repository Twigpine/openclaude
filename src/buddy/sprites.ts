import type { CompanionBones, Eye, Form } from './types.js'
import {
  corsair,
  ember,
  kage,
  kaio,
  merlin,
  robinhood,
  keynote,
  strawhat,
  twig,
} from './types.js'

// Line-art fallback sprites for low-color terminals (the primary rendering
// is the procedural hero art in heroArt.ts). Each sprite is 5 lines
// tall, 12 wide (after {E}→1char substitution), with multiple frames for
// idle fidget animation. Row 0 is the signature headwear/hair and is
// non-blank in every frame, so heights never oscillate.
//
// All heroes face LEFT: the sprite sits on the right edge of the screen
// and signature effects travel toward the prompt.
const BODIES: Record<Form, string[][]> = {
  [keynote]: [
    [
      '    ,~~~.   ',
      '   ({E}.{E})    ',
      '  /|\\#/|\\   ',
      '  #|   |    ',
      '   |_|_|    ',
    ],
    [
      '    ,~~~.   ',
      '   ({E}.{E})    ',
      '  /|\\#/|\\   ',
      '   |   |#   ',
      '   |_|_|    ',
    ],
    [
      '    ,~~~~.  ',
      '   ({E}.{E})    ',
      '  /|\\#/|\\   ',
      '  #|   |    ',
      '   |_|_|    ',
    ],
  ],
  [twig]: [
    [
      '  /\\_/\\   _ ',
      ' ( {E}.{E} ) ( )',
      '  > w < _/  ',
      ' (  ""  )/  ',
      '  ^^  ^^    ',
    ],
    [
      '  /\\_/\\  __ ',
      ' ( {E}.{E} ) (_)',
      '  > w < _/  ',
      ' (  ""  )/  ',
      '  ^^  ^^    ',
    ],
    [
      '  /\\_/|   _ ',
      ' ( {E}.{E} ) ( )',
      '  > w < _/  ',
      ' (  ""  )/  ',
      '  ^^  ^^    ',
    ],
  ],
  [robinhood]: [
    [
      '    <,___   ',
      '     ({E}.{E})  ',
      '   /(   )\\  ',
      '   (|   |   ',
      '   _/   \\_  ',
    ],
    [
      '   <<,___   ',
      '     ({E}.{E})  ',
      '   /(   )\\  ',
      '   (|   |   ',
      '   _/   \\_  ',
    ],
    [
      '    <,___   ',
      '     ({E}.{E})  ',
      '   ((   )\\  ',
      '    |   |   ',
      '   _/   \\_  ',
    ],
  ],
  [kaio]: [
    [
      '   \\|/|/    ',
      '    ({E}.{E})   ',
      '   /(   )\\  ',
      '    |   |   ',
      '   _/   \\_  ',
    ],
    [
      '   \\|/|//   ',
      '    ({E}.{E})   ',
      '   /(   )\\  ',
      '    |   |   ',
      '   _/   \\_  ',
    ],
    [
      '  *\\|/|/*   ',
      '    ({E}.{E})   ',
      '   /(   )\\  ',
      '    |   |   ',
      '   _/   \\_  ',
    ],
  ],
  [strawhat]: [
    [
      '    ____    ',
      '   <____>   ',
      '   ({E}.{E})    ',
      '   /|~~|\\   ',
      '   _/  \\_   ',
    ],
    [
      '    ____    ',
      '   <____>~  ',
      '   ({E}.{E})    ',
      '   /|~~|\\   ',
      '   _/  \\_   ',
    ],
    [
      '    ____    ',
      '   <____>   ',
      '   ({E}.{E})    ',
      '   \\|~~|/   ',
      '   _/  \\_   ',
    ],
  ],
  [merlin]: [
    [
      '    /\\      ',
      '   /__\\     ',
      '  ~({E}.{E})~   ',
      '   /|##|\\   ',
      '   _/~~\\_   ',
    ],
    [
      '   */\\      ',
      '   /__\\     ',
      '  ~({E}.{E})~   ',
      '   /|##|\\   ',
      '   _/~~\\_   ',
    ],
    [
      '    /\\      ',
      '   /__\\     ',
      '  ~({E}.{E})~   ',
      '  |/|##|\\   ',
      '   _/~~\\_   ',
    ],
  ],
  [kage]: [
    [
      '   ____     ',
      '  /____\\    ',
      '  |({E}{E})|    ',
      '   |==|~    ',
      '   _/\\_     ',
    ],
    [
      '   ____     ',
      '  /____\\    ',
      '  |({E}{E})|    ',
      '   |==|~~   ',
      '   _/\\_     ',
    ],
    [
      '   ____  *  ',
      '  /____\\    ',
      '  |({E}{E})|    ',
      '   |==|~    ',
      '   _/\\_     ',
    ],
  ],
  [ember]: [
    [
      '    ^^      ',
      '  <({E}{E})     ',
      '  (~~~~)>   ',
      '   |  |     ',
      '  _/  \\_~   ',
    ],
    [
      '  o ^^      ',
      '  <({E}{E})     ',
      '  (~~~~)>   ',
      '   |  |     ',
      '  _/  \\_~   ',
    ],
    [
      '    ^^      ',
      '  <({E}{E})     ',
      '  (^^^^)>   ',
      '   |  |     ',
      '  _/  \\_~   ',
    ],
  ],
  [corsair]: [
    [
      '   _/\\_     ',
      '  [____]    ',
      '   ({E}x)     ',
      '  /|++|\\    ',
      '   _/\\_     ',
    ],
    [
      '   _/\\_  ,> ',
      '  [____]    ',
      '   ({E}x)     ',
      '  /|++|\\    ',
      '   _/\\_     ',
    ],
    [
      '   _/\\_     ',
      '  [____]    ',
      '   ({E}x)     ',
      '  \\|++|/    ',
      '   _/\\_     ',
    ],
  ],
}

// One-shot draw/cast poses for the signature action, line-art fallback.
// Kept out of BODIES so spriteFrameCount and the excited all-frames cycle
// never leak action poses into idle animation. EVERY hero needs an entry:
// without one, low-color terminals show a projectile flying out of a
// motionless sprite.
const SHOOT_FRAMES: Record<Form, string[][]> = {
  [keynote]: [
    [
      // chip up
      '    ,~~~.   ',
      '   ({E}.{E})    ',
      ' #/|\\#/|\\   ',
      '   |   |    ',
      '   |_|_|    ',
    ],
    [
      // toss
      '    ,~~~.   ',
      '   ({E}o{E})    ',
      '#-/|\\#/|\\   ',
      '   |   |    ',
      '   |_|_|    ',
    ],
    [
      // follow through — the chip hands off to CompanionActionFX
      '    ,~~~.   ',
      '   ({E}.{E})    ',
      ' -/|\\#/|\\   ',
      '   |   |    ',
      '   |_|_|    ',
    ],
  ],
  [twig]: [
    [
      // wind up, acorn in paw
      '  /\\_/\\   _ ',
      ' ( {E}.{E} ) ( )',
      ' o> w < _/  ',
      ' (  ""  )/  ',
      '  ^^  ^^    ',
    ],
    [
      // throw
      '  /\\_/\\   _ ',
      ' ( {E}.{E} ) ( )',
      'o-> w < _/  ',
      ' (  ""  )/  ',
      '  ^^  ^^    ',
    ],
    [
      // follow through — the acorn hands off to CompanionActionFX
      '  /\\_/\\   _ ',
      ' ( {E}.{E} ) ( )',
      ' -> w < _/  ',
      ' (  ""  )/  ',
      '  ^^  ^^    ',
    ],
  ],
  [robinhood]: [
    [
      // nock
      '    <,___   ',
      '     ({E}.{E})  ',
      '  <-(   )\\  ',
      '   (|   |   ',
      '   _/   \\_  ',
    ],
    [
      // full draw
      '    <,___   ',
      '     ({E}.{E})  ',
      '  <==(   )> ',
      '   (|   |   ',
      '   _/   \\_  ',
    ],
    [
      // loose — string vibrates; the arrow hands off to CompanionActionFX
      '    <,___   ',
      '     ({E}.{E})  ',
      '   ~(   )\\  ',
      '   (|   |   ',
      '   _/   \\_  ',
    ],
  ],
  [kaio]: [
    [
      '   \\|/|/    ',
      '    ({E}.{E})   ',
      '  ((   )\\   ',
      '    |   |   ',
      '   _/   \\_  ',
    ],
    [
      '   \\|/|/    ',
      '    ({E}.{E})   ',
      ' o((   )\\   ',
      '    |   |   ',
      '   _/   \\_  ',
    ],
    [
      '   \\|/|/    ',
      '    ({E}.{E})   ',
      ' =((   )\\   ',
      '    |   |   ',
      '   _/   \\_  ',
    ],
  ],
  [strawhat]: [
    [
      '    ____    ',
      '   <____>   ',
      '   ({E}.{E})    ',
      '   /|~~|>   ',
      '   _/  \\_   ',
    ],
    [
      '    ____    ',
      '   <____>   ',
      '   ({E}.{E})    ',
      '  o|~~|\\    ',
      '   _/  \\_   ',
    ],
    [
      '    ____    ',
      '   <____>   ',
      '   ({E}.{E})    ',
      ' o-|~~|\\    ',
      '   _/  \\_   ',
    ],
  ],
  [merlin]: [
    [
      '    /\\      ',
      '   /__\\     ',
      '  ~({E}.{E})~   ',
      '  |/|##|\\   ',
      '   _/~~\\_   ',
    ],
    [
      '  */\\       ',
      '   /__\\     ',
      '  ~({E}.{E})~   ',
      '  |/|##|\\   ',
      '   _/~~\\_   ',
    ],
    [
      ' **/\\       ',
      '   /__\\     ',
      '  ~({E}.{E})~   ',
      '  |/|##|\\   ',
      '   _/~~\\_   ',
    ],
  ],
  [kage]: [
    [
      '   ____     ',
      '  /____\\    ',
      '  |({E}{E})|    ',
      '  -|==|~    ',
      '   _/\\_     ',
    ],
    [
      '   ____ *   ',
      '  /____\\    ',
      '  |({E}{E})|    ',
      '  -|==|~    ',
      '   _/\\_     ',
    ],
    [
      '   ____     ',
      '  /____\\    ',
      '  |({E}{E})|    ',
      '  ~|==|~    ',
      '   _/\\_     ',
    ],
  ],
  [ember]: [
    [
      '    ^^      ',
      ' <<({E}{E})     ',
      '  (~~~~)>   ',
      '   |  |     ',
      '  _/  \\_~   ',
    ],
    [
      '    ^^      ',
      '~<({E}{E})      ',
      '  (^^^^)>   ',
      '   |  |     ',
      '  _/  \\_~   ',
    ],
    [
      '    ^^      ',
      ' <({E}{E})~     ',
      '  (~~~~)>   ',
      '   |  |     ',
      '  _/  \\_~   ',
    ],
  ],
  [corsair]: [
    [
      '   _/\\_     ',
      '  [____]    ',
      '   ({E}x)     ',
      ' =/|++|\\    ',
      '   _/\\_     ',
    ],
    [
      '   _/\\_     ',
      '  [____]    ',
      '   ({E}x)     ',
      '==/|++|\\    ',
      '   _/\\_     ',
    ],
    [
      '   _/\\_     ',
      '  [____]    ',
      '   ({E}x)     ',
      ' */|++|\\    ',
      '   _/\\_     ',
    ],
  ],
}

export function renderSprite(bones: CompanionBones, frame = 0): string[] {
  const frames = BODIES[bones.species]
  return frames[frame % frames.length]!.map(line =>
    line.replaceAll('{E}', bones.eye),
  )
}

export function renderShootSprite(
  bones: CompanionBones,
  frame: number,
): string[] {
  const frames = SHOOT_FRAMES[bones.species]
  const clamped = Math.min(Math.max(frame, 0), frames.length - 1)
  return frames[clamped]!.map(line => line.replaceAll('{E}', bones.eye))
}

export function shootFrameCount(species: Form): number {
  return SHOOT_FRAMES[species].length
}

export function spriteFrameCount(species: Form): number {
  return BODIES[species].length
}

export function renderFace(bones: CompanionBones): string {
  const eye: Eye = bones.eye
  switch (bones.species) {
    case robinhood:
      return `«(${eye})`
    case kaio:
      return `\\(${eye})/`
    case strawhat:
      return `∩(${eye})`
    case merlin:
      return `^(${eye})`
    case kage:
      return `|${eye}${eye}|`
    case ember:
      return `<${eye}${eye}>`
    case corsair:
      return `(${eye}x)`
    case twig:
      return `=(${eye})~`
    case keynote:
      return `/(${eye})\\`
  }
}
