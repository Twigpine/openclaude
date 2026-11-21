import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { CompactBoundaryMessage } from './CompactBoundaryMessage.js'

type Props = {
  hiddenTurns: number
  compacted: boolean
}

export function FocusMarkerMessage({
  hiddenTurns,
  compacted,
}: Props): React.ReactNode {
  const historyShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  return (
    <Box flexDirection="column">
      {hiddenTurns > 0 && (
        <Text dimColor>
          {hiddenTurns} earlier {hiddenTurns === 1 ? 'turn' : 'turns'} hidden,{' '}
          {historyShortcut} for transcript, /focus to turn off
        </Text>
      )}
      {compacted && <CompactBoundaryMessage />}
    </Box>
  )
}
