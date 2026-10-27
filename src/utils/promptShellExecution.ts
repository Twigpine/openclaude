import { randomUUID } from 'crypto'
import type { Tool, ToolUseContext } from '../Tool.js'
import { BashTool } from '../tools/BashTool/BashTool.js'
import { logForDebugging } from './debug.js'
import { errorMessage, MalformedCommandError } from './errors.js'
import type { FrontmatterShell } from './frontmatterParser.js'
import { createAssistantMessage } from './messages.js'
import { hasPermissionsToUseTool } from './permissions/permissions.js'
import { processToolResultBlock } from './toolResultStorage.js'

// Narrow structural slice both BashTool and PowerShellTool satisfy. We can't
// use the base Tool type: it marks call()'s canUseTool/parentMessage as
// required, but both concrete tools have them optional and the original code
// called BashTool.call({ command }, ctx) with just 2 args. We can't use
// `typeof BashTool` either: BashTool's input schema has fields (e.g.
// _simulatedSedEdit) that PowerShellTool's does not.
// NOTE: call() is invoked directly here, bypassing validateInput — any
// load-bearing check must live in call() itself (see PR #23311).
type ShellOut = {
  stdout: string | null | undefined
  stderr: string | null | undefined
  interrupted: boolean
}
type PromptShellTool = Tool & {
  call(
    input: { command: string },
    context: ToolUseContext,
  ): Promise<{ data: ShellOut }>
}

import { isPowerShellToolEnabled } from './shell/shellToolUtils.js'

// Lazy: this file is on the startup import chain (main → commands →
// loadSkillsDir → here). A static import would load PowerShellTool.ts
// (and transitively parser.ts, validators, etc.) at startup on all
// platforms, defeating tools.ts's lazy require. Deferred until the
// first skill with `shell: powershell` actually runs.
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = (() => {
  let cached: PromptShellTool | undefined
  return (): PromptShellTool => {
    if (!cached) {
      cached = (
        require('../tools/PowerShellTool/PowerShellTool.js') as typeof import('../tools/PowerShellTool/PowerShellTool.js')
      ).PowerShellTool
    }
    return cached
  }
})()
/* eslint-enable @typescript-eslint/no-require-imports */

// Pattern for code blocks: ```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// Pattern for inline: !`command`
// Uses a positive lookbehind to require whitespace or start-of-line before !
// This prevents false matches inside markdown inline code spans like `!!` or
// adjacent spans like `foo`!`bar`, and shell variables like $!
// eslint-disable-next-line custom-rules/no-lookbehind-regex -- gated by text.includes('!`') below (PR#22986)
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm

/**
 * Parses prompt text and executes any embedded shell commands.
 * Supports two syntaxes:
 * - Code blocks: ```! command ```
 * - Inline: !`command`
 *
 * @param shell - Shell to route commands through. Defaults to bash.
 *   This is *never* read from settings.defaultShell — it comes from .md
 *   frontmatter (author's choice) or is undefined for built-in commands.
 *   See docs/design/ps-shell-selection.md §5.3.
 * @param options.lineLimits - Map of command-prefix → max output lines.
 *   When a snippet's executed command (trimmed) starts with one of the
 *   prefixes, the output is sliced to that many lines before being
 *   substituted. Invalid limits (nonfinite, fractional, or negative) are ignored.
 *   Use to bound diffs or other potentially-large outputs
 *   without widening the Bash allowlist (avoids `| head -N` in commands,
 *   which the permission parser treats as a compound and may reject).
 */
export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell?: FrontmatterShell,
  options?: { lineLimits?: Record<string, number>; granularFallback?: boolean },
): Promise<string> {
  let result = text
  const lineLimits = options?.lineLimits ?? {}
  // Default path: any non-permission, non-interrupted shell failure is wrapped
  // in a MalformedCommandError with the failing pattern + formatted stderr so
  // /commit, /security-review, loaded skills, and plugin commands show a
  // useful message instead of the raw "ShellError: Shell command failed".
  // Opt-in `granularFallback: true` rethrows the raw error and lets the caller
  // blank just the failed snippet in place (used by the bughunter siblings
  // where one bad git command should not discard the rest of the context).
  const granularFallback = options?.granularFallback === true

  // Resolve the tool once. `shell === undefined` and `shell === 'bash'` both
  // hit BashTool. PowerShell only when the runtime gate allows — a skill
  // author's frontmatter choice doesn't override the user's opt-in/out.
  const shellTool: PromptShellTool =
    shell === 'powershell' && isPowerShellToolEnabled()
      ? getPowerShellTool()
      : BashTool

  // INLINE_PATTERN's lookbehind is ~100x slower than BLOCK_PATTERN on large
  // skill content (265µs vs 2µs @ 17KB). 93% of skills have no !` at all,
  // so gate the expensive scan on a cheap substring check. BLOCK_PATTERN
  // (```!) doesn't require !` in the text, so it's always scanned.
  const blockMatches = text.matchAll(BLOCK_PATTERN)
  const inlineMatches = text.includes('!`') ? text.matchAll(INLINE_PATTERN) : []

  await Promise.all(
    [...blockMatches, ...inlineMatches].map(async match => {
      const command = match[1]?.trim()
      if (command) {
        try {
          // Check permissions before executing
          const permissionResult = await hasPermissionsToUseTool(
            shellTool,
            { command },
            context,
            createAssistantMessage({ content: [] }),
            '',
          )

          if (permissionResult.behavior !== 'allow') {
            logForDebugging(
              `Shell command permission check failed for command in ${slashCommandName}: ${command}. Error: ${permissionResult.message}`,
            )
            throw new MalformedCommandError(
              `Shell command permission check failed for pattern "${match[0]}": ${permissionResult.message || 'Permission denied'}`,
            )
          }

          const { data } = await shellTool.call({ command }, context)
          // Apply per-prefix line limit to the raw stdout BEFORE persistence
          // so the trimmed output flows through processToolResultBlock and
          // its empty-content guard fires correctly when truncation empties
          // the block entirely. Also avoids the 30k-char Bash result cap
          // short-circuit for huge diffs.
          const trimmedStdout =
            typeof data.stdout === 'string' ? data.stdout : ''
          const boundedStdout = applyLineLimit(
            command,
            trimmedStdout,
            lineLimits,
          )
          const normalizedData = {
            ...data,
            stdout: boundedStdout,
            stderr: typeof data.stderr === 'string' ? data.stderr : '',
          }
          // Reuse the same persistence flow as regular Bash tool calls
          const toolResultBlock = await processToolResultBlock(
            shellTool,
            normalizedData,
            randomUUID(),
          )
          // Extract the string content from the block
          const output =
            typeof toolResultBlock.content === 'string'
              ? toolResultBlock.content
              : formatBashOutput(
                  normalizedData.stdout,
                  normalizedData.stderr,
                )
          // Function replacer — String.replace interprets $$, $&, $`, $' in
          // the replacement string even with a string search pattern. Shell
          // output (especially PowerShell: $env:PATH, $$, $PSVersionTable)
          // is arbitrary user data; a bare string arg would corrupt it.
          result = result.replace(match[0], () => output)
        } catch (e) {
          if (e instanceof MalformedCommandError) {
            throw e
          }
          if (granularFallback) {
            // Blank the failed snippet in place so the other successful
            // snippets (e.g. git status, git diff) are preserved. Callers
            // can render their own fallback text outside the code blocks
            // if they need to explain the gap.
            result = result.replace(match[0], () => '')
            return
          }
          throw formatBashError(e, match[0])
        }
      }
    }),
  )

  return result
}

function formatBashOutput(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  inline = false,
): string {
  const normalizedStdout = typeof stdout === 'string' ? stdout : ''
  const normalizedStderr = typeof stderr === 'string' ? stderr : ''
  const parts: string[] = []

  if (normalizedStdout.trim()) {
    parts.push(normalizedStdout.trim())
  }

  if (normalizedStderr.trim()) {
    if (inline) {
      parts.push(`[stderr: ${normalizedStderr.trim()}]`)
    } else {
      parts.push(`[stderr]\n${normalizedStderr.trim()}`)
    }
  }

  return parts.join(inline ? ' ' : '\n')
}

function formatBashError(
  e: unknown,
  pattern: string,
  _inline = false,
): MalformedCommandError {
  // Restore the original rich diagnostic: include the failing pattern and the
  // formatted stdout/stderr so processSlashCommand can render something a user
  // can act on. Permission denials and aborts are surfaced as
  // MalformedCommandError by the caller; this path is for everything else.
  if (e instanceof MalformedCommandError) {
    return e
  }
  const stderr =
    e instanceof Error && 'stderr' in e && typeof (e as { stderr?: unknown }).stderr === 'string'
      ? (e as { stderr: string }).stderr
      : ''
  const stdout =
    e instanceof Error && 'stdout' in e && typeof (e as { stdout?: unknown }).stdout === 'string'
      ? (e as { stdout: string }).stdout
      : ''
  const formatted = formatBashOutput(stdout, stderr, false)
  const message = `Shell command failed for pattern "${pattern}": ${errorMessage(e)}${formatted ? `\n${formatted}` : ''}`
  return new MalformedCommandError(message)
}

/**
 * If `command` (trimmed) starts with a key from `limits`, slice `output` to
 * at most that many lines. Longest prefix wins so callers can register
 * `git diff HEAD -- .` and `git diff` and get the more specific cap.
 * Returns `output` unchanged when no key matches or the output is already
 * under the cap. A trailing-newline-preserving split keeps the file as
 * the diff tool would have rendered it.
 */
function applyLineLimit(
  command: string,
  output: string,
  limits: Record<string, number>,
): string {
  const trimmed = command.trim()
  let bestPrefix = ''
  let bestLimit = Infinity
  for (const [prefix, limit] of Object.entries(limits)) {
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) {
      continue
    }
    if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) {
      if (prefix.length > bestPrefix.length) {
        bestPrefix = prefix
        bestLimit = limit
      }
    }
  }
  if (bestPrefix === '') {
    return output
  }
  const lines = output.split('\n')
  if (lines.length <= bestLimit) {
    return output
  }
  const truncated = lines.slice(0, bestLimit).join('\n')
  return output.endsWith('\n') ? truncated + '\n' : truncated
}
