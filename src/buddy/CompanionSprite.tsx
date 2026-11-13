import figures from 'figures'
import React, { useEffect, useState } from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
// Raw ink Text (not the themed wrapper): pixel art needs arbitrary rgb()
// values for BOTH foreground and background, and ThemedText only accepts
// theme keys for backgroundColor.
import RawText from '../ink/components/Text.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text, useAnimationFrame } from '../ink.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import { getGlobalConfig } from '../utils/config.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import type { Theme } from '../utils/theme.js'
import { effectTotalMs, getActionEffect } from './actionEffects.js'
import { getCompanion } from './companion.js'
import { isBuddyEnabled } from './feature.js'
import {
  HERO_SPRITE_COLS,
  heroSpriteRows,
  isPixelColorCapable,
  type PixelRun,
} from './heroArt.js'
import {
  actionPoseTime,
  type MoodClock,
  moodFrameMs,
  resolveMood,
  startMoodClock,
} from './heroMoods.js'
import {
  renderFace,
  renderShootSprite,
  renderSprite,
  shootFrameCount,
  spriteFrameCount,
} from './sprites.js'
import { companionColor } from './types.js'
import { useShotClock } from './useShotClock.js'

/** Sprite pose index during the effect's draw phase; clamps to the release
 *  pose while the projectile travels. Pose count derives from the actual
 *  frame set so heroes with more/fewer poses animate correctly. */
function drawPoseIndex(
  drawMs: number,
  elapsedMs: number,
  poseCount: number,
): number {
  if (poseCount <= 1) return 0
  return Math.min(
    poseCount - 1,
    Math.max(0, Math.floor(elapsedMs / (drawMs / poseCount))),
  )
}

const TICK_MS = 500
const BUBBLE_SHOW = 20 // ticks → ~10s at 500ms
const FADE_WINDOW = 6 // last ~3s the bubble dims so you know it's about to go
const PET_BURST_MS = 2500 // how long hearts float after /buddy pet
const DANCE_MS = 6000 // how long /buddy dance lasts

// Notes bob above the line-art sprite while it dances (hero art draws its own).
const DANCE_NOTES = [
  '  ♪      ♫  ',
  '    ♫  ♪    ',
  ' ♫    ♪   ♪ ',
  '   ♪   ♫    ',
]

// Idle sequence: mostly rest (frame 0), occasional fidget (frames 1-2), rare blink.
// Sequence indices map to sprite frames; -1 means "blink on frame 0".
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]

// Hearts float up-and-out over 5 ticks (~2.5s). Prepended above the sprite.
const H = figures.heart
const PET_HEARTS = [
  `   ${H}    ${H}   `,
  `  ${H}  ${H}   ${H}  `,
  ` ${H}   ${H}  ${H}   `,
  `${H}  ${H}      ${H} `,
  '·    ·   ·  ',
]

function wrap(text: string, width: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur.length + w.length + 1 > width && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = cur ? `${cur} ${w}` : w
    }
  }
  if (cur) lines.push(cur)
  return lines
}

function SpeechBubble({
  text,
  color,
  fading,
  tail,
}: {
  text: string
  color: keyof Theme
  fading: boolean
  tail: 'right' | 'down'
}): React.ReactNode {
  const lines = wrap(text, 30)
  const borderColor = fading ? 'inactive' : color
  const bubble = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={34}
    >
      {lines.map((l, i) => (
        <Text
          key={i}
          italic
          dimColor={!fading}
          color={fading ? 'inactive' : undefined}
        >
          {l}
        </Text>
      ))}
    </Box>
  )
  if (tail === 'right') {
    return (
      <Box flexDirection="row" alignItems="center">
        {bubble}
        <Text color={borderColor}>─</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" alignItems="flex-end" marginRight={1}>
      {bubble}
      <Box flexDirection="column" alignItems="flex-end" paddingRight={6}>
        <Text color={borderColor}>╲ </Text>
        <Text color={borderColor}>╲</Text>
      </Box>
    </Box>
  )
}

export const MIN_COLS_FOR_FULL_SPRITE = 100
const SPRITE_BODY_WIDTH = 12
const NAME_ROW_PAD = 2 // focused state wraps name in spaces: ` name `
const SPRITE_PADDING_X = 2
const BUBBLE_WIDTH = 36 // SpeechBubble box (34) + tail column
const NARROW_QUIP_CAP = 24

function spriteColWidth(nameWidth: number): number {
  return Math.max(SPRITE_BODY_WIDTH, nameWidth + NAME_ROW_PAD)
}

// Width the sprite area consumes. PromptInput subtracts this so text wraps
// correctly. In fullscreen the bubble floats over scrollback (no extra
// width); in non-fullscreen it sits inline and needs BUBBLE_WIDTH more.
// Narrow terminals: 0 — REPL.tsx stacks the one-liner on its own row
// (above input in fullscreen, below in scrollback), so no reservation.
// Pixel mode depends only on terminal color support (every form has hero
// art), so the reservation math and the sprite renderer can never disagree.
function pixelModeActive(): boolean {
  return isPixelColorCapable()
}

// Single source of truth for the sprite column width — used by BOTH the
// reservation math and the renderer so they cannot drift.
function companionColumnWidth(companion: { name: string }): number {
  const base = spriteColWidth(stringWidth(companion.name))
  return pixelModeActive() ? Math.max(base, HERO_SPRITE_COLS) : base
}

export function companionReservedColumns(
  terminalColumns: number,
  speaking: boolean,
): number {
  if (!isBuddyEnabled()) return 0
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return 0
  if (terminalColumns < MIN_COLS_FOR_FULL_SPRITE) return 0
  const bubble = speaking && !isFullscreenActive() ? BUBBLE_WIDTH : 0
  return companionColumnWidth(companion) + SPRITE_PADDING_X + bubble
}

function PixelRows({ rows }: { rows: PixelRun[][] }): React.ReactNode {
  return (
    <>
      {rows.map((runs, i) => (
        <RawText key={i} wrap="truncate">
          {runs.map((run, j) => (
            <RawText
              key={j}
              color={run.color}
              backgroundColor={run.backgroundColor}
            >
              {run.text}
            </RawText>
          ))}
        </RawText>
      ))}
    </>
  )
}

// React.memo: this file ships as plain source (not committed react-compiler
// output), and REPL re-renders it per keystroke. The mood clock prop only
// changes identity when the agent's activity changes, so memo still skips
// those re-renders; animation re-renders come from the component's own clock
// subscriptions and are unaffected.
type CompanionSpriteProps = {
  /** The agent's activity over time, from useCompanionMoodClock in the REPL.
   *  Owned there because this sprite unmounts while dialogs cover the prompt. */
  moodClock?: MoodClock
}

export const CompanionSprite = React.memo(function CompanionSprite({
  moodClock: sessionMoodClock,
}: CompanionSpriteProps): React.ReactNode {
  const reaction = useAppState(s => s.companionReaction)
  const petAt = useAppState(s => s.companionPetAt)
  const danceAt = useAppState(s => s.companionDanceAt)
  // Subscribed only so a /buddy config change (mute, set, name) redraws the
  // sprite: getCompanion() and companionMuted are read non-reactively below,
  // and the clock that would otherwise pick them up is paused under reduced
  // motion and while hidden.
  useAppState(s => s.companionConfigVersion)
  const shotAt = useAppState(s => s.companionShotAt)
  const focused = useAppState(s => s.footerSelection === 'companion')
  const setAppState = useSetAppState()
  const { columns } = useTerminalSize()
  const settings = useSettings()
  const reducedMotion = settings?.prefersReducedMotion === true

  // Plain reads (not hooks) — safe before the early returns below, and
  // needed up here so the clock subscription can pause when hidden.
  const companion = isBuddyEnabled() ? getCompanion() : undefined
  const hidden = !companion || getGlobalConfig().companionMuted === true

  // Hero art animates faster than the line-art fallback, and busier moods
  // faster than calm ones. The interval follows the mood resolved on the
  // previous render (sync-during-render below keeps it current).
  const [frameMs, setFrameMs] = useState(TICK_MS)

  // Shared animation clock. Paused entirely when the sprite is hidden or the
  // user prefers reduced motion (time freezes, so reduced-motion renders
  // below must not derive frames from it).
  const [, time] = useAnimationFrame(hidden || reducedMotion ? null : frameMs)
  const tick = Math.floor(time / TICK_MS)

  // Without a session clock (rendered outside the REPL), stay idle.
  const [idleMoodClock] = useState<MoodClock>(() => startMoodClock('idle', time))
  const moodClock = sessionMoodClock ?? idleMoodClock

  // A token seen at mount is from before this mount: it never starts a dance.
  const [{ danceStartTime, forDanceAt }, setDanceStart] = useState({
    danceStartTime: Number.NEGATIVE_INFINITY,
    forDanceAt: danceAt,
  })
  if (danceAt !== forDanceAt) {
    setDanceStart({ danceStartTime: time, forDanceAt: danceAt })
  }

  // Sync-during-render (not useEffect) so the first post-pet render already
  // has petStartTime=time and petAge=0 — otherwise frame 0 is skipped.
  const [{ petStartTime, forPetAt }, setPetStart] = useState({
    petStartTime: 0,
    forPetAt: petAt,
  })
  if (petAt !== forPetAt) {
    setPetStart({ petStartTime: time, forPetAt: petAt })
  }

  // Bubble age uses the same sync-during-render pattern (a ref updated in an
  // effect would leave the FIRST render of a new reaction reading the
  // previous bubble's age — a fresh bubble could appear already faded).
  const [{ spokeTime, forSpoken }, setSpoke] = useState({
    spokeTime: 0,
    forSpoken: reaction,
  })
  if (reaction !== forSpoken) {
    setSpoke({ spokeTime: time, forSpoken: reaction })
  }

  // Signature action: a 50ms burst clock that runs only while a shot is live.
  const actionFx =
    companion !== undefined ? getActionEffect(companion.species) : undefined
  const shotEligible =
    !hidden &&
    !reducedMotion &&
    actionFx !== undefined &&
    columns >= MIN_COLS_FOR_FULL_SPRITE
  // Pass shotAt UNCONDITIONALLY — the hook consumes tokens even while
  // ineligible so a stale token can't replay after remount/eligibility
  // flips (see useShotClock docs).
  const shotElapsed = useShotClock(
    shotAt,
    shotEligible,
    actionFx !== undefined ? effectTotalMs(actionFx) : 0,
  )

  useEffect(() => {
    if (!reaction) return
    const timer = setTimeout(
      setA =>
        setA((prev: AppState) =>
          prev.companionReaction === undefined
            ? prev
            : { ...prev, companionReaction: undefined },
        ),
      BUBBLE_SHOW * TICK_MS,
      setAppState,
    )
    return () => clearTimeout(timer)
  }, [reaction, setAppState])

  if (!companion || hidden) return null

  const color = companionColor(companion)
  const colWidth = companionColumnWidth(companion)
  const pixelMode = pixelModeActive()
  const bubbleAgeMs =
    reaction !== undefined && reaction === forSpoken ? time - spokeTime : 0
  const fading =
    !reducedMotion &&
    reaction !== undefined &&
    bubbleAgeMs >= (BUBBLE_SHOW - FADE_WINDOW) * TICK_MS
  const petAgeMs = petAt !== undefined ? time - petStartTime : Infinity
  const petting = !reducedMotion && petAgeMs < PET_BURST_MS
  const shooting = shotElapsed !== null
  // Frozen under reduced motion, so a dance would never end; /buddy dance
  // says so instead.
  const dancing = !reducedMotion && time - danceStartTime < DANCE_MS
  const fullSprite = columns >= MIN_COLS_FOR_FULL_SPRITE
  const mood = resolveMood(moodClock, {
    now: time,
    shooting: shooting && actionFx !== undefined,
    petting,
    dancing,
    speaking: reaction !== undefined,
    reducedMotion,
  })
  // Only the full hero sprite needs the faster mood clock; the line-art and
  // narrow-face fallbacks keep the original idle cadence.
  const wantFrameMs = pixelMode && fullSprite ? moodFrameMs(mood) : TICK_MS
  if (wantFrameMs !== frameMs) {
    setFrameMs(wantFrameMs)
  }

  // Narrow terminals: collapse to one-line face. When speaking, the quip
  // replaces the name beside the face (no room for a bubble).
  if (!fullSprite) {
    const quip =
      reaction && reaction.length > NARROW_QUIP_CAP
        ? reaction.slice(0, NARROW_QUIP_CAP - 1) + '…'
        : reaction
    const label = quip
      ? `"${quip}"`
      : focused
        ? ` ${companion.name} `
        : companion.name
    return (
      <Box paddingX={1} alignSelf="flex-end">
        <Text>
          {petting && <Text color="autoAccept">{figures.heart} </Text>}
          {dancing && !petting && <Text color={color}>♪ </Text>}
          <Text bold color={color}>
            {renderFace(companion)}
          </Text>{' '}
          <Text
            italic
            dimColor={!focused && !reaction}
            bold={focused}
            inverse={focused && !reaction}
            color={
              reaction
                ? fading
                  ? 'inactive'
                  : color
                : focused
                  ? color
                  : undefined
            }
          >
            {label}
          </Text>
        </Text>
      </Box>
    )
  }

  const frameCount = spriteFrameCount(companion.species)
  // Hearts or notes float above the line-art sprite; hero art draws its own.
  const heartFrame =
    petting && !pixelMode
      ? PET_HEARTS[Math.floor(petAgeMs / TICK_MS) % PET_HEARTS.length]
      : null
  const noteFrame =
    dancing && !petting && !pixelMode
      ? DANCE_NOTES[tick % DANCE_NOTES.length]
      : null
  const overlayFrame = heartFrame ?? noteFrame

  // Shared frame selection for both render modes.
  let idleStep = 0
  let blink = false
  if (!reducedMotion && !shooting) {
    if (reaction || petting || dancing) {
      // Excited: cycle all fidget frames fast
      idleStep = tick % frameCount
    } else {
      const step = IDLE_SEQUENCE[tick % IDLE_SEQUENCE.length]!
      if (step === -1) {
        blink = true
      } else {
        idleStep = step % frameCount
      }
    }
  }

  let pixelRows: PixelRun[][] | null = null
  let sprite: string[] = []
  if (pixelMode) {
    const t =
      shooting && actionFx !== undefined
        ? actionPoseTime(shotElapsed, actionFx)
        : time / 1000
    pixelRows = heroSpriteRows(companion.species, mood, t)
  } else {
    let body: string[]
    if (shooting && actionFx !== undefined) {
      // Draw/cast poses; clamps to the release pose while the effect flies.
      body = renderShootSprite(
        companion,
        drawPoseIndex(
          actionFx.drawMs,
          shotElapsed,
          shootFrameCount(companion.species),
        ),
      )
    } else {
      body = renderSprite(companion, idleStep).map(line =>
        blink ? line.replaceAll(companion.eye, '-') : line,
      )
    }
    sprite = overlayFrame ? [overlayFrame, ...body] : body
  }

  // Name row doubles as hint row — unfocused shows dim name + ↓ discovery,
  // focused shows inverse name. The enter-to-open hint lives in
  // PromptInputFooter's right column so this row stays one line and the
  // sprite doesn't jump up when selected. flexShrink=0 stops the
  // inline-bubble row wrapper from squeezing the sprite to fit.
  const spriteColumn = (
    <Box
      flexDirection="column"
      flexShrink={0}
      alignItems="center"
      width={colWidth}
    >
      {pixelRows !== null ? (
        <PixelRows rows={pixelRows} />
      ) : (
        sprite.map((line, i) => (
          <Text key={i} color={i === 0 && heartFrame ? 'autoAccept' : color}>
            {line}
          </Text>
        ))
      )}
      <Text
        italic
        bold={focused}
        dimColor={!focused}
        color={focused ? color : undefined}
        inverse={focused}
      >
        {focused ? ` ${companion.name} ` : companion.name}
      </Text>
    </Box>
  )

  if (!reaction) {
    return <Box paddingX={1}>{spriteColumn}</Box>
  }

  // Fullscreen: bubble renders separately via CompanionFloatingBubble in
  // FullscreenLayout's bottomFloat slot (the bottom slot's overflowY:hidden
  // would clip a position:absolute overlay here). Sprite body only.
  // Non-fullscreen: bubble sits inline beside the sprite (input shrinks)
  // because floating into Static scrollback can't be cleared.
  if (isFullscreenActive()) {
    return <Box paddingX={1}>{spriteColumn}</Box>
  }
  return (
    <Box flexDirection="row" alignItems="flex-end" paddingX={1} flexShrink={0}>
      <SpeechBubble text={reaction} color={color} fading={fading} tail="right" />
      {spriteColumn}
    </Box>
  )
})

// Floating bubble overlay for fullscreen mode. Mounted in FullscreenLayout's
// bottomFloat slot (outside the overflowY:hidden clip) so it can extend into
// the ScrollBox region. CompanionSprite owns the clear-after-10s timer; this
// just reads companionReaction and renders the fade.
export const CompanionFloatingBubble = React.memo(
  function CompanionFloatingBubble(): React.ReactNode {
  const reaction = useAppState(s => s.companionReaction)
  const settings = useSettings()
  const reducedMotion = settings?.prefersReducedMotion === true
  const [, time] = useAnimationFrame(
    reaction && !reducedMotion ? TICK_MS : null,
  )
  const [{ start, forReaction }, setStart] = useState({
    start: 0,
    forReaction: reaction,
  })
  if (reaction !== forReaction) {
    setStart({ start: time, forReaction: reaction })
  }
  if (!isBuddyEnabled() || !reaction) return null
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return null
  const fading =
    !reducedMotion &&
    reaction === forReaction &&
    time - start >= (BUBBLE_SHOW - FADE_WINDOW) * TICK_MS
  return (
    <SpeechBubble
      text={reaction}
      color={companionColor(companion)}
      fading={fading}
      tail="down"
    />
  )
  },
)
