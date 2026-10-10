/**
 * duo — automatic skill routing.
 *
 * The debaters cannot pick a skill themselves: their turns are tool-less, so
 * they never see the skill catalogue. Instead, one cheap routing pass runs
 * before the debate, picks the 1–2 skills that fit the task, and their text is
 * injected into both debaters' turn.
 *
 * `ask` is injected so this module stays pure and testable; the caller wires
 * it to whichever backend is active.
 */

import type { DuoSkillInfo } from './skills.js'

/** Upper bound on skills injected into one debate (context budget). */
export const MAX_AUTO_SKILLS = 2

/** Cap the catalogue sent to the router (progressive disclosure). */
const MAX_CATALOG_ITEMS = 60

/**
 * The router answers one line: `NONE`, or the skill name(s).
 *
 * Lesson from measuring it (ops/eval_router.py, 2026-10-08): demanding a rigid
 * `name | high` marker made every free-model answer unparseable, so the router
 * abstained on *every* question — including ones where `tdd` or `code-review`
 * clearly applied. Zero recall. Answering nothing but a name over-attributed
 * instead. The working middle: accept a bare known skill name, and abstain on
 * NONE, hedging, or a name that is not in the catalogue — a confused router
 * then costs one plain answer instead of a wrong skill injected twice.
 */
export const SKILL_ROUTER_SYSTEM: readonly string[] = [
  'You route an engineering task to the most relevant skill.',
  'You have NO tools and cannot read files: answer only from the catalogue you are given.',
  '',
  'Answer with EXACTLY one line, either:',
  '  NONE',
  '  skill-name',
  '  skill-name, other-skill',
  '',
  'Rules:',
  '- Use NONE unless one of the listed skills clearly applies to this exact task.',
  '- Never explain, never add punctuation, never invent a skill name.',
  '- If no name you were given fits, say NONE.',
]

export function firstLine(text: string): string {
  return text.split('\n')[0]!.trim()
}

/** Compact `name: description` catalogue for the router. */
export function buildSkillCatalog(
  skills: readonly DuoSkillInfo[],
  maxItems: number = MAX_CATALOG_ITEMS,
): string {
  return skills
    .slice(0, maxItems)
    .map(skill => `- ${skill.name}: ${firstLine(skill.description)}`)
    .join('\n')
}

/**
 * Extract skill names from a router answer. Abstains on NONE, hedging, an
 * empty answer, or names outside the catalogue, so a confused router never
 * injects a skill it invented.
 *
 * The answer must also be *only* names. Scanning for known names anywhere in
 * the text (the previous behaviour) meant a chatty answer counted as a
 * confident multi-skill selection: "I think tdd is the best fit here, and
 * to-tickets could also help" selected both. In a debate that text is injected
 * into *both* debaters, so the cost of a wrong extra pick is double — and
 * verbose answers cluster exactly where the router is least trustworthy, since
 * a saturated provider is also a slow one. Requiring a clean list turns that
 * case into an abstention the caller can fall back from and show.
 */
export function parseSkillSelection(
  answer: string,
  known: readonly string[],
  max: number = MAX_AUTO_SKILLS,
): string[] {
  const trimmed = answer.trim()
  if (!trimmed) return []
  if (/\bnone\b/i.test(trimmed)) return []
  if (/\b(maybe|perhaps|unclear|not sure|could be|possibly)\b/i.test(trimmed)) return []

  // First line only: a model that keeps talking after the answer has already
  // lost the format, and its later lines are commentary, not selection.
  const line = firstLine(trimmed)
  const chosen: string[] = []
  for (const token of line.split(/[^a-z0-9-]+/i)) {
    if (!token) continue
    const match = known.find(name => name.toLowerCase() === token.toLowerCase())
    // Every token must be a known name. An unknown one means prose, not a
    // selection — reject the whole answer rather than keep the part that
    // happened to look right.
    if (!match) return []
    if (!chosen.includes(match)) chosen.push(match)
    if (chosen.length >= max) break
  }
  return chosen
}

/** Build the router prompt for one task. */
export function buildSelectionPrompt(
  question: string,
  skills: readonly DuoSkillInfo[],
): string {
  return [
    'Pick the skills that apply to this task from the catalogue below.',
    'Answer NONE unless a skill is clearly and specifically the best match.',
    '',
    '<available_skills>',
    buildSkillCatalog(skills),
    '</available_skills>',
    '',
    '<task>',
    question,
    '</task>',
  ].join('\n')
}

/**
 * Deterministic keyword routing, no model call.
 *
 * Exists because of a measured failure: the model router and the debaters
 * share one free provider, so a 429 took the whole routing feature down —
 * and every such failure used to look like an intentional abstention. This
 * fallback keeps routing working (less sharply) when the provider refuses,
 * at zero cost and zero latency.
 */

/** Words too common to discriminate between skills. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'our',
  'we', 'how', 'what', 'why', 'when', 'where', 'should', 'start', 'this',
  'that', 'is', 'are', 'be', 'it', 'my', 'me', 'do', 'does', 'can', 'i',
])

/**
 * Routing keywords per skill.
 *
 * Pure keyword matching cannot see that "flaky" and "slow" mean
 * `diagnosing-bugs`, or that "review the diff" means `code-review` — the
 * descriptions do not contain those words. This curated table (same spirit as
 * freeModels.ts) supplies the missing vocabulary. It is the fallback's only
 * hand-tuned part; the model router stays the primary path.
 */
const ROUTING_KEYWORDS: Record<string, readonly string[]> = {
  'tdd': ['test', 'tests', 'testing', 'red', 'green', 'refactor', 'unit', 'integration', 'coverage', 'test-first', 'spec'],
  'code-review': ['review', 'diff', 'pull', 'pr', 'merge', 'standards', 'smell', 'feedback', 'approve', 'changes'],
  'diagnosing-bugs': ['bug', 'bugs', 'debug', 'flaky', 'slow', 'performance', 'regression', 'crash', 'error', 'diagnose', 'latency', 'timeout', 'hang', 'ci'],
  'codebase-design': ['design', 'interface', 'module', 'architecture', 'seam', 'api', 'abstraction', 'deep'],
  'domain-modeling': ['domain', 'glossary', 'terminology', 'vocabulary', 'model', 'language', 'adr'],
  'to-spec': ['spec', 'specification', 'document', 'write-up', 'plan'],
  'to-tickets': ['ticket', 'tickets', 'breakdown', 'tasks', 'tracker', 'split'],
  'implement': ['implement', 'build', 'code', 'feature', 'fix', 'write'],
  'implement-spec': ['implement', 'spec', 'branch', 'integration'],
  'wayfinder': ['plan', 'large', 'map', 'decision', 'wayfinder'],
  'retro': ['retro', 'retrospective', 'review', 'session', 'improve'],
  'prototype': ['prototype', 'throwaway', 'experiment', 'ui', 'state'],
  'research': ['research', 'investigate', 'sources', 'docs', 'facts', 'background'],
  'grill-with-docs': ['grill', 'interview', 'clarify', 'docs', 'glossary', 'adr'],
  'triage': ['triage', 'issue', 'issues', 'label', 'categorize', 'brief'],
  'improve-codebase-architecture': ['architecture', 'deepen', 'module', 'seam', 'improve'],
  'setup-matt-pocock-skills': ['setup', 'install', 'configure'],
  'pr': ['pull', 'request', 'pr', 'body', 'merge'],
  'wizard': ['wizard', 'script', 'bash', 'provision', 'credentials', 'setup'],
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word))
}

/**
 * Score one skill against a question: hits on the skill's own name count
 * triple (naming the discipline is naming the skill), curated routing
 * keywords count twice, description hits count once.
 */
function keywordScore(question: readonly string[], skill: DuoSkillInfo): number {
  const nameTokens = words(skill.name.replace(/-/g, ' '))
  const descTokens = words(firstLine(skill.description))
  const routing = (ROUTING_KEYWORDS[skill.name] ?? []).map(word => word.toLowerCase())
  let score = 0
  for (const token of question) {
    if (nameTokens.includes(token)) score += 3
    if (routing.includes(token)) score += 2
    if (descTokens.includes(token)) score += 1
  }
  return score
}

/**
 * Route by keywords. Returns [] when nothing scores above the threshold, so a
 * vague question still abstains rather than dragging in a marginal skill.
 */
export function keywordRoute(
  question: string,
  skills: readonly DuoSkillInfo[],
  max: number = MAX_AUTO_SKILLS,
): string[] {
  const questionWords = words(question)
  if (questionWords.length === 0) return []
  const scored = skills
    .map(skill => ({ name: skill.name, score: keywordScore(questionWords, skill) }))
    .filter(entry => entry.score >= 3)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, max).map(entry => entry.name)
}
export async function selectSkills({
  question,
  skills,
  ask,
  max = MAX_AUTO_SKILLS,
}: {
  question: string
  skills: readonly DuoSkillInfo[]
  ask: (prompt: string) => Promise<string>
  max?: number
}): Promise<{ names: string[]; error?: string; via?: 'model' | 'keywords'; fallbackReason?: string }> {
  if (skills.length === 0) return { names: [], error: 'no skill installed' }
  try {
    const answer = (await ask(buildSelectionPrompt(question, skills))).trim()
    const names = parseSkillSelection(answer, skills.map(skill => skill.name), max)
    if (names.length === 0) {
      // An explicit NONE is a decision. Everything else is a failure worth
      // showing — and "no answer at all" is a failure too: counting silence as
      // an abstention makes an unreachable provider indistinguishable from a
      // router that deliberately declined, which is the same invisibility that
      // let 429s read as good behaviour in the first place.
      const explicitNone = /^none\b/i.test(answer)
      if (!explicitNone) {
        const reason = answer
          ? `router answered: ${answer.slice(0, 120)}`
          : 'router returned nothing (provider unreachable or rate limited)'
        // As unhelpful as a 429: the model was asked for a bare name and gave
        // something else. The keyword path is the designed answer to that, and
        // routing through it keeps the failure visible (via='keywords') instead
        // of dropping the skill on the floor.
        const names = keywordRoute(question, skills, max)
        if (names.length > 0) {
          return { names, via: 'keywords' as const, fallbackReason: reason }
        }
        return { names: [], error: reason }
      }
    }
    return { names }
  } catch (error) {
    // The model router and the debaters share one free provider, so a 429 takes
    // routing down with them. Fall back to deterministic keyword routing
    // instead of silently dropping the skill.
    const names = keywordRoute(question, skills, max)
    return {
      names,
      error: undefined,
      via: 'keywords' as const,
      fallbackReason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Wrap a question with one or more selected skills. */
export function composeSelectedSkillsQuestion(
  skillTexts: ReadonlyArray<{ name: string; text: string }>,
  question: string,
): string {
  const blocks = skillTexts.map(
    skill => `<skill name="${skill.name}">\n${skill.text.trim()}\n</skill>`,
  )
  return [
    ...blocks,
    '',
    'Apply the skill(s) above to the following question:',
    question,
  ].join('\n')
}