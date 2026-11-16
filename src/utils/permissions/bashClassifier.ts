/**
 * Semantic Bash permission rules ("prompt rules").
 *
 * Users can write natural-language permission rules such as
 * `Bash(prompt: allow all git status commands)`. Literal rule matching
 * cannot evaluate those, so a small side model decides whether a given
 * command falls within a description's scope.
 *
 * Deny and ask rules are evaluated up front in bashToolHasPermission;
 * allow rules run as a speculative background check that may auto-approve
 * the command while the permission dialog is visible. Only high-confidence
 * matches change the outcome in either direction.
 */

import { feature } from 'bun:bundle'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import { z } from 'zod/v4'
import { getSmallFastModel } from '../model/model.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { isEnvTruthy } from '../envUtils.js'
import { logForDebugging } from '../debug.js'
import { isAbortError } from '../errors.js'
import { getDefaultMaxRetries } from '../../services/api/withRetry.js'
import { sideQuery } from '../sideQuery.js'
import {
  extractToolUseBlock,
  parseClassifierResponse,
} from './classifierShared.js'
import { permissionRuleValueFromString } from './permissionRuleParser.js'

export const PROMPT_PREFIX = 'prompt:'

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

export function extractPromptDescription(
  ruleContent: string | undefined,
): string | null {
  if (!ruleContent) return null
  const prefix = `${PROMPT_PREFIX} `
  if (!ruleContent.startsWith(prefix)) return null
  const description = ruleContent.slice(prefix.length).trim()
  return description.length > 0 ? description : null
}

export function createPromptRuleContent(description: string): string {
  return `${PROMPT_PREFIX} ${description.trim()}`
}

export function isClassifierPermissionsEnabled(): boolean {
  if (!feature('BASH_CLASSIFIER')) return false
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BASH_CLASSIFIER)
}

function collectPromptDescriptions(
  rulesBySource:
    | ToolPermissionContext['alwaysAllowRules']
    | ToolPermissionContext['alwaysDenyRules']
    | ToolPermissionContext['alwaysAskRules'],
): string[] {
  const descriptions: string[] = []
  for (const rules of Object.values(rulesBySource)) {
    if (!rules) continue
    for (const ruleString of rules) {
      const ruleValue = permissionRuleValueFromString(ruleString)
      if (ruleValue.toolName !== BASH_TOOL_NAME) continue
      const description = extractPromptDescription(ruleValue.ruleContent)
      if (description) descriptions.push(description)
    }
  }
  return descriptions
}

export function getBashPromptAllowDescriptions(
  context: ToolPermissionContext,
): string[] {
  return collectPromptDescriptions(context.alwaysAllowRules)
}

export function getBashPromptDenyDescriptions(
  context: ToolPermissionContext,
): string[] {
  return collectPromptDescriptions(context.alwaysDenyRules)
}

export function getBashPromptAskDescriptions(
  context: ToolPermissionContext,
): string[] {
  return collectPromptDescriptions(context.alwaysAskRules)
}

const BASH_CLASSIFIER_TOOL_NAME = 'report_bash_rule_match'

const BASH_CLASSIFIER_TOOL_SCHEMA: BetaToolUnion = {
  type: 'custom',
  name: BASH_CLASSIFIER_TOOL_NAME,
  description:
    'Report whether a shell command falls within one of the listed permission rule descriptions',
  input_schema: {
    type: 'object',
    properties: {
      reasoning: {
        type: 'string',
        description:
          'One or two sentences comparing the command against the best candidate description.',
      },
      matched_index: {
        type: 'integer',
        description:
          '0-based index of the description the command falls within, or -1 when none apply.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'high only when the command unambiguously stays within the description scope.',
      },
      reason: {
        type: 'string',
        description: 'Short human-readable explanation of the decision.',
      },
    },
    required: ['reasoning', 'matched_index', 'confidence', 'reason'],
  },
}

const responseSchema = z.object({
  reasoning: z.string(),
  matched_index: z.number().int(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
})

const BEHAVIOR_INTENT: Record<ClassifierBehavior, string> = {
  deny: 'the user wants denied outright',
  ask: 'the user wants to be prompted about',
  allow: 'the user has pre-approved and never wants to be asked about',
}

function buildSystemPrompt(behavior: ClassifierBehavior): string {
  return `You decide whether a shell command falls within one of a set of natural-language permission descriptions. Each description names a class of commands ${BEHAVIOR_INTENT[behavior]}.

Matching rules:
- Match on the command's actual effect and intent, not literal text. "git status commands" matches \`git status\` and \`git status -sb\` but not \`git push\`.
- The whole command must stay within the description's scope. A command that does anything beyond or unrelated to the description does not match.
- For compound commands (pipes, \`&&\`, \`;\`, substitutions), evaluate the entire command's combined effect.
- Pick the single best-matching description index, or -1 when none apply.
- Confidence: "high" only when the command unambiguously fits; "medium" when plausible but uncertain; "low" when unlikely. When in doubt choose the lower confidence — a wrong answer changes what the user is or is not asked about.

Answer only through the ${BASH_CLASSIFIER_TOOL_NAME} tool.`
}

export async function classifyBashCommand(
  command: string,
  cwd: string,
  descriptions: string[],
  behavior: ClassifierBehavior,
  signal: AbortSignal,
  _isNonInteractiveSession: boolean,
): Promise<ClassifierResult> {
  const noMatch = (reason: string): ClassifierResult => ({
    matches: false,
    confidence: 'low',
    reason,
  })

  if (!isClassifierPermissionsEnabled()) {
    return noMatch('Bash prompt rules are disabled')
  }
  if (descriptions.length === 0) {
    return noMatch('No prompt rule descriptions configured')
  }

  const userContent = [
    `<command>${command}</command>`,
    `<working-directory>${cwd}</working-directory>`,
    `<descriptions>\n${descriptions
      .map((d, i) => `${i}. ${d}`)
      .join('\n')}\n</descriptions>`,
  ].join('\n')

  try {
    const result = await sideQuery({
      model: getSmallFastModel(),
      system: [
        {
          type: 'text' as const,
          text: buildSystemPrompt(behavior),
        },
      ],
      messages: [{ role: 'user' as const, content: userContent }],
      tools: [BASH_CLASSIFIER_TOOL_SCHEMA],
      tool_choice: { type: 'tool' as const, name: BASH_CLASSIFIER_TOOL_NAME },
      temperature: 0,
      maxRetries: getDefaultMaxRetries(),
      max_tokens: 1024,
      signal,
      querySource: 'bash_permission_classifier',
    })

    const toolUse = extractToolUseBlock(result.content, BASH_CLASSIFIER_TOOL_NAME)
    if (!toolUse) {
      return noMatch('Classifier returned no structured verdict')
    }
    const parsed = parseClassifierResponse(toolUse, responseSchema)
    if (!parsed) {
      return noMatch('Classifier returned an unparseable verdict')
    }

    const matched = descriptions[parsed.matched_index]
    if (parsed.matched_index < 0 || matched === undefined) {
      return {
        matches: false,
        confidence: parsed.confidence,
        reason: parsed.reason,
      }
    }
    return {
      matches: true,
      matchedDescription: matched,
      confidence: parsed.confidence,
      reason: parsed.reason,
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    logForDebugging(
      `bash prompt-rule classifier failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    // Fail toward prompting the user rather than silently deciding.
    return noMatch('Classifier unavailable')
  }
}

export async function generateGenericDescription(
  _command: string,
  specificDescription: string | undefined,
  _signal: AbortSignal,
): Promise<string | null> {
  return specificDescription || null
}
