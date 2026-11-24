import { feature } from 'bun:bundle';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { createReadStream, createWriteStream } from 'fs';
import { copyFile, stat as fsStat, link, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import * as React from 'react';
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js';
import type { AppState } from 'src/state/AppState.js';
import { z } from 'zod/v4';
import { getKairosActive } from '../../bootstrap/state.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import type { SetToolJSXFn, Tool, ToolCallProgress, ValidationResult } from '../../Tool.js';
import { buildTool, type ToolDef } from '../../Tool.js';
import { backgroundExistingForegroundTask, markTaskNotified, registerForeground, spawnShellTask, unregisterForeground } from '../../tasks/LocalShellTask/LocalShellTask.js';
import type { AgentId } from '../../types/ids.js';
import type { AssistantMessage } from '../../types/message.js';
import { extractClaudeCodeHints, extractClaudeCodeHintsFromPreview, type ClaudeCodeHint } from '../../utils/claudeCodeHints.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { errorMessage as getErrorMessage, ShellError } from '../../utils/errors.js';
import { truncate } from '../../utils/format.js';
import { findForbiddenCommitMessagePattern, getForbiddenCommitMessagePatterns, isGeneratedCommitAttributionBlocked } from '../../utils/governancePolicy.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { logError } from '../../utils/log.js';
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js';
import { getPlatform } from '../../utils/platform.js';
import { maybeRecordPluginHint } from '../../utils/plugins/hintRecommendation.js';
import { exec } from '../../utils/Shell.js';
import type { ExecResult } from '../../utils/ShellCommand.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { semanticBoolean } from '../../utils/semanticBoolean.js';
import { semanticNumber } from '../../utils/semanticNumber.js';
import { getCachedPowerShellPath } from '../../utils/shell/powershellDetection.js';
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { TaskOutput } from '../../utils/task/TaskOutput.js';
import { isOutputLineTruncated } from '../../utils/terminal.js';
import { buildLargeToolResultMessage, ensureToolResultsDir, generateFilePreview, generatePreview, getToolResultPath, PREVIEW_SIZE_BYTES, type PreviewStrategy } from '../../utils/toolResultStorage.js';
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js';
import { BackgroundHint } from '../BashTool/UI.js';
import { buildImageToolResult, isImageOutput, resetCwdIfOutsideProject, resizeShellImageOutput, stdErrAppendShellResetMessage, stripEmptyLines } from '../BashTool/utils.js';
import { trackGitOperations } from '../shared/gitOperationTracking.js';
import { interpretCommandResult } from './commandSemantics.js';
import { powershellToolHasPermission } from './powershellPermissions.js';
import { getEffectiveTimeoutMs, getMaxTimeoutMs, getPrompt } from './prompt.js';
import { hasSyncSecurityConcerns, isReadOnlyCommand, resolveToCanonical } from './readOnlyValidation.js';
import { POWERSHELL_TOOL_NAME } from './toolName.js';
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from './UI.js';

// Never use os.EOL for terminal output — \r\n on Windows breaks Ink rendering
const EOL = '\n';
export const MAX_PERSISTED_POWERSHELL_OUTPUT_SIZE = 64 * 1024 * 1024;

export async function persistPowerShellOutputFile(
  sourcePath: string,
  taskId: string,
  maxSize: number = MAX_PERSISTED_POWERSHELL_OUTPUT_SIZE,
  command: string = '',
): Promise<{ path: string; size: number; truncated: boolean; preview?: string; previewStrategy?: PreviewStrategy; previewHints?: ClaudeCodeHint[] } | null> {
  try {
    const fileStat = await fsStat(sourcePath);
    const size = fileStat.size;
    await ensureToolResultsDir();
    const dest = getToolResultPath(taskId, false);
    const truncated = size > maxSize;
    if (truncated) {
      try {
        await pipeline(
          createReadStream(sourcePath, { start: 0, end: maxSize - 1 }),
          createWriteStream(dest),
        );
      } catch (e) {
        await unlink(dest).catch(() => {});
        throw e;
      }
    } else {
      try {
        await link(sourcePath, dest);
      } catch {
        await copyFile(sourcePath, dest);
      }
    }
    const previewSourcePath = truncated ? sourcePath : dest;
    const previewResult = await generateFilePreview(
      previewSourcePath,
      PREVIEW_SIZE_BYTES,
    ).catch(error => {
      logError(error instanceof Error ? error : new Error(getErrorMessage(error)));
      return undefined;
    });
    const previewExtraction = previewResult
      ? extractClaudeCodeHintsFromPreview(previewResult, command)
      : undefined;
    return {
      path: dest,
      size,
      truncated,
      preview: previewExtraction?.previewResult.preview,
      previewStrategy: previewExtraction?.previewResult.strategy,
      previewHints: previewExtraction?.hints,
    };
  } catch {
    return null;
  }
}

export function appendPersistedPowerShellOutputHint(
  stdout: string,
  persistedPath: string,
  persistedSize: number,
  truncated: boolean,
  preview?: string,
  previewStrategy?: PreviewStrategy,
): string {
  const capDetail = previewStrategy === 'head-tail'
    ? 'capped; preview may include tail bytes not saved at that path'
    : 'capped, tail not saved';
  const hint = truncated
    ? `[output truncated above — first ${MAX_PERSISTED_POWERSHELL_OUTPUT_SIZE} bytes of the ${persistedSize}-byte output saved to ${persistedPath} (${capDetail}); read with the Read tool]`
    : `[output truncated above — full output (${persistedSize} bytes) saved to ${persistedPath}; read with the Read tool]`;
  const previewStrategyLabel = previewStrategy === 'head-tail'
    ? 'head and tail'
    : previewStrategy === 'complete'
      ? 'complete'
      : 'head-only partial';
  const previewBlock = preview
    ? `Persisted output preview (UTF-8-safe ${previewStrategyLabel}, ${PREVIEW_SIZE_BYTES}-byte budget):\n${preview}`
    : '';
  const capturedFallback = preview
    ? ''
    : stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const parts = [capturedFallback, previewBlock, hint].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * PowerShell search commands (grep equivalents) for collapsible display.
 * Stored as canonical (lowercase) cmdlet names.
 */
const PS_SEARCH_COMMANDS = new Set(['select-string',
// grep equivalent
'get-childitem',
// find equivalent (with -Recurse)
'findstr',
// native Windows search
'where.exe' // native Windows which
]);

/**
 * PowerShell read/view commands for collapsible display.
 * Stored as canonical (lowercase) cmdlet names.
 */
const PS_READ_COMMANDS = new Set(['get-content',
// cat equivalent
'get-item',
// file info
'test-path',
// test -e equivalent
'resolve-path',
// realpath equivalent
'get-process',
// ps equivalent
'get-service',
// system info
'get-childitem',
// ls/dir equivalent (also search when recursive)
'get-location',
// pwd equivalent
'get-filehash',
// checksum
'get-acl',
// permissions info
'format-hex' // hexdump equivalent
]);

/**
 * PowerShell semantic-neutral commands that don't change the search/read nature.
 */
const PS_SEMANTIC_NEUTRAL_COMMANDS = new Set(['write-output',
// echo equivalent
'write-host']);

/**
 * Checks if a PowerShell command is a search or read operation.
 * Used to determine if the command should be collapsed in the UI.
 */
function isSearchOrReadPowerShellCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
} {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      isSearch: false,
      isRead: false
    };
  }

  // Simple split on statement separators and pipe operators
  // This is a sync function so we use a lightweight approach
  const parts = trimmed.split(/\s*[;|]\s*/).filter(Boolean);
  if (parts.length === 0) {
    return {
      isSearch: false,
      isRead: false
    };
  }
  let hasSearch = false;
  let hasRead = false;
  let hasNonNeutralCommand = false;
  for (const part of parts) {
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    const canonical = resolveToCanonical(baseCommand);
    if (PS_SEMANTIC_NEUTRAL_COMMANDS.has(canonical)) {
      continue;
    }
    hasNonNeutralCommand = true;
    const isPartSearch = PS_SEARCH_COMMANDS.has(canonical);
    const isPartRead = PS_READ_COMMANDS.has(canonical);
    if (!isPartSearch && !isPartRead) {
      return {
        isSearch: false,
        isRead: false
      };
    }
    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
  }
  if (!hasNonNeutralCommand) {
    return {
      isSearch: false,
      isRead: false
    };
  }
  return {
    isSearch: hasSearch,
    isRead: hasRead
  };
}

// Progress display constants
const PROGRESS_THRESHOLD_MS = 2000;
const PROGRESS_INTERVAL_MS = 1000;
// In assistant mode, blocking commands auto-background after this many ms in the main agent
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

// Commands that should not be auto-backgrounded (canonical lowercase).
// 'sleep' is a PS built-in alias for Start-Sleep but not in COMMON_ALIASES,
// so list both forms.
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['start-sleep',
// Start-Sleep should run in foreground unless explicitly backgrounded
'sleep'];

/**
 * Checks if a command is allowed to be automatically backgrounded
 * @param command The command to check
 * @returns false for commands that should not be auto-backgrounded (like Start-Sleep)
 */
function isAutobackgroundingAllowed(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  if (!firstWord) return true;
  const canonical = resolveToCanonical(firstWord);
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(canonical);
}

/**
 * PS-flavored port of BashTool's detectBlockedSleepPattern.
 * Catches `Start-Sleep N`, `Start-Sleep -Seconds N`, `sleep N` (built-in alias)
 * as the first statement. Does NOT block `Start-Sleep -Milliseconds` (sub-second
 * pacing is fine) or float seconds (legit rate limiting).
 */
export function detectBlockedSleepPattern(command: string): string | null {
  // First statement only — split on PS statement separators: `;`, `|`,
  // `&`/`&&`/`||` (pwsh 7+), and newline (PS's primary separator). This is
  // intentionally shallow — sleep inside script blocks, subshells, or later
  // pipeline stages is fine. Matches BashTool's splitCommandWithOperators
  // intent (src/utils/bash/commands.ts) without a full PS parser.
  const first = command.trim().split(/[;|&\r\n]/)[0]?.trim() ?? '';
  // Match: Start-Sleep N, Start-Sleep -Seconds N, Start-Sleep -s N, sleep N
  // (case-insensitive; -Seconds can be abbreviated to -s per PS convention)
  const m = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first);
  if (!m) return null;
  const secs = parseInt(m[1]!, 10);
  if (secs < 2) return null; // sub-2s sleeps are fine (rate limiting, pacing)

  const rest = command.trim().slice(first.length).replace(/^[\s;|&]+/, '');
  return rest ? `Start-Sleep ${secs} followed by: ${rest}` : `standalone Start-Sleep ${secs}`;
}

function takePowerShellToken(input: string): string | null {
  const match = input.match(/^(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&()]+)/);
  return match?.[0] ?? null;
}

function normalizePowerShellGitCommitCommand(command: string): string | null {
  const normalizedInput = command
    .trimStart()
    .replace(/^&\s*(?=(?:"git(?:\.exe)?"|'git(?:\.exe)?'|git(?:\.exe)?\s+))/i, '');
  const gitMatch = normalizedInput.match(/^(?:"git(?:\.exe)?"|'git(?:\.exe)?'|git(?:\.exe)?)\s+/i);
  if (!gitMatch) return null;

  let rest = normalizedInput.slice(gitMatch[0].length);
  for (;;) {
    const commitMatch = rest.match(/^commit(?=$|\s)/i);
    if (commitMatch) {
      return `git commit${rest.slice(commitMatch[0].length)}`;
    }

    const flag = takePowerShellToken(rest);
    if (!flag?.startsWith('-')) return null;
    rest = rest.slice(flag.length).replace(/^\s+/, '');

    const hasInlineValue = flag.includes('=');
    const needsValue =
      flag.toLowerCase() === '-c' ||
      [
        '--git-dir',
        '--work-tree',
        '--namespace',
        '--super-prefix',
        '--config-env',
        '--exec-path'
      ].includes(flag.toLowerCase());

    if (needsValue && !hasInlineValue) {
      const value = takePowerShellToken(rest);
      if (!value) return null;
      rest = rest.slice(value.length).replace(/^\s+/, '');
    }
  }
}

function hasExpandablePowerShellText(message: string): boolean {
  return /(^|[^`])\$\w|(^|[^`])\$\{[^}]+\}|(^|[^`])\$\(/.test(message);
}

function extractPowerShellGitCommitMessages(command: string): {
  messages: string[];
  hasUninspectableSource: boolean;
} {
  const normalizedCommand = normalizePowerShellGitCommitCommand(command);
  if (!normalizedCommand) return { messages: [], hasUninspectableSource: false };

  const messages: string[] = [];
  let hasUninspectableSource = false;
  const quotedPattern = /(?:^|\s)(?:-m|--message)\s+(["'])([\s\S]*?)\1|(?:^|\s)--message=(["'])([\s\S]*?)\3/g;
  for (const match of normalizedCommand.matchAll(quotedPattern)) {
    const quote = match[1] ?? match[3];
    const message = match[2] ?? match[4] ?? '';
    if (quote === '"' && hasExpandablePowerShellText(message)) {
      hasUninspectableSource = true;
      continue;
    }
    messages.push(message);
  }

  const unquotedPattern = /(?:^|\s)(?:-m|--message)\s+([^"'\s;|&()]+)|(?:^|\s)--message=([^"'\s;|&()]+)/g;
  for (const match of normalizedCommand.matchAll(unquotedPattern)) {
    const message = match[1] ?? match[2] ?? '';
    if (hasExpandablePowerShellText(message)) {
      hasUninspectableSource = true;
      continue;
    }
    messages.push(message);
  }

  const hereStringPattern = /(?:^|\s)(?:-m|--message)\s+@'\r?\n([\s\S]*?)\r?\n'@|(?:^|\s)--message=@'\r?\n([\s\S]*?)\r?\n'@/g;
  for (const match of normalizedCommand.matchAll(hereStringPattern)) {
    messages.push(match[1] ?? match[2] ?? '');
  }

  const expandableHereStringPattern = /(?:^|\s)(?:-m|--message)\s+@"\r?\n([\s\S]*?)\r?\n"@|(?:^|\s)--message=@"\r?\n([\s\S]*?)\r?\n"@/g;
  for (const match of normalizedCommand.matchAll(expandableHereStringPattern)) {
    const message = match[1] ?? match[2] ?? '';
    if (hasExpandablePowerShellText(message)) {
      hasUninspectableSource = true;
      continue;
    }
    messages.push(message);
  }

  return { messages, hasUninspectableSource };
}

function powerShellGitCommitUsesFileMessage(command: string): boolean {
  const normalizedCommand = normalizePowerShellGitCommitCommand(command);
  if (!normalizedCommand) return false;

  return /(?:^|\s)(?:-F|--file)\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&()]+)|(?:^|\s)--file=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&()]+)/i.test(normalizedCommand);
}

function hasCommitMessagePolicyRestrictions(): boolean {
  return getForbiddenCommitMessagePatterns().length > 0 || isGeneratedCommitAttributionBlocked();
}

function commitPolicyAsk(message: string): PermissionResult {
  return {
    behavior: 'ask',
    message,
    decisionReason: {
      type: 'safetyCheck',
      reason: message,
      classifierApprovable: false
    }
  };
}

function splitPowerShellStatements(command: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let hereStringTerminator: '"@' | "'@" | null = null;

  for (let i = 0; i < command.length; i++) {
    if (hereStringTerminator) {
      if (
        command.startsWith(hereStringTerminator, i) &&
        (i === 0 || command[i - 1] === '\n' || command[i - 1] === '\r')
      ) {
        i += hereStringTerminator.length - 1;
        hereStringTerminator = null;
      }
      continue;
    }

    const char = command[i];
    const next = command[i + 1];
    if (!quote && char === '@' && (next === "'" || next === '"')) {
      hereStringTerminator = next === "'" ? "'@" : '"@';
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n' || char === '\r' || (char === '&' && next === '&')) {
      const statement = command.slice(start, i).trim();
      if (statement) statements.push(statement);
      if (char === '&') i++;
      if (char === '\r' && next === '\n') i++;
      start = i + 1;
    }
  }

  const statement = command.slice(start).trim();
  if (statement) statements.push(statement);
  return statements.length > 0 ? statements : [command];
}

function checkPowerShellCommitMessagePolicyForStatement(command: string): PermissionResult | null {
  const normalizedCommand = normalizePowerShellGitCommitCommand(command);
  if (!normalizedCommand) return null;

  const hasPolicyRestrictions = hasCommitMessagePolicyRestrictions();

  if (powerShellGitCommitUsesFileMessage(command) && hasPolicyRestrictions) {
    return commitPolicyAsk('Git commit message is loaded from a file and cannot be checked against commit-message policy');
  }

  const { messages, hasUninspectableSource } = extractPowerShellGitCommitMessages(command);
  if ((hasUninspectableSource || messages.length === 0) && hasPolicyRestrictions) {
    return commitPolicyAsk('Git commit message source cannot be checked against commit-message policy');
  }

  for (const message of messages) {
    const forbiddenPattern = findForbiddenCommitMessagePattern(message);
    if (forbiddenPattern) {
      return commitPolicyAsk(`Git commit message contains forbidden pattern: ${forbiddenPattern}`);
    }
    if (isGeneratedCommitAttributionBlocked() && /Co-Authored-By:|Generated with/i.test(message)) {
      return commitPolicyAsk('Git commit message contains AI attribution that is disabled by policy');
    }
  }
  return null;
}

export function checkPowerShellCommitMessagePolicy(command: string): PermissionResult | null {
  for (const statement of splitPowerShellStatements(command)) {
    const result = checkPowerShellCommitMessagePolicyForStatement(statement);
    if (result) return result;
  }
  return null;
}

/**
 * On Windows native, sandbox is unavailable (bwrap/sandbox-exec are
 * POSIX-only). If enterprise policy has sandbox.enabled AND forbids
 * unsandboxed commands, PowerShell cannot comply — refuse execution
 * rather than silently bypass the policy. On Linux/macOS/WSL2, pwsh
 * runs as a native binary under the sandbox same as bash, so this
 * gate does not apply.
 *
 * Checked in BOTH validateInput (clean tool-runner error) and call()
 * (covers direct callers like promptShellExecution.ts that skip
 * validateInput). The call() guard is the load-bearing one.
 */
const WINDOWS_SANDBOX_POLICY_REFUSAL = 'Enterprise policy requires sandboxing, but sandboxing is not available on native Windows. Shell command execution is blocked on this platform by policy.';
function isWindowsSandboxPolicyViolation(): boolean {
  return getPlatform() === 'windows' && SandboxManager.isSandboxEnabledInSettings() && !SandboxManager.areUnsandboxedCommandsAllowed();
}

// Check if background tasks are disabled at module load time
const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('The PowerShell command to execute'),
  timeout: semanticNumber(z.number().optional()).describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
  description: z.string().optional().describe('Clear, concise description of what this command does in active voice.'),
  run_in_background: semanticBoolean(z.boolean().optional()).describe(`Set to true to run this command in the background. Use Read to read the output later.`),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('Set this to true to dangerously override sandbox mode and run commands without sandboxing.'),
  _dangerouslyDisableSandboxApproved: z.boolean().optional().describe('Internal: user-approved sandbox override')
}));

// Omit internal-only sandbox override fields from the model-facing schema.
// Conditionally remove run_in_background from schema when background tasks are disabled.
const inputSchema = lazySchema(() => isBackgroundTasksDisabled ? fullInputSchema().omit({
  run_in_background: true,
  dangerouslyDisableSandbox: true,
  _dangerouslyDisableSandboxApproved: true
}) : fullInputSchema().omit({
  dangerouslyDisableSandbox: true,
  _dangerouslyDisableSandboxApproved: true
}));
type InputSchema = ReturnType<typeof inputSchema>;

// Use fullInputSchema for the type to always include run_in_background
// (even when it's omitted from the schema, the code needs to handle it)
export type PowerShellToolInput = z.infer<ReturnType<typeof fullInputSchema>>;
const outputSchema = lazySchema(() => z.object({
  stdout: z.string().describe('The standard output of the command'),
  stderr: z.string().describe('The standard error output of the command'),
  interrupted: z.boolean().describe('Whether the command was interrupted'),
  isAbort: z.boolean().optional().describe('Whether the command was cancelled through the abort path'),
  abortReason: z.string().optional().describe('Normalized abort reason when the command was cancelled'),
  abortMessage: z.string().optional().describe('Safe user-facing abort explanation'),
  returnCodeInterpretation: z.string().optional().describe('Semantic interpretation for non-error exit codes with special meaning'),
  isImage: z.boolean().optional().describe('Flag to indicate if stdout contains image data'),
  persistedOutputPath: z.string().optional().describe('Path to persisted full output when too large for inline'),
  persistedOutputSize: z.number().optional().describe('Total output size in bytes when persisted'),
  persistedOutputPreview: z.string().optional().describe('UTF-8-safe head/tail preview read from the complete rolled-output source'),
  persistedOutputPreviewStrategy: z.enum(['complete', 'head-tail', 'head-only']).optional().describe('How the persisted output preview was selected'),
  persistedOutputTruncated: z.boolean().optional().describe('Whether the persisted file is capped (only the first portion of the output was saved)'),
  backgroundTaskId: z.string().optional().describe('ID of the background task if command is running in background'),
  backgroundedByUser: z.boolean().optional().describe('True if the user manually backgrounded the command with Ctrl+B'),
  assistantAutoBackgrounded: z.boolean().optional().describe('True if the command was auto-backgrounded by the assistant-mode blocking budget')
}));
type OutputSchema = ReturnType<typeof outputSchema>;
export type Out = z.infer<OutputSchema>;
import type { PowerShellProgress } from '../../types/tools.js';
export type { PowerShellProgress } from '../../types/tools.js';
const COMMON_BACKGROUND_COMMANDS = ['npm', 'yarn', 'pnpm', 'node', 'python', 'python3', 'go', 'cargo', 'make', 'docker', 'terraform', 'webpack', 'vite', 'jest', 'pytest', 'curl', 'Invoke-WebRequest', 'build', 'test', 'serve', 'watch', 'dev'] as const;
function getCommandTypeForLogging(command: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/)[0] || '';
  for (const cmd of COMMON_BACKGROUND_COMMANDS) {
    if (firstWord.toLowerCase() === cmd.toLowerCase()) {
      return cmd as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
  }
  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
}
export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  searchHint: 'execute Windows PowerShell commands',
  maxResultSizeChars: 30_000,
  strict: true,
  async description({
    description
  }: Partial<PowerShellToolInput>): Promise<string> {
    return description || 'Run PowerShell command';
  },
  async prompt(): Promise<string> {
    return getPrompt();
  },
  isConcurrencySafe(input: PowerShellToolInput): boolean {
    return this.isReadOnly?.(input) ?? false;
  },
  isSearchOrReadCommand(input: Partial<PowerShellToolInput>): {
    isSearch: boolean;
    isRead: boolean;
  } {
    if (!input.command) {
      return {
        isSearch: false,
        isRead: false
      };
    }
    return isSearchOrReadPowerShellCommand(input.command);
  },
  isReadOnly(input: PowerShellToolInput): boolean {
    // Check sync security heuristics before declaring read-only.
    // The full AST parse is async and unavailable here, so we use
    // regex-based detection of subexpressions, splatting, member
    // invocations, and assignments — matching BashTool's pattern of
    // checking security concerns before cmdlet allowlist evaluation.
    if (hasSyncSecurityConcerns(input.command)) {
      return false;
    }
    // NOTE: This calls isReadOnlyCommand without the parsed AST. Without the
    // AST, isReadOnlyCommand cannot split pipelines/statements and will return
    // false for anything but the simplest single-token commands. This is a
    // known limitation of the sync Tool.isReadOnly() interface — the real
    // read-only auto-allow happens async in powershellToolHasPermission (step
    // 4.5) where the parsed AST is available.
    return isReadOnlyCommand(input.command);
  },
  toAutoClassifierInput(input) {
    return input.command;
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName(): string {
    return 'PowerShell';
  },
  getToolUseSummary(input: Partial<PowerShellToolInput> | undefined): string | null {
    if (!input?.command) {
      return null;
    }
    const {
      command,
      description
    } = input;
    if (description) {
      return description;
    }
    return truncate(command, TOOL_SUMMARY_MAX_LENGTH);
  },
  getActivityDescription(input: Partial<PowerShellToolInput> | undefined): string {
    if (!input?.command) {
      return 'Running command';
    }
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH);
    return `Running ${desc}`;
  },
  isEnabled(): boolean {
    return true;
  },
  async validateInput(input: PowerShellToolInput): Promise<ValidationResult> {
    // Defense-in-depth: also guarded in call() for direct callers.
    if (isWindowsSandboxPolicyViolation()) {
      return {
        result: false,
        message: WINDOWS_SANDBOX_POLICY_REFUSAL,
        errorCode: 11
      };
    }
    if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
      const sleepPattern = detectBlockedSleepPattern(input.command);
      if (sleepPattern !== null) {
        return {
          result: false,
          message: `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. For streaming events (watching logs, polling APIs), use the Monitor tool. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
          errorCode: 10
        };
      }
    }
    return {
      result: true
    };
  },
  async checkPermissions(input: PowerShellToolInput, context: Parameters<Tool['checkPermissions']>[1]): Promise<PermissionResult> {
    const policyResult = checkPowerShellCommitMessagePolicy(input.command);
    if (policyResult) return policyResult;
    return await powershellToolHasPermission(input, context);
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  mapToolResultToToolResultBlockParam({
    interrupted,
    stdout,
    stderr,
    isImage,
    persistedOutputPath,
    persistedOutputSize,
    persistedOutputPreview,
    persistedOutputPreviewStrategy,
    persistedOutputTruncated,
    backgroundTaskId,
    backgroundedByUser,
    assistantAutoBackgrounded,
    abortMessage
  }: Out, toolUseID: string): ToolResultBlockParam {
    // For image data, format as image content block for Claude
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID);
      if (block) return block;
    }
    const normalizedStdout = typeof stdout === 'string' ? stdout : '';
    const normalizedStderr = typeof stderr === 'string' ? stderr : '';
    let processedStdout = normalizedStdout;
    if (persistedOutputPath) {
      const trimmed = normalizedStdout
        ? normalizedStdout.replace(/^(\s*\n)+/, '').trimEnd()
        : '';
      // Prefer the bounded preview read from the full rolled-output source.
      // If that read failed, the in-memory value is only a captured head.
      const preview = persistedOutputPreview ?? generatePreview(
        trimmed,
        PREVIEW_SIZE_BYTES,
        'head-only',
      ).preview;
      const strategy = persistedOutputPreviewStrategy ?? 'head-only';
      processedStdout = buildLargeToolResultMessage({
        filepath: persistedOutputPath,
        originalSize: persistedOutputSize ?? 0,
        isJson: false,
        preview,
        hasMore: strategy !== 'complete',
        strategy,
        truncated: persistedOutputTruncated
      });
    } else if (normalizedStdout) {
      processedStdout = normalizedStdout.replace(/^(\s*\n)+/, '');
      processedStdout = processedStdout.trimEnd();
    }
    let errorMessage = normalizedStderr.trim();
    if (interrupted) {
      if (normalizedStderr) errorMessage += EOL;
      errorMessage += `<error>${abortMessage ?? 'Command was aborted before completion'}</error>`;
    }
    let backgroundInfo = '';
    if (backgroundTaskId) {
      const outputPath = getTaskOutputPath(backgroundTaskId);
      if (assistantAutoBackgrounded) {
        backgroundInfo = `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${backgroundTaskId}. It is still running — you will be notified when it completes. Output is being written to: ${outputPath}. In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`;
      } else if (backgroundedByUser) {
        backgroundInfo = `Command was manually backgrounded by user with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`;
      } else {
        backgroundInfo = `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`;
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [processedStdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      is_error: interrupted
    };
  },
  async call(input: PowerShellToolInput, toolUseContext: Parameters<Tool['call']>[1], _canUseTool?: CanUseToolFn, _parentMessage?: AssistantMessage, onProgress?: ToolCallProgress<PowerShellProgress>): Promise<{
    data: Out;
  }> {
    // Load-bearing guard: promptShellExecution.ts and processBashCommand.tsx
    // call PowerShellTool.call() directly, bypassing validateInput. This is
    // the check that covers ALL callers. See isWindowsSandboxPolicyViolation
    // comment for the policy rationale.
    if (isWindowsSandboxPolicyViolation()) {
      throw new Error(WINDOWS_SANDBOX_POLICY_REFUSAL);
    }
    const {
      abortController,
      setAppState,
      setToolJSX
    } = toolUseContext;
    const isMainThread = !toolUseContext.agentId;
    let progressCounter = 0;
    try {
      const commandGenerator = runPowerShellCommand({
        input,
        abortController,
        // Use the always-shared task channel so async agents' background
        // shell tasks are actually registered (and killable on agent exit).
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges: !isMainThread,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId,
        foregroundOnly: toolUseContext.replInnerExecution === true
      });
      let generatorResult;
      do {
        generatorResult = await commandGenerator.next();
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value;
          onProgress({
            toolUseID: `ps-progress-${progressCounter++}`,
            data: {
              type: 'powershell_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes,
              timeoutMs: progress.timeoutMs,
              taskId: progress.taskId
            }
          });
        }
      } while (!generatorResult.done);
      const result = generatorResult.value;

      // Feed git/PR usage metrics (same counters as BashTool). PS invokes
      // git/gh/glab/curl as external binaries with identical syntax, so the
      // shell-agnostic regex detection in trackGitOperations works as-is.
      // Called before the backgroundTaskId early-return so backgrounded
      // commands are counted too (matches BashTool.tsx:912).
      //
      // Pre-flight sentinel guard: the two PS pre-flight paths (pwsh-not-found,
      // exec-spawn-catch) return code: 0 + empty stdout + stderr so call() can
      // surface stderr gracefully instead of throwing ShellError. But
      // gitOperationTracking.ts:48 treats code 0 as success and would
      // regex-match the command, mis-counting a command that never ran.
      // BashTool is safe — its pre-flight goes through createFailedCommand
      // (code: 1) so tracking early-returns. Skip tracking on this sentinel.
      const isPreFlightSentinel = result.code === 0 && !result.stdout && result.stderr && !result.backgroundTaskId;
      if (!isPreFlightSentinel) {
        trackGitOperations(input.command, result.code, result.stdout);
      }

      // Suppress ShellError only for commands killed through the abort path.
      // Tool timeouts and ordinary non-zero exits still surface as failures.
      // Matches BashTool's abort classification.
      const isAbort = result.isAbort === true;

      // Only the main thread tracks/resets cwd; agents have their own cwd
      // isolation. Matches BashTool's !preventCwdChanges guard.
      // Runs before the backgroundTaskId early-return: a command may change
      // CWD before being backgrounded (e.g. `Set-Location C:\temp;
      // Start-Sleep 60`), and BashTool has no such early return — its
      // backgrounded results flow through resetCwdIfOutsideProject at :945.
      let stderrForShellReset = '';
      if (isMainThread) {
        const appState = toolUseContext.getAppState();
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('');
        }
      }

      // If backgrounded, return immediately with task ID. Strip hints first
      // so interrupt-backgrounded fullOutput doesn't leak the tag to the
      // model (BashTool has no early return, so all paths flow through its
      // single extraction site).
      if (result.backgroundTaskId) {
        const bgExtracted = extractClaudeCodeHints(result.stdout || '', input.command);
        if (isMainThread && bgExtracted.hints.length > 0) {
          for (const hint of bgExtracted.hints) maybeRecordPluginHint(hint);
        }
        return {
          data: {
            stdout: bgExtracted.stripped,
            stderr: [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n'),
            interrupted: false,
            isAbort: false,
            backgroundTaskId: result.backgroundTaskId,
            backgroundedByUser: result.backgroundedByUser,
            assistantAutoBackgrounded: result.assistantAutoBackgrounded
          }
        };
      }
      const stdoutAccumulator = new EndTruncatingAccumulator();
      const processedStdout = (result.stdout || '').trimEnd();
      stdoutAccumulator.append(processedStdout + EOL);

      // Interpret exit code using semantic rules. PS-native cmdlets (Select-String,
      // Compare-Object, Test-Path) exit 0 on no-match so they always hit the default
      // here. This primarily handles external .exe's (grep, rg, findstr, fc, robocopy)
      // where non-zero can mean "no match" / "files copied" rather than failure.
      const interpretation = interpretCommandResult(input.command, result.code, processedStdout, result.stderr || '');

      // getErrorParts() in toolErrors.ts already prepends 'Exit code N'
      // from error.code when building the ShellError message. Do not
      // duplicate it into stdout here (BashTool's append at :939 is dead
      // code — it throws before stdoutAccumulator.toString() is read).

      let stdout = stripEmptyLines(stdoutAccumulator.toString());

      // Claude Code hints protocol: CLIs/SDKs gated on CLAUDECODE=1 emit a
      // `<claude-code-hint />` tag to stderr (merged into stdout here). Scan,
      // record for useClaudeCodeHintRecommendation to surface, then strip
      // so the model never sees the tag — a zero-token side channel.
      // Stripping runs unconditionally (subagent output must stay clean too);
      // only the dialog recording is main-thread-only.
      const extracted = extractClaudeCodeHints(stdout, input.command);
      stdout = extracted.stripped;
      if (isMainThread && extracted.hints.length > 0) {
        for (const hint of extracted.hints) maybeRecordPluginHint(hint);
      }

      // preSpawnError means exec() succeeded but the inner shell failed before
      // the command ran (e.g. CWD deleted). createFailedCommand sets code=1,
      // which interpretCommandResult can mistake for grep-no-match / findstr
      // string-not-found. Throw it directly. Matches BashTool.tsx:957.
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError);
      }
      if (interpretation.isError && !isAbort) {
        let errorStdout = stdout;
        if (result.outputFilePath && result.outputTaskId) {
          const persistedForError = await persistPowerShellOutputFile(
            result.outputFilePath,
            result.outputTaskId,
            MAX_PERSISTED_POWERSHELL_OUTPUT_SIZE,
            input.command,
          );
          if (persistedForError) {
            if (isMainThread) {
              for (const hint of persistedForError.previewHints ?? []) {
                const alreadyCaptured = extracted.hints.some(
                  captured =>
                    captured.v === hint.v &&
                    captured.type === hint.type &&
                    captured.value === hint.value,
                );
                if (!alreadyCaptured) maybeRecordPluginHint(hint);
              }
            }
            errorStdout = appendPersistedPowerShellOutputHint(
              errorStdout,
              persistedForError.path,
              persistedForError.size,
              persistedForError.truncated,
              persistedForError.preview,
              persistedForError.previewStrategy,
            );
          }
        }
        throw new ShellError(errorStdout, result.stderr || '', result.code, result.interrupted, {
          abortReason: result.abortReason,
          abortMessage: result.abortMessage,
          isAbort: result.isAbort
        });
      }

      // Large output: file on disk has more than getMaxOutputLength() bytes.
      // stdout already contains the first chunk. Copy the output file to the
      // tool-results dir so the model can read it via FileRead.
      let persistedOutputPath: string | undefined;
      let persistedOutputSize: number | undefined;
      let persistedOutputPreview: string | undefined;
      let persistedOutputPreviewStrategy: PreviewStrategy | undefined;
      let persistedOutputTruncated: boolean | undefined;
      if (result.outputFilePath && result.outputTaskId) {
        const persisted = await persistPowerShellOutputFile(
          result.outputFilePath,
          result.outputTaskId,
          MAX_PERSISTED_POWERSHELL_OUTPUT_SIZE,
          input.command,
        );
        if (persisted) {
          persistedOutputPath = persisted.path;
          persistedOutputSize = persisted.size;
          persistedOutputPreview = persisted.preview;
          persistedOutputPreviewStrategy = persisted.previewStrategy;
          persistedOutputTruncated = persisted.truncated;
          if (isMainThread) {
            for (const hint of persisted.previewHints ?? []) {
              const alreadyCaptured = extracted.hints.some(
                captured =>
                  captured.v === hint.v &&
                  captured.type === hint.type &&
                  captured.value === hint.value,
              );
              if (!alreadyCaptured) maybeRecordPluginHint(hint);
            }
          }
        }
      }

      // Cap image dimensions + size if present (CC-304 — see
      // resizeShellImageOutput). Scope the decoded buffer so it can be
      // reclaimed before we build the output object.
      let isImage = isImageOutput(stdout);
      let compressedStdout = stdout;
      if (isImage) {
        const resized = await resizeShellImageOutput(stdout, result.outputFilePath, persistedOutputSize);
        if (resized) {
          compressedStdout = resized;
        } else {
          // Parse failed (e.g. multi-line stdout after the data URL). Keep
          // isImage in sync with what we actually send so the UI label stays
          // accurate — mapToolResultToToolResultBlockParam's defensive
          // fallthrough will send text, not an image block.
          isImage = false;
        }
      }
      const finalStderr = [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n');
      logEvent('tengu_powershell_tool_command_executed', {
        command_type: getCommandTypeForLogging(input.command),
        stdout_length: compressedStdout.length,
        stderr_length: finalStderr.length,
        exit_code: result.code,
        interrupted: result.interrupted,
        duration_ms: result.durationMs,
        signal: result.signal as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined,
        signal_aborted: result.signalAborted,
        is_abort: result.isAbort,
        abort_reason: result.abortReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined,
        result_stdout_length: result.stdoutLength,
        result_stderr_length: result.stderrLength
      });
      return {
        data: {
          stdout: compressedStdout,
          stderr: finalStderr,
          interrupted: result.interrupted,
          isAbort: result.isAbort,
          abortReason: result.abortReason,
          abortMessage: result.abortMessage,
          returnCodeInterpretation: interpretation.message,
          isImage,
          persistedOutputPath,
          persistedOutputSize,
          persistedOutputPreview,
          persistedOutputPreviewStrategy,
          persistedOutputTruncated
        }
      };
    } finally {
      if (setToolJSX) setToolJSX(null);
    }
  },
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  }
} satisfies ToolDef<InputSchema, Out>);
async function* runPowerShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId,
  foregroundOnly
}: {
  input: PowerShellToolInput;
  abortController: AbortController;
  setAppState: (f: (prev: AppState) => AppState) => void;
  setToolJSX?: SetToolJSXFn;
  preventCwdChanges?: boolean;
  isMainThread?: boolean;
  toolUseId?: string;
  agentId?: AgentId;
  foregroundOnly?: boolean;
}): AsyncGenerator<{
  type: 'progress';
  output: string;
  fullOutput: string;
  elapsedTimeSeconds: number;
  totalLines: number;
  totalBytes: number;
  taskId?: string;
  timeoutMs?: number;
}, ExecResult, void> {
  const {
    command,
    description,
    timeout,
    run_in_background,
    dangerouslyDisableSandbox,
    _dangerouslyDisableSandboxApproved
  } = input;
  const timeoutMs = getEffectiveTimeoutMs(timeout);
  let fullOutput = '';
  let lastProgressOutput = '';
  let lastTotalLines = 0;
  let lastTotalBytes = 0;
  let backgroundShellId: string | undefined = undefined;
  let interruptBackgroundingStarted = false;
  let assistantAutoBackgrounded = false;

  // Progress signal: resolved when backgroundShellId is set in the async
  // .then() path, waking the generator's Promise.race immediately instead of
  // waiting for the next setTimeout tick (matches BashTool pattern).
  let resolveProgress: (() => void) | null = null;
  function createProgressSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null);
    });
  }
  const shouldAutoBackground = foregroundOnly !== true && !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command);
  const powershellPath = await getCachedPowerShellPath();
  if (!powershellPath) {
    // Pre-flight failure: pwsh not installed. Return code 0 so call() surfaces
    // this as a graceful stderr message rather than throwing ShellError — the
    // command never ran, so there is no meaningful non-zero exit to report.
    return {
      stdout: '',
      stderr: 'PowerShell is not available on this system.',
      code: 0,
      interrupted: false
    };
  }
  let shellCommand: Awaited<ReturnType<typeof exec>>;
  try {
    shellCommand = await exec(command, abortController.signal, 'powershell', {
      timeout: timeoutMs,
      onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
        lastProgressOutput = lastLines;
        fullOutput = allLines;
        lastTotalLines = totalLines;
        lastTotalBytes = isIncomplete ? totalBytes : 0;
      },
      preventCwdChanges,
      // Sandbox works on Linux/macOS/WSL2 — pwsh there is a native binary and
      // SandboxManager.wrapWithSandbox wraps it same as bash (Shell.ts uses
      // /bin/sh for the outer spawn to parse the POSIX-quoted bwrap/sandbox-exec
      // string). On Windows native, sandbox is unsupported; shouldUseSandbox()
      // returns false via isSandboxingEnabled() → isSupportedPlatform() → false.
      // The explicit platform check is redundant-but-obvious.
      shouldUseSandbox: getPlatform() === 'windows' ? false : shouldUseSandbox({
        command,
        dangerouslyDisableSandbox,
        _dangerouslyDisableSandboxApproved
      }),
      shouldAutoBackground
    });
  } catch (e) {
    logError(e);
    // Pre-flight failure: spawn/exec rejected before the command ran. Use
    // code 0 so call() returns stderr gracefully instead of throwing ShellError.
    return {
      stdout: '',
      stderr: `Failed to execute PowerShell command: ${getErrorMessage(e)}`,
      code: 0,
      interrupted: false
    };
  }
  const resultPromise = shellCommand.result;

  // Helper to spawn a background task and return its ID
  async function spawnBackgroundTask(): Promise<string> {
    const handle = await spawnShellTask({
      command,
      description: description || command,
      shellCommand,
      toolUseId,
      agentId
    }, {
      abortController,
      getAppState: () => {
        throw new Error('getAppState not available in runPowerShellCommand context');
      },
      setAppState
    });
    return handle.taskId;
  }

  // Helper to start backgrounding with logging
  function startBackgrounding(eventName: string, backgroundFn?: (shellId: string) => void): void {
    // If a foreground task is already registered (via registerForeground in the
    // progress loop), background it in-place instead of re-spawning. Re-spawning
    // would overwrite tasks[taskId], emit a duplicate task_started SDK event,
    // and leak the first cleanup callback.
    if (foregroundTaskId) {
      if (!backgroundExistingForegroundTask(foregroundTaskId, shellCommand, description || command, setAppState, toolUseId)) {
        return;
      }
      backgroundShellId = foregroundTaskId;
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command)
      });
      backgroundFn?.(foregroundTaskId);
      return;
    }

    // No foreground task registered — spawn a new background task
    // Note: spawn is essentially synchronous despite being async
    void spawnBackgroundTask().then(shellId => {
      backgroundShellId = shellId;

      // Wake the generator's Promise.race so it sees backgroundShellId.
      // Without this, the generator waits for the current setTimeout to fire
      // (up to ~1s) before noticing the backgrounding. Matches BashTool.
      const resolve = resolveProgress;
      if (resolve) {
        resolveProgress = null;
        resolve();
      }
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command)
      });
      if (backgroundFn) {
        backgroundFn(shellId);
      }
    });
  }

  // Set up auto-backgrounding on timeout if enabled
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding('tengu_powershell_command_timeout_backgrounded', backgroundFn);
    });
  }

  // In assistant mode, the main agent should stay responsive. Auto-background
  // blocking commands after ASSISTANT_BLOCKING_BUDGET_MS so the agent can keep
  // coordinating instead of waiting. The command keeps running — no state loss.
  if (foregroundOnly !== true && feature('KAIROS') && getKairosActive() && isMainThread && !isBackgroundTasksDisabled && run_in_background !== true) {
    setTimeout(() => {
      if (shellCommand.status === 'running' && backgroundShellId === undefined) {
        assistantAutoBackgrounded = true;
        startBackgrounding('tengu_powershell_command_assistant_auto_backgrounded');
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref();
  }

  // Handle Claude asking to run it in the background explicitly
  // When explicitly requested via run_in_background, always honor the request
  // regardless of the command type (isAutobackgroundingAllowed only applies to automatic backgrounding)
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask();
    logEvent('tengu_powershell_command_explicitly_backgrounded', {
      command_type: getCommandTypeForLogging(command)
    });
    return {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: shellId
    };
  }

  // Start polling the output file for progress
  TaskOutput.startPolling(shellCommand.taskOutput.taskId);

  // Set up progress yielding with periodic checks
  const startTime = Date.now();
  let nextProgressTime = startTime + PROGRESS_THRESHOLD_MS;
  let foregroundTaskId: string | undefined = undefined;

  // Progress loop: wrap in try/finally so stopPolling is called on every exit
  // path — normal completion, timeout/interrupt backgrounding, and Ctrl+B
  // (matches BashTool pattern; see PR #18887 review thread at :560)
  try {
    while (true) {
      const now = Date.now();
      const timeUntilNextProgress = Math.max(0, nextProgressTime - now);
      const progressSignal = createProgressSignal();
      const result = await Promise.race([resultPromise, new Promise<null>(resolve => setTimeout(r => r(null), timeUntilNextProgress, resolve).unref()), progressSignal]);
      if (result !== null) {
        // Race: backgrounding fired (15s timer / onTimeout / Ctrl+B) but the
        // command completed before the next poll tick. #handleExit sets
        // backgroundTaskId but skips outputFilePath (it assumes the background
        // message or <task_notification> will carry the path). Strip
        // backgroundTaskId so the model sees a clean completed command,
        // reconstruct outputFilePath for large outputs, and suppress the
        // redundant <task_notification> from the .then() handler.
        // Check result.backgroundTaskId (not the closure var) to also cover
        // Ctrl+B, which calls shellCommand.background() directly.
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState);
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined
          };
          // Mirror ShellCommand.#handleExit's large-output branch that was
          // skipped because #backgroundTaskId was set.
          const {
            taskOutput
          } = shellCommand;
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path;
            fixedResult.outputFileSize = taskOutput.outputFileSize;
            fixedResult.outputTaskId = taskOutput.taskId;
          }
          // Command completed — cleanup stream listeners here. The finally
          // block's guard (!backgroundShellId && status !== 'backgrounded')
          // correctly skips cleanup for *running* backgrounded tasks, but
          // in this race the process is done. Matches BashTool.tsx:1399.
          shellCommand.cleanup();
          return fixedResult;
        }
        // Command has completed
        return result;
      }

      // Check if command was backgrounded (by timeout or interrupt)
      if (backgroundShellId) {
        return {
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded
        };
      }

      // User submitted a new message - background instead of killing
      if (abortController.signal.aborted && abortController.signal.reason === 'interrupt' && !interruptBackgroundingStarted) {
        interruptBackgroundingStarted = true;
        if (!isBackgroundTasksDisabled) {
          startBackgrounding('tengu_powershell_command_interrupt_backgrounded');
          // Reloop so the backgroundShellId check (above) catches the sync
          // foregroundTaskId→background path. Without this, we fall through
          // to the Ctrl+B check below, which matches status==='backgrounded'
          // and incorrectly returns backgroundedByUser:true. (bugs 020/021)
          continue;
        }
        shellCommand.kill();
      }

      // Check if this foreground task was backgrounded via backgroundAll() (ctrl+b)
      if (foregroundTaskId) {
        if (shellCommand.status === 'backgrounded') {
          return {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: false,
            backgroundTaskId: foregroundTaskId,
            backgroundedByUser: true
          };
        }
      }

      // Time for a progress update
      const elapsed = Date.now() - startTime;
      const elapsedSeconds = Math.floor(elapsed / 1000);

      // Show backgrounding UI hint after threshold
      if (foregroundOnly !== true && !isBackgroundTasksDisabled && backgroundShellId === undefined && elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 && setToolJSX) {
        if (!foregroundTaskId) {
          foregroundTaskId = registerForeground({
            command,
            description: description || command,
            shellCommand,
            agentId
          }, setAppState, toolUseId);
        }
        setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true
        });
      }
      yield {
        type: 'progress',
        fullOutput,
        output: lastProgressOutput,
        elapsedTimeSeconds: elapsedSeconds,
        totalLines: lastTotalLines,
        totalBytes: lastTotalBytes,
        taskId: shellCommand.taskOutput.taskId,
        ...(timeout ? {
          timeoutMs
        } : undefined)
      };
      nextProgressTime = Date.now() + PROGRESS_INTERVAL_MS;
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
    // Ensure cleanup runs on every exit path (success, rejection, abort).
    // Skip when backgrounded — LocalShellTask owns cleanup for those.
    // Matches main #21105.
    if (!backgroundShellId && shellCommand.status !== 'backgrounded') {
      if (foregroundTaskId) {
        unregisterForeground(foregroundTaskId, setAppState);
      }
      shellCommand.cleanup();
    }
  }
}
