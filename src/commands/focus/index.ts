import type { Command } from '../../commands.js'

const focus = {
  type: 'local',
  name: 'focus',
  description: 'Toggle focus view, fullscreen only (see /tui fullscreen). Hides earlier turns; keeps the latest prompt, tool summary, failures and response',
  supportsNonInteractive: false,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
