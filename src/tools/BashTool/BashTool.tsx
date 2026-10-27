import { feature } from 'bun:bundle';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { copyFile, stat as fsStat, link, unlink } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import * as React from 'react';
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js';
import type { AppState } from 'src/state/AppState.js';
import { z } from 'zod/v4';
import { getKairosActive } from '../../bootstrap/state.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js';
import type { SetToolJSXFn, ToolCallProgress, ToolUseContext, ValidationResult } from '../../Tool.js';
import { buildTool, type ToolDef } from '../../Tool.js';
import { backgroundExistingForegroundTask, markTaskNotified, registerForeground, spawnShellTask, unregisterForeground } from '../../tasks/LocalShellTask/LocalShellTask.js';
import type { AgentId } from '../../types/ids.js';
import type { AssistantMessage } from '../../types/message.js';
import { parseForSecurity } from '../../utils/bash/ast.js';
import { splitCommand_DEPRECATED, splitCommandWithOperators } from '../../utils/bash/commands.js';
import { extractClaudeCodeHints, extractClaudeCodeHintsFromPreview, type ClaudeCodeHint } from '../../utils/claudeCodeHints.js';
import { detectCodeIndexingFromCommand } from '../../utils/codeIndexing.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isENOENT, ShellError, toError } from '../../utils/errors.js';
import { detectFileEncoding, detectLineEndings, getFileModificationTime, writeTextContent } from '../../utils/file.js';
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js';
import { truncate } from '../../utils/format.js';
import { getFsImplementation } from '../../utils/fsOperations.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { logError } from '../../utils/log.js';
import { expandPath } from '../../utils/path.js';
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js';
import { maybeRecordPluginHint } from '../../utils/plugins/hintRecommendation.js';
import { exec } from '../../utils/Shell.js';
import type { ExecResult } from '../../utils/ShellCommand.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { semanticBoolean } from '../../utils/semanticBoolean.js';
import { semanticNumber } from '../../utils/semanticNumber.js';
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { TaskOutput } from '../../utils/task/TaskOutput.js';
import { isOutputLineTruncated } from '../../utils/terminal.js';
import { buildLargeToolResultMessage, ensureToolResultsDir, generateFilePreview, generatePreview, getToolResultPath, PREVIEW_SIZE_BYTES, type PreviewStrategy } from '../../utils/toolResultStorage.js';
import { userFacingName as fileEditUserFacingName } from '../FileEditTool/UI.js';
import { trackGitOperations } from '../shared/gitOperationTracking.js';
import { bashToolHasPermission, commandHasAnyCd, matchWildcardPattern, permissionRuleExtractPrefix } from './bashPermissions.js';
import { analyzeBashCommand, parseLegacyShellCommandForAnalysis, type BashCommandAnalysis } from './bashCommandAnalysis.js';
import { interpretCommandResult } from './commandSemantics.js';
import { getEffectiveTimeoutMs, getMaxTimeoutMs, getSimplePrompt } from './prompt.js';
import { checkReadOnlyConstraints } from './readOnlyValidation.js';
import { parseSedEditCommand } from './sedEditParser.js';
import { shouldUseSandbox, shouldUseSandboxForPresentation } from './shouldUseSandbox.js';
import { BASH_TOOL_NAME } from './toolName.js';
import { BackgroundHint, renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from './UI.js';
import { buildImageToolResult, isImageOutput, resetCwdIfOutsideProject, resizeShellImageOutput, selectFailureOutput, stdErrAppendShellResetMessage, stripEmptyLines } from './utils.js';
const EOL = '\n';

// Progress display constants
const PROGRESS_THRESHOLD_MS = 2000; // Show progress after 2 seconds
// In assistant mode, blocking bash auto-backgrounds after this many ms in the main agent
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

// Search commands for collapsible display (grep, find, etc.)
const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis']);

// Read/view commands for collapsible display (cat, head, etc.)
const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more',
// Analysis commands
'wc', 'stat', 'file', 'strings',
// Data processing — commonly used to parse/transform file content in pipes
'jq', 'awk', 'cut', 'sort', 'uniq', 'tr']);

// Directory-listing commands for collapsible display (ls, tree, du).
// Split from BASH_READ_COMMANDS so the summary says "Listed N directories"
// instead of the misleading "Read N files".
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du']);

// Commands that are semantic-neutral in any position — pure output/status commands
// that don't change the read/search nature of the overall pipeline.
// e.g. `ls dir && echo "---" && ls dir2` is still a read-only compound command.
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':' // bash no-op
]);

// Commands that typically produce no stdout on success
const BASH_SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'cd', 'export', 'unset', 'wait']);

/**
 * Checks if a bash command is a search or read operation.
 * Used to determine if the command should be collapsed in the UI.
 * Returns an object indicating whether it's a search or read operation.
 *
 * For pipelines (e.g., `cat file | bq`), ALL parts must be search/read commands
 * for the whole command to be considered collapsible.
 *
 * Semantic-neutral commands (echo, printf, true, false, :) are skipped in any
 * position, as they're pure output/status commands that don't affect the read/search
 * nature of the pipeline (e.g. `ls dir && echo "---" && ls dir2` is still a read).
 */
export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
} {
  let partsWithOperators: string[];
  try {
    partsWithOperators = splitCommandWithOperators(command);
  } catch {
    // If we can't parse the command due to malformed syntax,
    // it's not a search/read command
    return {
      isSearch: false,
      isRead: false,
      isList: false
    };
  }
  if (partsWithOperators.length === 0) {
    return {
      isSearch: false,
      isRead: false,
      isList: false
    };
  }
  let hasSearch = false;
  let hasRead = false;
  let hasList = false;
  let hasNonNeutralCommand = false;
  let skipNextAsRedirectTarget = false;
  for (const part of partsWithOperators) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false;
      continue;
    }
    if (part === '>' || part === '>>' || part === '>&') {
      skipNextAsRedirectTarget = true;
      continue;
    }
    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      continue;
    }
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) {
      continue;
    }
    hasNonNeutralCommand = true;
    const isPartSearch = BASH_SEARCH_COMMANDS.has(baseCommand);
    const isPartRead = BASH_READ_COMMANDS.has(baseCommand);
    const isPartList = BASH_LIST_COMMANDS.has(baseCommand);
    if (!isPartSearch && !isPartRead && !isPartList) {
      return {
        isSearch: false,
        isRead: false,
        isList: false
      };
    }
    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
    if (isPartList) hasList = true;
  }

  // Only neutral commands (e.g., just "echo foo") -- not collapsible
  if (!hasNonNeutralCommand) {
    return {
      isSearch: false,
      isRead: false,
      isList: false
    };
  }
  return {
    isSearch: hasSearch,
    isRead: hasRead,
    isList: hasList
  };
}

/**
 * Checks if a bash command is expected to produce no stdout on success.
 * Used to show "Done" instead of "(No output)" in the UI.
 */
function isSilentBashCommand(command: string): boolean {
  let partsWithOperators: string[];
  try {
    partsWithOperators = splitCommandWithOperators(command);
  } catch {
    return false;
  }
  if (partsWithOperators.length === 0) {
    return false;
  }
  let hasNonFallbackCommand = false;
  let lastOperator: string | null = null;
  let skipNextAsRedirectTarget = false;
  for (const part of partsWithOperators) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false;
      continue;
    }
    if (part === '>' || part === '>>' || part === '>&') {
      skipNextAsRedirectTarget = true;
      continue;
    }
    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      lastOperator = part;
      continue;
    }
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    if (lastOperator === '||' && BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) {
      continue;
    }
    hasNonFallbackCommand = true;
    if (!BASH_SILENT_COMMANDS.has(baseCommand)) {
      return false;
    }
  }
  return hasNonFallbackCommand;
}

// Commands that should not be auto-backgrounded
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['sleep' // Sleep should run in foreground unless explicitly backgrounded by user
];

// Check if background tasks are disabled at module load time
const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('The command to execute'),
  timeout: semanticNumber(z.number().optional()).describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
  description: z.string().optional().describe(`Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`),
  run_in_background: semanticBoolean(z.boolean().optional()).describe(`Set to true to run this command in the background. Use Read to read the output later.`),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('Set this to true to dangerously override sandbox mode and run commands without sandboxing.'),
  _dangerouslyDisableSandboxApproved: z.boolean().optional().describe('Internal: user-approved sandbox override'),
  _simulatedSedEdit: z.object({
    filePath: z.string(),
    newContent: z.string()
  }).optional().describe('Internal: pre-computed sed edit result from preview')
}));

// Always omit internal-only fields from the model-facing schema.
// _simulatedSedEdit is set by SedEditPermissionRequest after the user approves a
// sed edit preview; exposing it would let the model bypass permission checks and
// the sandbox by pairing an innocuous command with an arbitrary file write.
// dangerouslyDisableSandbox is also omitted because sandbox escape must be tied
// to trusted user/internal provenance, not model-controlled tool input.
// Also conditionally remove run_in_background when background tasks are disabled.
const inputSchema = lazySchema(() => isBackgroundTasksDisabled ? fullInputSchema().omit({
  run_in_background: true,
  dangerouslyDisableSandbox: true,
  _dangerouslyDisableSandboxApproved: true,
  _simulatedSedEdit: true
}) : fullInputSchema().omit({
  dangerouslyDisableSandbox: true,
  _dangerouslyDisableSandboxApproved: true,
  _simulatedSedEdit: true
}));
type InputSchema = ReturnType<typeof inputSchema>;

// Use fullInputSchema for the type to always include run_in_background
// (even when it's omitted from the schema, the code needs to handle it)
export type BashToolInput = z.infer<ReturnType<typeof fullInputSchema>>;
const COMMON_BACKGROUND_COMMANDS = ['npm', 'yarn', 'pnpm', 'node', 'python', 'python3', 'go', 'cargo', 'make', 'docker', 'terraform', 'webpack', 'vite', 'jest', 'pytest', 'curl', 'wget', 'build', 'test', 'serve', 'watch', 'dev'] as const;
function getCommandTypeForLogging(command: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;

  // Check each part of the command to see if any match common background commands
  for (const part of parts) {
    const baseCommand = part.split(' ')[0] || '';
    if (COMMON_BACKGROUND_COMMANDS.includes(baseCommand as (typeof COMMON_BACKGROUND_COMMANDS)[number])) {
      return baseCommand as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
  }
  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
}
const outputSchema = lazySchema(() => z.object({
  stdout: z.string().describe('The standard output of the command'),
  stderr: z.string().describe('The standard error output of the command'),
  rawOutputPath: z.string().optional().describe('Path to raw output file for large MCP tool outputs'),
  interrupted: z.boolean().describe('Whether the command was interrupted'),
  isAbort: z.boolean().optional().describe('Whether the command was cancelled through the abort path'),
  abortReason: z.string().optional().describe('Normalized abort reason when the command was cancelled'),
  abortMessage: z.string().optional().describe('Safe user-facing abort explanation'),
  isImage: z.boolean().optional().describe('Flag to indicate if stdout contains image data'),
  backgroundTaskId: z.string().optional().describe('ID of the background task if command is running in background'),
  backgroundedByUser: z.boolean().optional().describe('True if the user manually backgrounded the command with Ctrl+B'),
  assistantAutoBackgrounded: z.boolean().optional().describe('True if assistant-mode auto-backgrounded a long-running blocking command'),
  dangerouslyDisableSandbox: z.boolean().optional().describe('Flag to indicate if sandbox mode was overridden'),
  returnCodeInterpretation: z.string().optional().describe('Semantic interpretation for non-error exit codes with special meaning'),
  noOutputExpected: z.boolean().optional().describe('Whether the command is expected to produce no output on success'),
  structuredContent: z.array(z.any()).optional().describe('Structured content blocks'),
  persistedOutputPath: z.string().optional().describe('Path to the persisted full output in tool-results dir (set when output is too large for inline)'),
  persistedOutputSize: z.number().optional().describe('Total size of the output in bytes (set when output is too large for inline)'),
  persistedOutputPreview: z.string().optional().describe('UTF-8-safe head/tail preview read from the complete rolled-output source'),
  persistedOutputPreviewStrategy: z.enum(['complete', 'head-tail', 'head-only']).optional().describe('How the persisted output preview was selected'),
  persistedOutputTruncated: z.boolean().optional().describe('Whether the persisted file is capped (only the first portion of the output was saved)')
}));
type OutputSchema = ReturnType<typeof outputSchema>;
export type Out = z.infer<OutputSchema>;

// Re-export BashProgress from centralized types to break import cycles
export type { BashProgress } from '../../types/tools.js';
import type { BashProgress } from '../../types/tools.js';

/**
 * Checks if a command is allowed to be automatically backgrounded
 * @param command The command to check
 * @returns false for commands that should not be auto-backgrounded (like sleep)
 */
/**
 * Maximum bytes we copy from a rolled-output file into the tool-results dir.
 * Files larger than this are truncated before the link/copy so a runaway
 * command does not blow up disk usage in the user's home dir.
 */
export const MAX_PERSISTED_SHELL_OUTPUT_SIZE = 64 * 1024 * 1024;
const MAX_SANDBOX_DIAGNOSTIC_PREVIEW_BYTES = 512;

/**
 * Copy the shell's rolled-output file into the tool-results dir so the model
 * can read it back via FileRead. Used by both the success path and the
 * non-zero-exit error path (issue #1359): without this on the error side,
 * the ShellError carries only the truncated first chunk from `result.stdout`
 * and the model has no way to recover the failure body, leaving it to ask
 * the user to re-run with redirection.
 *
 * Returns the destination path and size on success; returns `null` if the
 * roll file is missing or the link/copy itself fails. Callers fall back to
 * the in-memory stdout preview in that case.
 */
export async function persistShellOutputFile(
  sourcePath: string,
  taskId: string,
  maxSize: number = MAX_PERSISTED_SHELL_OUTPUT_SIZE,
  command: string = '',
): Promise<{ path: string; size: number; truncated: boolean; preview?: string; previewStrategy?: PreviewStrategy; previewHints?: ClaudeCodeHint[] } | null> {
  try {
    const fileStat = await fsStat(sourcePath);
    const size = fileStat.size;
    await ensureToolResultsDir();
    const dest = getToolResultPath(taskId, false);
    const truncated = size > maxSize;
    if (truncated) {
      // Cap the destination, never the shell's rolled-output source: the error
      // fallback and resizeShellImageOutput still read `sourcePath`, so
      // truncating it would drop the tail this persistence is meant to recover.
      // Write only the first `maxSize` bytes into `dest` via a bounded read
      // range — copying the whole (potentially multi-GB) source and truncating
      // afterward would balloon session storage and, if the truncate failed,
      // leave a full-size copy behind. `end` is inclusive, so [0, maxSize-1]
      // yields exactly maxSize bytes.
      try {
        await pipeline(
          createReadStream(sourcePath, { start: 0, end: maxSize - 1 }),
          createWriteStream(dest),
        );
      } catch (e) {
        // Remove any partial destination before falling through to the outer
        // catch, so we never report a half-written capped file.
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
    // `size` is the original (pre-cap) byte count, which the success path
    // reports as the output total. `truncated` tells the error path that the
    // saved file is capped at MAX_PERSISTED_SHELL_OUTPUT_SIZE so it does not
    // describe a partial file as the full output.
    const previewSourcePath = truncated ? sourcePath : dest;
    const previewResult = await generateFilePreview(
      previewSourcePath,
      PREVIEW_SIZE_BYTES,
    ).catch(error => {
      logError(toError(error));
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
    // File may already be gone — caller's stdout preview is sufficient.
    return null;
  }
}

/**
 * Append a "[…output saved to <path>]" marker to the captured stdout carried
 * on a ShellError. Pads with a blank line so the marker reads as a distinct
 * paragraph regardless of whether `stdout` ended with a newline.
 *
 * When the rolled output exceeded MAX_PERSISTED_SHELL_OUTPUT_SIZE the saved
 * file is capped, so the marker says so rather than claiming the full failure
 * body is on disk — otherwise the model trusts a truncated file and may miss a
 * compiler/test error that appears past the cap.
 */
export function appendPersistedOutputHint(
  stdout: string,
  persistedPath: string,
  persistedSize: number,
  truncated: boolean,
  preview?: string,
  previewStrategy?: PreviewStrategy,
  sandboxDiagnostics?: string,
): string {
  const capDetail = previewStrategy === 'head-tail'
    ? 'capped; preview may include tail bytes not saved at that path'
    : 'capped, tail not saved';
  const hint = truncated
    ? `[output truncated above — first ${MAX_PERSISTED_SHELL_OUTPUT_SIZE} bytes of the ${persistedSize}-byte output saved to ${persistedPath} (${capDetail}); read with the Read tool]`
    : `[output truncated above — full output (${persistedSize} bytes) saved to ${persistedPath}; read with the Read tool]`;
  const previewStrategyLabel = previewStrategy === 'head-tail'
    ? 'head and tail'
    : previewStrategy === 'complete'
      ? 'complete'
      : 'head-only partial';
  const previewBlock = preview
    ? `Persisted output preview (UTF-8-safe ${previewStrategyLabel}, ${PREVIEW_SIZE_BYTES}-byte budget):\n${preview}`
    : '';
  const boundedSandboxDiagnostics = preview && sandboxDiagnostics
    ? generatePreview(
      sandboxDiagnostics,
      MAX_SANDBOX_DIAGNOSTIC_PREVIEW_BYTES,
      'text',
    ).preview
    : '';
  const capturedFallback = preview
    ? ''
    : stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const parts = [capturedFallback, previewBlock, boundedSandboxDiagnostics, hint].filter(Boolean);
  return parts.join('\n\n');
}

function isAutobackgroundingAllowed(command: string): boolean {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return true;

  // Get the first part which should be the base command
  const baseCommand = parts[0]?.trim();
  if (!baseCommand) return true;
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(baseCommand);
}

/**
 * Detect standalone or leading `sleep N` patterns that should use Monitor
 * instead. Catches `sleep 5`, `sleep 5 && check`, `sleep 5; check` — but
 * not sleep inside pipelines, subshells, or scripts (those are fine).
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return null;
  const first = parts[0]?.trim() ?? '';
  // Bare `sleep N` or `sleep N.N` as the first subcommand.
  // Float durations (sleep 0.5) are allowed — those are legit pacing, not polls.
  const m = /^sleep\s+(\d+)\s*$/.exec(first);
  if (!m) return null;
  const secs = parseInt(m[1]!, 10);
  if (secs < 2) return null; // sub-2s sleeps are fine (rate limiting, pacing)

  // `sleep N` alone → "what are you waiting for?"
  // `sleep N && check` → "use Monitor { command: check }"
  const rest = parts.slice(1).join(' ').trim();
  return rest ? `sleep ${secs} followed by: ${rest}` : `standalone sleep ${secs}`;
}

/**
 * Checks if a command contains tools that shouldn't run in sandbox
 * This includes:
 * - Dynamic config-based disabled commands and substrings (tengu_sandbox_disabled_commands)
 * - User-configured commands from settings.json (sandbox.excludedCommands)
 *
 * User-configured commands support the same pattern syntax as permission rules:
 * - Exact matches: "npm run lint"
 * - Prefix patterns: "npm run test:*"
 */

type SimulatedSedEditResult = {
  data: Out;
};
type SimulatedSedEditContext = Pick<ToolUseContext, 'readFileState' | 'updateFileHistoryState'>;

/**
 * Applies a simulated sed edit directly instead of running sed.
 * This is used by the permission dialog to ensure what the user previews
 * is exactly what gets written to the file.
 */
async function applySedEdit(simulatedEdit: {
  filePath: string;
  newContent: string;
}, toolUseContext: SimulatedSedEditContext, parentMessage?: AssistantMessage): Promise<SimulatedSedEditResult> {
  const {
    filePath,
    newContent
  } = simulatedEdit;
  const absoluteFilePath = expandPath(filePath);
  const fs = getFsImplementation();

  // Read original content for VS Code notification
  const encoding = detectFileEncoding(absoluteFilePath);
  let originalContent: string;
  try {
    originalContent = await fs.readFile(absoluteFilePath, {
      encoding
    });
  } catch (e) {
    if (isENOENT(e)) {
      return {
        data: {
          stdout: '',
          stderr: `sed: ${filePath}: No such file or directory\nExit code 1`,
          interrupted: false
        }
      };
    }
    throw e;
  }

  // Track file history before making changes (for undo support)
  if (fileHistoryEnabled() && parentMessage) {
    await fileHistoryTrackEdit(toolUseContext.updateFileHistoryState, absoluteFilePath, parentMessage.uuid);
  }

  // Detect line endings and write new content
  const endings = detectLineEndings(absoluteFilePath);
  writeTextContent(absoluteFilePath, newContent, encoding, endings);

  // Notify VS Code about the file change
  notifyVscodeFileUpdated(absoluteFilePath, originalContent, newContent);

  // Update read timestamp to invalidate stale writes
  toolUseContext.readFileState.set(absoluteFilePath, {
    content: newContent,
    timestamp: getFileModificationTime(absoluteFilePath),
    offset: undefined,
    limit: undefined
  });

  // Return success result matching sed output format (sed produces no output on success)
  return {
    data: {
      stdout: '',
      stderr: '',
      interrupted: false
    }
  };
}
export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  searchHint: 'execute shell commands',
  // 30K chars - tool result persistence threshold
  maxResultSizeChars: 30_000,
  strict: true,
  async description({
    description
  }) {
    return description || 'Run shell command';
  },
  async prompt() {
    return getSimplePrompt();
  },
  isConcurrencySafe(input) {
    return this.isReadOnly?.(input) ?? false;
  },
  isReadOnly(input) {
    const legacyParse = parseLegacyShellCommandForAnalysis(input.command);
    const compoundCommandHasCd = commandHasAnyCd(input.command, legacyParse);
    const result = checkReadOnlyConstraints(input, compoundCommandHasCd, legacyParse);
    return result.behavior === 'allow';
  },
  toAutoClassifierInput(input) {
    return input.command;
  },
  async preparePermissionMatcher({
    command
  }) {
    // Hook `if` filtering is "no match → skip hook" (deny-like semantics), so
    // compound commands must fire the hook if ANY subcommand matches. Without
    // splitting, `ls && git push` would bypass a `Bash(git *)` security hook.
    const parsed = await parseForSecurity(command);
    if (parsed.kind !== 'simple') {
      // parse-unavailable / too-complex: fail safe by running the hook.
      return () => true;
    }
    // Match on argv (strips leading VAR=val) so `FOO=bar git push` still
    // matches `Bash(git *)`.
    const subcommands = parsed.commands.map(c => c.argv.join(' '));
    return pattern => {
      const prefix = permissionRuleExtractPrefix(pattern);
      return subcommands.some(cmd => {
        if (prefix !== null) {
          return cmd === prefix || cmd.startsWith(`${prefix} `);
        }
        return matchWildcardPattern(pattern, cmd);
      });
    };
  },
  isSearchOrReadCommand(input) {
    const parsed = inputSchema().safeParse(input);
    if (!parsed.success) return {
      isSearch: false,
      isRead: false,
      isList: false
    };
    return isSearchOrReadBashCommand(parsed.data.command);
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName(input) {
    if (!input) {
      return 'Bash';
    }
    // Render sed in-place edits as file edits
    if (input.command) {
      const sedInfo = parseSedEditCommand(input.command);
      if (sedInfo) {
        return fileEditUserFacingName({
          file_path: sedInfo.filePath,
          old_string: 'x'
        });
      }
    }
    // Env var FIRST: sandbox presentation decision can parse via shell-quote's
    // `new RegExp` per call. userFacingName runs per-render for every bash
    // message in history; with ~50 msgs + one slow-to-tokenize command, this
    // exceeds the shimmer tick → transition abort → infinite retry (#21605).
    return isEnvTruthy(process.env.CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR) && shouldUseSandboxForPresentation(input) ? 'SandboxedBash' : 'Bash';
  },
  getToolUseSummary(input) {
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
  getActivityDescription(input) {
    if (!input?.command) {
      return 'Running command';
    }
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH);
    return `Running ${desc}`;
  },
  async validateInput(input: BashToolInput): Promise<ValidationResult> {
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
  async checkPermissions(input, context): Promise<PermissionResult> {
    return bashToolHasPermission(input, context);
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  // BashToolResultMessage shows <OutputLine content={stdout}> + stderr.
  // UI never shows persistedOutputPath wrapper, backgroundInfo — those are
  // model-facing (mapToolResult... below).
  extractSearchText({
    stdout,
    stderr
  }) {
    return stderr ? `${stdout}\n${stderr}` : stdout;
  },
  mapToolResultToToolResultBlockParam({
    interrupted,
    stdout,
    stderr,
    isImage,
    backgroundTaskId,
    backgroundedByUser,
    assistantAutoBackgrounded,
    abortMessage,
    structuredContent,
    persistedOutputPath,
    persistedOutputSize,
    persistedOutputPreview,
    persistedOutputPreviewStrategy,
    persistedOutputTruncated
  }, toolUseID): ToolResultBlockParam {
    // Handle structured content
    if (structuredContent && structuredContent.length > 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: structuredContent
      };
    }

    // For image data, format as image content block for Claude
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID);
      if (block) return block;
    }
    const normalizedStdout = typeof stdout === 'string' ? stdout : '';
    const normalizedStderr = typeof stderr === 'string' ? stderr : '';
    let processedStdout = normalizedStdout;
    if (normalizedStdout) {
      // Replace any leading newlines or lines with only whitespace
      processedStdout = normalizedStdout.replace(/^(\s*\n)+/, '');
      // Still trim the end as before
      processedStdout = processedStdout.trimEnd();
    }

    // For large output that was persisted to disk, build <persisted-output>
    // message for the model. The UI never sees this — it uses data.stdout.
    if (persistedOutputPath) {
      // Prefer the bounded preview read from the full rolled-output source.
      // If that read failed, the in-memory value is only a captured head.
      const preview = persistedOutputPreview ?? generatePreview(
        processedStdout,
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
      type: 'tool_result',
      content: [processedStdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      is_error: interrupted
    };
  },
  async call(input: BashToolInput, toolUseContext, _canUseTool?: CanUseToolFn, parentMessage?: AssistantMessage, onProgress?: ToolCallProgress<BashProgress>) {
    // Handle simulated sed edit - apply directly instead of running sed
    // This ensures what the user previewed is exactly what gets written
    if (input._simulatedSedEdit) {
      return applySedEdit(input._simulatedSedEdit, toolUseContext, parentMessage);
    }
    const {
      abortController,
      getAppState,
      setAppState,
      setToolJSX
    } = toolUseContext;
    const stdoutAccumulator = new EndTruncatingAccumulator();
    let stderrForShellReset = '';
    let interpretationResult: ReturnType<typeof interpretCommandResult> | undefined;
    let progressCounter = 0;
    let wasInterrupted = false;
    let result: ExecResult;
    const isMainThread = !toolUseContext.agentId;
    const preventCwdChanges = !isMainThread;
    try {
      const commandAnalysis = await analyzeBashCommand(input.command);
      // Use the new async generator version of runShellCommand
      const commandGenerator = runShellCommand({
        input,
        commandAnalysis,
        abortController,
        // Use the always-shared task channel so async agents' background
        // bash tasks are actually registered (and killable on agent exit).
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId
      });

      // Consume the generator and capture the return value
      let generatorResult;
      // Capture the most recent `fullOutput` yielded by the streaming
      // generator so we can fall back to it for failure messages when the
      // final ExecResult.stdout slot ends up empty (#1231).
      let lastProgressFullOutput = '';
      do {
        generatorResult = await commandGenerator.next();
        if (!generatorResult.done) {
          const progress = generatorResult.value;
          if (typeof progress.fullOutput === 'string' && progress.fullOutput.length > 0) {
            lastProgressFullOutput = progress.fullOutput;
          }
          if (onProgress) {
            onProgress({
              toolUseID: `bash-progress-${progressCounter++}`,
              data: {
                type: 'bash_progress',
                output: progress.output,
                fullOutput: progress.fullOutput,
                elapsedTimeSeconds: progress.elapsedTimeSeconds,
                totalLines: progress.totalLines,
                totalBytes: progress.totalBytes,
                taskId: progress.taskId,
                timeoutMs: progress.timeoutMs
              }
            });
          }
        }
      } while (!generatorResult.done);

      // Get the final result from the generator's return value
      result = generatorResult.value;
      trackGitOperations(input.command, result.code, result.stdout);
      const isAbort = result.isAbort === true;

      // stderr is interleaved in stdout (merged fd) — result.stdout has both
      stdoutAccumulator.append((result.stdout || '').trimEnd() + EOL);

      // Interpret the command result using semantic rules
      interpretationResult = interpretCommandResult(input.command, result.code, result.stdout || '', '');

      // Check for git index.lock error (stderr is in stdout now)
      if (result.stdout && result.stdout.includes(".git/index.lock': File exists")) {
        logEvent('tengu_git_index_lock_error', {});
      }
      if (!preventCwdChanges) {
        const appState = getAppState();
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('');
        }
      }

      // Annotate output with sandbox violations if any (stderr is in stdout).
      // Issue #1231: pick the best non-empty failure body across three
      // sources, ordered by trust:
      //   1. The accumulator (after stripping the synthetic "Exit code N"
      //      marker we appended above) — mirrors the success-path stdout
      //      that was appended at line 696 above.
      //   2. result.stdout from the shell runner.
      //   3. lastProgressFullOutput — the most recent fullOutput yielded by
      //      the streaming generator. Recovers stdout when the shell runner
      //      streamed every line through progress callbacks but the final
      //      ExecResult.stdout slot was left empty (flush-after-result race,
      //      exit before EOF, persisted to file path, etc.).
      // Strip the trailing "Exit code N" so getErrorParts() doesn't
      // duplicate it; ShellError carries the code separately.
      const accumulatedOutput = stdoutAccumulator
        .toString()
        .replace(new RegExp(`\\nExit code ${result.code}$`), '')
        .replace(new RegExp(`^Exit code ${result.code}$`), '');
      const failureOutput = selectFailureOutput(
        accumulatedOutput,
        result.stdout,
        lastProgressFullOutput,
      );
      const outputWithSbFailures = SandboxManager.annotateStderrWithSandboxFailures(input.command, failureOutput);
      const sandboxDiagnostics = outputWithSbFailures.startsWith(failureOutput)
        ? outputWithSbFailures.slice(failureOutput.length).trim()
        : '';
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError);
      }
      if (interpretationResult.isError && !isAbort) {
        // Merged-fd setup puts both streams into result.stdout. Carry it on
        // the stdout slot of ShellError (matches PowerShellTool.tsx:595) so
        // getErrorParts() emits the captured output alongside "Exit code N"
        // — without this, a non-zero exit hides the very output users need
        // to debug the failure (issue #1231). result.stderr is empty in
        // file mode but populated in pipe mode (hooks).
        //
        // When the shell rolled output to a file (large output path), the
        // first chunk on `result.stdout` is truncated. Hoist the persist
        // step here so the error message can point at the full output
        // (issue #1359) — otherwise the model sees only the exit code +
        // the truncated chunk and has no signal that the rest exists. The
        // persist step is identical to the success-path block below; both
        // sites resolve the same `result.outputFilePath` / outputTaskId.
        const errorExtraction = extractClaudeCodeHints(
          outputWithSbFailures,
          input.command,
        );
        let errorStdout = errorExtraction.stripped;
        if (isMainThread) {
          for (const hint of errorExtraction.hints) {
            maybeRecordPluginHint(hint);
          }
        }
        if (result.outputFilePath && result.outputTaskId) {
          const persistedForError = await persistShellOutputFile(
            result.outputFilePath,
            result.outputTaskId,
            MAX_PERSISTED_SHELL_OUTPUT_SIZE,
            input.command,
          );
          if (persistedForError) {
            if (isMainThread) {
              for (const hint of persistedForError.previewHints ?? []) {
                const alreadyCaptured = errorExtraction.hints.some(
                  captured =>
                    captured.v === hint.v &&
                    captured.type === hint.type &&
                    captured.value === hint.value,
                );
                if (!alreadyCaptured) maybeRecordPluginHint(hint);
              }
            }
            errorStdout = appendPersistedOutputHint(
              errorStdout,
              persistedForError.path,
              persistedForError.size,
              persistedForError.truncated,
              persistedForError.preview,
              persistedForError.previewStrategy,
              sandboxDiagnostics,
            );
          }
        }
        throw new ShellError(errorStdout, result.stderr || '', result.code, result.interrupted, {
          abortReason: result.abortReason,
          abortMessage: result.abortMessage,
          isAbort: result.isAbort
        });
      }
      wasInterrupted = result.interrupted;
    } finally {
      if (setToolJSX) setToolJSX(null);
    }

    // Get final string from accumulator
    const stdout = stdoutAccumulator.toString();

    // Large output: the file on disk has more than getMaxOutputLength() bytes.
    // stdout already contains the first chunk (from getStdout()). Copy the
    // output file to the tool-results dir so the model can read it via
    // FileRead. If > 64 MB, truncate after copying.
    let persistedOutputPath: string | undefined;
    let persistedOutputSize: number | undefined;
    let persistedOutputPreview: string | undefined;
    let persistedOutputPreviewStrategy: PreviewStrategy | undefined;
    let persistedOutputPreviewHints: ClaudeCodeHint[] = [];
    let persistedOutputTruncated: boolean | undefined;
    if (result.outputFilePath && result.outputTaskId) {
      const persisted = await persistShellOutputFile(
        result.outputFilePath,
        result.outputTaskId,
        MAX_PERSISTED_SHELL_OUTPUT_SIZE,
        input.command,
      );
      if (persisted) {
        persistedOutputPath = persisted.path;
        persistedOutputSize = persisted.size;
        persistedOutputPreview = persisted.preview;
        persistedOutputPreviewStrategy = persisted.previewStrategy;
        persistedOutputPreviewHints = persisted.previewHints ?? [];
        persistedOutputTruncated = persisted.truncated;
      }
    }
    const commandType = input.command.split(' ')[0];
    logEvent('tengu_bash_tool_command_executed', {
      command_type: commandType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      stdout_length: stdout.length,
      stderr_length: 0,
      exit_code: result.code,
      interrupted: wasInterrupted,
      duration_ms: result.durationMs,
      signal: result.signal as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined,
      signal_aborted: result.signalAborted,
      is_abort: result.isAbort,
      abort_reason: result.abortReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined,
      result_stdout_length: result.stdoutLength,
      result_stderr_length: result.stderrLength
    });

    // Log code indexing tool usage
    const codeIndexingTool = detectCodeIndexingFromCommand(input.command);
    if (codeIndexingTool) {
      logEvent('tengu_code_indexing_tool_used', {
        tool: codeIndexingTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: result.code === 0
      });
    }
    let strippedStdout = stripEmptyLines(stdout);

    // Claude Code hints protocol: CLIs/SDKs gated on CLAUDECODE=1 emit a
    // `<claude-code-hint />` tag to stderr (merged into stdout here). Scan,
    // record for useClaudeCodeHintRecommendation to surface, then strip
    // so the model never sees the tag — a zero-token side channel.
    // Stripping runs unconditionally (subagent output must stay clean too);
    // only the dialog recording is main-thread-only.
    const extracted = extractClaudeCodeHints(strippedStdout, input.command);
    strippedStdout = extracted.stripped;
    if (isMainThread && extracted.hints.length > 0) {
      for (const hint of extracted.hints) maybeRecordPluginHint(hint);
    }
    if (isMainThread && persistedOutputPreviewHints.length > 0) {
      for (const hint of persistedOutputPreviewHints) {
        const alreadyCaptured = extracted.hints.some(
          captured =>
            captured.v === hint.v &&
            captured.type === hint.type &&
            captured.value === hint.value,
        );
        if (!alreadyCaptured) maybeRecordPluginHint(hint);
      }
    }
    let isImage = isImageOutput(strippedStdout);

    // Cap image dimensions + size if present (CC-304 — see
    // resizeShellImageOutput). Scope the decoded buffer so it can be reclaimed
    // before we build the output Out object.
    let compressedStdout = strippedStdout;
    if (isImage) {
      const resized = await resizeShellImageOutput(strippedStdout, result.outputFilePath, persistedOutputSize);
      if (resized) {
        compressedStdout = resized;
      } else {
        // Parse failed or file too large (e.g. exceeds MAX_IMAGE_FILE_SIZE).
        // Keep isImage in sync with what we actually send so the UI label stays
        // accurate — mapToolResultToToolResultBlockParam's defensive
        // fallthrough will send text, not an image block.
        isImage = false;
      }
    }
    const data: Out = {
      stdout: compressedStdout,
      stderr: stderrForShellReset,
      interrupted: wasInterrupted,
      isAbort: result.isAbort,
      abortReason: result.abortReason,
      abortMessage: result.abortMessage,
      isImage,
      returnCodeInterpretation: interpretationResult?.message,
      noOutputExpected: isSilentBashCommand(input.command),
      backgroundTaskId: result.backgroundTaskId,
      backgroundedByUser: result.backgroundedByUser,
      assistantAutoBackgrounded: result.assistantAutoBackgrounded,
      dangerouslyDisableSandbox: 'dangerouslyDisableSandbox' in input ? input.dangerouslyDisableSandbox as boolean | undefined : undefined,
      persistedOutputPath,
      persistedOutputSize,
      persistedOutputPreview,
      persistedOutputPreviewStrategy,
      persistedOutputTruncated
    };
    return {
      data
    };
  },
  renderToolUseErrorMessage,
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  }
} satisfies ToolDef<InputSchema, Out, BashProgress>);
async function* runShellCommand({
  input,
  commandAnalysis,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId
}: {
  input: BashToolInput;
  commandAnalysis: BashCommandAnalysis;
  abortController: AbortController;
  setAppState: (f: (prev: AppState) => AppState) => void;
  setToolJSX?: SetToolJSXFn;
  preventCwdChanges?: boolean;
  isMainThread?: boolean;
  toolUseId?: string;
  agentId?: AgentId;
}): AsyncGenerator<{
  type: 'progress';
  output: string;
  fullOutput: string;
  elapsedTimeSeconds: number;
  totalLines: number;
  totalBytes?: number;
  taskId?: string;
  timeoutMs?: number;
}, ExecResult, void> {
  const {
    command,
    description,
    timeout,
    run_in_background
  } = input;
  const timeoutMs = getEffectiveTimeoutMs(timeout);
  let fullOutput = '';
  let lastProgressOutput = '';
  let lastTotalLines = 0;
  let lastTotalBytes = 0;
  let backgroundShellId: string | undefined = undefined;
  let assistantAutoBackgrounded = false;

  // Progress signal: resolved by onProgress callback from the shared poller,
  // waking the generator to yield a progress update.
  let resolveProgress: (() => void) | null = null;
  function createProgressSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null);
    });
  }

  // Determine if auto-backgrounding should be enabled
  // Only enable for commands that are allowed to be auto-backgrounded
  // and when background tasks are not disabled
  const shouldAutoBackground = !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command);
  const shellCommand = await exec(command, abortController.signal, 'bash', {
    timeout: timeoutMs,
    onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
      lastProgressOutput = lastLines;
      fullOutput = allLines;
      lastTotalLines = totalLines;
      lastTotalBytes = isIncomplete ? totalBytes : 0;
      // Wake the generator so it yields the new progress data
      const resolve = resolveProgress;
      if (resolve) {
        resolveProgress = null;
        resolve();
      }
    },
    preventCwdChanges,
    shouldUseSandbox: shouldUseSandbox(input, commandAnalysis),
    shouldAutoBackground
  });

  // Start the command execution
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
        // We don't have direct access to getAppState here, but spawn doesn't
        // actually use it during the spawn process
        throw new Error('getAppState not available in runShellCommand context');
      },
      setAppState
    });
    return handle.taskId;
  }

  // Helper to start backgrounding with optional logging
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
      // Without this, if the poller has stopped ticking for this task
      // (no output + shared-poller race with sibling stopPolling calls)
      // and the process is hung on I/O, the race at line ~1357 never
      // resolves and the generator deadlocks despite being backgrounded.
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
  // Only background commands that are allowed to be auto-backgrounded (not sleep, etc.)
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding('tengu_bash_command_timeout_backgrounded', backgroundFn);
    });
  }

  // In assistant mode, the main agent should stay responsive. Auto-background
  // blocking commands after ASSISTANT_BLOCKING_BUDGET_MS so the agent can keep
  // coordinating instead of waiting. The command keeps running — no state loss.
  if (feature('KAIROS') && getKairosActive() && isMainThread && !isBackgroundTasksDisabled && run_in_background !== true) {
    setTimeout(() => {
      if (shellCommand.status === 'running' && backgroundShellId === undefined) {
        assistantAutoBackgrounded = true;
        startBackgrounding('tengu_bash_command_assistant_auto_backgrounded');
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref();
  }

  // Handle Claude asking to run it in the background explicitly
  // When explicitly requested via run_in_background, always honor the request
  // regardless of the command type (isAutobackgroundingAllowed only applies to automatic backgrounding)
  // Skip if background tasks are disabled - run in foreground instead
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask();
    logEvent('tengu_bash_command_explicitly_backgrounded', {
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

  // Wait for the initial threshold before showing progress
  const startTime = Date.now();
  let foregroundTaskId: string | undefined = undefined;
  {
    const initialResult = await Promise.race([resultPromise, new Promise<null>(resolve => {
      const t = setTimeout((r: (v: null) => void) => r(null), PROGRESS_THRESHOLD_MS, resolve);
      t.unref();
    })]);
    if (initialResult !== null) {
      shellCommand.cleanup();
      return initialResult;
    }
    if (backgroundShellId) {
      return {
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
        backgroundTaskId: backgroundShellId,
        assistantAutoBackgrounded
      };
    }
  }

  // Start polling the output file for progress. The poller's #tick calls
  // onProgress every second, which resolves progressSignal below.
  TaskOutput.startPolling(shellCommand.taskOutput.taskId);

  // Progress loop: wake is driven by the shared poller calling onProgress,
  // which resolves the progressSignal.
  try {
    while (true) {
      const progressSignal = createProgressSignal();
      const result = await Promise.race([resultPromise, progressSignal]);
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
          shellCommand.cleanup();
          return fixedResult;
        }
        // Command has completed - return the actual result
        // If we registered as a foreground task, unregister it
        if (foregroundTaskId) {
          unregisterForeground(foregroundTaskId, setAppState);
        }
        // Clean up stream resources for foreground commands
        // (backgrounded commands are cleaned up by LocalShellTask)
        shellCommand.cleanup();
        return result;
      }

      // Check if command was backgrounded (either via old mechanism or new backgroundAll)
      if (backgroundShellId) {
        return {
          stdout: '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded
        };
      }

      // Check if this foreground task was backgrounded via backgroundAll()
      if (foregroundTaskId) {
        // shellCommand.status becomes 'backgrounded' when background() is called
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

      // Show minimal backgrounding UI if available
      // Skip if background tasks are disabled
      if (!isBackgroundTasksDisabled && backgroundShellId === undefined && elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 && setToolJSX) {
        // Register this command as a foreground task so it can be backgrounded via Ctrl+B
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
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
  }
}
