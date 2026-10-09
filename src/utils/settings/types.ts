import { feature } from 'bun:bundle'
import { toJSONSchema, z } from 'zod/v4'
import { SandboxSettingsSchema } from '../../entrypoints/sandboxTypes.js'
import { isEnvTruthy } from '../envUtils.js'
import { lazySchema } from '../lazySchema.js'
import {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
} from '../permissions/PermissionMode.js'
import { MarketplaceSourceSchema } from '../plugins/schemas.js'
import { CLAUDE_CODE_SETTINGS_SCHEMA_URL } from './constants.js'
import { PermissionRuleSchema } from './permissionValidation.js'

// Re-export hook schemas and types from centralized location for backward compatibility
export {
  type AgentHook,
  type BashCommandHook,
  type HookCommand,
  HookCommandSchema,
  type HookMatcher,
  HookMatcherSchema,
  HooksSchema,
  type HooksSettings,
  type HttpHook,
  type PromptHook,
} from '../../schemas/hooks.js'

// Also import for use within this file
import { type HookCommand, HooksSchema } from '../../schemas/hooks.js'
import { AutoFixConfigSchema } from '../../services/autoFix/autoFixConfig.js'
import { count } from '../array.js'

export const MAX_MODEL_PRICING_ENTRIES = 256
export const MAX_MODEL_PRICING_ID_LENGTH = 512
export const MAX_MODEL_TOKEN_RATE_USD_PER_MILLION = 100_000
export const MAX_MODEL_WEB_SEARCH_RATE_USD_PER_REQUEST = 1_000

const ModelTokenRateSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(MAX_MODEL_TOKEN_RATE_USD_PER_MILLION)

export const ModelPricingEntrySchema = z
  .object({
    inputTokens: ModelTokenRateSchema.describe(
      'Input-token price in USD per 1,000,000 tokens.',
    ),
    outputTokens: ModelTokenRateSchema.describe(
      'Output-token price in USD per 1,000,000 tokens.',
    ),
    promptCacheReadTokens: ModelTokenRateSchema.describe(
      'Prompt-cache read price in USD per 1,000,000 tokens.',
    ),
    promptCacheWriteTokens: ModelTokenRateSchema.describe(
      'Prompt-cache write price in USD per 1,000,000 tokens.',
    ),
    webSearchRequests: z
      .number()
      .finite()
      .nonnegative()
      .max(MAX_MODEL_WEB_SEARCH_RATE_USD_PER_REQUEST)
      .optional()
      .describe(
        'Web-search price in USD per request. Defaults to $0.01 when omitted.',
      ),
  })
  .strict()

const MODEL_PRICING_KEY_PREFIX = '\0'

const ModelPricingJSONSchema = z.record(
  z.string().min(1).max(MAX_MODEL_PRICING_ID_LENGTH),
  ModelPricingEntrySchema,
)

const ModelPricingSchema = z.preprocess(
  value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value
    }
    // Zod's record parser treats Object.prototype names as structural record
    // members. Prefix every raw own key before validation so arbitrary exact
    // model ids such as `constructor`, `toString`, and `__proto__` stay data.
    const entries = Object.entries(value)
    if (
      entries.length > MAX_MODEL_PRICING_ENTRIES ||
      entries.some(
        ([model]) =>
          model.length < 1 || model.length > MAX_MODEL_PRICING_ID_LENGTH,
      )
    ) {
      return null
    }
    const encoded: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >
    for (const [model, entry] of entries) {
      encoded[MODEL_PRICING_KEY_PREFIX + model] = entry
    }
    return encoded
  },
  z
    .record(z.string(), ModelPricingEntrySchema)
    .transform(value => {
      const decoded = Object.create(null) as Record<
        string,
        z.infer<typeof ModelPricingEntrySchema>
      >
      for (const [encodedModel, entry] of Object.entries(value)) {
        decoded[encodedModel.slice(MODEL_PRICING_KEY_PREFIX.length)] = entry
      }
      return decoded
    }),
)

export const ModelPricingDiagnosticSchema = z.unknown().superRefine(
  (value, context) => {
    if (!ModelPricingSchema.safeParse(value).success) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid modelPricing value was ignored',
        params: { received: value },
      })
    }
  },
)

/**
 * Schema for environment variables
 */
export const EnvironmentVariablesSchema = lazySchema(() =>
  z.record(z.string(), z.coerce.string()),
)

/**
 * Schema for permissions section
 */
export const PermissionsSchema = lazySchema(() =>
  z
    .object({
      allow: z
        .array(PermissionRuleSchema())
        .optional()
        .describe('List of permission rules for allowed operations'),
      deny: z
        .array(PermissionRuleSchema())
        .optional()
        .describe('List of permission rules for denied operations'),
      ask: z
        .array(PermissionRuleSchema())
        .optional()
        .describe(
          'List of permission rules that should always prompt for confirmation',
        ),
      defaultMode: z
        .enum(
          feature('TRANSCRIPT_CLASSIFIER')
            ? PERMISSION_MODES
            : EXTERNAL_PERMISSION_MODES,
        )
        .optional()
        .describe('Default permission mode when Claude Code needs access'),
      disableBypassPermissionsMode: z
        .enum(['disable'])
        .optional()
        .describe('Disable the ability to bypass permission prompts'),
      allowBypassPermissionsMode: z
        .boolean()
        .optional()
        .describe(
          'Allow bypass permissions mode to appear in the mode list without requiring the CLI flag',
        ),
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? {
            disableAutoMode: z
              .enum(['disable'])
              .optional()
              .describe('Disable auto mode'),
          }
        : {}),
      additionalDirectories: z
        .array(z.string())
        .optional()
        .describe('Additional directories to include in the permission scope'),
    })
    .passthrough(),
)

/**
 * Schema for extra marketplaces defined in repository settings
 * Same as KnownMarketplace but without lastUpdated (which is managed automatically)
 */
export const ExtraKnownMarketplaceSchema = lazySchema(() =>
  z.object({
    source: MarketplaceSourceSchema().describe(
      'Where to fetch the marketplace from',
    ),
    installLocation: z
      .string()
      .optional()
      .describe(
        'Local cache path where marketplace manifest is stored (auto-generated if not provided)',
      ),
    autoUpdate: z
      .boolean()
      .optional()
      .describe(
        'Whether to automatically update this marketplace and its installed plugins on startup',
      ),
  }),
)

// The prefix transform above is deliberately invisible to settings authors,
// so expose the equivalent public input contract to JSON Schema consumers.
// Zod documents this hook for schemas whose runtime representation needs a
// custom JSON Schema (the preprocess itself is otherwise unrepresentable).
ModelPricingSchema._zod.toJSONSchema = () => {
  const schema = toJSONSchema(ModelPricingJSONSchema, {
    unrepresentable: 'any',
  }) as Record<string, unknown>
  delete schema.$schema
  schema.maxProperties = MAX_MODEL_PRICING_ENTRIES
  return schema
}

/**
 * Schema for allowed MCP server entry in enterprise allowlist.
 * Supports matching by serverName, serverCommand, or serverUrl (mutually exclusive).
 */
export const AllowedMcpServerEntrySchema = lazySchema(() =>
  z
    .object({
      serverName: z
        .string()
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          'Server name can only contain letters, numbers, hyphens, and underscores',
        )
        .optional()
        .describe('Name of the MCP server that users are allowed to configure'),
      serverCommand: z
        .array(z.string())
        .min(1, 'Server command must have at least one element (the command)')
        .optional()
        .describe(
          'Command array [command, ...args] to match exactly for allowed stdio servers',
        ),
      serverUrl: z
        .string()
        .optional()
        .describe(
          'URL pattern with wildcard support (e.g., "https://*.example.com/*") for allowed remote MCP servers',
        ),
      // Future extensibility: allowedTransports, requiredArgs, maxInstances, etc.
    })
    .refine(
      data => {
        const defined = count(
          [
            data.serverName !== undefined,
            data.serverCommand !== undefined,
            data.serverUrl !== undefined,
          ],
          Boolean,
        )
        return defined === 1
      },
      {
        message:
          'Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"',
      },
    ),
)

/**
 * Schema for denied MCP server entry in enterprise denylist.
 * Supports matching by serverName, serverCommand, or serverUrl (mutually exclusive).
 */
export const DeniedMcpServerEntrySchema = lazySchema(() =>
  z
    .object({
      serverName: z
        .string()
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          'Server name can only contain letters, numbers, hyphens, and underscores',
        )
        .optional()
        .describe('Name of the MCP server that is explicitly blocked'),
      serverCommand: z
        .array(z.string())
        .min(1, 'Server command must have at least one element (the command)')
        .optional()
        .describe(
          'Command array [command, ...args] to match exactly for blocked stdio servers',
        ),
      serverUrl: z
        .string()
        .optional()
        .describe(
          'URL pattern with wildcard support (e.g., "https://*.example.com/*") for blocked remote MCP servers',
        ),
      // Future extensibility: reason, blockedSince, etc.
    })
    .refine(
      data => {
        const defined = count(
          [
            data.serverName !== undefined,
            data.serverCommand !== undefined,
            data.serverUrl !== undefined,
          ],
          Boolean,
        )
        return defined === 1
      },
      {
        message:
          'Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"',
      },
    ),
)

/**
 * Unified schema for settings files
 *
 * ⚠️ BACKWARD COMPATIBILITY NOTICE ⚠️
 *
 * This schema defines the structure of user settings files (~/.openclaude/settings.json).
 * We support backward-compatible changes! Here's how:
 *
 * ✅ ALLOWED CHANGES:
 * - Adding new optional fields (always use .optional())
 * - Adding new enum values (keeping existing ones)
 * - Adding new properties to objects
 * - Making validation more permissive
 * - Using union types for gradual migration (e.g., z.union([oldType, newType]))
 *
 * ❌ BREAKING CHANGES TO AVOID:
 * - Removing fields (mark as deprecated instead)
 * - Removing enum values
 * - Making optional fields required
 * - Making types more restrictive
 * - Renaming fields without keeping the old name
 *
 * TO ENSURE BACKWARD COMPATIBILITY:
 * 1. Run: npm run test:file -- test/utils/settings/backward-compatibility.test.ts
 * 2. If tests fail, you've introduced a breaking change
 * 3. When adding new fields, add a test to BACKWARD_COMPATIBILITY_CONFIGS
 *
 * The settings system handles backward compatibility automatically:
 * - When updating settings, invalid fields are preserved in the file (see settings.ts lines 233-249)
 * - Type coercion via z.coerce (e.g., env vars convert numbers to strings)
 * - .passthrough() preserves unknown fields in permissions object
 * - Invalid settings are simply not used, but remain in the file to be fixed by the user
 */

/**
 * Surfaces lockable by `strictPluginOnlyCustomization`. Exported so the
 * schema preprocess (below) and the runtime helper (pluginOnlyPolicy.ts)
 * share one source of truth.
 */
export const CUSTOMIZATION_SURFACES = [
  'skills',
  'agents',
  'hooks',
  'mcp',
] as const

export const SettingsSchema = lazySchema(() =>
  z
    .object({
      $schema: z
        .literal(CLAUDE_CODE_SETTINGS_SCHEMA_URL)
        .optional()
        .describe('JSON Schema reference for Claude Code settings'),
      subscriptionType: z
        .enum(['free', 'pro', 'max', 'team', 'enterprise'])
        .optional()
        .describe(
          'Override the active subscription type from user settings only. Project, repository, local, flag, and policy settings are ignored to prevent spoofing. Allowed values: free, pro, max, team, enterprise. The "free" value is authoritative and takes precedence over OAuth fallback detection.',
        ),
      apiKeyHelper: z
        .string()
        .optional()
        .describe('Path to a script that outputs authentication values'),
      awsCredentialExport: z
        .string()
        .optional()
        .describe('Path to a script that exports AWS credentials'),
      awsAuthRefresh: z
        .string()
        .optional()
        .describe('Path to a script that refreshes AWS authentication'),
      gcpAuthRefresh: z
        .string()
        .optional()
        .describe(
          'Command to refresh GCP authentication (e.g., gcloud auth application-default login)',
        ),
      // Gated so the SDK generator (which runs without CLAUDE_CODE_ENABLE_XAA)
      // doesn't surface this in GlobalClaudeSettings. Read via getXaaIdpSettings().
      // .passthrough() on the outer object keeps an existing settings.json key
      // alive across env-var-off sessions — it's just not schema-validated then.
      ...(isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_XAA)
        ? {
            xaaIdp: z
              .object({
                issuer: z
                  .string()
                  .url()
                  .describe('IdP issuer URL for OIDC discovery'),
                clientId: z
                  .string()
                  .describe("Claude Code's client_id registered at the IdP"),
                callbackPort: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe(
                    'Fixed loopback callback port for the IdP OIDC login. ' +
                      'Only needed if the IdP does not honor RFC 8252 port-any matching.',
                  ),
              })
              .optional()
              .describe(
                'XAA (SEP-990) IdP connection. Configure once; all XAA-enabled MCP servers reuse this.',
              ),
          }
        : {}),
      fileSuggestion: z
        .object({
          type: z.literal('command'),
          command: z.string(),
        })
        .optional()
        .describe('Custom file suggestion configuration for @ mentions'),
      respectGitignore: z
        .boolean()
        .optional()
        .describe(
          'Whether file picker should respect .gitignore files (default: true). ' +
            'Note: .ignore files are always respected.',
        ),
      cleanupPeriodDays: z
        .number()
        .nonnegative()
        .int()
        .optional()
        .describe(
          'Number of days to retain local session artifacts, including chat transcripts and completed background-session metadata and logs (default: 30). Setting to 0 disables transcript persistence entirely and removes completed background-session artifacts after they finish.',
        ),
      env: EnvironmentVariablesSchema()
        .optional()
        .describe('Environment variables to set for Claude Code sessions'),
      // Attribution for commits and PRs
      attribution: z
        .object({
          commit: z
            .string()
            .optional()
            .describe(
              'Attribution text for git commits, including any trailers. ' +
                'Empty string hides attribution.',
            ),
          pr: z
            .string()
            .optional()
            .describe(
              'Attribution text for pull request descriptions. ' +
                'Empty string hides attribution.',
            ),
        })
        .optional()
        .describe(
          'Customize attribution text for commits and PRs. ' +
            'Unspecified fields are off by default; set a non-empty string to opt in.',
        ),
      includeCoAuthoredBy: z
        .boolean()
        .optional()
        .describe(
          'Deprecated: Use attribution instead. ' +
            "Whether to include Claude's co-authored by attribution in commits and PRs (defaults to false)",
        ),
      includeGitInstructions: z
        .boolean()
        .optional()
        .describe(
          "Include built-in commit and PR workflow instructions in Claude's system prompt (default: true)",
        ),
      permissions: PermissionsSchema()
        .optional()
        .describe('Tool usage permissions configuration'),
      model: z
        .string()
        .optional()
        .describe('Override the default model used by Claude Code'),
      // Enterprise allowlist of models
      availableModels: z
        .array(z.string())
        .optional()
        .describe(
          'Allowlist of models that users can select. ' +
            'Accepts family aliases ("opus" allows any opus version), ' +
            'version prefixes ("opus-4-5" allows only that version), ' +
            'and full model IDs. ' +
            'If undefined, all models are available. If empty array, only the default model is available. ' +
            'Typically set in managed settings by enterprise administrators.',
        ),
      providerProfileModelPickerMode: z
        .enum(['auto', 'profile', 'provider'])
        .optional()
        .catch(undefined)
        .describe(
          'Controls /model options when an active provider profile is applied. ' +
            '"profile" shows only explicitly configured profile models; ' +
            '"provider" shows the provider catalog/discovery list plus explicit profile-only custom models; ' +
            '"auto" uses profile mode when the profile has multiple explicitly configured models, otherwise provider mode.',
        ),
      modelOverrides: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Override mapping from Anthropic model ID (e.g. "claude-opus-4-6") to provider-specific ' +
            'model ID (e.g. a Bedrock inference profile ARN). Typically set in managed settings by ' +
            'enterprise administrators.',
        ),
      // Whether to automatically approve all MCP servers in the project
      enableAllProjectMcpServers: z
        .boolean()
        .optional()
        .describe(
          'Whether to automatically approve all MCP servers in the project',
        ),
      // List of approved MCP servers from .mcp.json
      enabledMcpjsonServers: z
        .array(z.string())
        .optional()
        .describe('List of approved MCP servers from .mcp.json'),
      // List of rejected MCP servers from .mcp.json
      disabledMcpjsonServers: z
        .array(z.string())
        .optional()
        .describe('List of rejected MCP servers from .mcp.json'),
      // Enterprise allowlist of MCP servers
      allowedMcpServers: z
        .array(AllowedMcpServerEntrySchema())
        .optional()
        .describe(
          'Enterprise allowlist of MCP servers that can be used. ' +
            'Applies to all scopes including enterprise servers from managed-mcp.json. ' +
            'If undefined, all servers are allowed. If empty array, no servers are allowed. ' +
            'Denylist takes precedence - if a server is on both lists, it is denied.',
        ),
      // Enterprise denylist of MCP servers
      deniedMcpServers: z
        .array(DeniedMcpServerEntrySchema())
        .optional()
        .describe(
          'Enterprise denylist of MCP servers that are explicitly blocked. ' +
            'If a server is on the denylist, it will be blocked across all scopes including enterprise. ' +
            'Denylist takes precedence over allowlist - if a server is on both lists, it is denied.',
        ),
      hooks: HooksSchema()
        .optional()
        .describe('Custom commands to run before/after tool executions'),
      autoFix: AutoFixConfigSchema
        .optional()
        .describe(
          'Auto-fix configuration: automatically run lint/test after AI file edits ' +
          'and feed errors back for self-repair.',
        ),
      todoReminder: z
        .object({
          turnsSinceWrite: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Assistant turns since last TodoWrite/TaskUpdate before showing reminder (default: 10)',
            ),
          turnsBetweenReminders: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Assistant turns between reminders (default: 10)',
            ),
        })
        .optional()
        .describe(
          'Configuration for todo/task tool usage reminders',
        ),
      worktree: z
        .preprocess((val: unknown) => {
          if (val && typeof val === 'object') {
            const copy: Record<string, unknown> = { ...(val as Record<string, unknown>) }
            if ('enableGitLongPaths' in val && !('autoConfigureLongPaths' in val)) {
              copy.autoConfigureLongPaths = (val as Record<string, unknown>).enableGitLongPaths
            }
            return copy
          }
          return val
        }, z.object({
          symlinkDirectories: z
            .array(z.string())
            .optional()
            .describe(
              'Directories to symlink from main repository to worktrees to avoid disk bloat. ' +
                'Must be explicitly configured - no directories are symlinked by default. ' +
                'Common examples: "node_modules", ".cache", ".bin"',
            ),
          sparsePaths: z
            .array(z.string())
            .optional()
            .describe(
              'Directories to include when creating worktrees, via git sparse-checkout (cone mode). ' +
                'Dramatically faster in large monorepos — only the listed paths are written to disk.',
            ),
          autoConfigureLongPaths: z
            .boolean()
            .optional()
            .describe(
              'On Windows, enable Git long-path support (core.longpaths=true) before ' +
                'creating worktrees. Defaults to true when unset.',
            ),
          enableGitLongPaths: z
            .boolean()
            .optional()
            .describe('Deprecated alias for autoConfigureLongPaths.'),
        }))
        .optional()
        .describe('Git worktree configuration for --worktree flag.'),
      // Whether to disable all hooks and statusLine
      disableAllHooks: z
        .boolean()
        .optional()
        .describe('Disable all hooks and statusLine execution'),
      // Which shell backs input-box `!` (see docs/design/ps-shell-selection.md §4.2)
      defaultShell: z
        .enum(['bash', 'powershell'])
        .optional()
        .describe(
          'Default shell for input-box ! commands. ' +
            "Defaults to 'bash' on all platforms (no Windows auto-flip).",
        ),
      // Only run hooks defined in managed settings (managed-settings.json)
      allowManagedHooksOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), only hooks from managed settings run. ' +
            'User, project, and local hooks are ignored.',
        ),
      // Allowlist of URL patterns HTTP hooks may target (follows allowedMcpServers precedent)
      allowedHttpHookUrls: z
        .array(z.string())
        .optional()
        .describe(
          'Allowlist of URL patterns that HTTP hooks may target. ' +
            'Supports * as a wildcard (e.g. "https://hooks.example.com/*"). ' +
            'When set, HTTP hooks with non-matching URLs are blocked. ' +
            'If undefined, all URLs are allowed. If empty array, no HTTP hooks are allowed. ' +
            'Arrays merge across settings sources (same semantics as allowedMcpServers).',
        ),
      // Allowlist of env var names HTTP hooks may interpolate into headers
      httpHookAllowedEnvVars: z
        .array(z.string())
        .optional()
        .describe(
          'Allowlist of environment variable names HTTP hooks may interpolate into headers. ' +
            "When set, each hook's effective allowedEnvVars is the intersection with this list. " +
            'If undefined, no restriction is applied. ' +
            'Arrays merge across settings sources (same semantics as allowedMcpServers).',
        ),
      // Only use permission rules defined in managed settings (managed-settings.json)
      allowManagedPermissionRulesOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), only permission rules (allow/deny/ask) from managed settings are respected. ' +
            'User, project, local, and CLI argument permission rules are ignored.',
        ),
      // Only read MCP allowlist policy from managed settings
      allowManagedMcpServersOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), allowedMcpServers is only read from managed settings. ' +
            'deniedMcpServers still merges from all sources, so users can deny servers for themselves. ' +
            'Users can still add their own MCP servers, but only the admin-defined allowlist applies.',
        ),
      // Force customizations through plugins only (LinkedIn ask via GTM)
      strictPluginOnlyCustomization: z
        .preprocess(
          // Forwards-compat: drop unknown surface names so a future enum
          // value (e.g. 'commands') doesn't fail safeParse and null out the
          // ENTIRE managed-settings file (settings.ts:101). ["skills",
          // "commands"] on an old client → ["skills"] → locks what it knows,
          // ignores what it doesn't. Degrades to less-locked, never to
          // everything-unlocked.
          v =>
            Array.isArray(v)
              ? v.filter(x =>
                  (CUSTOMIZATION_SURFACES as readonly string[]).includes(x),
                )
              : v,
          z.union([z.boolean(), z.array(z.enum(CUSTOMIZATION_SURFACES))]),
        )
        .optional()
        // Non-array invalid values ("skills" string, {object}) pass through
        // the preprocess unchanged and would fail the union → null the whole
        // managed-settings file. .catch drops the field to undefined instead.
        // Degrades to unlocked-for-this-field, never to everything-broken.
        // Doctor flags the raw value.
        .catch(undefined)
        .describe(
          'When set in managed settings, blocks non-plugin customization sources for the listed surfaces. ' +
            'Array form locks specific surfaces (e.g. ["skills", "hooks"]); `true` locks all four; `false` is an explicit no-op. ' +
            'Blocked: ~/.claude/{surface}/, .claude/{surface}/ (project), settings.json hooks, .mcp.json. ' +
            'NOT blocked: managed (policySettings) sources, plugin-provided customizations. ' +
            'Composes with strictKnownMarketplaces for end-to-end admin control — plugins gated by ' +
            'marketplace allowlist, everything else blocked here.',
        ),
      // Status line for custom status line display
      statusLine: z
        .object({
          type: z.literal('command'),
          command: z.string(),
          padding: z.number().optional(),
        })
        .optional()
        .describe('Custom status line display configuration'),
      // Enabled plugins using marketplace-first format
      enabledPlugins: z
        .record(
          z.string(),
          z.union([z.array(z.string()), z.boolean()]),
        )
        .optional()
        .describe(
          'Enabled plugins using plugin-id@marketplace-id format. Example: { "formatter@anthropic-tools": true }. Also supports extended format with version constraints.',
        ),
      // Extra marketplaces for this repository (usually for project settings)
      extraKnownMarketplaces: z
        .record(z.string(), ExtraKnownMarketplaceSchema())
        .check(ctx => {
          // For settings sources, key must equal source.name. diffMarketplaces
          // looks up materialized state by dict key; addMarketplaceSource stores
          // under marketplace.name (= source.name for settings). A mismatch means
          // the reconciler never converges — every session: key-lookup misses →
          // 'missing' → source-idempotency returns alreadyMaterialized but
          // installed++ anyway → pointless cache clears. For github/git/url the
          // name comes from a fetched marketplace.json (mismatch is expected and
          // benign); for settings, both key and name are user-authored in the
          // same JSON object.
          for (const [key, entry] of Object.entries(ctx.value)) {
            if (
              entry.source.source === 'settings' &&
              entry.source.name !== key
            ) {
              ctx.issues.push({
                code: 'custom',
                input: entry.source.name,
                path: [key, 'source', 'name'],
                message:
                  `Settings-sourced marketplace name must match its extraKnownMarketplaces key ` +
                  `(got key "${key}" but source.name "${entry.source.name}")`,
              })
            }
          }
        })
        .optional()
        .describe(
          'Additional marketplaces to make available for this repository. Typically used in repository .openclaude/settings.json to ensure team members have required plugin sources.',
        ),
      // Enterprise strict list of allowed marketplace sources (policy settings only)
      // When set, ONLY these exact sources can be added. Check happens BEFORE download.
      strictKnownMarketplaces: z
        .array(MarketplaceSourceSchema())
        .optional()
        .describe(
          'Enterprise strict list of allowed marketplace sources. When set in managed settings, ' +
            'ONLY these exact sources can be added as marketplaces. The check happens BEFORE ' +
            'downloading, so blocked sources never touch the filesystem. ' +
            'Note: this is a policy gate only — it does NOT register marketplaces. ' +
            'To pre-register allowed marketplaces for users, also set extraKnownMarketplaces.',
        ),
      // Enterprise blocklist of marketplace sources (policy settings only)
      // When set, these exact sources are blocked. Check happens BEFORE download.
      blockedMarketplaces: z
        .array(MarketplaceSourceSchema())
        .optional()
        .describe(
          'Enterprise blocklist of marketplace sources. When set in managed settings, ' +
            'these exact sources are blocked from being added as marketplaces. The check happens BEFORE ' +
            'downloading, so blocked sources never touch the filesystem.',
        ),
      // Force a specific login method: 'claudeai' for Claude Pro/Max, 'console' for Console billing
      forceLoginMethod: z
        .enum(['claudeai', 'console'])
        .optional()
        .describe(
          'Force a specific login method: "claudeai" for Claude Pro/Max, "console" for Console billing',
        ),
      // Organization UUID to use for OAuth login (will be added as URL param to authorization URL)
      forceLoginOrgUUID: z
        .string()
        .optional()
        .describe('Organization UUID to use for OAuth login'),
      otelHeadersHelper: z
        .string()
        .optional()
        .describe('Path to a script that outputs OpenTelemetry headers'),
      outputStyle: z
        .string()
        .optional()
        .describe('Controls the output style for assistant responses'),
      language: z
        .string()
        .optional()
        .describe(
          'Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish")',
        ),
      skipWebFetchPreflight: z
        .boolean()
        .optional()
        .describe(
          'Skip the WebFetch blocklist check for enterprise environments with restrictive security policies',
        ),
      sandbox: SandboxSettingsSchema().optional(),
      feedbackSurveyRate: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Probability (0–1) that the session quality survey appears when eligible. 0.05 is a reasonable starting point.',
        ),
      spinnerTipsEnabled: z
        .boolean()
        .optional()
        .describe('Whether to show tips in the spinner'),
      sponsoredTipsEnabled: z
        .boolean()
        .optional()
        .describe(
          'Whether to show sponsored partner tips alongside regular tips (default: true). Disabling does not affect regular tips.',
        ),
      sponsoredTipsFrequency: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Show at most 1 sponsored tip per N spinner picks. Default 10. Set 0 to disable sponsored tips.',
        ),
      spinnerVerbs: z
        .object({
          mode: z.enum(['append', 'replace']),
          verbs: z.array(z.string()),
        })
        .optional()
        .describe(
          'Customize spinner verbs. mode: "append" adds verbs to defaults, "replace" uses only your verbs.',
        ),
      spinnerTipsOverride: z
        .object({
          excludeDefault: z.boolean().optional(),
          tips: z.array(z.string()),
        })
        .optional()
        .describe(
          'Override spinner tips. tips: array of tip strings. excludeDefault: if true, only show custom tips (default: false).',
        ),
      syntaxHighlightingDisabled: z
        .boolean()
        .optional()
        .describe('Whether to disable syntax highlighting in diffs'),
      terminalTitleFromRename: z
        .boolean()
        .optional()
        .describe(
          'Whether /rename updates the terminal tab title (defaults to true). Set to false to keep auto-generated topic titles.',
        ),
      alwaysThinkingEnabled: z
        .boolean()
        .optional()
        .describe(
          'When false, thinking is disabled. When absent or true, thinking is ' +
            'enabled automatically for supported models.',
        ),
      effortLevel: z
        .enum(['low', 'medium', 'high', 'xhigh', 'max'])
        .optional()
        .catch(undefined)
        .describe('Persisted effort level for supported models.'),
      advisorModel: z
        .string()
        .optional()
        .describe('Advisor model for the server-side advisor tool.'),
      agentModels: z
        .record(
          z.string(),
          z.object({
            model: z
              .string()
              .optional()
              .describe('Actual model name to send to the API. Defaults to the surrounding agentModels key.'),
            base_url: z
              .string()
              .url()
              .optional()
              .describe('OpenAI-compatible API endpoint (must be https:// or http://). Omit together with api_key to reuse the current provider (model-only route).'),
            api_key: z
              .string()
              .optional()
              .describe('API key for this provider. Omit together with base_url to reuse the current provider (model-only route).'),
          }),
        )
        .optional()
        .describe(
          'Map of route key to provider connection info. ' +
            'Cross-provider: { "deepseek-chat": { "base_url": "https://api.deepseek.com/v1", "api_key": "sk-xxx" } }. ' +
            'Model-only (reuse current provider): { "mini": { "model": "gpt-5-mini" } }. ' +
            'Use "model" when the route key is an alias for a different API model name.',
        ),
      agentRouting: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Map of agent identifier (subagent_type or team member name) to model name. ' +
            'Use "default" key as fallback. Model name must exist in agentModels. ' +
            'Example: { "Explore": "deepseek-chat", "general-purpose": "gpt-4o", "default": "gpt-4o" }',
        ),
      smartRouting: z
        .object({
          enabled: z.boolean().optional().describe('Opt in to per-turn simple-vs-strong model routing. Off by default.'),
          simpleModel: z
            .string()
            .optional()
            .describe('agentModels key (or bare model id) used for turns classified "simple".'),
          strongModel: z
            .string()
            .optional()
            .describe('agentModels key (or bare model id) used for "strong" turns and whenever routing is unsure.'),
          simpleMaxChars: z
            .number()
            .optional()
            .describe('Max characters in user input to qualify as "simple". Passed to routeModel.'),
          simpleMaxWords: z
            .number()
            .optional()
            .describe('Max whitespace-separated words to qualify as "simple". Passed to routeModel.'),
        })
        .optional()
        .describe(
          'Opt-in smart routing: classify each user turn and route simple turns to the configured simple model. ' +
            'simpleModel/strongModel are agentModels keys (or bare model ids). ' +
            'Example: { "enabled": true, "simpleModel": "mini", "strongModel": "main" }',
        ),
      providerFallbackChain: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered list of providerProfile ids. When the active provider returns a rate-limit ' +
            'or quota error, OpenClaude advances to the next profile in this list (starting after ' +
            'the currently-active id) and retries the turn. ' +
            'Example: ["provider_anthropic", "provider_openai", "provider_ollama"]',
        ),
      modelLimits: z
        .record(
          z.string(),
          z.object({
            contextWindow: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Total context window size in tokens.'),
            maxOutputTokens: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Maximum output tokens per response.'),
          }),
        )
        .optional()
        .describe(
          'Per-model overrides for context window and max output tokens. ' +
            'Used for OpenAI-compatible models whose limits are not in the built-in catalog. ' +
            'Keys are matched against the model name (exact match preferred, then prefix). ' +
            'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS / CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS env vars take precedence. ' +
            'Example: { "qwen3.6-plus": { "contextWindow": 1048576, "maxOutputTokens": 32768 } }',
        ),
      modelPricing: ModelPricingSchema.optional()
        // One malformed pricing map must not invalidate unrelated settings in
        // the same source. Drop the whole field so callers never combine a
        // partially-trusted price with built-in cache rates.
        .catch(undefined)
        .describe(
          'Exact-model pricing overrides. Token fields are USD per 1,000,000 tokens; ' +
            'webSearchRequests is USD per request and defaults to $0.01 when omitted. ' +
            'All four token fields are required. Keys are exact, case-sensitive resolved model ids. ' +
            'Shared project settings are ignored for personal USD accounting.',
        ),
      fastMode: z
        .boolean()
        .optional()
        .describe(
          'When true, fast mode is enabled. When absent or false, fast mode is off.',
        ),
      fastModePerSessionOptIn: z
        .boolean()
        .optional()
        .describe(
          'When true, fast mode does not persist across sessions. Each session starts with fast mode off.',
        ),
      promptSuggestionEnabled: z
        .boolean()
        .optional()
        .describe(
          'When false, prompt suggestions are disabled. When absent or true, ' +
            'prompt suggestions are enabled.',
        ),
      showClearContextOnPlanAccept: z
        .boolean()
        .optional()
        .describe(
          'When true, the plan-approval dialog offers a "clear context" option. Defaults to false.',
        ),
      agent: z
        .string()
        .optional()
        .describe(
          'Name of an agent (built-in or custom) to use for the main thread. ' +
            "Applies the agent's system prompt, tool restrictions, and model.",
        ),
      companyAnnouncements: z
        .array(z.string())
        .optional()
        .describe(
          'Company announcements to display at startup (one will be randomly selected if multiple are provided)',
        ),
      pluginConfigs: z
        .record(
          z.string(),
          z.object({
            mcpServers: z
              .record(
                z.string(),
                z.record(
                  z.string(),
                  z.union([
                    z.string(),
                    z.number(),
                    z.boolean(),
                    z.array(z.string()),
                  ]),
                ),
              )
              .optional()
              .describe(
                'User configuration values for MCP servers keyed by server name',
              ),
            options: z
              .record(
                z.string(),
                z.union([
                  z.string(),
                  z.number(),
                  z.boolean(),
                  z.array(z.string()),
                ]),
              )
              .optional()
              .describe(
                'Non-sensitive option values from plugin manifest userConfig, keyed by option name. Sensitive values go to secure storage instead.',
              ),
          }),
        )
        .optional()
        .describe(
          'Per-plugin configuration including MCP server user configs, keyed by plugin ID (plugin@marketplace format)',
        ),
      remote: z
        .object({
          defaultEnvironmentId: z
            .string()
            .optional()
            .describe('Default environment ID to use for remote sessions'),
        })
        .optional()
        .describe('Remote session configuration'),
      autoUpdatesChannel: z
        .enum(['latest', 'stable'])
        .optional()
        .describe('Release channel for auto-updates (latest or stable)'),
      ...(feature('LODESTONE')
        ? {
            disableDeepLinkRegistration: z
              .enum(['disable'])
              .optional()
              .describe(
                'Prevent claude-cli:// protocol handler registration with the OS',
              ),
          }
        : {}),
      minimumVersion: z
        .string()
        .optional()
        .describe(
          'Minimum version to stay on - prevents downgrades when switching to stable channel',
        ),
      plansDirectory: z
        .string()
        .optional()
        .describe(
          'Custom directory for plan files, relative to project root. ' +
            'If not set, defaults to ~/.openclaude/plans/',
        ),
      ...(process.env.USER_TYPE === 'ant'
        ? {
            classifierPermissionsEnabled: z
              .boolean()
              .optional()
              .describe(
                'Enable AI-based classification for Bash(prompt:...) permission rules',
              ),
          }
        : {}),
      ...(feature('PROACTIVE') || feature('KAIROS')
        ? {
            minSleepDurationMs: z
              .number()
              .nonnegative()
              .int()
              .optional()
              .describe(
                'Minimum duration in milliseconds that the Sleep tool must sleep for. ' +
                  'Useful for throttling proactive tick frequency.',
              ),
            maxSleepDurationMs: z
              .number()
              .int()
              .min(-1)
              .optional()
              .describe(
                'Maximum duration in milliseconds that the Sleep tool can sleep for. ' +
                  'Set to -1 for indefinite sleep (waits for user input). ' +
                  'Useful for limiting idle time in remote/managed environments.',
              ),
          }
        : {}),
      ...(feature('VOICE_MODE')
        ? {
            voiceEnabled: z
              .boolean()
              .optional()
              .describe('Enable voice mode (hold-to-talk dictation)'),
          }
        : {}),
      ...(feature('KAIROS')
        ? {
            assistant: z
              .boolean()
              .optional()
              .describe(
                'Start Claude in assistant mode (custom system prompt, brief view, scheduled check-in skills)',
              ),
            assistantName: z
              .string()
              .optional()
              .describe(
                'Display name for the assistant, shown in the claude.ai session list',
              ),
          }
        : {}),
      // Teams/Enterprise opt-IN for channel notifications. Default OFF.
      // MCP servers that declare the claude/channel capability can push
      // inbound messages into the conversation; for managed orgs this only
      // works when explicitly enabled. Which servers can connect at all is
      // still governed by allowedMcpServers/deniedMcpServers. Not
      // feature-spread: KAIROS_CHANNELS is external:true, and the spread
      // wrecks type inference for allowedChannelPlugins (the .passthrough()
      // catch-all gives {} instead of the array type).
      channelsEnabled: z
        .boolean()
        .optional()
        .describe(
          'Teams/Enterprise opt-in for channel notifications (MCP servers with the ' +
            'claude/channel capability pushing inbound messages). Default off. ' +
            'Set true to allow; users then select servers via --channels.',
        ),
      // Org-level channel plugin allowlist. When set, REPLACES the
      // Anthropic ledger — admin owns the trust decision. Undefined means
      // fall back to the ledger. Plugin-only entry shape (same as the
      // ledger); server-kind entries still need the dev flag.
      allowedChannelPlugins: z
        .array(
          z.object({
            marketplace: z.string(),
            plugin: z.string(),
          }),
        )
        .optional()
        .describe(
          'Teams/Enterprise allowlist of channel plugins. When set, ' +
            'replaces the default Anthropic allowlist — admins decide which ' +
            'plugins may push inbound messages. Undefined falls back to the default. ' +
            'Requires channelsEnabled: true.',
        ),
      ...(feature('KAIROS') || feature('KAIROS_BRIEF')
        ? {
            defaultView: z
              .enum(['chat', 'transcript'])
              .optional()
              .describe(
                'Default transcript view: chat (SendUserMessage checkpoints only) or transcript (full)',
              ),
          }
        : {}),
      prefersReducedMotion: z
        .boolean()
        .optional()
        .describe(
          'Reduce or disable animations for accessibility (spinner shimmer, flash effects, etc.)',
        ),
      autoMemoryEnabled: z
        .boolean()
        .optional()
        .describe(
          'Enable auto-memory for this project. When false, Claude will not read from or write to the auto-memory directory. Equivalent to `memory.autoWrite` — see that setting for the governance-focused shape requested in #1326.',
        ),
      memory: z
        .object({
          autoWrite: z
            .boolean()
            .optional()
            .describe(
              'When false, disables auto-memory reads and writes for this project. Discoverable alias for `autoMemoryEnabled`; the two are equivalent and either one can be used to opt out for governance / regulated / client-sensitive repos (issue #1326). When both are set, the more restrictive (false) value wins so a parent-scope opt-out cannot be silently re-enabled by a narrower scope.',
            ),
          requireApprovalBeforeWrite: z
            .boolean()
            .optional()
            .describe(
              'Persistent auto-memory writes require explicit permission approval by default. Set to false to restore automatic memory writes when auto-memory is enabled.',
            ),
        })
        .optional()
        .describe(
          'Memory governance settings. `autoWrite` controls whether auto-memory is active; `requireApprovalBeforeWrite` forces explicit approval for persistent memory writes.',
        ),
      git: z
        .object({
          addAICoAuthor: z
            .boolean()
            .optional()
            .describe(
              'When true, opt in to the generated Co-Authored-By trailer for local commits. When false in any settings source, generated commit attribution is blocked.',
            ),
          addGeneratedWithFooter: z
            .boolean()
            .optional()
            .describe(
              'When true, opt in to the generated OpenClaude footer for PR descriptions. When false in any settings source, generated PR attribution is blocked.',
            ),
          forbiddenCommitMessagePatterns: z
            .array(z.string())
            .optional()
            .describe(
              'Literal text patterns that must not appear in git commit messages, such as "Co-Authored-By:" or "Generated with".',
            ),
        })
        .optional()
        .describe(
          'Git governance settings for AI attribution and commit-message policy.',
        ),
      autoMemoryDirectory: z
        .string()
        .optional()
        .describe(
          'Custom directory path for auto-memory storage. Supports ~/ prefix for home directory expansion. Ignored if set in projectSettings (checked-in .openclaude/settings.json) for security. When unset, defaults to ~/.openclaude/projects/<sanitized-cwd>/memory/.',
        ),
      autoDreamEnabled: z
        .boolean()
        .optional()
        .describe(
          'Enable background memory consolidation (auto-dream). When set, overrides the server-side default.',
        ),
      showThinkingSummaries: z
        .boolean()
        .optional()
        .describe(
          'Show thinking summaries in the transcript view (ctrl+o). Default: false.',
        ),
      skipDangerousModePermissionPrompt: z
        .boolean()
        .optional()
        .describe(
          'Whether the user has accepted the bypass permissions mode dialog',
        ),
      skipFullAccessModePermissionPrompt: z
        .boolean()
        .optional()
        .describe(
          'Whether the user has accepted the full access mode dialog',
        ),
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? {
            skipAutoPermissionPrompt: z
              .boolean()
              .optional()
              .describe(
                'Whether the user has accepted the auto mode opt-in dialog',
              ),
            useAutoModeDuringPlan: z
              .boolean()
              .optional()
              .describe(
                'Whether plan mode uses auto mode semantics when auto mode is available (default: true)',
              ),
            autoMode: z
              .object({
                allow: z
                  .array(z.string())
                  .optional()
                  .describe('Rules for the auto mode classifier allow section'),
                soft_deny: z
                  .array(z.string())
                  .optional()
                  .describe('Rules for the auto mode classifier deny section'),
                ...(process.env.USER_TYPE === 'ant'
                  ? {
                      // Back-compat alias for ant users; external users use soft_deny
                      deny: z.array(z.string()).optional(),
                    }
                  : {}),
                environment: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Entries for the auto mode classifier environment section',
                  ),
              })
              .optional()
              .describe('Auto mode classifier prompt customization'),
          }
        : {}),
      disableAutoMode: z
        .enum(['disable'])
        .optional()
        .describe('Disable auto mode'),
      sshConfigs: z
        .array(
          z.object({
            id: z
              .string()
              .describe(
                'Unique identifier for this SSH config. Used to match configs across settings sources.',
              ),
            name: z.string().describe('Display name for the SSH connection'),
            sshHost: z
              .string()
              .describe(
                'SSH host in format "user@hostname" or "hostname", or a host alias from ~/.ssh/config',
              ),
            sshPort: z
              .number()
              .int()
              .optional()
              .describe('SSH port (default: 22)'),
            sshIdentityFile: z
              .string()
              .optional()
              .describe('Path to SSH identity file (private key)'),
            startDirectory: z
              .string()
              .optional()
              .describe(
                'Default working directory on the remote host. ' +
                  'Supports tilde expansion (e.g. ~/projects). ' +
                  'If not specified, defaults to the remote user home directory. ' +
                  'Can be overridden by the [dir] positional argument in `claude ssh <config> [dir]`.',
              ),
          }),
        )
        .optional()
        .describe(
          'SSH connection configurations for remote environments. ' +
            'Typically set in managed settings by enterprise administrators ' +
            'to pre-configure SSH connections for team members.',
        ),
      claudeMdExcludes: z
        .array(z.string())
        .optional()
        .describe(
          'Glob patterns or absolute paths of AGENTS.md/CLAUDE.md files to exclude from loading. ' +
            'Patterns are matched against absolute file paths using picomatch. ' +
            'Only applies to User, Project, and Local memory types (Managed/policy files cannot be excluded). ' +
            'Examples: "/home/user/monorepo/AGENTS.md", "**/code/CLAUDE.md", "**/some-dir/.claude/rules/**"',
        ),
      pluginTrustMessage: z
        .string()
        .optional()
        .describe(
          'Custom message to append to the plugin trust warning shown before installation. ' +
            'Only read from policy settings (managed-settings.json / MDM). ' +
            'Useful for enterprise administrators to add organization-specific context ' +
            '(e.g., "All plugins from our internal marketplace are vetted and approved.").',
        ),
    })
    .passthrough(),
)

/**
 * Internal type for plugin hooks - includes plugin context for execution.
 * Not a Zod schema since it's not user-facing (plugins provide native hooks).
 */
export type PluginHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  pluginRoot: string
  pluginName: string
  pluginId: string // format: "pluginName@marketplaceName"
}

/**
 * Internal type for skill hooks - includes skill context for execution.
 * Not a Zod schema since it's not user-facing (skills provide native hooks).
 */
export type SkillHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  skillRoot: string
  skillName: string
}

export type AllowedMcpServerEntry = z.infer<
  ReturnType<typeof AllowedMcpServerEntrySchema>
>
export type DeniedMcpServerEntry = z.infer<
  ReturnType<typeof DeniedMcpServerEntrySchema>
>
export type SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>
export type ModelPricingEntry = z.infer<typeof ModelPricingEntrySchema>

/**
 * Type guard for MCP server entry with serverName
 */
export function isMcpServerNameEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is { serverName: string } {
  return 'serverName' in entry && entry.serverName !== undefined
}

/**
 * Type guard for MCP server entry with serverCommand
 */
export function isMcpServerCommandEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is { serverCommand: string[] } {
  return 'serverCommand' in entry && entry.serverCommand !== undefined
}

/**
 * Type guard for MCP server entry with serverUrl
 */
export function isMcpServerUrlEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is { serverUrl: string } {
  return 'serverUrl' in entry && entry.serverUrl !== undefined
}

/**
 * User configuration values for MCPB MCP servers
 */
export type UserConfigValues = Record<
  string,
  string | number | boolean | string[]
>

/**
 * Plugin configuration stored in settings.json
 */
export type PluginConfig = {
  mcpServers?: {
    [serverName: string]: UserConfigValues
  }
}
