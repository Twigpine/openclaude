// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Box, Text } from '../ink.js';
import * as React from 'react';
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT, type MemoryFileInfo } from './claudemd.js';
import figures from 'figures';
import { getCwd } from './cwd.js';
import { relative } from 'path';
import { formatNumber } from './format.js';
import type { getGlobalConfig } from './config.js';
import { getAnthropicApiKeyWithSource, getApiKeyFromConfigOrMacOSKeychain, getAuthTokenSource, isClaudeAISubscriber } from './auth.js';
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js';
import { getAgentDescriptionsTotalTokens, AGENT_DESCRIPTIONS_THRESHOLD } from './statusNoticeHelpers.js';
import { isSupportedJetBrainsTerminal, toIDEDisplayName, getTerminalIdeType } from './ide.js';
import { isJetBrainsPluginInstalledCachedSync } from './jetbrains.js';
import type { LocalModelContextWarning } from './statusNoticeLocalModel.js';
import { isDangerousPermissionMode, type PermissionMode } from './permissions/PermissionMode.js';
import { modelSupportsAutoMode } from './betas.js';
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './model/providers.js';
import { logForDebugging } from './debug.js';

// Types
export type StatusNoticeType = 'warning' | 'info';
export type StatusNoticeContext = {
  config: ReturnType<typeof getGlobalConfig>;
  agentDefinitions?: AgentDefinitionsResult;
  memoryFiles: MemoryFileInfo[];
  isLocalModel?: boolean;
  localModelContextLoad?: LocalModelContextWarning | null;
  /** Active session permission mode. Used by the 3P-safety notices. */
  permissionMode?: PermissionMode;
  /** Current main-loop model id. Used by the 3P-safety notices to decide
   * whether the AI classifier would actually run. */
  mainLoopModel?: string;
};
export type StatusNoticeDefinition = {
  id: string;
  type: StatusNoticeType;
  isActive: (context: StatusNoticeContext) => boolean;
  render: (context: StatusNoticeContext) => React.ReactNode;
};

function WarningNoticeRow({
  children,
  marginTop,
}: {
  children: React.ReactNode;
  marginTop?: number;
}): React.ReactNode {
  return <Box flexDirection="row" marginTop={marginTop}>
      <Box marginRight={1}>
        <Text color="warning">{figures.warning}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        {children}
      </Box>
    </Box>;
}

// Individual notice definitions
const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: ctx => {
    if (ctx.isLocalModel && ctx.localModelContextLoad) {
      return false;
    }
    return getLargeMemoryFiles(ctx.memoryFiles).length > 0;
  },
  render: ctx => {
    const largeMemoryFiles = getLargeMemoryFiles(ctx.memoryFiles);
    return <>
        {largeMemoryFiles.map(file => {
        const displayPath = file.path.startsWith(getCwd()) ? relative(getCwd(), file.path) : file.path;
        return <WarningNoticeRow key={file.path}>
              <Text color="warning">
                Large <Text bold>{displayPath}</Text> will impact performance (
                {formatNumber(file.content.length)} chars &gt;{' '}
                {formatNumber(MAX_MEMORY_CHARACTER_COUNT)})
                <Text dimColor> · /memory to edit</Text>
              </Text>
            </WarningNoticeRow>;
      })}
      </>;
  }
};
const claudeAiSubscriberExternalTokenNotice: StatusNoticeDefinition = {
  id: 'claude-ai-external-token',
  type: 'warning',
  isActive: () => {
    const authTokenInfo = getAuthTokenSource();
    return isClaudeAISubscriber() && (authTokenInfo.source === 'ANTHROPIC_AUTH_TOKEN' || authTokenInfo.source === 'apiKeyHelper');
  },
  render: () => {
    const authTokenInfo = getAuthTokenSource();
    return <WarningNoticeRow marginTop={1}>
        <Text color="warning">
          Auth conflict: Using {authTokenInfo.source} instead of Claude account
          subscription token. Either unset {authTokenInfo.source}, or run
          `claude /logout`.
        </Text>
      </WarningNoticeRow>;
  }
};
const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  isActive: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    return !!getApiKeyFromConfigOrMacOSKeychain() && (apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper');
  },
  render: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    return <WarningNoticeRow marginTop={1}>
        <Text color="warning">
          Auth conflict: Using {apiKeySource} instead of Anthropic Console key.
          Either unset {apiKeySource}, or run `openclaude /logout`.
        </Text>
      </WarningNoticeRow>;
  }
};
const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    const authTokenInfo = getAuthTokenSource();
    return apiKeySource !== 'none' && authTokenInfo.source !== 'none' && !(apiKeySource === 'apiKeyHelper' && authTokenInfo.source === 'apiKeyHelper');
  },
  render: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    const authTokenInfo = getAuthTokenSource();
    return <Box flexDirection="column" marginTop={1}>
        <WarningNoticeRow>
          <Text color="warning">
            Auth conflict: Both a token ({authTokenInfo.source}) and an API key
            ({apiKeySource}) are set. This may lead to unexpected behavior.
          </Text>
        </WarningNoticeRow>
        <Box flexDirection="column" marginLeft={3}>
          <Text color="warning">
            · Trying to use{' '}
            {authTokenInfo.source === 'claude.ai' ? 'claude.ai' : authTokenInfo.source}
            ?{' '}
            {apiKeySource === 'ANTHROPIC_API_KEY' ? 'Unset the ANTHROPIC_API_KEY environment variable, or claude /logout then say "No" to the API key approval before login.' : apiKeySource === 'apiKeyHelper' ? 'Unset the apiKeyHelper setting.' : 'claude /logout'}
          </Text>
          <Text color="warning">
            · Trying to use {apiKeySource}?{' '}
            {authTokenInfo.source === 'claude.ai' ? 'claude /logout to sign out of claude.ai.' : `Unset the ${authTokenInfo.source} environment variable.`}
          </Text>
        </Box>
      </Box>;
  }
};
const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: context => {
    if (context.isLocalModel && context.localModelContextLoad) {
      return false;
    }
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return totalTokens > AGENT_DESCRIPTIONS_THRESHOLD;
  },
  render: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return <WarningNoticeRow>
        <Text color="warning">
          Large cumulative agent descriptions will impact performance (~
          {formatNumber(totalTokens)} tokens &gt;{' '}
          {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)})
          <Text dimColor> · /agents to manage</Text>
        </Text>
      </WarningNoticeRow>;
  }
};
const jetbrainsPluginNotice: StatusNoticeDefinition = {
  id: 'jetbrains-plugin-install',
  type: 'info',
  isActive: context => {
    // Only show if running in JetBrains built-in terminal
    if (!isSupportedJetBrainsTerminal()) {
      return false;
    }
    // Don't show if auto-install is disabled
    const shouldAutoInstall = context.config.autoInstallIdeExtension ?? true;
    if (!shouldAutoInstall) {
      return false;
    }
    // Check if plugin is already installed (cached to avoid repeated filesystem checks)
    const ideType = getTerminalIdeType();
    return ideType !== null && !isJetBrainsPluginInstalledCachedSync(ideType);
  },
  render: () => {
    const ideType = getTerminalIdeType();
    const ideName = toIDEDisplayName(ideType);
    return <Box flexDirection="row" gap={1} marginLeft={1}>
        <Text color="ide">{figures.arrowUp}</Text>
        <Text>
          Install the <Text color="ide">{ideName}</Text> plugin from the
          JetBrains Marketplace:{' '}
          <Text bold>https://docs.claude.com/s/claude-code-jetbrains</Text>
        </Text>
      </Box>;
  }
};
const localModelContextLoadNotice: StatusNoticeDefinition = {
  id: 'local-model-context-load',
  type: 'warning',
  isActive: context => context.localModelContextLoad != null,
  render: context => {
    const warning = context.localModelContextLoad
    if (!warning) return null
    return <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color="warning">{figures.warning}</Text>
          <Text color="warning">
            Large context loaded for local model:
          </Text>
        </Box>
        {warning.lines.map((line, i) => (
          <Box key={i} flexDirection="row" marginLeft={3}>
            <Text color="warning">{'\u2212'} {line}</Text>
          </Box>
        ))}
        <Box flexDirection="row" marginLeft={3}>
          <Text dimColor>Run /doctor for details or disable noisy plugins</Text>
        </Box>
      </Box>
  }
};

// Permissive permission modes (acceptEdits, bypassPermissions, auto) suppress
// the per-tool consent prompt that normally gives the user a moment to inspect
// what the model is about to do. On first-party Claude, the AI safety
// classifier (gated by `modelSupportsAutoMode`) is the backstop that catches
// PI-driven dangerous calls in that consent-free path. For 3P providers the
// classifier never runs (betas.ts:166), so users get the consent shortcut
// without the safety net — silently. See issue #244 finding 1.
const PERMISSIVE_MODES_REQUIRING_CLASSIFIER: ReadonlyArray<PermissionMode> = [
  'acceptEdits',
  'bypassPermissions',
];
const thirdPartyPermissiveModeNotice: StatusNoticeDefinition = {
  id: 'third-party-permissive-mode',
  type: 'warning',
  isActive: ctx => {
    const mode = ctx.permissionMode;
    if (!mode || !PERMISSIVE_MODES_REQUIRING_CLASSIFIER.includes(mode)) {
      return false;
    }
    // If the active model supports the AI classifier the safety net is in place,
    // so suppress the notice even on 3P. Treat unknown model as classifier-off.
    if (ctx.mainLoopModel && modelSupportsAutoMode(ctx.mainLoopModel)) {
      return false;
    }
    return getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl();
  },
  render: ctx => {
    const mode = ctx.permissionMode;
    return <WarningNoticeRow>
        <Text color="warning">
          <Text bold>{mode}</Text> mode is active on a third-party provider.
        </Text>
        <Text dimColor>
          Tool calls run without the AI safety classifier. Inspect tool calls manually,
          especially when working with untrusted code.
        </Text>
      </WarningNoticeRow>;
  }
};
// `--dangerously-skip-permissions` (a.k.a. bypassPermissions) and `fullAccess`
// suppress the normal per-tool consent prompt, but they differ in what
// guardrails remain:
//
// - bypassPermissions still honors deny rules, user-interaction prompts,
//   content-specific ask rules, and safety-check guardrails (e.g. .git/,
//   .claude/, shell configs).
// - fullAccess skips those safety-check prompts too and is the stronger bypass.
//
// The SDK also accepts the kebab-case `full-access` alias and normalizes it to
// the internal camelCase mode, but a context may carry the external spelling
// directly. Treat both spellings as the stronger bypass so the warning does not
// accidentally downgrade to the weaker message.
//
// On first-party builds an employee-only sandbox check (Docker/Bubblewrap + no
// internet) gates these modes; external users skip the check entirely
// (setup.ts), so they are effectively "run any command with no review". Warn
// loudly. Commander resolves `--dangerously-skip-permissions` (and its `--yolo`
// alias) into the permission mode during startup, while `fullAccess` can be set
// via `--permission-mode` or settings, so this notice keys off the resolved
// `ctx.permissionMode` rather than re-scanning raw argv. That keeps it
// authoritative and avoids re-implementing commander's option arity / `--`
// semantics. See issue #244 finding 2.
function isDangerousMode(mode: PermissionMode | undefined): boolean {
  return isDangerousPermissionMode(mode) || (mode as string) === 'full-access'
}
function isFullAccessMode(mode: PermissionMode | undefined): boolean {
  return mode === 'fullAccess' || (mode as string) === 'full-access'
}
const dangerouslySkipPermissionsNotice: StatusNoticeDefinition = {
  id: 'dangerously-skip-permissions-no-sandbox',
  type: 'warning',
  isActive: ctx => isDangerousMode(ctx.permissionMode),
  render: ctx => {
    const mode = ctx.permissionMode;
    const isFullAccess = isFullAccessMode(mode);
    return <WarningNoticeRow>
        <Text color="warning">
          <Text bold>{mode}</Text> mode is active.
        </Text>
        <Text dimColor>
          {isFullAccess
            ? 'Most tool consent checks are bypassed, including safety-check prompts. Hard deny rules and user-interaction prompts still apply. Only use inside a sandbox with no internet access. Restart without the bypass flag/mode to re-enable prompts.'
            : 'Most tool consent checks are bypassed. Deny rules, user-interaction prompts, content-specific ask rules, and safety-check guardrails still apply. Only use inside a sandbox with no internet access.'}
        </Text>
      </WarningNoticeRow>
  },
};

// All notice definitions
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [largeMemoryFilesNotice, largeAgentDescriptionsNotice, localModelContextLoadNotice, claudeAiSubscriberExternalTokenNotice, apiKeyConflictNotice, bothAuthMethodsNotice, jetbrainsPluginNotice, thirdPartyPermissiveModeNotice, dangerouslySkipPermissionsNotice];

// Helper functions for external use
export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter(notice => {
    try {
      return notice.isActive(context);
    } catch (error) {
      logForDebugging(
        `status_notice_isActive_failed noticeId=${notice.id} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  });
}
