import { describe, expect, test } from 'bun:test'
import { comparePersistedDates, inclusiveCalendarDaySpan } from './stats.js'
import type { SessionStats } from './stats.js'
import {
  mergeCacheWithNewStats,
  type PersistedStatsCache,
  STATS_CACHE_VERSION,
} from './statsCache.js'

describe('inclusiveCalendarDaySpan', () => {
  test('is 1 when both timestamps fall on the same UTC calendar day', () => {
    // Two sessions on the same day (01:00 and 20:00 UTC). The old
    // Math.ceil(rawGap) + 1 rounded the 19h partial day up to 1 and then added
    // 1, reporting 2 total days for a single active day.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T01:00:00.000Z',
        '2026-07-13T20:00:00.000Z',
      ),
    ).toBe(1)
  })

  test('counts calendar days inclusively across a multi-day span', () => {
    // 2026-07-13 .. 2026-07-15 inclusive = 3 days, regardless of time of day.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T22:00:00.000Z',
        '2026-07-15T06:00:00.000Z',
      ),
    ).toBe(3)
  })

  test('does not add a day when the later session is later in the day', () => {
    // The canonical off-by-one: the raw gap is 1.5 days, so the old
    // Math.ceil(gap) + 1 rounded up to 2 and then added the inclusive +1,
    // reporting 3 for a 2-calendar-day span. Unlike the spans above, this case
    // separates the two formulas, so it fails if the off-by-one comes back.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T06:00:00.000Z',
        '2026-07-14T18:00:00.000Z',
      ),
    ).toBe(2)
  })

  test('counts a longer non-midnight span by calendar day', () => {
    // Raw gap 3.5 days: old formula gave ceil(3.5) + 1 = 5, correct is 4.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T06:00:00.000Z',
        '2026-07-16T18:00:00.000Z',
      ),
    ).toBe(4)
  })

  test('accepts bare dailyActivity date keys', () => {
    // lastSessionDate can be derived from dailyActivity, which stores YYYY-MM-DD.
    expect(inclusiveCalendarDaySpan('2026-07-13', '2026-07-15')).toBe(3)
  })

  test('returns 0 for parseable but malformed persisted dates', () => {
    // Date.parse accepts all of these, silently producing a misleading span:
    // "2026-07" -> Jul 1, "2026" -> Jan 1, "123" -> year 0123, and a
    // non-ISO locale format. None is a shape this pipeline ever persists.
    for (const bad of ['2026-07', '2026', '123', '01/01/2026']) {
      expect(inclusiveCalendarDaySpan(bad, '2026-07-15T06:00:00.000Z')).toBe(0)
      expect(inclusiveCalendarDaySpan('2026-07-13T06:00:00.000Z', bad)).toBe(0)
    }
  })

  test('is 1 for identical timestamps', () => {
    const t = '2026-07-13T12:00:00.000Z'
    expect(inclusiveCalendarDaySpan(t, t)).toBe(1)
  })

  test('counts exactly two days for adjacent calendar days', () => {
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T23:59:59.000Z',
        '2026-07-14T00:00:01.000Z',
      ),
    ).toBe(2)
  })

  test('returns 0 instead of throwing on an unparseable persisted date', () => {
    // A same-version stats cache can carry a corrupt firstSessionDate/last date
    // (e.g. "not-a-date"). Feeding that to toDateString → toISOString throws
    // RangeError and aborts /stats; the helper must degrade to 0 for either end.
    expect(() =>
      inclusiveCalendarDaySpan('not-a-date', '2026-07-15T06:00:00.000Z'),
    ).not.toThrow()
    expect(
      inclusiveCalendarDaySpan('not-a-date', '2026-07-15T06:00:00.000Z'),
    ).toBe(0)
    expect(
      inclusiveCalendarDaySpan('2026-07-13T22:00:00.000Z', 'not-a-date'),
    ).toBe(0)
    expect(inclusiveCalendarDaySpan('not-a-date', 'also-bad')).toBe(0)
  })

  test('returns 0 for impossible calendar dates instead of normalizing them', () => {
    // Date.parse rolls 2026-02-30 over to March 2, so a date-shaped-prefix
    // guard alone would fabricate a span (this exact pair returned 1) instead
    // of taking the documented 0 fallback.
    expect(inclusiveCalendarDaySpan('2026-02-30', '2026-03-02')).toBe(0)
    expect(inclusiveCalendarDaySpan('2026-07-13', '2026-13-01')).toBe(0)
    expect(inclusiveCalendarDaySpan('2026-00-10', '2026-07-13')).toBe(0)
    expect(inclusiveCalendarDaySpan('2026-07-00', '2026-07-13')).toBe(0)
    expect(inclusiveCalendarDaySpan('2026-04-31', '2026-05-01')).toBe(0)
  })

  test('rejects February 29 only in non-leap years', () => {
    // Non-leap 2026: impossible, must not normalize to March 1.
    expect(inclusiveCalendarDaySpan('2026-02-29', '2026-03-01')).toBe(0)
    // Leap 2024: a real day, spans inclusively to March 1.
    expect(inclusiveCalendarDaySpan('2024-02-29', '2024-03-01')).toBe(2)
  })

  test('rejects timestamps that are not one of the two persisted shapes', () => {
    // Space-delimited: Date.parse would read this as host-local time, so the
    // span would depend on the machine's timezone instead of falling back to 0.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13 23:30:00',
        '2026-07-14T00:30:00.000Z',
      ),
    ).toBe(0)
    // ISO shape with no zone designator is equally ambiguous.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T23:30:00',
        '2026-07-14T00:30:00.000Z',
      ),
    ).toBe(0)
    // Trailing junk after a valid instant.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T23:30:00.000Zjunk',
        '2026-07-14T00:30:00.000Z',
      ),
    ).toBe(0)
  })

  test('accepts valid ISO spellings the ingestion path persists', () => {
    // processSessionFiles stores whatever original string `new Date(...)`
    // accepted, so seconds may be omitted and a numeric offset may drop its
    // colon. Narrowing the validator to require both counted the session in
    // dailyActivity yet returned a 0 span, so /stats read zero total days for
    // genuine multi-day activity.
    expect(
      inclusiveCalendarDaySpan('2026-07-13T12:00Z', '2026-07-14T12:00Z'),
    ).toBe(2)
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T12:00:00+0000',
        '2026-07-15T00:00:00+0000',
      ),
    ).toBe(3)
    // Second-less form with an offset, and fractional seconds, both accepted.
    expect(
      inclusiveCalendarDaySpan('2026-07-13T23:30+05:30', '2026-07-14T00:30Z'),
    ).toBe(2)
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T00:00:00.5Z',
        '2026-07-13T23:00:00.250Z',
      ),
    ).toBe(1)
  })

  test('accepts a UTC offset instant as well as Z', () => {
    // 2026-07-13T23:30+05:30 is 2026-07-13T18:00Z, so these endpoints span
    // exactly two UTC calendar days. Asserting the value rather than just
    // "positive" means a regression back to 1 is caught.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T23:30:00+05:30',
        '2026-07-14T00:30:00.000Z',
      ),
    ).toBe(2)
  })

  test('returns 0 for out-of-range clock components', () => {
    // Date.parse normalizes T24:00:00 to midnight the next day, so a corrupt
    // persisted timestamp would shift the span by a day rather than take the
    // documented 0 fallback.
    expect(
      inclusiveCalendarDaySpan(
        '2026-07-13T24:00:00.000Z',
        '2026-07-14T00:00:00.000Z',
      ),
    ).toBe(0)
    for (const bad of [
      '2026-07-13T25:00:00.000Z',
      '2026-07-13T12:60:00.000Z',
      '2026-07-13T12:00:60.000Z',
      '2026-07-13T12:00:00+24:00',
      '2026-07-13T12:00:00+05:60',
    ]) {
      expect(inclusiveCalendarDaySpan(bad, '2026-07-15T06:00:00.000Z')).toBe(0)
    }
  })
})

describe('comparePersistedDates', () => {
  test('orders offset instants by the moment they denote, not by string', () => {
    // 2026-07-13T23:30:00-10:00 is 2026-07-14T09:30Z; 2026-07-14T00:00:00+14:00
    // is 2026-07-13T10:00Z. String order gets this exactly backwards, so the
    // later instant was selected as firstSessionDate and the span collapsed to
    // 0 for two sessions occupying different UTC days.
    const earlier = '2026-07-14T00:00:00+14:00'
    const later = '2026-07-13T23:30:00-10:00'
    // String order puts the chronologically earlier instant last -- that
    // inversion is the bug.
    expect(earlier > later).toBe(true)
    expect(comparePersistedDates(earlier, later)).toBeLessThan(0)
    expect(comparePersistedDates(later, earlier)).toBeGreaterThan(0)
    // Selected chronologically, the pair spans UTC July 13 and 14.
    expect(inclusiveCalendarDaySpan(earlier, later)).toBe(2)
  })

  test('orders same-zone instants and bare date keys', () => {
    expect(
      comparePersistedDates(
        '2026-07-13T01:00:00.000Z',
        '2026-07-13T20:00:00.000Z',
      ),
    ).toBeLessThan(0)
    expect(comparePersistedDates('2026-07-13', '2026-07-15')).toBeLessThan(0)
    const same = '2026-07-13T12:00:00.000Z'
    expect(comparePersistedDates(same, same)).toBe(0)
  })

  test('stays deterministic when a value is not parseable', () => {
    // The span helper rejects corrupt values separately; selection must still
    // be total and stable rather than depending on NaN comparisons.
    // Falls back to string order, which is at least total and antisymmetric.
    expect(comparePersistedDates('not-a-date', '2026-07-13')).toBeGreaterThan(0)
    expect(comparePersistedDates('2026-07-13', 'not-a-date')).toBeLessThan(0)
    expect(comparePersistedDates('not-a-date', 'not-a-date')).toBe(0)
  })
})
describe('mergeCacheWithNewStats first-session selection', () => {
  // The cache writer is the companion to the endpoint selection above: what it
  // stores is what a later cached /stats run reads back, and at that point
  // there is no session list left to correct it.
  function emptyCache(): PersistedStatsCache {
    return {
      version: STATS_CACHE_VERSION,
      lastComputedDate: '2026-07-12',
      dailyActivity: [],
      dailyModelTokens: [],
      modelUsage: {},
      totalSessions: 0,
      totalMessages: 0,
      longestSession: null,
      firstSessionDate: null,
      hourCounts: {},
      totalSpeculationTimeSavedMs: 0,
    } as PersistedStatsCache
  }

  function session(timestamp: string): SessionStats {
    return { sessionId: timestamp, duration: 1, messageCount: 1, timestamp }
  }

  function mergeSessions(timestamps: string[]): string | null {
    return mergeCacheWithNewStats(
      emptyCache(),
      {
        dailyActivity: [],
        dailyModelTokens: [],
        modelUsage: {},
        sessionStats: timestamps.map(session),
        hourCounts: {},
        totalSpeculationTimeSavedMs: 0,
      },
      '2026-07-14',
    ).firstSessionDate
  }

  test('stores the chronologically first session across mixed offsets', () => {
    // +14:00 is UTC July 13, -10:00 is UTC July 14, but string order ranks them
    // the other way round -- so the lexical pick stored the later instant and a
    // later cached run reported one day for two UTC dates.
    const utcJuly13 = '2026-07-14T00:00:00+14:00'
    const utcJuly14 = '2026-07-13T23:30:00-10:00'
    expect(mergeSessions([utcJuly14, utcJuly13])).toBe(utcJuly13)
    expect(mergeSessions([utcJuly13, utcJuly14])).toBe(utcJuly13)
  })

  test('keeps an existing cached first date when it is genuinely earlier', () => {
    const cache = { ...emptyCache(), firstSessionDate: '2026-07-01T00:00:00Z' }
    const merged = mergeCacheWithNewStats(
      cache,
      {
        dailyActivity: [],
        dailyModelTokens: [],
        modelUsage: {},
        sessionStats: [session('2026-07-13T12:00:00.000Z')],
        hourCounts: {},
        totalSpeculationTimeSavedMs: 0,
      },
      '2026-07-14',
    )
    expect(merged.firstSessionDate).toBe('2026-07-01T00:00:00Z')
  })

  test('same-zone timestamps are unaffected', () => {
    expect(
      mergeSessions(['2026-07-13T20:00:00.000Z', '2026-07-13T01:00:00.000Z']),
    ).toBe('2026-07-13T01:00:00.000Z')
  })

  test('replaces a corrupt cached first date that lexical order never heals', () => {
    // A persisted seed like "1" is unparseable and sorts lexically BEFORE every
    // real timestamp, so comparePersistedDates alone never displaces it -- the
    // corruption (and the wrong totalDays it drives) survives every later run.
    // The NaN guard treats it as absent so the first valid session date wins.
    for (const corrupt of ['1', '0000', 'not-a-date']) {
      const cache = { ...emptyCache(), firstSessionDate: corrupt }
      const merged = mergeCacheWithNewStats(
        cache,
        {
          dailyActivity: [],
          dailyModelTokens: [],
          modelUsage: {},
          sessionStats: [session('2026-07-13T12:00:00.000Z')],
          hourCounts: {},
          totalSpeculationTimeSavedMs: 0,
        },
        '2026-07-14',
      )
      expect(merged.firstSessionDate).toBe('2026-07-13T12:00:00.000Z')
    }
  })
})
