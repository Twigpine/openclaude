import type { Command } from '../../commands.js'

const scrollSpeed = {
  type: 'local',
  name: 'scroll-speed',
  description: 'Set mouse wheel scroll speed',
  argumentHint: '<1-20>',
  supportsNonInteractive: false,
  load: () => import('./scroll-speed.js'),
} satisfies Command

export default scrollSpeed
