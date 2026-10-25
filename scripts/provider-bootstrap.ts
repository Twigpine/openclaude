// @ts-nocheck
import {
  resolveCodexApiCredentials,
} from '../src/services/api/providerConfig.js'
import {
  getGoalDefaultOpenAIModel,
  normalizeRecommendationGoal,
  recommendOllamaModel,
} from '../src/utils/providerRecommendation.ts'
import {
  buildAtomicChatProfileEnv,
  buildCodexProfileEnv,
  buildGeminiProfileEnv,
  buildMistralProfileEnv,
  buildOllamaProfileEnv,
  buildOpenAIProfileEnv,
  createProfileFile,
  saveProfileFile,
  selectAutoProfile,
  type ProfileFile,
  type ProviderProfile,
} from '../src/utils/providerProfile.ts'
import {
  getAtomicChatChatBaseUrl,
  getOllamaChatBaseUrl,
  hasLocalAtomicChat,
  hasLocalOllama,
  listAtomicChatModels,
  listOllamaModels,
} from './provider-discovery.ts'

function parseArg(name: string): string | null {
  const args = process.argv.slice(2)
  const idx = args.indexOf(name)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

function parseProviderArg(): ProviderProfile | 'auto' {
  const p = parseArg('--provider')?.toLowerCase()
  if (p === 'openai' || p === 'ollama' || p === 'codex' || p === 'gemini' || p === 'mistral' || p === 'atomic-chat') return p
  return 'auto'
}

async function resolveOllamaModel(
  argModel: string | null,
  argBaseUrl: string | null,
  goal: ReturnType<typeof normalizeRecommendationGoal>,
): Promise<string | null> {
  if (argModel) return argModel

  const discovered = await listOllamaModels(argBaseUrl || undefined)
  const recommended = recommendOllamaModel(discovered, goal)
  return recommended?.name ?? null
}

async function main(): Promise<void> {
  const provider = parseProviderArg()
  const argModel = parseArg('--model')
  const argBaseUrl = parseArg('--base-url')
  const argApiKey = parseArg('--api-key')
  const goal = normalizeRecommendationGoal(
    parseArg('--goal') || process.env.OPENCLAUDE_PROFILE_GOAL,
  )

  let selected: ProviderProfile
  let resolvedOllamaModel: string | null = null
  if (provider === 'auto') {
    if (await hasLocalOllama(argBaseUrl || undefined)) {
      resolvedOllamaModel = await resolveOllamaModel(argModel, argBaseUrl, goal)
      selected = selectAutoProfile(resolvedOllamaModel)
    } else {
      selected = 'openai'
    }
  } else {
    selected = provider
  }

  let env: ProfileFile['env']
  if (selected === 'gemini') {
    const builtEnv = buildGeminiProfileEnv({
      model: argModel || null,
      baseUrl: argBaseUrl || null,
      apiKey: argApiKey || null,
      processEnv: process.env,
    })

    if (!builtEnv) {
      console.error('Gemini profile requires an API key. Use --api-key or set GEMINI_API_KEY.')
      console.error('Get a free key at: https://aistudio.google.com/apikey')
      process.exit(1)
    }

    env = builtEnv
  } else if (selected === 'mistral') {
    const builtEnv = buildMistralProfileEnv({
      model: argModel || null,
      baseUrl: argBaseUrl || null,
      apiKey: argApiKey || null,
      processEnv: process.env,
    })

    if (!builtEnv) {
      console.error('Mistral profile requires an API key. Use --api-key or set MISTRAL_API_KEY.')
      console.error('Get a free key at: https://admin.mistral.ai/organization/api-keys')
      process.exit(1)
    }

    env = builtEnv
  } else if (selected === 'ollama') {
    resolvedOllamaModel ??= await resolveOllamaModel(argModel, argBaseUrl, goal)
    if (!resolvedOllamaModel) {
      console.error('No viable Ollama chat model was discovered. Pull a chat model first or pass --model explicitly.')
      process.exit(1)
    }

    env = buildOllamaProfileEnv(
      resolvedOllamaModel,
      {
        baseUrl: argBaseUrl,
        getOllamaChatBaseUrl,
      },
    )
  } else if (selected === 'atomic-chat') {
    const model = argModel || (await listAtomicChatModels(argBaseUrl || undefined))[0]
    if (!model) {
      if (!(await hasLocalAtomicChat(argBaseUrl || undefined))) {
        console.error('Atomic Chat is not running (could not connect to 127.0.0.1:1337).\n  Download from https://atomic.chat/ and launch the application.')
      } else {
        console.error('Atomic Chat is running but no model is loaded. Open Atomic Chat and download or start a model first.')
      }
      process.exit(1)
    }

    env = buildAtomicChatProfileEnv(model, {
      baseUrl: argBaseUrl,
      getAtomicChatChatBaseUrl,
    })
  } else if (selected === 'codex') {
    const builtEnv = buildCodexProfileEnv({
      model: argModel,
      baseUrl: argBaseUrl,
      apiKey: argApiKey || process.env.CODEX_API_KEY || null,
      processEnv: process.env,
    })

    if (!builtEnv) {
      const credentials = resolveCodexApiCredentials(
        argApiKey
          ? { ...process.env, CODEX_API_KEY: argApiKey }
          : process.env,
      )
      const authHint = credentials.authPath
        ? ` or make sure ${credentials.authPath} exists`
        : ''
      if (!credentials.apiKey) {
        console.error(`Codex profile requires CODEX_API_KEY${authHint}.`)
      } else {
        console.error('Codex profile requires CHATGPT_ACCOUNT_ID or an auth.json that includes it.')
      }
      process.exit(1)
    }

    env = builtEnv
  } else {
    const builtEnv = buildOpenAIProfileEnv({
      goal,
      model: argModel || null,
      baseUrl: argBaseUrl || null,
      apiKey: argApiKey || null,
      processEnv: process.env,
    })

    if (!builtEnv) {
      console.error(
        'OpenAI profile requires real credential(s). Use --api-key or set OPENAI_API_KEYS or OPENAI_API_KEY.',
      )
      process.exit(1)
    }

    env = builtEnv
  }

  const profile = createProfileFile(selected, env)

  const outputPath = saveProfileFile(profile)

  console.log(`Saved profile: ${selected}`)
  console.log(`Goal: ${goal}`)
  console.log(`Model: ${profile.env.GEMINI_MODEL || profile.env.MISTRAL_MODEL || profile.env.OPENAI_MODEL || getGoalDefaultOpenAIModel(goal)}`)
  console.log(`Path: ${outputPath}`)
  console.log('Next: bun run dev:profile')
}

await main()

export {}
