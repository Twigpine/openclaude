import { feature } from 'bun:bundle';
import { statSync } from 'fs';
import { isAbsolute } from 'path';
import * as React from 'react';
import { buildTool, type ToolDef, toolMatchesName } from 'src/Tool.js';
import type { Message as MessageType, NormalizedUserMessage } from 'src/types/message.js';
import { getQuerySourceForAgent } from 'src/utils/promptCategory.js';
import { z } from 'zod/v4';
import { clearInvokedSkillsForAgent, getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js';
import { enhanceSystemPromptWithEnvDetails, getSystemPrompt } from '../../constants/prompts.js';
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js';
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { clearDumpState } from '../../services/api/dumpPrompts.js';
import { resolveAgentRunModelRouting, resolveOutOfProcessTeammateProvider, resolveOutOfProcessTeammateModelOnly } from '../../services/api/agentRouting.js';
import { completeAgentTask as completeAsyncAgent, createActivityDescriptionResolver, createProgressTracker, enqueueAgentNotification, failAgentTask as failAsyncAgent, getProgressUpdate, getTokenCountFromTracker, isLocalAgentTask, killAsyncAgent, registerAgentForeground, registerAsyncAgent, unregisterAgentForeground, updateAgentProgress as updateAsyncAgentProgress, updateProgressFromMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { assembleToolPool } from '../../tools.js';
import { isBuiltInAgentType } from './builtInAgents.js';
import { asAgentId } from '../../types/ids.js';
import { runWithAgentContext } from '../../utils/agentContext.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js';
import { logForDebugging } from '../../utils/debug.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import {
  getCopilotMaxConcurrentSubagents,
  isCopilotPremiumOptimizationEnabled,
  shouldForceSyncSubagentsInCopilotMode,
  shouldSuppressSubagentsInCopilotMode,
} from '../../utils/copilotOptimization.js';
import { AbortError, errorMessage, toError } from '../../utils/errors.js';
import type { CacheSafeParams } from '../../utils/forkedAgent.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { logError } from '../../utils/log.js';
import { createUserMessage, extractTextContent, isSyntheticMessage, normalizeMessages } from '../../utils/messages.js';
import { getAgentModel } from '../../utils/model/agent.js';
import { isModelAllowed } from '../../utils/model/modelAllowlist.js';
import { permissionModeSchema } from '../../utils/permissions/PermissionMode.js';
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js';
import { filterDeniedAgents, getDenyRuleForAgent } from '../../utils/permissions/permissions.js';
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { writeAgentMetadata } from '../../utils/sessionStorage.js';
import { sleep } from '../../utils/sleep.js';
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js';
import { asSystemPrompt } from '../../utils/systemPromptType.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { getParentSessionId, isTeammate } from '../../utils/teammate.js';
import { isInProcessTeammate } from '../../utils/teammateContext.js';
import { getAssistantMessageContentLength } from '../../utils/tokens.js';
import { createAgentId } from '../../utils/uuid.js';
import { createAgentWorktree, hasWorktreeChanges, removeAgentWorktree } from '../../utils/worktree.js';
import { BASH_TOOL_NAME } from '../BashTool/toolName.js';
import { BackgroundHint } from '../BashTool/UI.js';
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js';
import { spawnTeammate } from '../shared/spawnMultiAgent.js';
import { setAgentColor } from './agentColorManager.js';
import { agentToolResultSchema, classifyHandoffIfNeeded, emitTaskProgress, extractPartialResult, finalizeAgentTool, getLastToolUseName, runAsyncAgentLifecycle } from './agentToolUtils.js';
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js';
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME, ONE_SHOT_BUILTIN_AGENT_TYPES } from './constants.js';
import { buildForkedMessages, buildWorktreeNotice, FORK_AGENT, isForkSubagentEnabled, isInForkChild } from './forkSubagent.js';
import { closeForegroundAgentForBackground, createForegroundAgentAbortController } from './foregroundAgentHandoff.js';
import type { AgentDefinition } from './loadAgentsDir.js';
import { filterAgentsByMcpRequirements, hasRequiredMcpServers, isBuiltInAgent } from './loadAgentsDir.js';
import { getPrompt } from './prompt.js';
import { runAgent } from './runAgent.js';
import { renderGroupedAgentToolUse, renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseRejectedMessage, renderToolUseTag, userFacingName, userFacingNameBackgroundColor } from './UI.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../proactive/index.js') as typeof import('../../proactive/index.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */

// Progress display constants (for showing background hint)
const PROGRESS_THRESHOLD_MS = 2000; // Show background hint after 2 seconds

// Check if background tasks are disabled at module load time
const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);

// Auto-background agent tasks after this many ms (0 = disabled)
// Enabled by env var OR GrowthBook gate (checked lazily since GB may not be ready at module load)
function getAutoBackgroundMs(): number {
  if (isEnvTruthy(process.env.CLAUDE_AUTO_BACKGROUND_TASKS) || getFeatureValue_CACHED_MAY_BE_STALE('tengu_auto_background_agents', false)) {
    return 120_000;
  }
  return 0;
}

// Multi-agent type constants are defined inline inside gated blocks to enable dead code elimination

// Base input schema without multi-agent parameters
const baseInputSchema = lazySchema(() => z.object({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().describe('The type of specialized agent to use for this task'),
  model: z.string().trim().min(1, 'Model cannot be empty').optional().describe("Optional model override for this agent. Accepts aliases such as sonnet, opus, haiku, inherit, or a provider-supported model ID. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent."),
  run_in_background: z.boolean().optional().describe('Set to true to run this agent in the background. You will be notified when it completes.')
}));

// Full schema combining base + multi-agent params + isolation
export const fullInputSchema = lazySchema(() => {
  // Multi-agent parameters
  const multiAgentInputSchema = z.object({
    name: z.string().optional().describe('Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.'),
    team_name: z.string().optional().describe('Team name for spawning. Uses current team context if omitted.'),
    mode: permissionModeSchema().optional().describe('Permission mode for spawned teammate (e.g., "plan" to require plan approval).')
  });
  return baseInputSchema().merge(multiAgentInputSchema).extend({
    isolation: z.enum(['worktree']).optional().describe('Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. When the session is outside a git repository (for example a parent of multiple repos), pass cwd set to the target repository root so the worktree is created from that repo.'),
    cwd: z.string().optional().describe('Absolute path to run the agent in. Overrides the working directory for all filesystem and shell operations within this agent. When isolation is "worktree", cwd selects which git repository to create the worktree from — use this when the session cwd is not itself a git repo (for example a folder parenting multiple repos).')
  }).refine(input => input.cwd === undefined || isAbsolute(input.cwd), {
    path: ['cwd'],
    message: 'cwd must be an absolute path.',
  });
});

// Strip optional fields from the schema when the backing feature is off so
// the model never sees them. Done via .omit() rather than conditional spread
// inside .extend() because the spread-ternary breaks Zod's type inference
// (field type collapses to `unknown`). The ternary return produces a union
// type, but call() destructures via the explicit AgentToolInput type below
// which always includes all optional fields.
export const inputSchema = lazySchema(() => {
  // cwd stays available in the open build so multi-repo parent sessions can
  // pin subagents (and worktree isolation) to a child repository (#2052).
  const schema = fullInputSchema();

  // GrowthBook-in-lazySchema is acceptable here (unlike subagent_type, which
  // was removed in 906da6c723): the divergence window is one-session-per-
  // gate-flip via _CACHED_MAY_BE_STALE disk read, and worst case is either
  // "schema shows a no-op param" (gate flips on mid-session: param ignored
  // by forceAsync) or "schema hides a param that would've worked" (gate
  // flips off mid-session: everything still runs async via memoized
  // forceAsync). No Zod rejection, no crash — unlike required→optional.
  return isBackgroundTasksDisabled || isForkSubagentEnabled() ? schema.omit({
    run_in_background: true
  }) : schema;
});
type InputSchema = ReturnType<typeof inputSchema>;

// Explicit type widens the schema inference to always include all optional
// fields even when .omit() strips them for gating (run_in_background).
// subagent_type is optional; call() defaults it to general-purpose when the
// fork gate is off, or routes to the fork path when the gate is on.
type AgentToolInput = z.infer<ReturnType<typeof baseInputSchema>> & {
  name?: string;
  team_name?: string;
  mode?: z.infer<ReturnType<typeof permissionModeSchema>>;
  isolation?: 'worktree';
  cwd?: string;
};
type AgentToolIsolation = AgentToolInput['isolation'];
type AgentToolWorktreeInfo = {
  worktreePath: string;
} | null | undefined;

export function resolveAgentToolEffectiveIsolation(
  requestedIsolation: AgentToolIsolation,
  agentIsolation: AgentToolIsolation,
): AgentToolIsolation {
  return requestedIsolation === 'worktree' || agentIsolation === 'worktree'
    ? 'worktree'
    : undefined;
}

/**
 * cwd may be combined with worktree isolation: it names the repository used
 * as the worktree base when the session itself is outside a git repo.
 * Relative paths are rejected so tool callers cannot depend on ambient cwd.
 * The path must exist and be a directory so spawn fails closed on typos.
 */
export function assertAgentToolCwdAllowed(
  cwd: string | undefined,
  _effectiveIsolation?: AgentToolIsolation,
): void {
  if (cwd === undefined) {
    return;
  }
  if (!isAbsolute(cwd)) {
    throw new Error('cwd must be an absolute path.');
  }
  let stats;
  try {
    stats = statSync(cwd);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cwd must be an existing directory (${reason}).`);
  }
  if (!stats.isDirectory()) {
    throw new Error('cwd must be an existing directory.');
  }
}

export function resolveAgentToolCwdOverride(
  cwd: string | undefined,
  worktreeInfo: AgentToolWorktreeInfo,
): string | undefined {
  return worktreeInfo?.worktreePath ?? cwd;
}

/** True when worktree creation failed only because no git root was available. */
export function isMissingGitAgentWorktreeError(message: string): boolean {
  return message.includes('Cannot create agent worktree: not in a git repository');
}

/**
 * User/model-visible notice when worktree isolation was requested but could
 * not be created (missing git). Edits are not isolated in a worktree copy.
 */
export function buildWorktreeIsolationFallbackNotice(cwdPath: string): string {
  return `Worktree isolation was requested but could not be created because no git repository is available. This agent is running without worktree isolation — edits modify files directly in ${cwdPath}, not an isolated worktree copy.`;
}

/** Trailer line(s) for tool results when worktree isolation fell back. */
export function formatWorktreeIsolationFallbackResultText(): string {
  return 'worktreeIsolationFallback: true\nnote: Worktree isolation was unavailable; this agent ran without an isolated worktree (edits are not sandboxed in a worktree).';
}

/** Shared async_launched payload for direct-async and sync-to-background paths. */
export function buildAsyncLaunchedToolData(args: {
  agentId: string;
  description: string;
  prompt: string;
  canReadOutputFile: boolean;
  worktreeIsolationFallback?: boolean;
}) {
  return {
    isAsync: true as const,
    status: 'async_launched' as const,
    agentId: args.agentId,
    description: args.description,
    prompt: args.prompt,
    outputFile: getTaskOutputPath(args.agentId),
    canReadOutputFile: args.canReadOutputFile,
    ...(args.worktreeIsolationFallback && { worktreeIsolationFallback: true as const }),
  };
}

// Output schema - multi-agent spawned schema added dynamically at runtime when enabled
export const outputSchema = lazySchema(() => {
  const syncOutputSchema = agentToolResultSchema().extend({
    status: z.literal('completed'),
    prompt: z.string(),
    worktreeIsolationFallback: z.boolean().optional().describe('True when worktree isolation was requested but fell back because no git repository was available'),
  });
  const asyncOutputSchema = z.object({
    status: z.literal('async_launched'),
    agentId: z.string().describe('The ID of the async agent'),
    description: z.string().describe('The description of the task'),
    prompt: z.string().describe('The prompt for the agent'),
    outputFile: z.string().describe('Path to the output file for checking agent progress'),
    canReadOutputFile: z.boolean().optional().describe('Whether the calling agent has Read/Bash tools to check progress'),
    worktreeIsolationFallback: z.boolean().optional().describe('True when worktree isolation was requested but fell back because no git repository was available'),
  });
  return z.union([syncOutputSchema, asyncOutputSchema]);
});
type OutputSchema = ReturnType<typeof outputSchema>;
type Output = z.input<OutputSchema>;

// Private type for teammate spawn results - excluded from exported schema for dead code elimination
// The 'teammate_spawned' status string is only included when ENABLE_AGENT_SWARMS is true
type TeammateSpawnedOutput = {
  status: 'teammate_spawned';
  prompt: string;
  teammate_id: string;
  agent_id: string;
  agent_type?: string;
  model?: string;
  name: string;
  color?: string;
  tmux_session_name: string;
  tmux_window_name: string;
  tmux_pane_id: string;
  team_name?: string;
  is_splitpane?: boolean;
  plan_mode_required?: boolean;
};

// Combined output type including both public and internal types
// Note: TeammateSpawnedOutput type is fine - TypeScript types are erased at compile time
type InternalOutput = Output | TeammateSpawnedOutput;
import type { AgentToolProgress, ShellProgress } from '../../types/tools.js';
// AgentTool forwards both its own progress events and shell progress
// events from the sub-agent so the SDK receives tool_progress updates during bash/powershell runs.
export type Progress = AgentToolProgress | ShellProgress;
export const AgentTool = buildTool({
  async prompt({
    agents,
    tools,
    getToolPermissionContext,
    allowedAgentTypes
  }) {
    const toolPermissionContext = await getToolPermissionContext();

    // Get MCP servers that have tools available
    const mcpServersWithTools: string[] = [];
    for (const tool of tools) {
      if (tool.name?.startsWith('mcp__')) {
        const parts = tool.name.split('__');
        const serverName = parts[1];
        if (serverName && !mcpServersWithTools.includes(serverName)) {
          mcpServersWithTools.push(serverName);
        }
      }
    }

    // Filter agents: first by MCP requirements, then by permission rules
    const agentsWithMcpRequirementsMet = filterAgentsByMcpRequirements(agents, mcpServersWithTools);
    const filteredAgents = filterDeniedAgents(agentsWithMcpRequirementsMet, toolPermissionContext, AGENT_TOOL_NAME);

    // Use inline env check instead of coordinatorModule to avoid circular
    // dependency issues during test module loading.
    const isCoordinator = feature('COORDINATOR_MODE') ? isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) : false;
    return await getPrompt(filteredAgents, isCoordinator, allowedAgentTypes);
  },
  name: AGENT_TOOL_NAME,
  searchHint: 'delegate work to a subagent',
  aliases: [LEGACY_AGENT_TOOL_NAME],
  maxResultSizeChars: 100_000,
  async description() {
    return 'Launch a new agent';
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  async call({
    prompt,
    subagent_type,
    description,
    model: modelParam,
    run_in_background,
    name,
    team_name,
    mode: spawnMode,
    isolation,
    cwd
  }: AgentToolInput, toolUseContext, canUseTool, assistantMessage, onProgress?) {
    const startTime = Date.now();
    const model = isCoordinatorMode() ? undefined : modelParam;

    // Get app state for permission mode and agent filtering
    const appState = toolUseContext.getAppState();
    const permissionSessionState = {
      appState,
      rootAppState: toolUseContext.getRootAppState?.() ?? appState
    };
    const permissionMode = appState.toolPermissionContext.mode;
    // In-process teammates get a no-op setAppState; setAppStateForTasks
    // reaches the root store so task registration/progress/kill stay visible.
    const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState;

    // Check if user is trying to use agent teams without access
    if (team_name && !isAgentSwarmsEnabled()) {
      throw new Error('Agent Teams is not yet available on your plan.');
    }

    // Teammates (in-process or tmux) passing `name` would trigger spawnTeammate()
    // below, but TeamFile.members is a flat array with one leadAgentId — nested
    // teammates land in the roster with no provenance and confuse the lead.
    const teamName = resolveTeamName({
      team_name
    }, appState);
    if (isTeammate() && teamName && name) {
      throw new Error('Teammates cannot spawn other teammates — the team roster is flat. To spawn a subagent instead, omit the `name` parameter.');
    }
    // In-process teammates cannot spawn background agents (their lifecycle is
    // tied to the leader's process). Tmux teammates are separate processes and
    // can manage their own background agents.
    if (isInProcessTeammate() && teamName && run_in_background === true) {
      throw new Error('In-process teammates cannot spawn background agents. Use run_in_background=false for synchronous subagents.');
    }

    // Check if this is a multi-agent spawn request
    // Spawn is triggered when team_name is set (from param or context) and name is provided
    if (teamName && name) {
      // Set agent definition color for grouped UI display before spawning
      const agentDef = subagent_type ? toolUseContext.options.agentDefinitions.activeAgents.find(a => a.agentType === subagent_type) : undefined;

      if (subagent_type) {
        if (agentDef) {
          if (agentDef.source === 'built-in') {
            throw new Error(`Built-in agent type '${subagent_type}' cannot be spawned as a teammate. Please omit name and team_name to use it as a standard subagent.`);
          }
        } else if (isBuiltInAgentType(subagent_type)) {
          throw new Error(`Built-in agent type '${subagent_type}' cannot be spawned as a teammate. Please omit name and team_name to use it as a standard subagent.`);
        }
      }

      if (agentDef?.color) {
        setAgentColor(subagent_type!, agentDef.color);
      }
      const rawTeammateModel = model ?? agentDef?.model;
      const resolvedTeammateModel =
        rawTeammateModel === undefined
          ? undefined
          : getAgentModel(
              agentDef?.model,
              toolUseContext.options.mainLoopModel,
              model,
              permissionMode
            );
      const routedTeammateProvider = resolveOutOfProcessTeammateProvider({
        cliModel: model,
        agentName: name,
        agentType: subagent_type,
        agentDefinitionModel: agentDef?.model,
        settings: getInitialSettings()
      });
      if (routedTeammateProvider && !isModelAllowed(routedTeammateProvider.model)) {
        throw new Error(`Model '${routedTeammateProvider.model}' is not available. Your organization restricts model selection.`);
      }
      // A model-only agentRouting route (no cross-provider creds) is dropped by the
      // provider resolver above, so resolve it separately and apply it on the next
      // spawn. The child inherits the parent provider env, so passing the model is
      // enough. Only consulted when there is no cross-provider override.
      const routedTeammateModelOnly = routedTeammateProvider
        ? undefined
        : resolveOutOfProcessTeammateModelOnly({
            cliModel: model,
            agentName: name,
            agentType: subagent_type,
            agentDefinitionModel: agentDef?.model,
            parentModel: toolUseContext.options.mainLoopModel,
            permissionMode,
            settings: getInitialSettings()
          });
      if (
        routedTeammateModelOnly &&
        routedTeammateModelOnly !== toolUseContext.options.mainLoopModel &&
        !isModelAllowed(routedTeammateModelOnly)
      ) {
        throw new Error(`Model '${routedTeammateModelOnly}' is not available. Your organization restricts model selection.`);
      }
      const result = await spawnTeammate({
        name,
        prompt,
        description,
        team_name: teamName,
        use_splitpane: true,
        plan_mode_required: spawnMode === 'plan',
        model: routedTeammateProvider?.model ?? routedTeammateModelOnly ?? resolvedTeammateModel,
        modelWasToolSpecified: model !== undefined,
        agent_type: subagent_type,
        invokingRequestId: assistantMessage?.requestId
      }, toolUseContext);

      // Type assertion uses TeammateSpawnedOutput (defined above) instead of any.
      // This type is excluded from the exported outputSchema for dead code elimination.
      // Cast through unknown because TeammateSpawnedOutput is intentionally
      // not part of the exported Output union (for dead code elimination purposes).
      const spawnResult: TeammateSpawnedOutput = {
        status: 'teammate_spawned' as const,
        prompt,
        ...result.data
      };
      return {
        data: spawnResult
      } as unknown as {
        data: Output;
      };
    }

    // Fork subagent experiment routing:
    // - subagent_type set: use it (explicit wins)
    // - subagent_type omitted, gate on: fork path (undefined)
    // - subagent_type omitted, gate off: default general-purpose
    const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
    const isForkPath = effectiveType === undefined;
    let selectedAgent: AgentDefinition;
    if (isForkPath) {
      // Recursive fork guard: fork children keep the Agent tool in their
      // pool for cache-identical tool defs, so reject fork attempts at call
      // time. Primary check is querySource (compaction-resistant — set on
      // context.options at spawn time, survives autocompact's message
      // rewrite). Message-scan fallback catches any path where querySource
      // wasn't threaded.
      if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` || isInForkChild(toolUseContext.messages)) {
        throw new Error('Fork is not available inside a forked worker. Complete your task directly using your tools.');
      }
      selectedAgent = FORK_AGENT;
    } else {
      // Filter agents to exclude those denied via Agent(AgentName) syntax
      const allAgents = toolUseContext.options.agentDefinitions.activeAgents;
      const {
        allowedAgentTypes
      } = toolUseContext.options.agentDefinitions;
      const agents = filterDeniedAgents(
      // When allowedAgentTypes is set (from Agent(x,y) tool spec), restrict to those types
      allowedAgentTypes ? allAgents.filter(a => allowedAgentTypes.includes(a.agentType)) : allAgents, appState.toolPermissionContext, AGENT_TOOL_NAME);
      const found = agents.find(agent => agent.agentType === effectiveType);
      if (!found) {
        // Check if the agent exists but is denied by permission rules
        const agentExistsButDenied = allAgents.find(agent => agent.agentType === effectiveType);
        if (agentExistsButDenied) {
          const denyRule = getDenyRuleForAgent(appState.toolPermissionContext, AGENT_TOOL_NAME, effectiveType);
          throw new Error(`Agent type '${effectiveType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${effectiveType})' from ${denyRule?.source ?? 'settings'}.`);
        }
        throw new Error(`Agent type '${effectiveType}' not found. Available agents: ${agents.map(a => a.agentType).join(', ')}`);
      }
      selectedAgent = found;
    }

    // Same lifecycle constraint as the run_in_background guard above, but for
    // agent definitions that force background via `background: true`. Checked
    // here because selectedAgent is only now resolved.
    if (isInProcessTeammate() && teamName && selectedAgent.background === true) {
      throw new Error(`In-process teammates cannot spawn background agents. Agent '${selectedAgent.agentType}' has background: true in its definition.`);
    }

    // Capture for type narrowing — `let selectedAgent` prevents TS from
    // narrowing property types across the if-else assignment above.
    const requiredMcpServers = selectedAgent.requiredMcpServers;

    // Check if required MCP servers have tools available
    // A server that's connected but not authenticated won't have any tools
    if (requiredMcpServers?.length) {
      // If any required servers are still pending (connecting), wait for them
      // before checking tool availability. This avoids a race condition where
      // the agent is invoked before MCP servers finish connecting.
      const hasPendingRequiredServers = appState.mcp.clients.some(c => c.type === 'pending' && requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())));
      let currentAppState = appState;
      if (hasPendingRequiredServers) {
        const MAX_WAIT_MS = 30_000;
        const POLL_INTERVAL_MS = 500;
        const deadline = Date.now() + MAX_WAIT_MS;
        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          currentAppState = toolUseContext.getAppState();

          // Early exit: if any required server has already failed, no point
          // waiting for other pending servers — the check will fail regardless.
          const hasFailedRequiredServer = currentAppState.mcp.clients.some(c => c.type === 'failed' && requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())));
          if (hasFailedRequiredServer) break;
          const stillPending = currentAppState.mcp.clients.some(c => c.type === 'pending' && requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())));
          if (!stillPending) break;
        }
      }

      // Get servers that actually have tools (meaning they're connected AND authenticated)
      const serversWithTools: string[] = [];
      for (const tool of currentAppState.mcp.tools) {
        if (tool.name?.startsWith('mcp__')) {
          // Extract server name from tool name (format: mcp__serverName__toolName)
          const parts = tool.name.split('__');
          const serverName = parts[1];
          if (serverName && !serversWithTools.includes(serverName)) {
            serversWithTools.push(serverName);
          }
        }
      }
      if (!hasRequiredMcpServers(selectedAgent, serversWithTools)) {
        const missing = requiredMcpServers.filter(pattern => !serversWithTools.some(server => server.toLowerCase().includes(pattern.toLowerCase())));
        throw new Error(`Agent '${selectedAgent.agentType}' requires MCP servers matching: ${missing.join(', ')}. ` + `MCP servers with tools: ${serversWithTools.length > 0 ? serversWithTools.join(', ') : 'none'}. ` + `Use /mcp to configure and authenticate the required MCP servers.`);
      }
    }

    // Initialize the color for this agent if it has a predefined one
    if (selectedAgent.color) {
      setAgentColor(selectedAgent.agentType, selectedAgent.color);
    }

    const forceSyncCopilot = shouldForceSyncSubagentsInCopilotMode();
    const forcePlanModeSync = permissionMode === 'plan' || toolUseContext.getAppState().toolPermissionContext.mode === 'plan';

    // Use inline env check instead of coordinatorModule to avoid circular
    // dependency issues during test module loading.
    const isCoordinator = feature('COORDINATOR_MODE') ? isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) : false;

    // Fork subagent experiment: force ALL spawns async for a unified
    // <task-notification> interaction model (not just fork spawns — all of them).
    const forceAsync = isForkSubagentEnabled();

    // Assistant mode: force all agents async. Synchronous subagents hold the
    // main loop's turn open until they complete — the daemon's inputQueue
    // backs up, and the first overdue cron catch-up on spawn becomes N
    // serial subagent turns blocking all user input. Same gate as
    // executeForkedSlashCommand's fire-and-forget path; the
    // <task-notification> re-entry there is handled by the else branch
    // below (registerAsyncAgentTask + notifyOnCompletion).
    const assistantForceAsync = feature('KAIROS') ? appState.kairosEnabled : false;

    // Compute shouldRunAsync once, used by both the telemetry log below and
    // the actual run decision. Must be computed before the telemetry so the
    // reported is_async matches the actual execution mode.
    if (shouldSuppressSubagentsInCopilotMode()) {
      throw new Error(
        `Sub-agents are disabled in GitHub Copilot mode to conserve Premium Requests. ` +
        `Run this task directly instead of delegating to Agent('${selectedAgent.agentType}'). ` +
        `To re-enable sub-agents, set GITHUB_COPILOT_MAX_SUBAGENTS=1, GITHUB_COPILOT_ALLOW_SUBAGENTS=1, ` +
        `or GITHUB_COPILOT_OPTIMIZATION_DISABLED=1.`,
      );
    }
    const shouldRunAsync = forceSyncCopilot || forcePlanModeSync
      ? false
      : (run_in_background === true || selectedAgent.background === true || isCoordinator || forceAsync || assistantForceAsync || (proactiveModule?.isProactiveActive() ?? false)) && !isBackgroundTasksDisabled;

    // Resolve agent params for logging and prebuilt system prompts. runAgent
    // resolves the same settings again before the actual query.
    const resolvedAgentModel = getAgentModel(selectedAgent.model, toolUseContext.options.mainLoopModel, isForkPath ? undefined : model, permissionMode);
    const { mainLoopModel: effectiveAgentModel } = resolveAgentRunModelRouting({
      resolvedAgentModel,
      parentModel: toolUseContext.options.mainLoopModel,
      toolSpecifiedModel: isForkPath ? undefined : model,
      agentName: name,
      subagentType: selectedAgent.agentType,
      agentDefinitionModel: selectedAgent.model,
      settings: getInitialSettings(),
      permissionMode,
    });
    logEvent('tengu_agent_tool_selected', {
      agent_type: selectedAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      model: effectiveAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: selectedAgent.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      color: selectedAgent.color as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      is_built_in_agent: isBuiltInAgent(selectedAgent),
      is_resume: false,
      is_async: shouldRunAsync,
      is_fork: isForkPath
    });

    // Agent frontmatter can force worktree isolation too; cwd may still be
    // supplied as the repository root for that worktree (#2052).
    const effectiveIsolation = resolveAgentToolEffectiveIsolation(
      isolation,
      selectedAgent.isolation,
    );
    assertAgentToolCwdAllowed(cwd, effectiveIsolation);
    // System prompt + prompt messages: branch on fork path.
    //
    // Fork path: child inherits the PARENT's system prompt (not FORK_AGENT's)
    // for cache-identical API request prefixes. Prompt messages are built via
    // buildForkedMessages() which clones the parent's full assistant message
    // (all tool_use blocks) + placeholder tool_results + per-child directive.
    //
    // Normal path: build the selected agent's own system prompt with env
    // details, and use a simple user message for the prompt.
    let enhancedSystemPrompt: string[] | undefined;
    let forkParentSystemPrompt: ReturnType<typeof buildEffectiveSystemPrompt> | undefined;
    let promptMessages: MessageType[];
    if (isForkPath) {
      if (toolUseContext.renderedSystemPrompt) {
        forkParentSystemPrompt = toolUseContext.renderedSystemPrompt;
      } else {
        // Fallback: recompute. May diverge from parent's cached bytes if
        // GrowthBook state changed between parent turn-start and fork spawn.
        const mainThreadAgentDefinition = appState.agent ? appState.agentDefinitions.activeAgents.find(a => a.agentType === appState.agent) : undefined;
        const additionalWorkingDirectories = Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys());
        const defaultSystemPrompt = await getSystemPrompt(toolUseContext.options.tools, toolUseContext.options.mainLoopModel, additionalWorkingDirectories, toolUseContext.options.mcpClients);
        forkParentSystemPrompt = buildEffectiveSystemPrompt({
          mainThreadAgentDefinition,
          toolUseContext,
          customSystemPrompt: toolUseContext.options.customSystemPrompt,
          defaultSystemPrompt,
          appendSystemPrompt: toolUseContext.options.appendSystemPrompt
        });
      }
      promptMessages = buildForkedMessages(prompt, assistantMessage);
    } else {
      try {
        const additionalWorkingDirectories = Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys());

        // All agents have getSystemPrompt - pass toolUseContext to all
        const agentPrompt = selectedAgent.getSystemPrompt({
          toolUseContext
        });

        // Log agent memory loaded event for subagents
        if (selectedAgent.memory) {
          logEvent('tengu_agent_memory_loaded', {
            scope: selectedAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            source: 'subagent' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
        }

        // Apply environment details enhancement
        enhancedSystemPrompt = await enhanceSystemPromptWithEnvDetails([agentPrompt], effectiveAgentModel, additionalWorkingDirectories);
      } catch (error) {
        logForDebugging(`Failed to get system prompt for agent ${selectedAgent.agentType}: ${errorMessage(error)}`);
      }
      promptMessages = [createUserMessage({
        content: prompt
      })];
    }
    const metadata = {
      prompt,
      resolvedAgentModel: effectiveAgentModel,
      isBuiltInAgent: isBuiltInAgent(selectedAgent),
      startTime,
      agentType: selectedAgent.agentType,
      isAsync: shouldRunAsync
    };
    // Use inline env check instead of coordinatorModule to avoid circular
    // dependency issues during test module loading.
    // (isCoordinator / forceAsync / assistantForceAsync already computed
    // above; shouldRunAsync is the single source of truth for the launch
    // decision. Throws above are gone — they're at the top now.)
    if (forceSyncCopilot) {
      const reason = isEnvTruthy(process.env.GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS)
        ? 'GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS=1'
        : `GITHUB_COPILOT_MAX_SUBAGENTS=${getCopilotMaxConcurrentSubagents()} (concurrency capped)`;
      // The remediation depends on the actual cause:
      //   - FORCE_SYNC=1 → user must unset it (or set OPTIMIZATION_DISABLED=1)
      //   - MAX=0 → sub-agents are suppressed (NOT just forced sync) — user must
      //     raise MAX to >=1 or set ALLOW_SUBAGENTS=1
      //   - MAX>=1 → sub-agents run synchronously one-at-a-time; to restore
      //     parallel execution set ALLOW_SUBAGENTS=1 or OPTIMIZATION_DISABLED=1
      const isForcedSync = isEnvTruthy(
        process.env.GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS,
      );
      const remediation = isForcedSync
        ? 'Unset GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS, or set GITHUB_COPILOT_OPTIMIZATION_DISABLED=1, ' +
          'to allow background sub-agents.'
        : getCopilotMaxConcurrentSubagents() === 0
        ? 'Set GITHUB_COPILOT_MAX_SUBAGENTS=1 (or higher) along with GITHUB_COPILOT_ALLOW_SUBAGENTS=1, ' +
          'or GITHUB_COPILOT_OPTIMIZATION_DISABLED=1, to allow background sub-agents.'
        : 'Set GITHUB_COPILOT_ALLOW_SUBAGENTS=1, or GITHUB_COPILOT_OPTIMIZATION_DISABLED=1, ' +
          'to allow background sub-agents.';
      logForDebugging(
        `[CopilotOptimization] Agent '${selectedAgent.agentType}' forced to synchronous execution ` +
        `because ${reason}. ${remediation}`,
      );
    }
    // Assemble the worker's tool pool independently of the parent's.
    // Workers always get their tools from assembleToolPool with their own
    // permission mode, so they aren't affected by the parent's tool
    // restrictions. This is computed here so that runAgent doesn't need to
    // import from tools.ts (which would create a circular dependency).
    const workerPermissionContext = {
      ...appState.toolPermissionContext,
      mode: selectedAgent.permissionMode ?? 'acceptEdits'
    };
    const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools);

    // Create a stable agent ID early so it can be used for worktree slug
    const earlyAgentId = createAgentId();

    // Set up worktree isolation if requested
    let worktreeInfo: {
      worktreePath: string;
      worktreeBranch?: string;
      headCommit?: string;
      gitRoot?: string;
      hookBased?: boolean;
    } | null = null;
    let worktreeIsolationFallback = false;
    if (effectiveIsolation === 'worktree') {
      const slug = `agent-${earlyAgentId.slice(0, 8)}`;
      try {
        // When the session is outside a git repo (e.g. a parent of multiple
        // repos), cwd names the child repository used as the worktree base.
        worktreeInfo = await createAgentWorktree(slug, cwd ? { cwd } : undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingGitAgentWorktreeError(message)) {
          // Fall back for both explicit and agent-definition isolation so
          // multi-repo parent sessions can still spawn subagents (#2052).
          // Prefer the caller-supplied cwd when present so the agent still
          // lands inside the target child repository without a worktree.
          worktreeIsolationFallback = true;
          logForDebugging(
            cwd
              ? `Agent worktree isolation unavailable outside a git repository; falling back to cwd override ${cwd}.`
              : 'Agent worktree isolation unavailable outside a git repository; falling back to the current working directory.',
          );
        } else {
          throw error;
        }
      }
    }

    // Fork + worktree: inject a notice telling the child to translate paths
    // and re-read potentially stale files. Appended after the fork directive
    // so it appears as the most recent guidance the child sees.
    if (isForkPath && worktreeInfo) {
      promptMessages.push(createUserMessage({
        // parentCwd must remain the session cwd: inherited context paths are
        // relative to the parent agent, even when worktree creation used a
        // child-repo cwd override for multi-repo parents.
        content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath)
      }));
    }
    // Missing-git soft-fallback: tell the child edits are not worktree-isolated.
    if (worktreeIsolationFallback) {
      promptMessages.push(createUserMessage({
        content: buildWorktreeIsolationFallbackNotice(cwd ?? getCwd())
      }));
    }
    const runAgentParams: Parameters<typeof runAgent>[0] = {
      agentDefinition: selectedAgent,
      promptMessages,
      toolUseContext,
      canUseTool,
      isAsync: shouldRunAsync,
      querySource: toolUseContext.options.querySource ?? getQuerySourceForAgent(selectedAgent.agentType, isBuiltInAgent(selectedAgent)),
      model: isForkPath ? undefined : model,
      // Fork path: pass parent's system prompt AND parent's exact tool
      // array (cache-identical prefix). workerTools is rebuilt under
      // permissionMode 'bubble' which differs from the parent's mode, so
      // its tool-def serialization diverges and breaks cache at the first
      // differing tool. useExactTools also inherits the parent's
      // thinkingConfig and isNonInteractiveSession (see runAgent.ts).
      //
      // Normal path: when a cwd override is in effect (worktree isolation
      // or explicit cwd), skip the pre-built system prompt so runAgent's
      // buildAgentSystemPrompt() runs inside wrapWithCwd where getCwd()
      // returns the override path.
      override: isForkPath ? {
        systemPrompt: forkParentSystemPrompt
      } : enhancedSystemPrompt && !worktreeInfo && !cwd ? {
        systemPrompt: asSystemPrompt(enhancedSystemPrompt)
      } : undefined,
      availableTools: isForkPath ? toolUseContext.options.tools : workerTools,
      // Pass parent conversation when the fork-subagent path needs full
      // context. useExactTools inherits thinkingConfig (runAgent.ts:624).
      forkContextMessages: isForkPath ? toolUseContext.messages : undefined,
      ...(isForkPath && {
        useExactTools: true
      }),
      worktreePath: worktreeInfo?.worktreePath,
      // Always persist an explicit child-repo cwd so resume can fall back to
      // it if the worktree is later removed or cleaned up (#2052).
      cwd,
      description,
      agentName: name,
      permissionSessionState,
    };

    // Helper to wrap execution with a cwd override. Worktree wins if present;
    // otherwise an explicit cwd pins the agent to a child repo / directory.
    const cwdOverridePath = resolveAgentToolCwdOverride(cwd, worktreeInfo);
    const wrapWithCwd = <T,>(fn: () => T): T => cwdOverridePath ? runWithCwdOverride(cwdOverridePath, fn) : fn();

    // Helper to clean up worktree after agent completes
    const cleanupWorktreeIfNeeded = async (): Promise<{
      worktreePath?: string;
      worktreeBranch?: string;
    }> => {
      if (!worktreeInfo) return {};
      const {
        worktreePath,
        worktreeBranch,
        headCommit,
        gitRoot,
        hookBased
      } = worktreeInfo;
      // Null out to make idempotent — guards against double-call if code
      // between cleanup and end of try throws into catch
      worktreeInfo = null;
      if (hookBased) {
        // Hook-based worktrees are always kept since we can't detect VCS changes
        logForDebugging(`Hook-based agent worktree kept at: ${worktreePath}`);
        return {
          worktreePath
        };
      }
      if (headCommit) {
        const changed = await hasWorktreeChanges(worktreePath, headCommit);
        if (!changed) {
          await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot);
          // Clear worktreePath from metadata so resume doesn't try to use
          // a deleted directory, but keep an explicit child-repo cwd when
          // present so resume can still land in the target repository.
          void writeAgentMetadata(asAgentId(earlyAgentId), {
            agentType: selectedAgent.agentType,
            source: selectedAgent.source,
            ...(cwd && { cwd }),
            ...(description && { description }),
          }).catch(_err => logForDebugging(`Failed to clear worktree metadata: ${_err}`));
          return {};
        }
      }
      logForDebugging(`Agent worktree has changes, keeping: ${worktreePath}`);
      return {
        worktreePath,
        worktreeBranch
      };
    };
    if (shouldRunAsync) {
      const asyncAgentId = earlyAgentId;
      const agentBackgroundTask = registerAsyncAgent({
        agentId: asyncAgentId,
        description,
        prompt,
        selectedAgent,
        setAppState: rootSetAppState,
        // Don't link to parent's abort controller -- background agents should
        // survive when the user presses ESC to cancel the main thread.
        // They are killed explicitly via chat:killAgents.
        toolUseId: toolUseContext.toolUseId
      });

      // Register name → agentId for SendMessage routing. Post-registerAsyncAgent
      // so we don't leave a stale entry if spawn fails. Sync agents skipped —
      // coordinator is blocked, so SendMessage routing doesn't apply.
      if (name) {
        rootSetAppState(prev => {
          const next = new Map(prev.agentNameRegistry);
          next.set(name, asAgentId(asyncAgentId));
          return {
            ...prev,
            agentNameRegistry: next
          };
        });
      }

      // Wrap async agent execution in agent context for analytics attribution
      const asyncAgentContext = {
        agentId: asyncAgentId,
        // For subagents from teammates: use team lead's session
        // For subagents from main REPL: undefined (no parent session)
        parentSessionId: getParentSessionId(),
        agentType: 'subagent' as const,
        subagentName: selectedAgent.agentType,
        isBuiltIn: isBuiltInAgent(selectedAgent),
        invokingRequestId: assistantMessage?.requestId,
        invocationKind: 'spawn' as const,
        invocationEmitted: false
      };

      // Workload propagation: handlePromptSubmit wraps the entire turn in
      // runWithWorkload (AsyncLocalStorage). ALS context is captured at
      // invocation time — when this `void` fires — and survives every await
      // inside. No capture/restore needed; the detached closure sees the
      // parent turn's workload automatically, isolated from its finally.
      void runWithAgentContext(asyncAgentContext, () => wrapWithCwd(() => runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams => runAgent({
          ...runAgentParams,
          override: {
            ...runAgentParams.override,
            agentId: asAgentId(agentBackgroundTask.agentId),
            abortController: agentBackgroundTask.abortController!
          },
          onCacheSafeParams
        }),
        metadata,
        description,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: asyncAgentId,
        enableSummarization: isCoordinator || isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: cleanupWorktreeIfNeeded
      })));
      const canReadOutputFile = toolUseContext.options.tools.some(t => toolMatchesName(t, FILE_READ_TOOL_NAME) || toolMatchesName(t, BASH_TOOL_NAME));
      return {
        data: buildAsyncLaunchedToolData({
          agentId: agentBackgroundTask.agentId,
          description,
          prompt,
          canReadOutputFile,
          worktreeIsolationFallback,
        }),
      };
    } else {
      // Create an explicit agentId for sync agents
      const syncAgentId = asAgentId(earlyAgentId);

      // Set up agent context for sync execution (for analytics attribution)
      const syncAgentContext = {
        agentId: syncAgentId,
        // For subagents from teammates: use team lead's session
        // For subagents from main REPL: undefined (no parent session)
        parentSessionId: getParentSessionId(),
        agentType: 'subagent' as const,
        subagentName: selectedAgent.agentType,
        isBuiltIn: isBuiltInAgent(selectedAgent),
        invokingRequestId: assistantMessage?.requestId,
        invocationKind: 'spawn' as const,
        invocationEmitted: false
      };

      // Wrap entire sync agent execution in context for analytics attribution
      // and optionally in a worktree cwd override for filesystem isolation
      return runWithAgentContext(syncAgentContext, () => wrapWithCwd(async () => {
        const agentMessages: MessageType[] = [];
        const agentStartTime = Date.now();
        const syncTracker = createProgressTracker();
        const syncResolveActivity = createActivityDescriptionResolver(toolUseContext.options.tools);

        // Yield initial progress message to carry metadata (prompt)
        if (promptMessages.length > 0) {
          const normalizedPromptMessages = normalizeMessages(promptMessages);
          const normalizedFirstMessage = normalizedPromptMessages.find((m): m is NormalizedUserMessage => m.type === 'user');
          if (normalizedFirstMessage && normalizedFirstMessage.type === 'user' && onProgress) {
            onProgress({
              toolUseID: `agent_${assistantMessage.message.id}`,
              data: {
                message: normalizedFirstMessage,
                type: 'agent_progress',
                prompt,
                agentId: syncAgentId
              }
            });
          }
        }

        // Register as foreground task immediately so it can be backgrounded at any time
        // Skip registration if background tasks are disabled
        let foregroundTaskId: string | undefined;
        // Create the background race promise once outside the loop — otherwise
        // each iteration adds a new .then() reaction to the same pending
        // promise, accumulating callbacks for the lifetime of the agent.
        let backgroundPromise: Promise<{
          type: 'background';
        }> | undefined;
        let cancelAutoBackground: (() => void) | undefined;
        if (!isBackgroundTasksDisabled && !forceSyncCopilot && !forcePlanModeSync) {
          const registration = registerAgentForeground({
            agentId: syncAgentId,
            description,
            prompt,
            selectedAgent,
            setAppState: rootSetAppState,
            toolUseId: toolUseContext.toolUseId,
            autoBackgroundMs: getAutoBackgroundMs() || undefined
          });
          foregroundTaskId = registration.taskId;
          backgroundPromise = registration.backgroundSignal.then(() => ({
            type: 'background' as const
          }));
          cancelAutoBackground = registration.cancelAutoBackground;
        }

        // Track if we've shown the background hint UI
        let backgroundHintShown = false;
        // Track if the agent was backgrounded (cleanup handled by backgrounded finally)
        let wasBackgrounded = false;
        // Per-scope stop function — NOT shared with the backgrounded closure.
        // idempotent: startAgentSummarization's stop() checks `stopped` flag.
        let stopForegroundSummarization: (() => void) | undefined;
        // const capture for sound type narrowing inside the callback below
        const summaryTaskId = foregroundTaskId;
        const foregroundAbortController = foregroundTaskId ? createForegroundAgentAbortController(toolUseContext.abortController) : undefined;

        // Get async iterator for the agent
        const agentIterator = runAgent({
          ...runAgentParams,
          override: {
            ...runAgentParams.override,
            agentId: syncAgentId,
            ...(foregroundAbortController && {
              abortController: foregroundAbortController
            })
          },
          onCacheSafeParams: summaryTaskId && getSdkAgentProgressSummariesEnabled() ? (params: CacheSafeParams) => {
            const {
              stop
            } = startAgentSummarization(summaryTaskId, syncAgentId, params, rootSetAppState);
            stopForegroundSummarization = stop;
          } : undefined
        })[Symbol.asyncIterator]();

        // Track if an error occurred during iteration
        let syncAgentError: Error | undefined;
        let wasAborted = false;
        let worktreeResult: {
          worktreePath?: string;
          worktreeBranch?: string;
        } = {};
        try {
          while (true) {
            const elapsed = Date.now() - agentStartTime;

            // Show background hint after threshold (but task is already registered)
            // Skip if background tasks are disabled or if Copilot mode is
            // forcing synchronous execution (no foreground registration, so
            // the hint would advertise a non-existent affordance).
            if (!isBackgroundTasksDisabled && !forceSyncCopilot && !forcePlanModeSync && !backgroundHintShown && elapsed >= PROGRESS_THRESHOLD_MS && toolUseContext.setToolJSX) {
              backgroundHintShown = true;
              toolUseContext.setToolJSX({
                jsx: <BackgroundHint />,
                shouldHidePromptInput: false,
                shouldContinueAnimation: true,
                showSpinner: true
              });
            }

            // Race between next message and background signal
            // If background tasks are disabled, just await the next message directly
            const nextMessagePromise = agentIterator.next();
            const raceResult = backgroundPromise ? await Promise.race([nextMessagePromise.then(r => ({
              type: 'message' as const,
              result: r
            })), backgroundPromise]) : {
              type: 'message' as const,
              result: await nextMessagePromise
            };

            // Check if we were backgrounded via backgroundAll()
            // foregroundTaskId is guaranteed to be defined if raceResult.type is 'background'
            // because backgroundPromise is only defined when foregroundTaskId is defined
            if (raceResult.type === 'background' && foregroundTaskId) {
              const appState = toolUseContext.getAppState();
              const task = appState.tasks[foregroundTaskId];
              if (isLocalAgentTask(task) && task.isBackgrounded) {
                // Capture the taskId for use in the async callback
                const backgroundedTaskId = foregroundTaskId;
                wasBackgrounded = true;
                // Stop foreground summarization; the backgrounded closure
                // below owns its own independent stop function.
                stopForegroundSummarization?.();

                // Workload: inherited via ALS at `void` invocation time,
                // same as the async-from-start path above.
                // Continue agent in background and return async result
                void runWithAgentContext(syncAgentContext, async () => {
                  let stopBackgroundedSummarization: (() => void) | undefined;
                  try {
                    // Clean up the foreground iterator so its finally block runs
                    // (releases MCP connections, session hooks, prompt cache tracking, etc.)
                    // Timeout prevents blocking if MCP server cleanup hangs.
                    // .catch() prevents unhandled rejection if timeout wins the race.
                    await closeForegroundAgentForBackground(foregroundAbortController!, () => agentIterator.return(undefined));
                    // Initialize progress tracking from existing messages
                    const tracker = createProgressTracker();
                    const resolveActivity2 = createActivityDescriptionResolver(toolUseContext.options.tools);
                    for (const existingMsg of agentMessages) {
                      updateProgressFromMessage(tracker, existingMsg, resolveActivity2, toolUseContext.options.tools);
                    }
                    for await (const msg of runAgent({
                      ...runAgentParams,
                      isAsync: true,
                      // Agent is now running in background
                      override: {
                        ...runAgentParams.override,
                        agentId: asAgentId(backgroundedTaskId),
                        abortController: task.abortController
                      },
                      onCacheSafeParams: getSdkAgentProgressSummariesEnabled() ? (params: CacheSafeParams) => {
                        const {
                          stop
                        } = startAgentSummarization(backgroundedTaskId, asAgentId(backgroundedTaskId), params, rootSetAppState);
                        stopBackgroundedSummarization = stop;
                      } : undefined
                    })) {
                      agentMessages.push(msg);

                      // Track progress for backgrounded agents
                      updateProgressFromMessage(tracker, msg, resolveActivity2, toolUseContext.options.tools);
                      updateAsyncAgentProgress(backgroundedTaskId, getProgressUpdate(tracker), rootSetAppState);
                      const lastToolName = getLastToolUseName(msg);
                      if (lastToolName) {
                        emitTaskProgress(tracker, backgroundedTaskId, toolUseContext.toolUseId, description, startTime, lastToolName);
                      }
                    }
                    const agentResult = finalizeAgentTool(agentMessages, backgroundedTaskId, metadata);

                    // Transcript writes are awaited by runAgent; completion joins the output link.
                    // Keep notification embellishments after the terminal state (gh-20236).
                    if (!await completeAsyncAgent(agentResult, rootSetAppState)) return;

                    // Extract text from agent result content for the notification
                    let finalMessage = extractTextContent(agentResult.content, '\n');
                    if (feature('TRANSCRIPT_CLASSIFIER')) {
                      const backgroundedAppState = toolUseContext.getAppState();
                      const handoffWarning = await classifyHandoffIfNeeded({
                        agentMessages,
                        tools: toolUseContext.options.tools,
                        toolPermissionContext: backgroundedAppState.toolPermissionContext,
                        abortSignal: task.abortController!.signal,
                        subagentType: selectedAgent.agentType,
                        totalToolUseCount: agentResult.totalToolUseCount
                      });
                      if (handoffWarning) {
                        finalMessage = `${handoffWarning}\n\n${finalMessage}`;
                      }
                    }

                    // Clean up worktree before notification so we can include it
                    const worktreeResult = await cleanupWorktreeIfNeeded();
                    enqueueAgentNotification({
                      taskId: backgroundedTaskId,
                      description,
                      status: 'completed',
                      setAppState: rootSetAppState,
                      finalMessage,
                      usage: {
                        totalTokens: getTokenCountFromTracker(tracker),
                        toolUses: agentResult.totalToolUseCount,
                        durationMs: agentResult.totalDurationMs
                      },
                      toolUseId: toolUseContext.toolUseId,
                      ...worktreeResult
                    });
                  } catch (error) {
                    if (error instanceof AbortError) {
                      // Transition status BEFORE worktree cleanup so
                      // TaskOutput unblocks even if git hangs (gh-20236).
                      killAsyncAgent(backgroundedTaskId, rootSetAppState);
                      logEvent('tengu_agent_tool_terminated', {
                        agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        duration_ms: Date.now() - metadata.startTime,
                        is_async: true,
                        is_built_in_agent: metadata.isBuiltInAgent,
                        reason: 'user_cancel_background' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
                      });
                      const worktreeResult = await cleanupWorktreeIfNeeded();
                      const partialResult = extractPartialResult(agentMessages);
                      enqueueAgentNotification({
                        taskId: backgroundedTaskId,
                        description,
                        status: 'killed',
                        setAppState: rootSetAppState,
                        toolUseId: toolUseContext.toolUseId,
                        finalMessage: partialResult,
                        ...worktreeResult
                      });
                      return;
                    }
                    const errMsg = errorMessage(error);
                    failAsyncAgent(backgroundedTaskId, errMsg, rootSetAppState);
                    const worktreeResult = await cleanupWorktreeIfNeeded();
                    enqueueAgentNotification({
                      taskId: backgroundedTaskId,
                      description,
                      status: 'failed',
                      error: errMsg,
                      setAppState: rootSetAppState,
                      toolUseId: toolUseContext.toolUseId,
                      ...worktreeResult
                    });
                  } finally {
                    stopBackgroundedSummarization?.();
                    // Defensive cleanup: wrap each call so one failure doesn't
                    // prevent the other from running. Without this, if
                    // clearInvokedSkillsForAgent throws, clearDumpState is
                    // skipped and dump state leaks.
                    try { clearInvokedSkillsForAgent(syncAgentId); } catch { /* cleanup best-effort */ }
                    try { clearDumpState(syncAgentId); } catch { /* cleanup best-effort */ }
                  }
                });

                // Return async_launched result immediately
                const canReadOutputFile = toolUseContext.options.tools.some(t => toolMatchesName(t, FILE_READ_TOOL_NAME) || toolMatchesName(t, BASH_TOOL_NAME));
                return {
                  data: buildAsyncLaunchedToolData({
                    agentId: backgroundedTaskId,
                    description,
                    prompt,
                    canReadOutputFile,
                    worktreeIsolationFallback,
                  }),
                };
              }
            }

            // Process the message from the race result
            if (raceResult.type !== 'message') {
              // This shouldn't happen - background case handled above
              continue;
            }
            const {
              result
            } = raceResult;
            if (result.done) break;
            const message = result.value;
            agentMessages.push(message);

            // Emit task_progress for the VS Code subagent panel
            updateProgressFromMessage(syncTracker, message, syncResolveActivity, toolUseContext.options.tools);
            if (foregroundTaskId) {
              const lastToolName = getLastToolUseName(message);
              if (lastToolName) {
                emitTaskProgress(syncTracker, foregroundTaskId, toolUseContext.toolUseId, description, agentStartTime, lastToolName);
                // Keep AppState task.progress in sync when SDK summaries are
                // enabled, so updateAgentSummary reads correct token/tool counts
                // instead of zeros.
                if (getSdkAgentProgressSummariesEnabled()) {
                  updateAsyncAgentProgress(foregroundTaskId, getProgressUpdate(syncTracker), rootSetAppState);
                }
              }
            }

            // Forward progress from long-running sub-agent tools so the parent
            // query remains active while the child is doing bounded work.
            if (message.type === 'progress' && (message.data.type === 'bash_progress' || message.data.type === 'powershell_progress' || message.data.type === 'mcp_progress' || message.data.type === 'waiting_for_task') && onProgress) {
              try {
                onProgress({
                  toolUseID: message.toolUseID,
                  data: message.data
                });
              } catch (error) {
                // A throwing parent progress consumer must not become
                // syncAgentError and change the subagent outcome.
                logError(error);
              }
            }
            if (message.type !== 'assistant' && message.type !== 'user') {
              continue;
            }

            // Increment token count in spinner for assistant messages
            // Subagent streaming events are filtered out in runAgent.ts, so we
            // need to count tokens from completed messages here
            if (message.type === 'assistant') {
              const contentLength = getAssistantMessageContentLength(message);
              if (contentLength > 0) {
                toolUseContext.setResponseLength(len => len + contentLength);
              }
            }
            const normalizedNew = normalizeMessages([message]);
            for (const m of normalizedNew) {
              for (const content of m.message.content) {
                if (content.type !== 'tool_use' && content.type !== 'tool_result') {
                  continue;
                }

                // Forward progress updates
                if (onProgress) {
                  onProgress({
                    toolUseID: `agent_${assistantMessage.message.id}`,
                    data: {
                      message: m,
                      type: 'agent_progress',
                      // prompt only needed on first progress message (UI.tsx:624
                      // reads progressMessages[0]). Omit here to avoid duplication.
                      prompt: '',
                      agentId: syncAgentId
                    }
                  });
                }
              }
            }
          }
        } catch (error) {
          // Handle errors from the sync agent loop
          // AbortError should be re-thrown for proper interruption handling
          if (error instanceof AbortError) {
            wasAborted = true;
            logEvent('tengu_agent_tool_terminated', {
              agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              duration_ms: Date.now() - metadata.startTime,
              is_async: false,
              is_built_in_agent: metadata.isBuiltInAgent,
              reason: 'user_cancel_sync' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
            });
            throw error;
          }

          // Log the error for debugging
          logForDebugging(`Sync agent error: ${errorMessage(error)}`, {
            level: 'error'
          });

          // Store the error to handle after cleanup
          syncAgentError = toError(error);
        } finally {
          // Clear the background hint UI
          if (toolUseContext.setToolJSX) {
            toolUseContext.setToolJSX(null);
          }

          // Stop foreground summarization. Idempotent — if already stopped at
          // the backgrounding transition, this is a no-op. The backgrounded
          // closure owns a separate stop function (stopBackgroundedSummarization).
          stopForegroundSummarization?.();

          // Unregister foreground task if agent completed without being backgrounded
          if (foregroundTaskId) {
            unregisterAgentForeground(foregroundTaskId, rootSetAppState);
            // Notify SDK consumers (e.g. VS Code subagent panel) that this
            // foreground agent is done. Goes through drainSdkEvents() — does
            // NOT trigger the print.ts XML task_notification parser or the LLM loop.
            if (!wasBackgrounded) {
              const progress = getProgressUpdate(syncTracker);
              enqueueSdkEvent({
                type: 'system',
                subtype: 'task_notification',
                task_id: foregroundTaskId,
                tool_use_id: toolUseContext.toolUseId,
                status: syncAgentError ? 'failed' : wasAborted ? 'stopped' : 'completed',
                output_file: '',
                summary: description,
                usage: {
                  total_tokens: progress.tokenCount,
                  tool_uses: progress.toolUseCount,
                  duration_ms: Date.now() - agentStartTime
                }
              });
            }
          }

          // Clean up scoped skills so they don't accumulate in the global map
          clearInvokedSkillsForAgent(syncAgentId);

          // Clean up dumpState entry for this agent to prevent unbounded growth
          // Skip if backgrounded — the backgrounded agent's finally handles cleanup
          if (!wasBackgrounded) {
            clearDumpState(syncAgentId);
          }

          // Cancel auto-background timer if agent completed before it fired
          cancelAutoBackground?.();

          // Clean up worktree if applicable (in finally to handle abort/error paths)
          // Skip if backgrounded — the background continuation is still running in it
          if (!wasBackgrounded) {
            worktreeResult = await cleanupWorktreeIfNeeded();
          }
        }

        // Re-throw abort errors
        // TODO: Find a cleaner way to express this
        const lastMessage = agentMessages.findLast(_ => _.type !== 'system' && _.type !== 'progress');
        if (lastMessage && isSyntheticMessage(lastMessage)) {
          logEvent('tengu_agent_tool_terminated', {
            agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            duration_ms: Date.now() - metadata.startTime,
            is_async: false,
            is_built_in_agent: metadata.isBuiltInAgent,
            reason: 'user_cancel_sync' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          throw new AbortError();
        }

        // If an error occurred during iteration, try to return a result with
        // whatever messages we have. If we have no assistant messages,
        // re-throw the error so it's properly handled by the tool framework.
        if (syncAgentError) {
          // Check if we have any assistant messages to return
          const hasAssistantMessages = agentMessages.some(msg => msg.type === 'assistant');
          if (!hasAssistantMessages) {
            // No messages collected, re-throw the error
            throw syncAgentError;
          }

          // We have some messages, try to finalize and return them
          // This allows the parent agent to see partial progress even after an error
          logForDebugging(`Sync agent recovering from error with ${agentMessages.length} messages`);
        }
        const agentResult = finalizeAgentTool(agentMessages, syncAgentId, metadata);
        if (feature('TRANSCRIPT_CLASSIFIER')) {
          const currentAppState = toolUseContext.getAppState();
          const handoffWarning = await classifyHandoffIfNeeded({
            agentMessages,
            tools: toolUseContext.options.tools,
            toolPermissionContext: currentAppState.toolPermissionContext,
            abortSignal: toolUseContext.abortController.signal,
            subagentType: selectedAgent.agentType,
            totalToolUseCount: agentResult.totalToolUseCount
          });
          if (handoffWarning) {
            agentResult.content = [{
              type: 'text' as const,
              text: handoffWarning
            }, ...agentResult.content];
          }
        }
        return {
          data: {
            status: 'completed' as const,
            prompt,
            ...agentResult,
            ...worktreeResult,
            ...(worktreeIsolationFallback && { worktreeIsolationFallback: true as const }),
          }
        };
      }));
    }
  },
  isReadOnly() {
    return true; // delegates permission checks to its underlying tools
  },
  toAutoClassifierInput(input) {
    const i = input as AgentToolInput;
    const tags = [i.subagent_type, i.mode ? `mode=${i.mode}` : undefined].filter((t): t is string => t !== undefined);
    const prefix = tags.length > 0 ? `(${tags.join(', ')}): ` : ': ';
    return `${prefix}${i.prompt}`;
  },
  isConcurrencySafe() {
    // When Copilot optimizations are disabled, sub-agents are fully
    // unrestricted and can run concurrently.
    if (!isCopilotPremiumOptimizationEnabled()) return true

    // Align with the launch path: use shouldForceSyncSubagentsInCopilotMode()
    // to decide whether the scheduler must serialize sub-agent calls.
    // This prevents mismatches where the launch path allows async but the
    // scheduler still serializes, or vice versa (e.g. ALLOW_SUBAGENTS=1
    // makes launch async but scheduler serialized; FORCE_SYNC=1 + MAX=0
    // made launch sync but scheduler treated it as concurrency-safe).
    return !shouldForceSyncSubagentsInCopilotMode()
  },
  userFacingName,
  userFacingNameBackgroundColor,
  getActivityDescription(input) {
    return input?.description ?? 'Running task';
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    return {
      behavior: 'allow',
      updatedInput: input
    };
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    // Multi-agent spawn result
    const internalData = data as InternalOutput;
    if (typeof internalData === 'object' && internalData !== null && 'status' in internalData && internalData.status === 'teammate_spawned') {
      const spawnData = internalData as TeammateSpawnedOutput;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [{
          type: 'text',
          text: `Spawned successfully.
agent_id: ${spawnData.teammate_id}
name: ${spawnData.name}
team_name: ${spawnData.team_name}
The agent is now running and will receive instructions via mailbox.`
        }]
      };
    }
    if (data.status === 'async_launched') {
      const prefix = `Async agent launched successfully.\nagentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
      const instructions = data.canReadOutputFile ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Briefly tell the user what you launched and end your response — agent results will arrive in a subsequent message. You may continue first ONLY if you have other tasks on clearly different files that this agent is not touching.\noutput_file: ${data.outputFile}\nIf asked, you can check progress before completion by using ${FILE_READ_TOOL_NAME} or ${BASH_TOOL_NAME} tail on the output file.` : `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`;
      const isolationFallbackText = data.worktreeIsolationFallback
        ? `\n${formatWorktreeIsolationFallbackResultText()}`
        : '';
      const text = `${prefix}\n${instructions}${isolationFallbackText}`;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [{
          type: 'text',
          text
        }]
      };
    }
    if (data.status === 'completed') {
      const worktreeData = data as Record<string, unknown>;
      const worktreeInfoText = worktreeData.worktreePath ? `\nworktreePath: ${worktreeData.worktreePath}\nworktreeBranch: ${worktreeData.worktreeBranch}` : '';
      const isolationFallbackText = worktreeData.worktreeIsolationFallback
        ? `\n${formatWorktreeIsolationFallbackResultText()}`
        : '';
      // If the subagent completes with no content, the tool_result is just the
      // agentId/usage trailer below — a metadata-only block at the prompt tail.
      // Some models read that as "nothing to act on" and end their turn
      // immediately. Say so explicitly so the parent has something to react to.
      const contentOrMarker = data.content.length > 0 ? data.content : [{
        type: 'text' as const,
        text: '(Subagent completed but returned no output.)'
      }];
      // One-shot built-ins (Explore, Plan) are never continued via SendMessage
      // — the agentId hint and <usage> block are dead weight (~135 chars ×
      // 34M Explore runs/week ≈ 1-2 Gtok/week). Telemetry doesn't parse this
      // block (it uses logEvent in finalizeAgentTool), so dropping is safe.
      // agentType is optional for resume compat — missing means show trailer.
      // Keep the trailer when isolation fell back so the parent sees that
      // edits were not worktree-isolated.
      if (data.agentType && ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) && !worktreeInfoText && !isolationFallbackText) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: contentOrMarker
        };
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [...contentOrMarker, {
          type: 'text',
          text: `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)${worktreeInfoText}${isolationFallbackText}
<usage>total_tokens: ${data.totalTokens}
tool_uses: ${data.totalToolUseCount}
duration_ms: ${data.totalDurationMs}</usage>`
        }]
      };
    }
    data satisfies never;
    throw new Error(`Unexpected agent tool result status: ${(data as {
      status: string;
    }).status}`);
  },
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseTag,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderGroupedToolUse: renderGroupedAgentToolUse
} satisfies ToolDef<InputSchema, Output, Progress>);
function resolveTeamName(input: {
  team_name?: string;
}, appState: {
  teamContext?: {
    teamName: string;
  };
}): string | undefined {
  if (!isAgentSwarmsEnabled()) return undefined;
  return input.team_name || appState.teamContext?.teamName;
}
