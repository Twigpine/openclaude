// Stub
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
export function SnapshotUpdateDialog(_props: unknown) { return null }

/**
 * Stub: AGENT_MEMORY_SNAPSHOT is internal-only; the stub dialog above never
 * resolves with 'merge', so this is unreachable in this build.
 */
export function buildMergePrompt(
  _agentType: string,
  _scope: AgentMemoryScope,
): string {
  return ''
}
