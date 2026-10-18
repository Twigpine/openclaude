// @ts-nocheck
import { spawn } from 'node:child_process'
import {
  resolveCodexApiCredentials,
} from '../src/services/api/providerConfig.js'
import {
  normalizeRecommendationGoal,
  recommendOllamaModel,
} from '../src/utils/providerRecommendation.ts'
import {
  buildLaunchEnv,
  loadProfileFile,
  resolveOpenAICredentialEnvState,
  selectAutoProfile,
  type ProfileFile,
  type ProviderProfile,
} from '../src/utils/providerProfile.ts'
import {
  getRouteCredentialValue,
  resolveActiveRouteIdFromEnv,
} from '../src/integrations/routeMetadata.ts'
import {
  getAtomicChatChatBaseUrl,
  getOllamaChatBaseUrl,
  hasLocalAtomicChat,
  hasLocalOllama,
  listAtomicChatModels,
  listOllamaModels,
} from './provider-discovery.ts'

type LaunchOptions = {
  requestedProfile: ProviderProfile | 'auto' | null
  passthroughArgs: string[]
  fast: boolean
  goal: ReturnType<typeof normalizeRecommendationGoal>
}

function parseLaunchOptions(argv: string[]): LaunchOptions {
  let requestedProfile: ProviderProfile | 'auto' | null = 'auto'
  const passthroughArgs: string[] = []
  let fast = false
  let goal = normalizeRecommendationGoal(process.env.OPENCLAUDE_PROFILE_GOAL)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const lower = arg.toLowerCase()
    if (lower === '--fast') {
      fast = true
      continue
    }

    if (lower === '--goal') {
      goal = normalizeRecommendationGoal(argv[i + 1] ?? null)
      i++
      continue
    }

    if ((lower === 'auto' || lower === 'openai' || lower === 'ollama' || lower === 'codex' || lower === 'gemini' || lower ==='mistral' || lower === 'atomic-chat') && requestedProfile === 'auto') {
      requestedProfile = lower as ProviderProfile | 'auto'
      continue
    }

    if (arg.startsWith('--')) {
      passthroughArgs.push(arg)
      continue
    }

    if (requestedProfile === 'auto') {
      requestedProfile = null
      break
    }

    passthroughArgs.push(arg)
  }

  return {
    requestedProfile,
    passthroughArgs,
    fast,
    goal,
  }
}

function loadPersistedProfile(): ProfileFile | null {
  return loadProfileFile()
}

async function resolveOllamaDefaultModel(
  goal: ReturnType<typeof normalizeRecommendationGoal>,
): Promise<string | null> {
  const models = await listOllamaModels()
  const recommended = recommendOllamaModel(models, goal)
  return recommended?.name ?? null
}

async function resolveAtomicChatDefaultModel(): Promise<string | null> {
  const models = await listAtomicChatModels()
  return models[0] ?? null
}

function runCommand(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  return runProcess(command, [], env)
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    })

    child.on('close', code => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

function applyFastFlags(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  env.CLAUDE_CODE_SIMPLE ??= '1'
  env.CLAUDE_CODE_DISABLE_THINKING ??= '1'
  env.DISABLE_INTERLEAVED_THINKING ??= '1'
  env.DISABLE_AUTO_COMPACT ??= '1'
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ??= '1'
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ??= '1'
  return env
}

function printSummary(profile: ProviderProfile): void {
  console.log(`Launching profile: ${profile}`)
  if (profile === 'gemini') {
    console.log('Using configured Gemini provider settings.')
  } else if (profile === 'mistral') {
    console.log('Using configured Mistral provider settings.')
  } else if (profile === 'codex') {
    console.log('Using configured Codex/OpenAI-compatible provider settings.')
  } else if (profile === 'atomic-chat') {
    console.log('Using configured Atomic Chat provider settings.')
  } else if (profile === 'ollama') {
    console.log('Using configured Ollama provider settings.')
  } else {
    console.log('Using configured OpenAI-compatible provider settings.')
  }
}

function hasUsableGeminiLaunchAuth(env: NodeJS.ProcessEnv): boolean {
  const authMode = env.GEMINI_AUTH_MODE?.trim().toLowerCase()
  if (authMode === 'adc') {
    return true
  }
  if (authMode === 'access-token') {
    return Boolean(env.GEMINI_ACCESS_TOKEN?.trim())
  }
  return Boolean(
    env.GEMINI_API_KEY?.trim() ||
      env.GOOGLE_API_KEY?.trim() ||
      env.GEMINI_ACCESS_TOKEN?.trim(),
  )
}

export function hasUsableOpenAILaunchCredential(
  env: NodeJS.ProcessEnv,
): boolean {
  return getOpenAILaunchCredentialError(env) === null
}

export function getOpenAILaunchCredentialError(
  env: NodeJS.ProcessEnv,
): string | null {
  if (resolveActiveRouteIdFromEnv(env) === 'commandcode') {
    if (getRouteCredentialValue('commandcode', env)) {
      return null
    }
    return 'CMD_API_KEY is required for the Command Code route (fallbacks: COMMANDCODE_API_KEY or COMMAND_CODE_API_KEY) and cannot include placeholder values such as SUA_CHAVE. Set one of those environment variables, rerun the launcher, then use /provider to save the Command Code profile.'
  }
  if (resolveOpenAICredentialEnvState(env).configured) {
    return null
  }
  return 'OPENAI_API_KEYS or OPENAI_API_KEY is required for openai profile and cannot include SUA_CHAVE. Run: bun run profile:init -- --provider openai --api-key <key>'
}

async function main(): Promise<void> {
  const options = parseLaunchOptions(process.argv.slice(2))
  const requestedProfile = options.requestedProfile
  if (!requestedProfile) {
    console.error('Usage: bun run scripts/provider-launch.ts [openai|ollama|codex|gemini|mistral|atomic-chat|mistral|auto] [--fast] [--goal <latency|balanced|coding>] [-- <cli args>]')
    process.exit(1)
  }

  const persisted = loadPersistedProfile()
  let profile: ProviderProfile
  let resolvedOllamaModel: string | null = null

  if (requestedProfile === 'auto') {
    if (persisted) {
      profile = persisted.profile
    } else if (await hasLocalOllama()) {
      resolvedOllamaModel = await resolveOllamaDefaultModel(options.goal)
      profile = selectAutoProfile(resolvedOllamaModel)
    } else {
      profile = 'openai'
    }
  } else {
    profile = requestedProfile
  }

  if (
    profile === 'ollama' &&
    (persisted?.profile !== 'ollama' || !persisted?.env?.OPENAI_MODEL)
  ) {
    resolvedOllamaModel ??= await resolveOllamaDefaultModel(options.goal)
    if (!resolvedOllamaModel) {
      console.error('No viable Ollama chat model was discovered. Pull a chat model first or save one with `bun run profile:init -- --provider ollama --model <model>`.')
      process.exit(1)
    }
  }

  let resolvedAtomicChatModel: string | null = null
  if (
    profile === 'atomic-chat' &&
    (persisted?.profile !== 'atomic-chat' || !persisted?.env?.OPENAI_MODEL)
  ) {
    if (!(await hasLocalAtomicChat())) {
      console.error('Atomic Chat is not running (could not connect to 127.0.0.1:1337).\n  Download from https://atomic.chat/ and launch the application.')
      process.exit(1)
    }
    resolvedAtomicChatModel = await resolveAtomicChatDefaultModel()
    if (!resolvedAtomicChatModel) {
      console.error('Atomic Chat is running but no model is loaded. Open Atomic Chat and download or start a model first.')
      process.exit(1)
    }
  }

  const env = await buildLaunchEnv({
    profile,
    persisted,
    goal: options.goal,
    getOllamaChatBaseUrl,
    resolveOllamaDefaultModel: async () => resolvedOllamaModel || 'llama3.1:8b',
    getAtomicChatChatBaseUrl,
    resolveAtomicChatDefaultModel: async () => resolvedAtomicChatModel,
  })
  if (options.fast) {
    applyFastFlags(env)
  }

  if (profile === 'gemini' && !hasUsableGeminiLaunchAuth(env)) {
    console.error('Gemini credentials are required for gemini profile. Use `bun run profile:init -- --provider gemini --api-key <key>`, save an access-token/ADC Gemini profile with `/provider`, or set GEMINI_API_KEY/GOOGLE_API_KEY/GEMINI_ACCESS_TOKEN.')
    process.exit(1)
  }

  if (profile === 'mistral' && !env.MISTRAL_API_KEY) {
    console.error('MISTRAL_API_KEY is required for mistral profile. Run: bun run profile:init -- --provider mistral --api-key <key>')
    process.exit(1)
  }

  const openAICredentialError =
    profile === 'openai' ? getOpenAILaunchCredentialError(env) : null
  if (openAICredentialError) {
    console.error(openAICredentialError)
    process.exit(1)
  }

  if (profile === 'codex') {
    const credentials = resolveCodexApiCredentials(env)
    if (!credentials.apiKey) {
      const authHint = credentials.authPath
        ? ` or make sure ${credentials.authPath} exists`
        : ''
      console.error(`CODEX_API_KEY is required for codex profile${authHint}. Run: bun run profile:init -- --provider codex --model codexplan`)
      process.exit(1)
    }

    if (!credentials.accountId) {
      console.error('CHATGPT_ACCOUNT_ID is required for codex profile. Set CHATGPT_ACCOUNT_ID/CODEX_ACCOUNT_ID or use an auth.json that includes it.')
      process.exit(1)
    }
  }

  printSummary(profile)

  const doctorCode = await runProcess('bun', ['run', 'scripts/system-check.ts'], env)
  if (doctorCode !== 0) {
    console.error('Runtime doctor failed. Fix configuration before launching.')
    process.exit(doctorCode)
  }

  const buildCode = await runProcess('bun', ['run', 'build'], env)
  if (buildCode !== 0) {
    process.exit(buildCode)
  }

  const devCode = await runProcess('node', ['bin/openclaude', ...options.passthroughArgs], env)
  process.exit(devCode)
}

if (import.meta.main) {
  await main()
}

export {}
