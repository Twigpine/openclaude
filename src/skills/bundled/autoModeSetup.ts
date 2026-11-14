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

Skim a few recent transcripts under the per-project directory in the config home (\`~/.openclaude/projects/<sanitized-project-path>/\`). Note the commands and tools that came up repeatedly; those are the ones worth making frictionless.

## Step 3: Write configuration

Merge into the project settings file (\`.openclaude/settings.json\` or \`settings.local.json\`, whichever already carries permissions) under \`permissions.autoMode\`:

- \`environment\`: short factual lines describing the project for the classifier, e.g. "tests run via bun test", "build writes to dist/", "this repo vendors generated protobufs".
- \`allow\`: classifier allow rules for routine safe operations in this project.
- \`soft_deny\`: classifier deny hints for operations that look routine elsewhere but are risky here (e.g. a script named build.sh that actually deploys).

Rules:

- Merge with existing entries; never clobber or reorder what is already there.
- Do not enable auto mode, do not change defaultMode, do not touch allow/deny/ask rule lists. This skill only writes autoMode classifier hints.
- Ground every entry in something observed in step 1 or 2; do not invent rules.

## Step 4: Report

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
