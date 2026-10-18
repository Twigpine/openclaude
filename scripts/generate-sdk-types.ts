/**
 * Generates TypeScript type exports from Zod schemas defined in
 * src/entrypoints/sdk/coreSchemas.ts.
 *
 * Usage:
 *   bun scripts/generate-sdk-types.ts
 *
 * Output:
 *   src/entrypoints/sdk/coreTypes.generated.ts
 *
 * The script walks the Zod v4 schema AST (schema.def.type) and emits
 * equivalent TypeScript type literals. Placeholder schemas (z.unknown())
 * are replaced via TypeOverrideMap with real TS type references.
 */

import { realpathSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as schemas from '../src/entrypoints/sdk/coreSchemas.js'

const scriptPath = fileURLToPath(import.meta.url)
const __dirname = dirname(scriptPath)
const outPath = resolve(
  __dirname, '..', 'src', 'entrypoints', 'sdk', 'coreTypes.generated.ts',
)

// ---------------------------------------------------------------------------
// Type override map — placeholder schemas → real TypeScript type references
// ---------------------------------------------------------------------------

// Override map keyed by schema variable name — applied when the schema is
// exported directly (top-level export) or encountered as a field in another
// schema (detected by identity comparison via placeholderInstances).
const TypeOverrideMap: Record<string, string> = {
  APIUserMessagePlaceholder:
    'Record<string, unknown> & { role: "user", content: string | Array<unknown> }',
  APIAssistantMessagePlaceholder:
    'Record<string, unknown> & { role: "assistant", content: Array<unknown> }',
  RawMessageStreamEventPlaceholder:
    'Record<string, unknown>',
  UUIDPlaceholder: 'string',
  // Self-contained structural stand-in for NonNullableUsage: the generated
  // file ships to external consumers without sdkUtilityTypes or
  // @anthropic-ai/sdk, so it must not import either. The four standard
  // counters are REQUIRED numbers — result messages are populated from
  // QueryEngine.totalUsage (initialized from EMPTY_USAGE), so they are
  // always present at runtime and strict consumers may sum them without
  // undefined guards (covered by tests/sdk/package-consumer-types.test.ts).
  // Richer nested metadata is modeled explicitly; unanticipated additions
  // flow through the top-level index signature. The nested objects carry no
  // index signature so the SDK's interface types remain assignable.
  NonNullableUsagePlaceholder:
    '{ input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }',
}

// Materialize placeholder schemas once so we can detect them by identity (===)
// when they appear as fields inside other schemas.
const placeholderInstances = new Map<unknown, string>()
for (const name of Object.keys(TypeOverrideMap)) {
  const candidate = (schemas as Record<string, unknown>)[name]
  if (typeof candidate === 'function') {
    try {
      placeholderInstances.set((candidate as () => unknown)(), TypeOverrideMap[name])
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Schema variable name → exported type name
// ---------------------------------------------------------------------------

function toTypeName(schemaVar: string): string {
  return schemaVar.replace(/Schema$/, '')
}

// ---------------------------------------------------------------------------
// Ordered list of schemas to export
// ---------------------------------------------------------------------------

const EXPORT_ORDER = [
  // Usage & Model
  'ModelUsageSchema',
  // Output Format
  'OutputFormatTypeSchema',
  'BaseOutputFormatSchema',
  'JsonSchemaOutputFormatSchema',
  'OutputFormatSchema',
  // Config
  'ApiKeySourceSchema',
  'ConfigScopeSchema',
  'SdkBetaSchema',
  'ThinkingAdaptiveSchema',
  'ThinkingEnabledSchema',
  'ThinkingDisabledSchema',
  'ThinkingConfigSchema',
  // MCP
  'McpStdioServerConfigSchema',
  'McpSSEServerConfigSchema',
  'McpHttpServerConfigSchema',
  'McpSdkServerConfigSchema',
  'McpServerConfigForProcessTransportSchema',
  'McpClaudeAIProxyServerConfigSchema',
  'McpServerStatusConfigSchema',
  'McpServerStatusSchema',
  'McpSetServersResultSchema',
  // Permission
  'PermissionUpdateDestinationSchema',
  'PermissionBehaviorSchema',
  'PermissionRuleValueSchema',
  'PermissionUpdateSchema',
  'PermissionDecisionClassificationSchema',
  'PermissionResultSchema',
  'PermissionModeSchema',
  // Hook event schemas
  'HookEventSchema',
  'BaseHookInputSchema',
  'PreToolUseHookInputSchema',
  'PostToolUseHookInputSchema',
  'PostToolUseFailureHookInputSchema',
  'PermissionDeniedHookInputSchema',
  'NotificationHookInputSchema',
  'UserPromptSubmitHookInputSchema',
  'SessionStartHookInputSchema',
  'SessionEndHookInputSchema',
  'StopHookInputSchema',
  'StopFailureHookInputSchema',
  'SubagentStartHookInputSchema',
  'SubagentStopHookInputSchema',
  'PreCompactHookInputSchema',
  'PostCompactHookInputSchema',
  'PermissionRequestHookInputSchema',
  'SetupHookInputSchema',
  'TeammateIdleHookInputSchema',
  'TaskCreatedHookInputSchema',
  'TaskCompletedHookInputSchema',
  'ElicitationHookInputSchema',
  'ElicitationResultHookInputSchema',
  'ConfigChangeHookInputSchema',
  'InstructionsLoadedHookInputSchema',
  'WorktreeCreateHookInputSchema',
  'WorktreeRemoveHookInputSchema',
  'CwdChangedHookInputSchema',
  'FileChangedHookInputSchema',
  'HookInputSchema',
  // Hook output schemas
  'AsyncHookJSONOutputSchema',
  'PreToolUseHookSpecificOutputSchema',
  'UserPromptSubmitHookSpecificOutputSchema',
  'SessionStartHookSpecificOutputSchema',
  'SetupHookSpecificOutputSchema',
  'SubagentStartHookSpecificOutputSchema',
  'PostToolUseHookSpecificOutputSchema',
  'PostToolUseFailureHookSpecificOutputSchema',
  'PermissionDeniedHookSpecificOutputSchema',
  'NotificationHookSpecificOutputSchema',
  'PermissionRequestHookSpecificOutputSchema',
  'CwdChangedHookSpecificOutputSchema',
  'FileChangedHookSpecificOutputSchema',
  'ElicitationHookSpecificOutputSchema',
  'ElicitationResultHookSpecificOutputSchema',
  'WorktreeCreateHookSpecificOutputSchema',
  'SyncHookJSONOutputSchema',
  'HookJSONOutputSchema',
  // Prompt
  'PromptRequestOptionSchema',
  'PromptRequestSchema',
  'PromptResponseSchema',
  // Skill/Command
  'SlashCommandSchema',
  'AgentInfoSchema',
  'ModelInfoSchema',
  'AccountInfoSchema',
  // Agent Definition
  'AgentMcpServerSpecSchema',
  'AgentDefinitionSchema',
  // Settings
  'SettingSourceSchema',
  'SdkPluginConfigSchema',
  // Rewind
  'RewindFilesResultSchema',
  // SDK Message Types
  'SDKAssistantMessageErrorSchema',
  'SDKStatusSchema',
  'SDKUserMessageSchema',
  'SDKUserMessageReplaySchema',
  'SDKRateLimitInfoSchema',
  'SDKAssistantMessageSchema',
  'SDKRateLimitEventSchema',
  'SDKStreamlinedTextMessageSchema',
  'SDKStreamlinedToolUseSummaryMessageSchema',
  'SDKPermissionDenialSchema',
  'SDKResultSuccessSchema',
  'SDKResultErrorSchema',
  'SDKResultMessageSchema',
  'SDKSystemMessageSchema',
  'SDKPartialAssistantMessageSchema',
  'SDKCompactBoundaryMessageSchema',
  'SDKStatusMessageSchema',
  'SDKPostTurnSummaryMessageSchema',
  'SDKAPIRetryMessageSchema',
  'SDKLocalCommandOutputMessageSchema',
  'SDKHookStartedMessageSchema',
  'SDKHookProgressMessageSchema',
  'SDKHookResponseMessageSchema',
  'SDKToolProgressMessageSchema',
  'SDKAuthStatusMessageSchema',
  'SDKFilesPersistedEventSchema',
  'SDKTaskNotificationMessageSchema',
  'SDKTaskStartedMessageSchema',
  'SDKTaskProgressMessageSchema',
  'SDKSessionStateChangedMessageSchema',
  'SDKHeartbeatMessageSchema',
  'SDKToolUseSummaryMessageSchema',
  'SDKElicitationCompleteMessageSchema',
  'SDKPromptSuggestionMessageSchema',
  // Session
  'SDKSessionInfoSchema',
  'SDKMessageSchema',
  // Misc
  'FastModeStateSchema',
  'ExitReasonSchema',
]

// ---------------------------------------------------------------------------
// Zod v4 schema → TypeScript type string
// ---------------------------------------------------------------------------

// Zod v4 uses schema.def.type as the discriminator (lowercase strings).
// All schemas have .def with { type: string, ... }.

function convert(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== 'object' || !('def' in schema)) return 'unknown'

  // Check if this schema is a known placeholder (identity comparison)
  const override = placeholderInstances.get(schema)
  if (override) return override

  const def = (schema as { def: unknown }).def as Record<string, unknown> | null
  if (!def || typeof def !== 'object') return 'unknown'
  const type = typeof def.type === 'string' ? def.type : ''

  switch (type) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'undefined':
      return 'undefined'
    case 'any':
      return 'any'
    case 'unknown':
      return 'unknown'
    case 'void':
      return 'void'
    case 'never':
      return 'never'
    case 'literal': {
      // def.values is an array of literal values
      const vals = Array.isArray(def.values) ? def.values : []
      return vals.map(v => JSON.stringify(v)).join(' | ')
    }
    case 'enum': {
      // def.entries is { key: value } or an array
      const entries = def.entries
      if (Array.isArray(entries)) {
        return entries.map(v => JSON.stringify(v)).join(' | ')
      }
      return Object.values(entries as Record<string, unknown>)
        .filter((v): v is string => typeof v === 'string')
        .map(v => JSON.stringify(v))
        .join(' | ')
    }
    case 'nativeEnum': {
      const enumObj = def.entries as Record<string, string | number>
      return Object.values(enumObj)
        .filter((v): v is string => typeof v === 'string')
        .map(v => JSON.stringify(v))
        .join(' | ')
    }
    case 'array': {
      const element = convert(def.element, depth)
      return `${needsArrayElementParens(element) ? `(${element})` : element}[]`
    }
    case 'tuple': {
      const items = (Array.isArray(def.items) ? def.items : []).map(t => convert(t, depth))
      return `[${items.join(', ')}]`
    }
    case 'record':
      return `Record<${convert(def.keyType, depth)}, ${convert(def.valueType, depth)}>`
    case 'object':
      return convertObject(def, depth)
    case 'union':
    case 'discriminated_union': {
      // def.options for discriminated, def.options for plain union
      const members = (Array.isArray(def.options) ? def.options : []).map(t => {
        const ts = convert(t, depth)
        return needsParens(ts) ? `(${ts})` : ts
      })
      return members.join(' | ')
    }
    case 'intersection':
      return `${convert(def.left, depth)} & ${convert(def.right, depth)}`
    case 'optional':
      return convert(def.innerType, depth)
    case 'nullable':
      return `${convert(def.innerType, depth)} | null`
    case 'default':
      return convert(def.innerType, depth)
    case 'lazy': {
      const getter = def.getter
      if (typeof getter !== 'function') return 'unknown'
      return convert((getter as () => unknown)(), depth)
    }
    case 'transform':
    case 'effects':
      return convert(def.schema, depth)
    case 'catch':
      return convert(def.innerType, depth)
    case 'pipe':
      return convert(def.in, depth)
    case 'preprocess':
      return convert(def.schema, depth)
    case 'branded':
      return convert(def.type, depth)
    case 'readonly':
      return `Readonly<${convert(def.innerType, depth)}>`
    case 'success':
      return 'true'
    case 'failure':
      return 'false'
    default:
      console.error(`  ⚠ Unknown Zod def.type: "${type}"`)
      return 'unknown'
  }
}

function convertObject(def: Record<string, unknown>, depth: number): string {
  let shape: Record<string, unknown>
  if (typeof def.shape === 'function') {
    shape = (def.shape as () => Record<string, unknown>)()
  } else if (typeof def.shape === 'object' && def.shape !== null) {
    shape = def.shape as Record<string, unknown>
  } else {
    return 'Record<string, unknown>'
  }

  const entries = Object.entries(shape)
  if (entries.length === 0) return '{}'

  const indent = '  '.repeat(depth + 1)
  const closeIndent = '  '.repeat(depth)

  const fields = entries.map(([key, value]) => {
    const ts = convert(value, depth + 1)
    const opt = isOptional(value)
    return `${indent}${key}${opt ? '?' : ''}: ${ts}`
  })

  return '{\n' + fields.join('\n') + '\n' + closeIndent + '}'
}

function isOptional(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || !('def' in schema)) return false
  const def = (schema as { def: unknown }).def
  if (!def || typeof def !== 'object') return false
  const defType = (def as { type?: unknown }).type
  return defType === 'optional' || defType === 'default'
}

function needsParens(ts: string): boolean {
  return ts.includes('\n') || ts.includes(' & ')
}

function needsArrayElementParens(ts: string): boolean {
  return ts.includes(' | ') || ts.includes(' & ')
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateSdkTypes(): string {
  const lines: string[] = [
    '// AUTO-GENERATED — do not edit manually.',
    '// Regenerate with: bun scripts/generate-sdk-types.ts',
    '//',
    '// Generated from Zod schemas in coreSchemas.ts',
    '',
  ]

  let errors = 0

  for (const schemaName of EXPORT_ORDER) {
    const thunk = (schemas as Record<string, unknown>)[schemaName]
    if (typeof thunk !== 'function') {
      console.warn(`  ⚠ Not found: ${schemaName}`)
      errors++
      continue
    }

    // Check type override first
    if (TypeOverrideMap[schemaName]) {
      const typeName = toTypeName(schemaName)
      lines.push(`export type ${typeName} = ${TypeOverrideMap[schemaName]}`)
      lines.push('')
      continue
    }

    let schema: unknown
    try {
      schema = (thunk as () => unknown)()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`  ⚠ Materialize failed: ${schemaName}: ${msg}`)
      errors++
      continue
    }

    const typeName = toTypeName(schemaName)

    try {
      const ts = convert(schema)
      // Check for top-level description
      const desc =
        schema && typeof schema === 'object'
          ? (Reflect.get(schema, 'description') as string | undefined)
          : undefined
      if (desc) {
        lines.push(`/** ${desc} */`)
      }
      lines.push(`export type ${typeName} = ${ts}`)
      lines.push('')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`  ⚠ Convert failed: ${schemaName}: ${msg}`)
      errors++
      lines.push(`// ⚠ Failed: ${schemaName}`)
      lines.push(`export type ${typeName} = any`)
      lines.push('')
    }
  }

  if (errors > 0) {
    console.warn(`\n  ⚠ ${errors} schema(s) had errors`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeGeneratedSdkTypes(): void {
  console.log('Generating SDK types from Zod schemas...')
  const output = generateSdkTypes()
  writeFileSync(outPath, output, 'utf-8')
  console.log(`✓ Written to ${outPath}`)
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false
  }
  const invokedPath = realpathOrUndefined(resolve(process.argv[1]))
  const currentScriptPath = realpathOrUndefined(scriptPath)
  return Boolean(
    invokedPath && currentScriptPath && invokedPath === currentScriptPath,
  )
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

if (isDirectExecution()) {
  writeGeneratedSdkTypes()
}
