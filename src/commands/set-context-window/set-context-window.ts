import { getSdkBetas } from '../../bootstrap/state.js'
import { getBaseModelApiName } from '../../integrations/runtimeMetadata.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  CONTEXT_WINDOW_SOURCE_LABELS,
  resolveContextWindowForModel,
  setSessionContextWindowOverride,
  getSessionContextWindowOverride,
  getSessionContextWindowOverrides,
} from '../../utils/context.js'
import {
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import { formatZodError } from '../../utils/settings/validation.js'

const HELP = `Usage: /set-context-window [model] <tokens> [--save]

Set a session-scoped context window override. Defaults to the active model.

Examples:
  /set-context-window 256000
  /set-context-window gpt-4o 200000
  /set-context-window my-model 1000000 --save
  /set-context-window status

The override takes precedence over discovery, catalog, and provider defaults
for this session only. Use /clear-context-window to remove it.

Add --save to also write the value to modelLimits in your user settings.json
so it survives restarts. Other settings, including the model's
maxOutputTokens, are kept. After a restart the saved value follows the
modelLimits precedence below, and --save reports when another source will
take precedence over it.

For a permanent override (survives restart), use modelLimits in settings.json
for custom/discovered models, for example:
  { "modelLimits": { "my-model": { "contextWindow": 1000000 } } }
For a catalogued model, use an exact CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS entry;
catalog values take precedence over modelLimits and prefix env entries.
See docs/advanced-setup.md (Per-model limit overrides).`

function saveContextWindow(model: string, tokens: number): string {
  const settingsPath = getSettingsFilePathForSource('userSettings')
  const key = getBaseModelApiName(model) ?? model
  const patch = { modelLimits: { [key]: { contextWindow: tokens } } }
  // The session override accepts values the settings schema rejects (such as
  // integers above Number.MAX_SAFE_INTEGER). Writing one would stop the whole
  // user settings file from loading, so check the entry before writing it.
  const validation = SettingsSchema().safeParse(patch)
  const error = validation.success
    ? updateSettingsForSource('userSettings', patch).error
    : new Error(
        formatZodError(validation.error, settingsPath ?? 'settings')
          .map(issue => `${issue.path}: ${issue.message}`)
          .join('; '),
      )
  if (error) {
    return `Not saved: ${error.message}\nThe override applies to this session only.`
  }

  const saved = `Saved to modelLimits["${key}"] in ${settingsPath}.`
  const afterRestart = resolveContextWindowForModel(
    model,
    getSdkBetas(),
    undefined,
    { ignoreSessionOverride: true },
  )
  if (
    afterRestart.source === 'model-limits' &&
    afterRestart.contextWindow === tokens
  ) {
    return saved
  }
  const shadowingSource =
    afterRestart.source === 'model-limits'
      ? 'a higher-priority modelLimits entry'
      : CONTEXT_WINDOW_SOURCE_LABELS[afterRestart.source]
  return `${saved}\nAfter a restart, ${shadowingSource} will set ${afterRestart.contextWindow.toLocaleString()} tokens instead of the saved value.`
}

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

  const allParts = trimmed.split(/\s+/)
  const save = allParts.includes('--save')
  const parts = allParts.filter(part => part !== '--save')

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
  const summary = save
    ? `Context window for "${result.normalizedModel}" set to ${tokens.toLocaleString()} tokens for this session.\n${saveContextWindow(model, tokens)}`
    : `Context window for "${result.normalizedModel}" set to ${tokens.toLocaleString()} tokens (session only).`
  return {
    type: 'text',
    value: `${summary}\nPrevious: ${prevDisplay}`,
  }
}
