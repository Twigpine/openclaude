// Seeded from src/skills/bundledSkills.ts + src/i18n/languages/en.ts.
// Feature-gated and hidden (non-user-invocable) skills are intentionally excluded.

export interface Skill {
  name: string
  invocation: string
  description: string
}

export const skills: Skill[] = [
  {
    name: 'batch',
    invocation: '/batch',
    description:
      'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR. Use for sweeping, mechanical changes (migrations, refactors, bulk renames) that decompose into independent units.',
  },
  {
    name: 'simplify',
    invocation: '/simplify',
    description:
      'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
  },
  {
    name: 'debug',
    invocation: '/debug',
    description: 'Enable debug logging for this session and help diagnose issues.',
  },
  {
    name: 'pdf',
    invocation: '/pdf',
    description:
      'Generate PDF documents from structured content — reports, formatted documents, tables, and more. Native TypeScript implementation, no external tooling.',
  },
  {
    name: 'update-config',
    invocation: '/update-config',
    description:
      'Configure the harness via settings.json: permissions, env vars, hooks, and automated behaviors ("from now on when X…").',
  },
]
