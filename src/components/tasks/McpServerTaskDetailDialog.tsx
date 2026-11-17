import * as React from 'react'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'x' && onKill) {
      e.preventDefault()
      onKill()
    }
    if (e.key === 'Escape' && onBack) {
      e.preventDefault()
      onBack()
    }
  }

  return (
    <Dialog title={task.description} onCancel={onDone} color="background">
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
          <Text>
            <Text dimColor>elapsed: </Text>
            {elapsedTime}
          </Text>
        </Box>
        <Byline>
          {onBack && <KeyboardShortcutHint shortcut="Esc" action="go back" />}
          <KeyboardShortcutHint shortcut="Enter" action="close" />
          {task.status === 'running' && onKill && (
            <KeyboardShortcutHint shortcut="x" action="cancel" />
          )}
        </Byline>
      </Box>
    </Dialog>
  )
}
