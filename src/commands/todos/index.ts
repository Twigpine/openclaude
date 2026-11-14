import type { Command } from '../../commands.js'

const todos = {
  type: 'local',
  name: 'todos',
  description: 'List current todo items',
  supportsNonInteractive: false,
  load: () => import('./todos.js'),
} satisfies Command

export default todos
