import type { LocalCommandCall } from '../../types/command.js'
import {
  setSessionContextWindowOverride,
  getSessionContextWindowOverride,
  getSessionContextWindowOverrides,
} from '../../utils/context.js'

const HELP = `Usage: /set-context-window [model] <tokens>

Set a session-scoped context window override. Defaults to the active model.

Examples:
  /set-context-window 256000
  /set-context-window gpt-4o 200000
  /set-context-window status

The override takes precedence over discovery, catalog, and provider defaults
for this session only. Use /clear-context-window to remove it.

For a permanent override (survives restart), use modelLimits in settings.json
for custom/discovered models, for example:
  { "modelLimits": { "my-model": { "contextWindow": 1000000 } } }
For a catalogued model, use an exact CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS entry;
catalog values take precedence over modelLimits and prefix env entries.
See docs/advanced-setup.md (Per-model limit overrides).`

export const call: LocalCommandCall = async (args, context) => {
  const trimmed = args.trim()

  if (!trimmed || trimmed === 'help' || trimmed === '-h' || trimmed === '--help') {
    return { type: 'text', value: HELP }
  }

  if (trimmed === 'status' || trimmed === 'current') {
    const overrides = getSessionContextWindowOverrides()
    if (overrides.size === 0) {
      return { type: 'text', value: 'No context window overrides set for this session.' }
    }
    const lines = Array.from(overrides.entries())
      .map(([model, tokens]) => `  ${model}: ${tokens.toLocaleString()} tokens`)
      .join('\n')
    return { type: 'text', value: `Active context window overrides:\n${lines}` }
  }

  const parts = trimmed.split(/\s+/)

  let model: string
  let tokensStr: string

  if (parts.length === 1) {
    model = context.options.mainLoopModel
    tokensStr = parts[0]
  } else if (parts.length === 2) {
    model = parts[0]
    tokensStr = parts[1]
  } else {
    return { type: 'text', value: `Error: expected 1 or 2 arguments, got ${parts.length}.\n\n${HELP}` }
  }

  if (!/^\d+$/.test(tokensStr)) {
    return { type: 'text', value: `Error: "${tokensStr}" is not a valid integer.` }
  }
  const tokens = Number(tokensStr)

  const previous = getSessionContextWindowOverride(model)

  const result = setSessionContextWindowOverride(model, tokens)
  if (!result.ok) {
    return { type: 'text', value: `Error: ${result.error}` }
  }

  const prevDisplay = previous !== undefined
    ? `${previous.toLocaleString()} tokens`
    : 'none (using default)'
  return {
    type: 'text',
    value: `Context window for "${result.normalizedModel}" set to ${tokens.toLocaleString()} tokens (session only).\nPrevious: ${prevDisplay}`,
  }
}
