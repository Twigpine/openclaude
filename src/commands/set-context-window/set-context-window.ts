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
import { errorMessage } from '../../utils/errors.js'
import { readFileSync } from '../../utils/fileRead.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  getSettingsFilePathForSource,
  parseSettingsFile,
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
take precedence over it, or when other invalid settings in the file stop it
from loading. If the save fixes a file this session could not load, it also
names the env settings in that file, which this check cannot account for.

For a permanent override (survives restart), use modelLimits in settings.json
for custom/discovered models, for example:
  { "modelLimits": { "my-model": { "contextWindow": 1000000 } } }
For a catalogued model, use an exact CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS entry;
catalog values take precedence over modelLimits and prefix env entries.
See docs/advanced-setup.md (Per-model limit overrides).`

function ownProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

// The writer reports success once it has written the file, not once the value
// is in it. For an invalid file it merges into the raw JSON, where an array in
// place of modelLimits or the model's entry keeps the new field only as a named
// array property, which JSON drops. Read the file back before reporting a save.
function checkContextWindowWritten(
  settingsPath: string | undefined,
  key: string,
  tokens: number,
): Error | null {
  if (!settingsPath) {
    return new Error('there is no user settings file to write to')
  }
  let data: unknown
  try {
    data = safeParseJSON(readFileSync(settingsPath), false)
  } catch (e) {
    return new Error(`could not read ${settingsPath} back: ${errorMessage(e)}`)
  }
  const modelLimits = ownProperty(data, 'modelLimits')
  if (Array.isArray(modelLimits)) {
    return new Error(
      `modelLimits in ${settingsPath} is an array, so it cannot hold model entries`,
    )
  }
  const entry = ownProperty(modelLimits, key)
  if (Array.isArray(entry)) {
    return new Error(
      `modelLimits["${key}"] in ${settingsPath} is an array, so it cannot hold contextWindow`,
    )
  }
  if (ownProperty(entry, 'contextWindow') !== tokens) {
    return new Error(
      `modelLimits["${key}"].contextWindow was not written to ${settingsPath}`,
    )
  }
  return null
}

function saveContextWindow(model: string, tokens: number): string {
  const settingsPath = getSettingsFilePathForSource('userSettings')
  const key = getBaseModelApiName(model) ?? model
  const patch = { modelLimits: { [key]: { contextWindow: tokens } } }
  // Startup ignores an invalid file, including its env settings, and the
  // settings watcher skips this command's own write. Keep the state from
  // before the write so a repair that makes the env load can be reported.
  const before = settingsPath ? parseSettingsFile(settingsPath) : null
  // The session override accepts values the settings schema rejects (such as
  // integers above Number.MAX_SAFE_INTEGER). Writing one would stop the whole
  // user settings file from loading, so check the entry before writing it.
  const validation = SettingsSchema().safeParse(patch)
  let error: Error | null
  if (!validation.success) {
    error = new Error(
      formatZodError(validation.error, settingsPath ?? 'settings')
        .map(issue => `${issue.path}: ${issue.message}`)
        .join('; '),
    )
  } else if (!Object.hasOwn(validation.data.modelLimits ?? {}, key)) {
    // Parsing also drops keys a settings object cannot hold, such as
    // "__proto__", without an error. The writer and the loader drop the entry
    // the same way, so it would never be saved or loaded.
    error = new Error(
      `modelLimits["${key}"]: settings cannot store this model name`,
    )
  } else {
    error =
      updateSettingsForSource('userSettings', patch).error ??
      checkContextWindowWritten(settingsPath, key, tokens)
  }
  if (error) {
    return `Not saved: ${error.message}\nThe override applies to this session only.`
  }

  const saved = `Saved to modelLimits["${key}"] in ${settingsPath}.`
  // The writer keeps invalid fields already in the file, and the loader then
  // ignores the whole file. Report that rather than naming whichever source
  // wins without it as the one taking precedence.
  const written = settingsPath ? parseSettingsFile(settingsPath) : null
  if (written?.settings === null) {
    const details = written.errors
      .map(issue => `\n  ${issue.path}: ${issue.message}`)
      .join('')
    return `${saved}\nAfter a restart, the saved value will not apply: ${settingsPath} has invalid settings, so the whole file is ignored until they are fixed.${details}`
  }
  // The restart check below reads this session's environment, which lacks
  // env settings from a file that only became valid with this save.
  const unloadedEnvKeys =
    before?.settings === null
      ? Object.entries(written?.settings?.env ?? {})
          .filter(([name, value]) => process.env[name] !== value)
          .map(([name]) => name)
      : []
  const unloadedEnvNote =
    unloadedEnvKeys.length > 0
      ? `\n${settingsPath} had invalid settings before this save, so this session did not load its env settings (${unloadedEnvKeys.join(', ')}). They can apply after a restart and change which window is used; this report does not account for them.`
      : ''
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
    return `${saved}${unloadedEnvNote}`
  }
  const shadowingSource =
    afterRestart.source === 'model-limits'
      ? 'a higher-priority modelLimits entry'
      : CONTEXT_WINDOW_SOURCE_LABELS[afterRestart.source]
  return `${saved}\nAfter a restart, ${shadowingSource} will set ${afterRestart.contextWindow.toLocaleString()} tokens instead of the saved value.${unloadedEnvNote}`
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
