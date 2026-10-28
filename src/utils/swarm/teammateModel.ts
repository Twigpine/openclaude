import { CLAUDE_OPUS_4_8_CONFIG } from '../model/configs.js'
import { getDefaultOpusModel } from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use Opus 4.8. Must be provider-aware so Bedrock/Vertex/Foundry customers get
// the correct model ID.
export function getHardcodedTeammateModelFallback(): string {
  const provider = getAPIProvider()
  // Native Vertex owns its Gemini tier defaults outside the Claude table.
  if (provider === 'gemini-vertex') return getDefaultOpusModel()
  return CLAUDE_OPUS_4_8_CONFIG[provider]
}
