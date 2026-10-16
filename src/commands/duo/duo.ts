/**
 * /duo — structured debate between two models.
 *
 * Both debaters answer the user's message in parallel, then exchange replies
 * for N internal rounds. With the consensus protocol on, every reply ends
 * with `VERDICT: CONSENSUS` or `VERDICT: SUITE` and the debate stops early
 * on double consensus.
 *
 * Implementation lives next to this entry point:
 * - parse.ts  — argument parsing and model resolution (pure helpers)
 * - render.ts — status, free-model list and result transcripts
 * - run.ts    — orchestration (debaters, skill routing) and `call`
 *
 * This module stays the stable surface: the command loader (index.ts) and
 * the tests import from here.
 *
 * Model calls reuse runForkedAgent with a per-side `mainLoopModel` override —
 * the same routing mechanism AgentTool uses for teammate models. Tools are
 * denied and maxTurns is capped at 1: debaters can only produce text.
 *
 * Two backends:
 * - `builtin` (default): in-process forked queries on the session provider.
 * - `cli`: side A drives the `opencode` CLI, side B the `cline` CLI, so the
 *   free models of both platforms can be debated with each other.
 */

export {
  isValidModelId,
  parseDuoInput,
  resolveDuoModel,
  type DuoInput,
} from './parse.js'
export {
  formatDuoResult,
  formatFreeModels,
  summarizeVerdicts,
} from './render.js'
export { buildDuoOverrides, call, isEngineeringSkill } from './run.js'
