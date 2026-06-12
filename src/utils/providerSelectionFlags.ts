/**
 * Single source of truth for every CLAUDE_CODE_USE_* provider-selection flag.
 *
 * Any code that enumerates provider flags — startup selection precedence,
 * env propagation to subprocesses, cleanup on provider switch, bootstrap
 * gating — must derive from this list instead of hardcoding its own copy.
 * The parity test in providerSelectionFlags.test.ts scans the source tree
 * and fails when a new CLAUDE_CODE_USE_* flag appears without being
 * registered here, which is how the Gemini Vertex provider drifted out of
 * several reference lists in the first place.
 *
 * Dependency-free on purpose: both low-level (model/providers.ts) and
 * high-level (providerProfiles.ts) modules import it without cycles.
 */
export const PROVIDER_SELECTION_FLAGS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GEMINI_VERTEX',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

export type ProviderSelectionFlag = (typeof PROVIDER_SELECTION_FLAGS)[number]
