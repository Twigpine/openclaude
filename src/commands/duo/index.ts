import type { Command } from '../../commands.js'

const duo = {
  type: 'local',
  name: 'duo',
  description:
    'Structured debate between two models or CLIs (parallel answers + consensus protocol)',
  argumentHint:
    '[message | skill <name> <question> | skills | rounds N | backend builtin|cli | model a|b <id> | protocol on|off | auto on|off | tools on|off | mode adversarial|neutral | approve on|off | models | status | clear]',
  supportsNonInteractive: true,
  load: () => import('./duo.js'),
} satisfies Command

export default duo
