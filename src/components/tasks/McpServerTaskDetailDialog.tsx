import * as React from 'react'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { McpServerTaskState } from '../../tasks/McpServerTask/McpServerTask.js'
import type { DeepImmutable } from '../../types/utils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: DeepImmutable<McpServerTaskState>
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
}

/**
 * Detail view for an MCP server-initiated task. The remote task is owned by
 * the MCP server; this view shows what it has reported (statusMessage) and
 * offers tasks/cancel through the kill control.
 */
export function McpServerTaskDetailDialog({
  task,
  onDone,
  onBack,
  onKill,
}: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(
    task.startTime,
    task.status === 'running',
    1000,
    0,
  )

  useKeybindings({ 'confirm:yes': onDone }, { context: 'Confirmation' })

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === ' ') {
      e.preventDefault()
      onDone()
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  return (
    <Dialog
      title={task.description}
      onCancel={onDone}
      color="background"
      inputGuide={() => (
        <Byline>
          {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
          <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
          {task.status === 'running' && onKill && (
            <KeyboardShortcutHint shortcut="x" action="cancel" />
          )}
        </Byline>
      )}
    >
      <Box
        flexDirection="column"
        gap={1}
        tabIndex={0}
        autoFocus
        onKeyDown={onKeyDown}
      >
        <Box flexDirection="column">
          <Text>
            <Text dimColor>server: </Text>
            {task.mcpServerName}
          </Text>
          <Text>
            <Text dimColor>tool: </Text>
            {task.mcpToolName}
          </Text>
          <Text>
            <Text dimColor>status: </Text>
            {task.status}
            {task.statusMessage ? `: ${task.statusMessage}` : ''}
          </Text>
          {task.cancelError && (
            <Text>
              <Text dimColor>stop: </Text>
              {task.cancelError}
            </Text>
          )}
          <Text>
            <Text dimColor>elapsed: </Text>
            {elapsedTime}
          </Text>
        </Box>
      </Box>
    </Dialog>
  )
}
