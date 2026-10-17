import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getSiblingSkillsHomeId } from '../../skills/siblingSkillHomes.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { logError } from '../../utils/log.js'

// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k × 4
export const MAX_CHAR_BUDGET = DEFAULT_CHAR_BUDGET
export const SUBAGENT_SKILL_LISTING_CHAR_BUDGET = 4_000

// Per-entry hard cap. The listing is for discovery only — the Skill tool loads
// full content on invoke, so verbose whenToUse strings waste turn-1 cache_creation
// tokens without improving match rate. Applies to all entries, including bundled,
// since the cap is generous enough to preserve the core use case.
export const MAX_LISTING_DESC_CHARS = 250

export type SkillListingBudgetOptions = {
  maxCharBudget?: number
}

export function getCharBudget(
  contextWindowTokens?: number,
  options: SkillListingBudgetOptions = {},
): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  const maxBudget = options.maxCharBudget ?? MAX_CHAR_BUDGET
  if (contextWindowTokens) {
    return Math.min(
      maxBudget,
      Math.floor(
        contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
      ),
    )
  }
  return Math.min(DEFAULT_CHAR_BUDGET, maxBudget)
}

function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}

function formatCommandDescription(cmd: Command): string {
  // Debug: log if userFacingName differs from cmd.name for plugin skills
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `Skill prompt: showing "${cmd.name}" (userFacingName="${displayName}")`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

const MIN_DESC_LENGTH = 20

export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
  options: SkillListingBudgetOptions = {},
): string {
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens, options)

  // Try full descriptions first
  const fullEntries = commands.map(cmd => ({
    cmd,
    full: formatCommandDescription(cmd),
  }))
  // join('\n') produces N-1 newlines for N entries
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1)

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // Partition into bundled (never truncated) and rest
  const bundledIndices = new Set<number>()
  const restCommands: Command[] = []
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledIndices.add(i)
    } else {
      restCommands.push(cmd)
    }
  }

  // Compute space used by bundled skills (full descriptions, always preserved)
  const bundledChars = fullEntries.reduce(
    (sum, e, i) =>
      bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum,
    0,
  )
  const remainingBudget = budget - bundledChars

  // Calculate max description length for non-bundled commands
  if (restCommands.length === 0) {
    return fullEntries.map(e => e.full).join('\n')
  }

  if (restCommands.some(cmd => getSiblingSkillsHomeId(cmd))) {
    return formatWithSiblingSkillsLast(
      commands,
      fullEntries,
      bundledIndices,
      remainingBudget,
    )
  }

  const restNameOverhead =
    restCommands.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) +
    (restCommands.length - 1)
  const availableForDescs = remainingBudget - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme case: non-bundled go names-only, bundled keep descriptions
    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_skill_descriptions_truncated', {
        skill_count: commands.length,
        budget,
        full_total: fullTotal,
        truncation_mode:
          'names_only' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_desc_length: maxDescLen,
        bundled_count: bundledIndices.size,
        bundled_chars: bundledChars,
      })
    }
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
      )
      .join('\n')
  }

  // Truncate non-bundled descriptions to fit within budget
  const truncatedCount = count(
    restCommands,
    cmd => stringWidth(getCommandDescription(cmd)) > maxDescLen,
  )
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_skill_descriptions_truncated', {
      skill_count: commands.length,
      budget,
      full_total: fullTotal,
      truncation_mode:
        'description_trimmed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      max_desc_length: maxDescLen,
      truncated_count: truncatedCount,
      // Count of bundled skills included in this prompt (excludes skills with disableModelInvocation)
      bundled_count: bundledIndices.size,
      bundled_chars: bundledChars,
    })
  }
  return commands
    .map((cmd, i) => {
      // Bundled skills always get full descriptions
      if (bundledIndices.has(i)) return fullEntries[i]!.full
      const description = getCommandDescription(cmd)
      return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
    })
    .join('\n')
}

/**
 * Over-budget listing when skills from other agents' homes are present. Those
 * rank last: they drop to names only before any OpenClaude skill description
 * is trimmed, and only get description space that OpenClaude skills leave
 * unused. Bundled skills keep full descriptions, as in the default path.
 */
function formatWithSiblingSkillsLast(
  commands: Command[],
  fullEntries: { cmd: Command; full: string }[],
  bundledIndices: Set<number>,
  remainingBudget: number,
): string {
  const ownIndices: number[] = []
  const siblingIndices: number[] = []
  for (let i = 0; i < commands.length; i++) {
    if (bundledIndices.has(i)) continue
    if (getSiblingSkillsHomeId(commands[i]!)) {
      siblingIndices.push(i)
    } else {
      ownIndices.push(i)
    }
  }

  const nameOnly = (cmd: Command): string => `- ${cmd.name}`
  // +1 per entry for the joining newline
  const siblingNamesChars = siblingIndices.reduce(
    (sum, i) => sum + stringWidth(nameOnly(commands[i]!)) + 1,
    0,
  )
  const ownBudget = remainingBudget - siblingNamesChars
  const ownFullChars = ownIndices.reduce(
    (sum, i) => sum + stringWidth(fullEntries[i]!.full) + 1,
    0,
  )

  const lines = new Map<number, string>()
  if (ownFullChars <= ownBudget) {
    for (const i of ownIndices) lines.set(i, fullEntries[i]!.full)
    // ": " separates a sibling skill's name from its description
    const siblingDescLen =
      Math.floor((ownBudget - ownFullChars) / siblingIndices.length) - 2
    for (const i of siblingIndices) {
      const cmd = commands[i]!
      lines.set(
        i,
        siblingDescLen >= MIN_DESC_LENGTH
          ? `- ${cmd.name}: ${truncate(getCommandDescription(cmd), siblingDescLen)}`
          : nameOnly(cmd),
      )
    }
  } else {
    for (const i of siblingIndices) lines.set(i, nameOnly(commands[i]!))
    // "- " + ": " + newline around each OpenClaude skill's description
    const ownNameOverhead = ownIndices.reduce(
      (sum, i) => sum + stringWidth(commands[i]!.name) + 5,
      0,
    )
    const ownDescLen =
      ownIndices.length > 0
        ? Math.floor((ownBudget - ownNameOverhead) / ownIndices.length)
        : 0
    for (const i of ownIndices) {
      const cmd = commands[i]!
      lines.set(
        i,
        ownDescLen >= MIN_DESC_LENGTH
          ? `- ${cmd.name}: ${truncate(getCommandDescription(cmd), ownDescLen)}`
          : nameOnly(cmd),
      )
    }
  }

  logForDebugging(
    `[skills] listing over budget; ${siblingIndices.length} sibling-home skills ranked after ${ownIndices.length} OpenClaude skills`,
  )
  return commands
    .map((_, i) =>
      bundledIndices.has(i) ? fullEntries[i]!.full : lines.get(i)!,
    )
    .join('\n')
}

export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`
})

export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// Returns the commands included in the SkillTool prompt.
// All commands are always included (descriptions may be truncated to fit budget).
// Used by analyzeContext to count skill tokens.
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    logError(toError(error))

    // Return zeros rather than throwing - let caller decide how to handle
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
