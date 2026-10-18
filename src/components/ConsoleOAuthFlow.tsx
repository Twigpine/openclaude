import React, { useCallback, useEffect, useRef, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { installOAuthTokens } from '../cli/handlers/auth.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { setClipboard } from '../ink/termio/osc.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import { Box, Link, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getSSLErrorHint } from '../services/api/errorUtils.js';
import { sendNotification } from '../services/notifier.js';
import { OAuthService } from '../services/oauth/index.js';
import { getOauthAccountInfo, validateForceLoginOrg } from '../utils/auth.js';
import { logError } from '../utils/log.js';
import { getEnvProviderOption } from '../utils/envProviderOption.js';
import { getLocalOpenAICompatibleProviderLabel } from '../utils/providerDiscovery.js';
import { type ProviderProfile } from '../utils/config.js';
import {
  addProviderProfile,
  getProviderProfiles,
  setActiveProviderProfile,
  updateProviderProfile,
} from '../utils/providerProfiles.js';
import { getSettings_DEPRECATED } from '../utils/settings/settings.js';
import { ProviderManager } from './ProviderManager.js';
import { Select } from './CustomSelect/select.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Spinner } from './Spinner.js';
import TextInput from './TextInput.js';
export type ConsoleOAuthFlowResult = {
  type: 'oauth';
} | {
  type: 'provider-setup';
  message: string;
};
type Props = {
  onDone(result?: ConsoleOAuthFlowResult): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
  forceLoginMethod?: 'claudeai' | 'console';
  initialStatus?: OAuthStatus;
};
type OAuthStatus = {
  state: 'idle';
} // Initial state, waiting to select login method
| {
  state: 'platform_setup';
} // Show third-party provider setup flow
| {
  state: 'platform_setup_complete';
  message: string;
}
| {
  state: 'ready_to_start';
} // Flow started, waiting for browser to open
| {
  state: 'waiting_for_login';
  url: string;
} // Browser opened, waiting for user to login
| {
  state: 'creating_api_key';
} // Got access token, creating API key
| {
  state: 'about_to_retry';
  nextState: OAuthStatus;
} | {
  state: 'success';
  token?: string;
} | {
  state: 'error';
  message: string;
  toRetry?: OAuthStatus;
};
const PASTE_HERE_MSG = 'Paste code here if prompted > ';
export function ConsoleOAuthFlow({
  onDone,
  startingMessage,
  mode = 'login',
  forceLoginMethod: forceLoginMethodProp,
  initialStatus
}: Props): React.ReactNode {
  const settings = getSettings_DEPRECATED() || {};
  const forceLoginMethod = forceLoginMethodProp ?? settings.forceLoginMethod;
  const orgUUID = settings.forceLoginOrgUUID;
  const forcedMethodMessage = forceLoginMethod === 'claudeai' ? 'Login method pre-selected: Subscription Plan (Claude Pro/Max)' : forceLoginMethod === 'console' ? 'Login method pre-selected: API Usage Billing (Anthropic Console)' : null;
  const terminal = useTerminalNotification();
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>(() => {
    if (initialStatus) {
      return initialStatus;
    }
    if (mode === 'setup-token') {
      return {
        state: 'ready_to_start'
      };
    }
    if (forceLoginMethod === 'claudeai' || forceLoginMethod === 'console') {
      return {
        state: 'ready_to_start'
      };
    }
    return {
      state: 'idle'
    };
  });
  const [pastedCode, setPastedCode] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [oauthService] = useState(() => new OAuthService());
  const [loginWithClaudeAi, setLoginWithClaudeAi] = useState(() => {
    // Use Claude AI auth for setup-token mode to support user:inference scope
    return mode === 'setup-token' || forceLoginMethod === 'claudeai';
  });
  // After a few seconds we suggest the user to copy/paste url if the
  // browser did not open automatically. In this flow we expect the user to
  // copy the code from the browser and paste it in the terminal
  const [showPastePrompt, setShowPastePrompt] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const textInputColumns = useTerminalSize().columns - PASTE_HERE_MSG.length - 1;

  // Log forced login method on mount
  useEffect(() => {
    if (forceLoginMethod === 'claudeai') {
      logEvent('tengu_oauth_claudeai_forced', {});
    } else if (forceLoginMethod === 'console') {
      logEvent('tengu_oauth_console_forced', {});
    }
  }, [forceLoginMethod]);

  // Retry logic
  useEffect(() => {
    if (oauthStatus.state === 'about_to_retry') {
      const timer = setTimeout(setOAuthStatus, 1000, oauthStatus.nextState);
      return () => clearTimeout(timer);
    }
  }, [oauthStatus]);

  // Handle Enter to continue on success state
  useKeybinding('confirm:yes', () => {
    logEvent('tengu_oauth_success', {
      loginWithClaudeAi
    });
    onDone({
      type: 'oauth'
    });
  }, {
    context: 'Confirmation',
    isActive: oauthStatus.state === 'success' && mode !== 'setup-token'
  });

  // Handle Enter to continue after third-party provider setup
  useKeybinding('confirm:yes', () => {
    if (oauthStatus.state !== 'platform_setup_complete') {
      return;
    }
    onDone({
      type: 'provider-setup',
      message: oauthStatus.message
    });
  }, {
    context: 'Confirmation',
    isActive: oauthStatus.state === 'platform_setup_complete'
  });

  // Handle Enter to retry on error state
  useKeybinding('confirm:yes', () => {
    if (oauthStatus.state === 'error' && oauthStatus.toRetry) {
      setPastedCode('');
      setOAuthStatus({
        state: 'about_to_retry',
        nextState: oauthStatus.toRetry
      });
    }
  }, {
    context: 'Confirmation',
    isActive: oauthStatus.state === 'error' && !!oauthStatus.toRetry
  });
  useEffect(() => {
    if (pastedCode === 'c' && oauthStatus.state === 'waiting_for_login' && showPastePrompt && !urlCopied) {
      void setClipboard(oauthStatus.url).then(raw => {
        if (raw) process.stdout.write(raw);
        setUrlCopied(true);
        setTimeout(setUrlCopied, 2000, false);
      });
      setPastedCode('');
    }
  }, [pastedCode, oauthStatus, showPastePrompt, urlCopied]);
  async function handleSubmitCode(value: string, url: string) {
    try {
      // Expecting format "authorizationCode#state" from the authorization callback URL
      const [authorizationCode, state] = value.split('#');
      if (!authorizationCode || !state) {
        setOAuthStatus({
          state: 'error',
          message: 'Invalid code. Please make sure the full code was copied',
          toRetry: {
            state: 'waiting_for_login',
            url
          }
        });
        return;
      }

      // Track which path the user is taking (manual code entry)
      logEvent('tengu_oauth_manual_entry', {});
      oauthService.handleManualAuthCodeInput({
        authorizationCode,
        state
      });
    } catch (err: unknown) {
      logError(err);
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: {
          state: 'waiting_for_login',
          url
        }
      });
    }
  }
  const startOAuth = useCallback(async () => {
    try {
      logEvent('tengu_oauth_flow_start', {
        loginWithClaudeAi
      });
      const result = await oauthService.startOAuthFlow(async url_0 => {
        setOAuthStatus({
          state: 'waiting_for_login',
          url: url_0
        });
        setTimeout(setShowPastePrompt, 3000, true);
      }, {
        loginWithClaudeAi,
        inferenceOnly: mode === 'setup-token',
        expiresIn: mode === 'setup-token' ? 365 * 24 * 60 * 60 : undefined,
        // 1 year for setup-token
        orgUUID
      }).catch(err_1 => {
        const isTokenExchangeError = err_1.message.includes('Token exchange failed');
        // Enterprise TLS proxies (Zscaler et al.) intercept the token
        // exchange POST and cause cryptic SSL errors. Surface an
        // actionable hint so the user isn't stuck in a login loop.
        const sslHint_0 = getSSLErrorHint(err_1);
        setOAuthStatus({
          state: 'error',
          message: sslHint_0 ?? (isTokenExchangeError ? 'Failed to exchange authorization code for access token. Please try again.' : err_1.message),
          toRetry: mode === 'setup-token' ? {
            state: 'ready_to_start'
          } : {
            state: 'idle'
          }
        });
        logEvent('tengu_oauth_token_exchange_error', {
          error: err_1.message,
          ssl_error: sslHint_0 !== null
        });
        throw err_1;
      });
      if (mode === 'setup-token') {
        // For setup-token mode, return the OAuth access token directly (it can be used as an API key)
        // Don't save to keychain - the token is displayed for manual use with CLAUDE_CODE_OAUTH_TOKEN
        setOAuthStatus({
          state: 'success',
          token: result.accessToken
        });
      } else {
        await installOAuthTokens(result);
        const orgResult = await validateForceLoginOrg();
        if (!orgResult.valid) {
          throw new Error(orgResult.message);
        }
        setOAuthStatus({
          state: 'success'
        });
        void sendNotification({
          message: 'OpenClaude login successful',
          notificationType: 'auth_success'
        }, terminal);
      }
    } catch (err_0) {
      const errorMessage = (err_0 as Error).message;
      const sslHint = getSSLErrorHint(err_0);
      setOAuthStatus({
        state: 'error',
        message: sslHint ?? errorMessage,
        toRetry: {
          state: mode === 'setup-token' ? 'ready_to_start' : 'idle'
        }
      });
      logEvent('tengu_oauth_error', {
        error: errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ssl_error: sslHint !== null
      });
    }
  }, [oauthService, setShowPastePrompt, loginWithClaudeAi, mode, orgUUID]);
  const pendingOAuthStartRef = useRef(false);
  useEffect(() => {
    if (oauthStatus.state === 'ready_to_start' && !pendingOAuthStartRef.current) {
      pendingOAuthStartRef.current = true;
      process.nextTick((startOAuth_0: () => Promise<void>, pendingOAuthStartRef_0: React.MutableRefObject<boolean>) => {
        void startOAuth_0();
        pendingOAuthStartRef_0.current = false;
      }, startOAuth, pendingOAuthStartRef);
    }
  }, [oauthStatus.state, startOAuth]);

  // Auto-exit for setup-token mode
  useEffect(() => {
    if (mode === 'setup-token' && oauthStatus.state === 'success') {
      // Delay to ensure static content is fully rendered before exiting
      const timer_0 = setTimeout((loginWithClaudeAi_0, onDone_0) => {
        logEvent('tengu_oauth_success', {
          loginWithClaudeAi: loginWithClaudeAi_0
        });
        // Don't clear terminal so the token remains visible
        onDone_0();
      }, 500, loginWithClaudeAi, onDone);
      return () => clearTimeout(timer_0);
    }
  }, [mode, oauthStatus, loginWithClaudeAi, onDone]);

  // Cleanup OAuth service when component unmounts
  useEffect(() => {
    return () => {
      oauthService.cleanup();
    };
  }, [oauthService]);
  return <Box flexDirection="column" gap={1}>
      {oauthStatus.state === 'waiting_for_login' && showPastePrompt && <Box flexDirection="column" key="urlToCopy" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>
              Browser didn&apos;t open? Use the url below to sign in{' '}
            </Text>
            {urlCopied ? <Text color="success">(Copied!)</Text> : <Text dimColor>
                <KeyboardShortcutHint shortcut="c" action="copy" parens />
              </Text>}
          </Box>
          <Link url={oauthStatus.url}>
            <Text dimColor>{oauthStatus.url}</Text>
          </Link>
        </Box>}
      {mode === 'setup-token' && oauthStatus.state === 'success' && oauthStatus.token && <Box key="tokenOutput" flexDirection="column" gap={1} paddingTop={1}>
            <Text color="success">
              ✓ Long-lived authentication token created successfully!
            </Text>
            <Box flexDirection="column" gap={1}>
              <Text>Your OAuth token (valid for 1 year):</Text>
              <Text color="warning">{oauthStatus.token}</Text>
              <Text dimColor>
                Store this token securely. You won&apos;t be able to see it
                again.
              </Text>
              <Text dimColor>
                Use this token by setting: export
                CLAUDE_CODE_OAUTH_TOKEN=&lt;token&gt;
              </Text>
            </Box>
          </Box>}
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        <OAuthStatusMessage oauthStatus={oauthStatus} mode={mode} startingMessage={startingMessage} forcedMethodMessage={forcedMethodMessage} showPastePrompt={showPastePrompt} pastedCode={pastedCode} setPastedCode={setPastedCode} cursorOffset={cursorOffset} setCursorOffset={setCursorOffset} textInputColumns={textInputColumns} handleSubmitCode={handleSubmitCode} setOAuthStatus={setOAuthStatus} setLoginWithClaudeAi={setLoginWithClaudeAi} />
      </Box>
    </Box>;
}
type OAuthStatusMessageProps = {
  oauthStatus: OAuthStatus;
  mode: 'login' | 'setup-token';
  startingMessage: string | undefined;
  forcedMethodMessage: string | null;
  showPastePrompt: boolean;
  pastedCode: string;
  setPastedCode: (value: string) => void;
  cursorOffset: number;
  setCursorOffset: (offset: number) => void;
  textInputColumns: number;
  handleSubmitCode: (value: string, url: string) => void;
  setOAuthStatus: (status: OAuthStatus) => void;
  setLoginWithClaudeAi: (value: boolean) => void;
};
function OAuthStatusMessage({
  oauthStatus,
  mode,
  startingMessage,
  forcedMethodMessage,
  showPastePrompt,
  pastedCode,
  setPastedCode,
  cursorOffset,
  setCursorOffset,
  textInputColumns,
  handleSubmitCode,
  setOAuthStatus,
  setLoginWithClaudeAi,
}: OAuthStatusMessageProps) {
  switch (oauthStatus.state) {
    case 'idle': {
      const promptText =
        startingMessage ||
        'OpenClaude can be used with your Claude subscription or billed based on API usage through your Console account.'

      // OPENAI_BASE_URL/OPENAI_MODEL in the environment signal an
      // OpenAI-compatible setup the user already has — offer to adopt it as
      // the active provider profile instead of walking them through login for
      // an account they may never have wanted. Env vars alone do NOT activate
      // the route (resolveActiveRouteIdFromEnv requires CLAUDE_CODE_USE_OPENAI
      // or a saved profile), so selecting this saves + activates a profile.
      // Endpoint + model gate the option; dedicated-only routes additionally
      // require their route-owned credential so an incomplete env is not saved.
      // getEnvProviderOption owns the secret-disclosure boundary: only
      // `displayBaseUrl` (redacted) may be rendered — the raw `baseUrl`
      // exists solely for profile creation/activation. See its tests for
      // the credential cases.
      const {
        available: envConfigAvailable,
        varName: envBaseUrlVarName,
        baseUrl: envBaseUrl,
        apiKey: envApiKey,
        displayBaseUrl: envBaseUrlForDisplay,
        model: envModel,
      } = getEnvProviderOption()

      const loginOptions = [
        ...(envConfigAvailable
          ? [
              {
                label: (
                  <Text>
                    Use current environment configuration ·{' '}
                    <Text dimColor>
                      {envBaseUrlVarName}={envBaseUrlForDisplay}
                    </Text>
                    {'\n'}
                  </Text>
                ),
                value: 'environment' as const,
              },
            ]
          : []),
        {
          label: (
            <Text>
              Claude account with subscription ·{' '}
              <Text dimColor>Pro, Max, Team, or Enterprise</Text>
              {'\n'}
            </Text>
          ),
          value: 'claudeai' as const,
        },
        {
          label: (
            <Text>
              Anthropic Console account ·{' '}
              <Text dimColor>API usage billing</Text>
              {'\n'}
            </Text>
          ),
          value: 'console' as const,
        },
        {
          label: (
            <Text>
              3rd-party platform ·{' '}
              <Text dimColor>OpenAI, Gemini, Bedrock, Ollama, and more</Text>
              {'\n'}
            </Text>
          ),
          value: 'platform' as const,
        },
      ]

      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold>{promptText}</Text>
          <Text>Select login method:</Text>
          <Box>
            <Select
              options={loginOptions}
              onChange={value => {
                if (value === 'environment') {
                  // Re-entering this flow with the same env must not stack
                  // near-identical profiles: reuse (and activate) an existing
                  // profile matching the env base URL + model before creating
                  // a new one. setActiveProviderProfile also re-applies the
                  // profile env and syncs the startup profile file.
                  const existing = getProviderProfiles().find(
                    profile =>
                      profile.baseUrl?.trim() === envBaseUrl?.trim() &&
                      profile.model?.trim() === envModel?.trim(),
                  )
                  let saved: ProviderProfile | null
                  if (existing) {
                    // Refresh the stored credential from the environment
                    // before activating: the env is the source of truth the
                    // user just chose, so a rotated route-owned credential must
                    // not leave the profile running on a stale key. Keep the
                    // existing key when the env no longer carries one rather
                    // than blanking a working credential.
                    //
                    // updateProviderProfile REPLACES the profile (toProfile
                    // builds a fresh object, it does not merge), so spread
                    // the existing profile first — otherwise a configured
                    // apiFormat / auth header / customHeaders / context
                    // length would be silently dropped on refresh.
                    const refreshed = updateProviderProfile(
                      existing.id,
                      {
                        ...existing,
                        apiKey: envApiKey ?? existing.apiKey,
                      },
                      { credentialSource: 'environment' },
                    )
                    if (!refreshed) {
                      // The env values failed profile validation. Activating
                      // now would claim a refresh that did not happen, so send
                      // the user to guided setup instead of silently running
                      // on the stale credential.
                      setOAuthStatus({ state: 'platform_setup' })
                      return
                    }
                    saved = setActiveProviderProfile(existing.id)
                  } else {
                    saved = addProviderProfile(
                      {
                        name: getLocalOpenAICompatibleProviderLabel(envBaseUrl),
                        baseUrl: envBaseUrl as string,
                        model: envModel as string,
                        apiKey: envApiKey,
                      },
                      {
                        makeActive: true,
                        credentialSource: 'environment',
                      },
                    )
                  }
                  if (!saved) {
                    // Env values failed profile validation — fall back to the
                    // guided provider setup with fields prefilled from env.
                    setOAuthStatus({ state: 'platform_setup' })
                    return
                  }
                  logEvent('tengu_oauth_env_config_selected', {})
                  setOAuthStatus({
                    state: 'platform_setup_complete',
                    message: `${existing ? 'Activated' : 'Saved'} ${saved.name} (${envBaseUrlForDisplay}) as your active provider.`,
                  })
                  return
                }
                if (value === 'platform') {
                  logEvent('tengu_oauth_platform_selected', {})
                  setOAuthStatus({ state: 'platform_setup' })
                  return
                }

                setOAuthStatus({ state: 'ready_to_start' })
                if (value === 'claudeai') {
                  logEvent('tengu_oauth_claudeai_selected', {})
                  setLoginWithClaudeAi(true)
                } else {
                  logEvent('tengu_oauth_console_selected', {})
                  setLoginWithClaudeAi(false)
                }
              }}
            />
          </Box>
        </Box>
      )
    }

    case 'platform_setup':
      return (
        <ProviderManager
          mode="first-run"
          onDone={result => {
            if (!result || result.action !== 'saved' || !result.message) {
              setOAuthStatus({ state: 'idle' })
              return
            }

            setOAuthStatus({
              state: 'platform_setup_complete',
              message: result.message,
            })
          }}
        />
      )

    case 'platform_setup_complete':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="success">{oauthStatus.message}</Text>
          <Text dimColor>
            Press <Text bold>Enter</Text> to continue.
          </Text>
        </Box>
      )

    case 'waiting_for_login':
      return (
        <Box flexDirection="column" gap={1}>
          {forcedMethodMessage ? (
            <Box>
              <Text dimColor>{forcedMethodMessage}</Text>
            </Box>
          ) : null}
          {!showPastePrompt ? (
            <Box>
              <Spinner />
              <Text>Opening browser to sign in…</Text>
            </Box>
          ) : null}
          {showPastePrompt ? (
            <Box>
              <Text>{PASTE_HERE_MSG}</Text>
              <TextInput
                value={pastedCode}
                onChange={setPastedCode}
                onSubmit={value => handleSubmitCode(value, oauthStatus.url)}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                columns={textInputColumns}
                mask="*"
              />
            </Box>
          ) : null}
        </Box>
      )

    case 'creating_api_key':
      return (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Spinner />
            <Text>Creating API key for OpenClaude…</Text>
          </Box>
        </Box>
      )

    case 'about_to_retry':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="permission">Retrying…</Text>
        </Box>
      )

    case 'success':
      return (
        <Box flexDirection="column">
          {mode === 'setup-token' && oauthStatus.token ? null : (
            <>
              {getOauthAccountInfo()?.emailAddress ? (
                <Text dimColor>
                  Logged in as <Text>{getOauthAccountInfo()?.emailAddress}</Text>
                </Text>
              ) : null}
              <Text color="success">
                Login successful. Press <Text bold>Enter</Text> to continue…
              </Text>
            </>
          )}
        </Box>
      )

    case 'error':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="error">OAuth error: {oauthStatus.message}</Text>
          {oauthStatus.toRetry ? (
            <Box marginTop={1}>
              <Text color="permission">
                Press <Text bold>Enter</Text> to retry.
              </Text>
            </Box>
          ) : null}
        </Box>
      )

    default:
      return null
  }
}
