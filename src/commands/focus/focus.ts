import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

export const call: LocalCommandCall = async () => {
  if (!isFullscreenEnvEnabled()) {
    return {
      type: 'text',
      value:
        'Focus view needs the fullscreen display mode. Run /tui fullscreen first.',
    }
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
      ? 'Focus view is on. Only your latest prompt, a tool summary and the response show.'
      : 'Focus view is off.',
  }
}
