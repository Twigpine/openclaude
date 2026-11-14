import chalk from 'chalk'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

const USAGE = 'Usage: /scroll-speed <1-20>'

export const call: LocalCommandCall = async args => {
  const input = (args ?? '').trim()
  const envSpeed = process.env.CLAUDE_CODE_SCROLL_SPEED
  if (!input) {
    const current = getGlobalConfig().scrollSpeed ?? 1
    const envNote = envSpeed
      ? ` CLAUDE_CODE_SCROLL_SPEED=${envSpeed} overrides it.`
      : ''
    return {
      type: 'text',
      value: `Current scroll speed: ${chalk.bold(String(current))}.${envNote} ${USAGE} to change.`,
    }
  }

  const speed = parseFloat(input)
  if (Number.isNaN(speed) || speed <= 0 || speed > 20) {
    return { type: 'text', value: USAGE }
  }

  saveGlobalConfig(current => ({ ...current, scrollSpeed: speed }))
  const envNote = envSpeed
    ? ` Note: CLAUDE_CODE_SCROLL_SPEED=${envSpeed} takes precedence.`
    : ''
  return {
    type: 'text',
    value: `Scroll speed set to ${chalk.bold(String(speed))}. Applies on the next wheel scroll.${envNote}`,
  }
}
