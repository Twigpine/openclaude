import * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import { nextLocalUsageRange } from '../../services/usage/format.js'
import {
  type LocalUsageRange,
  type LocalUsageSummary,
  queryLocalUsage,
} from '../../services/usage/query.js'
import { logError } from '../../utils/log.js'
import { shouldSkipSessionPersistence } from '../../utils/sessionPersistencePolicy.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { LocalUsageView } from './LocalUsageView.js'

const MAX_VIEW_WIDTH = 100

type LoadedRange = {
  range: LocalUsageRange
  summary: LocalUsageSummary | null
  error: string | null
}

/**
 * Loads local usage for the selected range; `r` cycles the range.
 *
 * The range and the per-range cache live in this component, so they reset
 * when it remounts (for example after switching to the Plan tab and back).
 * That is intended: reopening the tab re-reads the ledger.
 */
export function LocalUsage({
  initialRange = 'today',
  load = queryLocalUsage,
}: {
  initialRange?: LocalUsageRange
  /** Reads one range from the ledger. Tests pass a stub. */
  load?: (range: LocalUsageRange) => Promise<LocalUsageSummary>
}): React.ReactNode {
  const [range, setRange] = useState<LocalUsageRange>(initialRange)
  const [loaded, setLoaded] = useState<LoadedRange | null>(null)
  const cache = useRef(new Map<LocalUsageRange, LocalUsageSummary>())
  const [historyOff] = useState(() => shouldSkipSessionPersistence())
  const { columns } = useTerminalSize()

  useEffect(() => {
    const cached = cache.current.get(range)
    if (cached) {
      setLoaded({ range, summary: cached, error: null })
      return
    }
    let cancelled = false
    load(range).then(
      summary => {
        cache.current.set(range, summary)
        if (!cancelled) setLoaded({ range, summary, error: null })
      },
      (error: unknown) => {
        logError(error)
        if (!cancelled) {
          setLoaded({
            range,
            summary: null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [range, load])

  useInput((input, key) => {
    if (key.ctrl || key.meta || !/^r+$/.test(input)) return
    // Quick repeated presses can arrive together as one input ("rrr").
    setRange(current => {
      let next = current
      for (let i = 0; i < input.length; i++) next = nextLocalUsageRange(next)
      return next
    })
  })

  const current = loaded?.range === range ? loaded : null
  return (
    <Box flexDirection="column" gap={1}>
      <LocalUsageView
        range={range}
        summary={current?.summary ?? null}
        error={current?.error ?? null}
        historyOff={historyOff}
        width={Math.max(40, Math.min(columns - 4, MAX_VIEW_WIDTH))}
      />
      <Text dimColor>
        <Byline>
          <KeyboardShortcutHint shortcut="r" action="change range" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="close"
          />
        </Byline>
      </Text>
    </Box>
  )
}
