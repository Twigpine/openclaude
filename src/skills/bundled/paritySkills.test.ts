import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NEW_SKILLS = [
  'skill-doctor',
  'less-permission-prompts',
  'dataviz',
  'auto-mode-setup',
]

test(
  'parity skills register and dataviz validator extracts and runs',
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bundled-parity-'))
    const modulePath = (path: string) =>
      JSON.stringify(fileURLToPath(new URL(path, import.meta.url)))
    // Isolate bundled-skill global state and extraction in a subprocess.
    const script = `
      const { initBundledSkills } = await import(${modulePath('./index.ts')})
      const { getBundledSkills, getBundledSkillExtractDir } = await import(${modulePath('../bundledSkills.ts')})
      const { existsSync } = await import('node:fs')
      initBundledSkills()
      const skills = getBundledSkills()
      const result = { skills: {}, validatorPath: null }
      for (const name of ${JSON.stringify(NEW_SKILLS)}) {
        const skill = skills.find(s => s.name === name)
        if (skill) {
          const blocks = await skill.getPromptForCommand('', {})
          result.skills[name] = {
            userInvocable: skill.userInvocable,
            prompt: blocks.map(b => b.text ?? '').join('\\n'),
          }
        }
      }
      const dir = getBundledSkillExtractDir('dataviz')
      const candidate = dir + '/validate-palette.mjs'
      if (existsSync(candidate)) result.validatorPath = candidate
      console.log(JSON.stringify(result))
    `
    try {
      const child = Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, CLAUDE_CODE_TMPDIR: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr).toBe(0)
      const result = JSON.parse(stdout)
      for (const name of NEW_SKILLS) {
        expect(result.skills[name], `${name} not registered`).toBeDefined()
        expect(result.skills[name].userInvocable).toBe(true)
        expect(result.skills[name].prompt.length).toBeGreaterThan(0)
      }

      const autoModePrompt = result.skills['auto-mode-setup'].prompt
      expect(autoModePrompt).toContain('top-level `autoMode`')
      expect(autoModePrompt).toContain('explicit confirmation')
      expect(autoModePrompt).toContain('settings.local.json')
      expect(autoModePrompt).toContain('OPENCLAUDE_CONFIG_DIR')

      expect(result.skills['less-permission-prompts'].prompt).toContain(
        'OPENCLAUDE_CONFIG_DIR',
      )

      const doctorPrompt = result.skills['skill-doctor'].prompt
      expect(doctorPrompt).toContain('Loaded cost')
      expect(doctorPrompt).toContain('Invocation cost')
      expect(doctorPrompt).toContain('does not enter context until invocation')

      expect(result.validatorPath).not.toBeNull()
      const run = (args: string[]) =>
        Bun.spawn(['node', result.validatorPath, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited
      // Black on white is the canonical compliant pair
      expect(await run(['#000000', '#ffffff'])).toBe(0)
      // Two near-identical grays fail every pair
      expect(await run(['#777777', '#888888'])).toBe(1)
      // No args is a usage error, not a palette failure
      expect(await run([])).toBe(2)
      // Garbage input rejected, not treated as a color
      expect(await run(['notacolor', '#ffffff'])).toBe(2)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
  30000,
)
