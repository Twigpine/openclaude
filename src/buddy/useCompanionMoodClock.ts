import { useContext, useState } from 'react'
import { ClockContext } from '../ink/components/ClockContext.js'
import {
  advanceMoodClock,
  type CompanionActivity,
  type MoodClock,
  startMoodClock,
} from './heroMoods.js'

/**
 * Track the agent's activity for the companion's mood.
 *
 * Call this from a component that stays mounted for the whole session (the
 * REPL), not from the sprite: the sprite unmounts while dialogs cover the
 * prompt, and a clock kept there would forget a busy stretch that a
 * permission prompt interrupted, so a long turn would end in a hop instead
 * of a celebration. Times use the shared animation clock, the same base as
 * the sprite's frame time.
 */
export function useCompanionMoodClock(
  activity: CompanionActivity,
  turnFailed: boolean,
): MoodClock {
  const clock = useContext(ClockContext)
  const now = clock?.now() ?? 0
  const [moodClock, setMoodClock] = useState<MoodClock>(() =>
    startMoodClock(activity, now),
  )
  // Sync-during-render, the same pattern the sprite uses for its anchors:
  // the render that sees the new activity already returns the new clock.
  const next = advanceMoodClock(moodClock, activity, turnFailed, now)
  if (next !== moodClock) {
    setMoodClock(next)
  }
  return next
}
