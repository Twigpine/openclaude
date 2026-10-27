import axios from 'axios';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import React from 'react';
import { getOriginalCwd, getSessionId } from 'src/bootstrap/state.js';
import { checkGate_CACHED_OR_BLOCKING } from 'src/services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { isPolicyAllowed } from 'src/services/policyLimits/index.js';
import { z } from 'zod/v4';
import { getTeleportErrors, TeleportError, type TeleportLocalErrorType } from '../components/TeleportError.js';
import { getOauthConfig } from '../constants/oauth.js';
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js';
import type { Root } from '../ink.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { queryHaiku } from '../services/api/claude.js';
import { getSessionLogsViaOAuth, getTeleportEvents } from '../services/api/sessionIngress.js';
import { getOrganizationUUID } from '../services/oauth/client.js';
import { AppStateProvider } from '../state/AppState.js';
import type { Message, SystemMessage } from '../types/message.js';
import type { PermissionMode } from '../types/permissions.js';
import { checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokens } from './auth.js';
import { checkGithubAppInstalled } from './background/remote/preconditions.js';
import { deserializeMessages, type TeleportRemoteResponse } from './conversationRecovery.js';
import { getCwd } from './cwd.js';
import { logForDebugging } from './debug.js';
import { detectCurrentRepositoryWithHost, parseGitHubRepository, parseGitRemote } from './detectRepository.js';
import { isEnvTruthy } from './envUtils.js';
import { TeleportOperationError, toError } from './errors.js';
import { execFileNoThrow } from './execFileNoThrow.js';
import { truncateToWidth } from './format.js';
import { findGitRoot, getDefaultBranch, getIsClean, gitExe } from './git.js';
import { safeParseJSON } from './json.js';
import { logError } from './log.js';
import { createSystemMessage, createUserMessage } from './messages.js';
import { getMainLoopModel } from './model/model.js';
import { isTranscriptMessage } from './sessionStorage.js';
import { getSettings_DEPRECATED } from './settings/settings.js';
import { jsonStringify } from './slowOperations.js';
import { asSystemPrompt } from './systemPromptType.js';
import { fetchSession, type GitRepositoryOutcome, type GitSource, getBranchFromSession, getOAuthHeaders, type SessionResource } from './teleport/api.js';
import { fetchEnvironments } from './teleport/environments.js';
import { createAndUploadGitBundle } from './teleport/gitBundle.js';
export type TeleportResult = {
  messages: Message[];
  branchName: string;
};
export type TeleportProgressStep = 'validating' | 'fetching_logs' | 'fetching_branch' | 'checking_out' | 'done';
export type TeleportProgressCallback = (step: TeleportProgressStep) => void;

/**
 * Creates a system message to inform about teleport session resume
 * @returns SystemMessage indicating session was resumed from another machine
 */
function createTeleportResumeSystemMessage(branchError: Error | null): SystemMessage {
  if (branchError === null) {
    return createSystemMessage('Session resumed', 'suggestion');
  }
  const formattedError = branchError instanceof TeleportOperationError ? branchError.formattedMessage : branchError.message;
  return createSystemMessage(`Session resumed without branch: ${formattedError}`, 'warning');
}

/**
 * Creates a user message to inform the model about teleport session resume
 * @returns User message indicating session was resumed from another machine
 */
function createTeleportResumeUserMessage() {
  return createUserMessage({
    content: `This session is being continued from another machine. Application state may have changed. The updated working directory is ${getOriginalCwd()}`,
    isMeta: true
  });
}
type TeleportToRemoteResponse = {
  id: string;
  title: string;
};
const SESSION_TITLE_AND_BRANCH_PROMPT = `You are coming up with a succinct title and git branch name for a coding session based on the provided description. The title should be clear, concise, and accurately reflect the content of the coding task.
You should keep it short and simple, ideally no more than 6 words. Avoid using jargon or overly technical terms unless absolutely necessary. The title should be easy to understand for anyone reading it.
Use sentence case for the title (capitalize only the first word and proper nouns), not Title Case.

The branch name should be clear, concise, and accurately reflect the content of the coding task.
You should keep it short and simple, ideally no more than 4 words. The branch should always start with "claude/" and should be all lower case, with words separated by dashes.

Return a JSON object with "title" and "branch" fields.

Example 1: {"title": "Fix login button not working on mobile", "branch": "claude/fix-mobile-login-button"}
Example 2: {"title": "Update README with installation instructions", "branch": "claude/update-readme"}
Example 3: {"title": "Improve performance of data processing script", "branch": "claude/improve-data-processing"}

Here is the session description:
<description>{description}</description>
Please generate a title and branch name for this session.`;
type TitleAndBranch = {
  title: string;
  branchName: string;
};

/**
 * Generates a title and branch name for a coding session using Claude Haiku
 * @param description The description/prompt for the session
 * @returns Promise<TitleAndBranch> The generated title and branch name
 */
async function generateTitleAndBranch(description: string, signal: AbortSignal): Promise<TitleAndBranch> {
  const fallbackTitle = truncateToWidth(description, 75);
  const fallbackBranch = 'claude/task';
  try {
    const userPrompt = SESSION_TITLE_AND_BRANCH_PROMPT.replace('{description}', description);
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([]),
      userPrompt,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: {
              type: 'string'
            },
            branch: {
              type: 'string'
            }
          },
          required: ['title', 'branch'],
          additionalProperties: false
        }
      },
      signal,
      options: {
        querySource: 'teleport_generate_title',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: []
      }
    });

    // Extract text from the response
    const firstBlock = response.message.content[0];
    if (firstBlock?.type !== 'text') {
      return {
        title: fallbackTitle,
        branchName: fallbackBranch
      };
    }
    const parsed = safeParseJSON(firstBlock.text.trim());
    const parseResult = z.object({
      title: z.string(),
      branch: z.string()
    }).safeParse(parsed);
    if (parseResult.success) {
      return {
        title: parseResult.data.title || fallbackTitle,
        branchName: parseResult.data.branch || fallbackBranch
      };
    }
    return {
      title: fallbackTitle,
      branchName: fallbackBranch
    };
  } catch (error) {
    logError(new Error(`Error generating title and branch: ${error}`));
    return {
      title: fallbackTitle,
      branchName: fallbackBranch
    };
  }
}

/**
 * Validates that the git working directory is clean (ignoring untracked files)
 * Untracked files are ignored because they won't be lost during branch switching
 */
export async function validateGitState(): Promise<void> {
  const isClean = await getIsClean({
    ignoreUntracked: true
  });
  if (!isClean) {
    logEvent('tengu_teleport_error_git_not_clean', {});
    const error = new TeleportOperationError('Git working directory is not clean. Please commit or stash your changes before using --teleport.', chalk.red('Error: Git working directory is not clean. Please commit or stash your changes before using --teleport.\n'));
    throw error;
  }
}

/**
 * Fetches a specific branch from remote origin
 * @param branch The branch to fetch.
 */
async function fetchFromOrigin(branch: string): Promise<void> {
  const fetchArgs = ['fetch', 'origin', `${branch}:${branch}`];
  const {
    code: fetchCode,
    stderr: fetchStderr
  } = await execFileNoThrow(gitExe(), fetchArgs);
  if (fetchCode !== 0) {
    // If fetching a specific branch fails, it might not exist locally yet
    // Try fetching just the ref without mapping to local branch
    if (fetchStderr.includes('refspec')) {
      logForDebugging(`Specific branch fetch failed, trying to fetch ref: ${branch}`);
      const {
        code: refFetchCode,
        stderr: refFetchStderr
      } = await execFileNoThrow(gitExe(), ['fetch', 'origin', branch]);
      if (refFetchCode !== 0) {
        logError(new Error(`Failed to fetch from remote origin: ${refFetchStderr}`));
      }
    } else {
      logError(new Error(`Failed to fetch from remote origin: ${fetchStderr}`));
    }
  }
}

/**
 * Ensures that the current branch has an upstream set
 * If not, sets it to origin/<branchName> if that remote branch exists
 */
async function ensureUpstreamIsSet(branchName: string): Promise<void> {
  // Check if upstream is already set
  const {
    code: upstreamCheckCode
  } = await execFileNoThrow(gitExe(), ['rev-parse', '--abbrev-ref', `${branchName}@{upstream}`]);
  if (upstreamCheckCode === 0) {
    // Upstream is already set
    logForDebugging(`Branch '${branchName}' already has upstream set`);
    return;
  }

  // Check if origin/<branchName> exists
  const {
    code: remoteCheckCode
  } = await execFileNoThrow(gitExe(), ['rev-parse', '--verify', `origin/${branchName}`]);
  if (remoteCheckCode === 0) {
    // Remote branch exists, set upstream
    logForDebugging(`Setting upstream for '${branchName}' to 'origin/${branchName}'`);
    const {
      code: setUpstreamCode,
      stderr: setUpstreamStderr
    } = await execFileNoThrow(gitExe(), ['branch', '--set-upstream-to', `origin/${branchName}`, branchName]);
    if (setUpstreamCode !== 0) {
      logForDebugging(`Failed to set upstream for '${branchName}': ${setUpstreamStderr}`);
      // Don't throw, just log - this is not critical
    } else {
      logForDebugging(`Successfully set upstream for '${branchName}'`);
    }
  } else {
    logForDebugging(`Remote branch 'origin/${branchName}' does not exist, skipping upstream setup`);
  }
}

/**
 * Checks out a specific branch
 */
async function checkoutBranch(branchName: string): Promise<void> {
  // First try to checkout the branch as-is (might be local)
  let {
    code: checkoutCode,
    stderr: checkoutStderr
  } = await execFileNoThrow(gitExe(), ['checkout', branchName]);

  // If that fails, try to checkout from origin
  if (checkoutCode !== 0) {
    logForDebugging(`Local checkout failed, trying to checkout from origin: ${checkoutStderr}`);

    // Try to checkout the remote branch and create a local tracking branch
    const result = await execFileNoThrow(gitExe(), ['checkout', '-b', branchName, '--track', `origin/${branchName}`]);
    checkoutCode = result.code;
    checkoutStderr = result.stderr;

    // If that also fails, try without -b in case the branch exists but isn't checked out
    if (checkoutCode !== 0) {
      logForDebugging(`Remote checkout with -b failed, trying without -b: ${checkoutStderr}`);
      const finalResult = await execFileNoThrow(gitExe(), ['checkout', '--track', `origin/${branchName}`]);
      checkoutCode = finalResult.code;
      checkoutStderr = finalResult.stderr;
    }
  }
  if (checkoutCode !== 0) {
    logEvent('tengu_teleport_error_branch_checkout_failed', {});
    throw new TeleportOperationError(`Failed to checkout branch '${branchName}': ${checkoutStderr}`, chalk.red(`Failed to checkout branch '${branchName}'\n`));
  }

  // After successful checkout, ensure upstream is set
  await ensureUpstreamIsSet(branchName);
}

/**
 * Gets the current branch name
 */
async function getCurrentBranch(): Promise<string> {
  const {
    stdout: currentBranch
  } = await execFileNoThrow(gitExe(), ['branch', '--show-current']);
  return currentBranch.trim();
}

/**
 * Processes messages for teleport resume, removing incomplete tool_use blocks
 * and adding teleport notice messages
 * @param messages The conversation messages
 * @param error Optional error from branch checkout
 * @returns Processed messages ready for resume
 */
export function processMessagesForTeleportResume(messages: Message[], error: Error | null): Message[] {
  // Shared logic with resume for handling interruped session transcripts
  const deserializedMessages = deserializeMessages(messages);

  // Add user message about teleport resume (visible to model)
  const messagesWithTeleportNotice = [...deserializedMessages, createTeleportResumeUserMessage(), createTeleportResumeSystemMessage(error)];
  return messagesWithTeleportNotice;
}

/**
 * Checks out the specified branch for a teleported session
 * @param branch Optional branch to checkout
 * @returns The current branch name and any error that occurred
 */
export async function checkOutTeleportedSessionBranch(branch?: string): Promise<{
  branchName: string;
  branchError: Error | null;
}> {
  try {
    const currentBranch = await getCurrentBranch();
    logForDebugging(`Current branch before teleport: '${currentBranch}'`);
    if (branch) {
      logForDebugging(`Switching to branch '${branch}'...`);
      await fetchFromOrigin(branch);
      await checkoutBranch(branch);
      const newBranch = await getCurrentBranch();
      logForDebugging(`Branch after checkout: '${newBranch}'`);
    } else {
      logForDebugging('No branch specified, staying on current branch');
    }
    const branchName = await getCurrentBranch();
    return {
      branchName,
      branchError: null
    };
  } catch (error) {
    const branchName = await getCurrentBranch();
    const branchError = toError(error);
    return {
      branchName,
      branchError
    };
  }
}

/**
 * Result of repository validation for teleport
 */
export type RepoValidationResult = {
  status: 'match' | 'mismatch' | 'not_in_repo' | 'no_repo_required' | 'error';
  sessionRepo?: string;
  currentRepo?: string | null;
  /** Host of the session repo (e.g. "github.com" or "ghe.corp.com") — for display only */
  sessionHost?: string;
  /** Host of the current repo (e.g. "github.com" or "ghe.corp.com") — for display only */
  currentHost?: string;
  errorMessage?: string;
};

/**
 * Validates that the current repository matches the session's repository.
 * Returns a result object instead of throwing, allowing the caller to handle mismatches.
 *
 * @param sessionData The session resource to validate against
 * @returns Validation result with status and repo information
 */
export async function validateSessionRepository(sessionData: SessionResource): Promise<RepoValidationResult> {
  const currentParsed = await detectCurrentRepositoryWithHost();
  const currentRepo = currentParsed ? `${currentParsed.owner}/${currentParsed.name}` : null;
  const gitSource = sessionData.session_context.sources.find((source): source is GitSource => source.type === 'git_repository');
  if (!gitSource?.url) {
    // Session has no repo requirement
    logForDebugging(currentRepo ? 'Session has no associated repository, proceeding without validation' : 'Session has no repo requirement and not in git directory, proceeding');
    return {
      status: 'no_repo_required'
    };
  }
  const sessionParsed = parseGitRemote(gitSource.url);
  const sessionRepo = sessionParsed ? `${sessionParsed.owner}/${sessionParsed.name}` : parseGitHubRepository(gitSource.url);
  if (!sessionRepo) {
    return {
      status: 'no_repo_required'
    };
  }
  logForDebugging(`Session is for repository: ${sessionRepo}, current repo: ${currentRepo ?? 'none'}`);
  if (!currentRepo) {
    // Not in a git repo, but session requires one
    return {
      status: 'not_in_repo',
      sessionRepo,
      sessionHost: sessionParsed?.host,
      currentRepo: null
    };
  }

  // Compare both owner/repo and host to avoid cross-instance mismatches.
  // Strip ports before comparing hosts — SSH remotes omit the port while
  // HTTPS remotes may include a non-standard port (e.g. ghe.corp.com:8443),
  // which would cause a false mismatch.
  const stripPort = (host: string): string => host.replace(/:\d+$/, '');
  const repoMatch = currentRepo.toLowerCase() === sessionRepo.toLowerCase();
  const hostMatch = !currentParsed || !sessionParsed || stripPort(currentParsed.host.toLowerCase()) === stripPort(sessionParsed.host.toLowerCase());
  if (repoMatch && hostMatch) {
    return {
      status: 'match',
      sessionRepo,
      currentRepo
    };
  }

  // Repo mismatch — keep sessionRepo/currentRepo as plain "owner/repo" so
  // downstream consumers (e.g. getKnownPathsForRepo) can use them as lookup keys.
  // Include host information in separate fields for display purposes.
  return {
    status: 'mismatch',
    sessionRepo,
    currentRepo,
    sessionHost: sessionParsed?.host,
    currentHost: currentParsed?.host
  };
}

/**
 * Handles teleporting from a code session ID.
 * Fetches session logs and validates repo.
 * @param sessionId The session ID to resume
 * @param onProgress Optional callback for progress updates
 * @returns The raw session log and branch name
 */
export async function teleportResumeCodeSession(sessionId: string, onProgress?: TeleportProgressCallback): Promise<TeleportRemoteResponse> {
  if (!isPolicyAllowed('allow_remote_sessions')) {
    throw new Error("Remote sessions are disabled by your organization's policy.");
  }
  logForDebugging(`Resuming code session ID: ${sessionId}`);
  try {
    const accessToken = getClaudeAIOAuthTokens()?.accessToken;
    if (!accessToken) {
      logEvent('tengu_teleport_resume_error', {
        error_type: 'no_access_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      throw new Error('Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.');
    }

    // Get organization UUID
    const orgUUID = await getOrganizationUUID();
    if (!orgUUID) {
      logEvent('tengu_teleport_resume_error', {
        error_type: 'no_org_uuid' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      throw new Error('Unable to get organization UUID for constructing session URL');
    }

    // Fetch and validate repository matches before resuming
    onProgress?.('validating');
    const sessionData = await fetchSession(sessionId);
    const repoValidation = await validateSessionRepository(sessionData);
    switch (repoValidation.status) {
      case 'match':
      case 'no_repo_required':
        // Proceed with teleport
        break;
      case 'not_in_repo':
        {
          logEvent('tengu_teleport_error_repo_not_in_git_dir_sessions_api', {
            sessionId: sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          // Include host for GHE users so they know which instance the repo is on
          const notInRepoDisplay = repoValidation.sessionHost && repoValidation.sessionHost.toLowerCase() !== 'github.com' ? `${repoValidation.sessionHost}/${repoValidation.sessionRepo}` : repoValidation.sessionRepo;
          throw new TeleportOperationError(`You must run openclaude --teleport ${sessionId} from a checkout of ${notInRepoDisplay}.`, chalk.red(`You must run openclaude --teleport ${sessionId} from a checkout of ${chalk.bold(notInRepoDisplay)}.\n`));
        }
      case 'mismatch':
        {
          logEvent('tengu_teleport_error_repo_mismatch_sessions_api', {
            sessionId: sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          // Only include host prefix when hosts actually differ to disambiguate
          // cross-instance mismatches; for same-host mismatches the host is noise.
          const hostsDiffer = repoValidation.sessionHost && repoValidation.currentHost && repoValidation.sessionHost.replace(/:\d+$/, '').toLowerCase() !== repoValidation.currentHost.replace(/:\d+$/, '').toLowerCase();
          const sessionDisplay = hostsDiffer ? `${repoValidation.sessionHost}/${repoValidation.sessionRepo}` : repoValidation.sessionRepo;
          const currentDisplay = hostsDiffer ? `${repoValidation.currentHost}/${repoValidation.currentRepo}` : repoValidation.currentRepo;
          throw new TeleportOperationError(`You must run openclaude --teleport ${sessionId} from a checkout of ${sessionDisplay}.\nThis repo is ${currentDisplay}.`, chalk.red(`You must run openclaude --teleport ${sessionId} from a checkout of ${chalk.bold(sessionDisplay)}.\nThis repo is ${chalk.bold(currentDisplay)}.\n`));
        }
      case 'error':
        throw new TeleportOperationError(repoValidation.errorMessage || 'Failed to validate session repository', chalk.red(`Error: ${repoValidation.errorMessage || 'Failed to validate session repository'}\n`));
      default:
        {
          const _exhaustive: never = repoValidation.status;
          throw new Error(`Unhandled repo validation status: ${_exhaustive}`);
        }
    }
    return await teleportFromSessionsAPI(sessionId, orgUUID, accessToken, onProgress, sessionData);
  } catch (error) {
    if (error instanceof TeleportOperationError) {
      throw error;
    }
    const err = toError(error);
    logError(err);
    logEvent('tengu_teleport_resume_error', {
      error_type: 'resume_session_id_catch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    throw new TeleportOperationError(err.message, chalk.red(`Error: ${err.message}\n`));
  }
}

/**
 * Helper function to handle teleport prerequisites (authentication and git state)
 * Shows TeleportError dialog rendered into the existing root if needed
 */
async function handleTeleportPrerequisites(root: Root, errorsToIgnore?: Set<TeleportLocalErrorType>): Promise<void> {
  const errors = await getTeleportErrors();
  if (errors.size > 0) {
    // Log teleport errors detected
    logEvent('tengu_teleport_errors_detected', {
      error_types: Array.from(errors).join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      errors_ignored: Array.from(errorsToIgnore || []).join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });

    // Show TeleportError dialog for user interaction
    await new Promise<void>(resolve => {
      root.render(<AppStateProvider>
          <KeybindingSetup>
            <TeleportError errorsToIgnore={errorsToIgnore} onComplete={() => {
            // Log when errors are resolved
            logEvent('tengu_teleport_errors_resolved', {
              error_types: Array.from(errors).join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
            });
            void resolve();
          }} />
          </KeybindingSetup>
        </AppStateProvider>);
    });
  }
}

/**
 * Creates a remote Claude.ai session with error handling and UI feedback.
 * Shows prerequisite error dialog in the existing root if needed.
 * @param root The existing Ink root to render dialogs into
 * @param description The description/prompt for the new session (null for no initial prompt)
 * @param signal AbortSignal for cancellation
 * @param branchName Optional branch name for the remote session to use
 * @returns Promise<TeleportToRemoteResponse | null> The created session or null if creation fails
 */
export async function teleportToRemoteWithErrorHandling(root: Root, description: string | null, signal: AbortSignal, branchName?: string): Promise<TeleportToRemoteResponse | null> {
  const errorsToIgnore = new Set<TeleportLocalErrorType>(['needsGitStash']);
  await handleTeleportPrerequisites(root, errorsToIgnore);
  return teleportToRemote({
    initialMessage: description,
    signal,
    branchName,
    onBundleFail: msg => process.stderr.write(`\n${msg}\n`)
  });
}

/**
 * Fetches session data from the session ingress API (/v1/session_ingress/)
 * Uses session logs instead of SDK events to get the correct message structure
 * @param sessionId The session ID to fetch
 * @param orgUUID The organization UUID
 * @param accessToken The OAuth access token
 * @param onProgress Optional callback for progress updates
 * @param sessionData Optional session data (used to extract branch info)
 * @returns TeleportRemoteResponse with session logs as Message[]
 */
export async function teleportFromSessionsAPI(sessionId: string, orgUUID: string, accessToken: string, onProgress?: TeleportProgressCallback, sessionData?: SessionResource): Promise<TeleportRemoteResponse> {
  const startTime = Date.now();
  try {
    // Fetch session logs via session ingress
    logForDebugging(`[teleport] Starting fetch for session: ${sessionId}`);
    onProgress?.('fetching_logs');
    const logsStartTime = Date.now();
    // Try CCR v2 first (GetTeleportEvents — server dispatches Spanner/
    // threadstore). Fall back to session-ingress if it returns null
    // (endpoint not yet deployed, or transient error). Once session-ingress
    // is gone, the fallback becomes a no-op — getSessionLogsViaOAuth will
    // return null too and we fail with "Failed to fetch session logs".
    let logs = await getTeleportEvents(sessionId, accessToken, orgUUID);
    if (logs === null) {
      logForDebugging('[teleport] v2 endpoint returned null, trying session-ingress');
      logs = await getSessionLogsViaOAuth(sessionId, accessToken, orgUUID);
    }
    logForDebugging(`[teleport] Session logs fetched in ${Date.now() - logsStartTime}ms`);
    if (logs === null) {
      throw new Error('Failed to fetch session logs');
    }

    // Filter to get only transcript messages, excluding sidechain messages
    const filterStartTime = Date.now();
    const messages = logs.filter(entry => isTranscriptMessage(entry) && !entry.isSidechain) as Message[];
    logForDebugging(`[teleport] Filtered ${logs.length} entries to ${messages.length} messages in ${Date.now() - filterStartTime}ms`);

    // Extract branch info from session data
    onProgress?.('fetching_branch');
    const branch = sessionData ? getBranchFromSession(sessionData) : undefined;
    if (branch) {
      logForDebugging(`[teleport] Found branch: ${branch}`);
    }
    logForDebugging(`[teleport] Total teleportFromSessionsAPI time: ${Date.now() - startTime}ms`);
    return {
      log: messages,
      branch
    };
  } catch (error) {
    const err = toError(error);

    // Handle 404 specifically
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      logEvent('tengu_teleport_error_session_not_found_404', {
        sessionId: sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      throw new TeleportOperationError(`${sessionId} not found.`, `${sessionId} not found.\n${chalk.dim('Run /status in Claude Code to check your account.')}`);
    }
    logError(err);
    throw new Error(`Failed to fetch session from Sessions API: ${err.message}`);
  }
}

/**
 * Response type for polling remote session events (uses SDK events format)
 */
export type PollRemoteSessionResponse = {
  newEvents: SDKMessage[];
  lastEventId: string | null;
  branch?: string;
  sessionStatus?: 'idle' | 'running' | 'requires_action' | 'archived';
};

/**
 * Polls remote session events. Pass the previous response's `lastEventId`
 * as `afterId` to fetch only the delta. Set `skipMetadata` to avoid the
 * per-call GET /v1/sessions/{id} when branch/status aren't needed.
 */
export async function pollRemoteSessionEvents(sessionId: string, afterId: string | null = null, opts?: {
  skipMetadata?: boolean;
}): Promise<PollRemoteSessionResponse> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken;
  if (!accessToken) {
    throw new Error('No access token for polling');
  }
  const orgUUID = await getOrganizationUUID();
  if (!orgUUID) {
    throw new Error('No org UUID for polling');
  }
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID
  };
  const eventsUrl = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`;
  type EventsResponse = {
    data: unknown[];
    has_more: boolean;
    first_id: string | null;
    last_id: string | null;
  };

  // Cap is a safety valve against stuck cursors; steady-state is 0–1 pages.
  const MAX_EVENT_PAGES = 50;
  const sdkMessages: SDKMessage[] = [];
  let cursor = afterId;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const eventsResponse = await axios.get(eventsUrl, {
      headers,
      params: cursor ? {
        after_id: cursor
      } : undefined,
      timeout: 30000
    });
    if (eventsResponse.status !== 200) {
      throw new Error(`Failed to fetch session events: ${eventsResponse.statusText}`);
    }
    const eventsData: EventsResponse = eventsResponse.data;
    if (!eventsData?.data || !Array.isArray(eventsData.data)) {
      throw new Error('Invalid events response');
    }
    for (const event of eventsData.data) {
      if (event && typeof event === 'object' && 'type' in event) {
        if (event.type === 'env_manager_log' || event.type === 'control_response') {
          continue;
        }
        if ('session_id' in event) {
          sdkMessages.push(event as SDKMessage);
        }
      }
    }
    if (!eventsData.last_id) break;
    cursor = eventsData.last_id;
    if (!eventsData.has_more) break;
  }
  if (opts?.skipMetadata) {
    return {
      newEvents: sdkMessages,
      lastEventId: cursor
    };
  }

  // Fetch session metadata (branch, status)
  let branch: string | undefined;
  let sessionStatus: PollRemoteSessionResponse['sessionStatus'];
  try {
    const sessionData = await fetchSession(sessionId);
    branch = getBranchFromSession(sessionData);
    sessionStatus = sessionData.session_status as PollRemoteSessionResponse['sessionStatus'];
  } catch (e) {
    logForDebugging(`teleport: failed to fetch session ${sessionId} metadata: ${e}`, {
      level: 'debug'
    });
  }
  return {
    newEvents: sdkMessages,
    lastEventId: cursor,
    branch,
    sessionStatus
  };
}

/**
 * Creates a remote Claude.ai session using the Sessions API.
 *
 * Two source modes:
 * - GitHub (default): backend clones from the repo's origin URL. Requires a
 *   GitHub remote + CCR-side GitHub connection. 43% of CLI sessions have an
 *   origin remote; far fewer pass the full precondition chain.
 * - Bundle (CCR_FORCE_BUNDLE=1): CLI creates `git bundle --all`, uploads via Files
 *   API, passes file_id as seed_bundle_file_id on the session context. CCR
 *   downloads it and clones from the bundle. No GitHub dependency — works for
 *   local-only repos. Reach: 54% of CLI sessions (anything with .git/).
 *   Backend: anthropic#303856.
 */
export async function teleportToRemote(options: {
  initialMessage: string | null;
  branchName?: string;
  title?: string;
  /**
   * The description of the session. This is used to generate the title and
   * session branch name (unless they are explicitly provided).
   */
  description?: string;
  model?: string;
  permissionMode?: PermissionMode;
  ultraplan?: boolean;
  signal: AbortSignal;
  useDefaultEnvironment?: boolean;
  /**
   * Explicit environment_id (e.g. the code_review synthetic env). Bypasses
   * fetchEnvironments; the usual repo-detection → git source still runs so
   * the container gets the repo checked out (orchestrator reads --repo-dir
   * from pwd, it doesn't clone).
   */
  environmentId?: string;
  /**
   * Per-session env vars merged into session_context.environment_variables.
   * Write-only at the API layer (stripped from Get/List responses). When
   * environmentId is set, CLAUDE_CODE_OAUTH_TOKEN is auto-injected from the
   * caller's accessToken so the container's hook can hit inference (the
   * server only passes through what the caller sends; bughunter.go mints
   * its own, user sessions don't get one automatically).
   */
  environmentVariables?: Record<string, string>;
  /**
   * When set with environmentId, creates and uploads a git bundle of the
   * local working tree (createAndUploadGitBundle handles the stash-create
   * for uncommitted changes) and passes it as seed_bundle_file_id. Backend
   * clones from the bundle instead of GitHub — container gets the caller's
   * exact local state. Needs .git/ only, not a GitHub remote.
   */
  useBundle?: boolean;
  /**
   * Called with a user-facing message when the bundle path is attempted but
   * fails. The wrapper stderr.writes it (pre-REPL). Remote-agent callers
   * capture it to include in their throw (in-REPL, Ink-rendered).
   */
  onBundleFail?: (message: string) => void;
  /**
   * When true, disables the git-bundle fallback entirely. Use for flows like
   * autofix where CCR must push to GitHub — a bundle can't do that.
   */
  skipBundle?: boolean;
  /**
   * When set, reuses this branch as the outcome branch instead of generating
   * a new claude/ branch. Sets allow_unrestricted_git_push on the source and
   * reuse_outcome_branches on the session context so the remote pushes to the
   * caller's branch directly.
   */
  reuseOutcomeBranch?: string;
  /**
   * GitHub PR to attach to the session context. Backend uses this to
   * identify the PR associated with this session.
   */
  githubPr?: {
    owner: string;
    repo: string;
    number: number;
  };
}): Promise<TeleportToRemoteResponse | null> {
  const {
    initialMessage,
    signal
  } = options;
  try {
    // Check authentication
    await checkAndRefreshOAuthTokenIfNeeded();
    const accessToken = getClaudeAIOAuthTokens()?.accessToken;
    if (!accessToken) {
      logError(new Error('No access token found for remote session creation'));
      return null;
    }

    // Get organization UUID
    const orgUUID = await getOrganizationUUID();
    if (!orgUUID) {
      logError(new Error('Unable to get organization UUID for remote session creation'));
      return null;
    }

    // Explicit environmentId short-circuits Haiku title-gen + env selection.
    // Still runs repo detection so the container gets a working directory —
    // the code_review orchestrator reads --repo-dir $(pwd), it doesn't clone
    // (bughunter.go:520 sets a git source too; env-manager does the checkout
    // before the SessionStart hook fires).
    if (options.environmentId) {
      const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`;
      const headers = {
        ...getOAuthHeaders(accessToken),
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        'x-organization-uuid': orgUUID
      };
      const envVars = {
        CLAUDE_CODE_OAUTH_TOKEN: accessToken,
        ...(options.environmentVariables ?? {})
      };

      // Bundle mode: upload local working tree (uncommitted changes via
      // refs/seed/stash), container clones from the bundle. No GitHub.
      // Otherwise: github.com source — caller checked eligibility.
      let gitSource: GitSource | null = null;
      let seedBundleFileId: string | null = null;
      if (options.useBundle) {
        const bundle = await createAndUploadGitBundle({
          oauthToken: accessToken,
          sessionId: getSessionId(),
          baseUrl: getOauthConfig().BASE_API_URL
        }, {
          signal
        });
        if (!bundle.success) {
          logError(new Error(`Bundle upload failed: ${bundle.error}`));
          return null;
        }
        seedBundleFileId = bundle.fileId;
        logEvent('tengu_teleport_bundle_mode', {
          size_bytes: bundle.bundleSizeBytes,
          scope: bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          has_wip: bundle.hasWip,
          reason: 'explicit_env_bundle' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      } else {
        const repoInfo = await detectCurrentRepositoryWithHost();
        if (repoInfo) {
          gitSource = {
            type: 'git_repository',
            url: `https://${repoInfo.host}/${repoInfo.owner}/${repoInfo.name}`,
            revision: options.branchName
          };
        }
      }
      const requestBody = {
        title: options.title || options.description || 'Remote task',
        events: [],
        session_context: {
          sources: gitSource ? [gitSource] : [],
          ...(seedBundleFileId && {
            seed_bundle_file_id: seedBundleFileId
          }),
          outcomes: [],
          environment_variables: envVars
        },
        environment_id: options.environmentId
      };
      logForDebugging(`[teleportToRemote] explicit env ${options.environmentId}, ${Object.keys(envVars).length} env vars, ${seedBundleFileId ? `bundle=${seedBundleFileId}` : `source=${gitSource?.url ?? 'none'}@${options.branchName ?? 'default'}`}`);
      const response = await axios.post(url, requestBody, {
        headers,
        signal
      });
      if (response.status !== 200 && response.status !== 201) {
        logError(new Error(`CreateSession ${response.status}: ${jsonStringify(response.data)}`));
        return null;
      }
      const sessionData = response.data as SessionResource;
      if (!sessionData || typeof sessionData.id !== 'string') {
        logError(new Error(`No session id in response: ${jsonStringify(response.data)}`));
        return null;
      }
      return {
        id: sessionData.id,
        title: sessionData.title || requestBody.title
      };
    }
    let gitSource: GitSource | null = null;
    let gitOutcome: GitRepositoryOutcome | null = null;
    let seedBundleFileId: string | null = null;

    // Source selection ladder: GitHub clone (if CCR can actually pull it) →
    // bundle fallback (if .git exists) → empty sandbox.
    //
    // The preflight is the same code path the container's git-proxy clone
    // will hit (get_github_client_with_user_auth → no_sync_user_token_found).
    // 50% of users who reach the "install GitHub App" step never finish it;
    // without the preflight, every one of them gets a container that 401s
    // on clone. With it, they silently fall back to bundle.
    //
    // CCR_FORCE_BUNDLE=1 skips the preflight entirely — useful for testing
    // or when you know your GitHub auth is busted. Read here (not in the
    // caller) so it works for remote-agent too, not just --remote.

    const repoInfo = await detectCurrentRepositoryWithHost();

    // Generate title and branch name for the session. Skip the Haiku call
    // when both title and outcome branch are explicitly provided.
    let sessionTitle: string;
    let sessionBranch: string;
    if (options.title && options.reuseOutcomeBranch) {
      sessionTitle = options.title;
      sessionBranch = options.reuseOutcomeBranch;
    } else {
      const generated = await generateTitleAndBranch(options.description || initialMessage || 'Background task', signal);
      sessionTitle = options.title || generated.title;
      sessionBranch = options.reuseOutcomeBranch || generated.branchName;
    }

    // Preflight: does CCR have a token that can clone this repo?
    // Only checked for github.com — GHES needs ghe_configuration_id which
    // we don't have, and GHES users are power users who probably finished
    // setup. For them (and for non-GitHub hosts that parseGitRemote
    // somehow accepted), fall through optimistically; if the backend
    // rejects the host, bundle next time.
    let ghViable = false;
    let sourceReason: 'github_preflight_ok' | 'ghes_optimistic' | 'github_preflight_failed' | 'no_github_remote' | 'forced_bundle' | 'no_git_at_all' = 'no_git_at_all';

    // gitRoot gates both bundle creation and the gate check itself — no
    // point awaiting GrowthBook when there's nothing to bundle.
    const gitRoot = findGitRoot(getCwd());
    const forceBundle = !options.skipBundle && isEnvTruthy(process.env.CCR_FORCE_BUNDLE);
    const bundleSeedGateOn = !options.skipBundle && gitRoot !== null && (isEnvTruthy(process.env.CCR_ENABLE_BUNDLE) || (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bundle_seed_enabled')));
    if (repoInfo && !forceBundle) {
      if (repoInfo.host === 'github.com') {
        ghViable = await checkGithubAppInstalled(repoInfo.owner, repoInfo.name, signal);
        sourceReason = ghViable ? 'github_preflight_ok' : 'github_preflight_failed';
      } else {
        ghViable = true;
        sourceReason = 'ghes_optimistic';
      }
    } else if (forceBundle) {
      sourceReason = 'forced_bundle';
    } else if (gitRoot) {
      sourceReason = 'no_github_remote';
    }

    // Preflight failed but bundle is off — fall through optimistically like
    // pre-preflight behavior. Backend reports the real auth error.
    if (!ghViable && !bundleSeedGateOn && repoInfo) {
      ghViable = true;
    }
    if (ghViable && repoInfo) {
      const {
        host,
        owner,
        name
      } = repoInfo;
      // Resolve the base branch: prefer explicit branchName, fall back to default branch
      const revision = options.branchName ?? (await getDefaultBranch()) ?? undefined;
      logForDebugging(`[teleportToRemote] Git source: ${host}/${owner}/${name}, revision: ${revision ?? 'none'}`);
      gitSource = {
        type: 'git_repository',
        url: `https://${host}/${owner}/${name}`,
        // The revision specifies which ref to checkout as the base branch
        revision,
        ...(options.reuseOutcomeBranch && {
          allow_unrestricted_git_push: true
        })
      };
      // type: 'github' is used for all GitHub-compatible hosts (github.com and GHE).
      // The CLI can't distinguish GHE from non-GitHub hosts (GitLab, Bitbucket)
      // client-side — the backend validates the URL against configured GHE instances
      // and ignores git_info for unrecognized hosts.
      gitOutcome = {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: `${owner}/${name}`,
          branches: [sessionBranch]
        }
      };
    }

    // Bundle fallback. Only try bundle if GitHub wasn't viable, the gate is
    // on, and there's a .git/ to bundle from. Reaching here with
    // ghViable=false and repoInfo non-null means the preflight failed —
    // .git definitely exists (detectCurrentRepositoryWithHost read the
    // remote from it).
    if (!gitSource && bundleSeedGateOn) {
      logForDebugging(`[teleportToRemote] Bundling (reason: ${sourceReason})`);
      const bundle = await createAndUploadGitBundle({
        oauthToken: accessToken,
        sessionId: getSessionId(),
        baseUrl: getOauthConfig().BASE_API_URL
      }, {
        signal
      });
      if (!bundle.success) {
        logError(new Error(`Bundle upload failed: ${bundle.error}`));
        // Only steer users to GitHub setup when there's a remote to clone from.
        const setup = repoInfo ? '. Please setup GitHub on https://claude.ai/code' : '';
        let msg: string;
        switch (bundle.failReason) {
          case 'empty_repo':
            msg = 'Repository has no commits — run `git add . && git commit -m "initial"` then retry';
            break;
          case 'too_large':
            msg = `Repo is too large to teleport${setup}`;
            break;
          case 'git_error':
            msg = `Failed to create git bundle (${bundle.error})${setup}`;
            break;
          case undefined:
            msg = `Bundle upload failed: ${bundle.error}${setup}`;
            break;
          default:
            {
              const _exhaustive: never = bundle.failReason;
              void _exhaustive;
              msg = `Bundle upload failed: ${bundle.error}`;
            }
        }
        options.onBundleFail?.(msg);
        return null;
      }
      seedBundleFileId = bundle.fileId;
      logEvent('tengu_teleport_bundle_mode', {
        size_bytes: bundle.bundleSizeBytes,
        scope: bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        has_wip: bundle.hasWip,
        reason: sourceReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    }
    logEvent('tengu_teleport_source_decision', {
      reason: sourceReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      path: (gitSource ? 'github' : seedBundleFileId ? 'bundle' : 'empty') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    if (!gitSource && !seedBundleFileId) {
      logForDebugging('[teleportToRemote] No repository detected — session will have an empty sandbox');
    }

    // Fetch available environments
    let environments = await fetchEnvironments();
    if (!environments || environments.length === 0) {
      logError(new Error('No environments available for session creation'));
      return null;
    }
    logForDebugging(`Available environments: ${environments.map(e => `${e.environment_id} (${e.name}, ${e.kind})`).join(', ')}`);

    // Select environment based on settings, then anthropic_cloud preference, then first available.
    // Prefer anthropic_cloud environments over byoc: anthropic_cloud environments (e.g. "Default")
    // are the standard compute environments with full repo access, whereas byoc environments
    // (e.g. "monorepo") are user-owned compute that may not support the current repository.
    const settings = getSettings_DEPRECATED();
    const defaultEnvironmentId = options.useDefaultEnvironment ? undefined : settings?.remote?.defaultEnvironmentId;
    let cloudEnv = environments.find(env => env.kind === 'anthropic_cloud');
    // When the caller opts out of their configured default, do not fall
    // through to a BYOC env that may not support the current repo or the
    // requested permission mode. Retry once for eventual consistency,
    // then fail loudly.
    if (options.useDefaultEnvironment && !cloudEnv) {
      logForDebugging(`No anthropic_cloud in env list (${environments.length} envs); retrying fetchEnvironments`);
      const retried = await fetchEnvironments();
      cloudEnv = retried?.find(env => env.kind === 'anthropic_cloud');
      if (!cloudEnv) {
        logError(new Error(`No anthropic_cloud environment available after retry (got: ${(retried ?? environments).map(e => `${e.name} (${e.kind})`).join(', ')}). Silent byoc fallthrough would launch into a dead env — fail fast instead.`));
        return null;
      }
      if (retried) environments = retried;
    }
    const selectedEnvironment = defaultEnvironmentId && environments.find(env => env.environment_id === defaultEnvironmentId) || cloudEnv || environments.find(env => env.kind !== 'bridge') || environments[0];
    if (!selectedEnvironment) {
      logError(new Error('No environments available for session creation'));
      return null;
    }
    if (defaultEnvironmentId) {
      const matchedDefault = selectedEnvironment.environment_id === defaultEnvironmentId;
      logForDebugging(matchedDefault ? `Using configured default environment: ${defaultEnvironmentId}` : `Configured default environment ${defaultEnvironmentId} not found, using first available`);
    }
    const environmentId = selectedEnvironment.environment_id;
    logForDebugging(`Selected environment: ${environmentId} (${selectedEnvironment.name}, ${selectedEnvironment.kind})`);

    // Prepare API request for Sessions API
    const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`;
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID
    };
    const sessionContext = {
      sources: gitSource ? [gitSource] : [],
      ...(seedBundleFileId && {
        seed_bundle_file_id: seedBundleFileId
      }),
      outcomes: gitOutcome ? [gitOutcome] : [],
      model: options.model ?? getMainLoopModel(),
      ...(options.reuseOutcomeBranch && {
        reuse_outcome_branches: true
      }),
      ...(options.githubPr && {
        github_pr: options.githubPr
      })
    };

    // CreateCCRSessionPayload has no permission_mode field — a top-level
    // body entry is silently dropped by the proto parser server-side.
    // Instead prepend a set_permission_mode control_request event. Initial
    // events are written to threadstore before the container connects, so
    // the CLI applies the mode before the first user turn — no readiness race.
    const events: Array<{
      type: 'event';
      data: Record<string, unknown>;
    }> = [];
    if (options.permissionMode) {
      events.push({
        type: 'event',
        data: {
          type: 'control_request',
          request_id: `set-mode-${randomUUID()}`,
          request: {
            subtype: 'set_permission_mode',
            mode: options.permissionMode,
            ultraplan: options.ultraplan
          }
        }
      });
    }
    if (initialMessage) {
      events.push({
        type: 'event',
        data: {
          uuid: randomUUID(),
          session_id: '',
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: initialMessage
          }
        }
      });
    }
    const requestBody = {
      title: options.ultraplan ? `ultraplan: ${sessionTitle}` : sessionTitle,
      events,
      session_context: sessionContext,
      environment_id: environmentId
    };
    logForDebugging(`Creating session with payload: ${jsonStringify(requestBody, null, 2)}`);

    // Make API call
    const response = await axios.post(url, requestBody, {
      headers,
      signal
    });
    const isSuccess = response.status === 200 || response.status === 201;
    if (!isSuccess) {
      logError(new Error(`API request failed with status ${response.status}: ${response.statusText}\n\nResponse data: ${jsonStringify(response.data, null, 2)}`));
      return null;
    }

    // Parse response as SessionResource
    const sessionData = response.data as SessionResource;
    if (!sessionData || typeof sessionData.id !== 'string') {
      logError(new Error(`Cannot determine session ID from API response: ${jsonStringify(response.data)}`));
      return null;
    }
    logForDebugging(`Successfully created remote session: ${sessionData.id}`);
    return {
      id: sessionData.id,
      title: sessionData.title || requestBody.title
    };
  } catch (error) {
    const err = toError(error);
    logError(err);
    return null;
  }
}

/**
 * Best-effort session archive. POST /v1/sessions/{id}/archive has no
 * running-status check (unlike DELETE which 409s on RUNNING), so it works
 * mid-implementation. Archived sessions reject new events (send_events.go),
 * so the remote stops on its next write. 409 (already archived) treated as
 * success. Fire-and-forget; failure leaks a visible session until the
 * reaper collects it.
 */
export async function archiveRemoteSession(sessionId: string): Promise<void> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken;
  if (!accessToken) return;
  const orgUUID = await getOrganizationUUID();
  if (!orgUUID) return;
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID
  };
  const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/archive`;
  try {
    const resp = await axios.post(url, {}, {
      headers,
      timeout: 10000,
      validateStatus: s => s < 500
    });
    if (resp.status === 200 || resp.status === 409) {
      logForDebugging(`[archiveRemoteSession] archived ${sessionId}`);
    } else {
      logForDebugging(`[archiveRemoteSession] ${sessionId} failed ${resp.status}: ${jsonStringify(resp.data)}`);
    }
  } catch (err) {
    logError(err);
  }
}
