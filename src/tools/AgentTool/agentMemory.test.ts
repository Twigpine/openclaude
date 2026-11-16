import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getAgentMemoryRoot } from './agentMemory.js'

describe('getAgentMemoryRoot with CLAUDE_CODE_REMOTE_MEMORY_DIR', () => {
  // The configured base itself contains the agent-memory-local segment. The
  // generated layout is <base>/projects/<project>/agent-memory-local, so the
  // containment root must anchor at the segment below projects/, not at the
  // first marker occurrence inside the base.
  const remoteBase = join('/mnt', 'agent-memory-local', 'store')
  const projectsRoot = join(remoteBase, 'projects')
  const memoryDir = join(projectsRoot, 'my-project', 'agent-memory-local')
  let savedEnv: string | undefined

  beforeAll(async () => {
    await acquireSharedMutationLock('tools/AgentTool/agentMemory.test.ts')
    savedEnv = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = remoteBase
  })

  afterAll(() => {
    try {
      if (savedEnv === undefined) {
        delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
      } else {
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = savedEnv
      }
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('resolves the generated memory dir below the projects root', () => {
    expect(
      getAgentMemoryRoot(join(memoryDir, 'some-agent', 'MEMORY.md')),
    ).toBe(memoryDir)
  })

  test('a marker inside the configured base does not anchor the root', () => {
    // Before the fix this path resolved to the /mnt/agent-memory-local
    // prefix, letting a symlink under the real memory dir redirect writes
    // anywhere below the base.
    expect(
      getAgentMemoryRoot(join(projectsRoot, 'my-project', 'file.txt')),
    ).toBeUndefined()
    expect(getAgentMemoryRoot(join(memoryDir))).toBeUndefined()
  })

  test('a marker nested deeper than one project segment is rejected', () => {
    expect(
      getAgentMemoryRoot(
        join(
          projectsRoot,
          'a',
          'b',
          'agent-memory-local',
          'file.txt',
        ),
      ),
    ).toBeUndefined()
  })

  test('paths outside the projects root are not local scope', () => {
    expect(
      getAgentMemoryRoot(join(remoteBase, 'other', 'agent-memory-local', 'f')),
    ).toBeUndefined()
  })
})
