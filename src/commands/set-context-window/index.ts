import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'set-context-window',
  description: 'Set a session-scoped context window override for a model',
  argumentHint: '[model] <tokens> [--save]',
  supportsNonInteractive: true,
  load: () => import('./set-context-window.js'),
} satisfies Command
