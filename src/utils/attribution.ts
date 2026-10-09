import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'
import { getClientType } from '../bootstrap/state.js'
import { getRemoteSessionUrl, isRemoteSessionLocal } from '../constants/product.js'
import { isEnvTruthy } from './envUtils.js'
import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import type { AppState } from '../state/AppState.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/constants.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import type { Entry } from '../types/logs.js'
import {
  type AttributionData,
  calculateCommitAttribution,
  isInternalModelRepo,
  isInternalModelRepoCached,
  sanitizeModelName,
} from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import { getAPIProvider } from './model/providers.js'
import {
  getGitAttributionOptIns,
  isGeneratedCommitAttributionBlocked,
  isGeneratedPrAttributionBlocked,
} from './governancePolicy.js'
import {
  getCanonicalName,
  getMainLoopModel,
  getPublicModelDisplayName,
  getPublicModelName,
} from './model/model.js'
import { isMemoryFileAccess } from './sessionFileAccessHooks.js'
import { getTranscriptPath } from './sessionStorage.js'
import { readTranscriptForLoad } from './sessionStoragePortable.js'
import { getInitialSettings } from './settings/settings.js'
import { isUndercover } from './undercover.js'

export type AttributionTexts = {
  commit: string
  pr: string
}

const DEFAULT_PR_ATTRIBUTION =
  '🤖 Generated with [OpenClaude](https://github.com/Twigpine/openclaude)'

function sanitizeCoAuthorNamePart(value: string): string {
  return value
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

function formatClaudeCoAuthorName(model: string): string {
  const publicName = getPublicModelDisplayName(model)
  if (!publicName) {
    return sanitizeCoAuthorNamePart(getPublicModelName(model))
  }
  const coAuthorName = publicName.startsWith('Claude ')
    ? publicName
    : `Claude ${publicName}`
  return sanitizeCoAuthorNamePart(coAuthorName)
}

export function getDefaultCommitCoAuthorName({
  model,
  apiProvider,
  isInternalRepo,
}: {
  model: string
  apiProvider: string
  isInternalRepo: boolean
}): string {
  const isKnownPublicModel = getPublicModelDisplayName(model) !== null
  const normalizedModel = model.toLowerCase()
  const isClaudeProvider =
    apiProvider === 'firstParty' ||
    apiProvider === 'bedrock' ||
    apiProvider === 'vertex' ||
    apiProvider === 'foundry' ||
    normalizedModel.includes('claude')

  if (isClaudeProvider && (isInternalRepo || isKnownPublicModel)) {
    return formatClaudeCoAuthorName(model)
  }

  // Unknown first-party models may be unreleased Claude codenames, so keep the
  // historical public fallback. OpenAI-compatible providers should identify the
  // actual configured model instead of claiming Claude Opus.
  if (apiProvider === 'firstParty') {
    // @[MODEL LAUNCH]: Update this fallback when the default public Claude model changes.
    return 'Claude Opus 4.8'
  }

  const sanitizedModel = sanitizeCoAuthorNamePart(model)
  return sanitizedModel ? `OpenClaude (${sanitizedModel})` : 'OpenClaude'
}

export function getDefaultCommitCoAuthorEmail(_apiProvider: string): string {
  return 'openclaude@gitlawb.com'
}

/**
 * Returns attribution text for commits and PRs based on user settings.
 * Handles:
 * - Dynamic model name via getPublicModelName()
 * - Explicit custom attribution settings (settings.attribution.commit/pr)
 * - Backward compatibility with deprecated includeCoAuthoredBy setting as an opt-in
 * - Remote mode: returns session URL for attribution
 */
export function getAttributionTexts(): AttributionTexts {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return { commit: '', pr: '' }
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // Skip for local dev - URLs won't persist
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        const sessionUrl = getRemoteSessionUrl(remoteSessionId, ingressUrl)
        return { commit: sessionUrl, pr: sessionUrl }
      }
    }
    return { commit: '', pr: '' }
  }

  const settings = getInitialSettings()

  // Explicit attribution settings take precedence over the deprecated setting.
  // Omitted fields stay off by default to avoid unrequested Git metadata.
  if (settings.attribution) {
    return {
      commit: settings.attribution.commit ?? '',
      pr: settings.attribution.pr ?? '',
    }
  }

  const optIns = getGitAttributionOptIns()
  const includeGeneratedCommit =
    (settings.includeCoAuthoredBy === true || optIns.addAICoAuthor) &&
    !isGeneratedCommitAttributionBlocked()
  const includeGeneratedPr =
    (settings.includeCoAuthoredBy === true || optIns.addGeneratedWithFooter) &&
    !isGeneratedPrAttributionBlocked()

  if (!includeGeneratedCommit && !includeGeneratedPr) {
    return { commit: '', pr: '' }
  }

  // First-party unknown models may be unreleased Claude codenames. Other
  // providers can safely use the configured public model string.
  const model = getMainLoopModel()
  const apiProvider = getAPIProvider()
  const modelName = getDefaultCommitCoAuthorName({
    model,
    apiProvider,
    isInternalRepo: isInternalModelRepoCached(),
  })
  const coAuthorEmail = getDefaultCommitCoAuthorEmail(apiProvider)
  const defaultCommit = isEnvTruthy(
    process.env.OPENCLAUDE_DISABLE_CO_AUTHORED_BY,
  )
    ? ''
    : `Co-Authored-By: ${modelName} <${coAuthorEmail}>`

  return {
    commit: includeGeneratedCommit ? defaultCommit : '',
    pr: includeGeneratedPr ? DEFAULT_PR_ATTRIBUTION : '',
  }
}

/**
 * Check if a message content string is terminal output rather than a user prompt.
 * Terminal output includes bash input/output tags and caveat messages about local commands.
 */
function isTerminalOutput(content: string): boolean {
  for (const tag of TERMINAL_OUTPUT_TAGS) {
    if (content.includes(`<${tag}>`)) {
      return true
    }
  }
  return false
}

/**
 * Count user messages with visible text content in a list of non-sidechain messages.
 * Excludes tool_result blocks, terminal output, and empty messages.
 *
 * Callers should pass messages already filtered to exclude sidechain messages.
 */
export function countUserPromptsInMessages(
  messages: ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
): number {
  let count = 0

  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const content = message.message?.content
    if (!content) {
      continue
    }

    let hasUserText = false

    if (typeof content === 'string') {
      if (isTerminalOutput(content)) {
        continue
      }
      hasUserText = content.trim().length > 0
    } else if (Array.isArray(content)) {
      hasUserText = content.some(block => {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          return false
        }
        return (
          (block.type === 'text' &&
            typeof block.text === 'string' &&
            !isTerminalOutput(block.text)) ||
          block.type === 'image' ||
          block.type === 'document'
        )
      })
    }

    if (hasUserText) {
      count++
    }
  }

  return count
}

/**
 * Count non-sidechain user messages in transcript entries.
 * Used to calculate the number of "steers" (user prompts - 1).
 *
 * Counts user messages that contain actual user-typed text,
 * excluding tool_result blocks, sidechain messages, and terminal output.
 */
function countUserPromptsFromEntries(entries: ReadonlyArray<Entry>): number {
  const nonSidechain = entries.filter(
    entry =>
      entry.type === 'user' && !('isSidechain' in entry && entry.isSidechain),
  )
  return countUserPromptsInMessages(nonSidechain)
}

/**
 * Get full attribution data from the provided AppState's attribution state.
 * Uses ALL tracked files from the attribution state (not just staged files)
 * because for PR attribution, files may not be staged yet.
 * Returns null if no attribution data is available.
 */
async function getPRAttributionData(
  appState: AppState,
): Promise<AttributionData | null> {
  const attribution = appState.attribution

  if (!attribution) {
    return null
  }

  // Handle both Map and plain object (in case of serialization)
  const fileStates = attribution.fileStates
  const isMap = fileStates instanceof Map
  const trackedFiles = isMap
    ? Array.from(fileStates.keys())
    : Object.keys(fileStates)

  if (trackedFiles.length === 0) {
    return null
  }

  try {
    return await calculateCommitAttribution([attribution], trackedFiles)
  } catch (error) {
    logError(error as Error)
    return null
  }
}

const MEMORY_ACCESS_TOOL_NAMES = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * Count memory file accesses in transcript entries.
 * Uses the same detection conditions as the PostToolUse session file access hooks.
 */
function countMemoryFileAccessFromEntries(
  entries: ReadonlyArray<Entry>,
): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block.type !== 'tool_use' ||
        !MEMORY_ACCESS_TOOL_NAMES.has(block.name)
      )
        continue
      if (isMemoryFileAccess(block.name, block.input)) count++
    }
  }
  return count
}

/**
 * Read session transcript entries and compute prompt count and memory access
 * count. Pre-compact entries are skipped — the N-shot count and memory-access
 * count should reflect only the current conversation arc, not accumulated
 * prompts from before a compaction boundary.
 */
async function getTranscriptStats(): Promise<{
  promptCount: number
  memoryAccessCount: number
}> {
  try {
    const filePath = getTranscriptPath()
    const fileSize = (await stat(filePath)).size
    // Fused reader: attr-snap lines (84% of a long session by bytes) are
    // skipped at the fd level so peak scales with output, not file size. The
    // one surviving attr-snap at EOF is a no-op for the count functions
    // (neither checks type === 'attribution-snapshot'). When the last
    // boundary has preservedSegment the reader returns full (no truncate);
    // the findLastIndex below still slices to post-boundary.
    const scan = await readTranscriptForLoad(filePath, fileSize)
    const buf = scan.postBoundaryBuf
    const entries = parseJSONL<Entry>(buf)
    const lastBoundaryIdx = entries.findLastIndex(
      e =>
        e.type === 'system' &&
        'subtype' in e &&
        e.subtype === 'compact_boundary',
    )
    const postBoundary =
      lastBoundaryIdx >= 0 ? entries.slice(lastBoundaryIdx + 1) : entries
    return {
      promptCount: countUserPromptsFromEntries(postBoundary),
      memoryAccessCount: countMemoryFileAccessFromEntries(postBoundary),
    }
  } catch {
    return { promptCount: 0, memoryAccessCount: 0 }
  }
}

/**
 * Get enhanced PR attribution text with Claude contribution stats.
 *
 * Format: "🤖 Generated with Claude Code (93% 3-shotted by claude-opus-4-5)"
 *
 * Rules:
 * - Shows Claude contribution percentage from commit attribution
 * - Shows N-shotted where N is the prompt count (1-shotted, 2-shotted, etc.)
 * - Shows short model name (e.g., claude-opus-4-5)
 * - Returns default attribution if explicitly enabled and stats can't be computed
 *
 * @param getAppState Function to get the current AppState (from command context)
 */
export async function getEnhancedPRAttribution(
  getAppState: () => AppState,
): Promise<string> {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return ''
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // Skip for local dev - URLs won't persist
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        return getRemoteSessionUrl(remoteSessionId, ingressUrl)
      }
    }
    return ''
  }

  const settings = getInitialSettings()

  // If user configured PR attribution, use the exact value. Omitted PR
  // attribution stays off even if commit attribution is configured.
  if (settings.attribution?.pr !== undefined) {
    return settings.attribution.pr
  }
  if (settings.attribution) {
    return ''
  }

  const optIns = getGitAttributionOptIns()
  const includeGeneratedPr =
    (settings.includeCoAuthoredBy === true || optIns.addGeneratedWithFooter) &&
    !isGeneratedPrAttributionBlocked()

  // Backward compatibility: deprecated includeCoAuthoredBy remains an explicit
  // opt-in, and git.addGeneratedWithFooter is the new generated-PR opt-in.
  if (!includeGeneratedPr) {
    return ''
  }

  // Get AppState first
  const appState = getAppState()

  logForDebugging(
    `PR Attribution: appState.attribution exists: ${!!appState.attribution}`,
  )
  if (appState.attribution) {
    const fileStates = appState.attribution.fileStates
    const isMap = fileStates instanceof Map
    const fileCount = isMap ? fileStates.size : Object.keys(fileStates).length
    logForDebugging(`PR Attribution: fileStates count: ${fileCount}`)
  }

  // Get attribution stats (transcript is read once for both prompt count and memory access)
  const [attributionData, { promptCount, memoryAccessCount }, isInternal] =
    await Promise.all([
      getPRAttributionData(appState),
      getTranscriptStats(),
      isInternalModelRepo(),
    ])

  const claudePercent = attributionData?.summary.claudePercent ?? 0

  logForDebugging(
    `PR Attribution: claudePercent: ${claudePercent}, promptCount: ${promptCount}, memoryAccessCount: ${memoryAccessCount}`,
  )

  // Get short model name, sanitized for non-internal repos
  const rawModelName = getCanonicalName(getMainLoopModel())
  const shortModelName = isInternal
    ? rawModelName
    : sanitizeModelName(rawModelName)

  // If no attribution data, return default
  if (claudePercent === 0 && promptCount === 0 && memoryAccessCount === 0) {
    logForDebugging('PR Attribution: returning default (no data)')
    return DEFAULT_PR_ATTRIBUTION
  }

  // Build the enhanced attribution: "🤖 Generated with Claude Code (93% 3-shotted by claude-opus-4-5, 2 memories recalled)"
  const memSuffix =
    memoryAccessCount > 0
      ? `, ${memoryAccessCount} ${memoryAccessCount === 1 ? 'memory' : 'memories'} recalled`
      : ''
  const summary = `🤖 Generated with [OpenClaude](https://github.com/Twigpine/openclaude) (${claudePercent}% ${promptCount}-shotted by ${shortModelName}${memSuffix})`

  // Append trailer lines for squash-merge survival. Only for allowlisted repos
  // (INTERNAL_MODEL_REPOS) and only in builds with COMMIT_ATTRIBUTION enabled —
  // attributionTrailer.ts contains excluded strings, so reach it via dynamic
  // import behind feature(). When the repo is configured with
  // squash_merge_commit_message=PR_BODY (cli, apps), the PR body becomes the
  // squash commit body verbatim — trailer lines at the end become proper git
  // trailers on the squash commit.
  if (feature('COMMIT_ATTRIBUTION') && isInternal && attributionData) {
    const { buildPRTrailers } = await import('./attributionTrailer.js')
    const trailers = buildPRTrailers(attributionData, appState.attribution)
    const result = `${summary}\n\n${trailers.join('\n')}`
    logForDebugging(`PR Attribution: returning with trailers: ${result}`)
    return result
  }

  logForDebugging(`PR Attribution: returning summary: ${summary}`)
  return summary
}
