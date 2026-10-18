import { feature } from 'bun:bundle';
import React, { useCallback, useEffect, useRef } from 'react';
import { setMainLoopModelOverride } from '../bootstrap/state.js';
import { type BridgePermissionCallbacks, type BridgePermissionResponse, isBridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js';
import { buildBridgeConnectUrl } from '../bridge/bridgeStatusUtil.js';
import { extractInboundMessageFields } from '../bridge/inboundMessages.js';
import type { BridgeState, ReplBridgeHandle } from '../bridge/replBridge.js';
import { setReplBridgeHandle } from '../bridge/replBridgeHandle.js';
import type { Command } from '../commands.js';
import { getSlashCommandToolSkills, isBridgeSafeCommand } from '../commands.js';
import { getRemoteSessionUrl } from '../constants/product.js';
import { useNotifications } from '../context/notifications.js';
import type { PermissionMode, SDKMessage } from '../entrypoints/agentSdkTypes.js';
import { EXTERNAL_PERMISSION_MODES } from '../types/permissions.js';
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js';
import { Text } from '../ink.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import type { Message } from '../types/message.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { errorMessage } from '../utils/errors.js';
import { requestBridgeInterrupt } from '../utils/replInterruption.js';
import { enqueue } from '../utils/messageQueueManager.js';
import { buildSystemInitMessage } from '../utils/messages/systemInit.js';
import { createBridgeStatusMessage, createSystemMessage } from '../utils/messages.js';
import { requestPermissionModeChange } from '../utils/permissions/permissionModeChange.js';
import { applyPermissionModeChange } from '../utils/permissions/permissionSetup.js';
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js';

/** How long after a failure before replBridgeEnabled is auto-cleared (stops retries). */
export const BRIDGE_FAILURE_DISMISS_MS = 10_000;

/**
 * Max consecutive initReplBridge failures before the hook stops re-attempting
 * for the session lifetime. Guards against paths that flip replBridgeEnabled
 * back on after auto-disable (settings sync, /remote-control, config tool)
 * when the underlying OAuth is unrecoverable — each re-attempt is another
 * guaranteed 401 against POST /v1/environments/bridge. Datadog 2026-03-08:
 * top stuck client generated 2,879 × 401/day alone (17% of all 401s on the
 * route).
 */
const MAX_CONSECUTIVE_INIT_FAILURES = 3;

/**
 * Hook that initializes an always-on bridge connection in the background
 * and writes new user/assistant messages to the bridge session.
 *
 * Silently skips if bridge is not enabled or user is not OAuth-authenticated.
 *
 * Watches AppState.replBridgeEnabled — when toggled off (via /config or footer),
 * the bridge is torn down. When toggled back on, it re-initializes.
 *
 * Inbound messages from claude.ai are injected into the REPL via queuedCommands.
 */
export function useReplBridge(messages: Message[], setMessages: (action: React.SetStateAction<Message[]>) => void, abortControllerRef: React.RefObject<AbortController | null>, commands: readonly Command[], mainLoopModel: string): {
  sendBridgeResult: () => void;
} {
  const handleRef = useRef<ReplBridgeHandle | null>(null);
  const teardownPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const lastWrittenIndexRef = useRef(0);
  // Tracks UUIDs already flushed as initial messages. Persists across
  // bridge reconnections so Bridge #2+ only sends new messages — sending
  // duplicate UUIDs causes the server to kill the WebSocket.
  const flushedUUIDsRef = useRef(new Set<string>());
  const failureTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Persists across effect re-runs (unlike the effect's local state). Reset
  // only on successful init. Hits MAX_CONSECUTIVE_INIT_FAILURES → fuse blown
  // for the session, regardless of replBridgeEnabled re-toggling.
  const consecutiveFailuresRef = useRef(0);
  const setAppState = useSetAppState();
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const mainLoopModelRef = useRef(mainLoopModel);
  mainLoopModelRef.current = mainLoopModel;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const store = useAppStateStore();
  const {
    addNotification
  } = useNotifications();
  const replBridgeEnabled = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.replBridgeEnabled) : false;
  const replBridgeConnected = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_0 => s_0.replBridgeConnected) : false;
  const replBridgeOutboundOnly = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_1 => s_1.replBridgeOutboundOnly) : false;
  const replBridgeInitialName = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_2 => s_2.replBridgeInitialName) : undefined;

  // Initialize/teardown bridge when enabled state changes.
  // Passes current messages as initialMessages so the remote session
  // starts with the existing conversation context (e.g. from /bridge).
  useEffect(() => {
    // feature() check must use positive pattern for dead code elimination —
    // negative pattern (if (!feature(...)) return) does NOT eliminate
    // dynamic imports below.
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeEnabled) return;
      const outboundOnly = replBridgeOutboundOnly;
      function notifyBridgeFailed(detail?: string): void {
        if (outboundOnly) return;
        addNotification({
          key: 'bridge-failed',
          jsx: <>
              <Text color="error">Remote Control failed</Text>
              {detail && <Text dimColor> · {detail}</Text>}
            </>,
          priority: 'immediate'
        });
      }
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_INIT_FAILURES) {
        logForDebugging(`[bridge:repl] Hook: ${consecutiveFailuresRef.current} consecutive init failures, not retrying this session`);
        // Clear replBridgeEnabled so /remote-control doesn't mistakenly show
        // BridgeDisconnectDialog for a bridge that never connected.
        const fuseHint = 'disabled after repeated failures · restart to retry';
        notifyBridgeFailed(fuseHint);
        setAppState(prev => {
          if (prev.replBridgeError === fuseHint && !prev.replBridgeEnabled) return prev;
          return {
            ...prev,
            replBridgeError: fuseHint,
            replBridgeEnabled: false
          };
        });
        return;
      }
      let cancelled = false;
      // Capture messages.length now so we don't re-send initial messages
      // through writeMessages after the bridge connects.
      const initialMessageCount = messages.length;
      void (async () => {
        try {
          // Wait for any in-progress teardown to complete before registering
          // a new environment. Without this, the deregister HTTP call from
          // the previous teardown races with the new register call, and the
          // server may tear down the freshly-created environment.
          if (teardownPromiseRef.current) {
            logForDebugging('[bridge:repl] Hook: waiting for previous teardown to complete before re-init');
            await teardownPromiseRef.current;
            teardownPromiseRef.current = undefined;
            logForDebugging('[bridge:repl] Hook: previous teardown complete, proceeding with re-init');
          }
          if (cancelled) return;

          // Dynamic import so the module is tree-shaken in external builds
          const {
            initReplBridge
          } = await import('../bridge/initReplBridge.js');
          const {
            shouldShowAppUpgradeMessage
          } = await import('../bridge/envLessBridgeConfig.js');

          // Assistant mode: perpetual bridge session — claude.ai shows one
          // continuous conversation across CLI restarts instead of a new
          // session per invocation. initBridgeCore reads bridge-pointer.json
          // (the same crash-recovery file #20735 added) and reuses its
          // {environmentId, sessionId} via reuseEnvironmentId +
          // api.reconnectSession(). Teardown skips archive/deregister/
          // pointer-clear so the session survives clean exits, not just
          // crashes. Non-assistant bridges clear the pointer on teardown
          // (crash-recovery only).
          let perpetual = false;
          if (feature('KAIROS')) {
            const {
              isAssistantMode
            } = await import('../assistant/index.js');
            perpetual = isAssistantMode();
          }

          // When a user message arrives from claude.ai, inject it into the REPL.
          // Preserves the original UUID so that when the message is forwarded
          // back to CCR, it matches the original — avoiding duplicate messages.
          //
          // Async because file_attachments (if present) need a network fetch +
          // disk write before we enqueue with the @path prefix. Caller doesn't
          // await — messages with attachments just land in the queue slightly
          // later, which is fine (web messages aren't rapid-fire).
          async function handleInboundMessage(msg: SDKMessage): Promise<void> {
            try {
              const fields = extractInboundMessageFields(msg);
              if (!fields) return;
              const {
                uuid
              } = fields;

              // Dynamic import keeps the bridge code out of non-BRIDGE_MODE builds.
              const {
                resolveAndPrepend
              } = await import('../bridge/inboundAttachments.js');
              let sanitized = fields.content;
              if (feature('KAIROS_GITHUB_WEBHOOKS')) {
                /* eslint-disable @typescript-eslint/no-require-imports */
                const {
                  sanitizeInboundWebhookContent
                } = require('../bridge/webhookSanitizer.js') as typeof import('../bridge/webhookSanitizer.js');
                /* eslint-enable @typescript-eslint/no-require-imports */
                sanitized = sanitizeInboundWebhookContent(fields.content);
              }
              const content = await resolveAndPrepend(msg, sanitized);
              const preview = typeof content === 'string' ? content.slice(0, 80) : `[${content.length} content blocks]`;
              logForDebugging(`[bridge:repl] Injecting inbound user message: ${preview}${uuid ? ` uuid=${uuid}` : ''}`);
              enqueue({
                value: content,
                mode: 'prompt' as const,
                uuid,
                // skipSlashCommands stays true as defense-in-depth —
                // processUserInputBase overrides it internally when bridgeOrigin
                // is set AND the resolved command passes isBridgeSafeCommand.
                // This keeps exit-word suppression and immediate-command blocks
                // intact for any code path that checks skipSlashCommands directly.
                skipSlashCommands: true,
                bridgeOrigin: true
              });
            } catch (e) {
              logForDebugging(`[bridge:repl] handleInboundMessage failed: ${e}`, {
                level: 'error'
              });
            }
          }

          // State change callback — maps bridge lifecycle events to AppState.
          function handleStateChange(state: BridgeState, detail_0?: string): void {
            if (cancelled) return;
            if (outboundOnly) {
              logForDebugging(`[bridge:repl] Mirror state=${state}${detail_0 ? ` detail=${detail_0}` : ''}`);
              // Sync replBridgeConnected so the forwarding effect starts/stops
              // writing as the transport comes up or dies.
              if (state === 'failed') {
                setAppState(prev_3 => {
                  if (!prev_3.replBridgeConnected) return prev_3;
                  return {
                    ...prev_3,
                    replBridgeConnected: false
                  };
                });
              } else if (state === 'ready' || state === 'connected') {
                setAppState(prev_4 => {
                  if (prev_4.replBridgeConnected) return prev_4;
                  return {
                    ...prev_4,
                    replBridgeConnected: true
                  };
                });
              }
              return;
            }
            const handle = handleRef.current;
            switch (state) {
              case 'ready':
                setAppState(prev_9 => {
                  const connectUrl = handle && handle.environmentId !== '' ? buildBridgeConnectUrl(handle.environmentId, handle.sessionIngressUrl) : prev_9.replBridgeConnectUrl;
                  const sessionUrl = handle ? getRemoteSessionUrl(handle.bridgeSessionId, handle.sessionIngressUrl) : prev_9.replBridgeSessionUrl;
                  const envId = handle?.environmentId;
                  const sessionId = handle?.bridgeSessionId;
                  if (prev_9.replBridgeConnected && !prev_9.replBridgeSessionActive && !prev_9.replBridgeReconnecting && prev_9.replBridgeConnectUrl === connectUrl && prev_9.replBridgeSessionUrl === sessionUrl && prev_9.replBridgeEnvironmentId === envId && prev_9.replBridgeSessionId === sessionId) {
                    return prev_9;
                  }
                  return {
                    ...prev_9,
                    replBridgeConnected: true,
                    replBridgeSessionActive: false,
                    replBridgeReconnecting: false,
                    replBridgeConnectUrl: connectUrl,
                    replBridgeSessionUrl: sessionUrl,
                    replBridgeEnvironmentId: envId,
                    replBridgeSessionId: sessionId,
                    replBridgeError: undefined
                  };
                });
                break;
              case 'connected':
                {
                  setAppState(prev_8 => {
                    if (prev_8.replBridgeSessionActive) return prev_8;
                    return {
                      ...prev_8,
                      replBridgeConnected: true,
                      replBridgeSessionActive: true,
                      replBridgeReconnecting: false,
                      replBridgeError: undefined
                    };
                  });
                  // Send system/init so remote clients (web/iOS/Android) get
                  // session metadata. REPL uses query() directly — never hits
                  // QueryEngine's SDKMessage layer — so this is the only path
                  // to put system/init on the REPL-bridge wire. Skills load is
                  // async (memoized, cheap after REPL startup); fire-and-forget
                  // so the connected-state transition isn't blocked.
                  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_system_init', false)) {
                    void (async () => {
                      try {
                        const skills = await getSlashCommandToolSkills(getCwd());
                        if (cancelled) return;
                        const state_0 = store.getState();
                                    const rawPermissionMode = state_0.toolPermissionContext.mode
            const validPermissionMode: PermissionMode = (EXTERNAL_PERMISSION_MODES as readonly string[]).includes(rawPermissionMode) ? (rawPermissionMode as PermissionMode) : 'default'
                        handleRef.current?.writeSdkMessages([buildSystemInitMessage({
                          // tools/mcpClients/plugins redacted for REPL-bridge:
                          // MCP-prefixed tool names and server names leak which
                          // integrations the user has wired up; plugin paths leak
                          // raw filesystem paths (username, project structure).
                          // CCR v2 persists SDK messages to Spanner — users who
                          // tap "Connect from phone" may not expect these on
                          // Anthropic's servers. QueryEngine (SDK) still emits
                          // full lists — SDK consumers expect full telemetry.
                          tools: [],
                          mcpClients: [],
                          model: mainLoopModelRef.current,
                                        permissionMode: validPermissionMode,
                          // Remote clients can only invoke bridge-safe commands —
                          // advertising unsafe ones (local-jsx, unallowed local)
                          // would let mobile/web attempt them and hit errors.
                          commands: commandsRef.current.filter(isBridgeSafeCommand),
                          agents: state_0.agentDefinitions.activeAgents,
                          skills,
                          plugins: [],
                          fastMode: state_0.fastMode
                        })]);
                      } catch (err_0) {
                        logForDebugging(`[bridge:repl] Failed to send system/init: ${errorMessage(err_0)}`, {
                          level: 'error'
                        });
                      }
                    })();
                  }
                  break;
                }
              case 'reconnecting':
                setAppState(prev_7 => {
                  if (prev_7.replBridgeReconnecting) return prev_7;
                  return {
                    ...prev_7,
                    replBridgeReconnecting: true,
                    replBridgeSessionActive: false
                  };
                });
                break;
              case 'failed':
                // Clear any previous failure dismiss timer
                clearTimeout(failureTimeoutRef.current);
                notifyBridgeFailed(detail_0);
                setAppState(prev_5 => ({
                  ...prev_5,
                  replBridgeError: detail_0,
                  replBridgeReconnecting: false,
                  replBridgeSessionActive: false,
                  replBridgeConnected: false
                }));
                // Auto-disable after timeout so the hook stops retrying.
                failureTimeoutRef.current = setTimeout(() => {
                  if (cancelled) return;
                  failureTimeoutRef.current = undefined;
                  setAppState(prev_6 => {
                    if (!prev_6.replBridgeError) return prev_6;
                    return {
                      ...prev_6,
                      replBridgeEnabled: false,
                      replBridgeError: undefined
                    };
                  });
                }, BRIDGE_FAILURE_DISMISS_MS);
                break;
            }
          }

          // Map of pending bridge permission response handlers, keyed by request_id.
          // Each entry is an onResponse handler waiting for CCR to reply.
          const pendingPermissionHandlers = new Map<string, (response: BridgePermissionResponse) => void>();

          // Dispatch incoming control_response messages to registered handlers
          function handlePermissionResponse(msg_0: SDKControlResponse): void {
            const requestId = msg_0.response?.request_id;
            if (!requestId) return;
            const handler = pendingPermissionHandlers.get(requestId);
            if (!handler) {
              logForDebugging(`[bridge:repl] No handler for control_response request_id=${requestId}`);
              return;
            }
            pendingPermissionHandlers.delete(requestId);
            // Extract the permission decision from the control_response payload
            const inner = msg_0.response;
            if (inner.subtype === 'success' && inner.response && isBridgePermissionResponse(inner.response)) {
              handler(inner.response);
            }
          }
          const handle_0 = await initReplBridge({
            outboundOnly,
            tags: outboundOnly ? ['ccr-mirror'] : undefined,
            onInboundMessage: handleInboundMessage,
            onPermissionResponse: handlePermissionResponse,
            onInterrupt() {
              requestBridgeInterrupt(abortControllerRef);
            },
            onSetModel(model) {
              const resolved = model === 'default' ? null : model ?? null;
              setMainLoopModelOverride(resolved);
              setAppState(prev_10 => {
                if (prev_10.mainLoopModelForSession === resolved) return prev_10;
                return {
                  ...prev_10,
                  mainLoopModelForSession: resolved
                };
              });
            },
            onSetMaxThinkingTokens(maxTokens) {
              const enabled = maxTokens !== null;
              setAppState(prev_11 => {
                if (prev_11.thinkingEnabled === enabled) return prev_11;
                return {
                  ...prev_11,
                  thinkingEnabled: enabled
                };
              });
            },
            async onSetPermissionMode(mode) {
              // Policy guards MUST fire before transitionPermissionMode —
              // its internal auto-gate check is a defensive throw (with a
              // setAutoModeActive(true) side-effect BEFORE the throw) rather
              // than a graceful reject. Letting that throw escape would:
              // (1) leave STATE.autoModeActive=true while the mode is
              //     unchanged (3-way invariant violation per src/CLAUDE.md)
              // (2) fail to send a control_response → server kills WS
              // These mirror print.ts handleSetPermissionMode; the bridge
              // can't import the checks directly (bootstrap-isolation), so
              // it relies on this verdict to emit the error response.
              let blockedError: string | undefined;
              const result = await requestPermissionModeChange({
                mode,
                toolPermissionContext: store.getState().toolPermissionContext,
                allowDangerousModeConfirmation: false,
                onApply: () => {
                  setAppState(prev_12 => {
                    const current = prev_12.toolPermissionContext.mode;
                    if (current === mode) return prev_12;
                    return {
                      ...prev_12,
                      toolPermissionContext: applyPermissionModeChange(prev_12.toolPermissionContext, mode)
                    };
                  });
                },
                onBlocked: error => {
                  blockedError = error;
                }
              });
              if (result.status !== 'applied') {
                return {
                  ok: false,
                  error: blockedError ?? `Cannot set permission mode to ${mode}`
                };
              }
              // Guards passed — apply via the centralized transition so
              // prePlanMode stashing and auto-mode state sync all fire.
              // Recheck queued permission prompts now that mode changed.
              setImmediate(() => {
                getLeaderToolUseConfirmQueue()?.(currentQueue => {
                  currentQueue.forEach(item => {
                    void item.recheckPermission();
                  });
                  return currentQueue;
                });
              });
              return {
                ok: true
              };
            },
            onStateChange: handleStateChange,
            initialMessages: messages.length > 0 ? messages : undefined,
            getMessages: () => messagesRef.current,
            previouslyFlushedUUIDs: flushedUUIDsRef.current,
            initialName: replBridgeInitialName,
            perpetual
          });
          if (cancelled) {
            // Effect was cancelled while initReplBridge was in flight.
            // Tear down the handle to avoid leaking resources (poll loop,
            // WebSocket, registered environment, cleanup callback).
            logForDebugging(`[bridge:repl] Hook: init cancelled during flight, tearing down${handle_0 ? ` env=${handle_0.environmentId}` : ''}`);
            if (handle_0) {
              void handle_0.teardown();
            }
            return;
          }
          if (!handle_0) {
            // initReplBridge returned null — a precondition failed. For most
            // cases (no_oauth, policy_denied, etc.) onStateChange('failed')
            // already fired with a specific hint. The GrowthBook-gate-off case
            // is intentionally silent — not a failure, just not rolled out.
            consecutiveFailuresRef.current++;
            logForDebugging(`[bridge:repl] Init returned null (precondition or session creation failed); consecutive failures: ${consecutiveFailuresRef.current}`);
            clearTimeout(failureTimeoutRef.current);
            setAppState(prev_13 => ({
              ...prev_13,
              replBridgeError: prev_13.replBridgeError ?? 'check debug logs for details'
            }));
            failureTimeoutRef.current = setTimeout(() => {
              if (cancelled) return;
              failureTimeoutRef.current = undefined;
              setAppState(prev_14 => {
                if (!prev_14.replBridgeError) return prev_14;
                return {
                  ...prev_14,
                  replBridgeEnabled: false,
                  replBridgeError: undefined
                };
              });
            }, BRIDGE_FAILURE_DISMISS_MS);
            return;
          }
          handleRef.current = handle_0;
          setReplBridgeHandle(handle_0);
          consecutiveFailuresRef.current = 0;
          // Skip initial messages in the forwarding effect — they were
          // already loaded as session events during creation.
          lastWrittenIndexRef.current = initialMessageCount;
          if (outboundOnly) {
            setAppState(prev_15 => {
              if (prev_15.replBridgeConnected && prev_15.replBridgeSessionId === handle_0.bridgeSessionId) return prev_15;
              return {
                ...prev_15,
                replBridgeConnected: true,
                replBridgeSessionId: handle_0.bridgeSessionId,
                replBridgeSessionUrl: undefined,
                replBridgeConnectUrl: undefined,
                replBridgeError: undefined
              };
            });
            logForDebugging(`[bridge:repl] Mirror initialized, session=${handle_0.bridgeSessionId}`);
          } else {
            // Build bridge permission callbacks so the interactive permission
            // handler can race bridge responses against local user interaction.
            const permissionCallbacks: BridgePermissionCallbacks = {
              sendRequest(requestId_0, toolName, input, toolUseId, description, permissionSuggestions, blockedPath) {
                handle_0.sendControlRequest({
                  type: 'control_request',
                  request_id: requestId_0,
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: toolName,
                    input,
                    tool_use_id: toolUseId,
                    description,
                    ...(permissionSuggestions ? {
                      permission_suggestions: permissionSuggestions
                    } : {}),
                    ...(blockedPath ? {
                      blocked_path: blockedPath
                    } : {})
                  }
                });
              },
              sendResponse(requestId_1, response) {
                const payload: Record<string, unknown> = {
                  ...response
                };
                handle_0.sendControlResponse({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: requestId_1,
                    response: payload
                  }
                });
              },
              cancelRequest(requestId_2) {
                handle_0.sendControlCancelRequest(requestId_2);
              },
              onResponse(requestId_3, handler_0) {
                pendingPermissionHandlers.set(requestId_3, handler_0);
                return () => {
                  pendingPermissionHandlers.delete(requestId_3);
                };
              }
            };
            setAppState(prev_16 => ({
              ...prev_16,
              replBridgePermissionCallbacks: permissionCallbacks
            }));
            const url = getRemoteSessionUrl(handle_0.bridgeSessionId, handle_0.sessionIngressUrl);
            // environmentId === '' signals the v2 env-less path. buildBridgeConnectUrl
            // builds an env-specific connect URL, which doesn't exist without an env.
            const hasEnv = handle_0.environmentId !== '';
            const connectUrl_0 = hasEnv ? buildBridgeConnectUrl(handle_0.environmentId, handle_0.sessionIngressUrl) : undefined;
            setAppState(prev_17 => {
              if (prev_17.replBridgeConnected && prev_17.replBridgeSessionUrl === url) {
                return prev_17;
              }
              return {
                ...prev_17,
                replBridgeConnected: true,
                replBridgeSessionUrl: url,
                replBridgeConnectUrl: connectUrl_0 ?? prev_17.replBridgeConnectUrl,
                replBridgeEnvironmentId: handle_0.environmentId,
                replBridgeSessionId: handle_0.bridgeSessionId,
                replBridgeError: undefined
              };
            });

            // Show bridge status with URL in the transcript. perpetual (KAIROS
            // assistant mode) falls back to v1 at initReplBridge.ts — skip the
            // v2-only upgrade nudge for them. Own try/catch so a cosmetic
            // GrowthBook hiccup doesn't hit the outer init-failure handler.
            const upgradeNudge = !perpetual ? await shouldShowAppUpgradeMessage().catch(() => false) : false;
            if (cancelled) return;
            setMessages(prev_18 => [...prev_18, createBridgeStatusMessage(url, upgradeNudge ? 'Please upgrade to the latest version of the Claude mobile app to see your Remote Control sessions.' : undefined)]);
            logForDebugging(`[bridge:repl] Hook initialized, session=${handle_0.bridgeSessionId}`);
          }
        } catch (err) {
          // Never crash the REPL — surface the error in the UI.
          // Check cancelled first (symmetry with the !handle path at line ~386):
          // if initReplBridge threw during rapid toggle-off (in-flight network
          // error), don't count that toward the fuse or spam a stale error
          // into the UI. Also fixes pre-existing spurious setAppState/
          // setMessages on cancelled throws.
          if (cancelled) return;
          consecutiveFailuresRef.current++;
          const errMsg = errorMessage(err);
          logForDebugging(`[bridge:repl] Init failed: ${errMsg}; consecutive failures: ${consecutiveFailuresRef.current}`);
          clearTimeout(failureTimeoutRef.current);
          notifyBridgeFailed(errMsg);
          setAppState(prev_0 => ({
            ...prev_0,
            replBridgeError: errMsg
          }));
          failureTimeoutRef.current = setTimeout(() => {
            if (cancelled) return;
            failureTimeoutRef.current = undefined;
            setAppState(prev_1 => {
              if (!prev_1.replBridgeError) return prev_1;
              return {
                ...prev_1,
                replBridgeEnabled: false,
                replBridgeError: undefined
              };
            });
          }, BRIDGE_FAILURE_DISMISS_MS);
          if (!outboundOnly) {
            setMessages(prev_2 => [...prev_2, createSystemMessage(`Remote Control failed to connect: ${errMsg}`, 'warning')]);
          }
        }
      })();
      return () => {
        cancelled = true;
        clearTimeout(failureTimeoutRef.current);
        failureTimeoutRef.current = undefined;
        if (handleRef.current) {
          logForDebugging(`[bridge:repl] Hook cleanup: starting teardown for env=${handleRef.current.environmentId} session=${handleRef.current.bridgeSessionId}`);
          teardownPromiseRef.current = handleRef.current.teardown();
          handleRef.current = null;
          setReplBridgeHandle(null);
        }
        setAppState(prev_19 => {
          if (!prev_19.replBridgeConnected && !prev_19.replBridgeSessionActive && !prev_19.replBridgeError) {
            return prev_19;
          }
          return {
            ...prev_19,
            replBridgeConnected: false,
            replBridgeSessionActive: false,
            replBridgeReconnecting: false,
            replBridgeConnectUrl: undefined,
            replBridgeSessionUrl: undefined,
            replBridgeEnvironmentId: undefined,
            replBridgeSessionId: undefined,
            replBridgeError: undefined,
            replBridgePermissionCallbacks: undefined
          };
        });
        lastWrittenIndexRef.current = 0;
      };
    }
  }, [replBridgeEnabled, replBridgeOutboundOnly, setAppState, setMessages, addNotification]);

  // Write new messages as they appear.
  // Also re-runs when replBridgeConnected changes (bridge finishes init),
  // so any messages that arrived before the bridge was ready get written.
  useEffect(() => {
    // Positive feature() guard — see first useEffect comment
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeConnected) return;
      const handle_1 = handleRef.current;
      if (!handle_1) return;

      // Clamp the index in case messages were compacted (array shortened).
      // After compaction the ref could exceed messages.length, and without
      // clamping no new messages would be forwarded.
      if (lastWrittenIndexRef.current > messages.length) {
        logForDebugging(`[bridge:repl] Compaction detected: lastWrittenIndex=${lastWrittenIndexRef.current} > messages.length=${messages.length}, clamping`);
      }
      const startIndex = Math.min(lastWrittenIndexRef.current, messages.length);

      // Collect new messages since last write
      const newMessages: Message[] = [];
      for (let i = startIndex; i < messages.length; i++) {
        const msg_1 = messages[i];
        if (msg_1 && (msg_1.type === 'user' || msg_1.type === 'assistant' || msg_1.type === 'system' && msg_1.subtype === 'local_command')) {
          newMessages.push(msg_1);
        }
      }
      lastWrittenIndexRef.current = messages.length;
      if (newMessages.length > 0) {
        handle_1.writeMessages(newMessages);
      }
    }
  }, [messages, replBridgeConnected]);
  const sendBridgeResult = useCallback(() => {
    if (feature('BRIDGE_MODE')) {
      handleRef.current?.sendResult();
    }
  }, []);
  return {
    sendBridgeResult
  };
}
