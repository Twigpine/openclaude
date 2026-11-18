import chalk from 'chalk'
import type { LocalCommandCall } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

const USAGE = 'Usage: /tui <fullscreen|inline>'

export const call: LocalCommandCall = async args => {
  const mode = (args ?? '').trim().toLowerCase()
  const envFlag = process.env.CLAUDE_CODE_NO_FLICKER
  const envNote = envFlag
    ? ` Note: CLAUDE_CODE_NO_FLICKER=${envFlag} takes precedence.`
    : ''

  if (mode === 'fullscreen' || mode === 'inline') {
    saveGlobalConfig(current => ({ ...current, flickerFreeMode: mode === 'fullscreen' }))
    const effective = isFullscreenEnvEnabled() ? 'fullscreen' : 'inline'
    if (effective === mode) {
      return { type: 'text', value: `Switched to ${effective} display mode.${envNote}` }
    }
    const reason = envFlag ? '' : ' This terminal does not support fullscreen.'
    return {
      type: 'text',
      value: `Saved ${mode} preference; effective display mode is ${effective}.${reason}${envNote}`,
    }
  }

  const current = isFullscreenEnvEnabled() ? 'fullscreen' : 'inline'
  return {
    type: 'text',
    value: `Current display mode: ${chalk.bold(current)}. ${USAGE}`,
  }
}
