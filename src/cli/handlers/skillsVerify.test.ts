import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { setEyebrowRunnerForTesting, skillsVerifyHandler } from './skillsVerify.ts'

const SKILL_MD = `---
name: sample-skill
description: Sample skill used by verify tests.
---

# Sample Skill
`

const REGISTRY_SHA256 =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

type Captured = { out: string[]; err: string[] }

/**
 * Builds an empty project and user skills root, a registry directory, and
 * clean process state: no eyebrow on PATH, no env override, exit code 0.
 * Every test mutates process globals, so each one holds the shared lock.
 */
async function withVerifyFixture(
  fn: (fixture: {
    tempDir: string
    projectDir: string
    userSkills: string
    projectSkills: string
    registryDir: string
    captured: Captured
  }) => Promise<void>,
): Promise<void> {
  await acquireSharedMutationLock('skillsVerifyHandler')
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-skill-verify-test-'))
  const projectDir = join(tempDir, 'project')
  const projectSkills = join(projectDir, '.openclaude', 'skills')
  const userHome = join(tempDir, 'home')
  const userSkills = join(userHome, 'skills')
  const registryDir = join(tempDir, 'registry')
  const emptyPathDir = join(tempDir, 'empty-path')
  for (const dir of [projectSkills, userSkills, registryDir, emptyPathDir]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(registryDir, 'registry.json'), '[]', 'utf8')
  writeFileSync(join(registryDir, 'revocations.json'), '[]', 'utf8')

  const saved = {
    path: process.env.PATH,
    bin: process.env.OPENCLAUDE_EYEBROW_BIN,
    revocationsUrl: process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL,
    registryUrl: process.env.OPENCLAUDE_SKILLS_REGISTRY_URL,
    log: console.log,
    error: console.error,
  }
  process.env.PATH = emptyPathDir
  delete process.env.OPENCLAUDE_EYEBROW_BIN
  delete process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL
  delete process.env.OPENCLAUDE_SKILLS_REGISTRY_URL
  process.exitCode = 0
  setClaudeConfigHomeDirForTesting(userHome)
  const captured: Captured = { out: [], err: [] }
  console.log = (...parts: unknown[]) => {
    captured.out.push(parts.map(String).join(' '))
  }
  console.error = (...parts: unknown[]) => {
    captured.err.push(parts.map(String).join(' '))
  }
  try {
    await fn({ tempDir, projectDir, userSkills, projectSkills, registryDir, captured })
  } finally {
    console.log = saved.log
    console.error = saved.error
    setClaudeConfigHomeDirForTesting(undefined)
    setEyebrowRunnerForTesting(undefined)
    process.exitCode = 0
    restoreEnv('PATH', saved.path)
    restoreEnv('OPENCLAUDE_EYEBROW_BIN', saved.bin)
    restoreEnv('OPENCLAUDE_SKILLS_REVOCATIONS_URL', saved.revocationsUrl)
    restoreEnv('OPENCLAUDE_SKILLS_REGISTRY_URL', saved.registryUrl)
    rmSync(tempDir, { recursive: true, force: true })
    releaseSharedMutationLock()
  }
}

/**
 * True when this platform lets the test create a directory symlink.
 * Windows needs a privilege or developer mode for that, so the symlink
 * cases are reported as skipped there instead of failing in setup.
 */
function canSymlinkDirectories(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'openclaude-skill-verify-symlink-probe-'))
  const target = join(probeDir, 'target')
  mkdirSync(target)
  try {
    symlinkSync(target, join(probeDir, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

const symlinkTest = test.serial.skipIf(!canSymlinkDirectories())

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function writeSkill(
  root: string,
  name: string,
  sidecar?: Record<string, unknown>,
): string {
  const dir = join(root, ...name.split(':'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD, 'utf8')
  if (sidecar) {
    writeFileSync(join(dir, 'skill.json'), JSON.stringify(sidecar), 'utf8')
  }
  return dir
}

function registrySidecar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gitlawb/sample-skill',
    name: 'sample-skill',
    trust: 'official',
    version: '0.1.0',
    sha256: REGISTRY_SHA256,
    ...overrides,
  }
}

function writeRevocations(registryDir: string, entries: unknown): void {
  writeFileSync(
    join(registryDir, 'revocations.json'),
    typeof entries === 'string' ? entries : JSON.stringify(entries),
    'utf8',
  )
}

test.serial('reports installed registry skills as ok when nothing is revoked', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, userSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    writeSkill(userSkills, 'git:commit', registrySidecar({ id: 'gitlawb/git-commit' }))

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 0)
    assert.match(captured.out[0]!, /^Found 2 installed skills\. Revocation list: .*revocations\.json$/)
    assert.ok(captured.out.some(line => /git:commit\s+ok$/.test(line)))
    assert.ok(captured.out.some(line => /sample-skill\s+ok$/.test(line)))
    assert.ok(captured.out.some(line => line.startsWith('eyebrow not found')))
    assert.deepEqual(captured.err, [])
  })
})

test.serial('flags a skill revoked by id and version', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    writeRevocations(registryDir, [
      { id: 'gitlawb/sample-skill', version: '0.1.0', reason: 'compromised release' },
    ])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.ok(
      captured.out.some(line => /sample-skill\s+REVOKED \(compromised release\)$/.test(line)),
    )
    assert.match(captured.err[0]!, /^1 revoked skill installed\./)
  })
})

test.serial('flags a skill revoked by digest alone', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    writeRevocations(registryDir, [{ sha256: REGISTRY_SHA256.toUpperCase() }])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.ok(captured.out.some(line => /sample-skill\s+REVOKED$/.test(line)))
  })
})

test.serial('leaves a skill alone when the revocation names another version', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    writeRevocations(registryDir, [{ id: 'gitlawb/sample-skill', version: '0.2.0' }])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 0)
    assert.ok(captured.out.some(line => /sample-skill\s+ok$/.test(line)))
  })
})

test.serial('skips local skills that carry no registry metadata', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'hand-made')
    writeSkill(projectSkills, 'stale-sidecar', { trust: 'local' })
    writeRevocations(registryDir, [{ id: 'gitlawb/hand-made' }])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 0)
    assert.ok(
      captured.out.some(line => /hand-made\s+skipped \(no registry metadata\)$/.test(line)),
    )
    assert.ok(
      captured.out.some(line => /stale-sidecar\s+skipped \(no registry metadata\)$/.test(line)),
    )
  })
})

test.serial('matches a copied sidecar on a local install like a registry one', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'copied', registrySidecar({ id: 'gitlawb/copied', trust: 'official' }))
    writeRevocations(registryDir, [{ id: 'gitlawb/copied' }])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.ok(captured.out.some(line => /^\s+copied\s+REVOKED$/.test(line)))
  })
})

symlinkTest('finds a skill behind a symlinked skill directory', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, projectSkills, registryDir, captured }) => {
    const target = writeSkill(join(tempDir, 'elsewhere'), 'linked', registrySidecar({ id: 'gitlawb/linked' }))
    symlinkSync(target, join(projectSkills, 'linked'), 'dir')
    writeRevocations(registryDir, [{ id: 'gitlawb/linked' }])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.ok(captured.out.some(line => /^\s+linked\s+REVOKED$/.test(line)))
  })
})

test.serial('finds a skill nested below another skill', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'outer', registrySidecar({ id: 'gitlawb/outer' }))
    writeSkill(projectSkills, 'outer:inner', registrySidecar({ id: 'gitlawb/inner' }))
    writeRevocations(registryDir, [{ id: 'gitlawb/inner' }])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.match(captured.out[0]!, /^Found 2 installed skills\. /)
    assert.ok(captured.out.some(line => /^\s+outer\s+ok$/.test(line)))
    assert.ok(captured.out.some(line => /^\s+outer:inner\s+REVOKED$/.test(line)))
  })
})

symlinkTest('reports a skill once when a symlink points back at the skills root', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    symlinkSync(projectSkills, join(projectSkills, 'loop-root'), 'dir')
    symlinkSync(projectDir, join(projectSkills, 'loop-ancestor'), 'dir')

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 0)
    assert.match(captured.out[0]!, /^Found 1 installed skill\. /)
    assert.equal(captured.out.filter(line => /sample-skill\s+ok$/.test(line)).length, 1)
  })
})

symlinkTest('reports a skill once when project and user roots link the same directory', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, projectSkills, userSkills, registryDir, captured }) => {
    const target = writeSkill(join(tempDir, 'elsewhere'), 'shared', registrySidecar({ id: 'gitlawb/shared' }))
    symlinkSync(target, join(projectSkills, 'shared'), 'dir')
    symlinkSync(target, join(userSkills, 'shared'), 'dir')
    writeRevocations(registryDir, [{ id: 'gitlawb/shared' }])

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.match(captured.out[0]!, /^Found 1 installed skill\. /)
    assert.equal(captured.out.filter(line => /^\s+shared\s+REVOKED$/.test(line)).length, 1)
    assert.match(captured.err[0]!, /^1 revoked skill installed\./)
  })
})

test.serial('fails closed when the revocation list cannot be parsed', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    writeRevocations(registryDir, '{not json')

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.match(captured.err[0]!, /Revocation list at .* is not valid JSON\./)
    assert.deepEqual(captured.out, [])
  })
})

test.serial('reads an absent revocation list as empty', async () => {
  await withVerifyFixture(async ({ projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    rmSync(join(registryDir, 'revocations.json'))

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 0)
    assert.ok(captured.out.some(line => /sample-skill\s+ok$/.test(line)))
  })
})

test.serial('hands off to eyebrow with the project path and lockfile', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, projectSkills, registryDir, captured }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    writeFileSync(join(projectDir, 'eyebrowlock.json'), '{}', 'utf8')
    const binary = join(tempDir, 'fake-eyebrow')
    writeFileSync(binary, '', 'utf8')
    process.env.OPENCLAUDE_EYEBROW_BIN = binary
    const calls: { binary: string; args: string[]; cwd: string }[] = []
    setEyebrowRunnerForTesting(async (bin, args, cwd) => {
      calls.push({ binary: bin, args, cwd })
      return 1
    })

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.binary, binary)
    assert.equal(calls[0]!.cwd, projectDir)
    assert.deepEqual(calls[0]!.args, [
      'verify',
      '--path',
      '.',
      '--lockfile',
      'eyebrowlock.json',
    ])
    assert.equal(process.exitCode, 1)
    assert.ok(captured.out.some(line => line.startsWith(`Running ${binary} verify `)))
  })
})

test.serial('adds --ci and the policy path when a policy is given', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, registryDir }) => {
    writeFileSync(join(projectDir, 'custom.lock.json'), '{}', 'utf8')
    process.env.OPENCLAUDE_EYEBROW_BIN = join(tempDir, 'fake-eyebrow')
    const calls: string[][] = []
    setEyebrowRunnerForTesting(async (_bin, args) => {
      calls.push(args)
      return 0
    })

    await skillsVerifyHandler({
      projectDir,
      registry: registryDir,
      lockfile: 'custom.lock.json',
      policy: 'eyebrow.policy.json',
    })

    assert.equal(process.exitCode, 0)
    assert.deepEqual(calls[0], [
      'verify',
      '--path',
      '.',
      '--lockfile',
      'custom.lock.json',
      '--ci',
      '--policy',
      'eyebrow.policy.json',
    ])
  })
})

test.serial('keeps exit code 1 for a revoked skill even when eyebrow is clean', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, projectSkills, registryDir }) => {
    writeSkill(projectSkills, 'sample-skill', registrySidecar())
    writeRevocations(registryDir, [{ id: 'gitlawb/sample-skill' }])
    writeFileSync(join(projectDir, 'eyebrowlock.json'), '{}', 'utf8')
    process.env.OPENCLAUDE_EYEBROW_BIN = join(tempDir, 'fake-eyebrow')
    setEyebrowRunnerForTesting(async () => 0)

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
  })
})

test.serial('does not run eyebrow when the lockfile is missing', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, registryDir, captured }) => {
    process.env.OPENCLAUDE_EYEBROW_BIN = join(tempDir, 'fake-eyebrow')
    let ran = false
    setEyebrowRunnerForTesting(async () => {
      ran = true
      return 1
    })

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(ran, false)
    assert.equal(process.exitCode, 0)
    assert.ok(
      captured.out.some(line => /^eyebrow found but no lockfile at .*eyebrowlock\.json\. Run "eyebrow scan --path \. --lockfile eyebrowlock\.json" in /.test(line)),
    )
  })
})

test.serial('finds eyebrow on PATH', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, registryDir, captured }) => {
    const binDir = join(tempDir, 'bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'eyebrow'), '', 'utf8')
    chmodSync(join(binDir, 'eyebrow'), 0o755)
    process.env.PATH = [process.env.PATH, binDir].join(delimiter)
    writeFileSync(join(projectDir, 'eyebrowlock.json'), '{}', 'utf8')
    const binaries: string[] = []
    setEyebrowRunnerForTesting(async bin => {
      binaries.push(bin)
      return 0
    })

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.deepEqual(binaries, [join(binDir, 'eyebrow')])
    assert.equal(process.exitCode, 0)
    assert.ok(captured.out.some(line => line.startsWith(`Running ${join(binDir, 'eyebrow')} verify `)))
  })
})

test.serial('skips a non-executable eyebrow file earlier on PATH', async () => {
  if (process.platform === 'win32') {
    return
  }
  await withVerifyFixture(async ({ tempDir, projectDir, registryDir }) => {
    const plainDir = join(tempDir, 'plain')
    const execDir = join(tempDir, 'exec')
    mkdirSync(plainDir)
    mkdirSync(execDir)
    writeFileSync(join(plainDir, 'eyebrow'), '', 'utf8')
    chmodSync(join(plainDir, 'eyebrow'), 0o644)
    writeFileSync(join(execDir, 'eyebrow'), '', 'utf8')
    chmodSync(join(execDir, 'eyebrow'), 0o755)
    process.env.PATH = [plainDir, execDir, process.env.PATH].join(delimiter)
    writeFileSync(join(projectDir, 'eyebrowlock.json'), '{}', 'utf8')
    const binaries: string[] = []
    setEyebrowRunnerForTesting(async bin => {
      binaries.push(bin)
      return 0
    })

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.deepEqual(binaries, [join(execDir, 'eyebrow')])
  })
})

test.serial('passes a real eyebrow exit code through', async () => {
  if (process.platform === 'win32') {
    return
  }
  await withVerifyFixture(async ({ tempDir, projectDir, registryDir }) => {
    const binary = join(tempDir, 'eyebrow.sh')
    writeFileSync(binary, '#!/bin/sh\nexit 3\n', 'utf8')
    chmodSync(binary, 0o755)
    process.env.OPENCLAUDE_EYEBROW_BIN = binary
    writeFileSync(join(projectDir, 'eyebrowlock.json'), '{}', 'utf8')

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 3)
  })
})

test.serial('reports a binary that cannot be started', async () => {
  await withVerifyFixture(async ({ tempDir, projectDir, registryDir, captured }) => {
    process.env.OPENCLAUDE_EYEBROW_BIN = join(tempDir, 'missing-eyebrow')
    writeFileSync(join(projectDir, 'eyebrowlock.json'), '{}', 'utf8')

    await skillsVerifyHandler({ projectDir, registry: registryDir })

    assert.equal(process.exitCode, 1)
    assert.match(captured.err[0]!, /^Failed to run eyebrow at .*missing-eyebrow: /)
  })
})
