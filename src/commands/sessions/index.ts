import type { Command } from '../../commands.js'

const sessions = {
  type: 'local-jsx',
  name: 'sessions',
  description: 'List saved conversations to resume or delete them',
  load: () => import('./sessions.js'),
} satisfies Command

export default sessions
