import type { Command } from '../../commands.js'

const focus = {
  type: 'local',
  name: 'focus',
  description: 'Toggle focus view (latest prompt, tool summary and response)',
  supportsNonInteractive: false,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
