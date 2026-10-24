import type { Command } from '../../commands.js'

const needle: Command = {
  type: 'local',
  name: 'needle',
  description: 'Enable or disable the local Needle tool-calling planner',
  supportsNonInteractive: true,
  argumentHint: 'enable | disable | status | mode <worker|main>',
  load: () => import('./needle.js'),
}

export default needle
