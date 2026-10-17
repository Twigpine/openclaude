import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import treeKill from 'tree-kill'

const repoRoot = resolve(import.meta.dir, '..', '..')
const cliEntrypoint = join(repoRoot, 'src', 'entrypoints', 'cli.tsx')
const cliTimeoutMs = 10_000

async function readStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const cancel = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

async function runSkillsList(
  args: string[],
  siblingSkills: string[] = [],
): Promise<{
  exitCode: number
  stderr: string
  stdout: string
}> {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-skills-cli-'))
  try {
    const projectDir = join(root, 'project')
    const homeDir = join(root, 'home')
    const configDir = join(root, 'config')
    mkdirSync(projectDir)
    mkdirSync(homeDir)
    for (const name of siblingSkills) {
      const skillDir = join(homeDir, '.agents', 'skills', name)
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---\ndescription: sibling ${name}\n---\nInstructions\n`,
      )
    }

    const proc = Bun.spawn({
      cmd: [process.execPath, cliEntrypoint, ...args],
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_API_KEY: '',
        CLAUDE_CONFIG_DIR: configDir,
        HOME: homeDir,
        OPENCLAUDE_DISABLE_EARLY_INPUT: '1',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    const streamAbort = new AbortController()
    let exited = false
    const processExit = proc.exited.finally(() => {
      exited = true
    })
    let termination: Promise<void> | undefined
    const terminate = (): Promise<void> => {
      if (termination) return termination
      streamAbort.abort()
      termination = new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        const fallback = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            // The process may already have exited while tree-kill was running.
          } finally {
            finish()
          }
        }, 500)
        treeKill(proc.pid, 'SIGKILL', error => {
          clearTimeout(fallback)
          if (error && !exited) {
            try {
              proc.kill('SIGKILL')
            } catch {
              // The process may have exited between tree-kill and the fallback.
            }
          }
          finish()
        })
      })
      return termination
    }
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => {
        void terminate().finally(() => {
          reject(new Error(`skills CLI timed out after ${cliTimeoutMs}ms`))
        })
      }, cliTimeoutMs)
    })
    try {
      const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([
          readStream(proc.stdout, streamAbort.signal),
          readStream(proc.stderr, streamAbort.signal),
          processExit,
        ]),
        timeout,
      ])

      return { exitCode, stderr, stdout }
    } finally {
      if (watchdog) clearTimeout(watchdog)
      if (!exited) {
        await terminate()
        await Promise.race([
          processExit.catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 1_000)),
        ])
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('skills list bypasses provider startup validation', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList(['skills', 'list'])

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('Skills: 0 enabled')
  expect(stdout).toContain('No installed skills found.')
  expect(stderr).not.toContain('OPENAI_API_KEY is required')
}, 15_000)

test('source CLI reserves bundled names when listing sibling skills', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList(
    ['skills', 'list', '--json'],
    ['simplify', 'pdf', 'sibling-only'],
  )
  expect(exitCode, stderr).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.enabledCount).toBe(1)
  expect(result.skills.map((skill: { name: string }) => skill.name)).toEqual([
    'sibling-only',
  ])
  expect(result.skills[0].source).toBe('agents')
}, 15_000)

test('skills list bypasses provider startup validation after --bare', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList([
    '--bare',
    'skills',
    'list',
  ])

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('Skills: 0 enabled')
  expect(stdout).toContain('No installed skills found.')
  expect(stderr).not.toContain('OPENAI_API_KEY is required')
}, 15_000)

test('skills list bypasses provider startup validation after --settings', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList([
    '--settings',
    '{}',
    'skills',
    'list',
  ])

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('Skills: 0 enabled')
  expect(stderr).not.toContain('OPENAI_API_KEY is required')
}, 15_000)

test('skills list bypasses provider startup validation after --setting-sources', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList([
    '--setting-sources',
    'user,project',
    'skills',
    'list',
  ])

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('Skills: 0 enabled')
  expect(stderr).not.toContain('OPENAI_API_KEY is required')
}, 15_000)

test('skills list honors --add-dir before provider startup validation', async () => {
  const addDirRoot = mkdtempSync(join(tmpdir(), 'openclaude-skills-add-dir-'))
  const skillDir = join(addDirRoot, '.openclaude', 'skills', 'addon')
  try {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\ndescription: Skill loaded from add-dir.\n---\n# Addon\n`,
      'utf8',
    )

    const { exitCode, stderr, stdout } = await runSkillsList([
      '--add-dir',
      addDirRoot,
      'skills',
      'list',
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('addon')
    expect(stderr).not.toContain('OPENAI_API_KEY is required')
  } finally {
    rmSync(addDirRoot, { recursive: true, force: true })
  }
}, 15_000)

test('skills list accepts equals-form global flags before provider startup validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-skills-cli-flags-'))
  const providerEnvFile = join(root, 'provider.env')
  const pluginDir = join(root, 'plugin')
  try {
    writeFileSync(providerEnvFile, '', 'utf8')
    mkdirSync(pluginDir, { recursive: true })

    const { exitCode, stderr, stdout } = await runSkillsList([
      `--provider-env-file=${providerEnvFile}`,
      `--plugin-dir=${pluginDir}`,
      '--mcp-config={}',
      'skills',
      'list',
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('Skills: 0 enabled')
    expect(stderr).not.toContain('OPENAI_API_KEY is required')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

test('--print keeps skills as a prompt instead of the management subcommand', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList([
    '--print',
    'skills',
    'list',
  ])

  expect(exitCode).toBe(1)
  expect(stdout).not.toContain('Skills: 0 enabled')
  expect(stderr).toContain('OPENAI_API_KEY')
}, 15_000)

test('--print with intervening global flags keeps skills as prompt text', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList([
    '--print',
    '--model',
    'gpt-4',
    'skills',
    'list',
  ])

  expect(exitCode).toBe(1)
  expect(stdout).not.toContain('Skills: 0 enabled')
  expect(stderr).toContain('OPENAI_API_KEY')
}, 15_000)

test('--continue keeps skills as prompt text instead of the management subcommand', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList([
    '--continue',
    'skills',
    'list',
  ])

  expect(exitCode).toBe(1)
  expect(stdout).not.toContain('Skills: 0 enabled')
  expect(stderr).toContain('OPENAI_API_KEY')
}, 15_000)

test('skills list accepts trailing global flags', async () => {
  const { exitCode, stderr, stdout } = await runSkillsList([
    'skills',
    'list',
    '--bare',
  ])

  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('Skills: 0 enabled')
  expect(stderr).not.toContain('Unknown skills option')
}, 15_000)

test('skills list honors trailing --add-dir', async () => {
  const addDirRoot = mkdtempSync(join(tmpdir(), 'openclaude-skills-add-dir-'))
  const skillDir = join(addDirRoot, '.openclaude', 'skills', 'addon')
  try {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\ndescription: Skill loaded from trailing add-dir.\n---\n# Addon\n`,
      'utf8',
    )

    const { exitCode, stderr, stdout } = await runSkillsList([
      'skills',
      'list',
      '--add-dir',
      addDirRoot,
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('addon')
    expect(stderr).not.toContain('Unknown skills option')
  } finally {
    rmSync(addDirRoot, { recursive: true, force: true })
  }
}, 15_000)
