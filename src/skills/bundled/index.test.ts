import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

for (const interactive of [false, true]) {
  test(`bundled registration and extraction: ${interactive ? 'interactive versioned' : 'noninteractive source'} session`, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bundled-init-'))
    // Isolate optional-package mocks, bootstrap state, and memoized extraction
    // paths in a subprocess so they cannot affect other test files.
    const modulePath = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)))
    const script = `
      import { mock } from 'bun:test'
      mock.module(${modulePath('./claudeInChromeAccess.ts')}, () => ({
        shouldEnableClaudeInChromeSkill: () => true,
      }))
      mock.module('@ant/claude-for-chrome-mcp', () => ({ BROWSER_TOOLS: [] }))
      ${interactive ? "globalThis.MACRO = { VERSION: 'test-version' }" : 'delete globalThis.MACRO'}
      const { setIsInteractive } = await import(${modulePath('../../bootstrap/state.ts')})
      const { initBundledSkills } = await import(${modulePath('./index.ts')})
      const { getBundledSkills, getBundledSkillExtractDir } = await import(${modulePath('../bundledSkills.ts')})
      const { getBundledSkillsRoot } = await import(${modulePath('../../utils/permissions/filesystem.ts')})
      const { readdirSync } = await import('node:fs')
      setIsInteractive(${interactive})
      initBundledSkills()
      const skills = getBundledSkills()
      const pdf = skills.find(skill => skill.name === 'pdf')
      const blocks = await pdf.getPromptForCommand('', {})
      const root = getBundledSkillsRoot()
      const dir = getBundledSkillExtractDir('pdf')
      console.log(JSON.stringify({
        names: skills.map(skill => skill.name), root, dir,
        stableRoot: getBundledSkillsRoot() === root,
        files: readdirSync(dir),
        prompt: blocks.filter(block => block.type === 'text').map(block => block.text).join('\\n'),
      }))
    `
    try {
      const child = Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, CLAUDE_CODE_TMPDIR: tempDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect(exit, stderr).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.names.includes('claude-in-chrome')).toBe(interactive)
      expect(result.names).toContain('simplify')
      expect(result.names).toContain('pdf')
      expect(basename(dirname(result.root))).toBe(interactive ? 'test-version' : 'development')
      expect(basename(result.root)).toMatch(/^[a-f0-9]{32}$/)
      expect(result.stableRoot).toBe(true)
      expect(result.dir).toBe(join(result.root, 'pdf'))
      expect(result.files).toContain('pdfgen.ts')
      expect(result.prompt).toContain(`Base directory for this skill: ${result.dir}`)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 15_000)
}
