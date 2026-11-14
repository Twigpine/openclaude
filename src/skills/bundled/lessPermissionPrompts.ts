import { registerBundledSkill } from '../bundledSkills.js'

const LESS_PERMISSION_PROMPTS_PROMPT = `# Fewer permission prompts: propose an allowlist

Scan recent session transcripts for read-only tool calls that repeatedly needed permission, and propose a prioritized allowlist for this project.

## Step 1: Find transcripts

Resolve the config home first: \`OPENCLAUDE_CONFIG_DIR\` when set, otherwise \`~/.openclaude\`. Recent session transcripts live under the per-project directory inside it: \`<config-home>/projects/<sanitized-project-path>/\` (JSONL files, one per session). Use Glob/ls to find the newest handful for the current project. If none exist, fall back to reasoning from this session only.

## Step 2: Extract prompted commands

Read the transcripts and collect Bash tool calls plus MCP tool calls that would have needed permission (any non-trivial invocation; you cannot always see the prompt itself, so use frequency and known read-only shape as the signal). Count how often each distinct command or command prefix appears.

## Step 3: Filter to safe candidates

Keep only commands that are clearly read-only:

- Bash: inspection commands such as \`git status\`, \`git diff\`, \`git log\`, \`ls\`, \`cat\`, \`grep\`/\`rg\`, \`find\`, \`wc\`, \`head\`, \`tail\`, \`which\`, \`pwd\`, \`echo\`, read-only package-manager queries (\`npm ls\`, \`bun pm ls\`), test/lint/typecheck runners (\`bun test\`, \`bun run typecheck\`, \`npm test\`) that do not write outside the project.
- MCP: tools whose names or descriptions indicate read/query/get/list/fetch/search behavior.
- Never propose anything that writes, deletes, installs, publishes, pushes, kills processes, or touches files outside the project. When in doubt, leave it out.

## Step 4: Propose rules

Rank the survivors by frequency. For each, propose a permission rule in this project's allowlist format, e.g. \`Bash(git status)\`, \`Bash(git diff:*)\`, or \`mcp__<server>__<tool>\`. Present the proposal to the user with the count evidence for each rule.

## Step 5: Confirm, then write

Ask the user which proposals to accept. Only after explicit confirmation, merge the accepted rules into \`permissions.allow\` in \`.openclaude/settings.local.json\` (create the file if needed). Merge with any existing entries; never clobber or reorder existing rules. Report what was written.
`

export function registerLessPermissionPromptsSkill(): void {
  registerBundledSkill({
    name: 'less-permission-prompts',
    description:
      'Scan recent sessions for frequently prompted read-only commands and propose a project allowlist.',
    descriptionKey: 'skills.lessPermissionPrompts.description',
    userInvocable: true,
    async getPromptForCommand() {
      return [{ type: 'text', text: LESS_PERMISSION_PROMPTS_PROMPT }]
    },
  })
}
