import { PassThrough } from 'node:stream'

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React, { useEffect } from 'react'
import stripAnsi from 'strip-ansi'

import { Box, createRoot, Text } from '../../../../ink.js'
import { WizardProvider, useWizard } from '../../../wizard/index.js'
import type { AgentWizardData } from '../types.js'

// Copy real exports before mock.module can replace live module bindings.
const nonce = `${Date.now()}-${Math.random()}`
const realColorPicker = {
  ...await import(`../../ColorPicker.js?real=${nonce}`),
}
const realSelect = {
  ...await import(`../../../CustomSelect/select.js?real=${nonce}`),
}

type ColorPickerProps = {
  onConfirm: (color: string | undefined) => void
}

type SelectProps = {
  onChange?: (value: string) => void
}

type WizardSnapshot = {
  currentStepIndex: number
  wizardData: AgentWizardData
}

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

let latestColorPickerProps: ColorPickerProps | undefined
let latestSelectProps: SelectProps | undefined

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createTestStreams() {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, getOutput: () => output }
}

async function waitFor<T>(
  getValue: () => T | undefined,
  message: string,
): Promise<T> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 2500) {
    const value = getValue()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }

  throw new Error(message)
}

function StateProbe({
  onSnapshot,
}: {
  onSnapshot: (snapshot: WizardSnapshot) => void
}) {
  const { currentStepIndex, wizardData } = useWizard<AgentWizardData>()

  useEffect(() => {
    onSnapshot({ currentStepIndex, wizardData })
  }, [currentStepIndex, onSnapshot, wizardData])

  return null
}

async function renderWizardChild(
  child: React.ReactNode,
  initialData: AgentWizardData,
) {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let snapshot: WizardSnapshot | undefined

  root.render(
    <WizardProvider<AgentWizardData>
      steps={[_tempStep, _tempStep]}
      initialData={initialData}
      onComplete={() => {}}
    >
      <Box flexDirection="column">
        {child}
        <StateProbe
          onSnapshot={nextSnapshot => {
            snapshot = nextSnapshot
          }}
        />
      </Box>
    </WizardProvider>,
  )

  await waitFor(() => snapshot, 'Timed out waiting for wizard snapshot')

  return {
    root,
    stdin,
    stdout,
    getOutput,
    getSnapshot: () => snapshot,
  }
}

beforeEach(() => {
  latestColorPickerProps = undefined
  latestSelectProps = undefined
  mock.module('../../ColorPicker.js', () => ({
    ColorPicker: (props: ColorPickerProps) => {
      latestColorPickerProps = props
      return <Text>Color picker test double</Text>
    },
  }))
  mock.module('../../../CustomSelect/select.js', () => ({
    Select: (props: SelectProps) => {
      latestSelectProps = props
      return <Text>Memory select test double</Text>
    },
  }))
})

afterEach(() => {
  try {
    mock.restore()
  } finally {
    latestColorPickerProps = undefined
    latestSelectProps = undefined
  }
})

afterAll(() => {
  // mock.restore() does not remove Bun module mock registrations.
  mock.module('../../ColorPicker.js', () => realColorPicker)
  mock.module('../../../CustomSelect/select.js', () => realSelect)
})

test('ColorStep does not create a final agent when required wizard data is missing', async () => {
  const { ColorStep } =
    await importFreshStep<typeof import('./ColorStep.js')>('./ColorStep.js')
  const harness = await renderWizardChild(<ColorStep />, {
    agentType: 'reviewer',
    whenToUse: 'Use for reviews',
    systemPrompt: 'Review carefully',
  })

  try {
    const colorPickerProps = await waitFor(
      () => latestColorPickerProps,
      'Timed out waiting for color picker props',
    )

    colorPickerProps.onConfirm(undefined)
    await Bun.sleep(25)

    const snapshot = harness.getSnapshot()
    expect(snapshot?.currentStepIndex).toBe(0)
    expect(snapshot?.wizardData.finalAgent).toBeUndefined()
  } finally {
    harness.root.unmount()
    harness.stdin.end()
    harness.stdout.end()
  }
})

test('MemoryStep falls back to an empty system prompt when wizard data is incomplete', async () => {
  const { MemoryStep } =
    await importFreshStep<typeof import('./MemoryStep.js')>('./MemoryStep.js')
  const harness = await renderWizardChild(<MemoryStep />, {
    finalAgent: {
      agentType: 'reviewer',
      whenToUse: 'Use for reviews',
      getSystemPrompt: () => 'original prompt',
      source: 'userSettings',
    },
  })

  try {
    const selectProps = await waitFor(
      () => latestSelectProps,
      'Timed out waiting for memory select props',
    )

    selectProps.onChange?.('none')
    await Bun.sleep(25)

    const finalAgent = harness.getSnapshot()?.wizardData.finalAgent
    expect(finalAgent?.getSystemPrompt()).toBe('')
  } finally {
    harness.root.unmount()
    harness.stdin.end()
    harness.stdout.end()
  }
})

test('ConfirmStep renders a fallback instead of a blank screen for incomplete wizard data', async () => {
  const { ConfirmStep } =
    await importFreshStep<typeof import('./ConfirmStep.js')>('./ConfirmStep.js')
  const harness = await renderWizardChild(
    <ConfirmStep
      tools={[]}
      existingAgents={[]}
      onSave={() => {}}
      onSaveAndEdit={() => {}}
    />,
    {},
  )

  try {
    await waitFor(() => {
      const frame = stripAnsi(extractLastFrame(harness.getOutput()))
      return frame.includes('Agent draft is incomplete') ? frame : undefined
    }, 'Timed out waiting for incomplete agent draft fallback')
  } finally {
    harness.root.unmount()
    harness.stdin.end()
    harness.stdout.end()
  }
})

function _tempStep() {
  return null
}

async function importFreshStep<T>(specifier: string): Promise<T> {
  return import(
    `${specifier}?wizard-steps-test=${Date.now()}-${Math.random()}`
  ) as Promise<T>
}
