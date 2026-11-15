import type { Command } from '../../commands.js'

const tui = {
  type: 'local',
  name: 'tui',
  description: 'Switch display mode (fullscreen or inline)',
  argumentHint: '<fullscreen|inline>',
  supportsNonInteractive: false,
  load: () => import('./tui.js'),
} satisfies Command

export default tui
