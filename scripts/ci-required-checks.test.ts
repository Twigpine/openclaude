import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

interface Job {
  name?: string
  if?: string
  needs?: string | string[]
  steps: { run?: string }[]
}
interface Workflow {
  on: { pull_request: { paths?: string[]; 'paths-ignore'?: string[] } | null }
  jobs: Record<string, Job>
}
interface Result {
  result: string
  outputs?: Record<string, string>
}

const workflows = [
  { file: 'pr-checks.yml', surfaces: ['code', 'web'], name: 'PR checks required' },
  { file: 'install-hygiene.yml', surfaces: ['install'], name: 'Install hygiene required' },
  { file: 'vscode-launcher.yml', surfaces: ['extension'], name: 'VS Code launcher required' },
]

for (const { file, surfaces, name } of workflows) {
  const workflow = Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')) as Workflow
  const gate = workflow.jobs.required!
  const run = gate.steps.find(step => step.run)?.run ?? ''
  const script = run.match(/^node <<'NODE'\n([\s\S]*)\nNODE\s*$/)?.[1] ?? ''
  const dependencies = gate.needs as string[]
  const jobs = Object.keys(workflow.jobs).filter(job => !['required', 'changes', 'pr-intent-scan'].includes(job))

  function results(selected: string[]): Record<string, Result> {
    return Object.fromEntries(dependencies.map(job => {
      if (job === 'changes') return [job, { result: 'success', outputs: Object.fromEntries(surfaces.map(surface => [surface, String(selected.includes(surface))])) }]
      if (job === 'pr-intent-scan') return [job, { result: 'success' }]
      const surface = file === 'pr-checks.yml' ? (job === 'web' ? 'web' : 'code') : surfaces[0]!
      return [job, { result: selected.includes(surface) ? 'success' : 'skipped' }]
    }))
  }

  function status(input: Record<string, Result>, event = 'pull_request') {
    return spawnSync('node', ['-e', script], {
      env: { ...process.env, JOB_RESULTS: JSON.stringify(input), EVENT_NAME: event },
      encoding: 'utf8',
      timeout: 5_000,
    }).status
  }

  describe(name, () => {
    test('always reports on PRs and waits for every validation job', () => {
      expect(Object.hasOwn(workflow.on, 'pull_request')).toBe(true)
      expect(workflow.on.pull_request?.paths).toBeUndefined()
      expect(workflow.on.pull_request?.['paths-ignore']).toBeUndefined()
      expect(gate.name).toBe(name)
      expect(gate.if).toBe('${{ always() }}')
      expect([...dependencies].sort()).toEqual(Object.keys(workflow.jobs).filter(job => job !== 'required').sort())
      expect(script).not.toBe('')
    })

    test('passes docs-only skips and successful applicable surfaces independently', () => {
      expect(status(results([]))).toBe(0)
      for (const surface of surfaces) expect(status(results([surface]))).toBe(0)
      expect(status(results(surfaces))).toBe(0)
    })

    test('blocks failed, cancelled, or unexpectedly skipped applicable jobs', () => {
      for (const job of jobs) {
        for (const outcome of ['failure', 'cancelled', 'skipped']) {
          const input = results(surfaces)
          input[job]!.result = outcome
          expect(status(input)).toBe(1)
        }
      }
    })

    test('blocks unsuccessful change detection or intent scanning even on docs-only PRs', () => {
      for (const job of ['changes', 'pr-intent-scan'].filter(job => dependencies.includes(job))) {
        for (const outcome of ['failure', 'cancelled', 'skipped']) {
          const input = results([])
          input[job]!.result = outcome
          expect(status(input)).toBe(1)
        }
      }
      const missing = results([])
      missing.changes!.outputs = {}
      expect(status(missing)).toBe(1)
    })

    test('requires validation on non-PR runs even without PR filter outputs', () => {
      const event = file === 'install-hygiene.yml' ? 'schedule' : 'push'
      const passed = results(surfaces)
      passed.changes!.outputs = {}
      expect(status(passed, event)).toBe(0)
      const skipped = results([])
      skipped.changes!.outputs = {}
      expect(status(skipped, event)).toBe(1)
    })
  })
}
