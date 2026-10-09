import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  enableUserAndProjectSettingSources,
  restoreSettingState,
} from '../../test/settingSourceState.js'
import { setAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import type { Command } from '../../types/command.js'
import {
  getFsImplementation,
  setFsImplementation,
} from '../../utils/fsOperations.js'
import { skillsInstallHandler } from './skillsInstall.ts'
import { skillsRemoveHandler } from './skills.ts'
import {
  formatSkillsListForDisplay,
  formatSkillsListJson,
  trustLabel,
} from './skillsListFormat.ts'
import { getSkillRemoveNotFoundMessage } from './skillsRemoveMessage.ts'
import { validateSkillPath } from './skillsValidation.ts'

type SkillCommand = Command & { type: 'prompt' }

const VALID_SKILL = `---
name: sample-skill
title: Sample Skill
description: Sample skill used by install tests.
version: 0.1.0
category: test
author: OpenClaude Tests
license: MIT
trust: local
---

# Sample Skill

Use this skill for install tests.
Document token scopes without storing secret values.
`

const NAMESPACED_SKILL = `---
name: git:commit
title: Git Commit
description: Nested git commit skill used by install tests.
version: 0.1.0
category: test
author: OpenClaude Tests
license: MIT
trust: local
---

# Git Commit

Use this skill for commit workflows.
`

const MINIMAL_EXISTING_FORMAT_SKILL = `---
description: Minimal existing-format skill.
---

# Minimal Existing Format

Use this skill for compatibility tests.
`

const PATH_TRAVERSAL_SKILL = `---
name: ../escape
title: Unsafe Skill
description: Invalid skill used by install tests.
version: 0.1.0
category: test
author: OpenClaude Tests
license: MIT
trust: local
---

# Unsafe Skill
`

function skill(
  name: string,
  description: string | undefined,
  source: SkillCommand['source'] = 'bundled',
  skillTrust?: string,
): SkillCommand {
  return {
    type: 'prompt',
    name,
    description: description ?? '',
    hasUserSpecifiedDescription: description !== undefined,
    progressMessage: 'running',
    contentLength: description?.length ?? 0,
    source,
    skillTrust,
    loadedFrom: source === 'bundled' ? 'bundled' : 'skills',
    userInvocable: true,
    async getPromptForCommand() {
      return []
    },
  }
}

function writeSkillDir(root: string): string {
  const skillDir = join(root, 'sample-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL, 'utf8')
  return skillDir
}

function sha256OfSkillSource(text: string): string {
  return createHash('sha256')
    .update(text.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex')
}

function buildRegistryEntry(
  sourceDir: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'gitlawb/sample-skill',
    name: 'sample-skill',
    title: 'Sample Skill',
    description: 'Sample skill used by install tests.',
    trust: 'official',
    version: '0.1.0',
    license: 'MIT',
    author: 'OpenClaude Tests',
    source: join(sourceDir, 'SKILL.md'),
    ...overrides,
  }
}

function stagedInstallTempDirs(): string[] {
  return readdirSync(tmpdir()).filter(entry =>
    entry.startsWith('openclaude-skill-install-'),
  )
}

function assertNoNewStagedInstallDirs(before: string[]): void {
  assert.deepEqual(stagedInstallTempDirs().sort(), before.sort())
}

const REMOTE_REGISTRY_URL = 'https://registry.test/registry.json'
const REMOTE_REVOCATIONS_URL = 'https://registry.test/revocations.json'
const REMOTE_SKILL_URL = 'https://registry.test/skills/sample-skill/SKILL.md'

type FetchHandler = (url: string) => Response | Promise<Response>

/**
 * Serves a registry and its skill through a mocked fetch, so the install
 * resolves revocations.json as the registry's remote sibling and reads it
 * over HTTP. `revocations` decides that one route; every requested URL is
 * recorded so a test can prove the transport boundary was exercised.
 */
function remoteRegistryFetch(
  revocations: () => Response | Promise<Response>,
  requested: string[],
): FetchHandler {
  return url => {
    requested.push(url)
    switch (url) {
      case REMOTE_REGISTRY_URL:
        return new Response(
          JSON.stringify([
            buildRegistryEntry('', {
              source: 'skills/sample-skill/SKILL.md',
              sha256: sha256OfSkillSource(VALID_SKILL),
            }),
          ]),
          { status: 200 },
        )
      case REMOTE_SKILL_URL:
        return new Response(VALID_SKILL, { status: 200 })
      case REMOTE_REVOCATIONS_URL:
        return revocations()
      default:
        throw new Error(`Unexpected fetch during install: ${url}`)
    }
  }
}

async function withMockedFetch<T>(
  handler: FetchHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) =>
    handler(input instanceof Request ? input.url : String(input))) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function withTempDir<T>(fn: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-skill-install-test-'))
  // The revocation override is process-global input that the fixtures below
  // resolve against, and production gives it precedence over the sibling
  // revocations.json. Own it here: clear any value inherited from the host
  // process so each fixture reads its own list, and hand it back afterwards.
  const inheritedRevocationsUrl = process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL
  delete process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL
  try {
    return await fn(tempDir)
  } finally {
    process.exitCode = 0
    if (inheritedRevocationsUrl === undefined) {
      delete process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL
    } else {
      process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL = inheritedRevocationsUrl
    }
    rmSync(tempDir, { recursive: true, force: true })
  }
}

test('formats skills list as an aligned human table', () => {
  const output = formatSkillsListForDisplay(
    [
      skill(
        'batch',
        'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.',
        'projectSettings',
      ),
      skill(
        'debug',
        'Enable debug logging for this session and help diagnose issues.',
        'userSettings',
      ),
      skill(
        'loop',
        'Run a prompt on a fixed interval or dynamically reschedule it, including bare maintenance-mode loops.',
        'projectSettings',
      ),
      skill(
        'simplify',
        'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
        'projectSettings',
      ),
      skill(
        'update-config',
        'Use this skill to configure the Claude Code harness via settings.json. Automated behaviors require hooks.',
        'projectSettings',
      ),
    ],
    80,
  )

  assert.match(output, /^Skills: 5 enabled/)
  assert.match(output, /Name\s+Status\s+Description/)
  assert.doesNotMatch(output, /\bSource\b/)
  assert.doesNotMatch(output, /source: bundled \| trust:/)
  assert.doesNotMatch(output, /\bbundled\b/)
  assert.match(output, /batch\s+enabled\s+Research and plan/)
  assert.match(output, /update-config\s+enabled\s+Configure the Claude Code harness via/)
})

test('omits source column while preserving installed rows', () => {
  const output = formatSkillsListForDisplay(
    [
      skill('docs-writer', 'Writes project documentation.', 'projectSettings'),
      skill('pr-review', 'Reviews pull requests.', 'userSettings'),
      skill('debug', 'Enable debug logging.', 'bundled'),
    ],
    100,
  )

  assert.doesNotMatch(output, /\bSource\b/)
  assert.doesNotMatch(output, /docs-writer\s+enabled\s+project\s+/)
  assert.doesNotMatch(output, /pr-review\s+enabled\s+user\s+/)
  assert.match(output, /docs-writer\s+enabled\s+Writes project documentation\./)
  assert.match(output, /pr-review\s+enabled\s+Reviews pull requests\./)
  assert.doesNotMatch(output, /\bdebug\b/)
  assert.doesNotMatch(output, /Enable debug logging/)
})

test('omits bundled skills from the human table', () => {
  const output = formatSkillsListForDisplay(
    [
      skill('debug', 'Enable debug logging.', 'bundled'),
      skill('docs-writer', 'Writes project documentation.', 'projectSettings'),
    ],
    100,
  )

  assert.match(output, /^Skills: 1 enabled/)
  assert.doesNotMatch(output, /\bdebug\b/)
  assert.doesNotMatch(output, /Enable debug logging/)
  assert.match(output, /docs-writer\s+enabled\s+Writes project documentation\./)
})

test('wraps description continuations under the Description column', () => {
  const output = formatSkillsListForDisplay(
    [
      skill(
        'batch',
        'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.',
        'projectSettings',
      ),
    ],
    45,
  )
  const lines = output.split('\n')
  const header = lines.find(line => line.includes('Description'))
  assert.ok(header)
  const descriptionColumn = header.indexOf('Description')
  const continuation = lines.find(line =>
    line.trim().startsWith('large-scale change'),
  )
  assert.ok(continuation)
  assert.equal(continuation.search(/\S/), descriptionColumn)
})

test('formats empty skills list cleanly', () => {
  assert.equal(
    formatSkillsListForDisplay([], 100),
    'Skills: 0 enabled\n\nNo installed skills found.',
  )
})

test('formats all-bundled skills as empty in the human table', () => {
  assert.equal(
    formatSkillsListForDisplay(
      [skill('debug', 'Enable debug logging.', 'bundled')],
      100,
    ),
    'Skills: 0 enabled\n\nNo installed skills found.',
  )
})

test('formats skills list json as machine-readable metadata', () => {
  const description = 'Full description should remain in JSON. Extra sentence stays.'
  const parsed = JSON.parse(
    formatSkillsListJson([
      skill('debug', description, 'projectSettings'),
      skill('batch', 'Bundled skill should stay hidden.', 'bundled'),
    ]),
  ) as {
    enabledCount: number
    skills: Array<{ name: string; source: string; description: string }>
  }

  assert.equal(parsed.enabledCount, 1)
  assert.equal(parsed.skills[0]?.name, 'debug')
  assert.equal(parsed.skills[0]?.source, 'project')
  assert.equal(parsed.skills[0]?.description, description)
  assert.equal(parsed.skills.length, 1)
  assert.equal(
    parsed.skills.some(item => item.name === 'batch'),
    false,
  )
})

test('formats persisted registry trust metadata for installed skills', () => {
  const installed = skill(
    'official-skill',
    'Installed from the registry.',
    'projectSettings',
    'official',
  )
  const parsed = JSON.parse(formatSkillsListJson([installed])) as {
    skills: Array<{ trust: string }>
  }

  assert.equal(trustLabel(installed), 'official')
  assert.equal(parsed.skills[0]?.trust, 'official')
})

test('formats all-bundled skills as empty json', () => {
  const parsed = JSON.parse(
    formatSkillsListJson([
      skill('batch', 'Research and plan large-scale changes.', 'bundled'),
      skill('debug', 'Enable debug logging.', 'bundled'),
    ]),
  ) as {
    enabledCount: number
    skills: Array<{ name: string }>
  }

  assert.equal(parsed.enabledCount, 0)
  assert.deepEqual(parsed.skills, [])
})

test('explains remove scope mismatch for globally installed skills', () => {
  assert.equal(
    getSkillRemoveNotFoundMessage(
      [skill('pr-review', 'Reviews pull requests.', 'userSettings')],
      'pr-review',
      {},
    ),
    'Skill "pr-review" is installed globally. Use --global to remove it.',
  )
})

test('explains remove scope mismatch for project installed skills', () => {
  assert.equal(
    getSkillRemoveNotFoundMessage(
      [skill('docs-writer', 'Writes documentation.', 'projectSettings')],
      'docs-writer',
      { global: true },
    ),
    'Skill "docs-writer" is installed in this project. Remove it without --global.',
  )
})

test('keeps remove not-found generic for hidden bundled skills', () => {
  assert.equal(
    getSkillRemoveNotFoundMessage(
      [skill('batch', 'Bundled skill.', 'bundled')],
      'batch',
      {},
    ),
    'Skill "batch" not found.',
  )
})

test.serial('installs a local skill directory into project skills by default', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const source = writeSkillDir(join(tempDir, 'source'))
    mkdirSync(cwd, { recursive: true })

    await skillsInstallHandler(source, { projectDir: cwd })

    const installed = readFileSync(
      join(cwd, '.openclaude', 'skills', 'sample-skill', 'SKILL.md'),
      'utf8',
    )
    assert.equal(installed, VALID_SKILL)
  })
})

test.serial('validates existing minimal local skill metadata format', async () => {
  await withTempDir(async tempDir => {
    const skillDir = join(tempDir, 'minimal-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), MINIMAL_EXISTING_FORMAT_SKILL, 'utf8')

    assert.deepEqual(await validateSkillPath(skillDir), [])
  })
})

test.serial('allows benign security guidance about credentials', async () => {
  await withTempDir(async tempDir => {
    const skillDir = join(tempDir, 'security-guidance')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\ndescription: Security guidance.\n---\n# Security Guidance\n\nDo not paste your token into chat.\n`,
      'utf8',
    )

    assert.deepEqual(await validateSkillPath(skillDir), [])
  })
})

test.serial('rejects oversized local text files without reading them fully', async () => {
  await withTempDir(async tempDir => {
    const skillDir = join(tempDir, 'oversized-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      MINIMAL_EXISTING_FORMAT_SKILL,
      'utf8',
    )
    writeFileSync(join(skillDir, 'notes.txt'), 'a'.repeat(1024 * 1024 + 1), 'utf8')

    assert.deepEqual(await validateSkillPath(skillDir), [
      'notes.txt is too large. Skill text files must be at most 1048576 bytes.',
    ])
  })
})

test.serial('installs existing minimal local skill metadata format', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const source = join(tempDir, 'source', 'minimal-skill')
    mkdirSync(source, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), MINIMAL_EXISTING_FORMAT_SKILL, 'utf8')

    await skillsInstallHandler(source, { projectDir: cwd })

    assert.equal(
      readFileSync(
        join(cwd, '.openclaude', 'skills', 'minimal-skill', 'SKILL.md'),
        'utf8',
      ),
      MINIMAL_EXISTING_FORMAT_SKILL,
    )
  })
})

test.serial('preserves namespaced names when installing local skill directories', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const source = join(tempDir, 'source', 'git', 'commit')
    mkdirSync(source, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), NAMESPACED_SKILL, 'utf8')

    await skillsInstallHandler(source, { projectDir: cwd })

    const nestedPath = join(
      cwd,
      '.openclaude',
      'skills',
      'git',
      'commit',
      'SKILL.md',
    )
    const flatPath = join(cwd, '.openclaude', 'skills', 'commit', 'SKILL.md')
    assert.equal(existsSync(flatPath), false)
    assert.equal(readFileSync(nestedPath, 'utf8'), NAMESPACED_SKILL)
  })
})

test.serial('refuses to overwrite installed skills without --force', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const source = writeSkillDir(join(tempDir, 'source'))
    mkdirSync(join(cwd, '.openclaude', 'skills', 'sample-skill'), {
      recursive: true,
    })
    writeFileSync(
      join(cwd, '.openclaude', 'skills', 'sample-skill', 'SKILL.md'),
      'existing skill content',
      'utf8',
    )

    await skillsInstallHandler(source, { projectDir: cwd })

    assert.equal(process.exitCode, 1)
    const installed = readFileSync(
      join(cwd, '.openclaude', 'skills', 'sample-skill', 'SKILL.md'),
      'utf8',
    )
    assert.equal(installed, 'existing skill content')
  })
})

test.serial('installs a registry skill by id from a local registry file', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          repo: 'https://github.com/Twigpine/openclaude-skills',
          path: 'skills/sample-skill/SKILL.md',
          homepage: 'https://github.com/Twigpine/openclaude-skills/tree/main/skills/sample-skill',
          sha256: sha256OfSkillSource(VALID_SKILL),
          min_openclaude_version: '0.1.0',
          tools_required: ['Read', 'Bash'],
        }),
      ]),
      'utf8',
    )

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    const installedMetadata = JSON.parse(
      readFileSync(
        join(cwd, '.openclaude', 'skills', 'sample-skill', 'skill.json'),
        'utf8',
      ),
    ) as {
      trust: string
      sha256: string
      min_openclaude_version: string
      tools_required: string[]
    }
    assert.equal(installedMetadata.trust, 'official')
    assert.equal(installedMetadata.sha256, sha256OfSkillSource(VALID_SKILL))
    assert.equal(installedMetadata.min_openclaude_version, '0.1.0')
    assert.deepEqual(installedMetadata.tools_required, ['Read', 'Bash'])
  })
})

test.serial('resolves relative registry skill sources from the registry file', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const registryDir = join(tempDir, 'registry')
    const sourceDir = writeSkillDir(join(registryDir, 'skills'))
    const registryPath = join(registryDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          source: 'skills/sample-skill/SKILL.md',
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 0)
    assert.equal(
      readFileSync(
        join(cwd, '.openclaude', 'skills', 'sample-skill', 'SKILL.md'),
        'utf8',
      ),
      VALID_SKILL,
    )
  })
})

test.serial('rejects registry skills without a sha256 pin', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir),
      ]),
      'utf8',
    )

    const stagedBefore = stagedInstallTempDirs()
    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
    assertNoNewStagedInstallDirs(stagedBefore)
  })
})

test.serial('rejects registry skills that require a newer OpenClaude version', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
          min_openclaude_version: '999.0.0',
        }),
      ]),
      'utf8',
    )

    const stagedBefore = stagedInstallTempDirs()
    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
    assertNoNewStagedInstallDirs(stagedBefore)
  })
})

test.serial('rejects registry skills revoked by id and version', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    writeFileSync(
      join(tempDir, 'revocations.json'),
      JSON.stringify([
        {
          id: 'gitlawb/sample-skill',
          version: '0.1.0',
          sha256: sha256OfSkillSource(VALID_SKILL),
          reason: 'compromised release',
        },
      ]),
      'utf8',
    )

    const stagedBefore = stagedInstallTempDirs()
    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
    assertNoNewStagedInstallDirs(stagedBefore)
  })
})

test.serial('rejects registry skills revoked by digest alone', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    writeFileSync(
      join(tempDir, 'revocations.json'),
      JSON.stringify([{ sha256: sha256OfSkillSource(VALID_SKILL) }]),
      'utf8',
    )

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('installs registry skills when a revocation targets another version', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    writeFileSync(
      join(tempDir, 'revocations.json'),
      JSON.stringify([{ id: 'gitlawb/sample-skill', version: '0.0.9' }]),
      'utf8',
    )

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(
      existsSync(join(cwd, '.openclaude', 'skills', 'sample-skill', 'SKILL.md')),
      true,
    )
  })
})

test.serial('rejects registry installs when revocations.json is malformed', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    writeFileSync(join(tempDir, 'revocations.json'), '{not json', 'utf8')

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('OPENCLAUDE_SKILLS_REVOCATIONS_URL takes precedence over the registry sibling', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    // The sibling list revokes nothing; the override list revokes the skill.
    writeFileSync(join(tempDir, 'revocations.json'), '[]', 'utf8')
    const overridePath = join(tempDir, 'override-revocations.json')
    writeFileSync(
      overridePath,
      JSON.stringify([{ id: 'gitlawb/sample-skill' }]),
      'utf8',
    )

    // Set inside the fixture, which cleared any inherited value on entry and
    // restores it on exit.
    process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL = overridePath
    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('an inherited OPENCLAUDE_SKILLS_REVOCATIONS_URL cannot redirect sibling-list fixtures', async () => {
  // Simulate a host process (developer shell, CI runner) that already
  // configures the override before the suite runs. Production gives that
  // variable precedence, so without fixture isolation every sibling-list
  // test would silently read this absent path instead of its own fixture.
  const hostValue = process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL
  const inheritedAbsentPath = join(tmpdir(), 'openclaude-revocations-never-written.json')
  process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL = inheritedAbsentPath
  try {
    await withTempDir(async tempDir => {
      assert.equal(process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL, undefined)

      const cwd = join(tempDir, 'project')
      const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
      const registryPath = join(tempDir, 'registry.json')
      mkdirSync(cwd, { recursive: true })
      writeFileSync(
        registryPath,
        JSON.stringify([
          buildRegistryEntry(sourceDir, {
            sha256: sha256OfSkillSource(VALID_SKILL),
          }),
        ]),
        'utf8',
      )
      writeFileSync(
        join(tempDir, 'revocations.json'),
        JSON.stringify([{ id: 'gitlawb/sample-skill' }]),
        'utf8',
      )

      await skillsInstallHandler('sample-skill', {
        projectDir: cwd,
        registry: registryPath,
      })

      // The sibling list revoked the skill: the inherited override was not read.
      assert.equal(process.exitCode, 1)
      assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
    })
    // The fixture hands the host's value back once it is done.
    assert.equal(process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL, inheritedAbsentPath)
  } finally {
    if (hostValue === undefined) {
      delete process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL
    } else {
      process.env.OPENCLAUDE_SKILLS_REVOCATIONS_URL = hostValue
    }
  }
})

test.serial('rejects registry installs when a revocation entry is invalid', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    writeFileSync(
      join(tempDir, 'revocations.json'),
      JSON.stringify([{ id: 'gitlawb/sample-skill', sha256: 'not-a-digest' }]),
      'utf8',
    )

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('rejects registry installs when revocations.json is not an array', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    writeFileSync(join(tempDir, 'revocations.json'), '{}', 'utf8')

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('fails closed when the revocation list exists but cannot be read', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )
    // A directory at the revocations path reads as EISDIR, not ENOENT:
    // unreadable is not the same as absent, and must block the install.
    mkdirSync(join(tempDir, 'revocations.json'))

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('installs a non-revoked registry skill when the remote revocation list is HTTP 404', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    mkdirSync(cwd, { recursive: true })
    const requested: string[] = []

    await withMockedFetch(
      remoteRegistryFetch(() => new Response('not found', { status: 404 }), requested),
      () =>
        skillsInstallHandler('sample-skill', {
          projectDir: cwd,
          registry: REMOTE_REGISTRY_URL,
        }),
    )

    // A registry that publishes no list at all is a confirmed absence: it
    // revokes nothing, and the sha256 pin still governs the install.
    assert.ok(requested.includes(REMOTE_REVOCATIONS_URL))
    assert.equal(process.exitCode, 0)
    assert.equal(
      readFileSync(
        join(cwd, '.openclaude', 'skills', 'sample-skill', 'SKILL.md'),
        'utf8',
      ),
      VALID_SKILL,
    )
  })
})

test.serial('fails closed when the remote revocation list is HTTP 500', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    mkdirSync(cwd, { recursive: true })
    const requested: string[] = []

    const stagedBefore = stagedInstallTempDirs()
    await withMockedFetch(
      remoteRegistryFetch(() => new Response('upstream error', { status: 500 }), requested),
      () =>
        skillsInstallHandler('sample-skill', {
          projectDir: cwd,
          registry: REMOTE_REGISTRY_URL,
        }),
    )

    // A list that exists but cannot be served is not an empty list.
    assert.ok(requested.includes(REMOTE_REVOCATIONS_URL))
    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
    assertNoNewStagedInstallDirs(stagedBefore)
  })
})

test.serial('fails closed when the remote revocation list is unreachable', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    mkdirSync(cwd, { recursive: true })
    const requested: string[] = []

    const stagedBefore = stagedInstallTempDirs()
    await withMockedFetch(
      remoteRegistryFetch(() => {
        throw new TypeError('fetch failed')
      }, requested),
      () =>
        skillsInstallHandler('sample-skill', {
          projectDir: cwd,
          registry: REMOTE_REGISTRY_URL,
        }),
    )

    assert.ok(requested.includes(REMOTE_REVOCATIONS_URL))
    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
    assertNoNewStagedInstallDirs(stagedBefore)
  })
})

test.serial('rejects path-like skill names before installing raw markdown', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = join(tempDir, 'source')
    const sourceFile = join(sourceDir, 'SKILL.md')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(sourceFile, PATH_TRAVERSAL_SKILL, 'utf8')

    await skillsInstallHandler(sourceFile, { projectDir: cwd })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('rejects registry names that would escape the install root', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const sourceDir = writeSkillDir(join(tempDir, 'registry-source'))
    const registryPath = join(tempDir, 'registry.json')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify([
        buildRegistryEntry(sourceDir, {
          name: '../escape',
          sha256: sha256OfSkillSource(VALID_SKILL),
        }),
      ]),
      'utf8',
    )

    await skillsInstallHandler('sample-skill', {
      projectDir: cwd,
      registry: registryPath,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
  })
})

test.serial('rejects direct HTTP URL installs without a sha256 pin', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    mkdirSync(cwd, { recursive: true })

    const stagedBefore = stagedInstallTempDirs()
    await skillsInstallHandler('https://example.com/sample-skill.md', {
      projectDir: cwd,
    })

    assert.equal(process.exitCode, 1)
    assert.equal(existsSync(join(cwd, '.openclaude', 'skills')), false)
    assertNoNewStagedInstallDirs(stagedBefore)
  })
})

test.serial('cleans staged temp roots when markdown staging fails', async () => {
  await withTempDir(async tempDir => {
    const cwd = join(tempDir, 'project')
    const source = join(tempDir, 'source', 'SKILL.md')
    const oversizedName = 'a'.repeat(300)
    mkdirSync(join(tempDir, 'source'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      source,
      `---\nname: ${oversizedName}\ndescription: oversized name\n---\n# Oversized\n`,
      'utf8',
    )

    const stagedBefore = stagedInstallTempDirs()
    await skillsInstallHandler(source, { projectDir: cwd })

    assert.equal(process.exitCode, 1)
    assertNoNewStagedInstallDirs(stagedBefore)
  })
})

test.serial('removes only the targeted project skill directory', async () => {
  await acquireSharedMutationLock('skillsRemoveHandler')
  const originalFs = getFsImplementation()
  try {
    setFsImplementation({
      ...originalFs,
      existsSync,
      stat: async path => statSync(path),
      readdir: async path => readdirSync(path, { withFileTypes: true }),
      readFile: async (path, options) => readFileSync(path, options),
      rm: async (path, options) => {
        rmSync(path, options)
      },
    })
    await withTempDir(async tempDir => {
      const cwd = join(tempDir, 'project')
      const skillsRoot = join(cwd, '.openclaude', 'skills')
      const targetName = 'remove-target-skill'
      const target = join(skillsRoot, targetName)
      const sibling = join(skillsRoot, 'sibling-skill')
      const originalSettingsState = enableUserAndProjectSettingSources()
      mkdirSync(target, { recursive: true })
      mkdirSync(sibling, { recursive: true })
      writeFileSync(
        join(target, 'SKILL.md'),
        VALID_SKILL.replace('sample-skill', targetName),
        'utf8',
      )
      writeFileSync(
        join(sibling, 'SKILL.md'),
        VALID_SKILL.replace('sample-skill', 'sibling-skill'),
        'utf8',
      )

      clearCommandsCache()
      try {
        process.exitCode = 0
        await skillsRemoveHandler(targetName, { projectDir: cwd })
        assert.equal(process.exitCode, 0)
      } finally {
        restoreSettingState(originalSettingsState)
        clearCommandsCache()
      }

      assert.equal(existsSync(target), false)
      assert.equal(existsSync(join(sibling, 'SKILL.md')), true)
    })
  } finally {
    setFsImplementation(originalFs)
    releaseSharedMutationLock()
  }
})

test.serial('does not remove legacy project skills from .claude directories', async () => {
  await acquireSharedMutationLock('skillsRemoveHandler')
  const originalFs = getFsImplementation()
  try {
    setFsImplementation({
      ...originalFs,
      existsSync,
      stat: async path => statSync(path),
      readdir: async path => readdirSync(path, { withFileTypes: true }),
      readFile: async (path, options) => readFileSync(path, options),
      rm: async (path, options) => {
        rmSync(path, options)
      },
    })
    await withTempDir(async tempDir => {
      const cwd = join(tempDir, 'project')
      const targetName = 'legacy-remove-skill'
      const target = join(cwd, '.claude', 'skills', targetName)
      const originalSettingsState = enableUserAndProjectSettingSources()
      mkdirSync(target, { recursive: true })
      writeFileSync(
        join(target, 'SKILL.md'),
        VALID_SKILL.replace('sample-skill', targetName),
        'utf8',
      )

      clearCommandsCache()
      try {
        process.exitCode = 0
        await skillsRemoveHandler(targetName, { projectDir: cwd })
        assert.equal(process.exitCode, 1)
      } finally {
        restoreSettingState(originalSettingsState)
        clearCommandsCache()
      }

      assert.equal(existsSync(target), true)
    })
  } finally {
    setFsImplementation(originalFs)
    releaseSharedMutationLock()
  }
})

test.serial('routes install and validation file access through the fs abstraction', async () => {
  await acquireSharedMutationLock('skillsInstallHandler')
  const originalFs = getFsImplementation()
  let statCalls = 0
  let readFileCalls = 0
  let writeFileCalls = 0
  try {
    setFsImplementation({
      ...originalFs,
      stat: async path => {
        statCalls += 1
        return originalFs.stat(path)
      },
      readFile: async (path, options) => {
        readFileCalls += 1
        return originalFs.readFile(path, options)
      },
      writeFile: async (path, data, options) => {
        writeFileCalls += 1
        return originalFs.writeFile(path, data, options)
      },
    })
    await withTempDir(async tempDir => {
      const cwd = join(tempDir, 'project')
      const source = writeSkillDir(join(tempDir, 'source'))
      const sourceFile = join(source, 'SKILL.md')
      mkdirSync(cwd, { recursive: true })

      await skillsInstallHandler(sourceFile, { projectDir: cwd })
      assert.equal(process.exitCode, 0)
      assert.deepEqual(await validateSkillPath(source), [])
    })

    assert.ok(statCalls > 0)
    assert.ok(readFileCalls > 0)
    assert.ok(writeFileCalls > 0)
  } finally {
    setFsImplementation(originalFs)
    releaseSharedMutationLock()
  }
})

test.serial('does not remove skills from --add-dir directories', async () => {
  await acquireSharedMutationLock('skillsRemoveHandler')
  const originalFs = getFsImplementation()
  try {
    setFsImplementation({
      ...originalFs,
      existsSync,
      stat: async path => statSync(path),
      readdir: async path => readdirSync(path, { withFileTypes: true }),
      readFile: async (path, options) => readFileSync(path, options),
      rm: async (path, options) => {
        rmSync(path, options)
      },
    })
    await withTempDir(async tempDir => {
      const cwd = join(tempDir, 'project')
      const addDir = join(tempDir, 'additional-project')
      const targetName = 'add-dir-skill'
      const target = join(addDir, '.openclaude', 'skills', targetName)
      const originalSettingsState = enableUserAndProjectSettingSources()
      mkdirSync(cwd, { recursive: true })
      mkdirSync(target, { recursive: true })
      writeFileSync(
        join(target, 'SKILL.md'),
        VALID_SKILL.replace('sample-skill', targetName),
        'utf8',
      )
      setAdditionalDirectoriesForClaudeMd([addDir])

      clearCommandsCache()
      try {
        process.exitCode = 0
        await skillsRemoveHandler(targetName, { projectDir: cwd })
        assert.equal(process.exitCode, 1)
      } finally {
        setAdditionalDirectoriesForClaudeMd([])
        restoreSettingState(originalSettingsState)
        clearCommandsCache()
      }

      assert.equal(existsSync(join(target, 'SKILL.md')), true)
    })
  } finally {
    setFsImplementation(originalFs)
    releaseSharedMutationLock()
  }
})
