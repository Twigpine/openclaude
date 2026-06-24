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
 * Leaf module on purpose: it only depends on envUtils (itself a leaf), so
 * both low-level (model/providers.ts) and high-level (providerProfiles.ts)
 * modules import it without cycles.
 */
import { isEnvTruthy } from './envUtils.js'

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

/**
 * True when any registered provider-selection flag is set to a truthy value.
 * Derives from PROVIDER_SELECTION_FLAGS so flag-agnostic call sites (explicit
 * selection, 3P-service detection, non-OpenAI-compatible gating) never drift
 * out of sync — this is exactly the check that silently omitted Gemini Vertex.
 */
export function hasAnyTruthyProviderSelectionFlag(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return PROVIDER_SELECTION_FLAGS.some(flag => isEnvTruthy(processEnv[flag]))
}

/**
 * True when any registered provider-selection flag other than `exceptFlag` is
 * present in env. Uses presence (`!== undefined`), not truthiness, because even
 * a bare `CLAUDE_CODE_USE_<provider>=` signals intent for the conflict check. Pass the
 * flag of the active profile to detect a conflicting selection for any other
 * provider.
 */
export function hasConflictingProviderFlag(
  processEnv: NodeJS.ProcessEnv = process.env,
  exceptFlag?: ProviderSelectionFlag,
): boolean {
  return PROVIDER_SELECTION_FLAGS.some(
    flag => flag !== exceptFlag && processEnv[flag] !== undefined,
  )
}
