// @ts-nocheck

import {
  applyBenchmarkLatency,
  getGoalDefaultOpenAIModel,
  isViableOllamaChatModel,
  normalizeRecommendationGoal,
  rankOllamaModels,
  selectRecommendedOllamaModel,
  type BenchmarkedOllamaModel,
  type RecommendationGoal,
} from '../src/utils/providerRecommendation.ts'
import {
  buildOllamaProfileEnv,
  buildOpenAIProfileEnv,
  createProfileFile,
  saveProfileFile,
  resolveOpenAICredentialEnvState,
  type ProfileFile,
  type ProviderProfile,
} from '../src/utils/providerProfile.ts'
import {
  benchmarkOllamaModel,
  getOllamaChatBaseUrl,
  hasLocalOllama,
  listOllamaModels,
} from './provider-discovery.ts'

type CliOptions = {
  apply: boolean
  benchmark: boolean
  goal: RecommendationGoal
  json: boolean
  provider: ProviderProfile | 'auto'
  baseUrl: string | null
}

export function getOpenAIConfigurationState(
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean; invalid: boolean } {
  const { configured, invalid } = resolveOpenAICredentialEnvState(env)
  return { configured, invalid }
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    benchmark: false,
    goal: normalizeRecommendationGoal(process.env.OPENCLAUDE_PROFILE_GOAL),
    json: false,
    provider: 'auto',
    baseUrl: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]?.toLowerCase()
    if (!arg) continue

    if (arg === '--apply') {
      options.apply = true
      continue
    }
    if (arg === '--benchmark') {
      options.benchmark = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--goal') {
      options.goal = normalizeRecommendationGoal(argv[i + 1] ?? null)
      i++
      continue
    }
    if (arg === '--provider') {
      const provider = argv[i + 1]?.toLowerCase()
      if (
        provider === 'openai' ||
        provider === 'ollama' ||
        provider === 'auto'
      ) {
        options.provider = provider
      }
      i++
      continue
    }
    if (arg === '--base-url') {
      options.baseUrl = argv[i + 1] ?? null
      i++
    }
  }

  return options
}

function printHumanSummary(payload: {
  goal: RecommendationGoal
  recommendedProfile: ProviderProfile
  recommendedModel: string
  rankedModels: BenchmarkedOllamaModel[]
  benchmarked: boolean
  applied: boolean
}): void {
  console.log(`Recommendation goal: ${payload.goal}`)
  console.log(`Recommended profile: ${payload.recommendedProfile}`)
  console.log(`Recommended model: ${payload.recommendedModel}`)

  if (payload.rankedModels.length > 0) {
    console.log('\nRanked Ollama models:')
    for (const [index, model] of payload.rankedModels.slice(0, 5).entries()) {
      const benchmarkPart =
        payload.benchmarked && model.benchmarkMs !== null
          ? ` | ${Math.round(model.benchmarkMs)}ms`
          : ''
      console.log(
        `${index + 1}. ${model.name} | score=${model.score}${benchmarkPart} | ${model.summary}`,
      )
    }
  }

  if (payload.applied) {
    console.log('\nSaved .openclaude-profile.json with the recommended profile.')
    console.log('Next: bun run dev:profile')
  } else {
    console.log(
      '\nTip: run `bun run profile:auto -- --goal ' +
        payload.goal +
        '` to apply this automatically.',
    )
  }
}

async function maybeApplyProfile(
  profile: ProviderProfile,
  model: string,
  goal: RecommendationGoal,
  baseUrl: string | null,
): Promise<boolean> {
  let env: ProfileFile['env'] | null
  if (profile === 'ollama') {
    env = buildOllamaProfileEnv(model, {
      baseUrl,
      getOllamaChatBaseUrl,
    })
  } else {
    env = buildOpenAIProfileEnv({
      goal,
      model: model || getGoalDefaultOpenAIModel(goal),
      processEnv: process.env,
    })

    if (!env) {
      console.error('Cannot apply an OpenAI profile without OPENAI_API_KEYS or OPENAI_API_KEY.')
      return false
    }
  }

  const profileFile = createProfileFile(profile, env)

  saveProfileFile(profileFile)
  return true
}

export async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const ollamaAvailable =
    options.provider !== 'openai' &&
    (await hasLocalOllama(options.baseUrl ?? undefined))
  const ollamaModels = ollamaAvailable
    ? await listOllamaModels(options.baseUrl ?? undefined)
    : []

  const heuristicRanked = rankOllamaModels(ollamaModels, options.goal)
  const benchmarkInput = options.benchmark
    ? heuristicRanked.filter(isViableOllamaChatModel).slice(0, 3)
    : []

  const benchmarkResults: Record<string, number | null> = {}
  for (const model of benchmarkInput) {
    benchmarkResults[model.name] = await benchmarkOllamaModel(
      model.name,
      options.baseUrl ?? undefined,
    )
  }

  const rankedModels: BenchmarkedOllamaModel[] = options.benchmark
    ? applyBenchmarkLatency(heuristicRanked, benchmarkResults, options.goal)
    : heuristicRanked.map(model => ({
        ...model,
        benchmarkMs: null,
      }))

  const recommendedOllama = selectRecommendedOllamaModel(rankedModels)
  const openAIConfiguration = getOpenAIConfigurationState(process.env)
  const openAIConfigured = openAIConfiguration.configured

  let recommendedProfile: ProviderProfile
  let recommendedModel: string

  if (options.provider === 'openai') {
    recommendedProfile = 'openai'
    recommendedModel = getGoalDefaultOpenAIModel(options.goal)
  } else if (options.provider === 'ollama') {
    if (!recommendedOllama) {
      console.error(
        'No Ollama models were discovered. Pull a model first or switch to --provider openai.',
      )
      process.exit(1)
    }
    recommendedProfile = 'ollama'
    recommendedModel = recommendedOllama.name
  } else if (recommendedOllama) {
    recommendedProfile = 'ollama'
    recommendedModel = recommendedOllama.name
  } else {
    recommendedProfile = 'openai'
    recommendedModel = getGoalDefaultOpenAIModel(options.goal)
  }

  let applied = false
  if (options.apply) {
    applied = await maybeApplyProfile(
      recommendedProfile,
      recommendedModel,
      options.goal,
      options.baseUrl,
    )
    if (!applied) {
      process.exit(1)
    }
  }

  const payload = {
    goal: options.goal,
    provider: options.provider,
    ollamaAvailable,
    openAIConfigured,
    recommendedProfile,
    recommendedModel,
    benchmarked: options.benchmark,
    rankedModels,
    applied,
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  printHumanSummary({
    goal: options.goal,
    recommendedProfile,
    recommendedModel,
    rankedModels,
    benchmarked: options.benchmark,
    applied,
  })

  if (!recommendedOllama && !openAIConfigured) {
    console.log(
      `
No local Ollama model was detected and OPENAI_API_KEYS / OPENAI_API_KEY ${
        openAIConfiguration.invalid ? 'are invalid' : 'are unset'
      }.`,
    )
    console.log(
      'Next steps: `ollama pull qwen2.5-coder:7b` or set valid OPENAI_API_KEYS or OPENAI_API_KEY.',
    )
  }
}

if (import.meta.main) {
  await main()
}

export {}
