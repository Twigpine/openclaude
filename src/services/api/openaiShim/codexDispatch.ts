import { APIError } from '@anthropic-ai/sdk'
import {
  readCodexCredentialsAsync,
  refreshCodexAccessTokenIfNeeded,
} from '../../../utils/codexCredentials.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isBareMode } from '../../../utils/envUtils.js'
import { COPILOT_HEADERS } from '../../github/deviceFlow.js'
import { refreshCopilotTokenOn401 } from '../../../utils/githubModelsCredentials.js'
import {
  performCodexRequest,
  type ShimCreateParams,
} from '../codexShim.js'
import {
  getGithubEndpointType,
  resolveRuntimeCodexCredentials,
  type ResolvedProviderRequest,
} from '../providerConfig.js'
import {
  redactSecretValueForDisplay,
  type SecretValueSource,
} from '../../../utils/providerProfile.js'
import {
  filterAnthropicHeaders,
  isGithubModelsMode,
} from './providerCompatibility.js'

type PerformCodexRequest = typeof performCodexRequest
type ResponseHeadersTimeoutClassification = Error | undefined

export type CodexDispatchDependencies = {
  classifyResponseHeadersTimeout(
    error: unknown,
    requestUrl: string,
    model: string,
  ): ResponseHeadersTimeoutClassification
  fetchWithHeadersDeadline(
    url: string,
    init: RequestInit,
    options: { callerSignal?: AbortSignal; timeoutMs: number },
  ): Promise<Response>
  getApiTimeoutMs(): number
  isCopilotTokenExpiredError(text: string): boolean
  preserveCallerAbortError(error: unknown, callerSignal: AbortSignal): unknown
}

type CodexDispatchOperations = {
  isGithubModelsMode: typeof isGithubModelsMode
  performCodexRequest: PerformCodexRequest
  readCodexCredentialsAsync: typeof readCodexCredentialsAsync
  refreshCodexAccessTokenIfNeeded: typeof refreshCodexAccessTokenIfNeeded
  refreshCopilotTokenOn401: typeof refreshCopilotTokenOn401
}

const defaultOperations: CodexDispatchOperations = {
  isGithubModelsMode,
  performCodexRequest,
  readCodexCredentialsAsync,
  refreshCodexAccessTokenIfNeeded,
  refreshCopilotTokenOn401,
}

export async function dispatchCodexRequest(options: {
  request: ResolvedProviderRequest
  params: ShimCreateParams
  requestOptions?: { signal?: AbortSignal; headers?: Record<string, string> }
  defaultHeaders: Record<string, string>
  providerOverrideApiKey?: string
  dependencies: CodexDispatchDependencies
  operations?: Partial<CodexDispatchOperations>
}): Promise<Response | null> {
  const {
    request,
    params,
    requestOptions,
    defaultHeaders,
    providerOverrideApiKey,
    dependencies,
  } = options
  const operations = { ...defaultOperations, ...options.operations }
  const githubEndpointType = getGithubEndpointType(request.baseUrl)
  const isGithubMode = operations.isGithubModelsMode()
  const isGithubCopilotEndpoint =
    isGithubMode &&
    (githubEndpointType === 'copilot' || githubEndpointType === 'ghe')

  if (isGithubCopilotEndpoint && request.transport === 'codex_responses') {
    const apiTimeoutMs = dependencies.getApiTimeoutMs()
    const responsesUrl = `${request.baseUrl}/responses`
    let didRefreshToken = false
    let refreshedToken: string | undefined

    for (let attempt = 0; attempt < 2; attempt++) {
      const apiKey =
        refreshedToken ??
        providerOverrideApiKey ??
        process.env.OPENAI_API_KEY ??
        ''
      if (!apiKey) {
        throw new Error(
          'GitHub Copilot auth is required. Run /onboard-github to sign in.',
        )
      }

      try {
        try {
          return await operations.performCodexRequest({
            request,
            credentials: { apiKey, source: 'env' },
            params,
            defaultHeaders: {
              ...defaultHeaders,
              ...filterAnthropicHeaders(requestOptions?.headers),
              ...COPILOT_HEADERS,
            },
            signal: requestOptions?.signal,
            fetcher: (input, init) => {
              const url =
                typeof input === 'string'
                  ? input
                  : input instanceof URL
                    ? input.toString()
                    : input.url
              return dependencies.fetchWithHeadersDeadline(url, init ?? {}, {
                callerSignal: requestOptions?.signal,
                timeoutMs: apiTimeoutMs,
              })
            },
          })
        } catch (error) {
          if (requestOptions?.signal?.aborted) {
            throw dependencies.preserveCallerAbortError(
              error,
              requestOptions.signal,
            )
          }
          const timeoutError = dependencies.classifyResponseHeadersTimeout(
            error,
            responsesUrl,
            request.resolvedModel,
          )
          if (timeoutError !== undefined) throw timeoutError
          throw error
        }
      } catch (error) {
        if (
          !didRefreshToken &&
          error instanceof APIError &&
          error.status === 401 &&
          apiKey === (process.env.OPENAI_API_KEY ?? '') &&
          dependencies.isCopilotTokenExpiredError(error.message)
        ) {
          didRefreshToken = true
          if (await operations.refreshCopilotTokenOn401()) {
            const newApiKey = process.env.OPENAI_API_KEY?.trim() || ''
            if (newApiKey && newApiKey !== apiKey) {
              refreshedToken = newApiKey
              continue
            }
          }
        }
        throw error
      }
    }
  }

  if (request.transport !== 'codex_responses' || isGithubMode) return null

  const refreshResult = await operations.refreshCodexAccessTokenIfNeeded().catch(
    async error => {
      logForDebugging(
        `[codex] access token refresh failed before request: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
      return {
        refreshed: false,
        credentials: await operations.readCodexCredentialsAsync(),
      }
    },
  )
  const credentials = resolveRuntimeCodexCredentials({
    storedCredentials: refreshResult.credentials,
  })
  if (!credentials.apiKey) {
    const oauthHint = isBareMode() ? '' : ', choose Codex OAuth in /provider'
    const authHint = credentials.authPath
      ? `${oauthHint} or place a Codex auth.json at ${credentials.authPath}`
      : oauthHint
    const safeModel =
      redactSecretValueForDisplay(
        request.requestedModel,
        process.env as SecretValueSource,
      ) ?? 'the requested model'
    throw new Error(
      `Codex auth is required for ${safeModel}. Set CODEX_API_KEY${authHint}.`,
    )
  }
  if (!credentials.accountId) {
    throw new Error(
      'Codex auth is missing chatgpt_account_id. Re-login with Codex OAuth, the Codex CLI, or set CHATGPT_ACCOUNT_ID/CODEX_ACCOUNT_ID.',
    )
  }

  return operations.performCodexRequest({
    request,
    credentials,
    params,
    defaultHeaders: {
      ...defaultHeaders,
      ...filterAnthropicHeaders(requestOptions?.headers),
    },
    signal: requestOptions?.signal,
  })
}
