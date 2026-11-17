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

  const next = !(getGlobalConfig().focusView ?? false)
  saveGlobalConfig(current => ({ ...current, focusView: next }))
  return {
    type: 'text',
    value: next
      ? 'Focus view is on. Only your latest prompt, a tool summary and the response show.'
      : 'Focus view is off.',
  }
}
