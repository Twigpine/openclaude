import { registerBundledSkill } from '../bundledSkills.js'

const AUTO_MODE_SETUP_PROMPT = `# Auto mode setup: teach the classifier about this project

Auto mode decides tool calls with a classifier instead of prompting. This skill configures it for the current project; it does not turn auto mode on.

## Step 1: Read the project

Inspect what makes this project tick:

- Package/build config (package.json scripts, Makefile, justfile, task runners)
- CI configuration for the canonical check commands
- The test, lint, typecheck, and build commands a safe workflow uses
- Anything environment-specific the classifier should know: required network access, codegen steps, tools that write outside the project by design

## Step 2: Read recent sessions

Resolve the config home first: \`OPENCLAUDE_CONFIG_DIR\` when set, otherwise \`~/.openclaude\`. Then skim a few recent transcripts under the per-project directory inside it (\`<config-home>/projects/<sanitized-project-path>/\`). Note the commands and tools that came up repeatedly; those are the ones worth making frictionless.

## Step 3: Draft configuration

Draft a top-level \`autoMode\` block:

- \`environment\`: short factual lines describing the project for the classifier, e.g. "tests run via bun test", "build writes to dist/", "this repo vendors generated protobufs".
- \`allow\`: classifier allow rules for routine safe operations in this project.
- \`soft_deny\`: classifier deny hints for operations that look routine elsewhere but are risky here (e.g. a script named build.sh that actually deploys).

Rules:

- The \`autoMode\` block is a top-level settings key. Do not write it under \`permissions\`; \`permissions.autoMode\` is a separate boolean and is not the classifier configuration.
- Ground every entry in something observed in step 1 or 2; do not invent rules.
- Do not enable auto mode, do not change defaultMode, do not touch allow/deny/ask rule lists.

## Step 4: Confirm, then write

Present the drafted \`autoMode\` block to the user and ask for explicit confirmation before writing anything.

Only after confirmation, merge it into a local settings file: \`.openclaude/settings.local.json\` for this project, or the user-level \`settings.json\` under the active config home to apply it to every project. The active config home is the directory in the \`OPENCLAUDE_CONFIG_DIR\` environment variable when it is set, otherwise \`~/.openclaude\`; check the variable and resolve the path yourself rather than assuming \`~/.openclaude\`. Never write it to \`.openclaude/settings.json\`: shared project settings are not a trusted source for classifier configuration and are ignored when autoMode is loaded.

Merge with existing entries; never clobber or reorder what is already there.

## Step 5: Report

Show the final merged autoMode block and a one-line justification per entry.
`

export function registerAutoModeSetupSkill(): void {
  registerBundledSkill({
    name: 'auto-mode-setup',
    description:
      'Inspect this project and recent sessions, then write autoMode classifier configuration.',
    descriptionKey: 'skills.autoModeSetup.description',
    userInvocable: true,
    async getPromptForCommand() {
      return [{ type: 'text', text: AUTO_MODE_SETUP_PROMPT }]
    },
  })
}
