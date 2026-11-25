import {
  CODE_MODE_ENV_VAR,
  getOriginalProcessEnvBeforeSettings,
} from '../../utils/managedEnvConstants.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export const REPL_TOOL_NAME = 'REPL'
export { CODE_MODE_ENV_VAR }

export const CODE_MODE_STARTUP_NOTICE = `Experimental Code Mode is active. The model can orchestrate tools through JavaScript in this interactive session. This session can be resumed only when ${CODE_MODE_ENV_VAR} is enabled.`

/**
 * Session-stable Code Mode activation. The interactive CLI resolves this once
 * during startup from the pre-settings process environment plus user settings.
 * Programmatic entrypoints never enable it, so the default state is direct tools.
 */
let replModeEligibleForSession = false
let replModeConversationOverride: boolean | undefined

export function setReplModeEnabledForSession(enabled: boolean): void {
  replModeEligibleForSession = enabled
  replModeConversationOverride = undefined
}

export function isReplModeEligibleForSession(): boolean {
  return replModeEligibleForSession
}

export function getReplModeConversationOverride(): boolean | undefined {
  return replModeConversationOverride
}

export function setReplModeForConversation(enabled: boolean | undefined): void {
  replModeConversationOverride = enabled
}

export function resetReplModeToSessionEligibility(): boolean {
  replModeConversationOverride = undefined
  return replModeEligibleForSession
}

export function isReplModeEnabled(): boolean {
  return replModeConversationOverride ?? replModeEligibleForSession
}

/**
 * Resolve the experimental enablement without reading mutable process.env.
 *
 * Accepted sources are exactly the original process environment and user-level
 * settings env. Project and local settings are filtered before this point and
 * are never accepted. An explicitly falsy value in either accepted source wins
 * over a truthy value in the other. Legacy CLAUDE_CODE_REPL, CLAUDE_REPL_MODE,
 * and USER_TYPE=ant intentionally have no effect.
 */
export function resolveCodeModeEnablement(input: {
  originalProcessEnv?: Readonly<Record<string, string | undefined>>
  userSettingsEnv?: Readonly<Record<string, string | undefined>>
  isInteractive: boolean
  entrypoint: string | undefined
}): boolean {
  if (!input.isInteractive || input.entrypoint !== 'cli') return false

  const acceptedValues = [
    input.originalProcessEnv?.[CODE_MODE_ENV_VAR],
    input.userSettingsEnv?.[CODE_MODE_ENV_VAR],
  ]
  if (acceptedValues.some(isEnvDefinedFalsy)) return false
  return acceptedValues.some(isEnvTruthy)
}


export function shouldShowCodeModeConsent(
  enablement: boolean,
  hasAcknowledged: boolean,
): boolean {
  return enablement && !hasAcknowledged
}

export function resolveCodeModeActivationAfterConsent(input: {
  enablement: boolean
  hasAcknowledged: boolean
  consentAccepted?: boolean
}): boolean {
  if (!input.enablement) return false
  return input.hasAcknowledged || input.consentAccepted === true
}

/**
 * The process env snapshot captured before settings env application. This is
 * the only process-env input to activation; later process.env mutations from
 * settings, provider profiles, or tests must not toggle the session mode.
 */
export function getCodeModeOriginalProcessEnv(): Readonly<
  Record<string, string | undefined>
> {
  return getOriginalProcessEnvBeforeSettings()
}

/**
 * Tools that are only accessible via REPL when REPL mode is enabled.
 * When REPL mode is on, these tools are hidden from Claude's direct use,
 * forcing Claude to use REPL for batch operations.
 */
export const REPL_ONLY_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'NotebookEdit',
  'PowerShell',
  'Agent',
])

/**
 * Guest-facing ergonomic aliases for primitive tools. Canonical names remain
 * the authoritative tool identity; these aliases only affect function names
 * installed inside the QuickJS guest.
 */
export const REPL_ERGONOMIC_ALIASES: ReadonlyMap<string, string> = new Map([
  ['Read', 'read'],
  ['Write', 'write'],
  ['Edit', 'edit'],
  ['Glob', 'glob'],
  ['Grep', 'grep'],
  ['Bash', 'bash'],
  ['NotebookEdit', 'notebookEdit'],
  ['PowerShell', 'powerShell'],
  ['Agent', 'agent'],
])

export function getReplErgonomicAlias(toolName: string): string | undefined {
  return REPL_ERGONOMIC_ALIASES.get(toolName)
}
