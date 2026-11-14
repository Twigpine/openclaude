import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_DOCTOR_PROMPT = `# Skill Doctor: audit loaded skills

Report which loaded skills went unused this session and what they cost in context, so the user can prune what they do not need.

## Step 1: Inventory

List every skill currently loaded in this session (the available-skills list in your context). For each one, record its name, source (bundled, plugin, personal, or project), and its directory if it lives on disk.

## Step 2: Usage

From this session's history, determine which loaded skills were actually invoked: skill commands the model called, plus skills the user ran directly. A skill whose name never appeared in a tool call or slash invocation counts as unused.

## Step 3: Cost

For each loaded skill estimate its context cost:

- If it has an on-disk SKILL.md, run \`wc -c\` on it and estimate tokens as bytes divided by 4 (state that this is an approximation).
- The description-level cost of a loaded-but-never-invoked skill is small: name, description, and trigger text sit in context. Full content only enters context on invocation.
- For skills with extracted reference files, note the extra files exist but are only read on demand.

## Step 4: Report

Produce a table:

| skill | source | invoked | est. content tokens |
|---|---|---|---|

Then summarize: total loaded skills, how many went unused, the combined estimated cost of unused skills, and a short prune recommendation (disable or remove the highest-cost unused skills; keep cheap ones). Do not modify any skill files or settings. This skill reports only; it changes nothing.
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
