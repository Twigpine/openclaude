import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_DOCTOR_PROMPT = `# Skill Doctor: audit loaded skills

Report which loaded skills went unused this session and what they cost in context, so the user can prune what they do not need.

## Step 1: Inventory

List every skill currently loaded in this session (the available-skills list in your context). For each one, record its name, source (bundled, plugin, personal, or project), and its directory if it lives on disk.

## Step 2: Usage

From this session's history, determine which loaded skills were actually invoked: skill commands the model called, plus skills the user ran directly. A skill whose name never appeared in a tool call or slash invocation counts as unused.

## Step 3: Cost

Estimate two separate costs per skill; do not conflate them:

- Loaded cost: what the skill occupies in context right now. That is its name, description, and trigger text in the skills list, so it stays small for every loaded skill.
- Invocation cost: what the skill would add to context only if it ran. If it has an on-disk SKILL.md, run \`wc -c\` on it and estimate tokens as bytes divided by 4 (state that this is an approximation). Full SKILL.md content does not enter context until invocation, so this number is potential spend, not current spend.

For skills with extracted reference files, note the extra files exist but are only read on demand.

## Step 4: Report

Produce a table:

| skill | source | invoked | loaded cost | invocation cost if run |
|---|---|---|---|---|

Then summarize: total loaded skills, how many went unused, and the combined loaded cost of unused skills (the real cost today). Use the invocation-cost column only to prioritize pruning, never count it as current spend. Recommend disabling or removing the highest-cost unused skills; keep cheap ones. Do not modify any skill files or settings. This skill reports only; it changes nothing.
`

export function registerSkillDoctorSkill(): void {
  registerBundledSkill({
    name: 'skill-doctor',
    description:
      'Audit loaded skills: which went unused this session and what they cost in context.',
    descriptionKey: 'skills.skillDoctor.description',
    userInvocable: true,
    async getPromptForCommand() {
      return [{ type: 'text', text: SKILL_DOCTOR_PROMPT }]
    },
  })
}
