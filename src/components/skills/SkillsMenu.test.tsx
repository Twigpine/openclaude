import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import type { Command } from '../../commands.js'
import { createRoot } from '../../ink.js'
import { getSiblingSkillsHome } from '../../skills/siblingSkillHomes.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getUnloadedSiblingSkillsHint,
  groupSkillsForMenu,
  SkillsMenu,
} from './SkillsMenu.js'

type SkillCommand = Extract<Command, { type: 'prompt' }>

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

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
  ;(stdout as unknown as { columns: number }).columns = 140
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, getOutput: () => output }
}

async function waitForOutput(
  getOutput: () => string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 2500) {
    const frame = stripAnsi(extractLastFrame(getOutput()))
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for skills menu output')
}

function skill(
  name: string,
  source: SkillCommand['source'],
  siblingSkillsHome?: SkillCommand['siblingSkillsHome'],
): SkillCommand {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    progressMessage: 'running',
    contentLength: 0,
    source,
    loadedFrom: 'skills',
    siblingSkillsHome,
    async getPromptForCommand() {
      return []
    },
  }
}

const unloadedClaudeCodeHome = {
  home: getSiblingSkillsHome('claude-code'),
  count: 2,
}

beforeEach(async () => {
  await acquireSharedMutationLock('components/skills/SkillsMenu.test.tsx')
})

afterEach(() => {
  releaseSharedMutationLock()
})

test('groups sibling-home skills separately, after OpenClaude skills', () => {
  const groups = groupSkillsForMenu([
    skill('zeta', 'userSettings', 'agents'),
    skill('mine', 'userSettings'),
    skill('alpha', 'userSettings', 'agents'),
    skill('repo', 'projectSettings'),
    skill('cc', 'userSettings', 'claude-code'),
  ])

  expect(
    groups.map(group => ({
      key: group.key,
      title: group.title,
      skills: group.skills.map(s => s.name),
    })),
  ).toEqual([
    { key: 'projectSettings', title: 'Project skills', skills: ['repo'] },
    { key: 'userSettings', title: 'User skills', skills: ['mine'] },
    {
      key: 'sibling:agents',
      title: 'Shared agent skills',
      skills: ['alpha', 'zeta'],
    },
    {
      key: 'sibling:claude-code',
      title: 'Claude Code skills',
      skills: ['cc'],
    },
  ])
  expect(groups[2]?.subtitle).toBe('~/.agents/skills')
})

test('describes how to enable an unloaded sibling home', () => {
  expect(getUnloadedSiblingSkillsHint(unloadedClaudeCodeHome)).toBe(
    '2 skills in ~/.claude/skills aren\'t loaded — enable "Load skills from ~/.claude/skills" in /config',
  )
  expect(
    getUnloadedSiblingSkillsHint({ ...unloadedClaudeCodeHome, count: 1 }),
  ).toBe(
    '1 skill in ~/.claude/skills isn\'t loaded — enable "Load skills from ~/.claude/skills" in /config',
  )
})

test('renders sibling groups and the unloaded-home hint', async () => {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <SkillsMenu
      onExit={() => {}}
      commands={[
        skill('mine', 'userSettings'),
        skill('shared-tool', 'userSettings', 'agents'),
      ]}
      unloadedSiblingHomes={[unloadedClaudeCodeHome]}
    />,
  )

  try {
    const output = await waitForOutput(getOutput, frame =>
      frame.includes("aren't loaded"),
    )
    expect(output).toContain('2 skills')
    expect(output).toContain('Shared agent skills (~/.agents/skills)')
    expect(output).toContain('shared-tool')
    expect(output).toContain('mine')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})
