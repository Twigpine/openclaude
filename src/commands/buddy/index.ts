import type { Command } from '../../commands.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: 'Hatch, pet, and manage your OpenClaude companion',
  immediate: true,
  argumentHint: '[status|mute|unmute|dance|images <on|off>|set <form>|name <name>|help]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
