import * as React from 'react'
import { Text } from '../../ink.js'

type Props = {
  summary: {
    toolCount: number
    linesAdded: number
    linesRemoved: number
    failed: number
  }
}

export function FocusSummaryMessage({ summary }: Props): React.ReactNode {
  const { toolCount, linesAdded, linesRemoved, failed } = summary
  const parts = [`${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`]
  if (linesAdded > 0 || linesRemoved > 0) {
    parts.push(`+${linesAdded}/-${linesRemoved}`)
  }
  if (failed > 0) parts.push(`${failed} failed`)
  return <Text dimColor>{parts.join(', ')}</Text>
}
