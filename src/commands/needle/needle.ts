import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import chalk from 'chalk'
import { checkNeedleAvailability } from '../../services/needle/needleClient.js'

export const call: LocalCommandCall = async args => {
  const parts = String(args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const command = parts[0] ?? 'status'
  const config = getGlobalConfig()
  const enabled = config.needleEnabled === true
  const mode = config.needleMode ?? 'worker'

  if (command === 'status') {
    return {
      type: 'text',
      value: `Needle: ${enabled ? chalk.green('enabled') : chalk.red('disabled')} (${mode} mode)`,
    }
  }

  if (command === 'enable' || command === 'disable') {
    const nextEnabled = command === 'enable'
    if (nextEnabled) {
      const availability = await checkNeedleAvailability()
      if (!availability.available) {
        return {
          type: 'text',
          value: `Needle was not enabled because its Python package is unavailable. Install it from source, then retry /needle enable. (${availability.error ?? 'import failed'})`,
        }
      }
    }
    saveGlobalConfig(current => ({
      ...current,
      needleEnabled: nextEnabled,
      needleMode: current.needleMode ?? 'worker',
    }))
    return {
      type: 'text',
      value: `Needle ${nextEnabled ? chalk.green('enabled') : chalk.red('disabled')} (${mode} mode).`,
    }
  }

  if (command === 'mode') {
    const nextMode = parts[1]
    if (nextMode !== 'worker' && nextMode !== 'main') {
      return { type: 'text', value: 'Usage: /needle mode <worker|main>' }
    }
    saveGlobalConfig(current => ({ ...current, needleMode: nextMode }))
    return {
      type: 'text',
      value: `Needle mode set to ${chalk.cyan(nextMode)}. ${
        nextMode === 'main'
          ? 'The main conversation will use Needle when enabled.'
          : 'AgentTool workers will use Needle when enabled.'
      }`,
    }
  }

  return {
    type: 'text',
    value: 'Usage: /needle <enable|disable|status|mode worker|main>',
  }
}
