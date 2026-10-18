import { setAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'

type SkillsCliOptions = {
  additionalDirectories: string[]
  force?: boolean
  global?: boolean
  help?: boolean
  json?: boolean
  lockfile?: string
  policy?: string
  registry?: string
  sha256?: string
}

const TRAILING_GLOBAL_BOOLEAN_FLAGS = new Set([
  '--bare',
  '--debug',
  '--debug-to-stderr',
  '--yolo',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--disable-slash-commands',
  '--enable-auth-status',
  '--fork-session',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '--init',
  '--init-only',
  '--maintenance',
  '--mcp-debug',
  '--no-chrome',
  '--no-session-persistence',
  '--replay-user-messages',
  '--strict-mcp-config',
  '--verbose',
])

const TRAILING_GLOBAL_VALUE_FLAGS = new Set([
  '--agent',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--debug-file',
  '--effort',
  '--fallback-model',
  '--heartbeat',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-thinking-tokens',
  '--max-turns',
  '--model',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--provider',
  '--resume-session-at',
  '--session-id',
  '--settings',
  '--setting-sources',
  '--system-prompt',
  '--system-prompt-file',
  '--thinking',
  '--workload',
  '-n',
  '--name',
])

const TRAILING_GLOBAL_MULTI_VALUE_FLAGS = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--betas',
  '--disallowedTools',
  '--disallowed-tools',
  '--file',
  '--mcp-config',
  '--plugin-dir',
  '--provider-env-file',
  '--tools',
])

const SKILLS_HELP = `Usage: openclaude skills <command> [options]

Commands:
  list [--json]                    List installed skills
  show <name>                      Show details for an installed skill
  validate <path>                  Validate a local skill directory
  install <idOrUrlOrPath> [options] Install a skill (--sha256 required for HTTP(S) URLs)
  remove <name> [--global]         Remove an installed skill
  verify [options]                 Check installed skills for revocations and, with eyebrow, drift

Verify options:
  --registry <urlOrPath>           Registry whose revocations.json to read
  --lockfile <path>                eyebrow lockfile (default: eyebrowlock.json)
  --policy <path>                  eyebrow policy file; adds --ci to the eyebrow run`

function parseSkillsCliArgs(args: string[]): {
  options: SkillsCliOptions
  positionals: string[]
  error?: string
} {
  const options: SkillsCliOptions = { additionalDirectories: [] }
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--global') {
      options.global = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--registry') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        return { options, positionals, error: '--registry requires a value.' }
      }
      options.registry = value
      index += 1
    } else if (arg === '--sha256') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        return { options, positionals, error: '--sha256 requires a value.' }
      }
      options.sha256 = value
      index += 1
    } else if (arg === '--lockfile') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        return { options, positionals, error: '--lockfile requires a value.' }
      }
      options.lockfile = value
      index += 1
    } else if (arg === '--policy') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        return { options, positionals, error: '--policy requires a value.' }
      }
      options.policy = value
      index += 1
    } else if (arg?.startsWith('--registry=')) {
      const value = arg.slice('--registry='.length)
      if (!value) {
        return { options, positionals, error: '--registry requires a value.' }
      }
      options.registry = value
    } else if (arg?.startsWith('--sha256=')) {
      const value = arg.slice('--sha256='.length)
      if (!value) {
        return { options, positionals, error: '--sha256 requires a value.' }
      }
      options.sha256 = value
    } else if (arg?.startsWith('--lockfile=')) {
      const value = arg.slice('--lockfile='.length)
      if (!value) {
        return { options, positionals, error: '--lockfile requires a value.' }
      }
      options.lockfile = value
    } else if (arg?.startsWith('--policy=')) {
      const value = arg.slice('--policy='.length)
      if (!value) {
        return { options, positionals, error: '--policy requires a value.' }
      }
      options.policy = value
    } else if (TRAILING_GLOBAL_BOOLEAN_FLAGS.has(arg)) {
      continue
    } else if (TRAILING_GLOBAL_VALUE_FLAGS.has(arg)) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        return { options, positionals, error: `${arg} requires a value.` }
      }
      index += 1
    } else if (
      Array.from(TRAILING_GLOBAL_VALUE_FLAGS).some(flag =>
        arg?.startsWith(`${flag}=`),
      )
    ) {
      continue
    } else if (TRAILING_GLOBAL_MULTI_VALUE_FLAGS.has(arg)) {
      let consumed = false
      while (args[index + 1] && !args[index + 1]!.startsWith('-')) {
        index += 1
        consumed = true
        if (arg === '--add-dir') {
          options.additionalDirectories.push(args[index]!)
        }
      }
      if (!consumed) {
        return { options, positionals, error: `${arg} requires a value.` }
      }
    } else {
      const multiValueEqualsFlag = Array.from(TRAILING_GLOBAL_MULTI_VALUE_FLAGS)
        .find(flag => arg?.startsWith(`${flag}=`))
      if (multiValueEqualsFlag) {
        const value = arg.slice(`${multiValueEqualsFlag}=`.length)
        if (!value) {
          return {
            options,
            positionals,
            error: `${multiValueEqualsFlag} requires a value.`,
          }
        }
        if (multiValueEqualsFlag === '--add-dir') {
          options.additionalDirectories.push(value)
        }
        continue
      }
      if (!arg?.startsWith('--')) {
        positionals.push(arg)
        continue
      }
      return { options, positionals, error: `Unknown skills option: ${arg}` }
    }
  }

  return { options, positionals }
}

/**
 * The skills subcommands skip the session startup that registers bundled
 * skills and built-in plugins. Register them so skills read from other
 * agents' homes resolve against them the way a session does: a sibling-home
 * skill that shares a bundled skill's name is dropped, not listed.
 */
async function registerBuiltinSkillSources(): Promise<void> {
  const [{ getBundledSkills }, { initBundledSkills }, { initBuiltinPlugins }] =
    await Promise.all([
      import('../../skills/bundledSkills.js'),
      import('../../skills/bundled/index.js'),
      import('../../plugins/bundled/index.js'),
    ])
  if (getBundledSkills().length > 0) return
  initBuiltinPlugins()
  initBundledSkills()
}

export async function runSkillsCliAction(
  action: () => Promise<void>,
): Promise<void> {
  try {
    await registerBuiltinSkillSources()
    await action()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export async function runSkillsCli(args: string[]): Promise<void> {
  const subcommand = args[1] ?? 'list'
  const { options, positionals, error } = parseSkillsCliArgs(args.slice(2))
  if (error) {
    console.error(error)
    process.exit(1)
  }
  if (subcommand === '--help' || subcommand === '-h' || options.help) {
    console.log(SKILLS_HELP)
    process.exit(0)
  }
  if (options.additionalDirectories.length > 0) {
    setAdditionalDirectoriesForClaudeMd(options.additionalDirectories)
  }

  const {
    skillsInstallHandler,
    skillsListHandler,
    skillsRemoveHandler,
    skillsShowHandler,
    skillsValidateHandler,
    skillsVerifyHandler,
  } = await import('./skills.js')

  await runSkillsCliAction(async () => {
    switch (subcommand) {
      case 'list':
        await skillsListHandler({ json: options.json })
        break
      case 'show': {
        const name = positionals[0]
        if (!name) {
          console.error('Skill name is required.')
          process.exit(1)
        }
        await skillsShowHandler(name)
        break
      }
      case 'validate': {
        const path = positionals[0]
        if (!path) {
          console.error('Skill path is required.')
          process.exit(1)
        }
        await skillsValidateHandler(path)
        break
      }
      case 'install': {
        const idOrUrlOrPath = positionals[0]
        if (!idOrUrlOrPath) {
          console.error('Skill ID, URL, or path is required.')
          process.exit(1)
        }
        await skillsInstallHandler(idOrUrlOrPath, options)
        break
      }
      case 'remove': {
        const name = positionals[0]
        if (!name) {
          console.error('Skill name is required.')
          process.exit(1)
        }
        await skillsRemoveHandler(name, { global: options.global })
        break
      }
      case 'verify':
        await skillsVerifyHandler({
          registry: options.registry,
          lockfile: options.lockfile,
          policy: options.policy,
        })
        break
      default:
        console.error(`Unknown skills command: ${subcommand}`)
        process.exit(1)
    }
  })

  process.exit(process.exitCode ?? 0)
}
