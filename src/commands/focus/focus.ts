import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { isFullscreenEnvEnabled, isTmuxControlMode } from '../../utils/fullscreen.js'

export const call: LocalCommandCall = async () => {
  if (!isFullscreenEnvEnabled()) {
    // /tui fullscreen only saves a setting, and the environment overrides it,
    // so name the override that is actually in force.
    const value = isEnvDefinedFalsy(process.env.CLAUDE_CODE_NO_FLICKER)
      ? 'Focus view needs the fullscreen display mode, which CLAUDE_CODE_NO_FLICKER=0 turns off. Unset it or set it to 1.'
      : isTmuxControlMode()
        ? 'Focus view needs the fullscreen display mode, which is off under tmux -CC. Set CLAUDE_CODE_NO_FLICKER=1 to turn it on.'
        : 'Focus view needs the fullscreen display mode. Run /tui fullscreen first.'
    return { type: 'text', value }
  }

  // Derive the inverse from the config the locked updater receives: the cached
  // read can lag a write another session just made.
  let next = false
  let ran = false
  saveGlobalConfig(current => {
    ran = true
    next = !(current.focusView ?? false)
    return { ...current, focusView: next }
  })
  // saveGlobalConfig returns without throwing when it skips a write (permission
  // error, auth guard), so confirm the stored value before reporting.
  if (!ran || (getGlobalConfig().focusView ?? false) !== next) {
    return {
      type: 'text',
      value: 'Could not save the focus view setting. Check write access to the config file.',
    }
  }
  return {
    type: 'text',
    value: next
      ? 'Focus view is on. Earlier turns are hidden; the latest prompt, a tool summary, failures, interrupts, local command output and the response show.'
      : 'Focus view is off.',
  }
}
