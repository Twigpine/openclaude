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

  if (mode === 'fullscreen') {
    saveGlobalConfig(current => ({ ...current, flickerFreeMode: true }))
    return {
      type: 'text',
      value: `Switched to fullscreen display mode.${envNote}`,
    }
  }
  if (mode === 'inline') {
    saveGlobalConfig(current => ({ ...current, flickerFreeMode: false }))
    return { type: 'text', value: `Switched to inline display mode.${envNote}` }
  }

  const current = isFullscreenEnvEnabled() ? 'fullscreen' : 'inline'
  return {
    type: 'text',
    value: `Current display mode: ${chalk.bold(current)}. ${USAGE}`,
  }
}
