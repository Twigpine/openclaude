import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

// A real path whose parent directory does not exist, so the tool's writeFile()
// rejects with a genuine ENOENT. Using this instead of mocking the core
// fs/promises module keeps the write-failure tests isolated — mock.module() on
// a core module is process-global and can leak into other files.
function makeUnwritablePlanPath(): string {
  return join(tmpdir(), `oc-exitplan-missing-${Date.now()}-${Math.random()}`, 'plan.md')
}

function planPathForAgent(basePath: string, agentId?: string): string {
  return agentId ? basePath.replace(/\.md$/, `-agent-${agentId}.md`) : basePath
}
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  setDynamicTeamContext,
  clearDynamicTeamContext,
} from '../../utils/teammate.js'

type ExitPlanModeModule = typeof import('./ExitPlanModeV2Tool.js')
type ExitPlanModeTool = ExitPlanModeModule['ExitPlanModeV2Tool']

let ExitPlanModeV2Tool: ExitPlanModeTool | undefined
let actualPlans: any
let actualTeammateMailbox: any

beforeAll(async () => {
  await acquireSharedMutationLock(
    'tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts',
  )

  const nonce = `${Date.now()}-${Math.random()}`
  actualPlans = { ...await import(`../../utils/plans.js?real=${nonce}`) }
  actualTeammateMailbox = {
    ...await import(`../../utils/teammateMailbox.js?real=${nonce}`),
  }

  mock.module('../../utils/plans.js', () => ({
    ...actualPlans,
    getPlanFilePath: (agentId?: string) =>
      planPathForAgent('/tmp/test-plan.md', agentId),
    getPlan: () => 'plan content',
    persistFileSnapshotIfRemote: () => Promise.resolve(),
  }))

  const mod = await import(
    `./ExitPlanModeV2Tool.ts?exitPlanModeWriteTest=${Date.now()}-${Math.random()}`
  )
  ExitPlanModeV2Tool = mod.ExitPlanModeV2Tool
})

afterAll(async () => {
  try {
    mock.restore()
    clearDynamicTeamContext()
    // Restore mock modules back to their actual implementations
    mock.module('../../utils/plans.js', () => actualPlans)
    mock.module('../../utils/teammateMailbox.js', () => actualTeammateMailbox)
  } finally {
    releaseSharedMutationLock()
  }
})

function makeCtx() {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    agentId: undefined,
    options: { isNonInteractiveSession: false, tools: [] },
    getAppState: () => ({ toolPermissionContext } as never),
    setAppState: () => undefined,
    setToolJSX: undefined,
    toolUseId: 'test-exit-plan-mode',
    addNotification: undefined,
  } as never
}

test('surfaces write error when plan file write fails and asserts no side effects (standard)', async () => {
  const persistFileSnapshotIfRemoteMock = mock(() => Promise.resolve())
  const unwritablePlanPath = makeUnwritablePlanPath()
  mock.module('../../utils/plans.js', () => ({
    ...actualPlans,
    getPlanFilePath: (agentId?: string) =>
      planPathForAgent(unwritablePlanPath, agentId),
    getPlan: () => 'plan content',
    persistFileSnapshotIfRemote: persistFileSnapshotIfRemoteMock,
  }))

  clearDynamicTeamContext()

  const setAppStateMock = mock(() => undefined)
  const toolPermissionContext = getEmptyToolPermissionContext()
  const ctx = {
    abortController: new AbortController(),
    agentId: undefined,
    options: { isNonInteractiveSession: false, tools: [] },
    getAppState: () => ({ toolPermissionContext } as never),
    setAppState: setAppStateMock,
    setToolJSX: undefined,
    toolUseId: 'test-exit-plan-mode',
    addNotification: undefined,
  } as never

  const mod = await import(
    `./ExitPlanModeV2Tool.ts?test1=${Date.now()}-${Math.random()}`
  )

  try {
    // The real writeFile rejects (ENOENT — parent dir is missing). The tool
    // must surface that error and run none of the post-write side effects.
    await expect(
      mod.ExitPlanModeV2Tool.call(
        { plan: 'edited plan content' } as never,
        ctx,
        (() => Promise.resolve({ behavior: 'allow' })) as never,
        {} as never,
      ),
      // Assert the specific ENOENT write failure (missing parent dir) rather
      // than any error, so the test locks in the intended failure behavior.
    ).rejects.toThrow(/ENOENT/)

    expect(persistFileSnapshotIfRemoteMock).not.toHaveBeenCalled()
    expect(setAppStateMock).not.toHaveBeenCalled()
  } finally {
    mock.restore()
    clearDynamicTeamContext()
    mock.module('../../utils/plans.js', () => actualPlans)
  }
})

test('surfaces write error when plan file write fails and asserts no teammate approval side effects', async () => {
  const persistFileSnapshotIfRemoteMock = mock(() => Promise.resolve())
  const unwritablePlanPath = makeUnwritablePlanPath()
  mock.module('../../utils/plans.js', () => ({
    ...actualPlans,
    getPlanFilePath: (agentId?: string) =>
      planPathForAgent(unwritablePlanPath, agentId),
    getPlan: () => 'plan content',
    persistFileSnapshotIfRemote: persistFileSnapshotIfRemoteMock,
  }))

  setDynamicTeamContext({
    agentId: 'test-agent',
    agentName: 'test-agent',
    teamName: 'test-team',
    planModeRequired: true,
  })

  const writeToMailboxMock = mock(() => Promise.resolve())
  mock.module('../../utils/teammateMailbox.js', () => ({
    writeToMailbox: writeToMailboxMock,
  }))

  const setAppStateMock = mock(() => undefined)
  const toolPermissionContext = getEmptyToolPermissionContext()
  const ctx = {
    abortController: new AbortController(),
    agentId: undefined,
    options: { isNonInteractiveSession: false, tools: [] },
    getAppState: () => ({ toolPermissionContext } as never),
    setAppState: setAppStateMock,
    setToolJSX: undefined,
    toolUseId: 'test-exit-plan-mode',
    addNotification: undefined,
  } as never

  const mod = await import(
    `./ExitPlanModeV2Tool.ts?test2=${Date.now()}-${Math.random()}`
  )

  try {
    // The real writeFile rejects (ENOENT — parent dir is missing). The tool
    // must surface that error before sending any teammate approval request.
    await expect(
      mod.ExitPlanModeV2Tool.call(
        { plan: 'edited plan content' } as never,
        ctx,
        (() => Promise.resolve({ behavior: 'allow' })) as never,
        {} as never,
      ),
      // Assert the specific ENOENT write failure (missing parent dir) rather
      // than any error, so the test locks in the intended failure behavior.
    ).rejects.toThrow(/ENOENT/)

    expect(persistFileSnapshotIfRemoteMock).not.toHaveBeenCalled()
    expect(writeToMailboxMock).not.toHaveBeenCalled()
    expect(setAppStateMock).not.toHaveBeenCalled()
  } finally {
    mock.restore()
    clearDynamicTeamContext()
    mock.module('../../utils/plans.js', () => actualPlans)
    mock.module('../../utils/teammateMailbox.js', () => actualTeammateMailbox)
  }
})
