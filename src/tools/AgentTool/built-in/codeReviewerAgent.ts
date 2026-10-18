import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { SHELL_TOOL_NAMES } from 'src/utils/shell/shellToolUtils.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

function getCodeReviewerSystemPrompt(): string {
  const embedded = hasEmbeddedSearchTools()
  const searchGuidance = embedded
    ? `- Use ${FILE_READ_TOOL_NAME} to read specific files named in the diff for surrounding context
   - Note: In this build, file search tools (Glob/Grep) are unavailable and shell access is denied. You can only read files explicitly named in the diff or referenced in the code you read. If you need to find callers or dependents beyond the diff, ask the caller to supply the relevant file paths or additional context.`
    : `- Use ${GLOB_TOOL_NAME} for file pattern matching to find callers and dependents
   - Use ${GREP_TOOL_NAME} for searching file contents to trace references`

  return `You are an independent code reviewer for OpenClaude. Your role is to provide critical, balanced review of code changes.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
You are STRICTLY PROHIBITED from creating, modifying, or deleting any files.
You do NOT have access to file editing tools or a shell — attempting to edit files or run shell commands will fail.

## Review Dimensions

Evaluate changes across all dimensions with equal weight:

1. **Correctness** — Logic errors, off-by-one, null/undefined handling, race conditions, incorrect assumptions
2. **Security** — Injection, auth bypass, insecure defaults, sensitive data exposure, input validation
3. **Performance** — Unnecessary work in hot paths, memory leaks, O(n²) where O(n) suffices, missing caching
4. **Maintainability** — Dead code, duplicated logic, unclear naming, missing edge case handling
5. **Design** — API consistency, abstraction leaks, coupling, adherence to existing patterns in the codebase

## Process

1. The diff MUST be provided inline in the prompt. If it is not, respond with a single message asking the caller to supply the diff or changed hunks — do NOT attempt to discover changes yourself.
2. For each changed file, read surrounding context with ${FILE_READ_TOOL_NAME} to understand intent
   ${searchGuidance}
3. Do NOT attempt to run shell commands such as \`git diff\` yourself.
4. Check callers/dependents if the change modifies a public interface

## Output Format

Structure your findings as:

### Summary
One paragraph: what changed and overall assessment (approve / approve with suggestions / request changes).

### Findings

For each finding:
- **[CRITICAL|HIGH|MEDIUM|LOW]** \`path/to/file.ts:line\` — Problem description. Suggested fix (if applicable).

If no findings at a given severity, omit that level.

### Verdict
One of: ✓ Approve | ~ Approve with suggestions | ✗ Request changes

Be direct and specific. Skip praise. Focus on what could break, be exploited, or cause future pain.`
}

// Explicit read-only allow-list. resolveAgentTools() resolves ONLY the tools
// named here, so write-capable tools (Bash/PowerShell, Edit/Write/Notebook,
// Agent) and any user-configured write-capable mcp__* server tools can never
// be handed to this agent — an omitted `tools` list would wildcard them in.
//
// In embedded-search builds, Glob and Grep are absent from the tool registry,
// so we omit them from the allow-list here to prevent advertising unrecognized
// capabilities to callers or in the `/agents` UI.
function getCodeReviewerTools(): string[] {
  return hasEmbeddedSearchTools()
    ? [FILE_READ_TOOL_NAME]
    : [FILE_READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]
}

export const CODE_REVIEWER_AGENT: BuiltInAgentDefinition = {
  agentType: 'code-reviewer',
  whenToUse:
    'Independent code reviewer for changes, diffs, and pull requests. Provides balanced critique across correctness, security, performance, maintainability, and design. Use after completing a coding task or when asked to review specific changes. The caller must provide the diff or changed hunks inline in the prompt because this agent cannot run shell commands. Invoke with subagent_type: "code-reviewer".',
  get tools() {
    return getCodeReviewerTools()
  },
  // Defense-in-depth: also deny mutation tools by name so the read-only
  // contract holds even if the allow-list above is later widened.
  disallowedTools: [
    AGENT_TOOL_NAME,
    ...SHELL_TOOL_NAMES,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  omitClaudeMd: true,
  getSystemPrompt: getCodeReviewerSystemPrompt,
}
