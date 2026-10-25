import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { color, Text } from '../ink.js';
import type { MCPServerConnection } from '../services/mcp/types.js';
import { getAccountInformation, isClaudeAISubscriber } from './auth.js';
import { getLargeMemoryFiles, getMemoryFiles, MAX_MEMORY_CHARACTER_COUNT } from './claudemd.js';
import { getDoctorDiagnostic } from './doctorDiagnostic.js';
import { getAWSRegion, getDefaultVertexRegion, isEnvTruthy } from './envUtils.js';
import { getDisplayPath } from './file.js';
import { formatNumber } from './format.js';
import { getIdeClientName, type IDEExtensionInstallationStatus, isJetBrainsIde, toIDEDisplayName } from './ide.js';
import { getClaudeAiUserDefaultModelDescription, modelDisplayString } from './model/model.js';
import { getAPIProvider, type APIProvider } from './model/providers.js';
import { resolveProviderRequest } from '../services/api/providerConfig.js';
import { getMTLSConfig } from './mtls.js';
import { checkInstall } from './nativeInstaller/index.js';
import { getProxyUrl } from './proxy.js';
import { SandboxManager } from './sandbox/sandbox-adapter.js';
import { getSettingsWithAllErrors } from './settings/allErrors.js';
import { getEnabledSettingSources, getSettingSourceDisplayNameCapitalized } from './settings/constants.js';
import { getManagedFileSettingsPresence, getPolicySettingsOrigin, getSettingsForSource } from './settings/settings.js';
import type { ThemeName } from './theme.js';
import { getKnownProviderSecretEnvKeys, redactSecretSubstringsForDisplay, redactSecretValueForDisplay, sanitizeApiKey, type SecretValueSource } from './providerSecrets.js';
import { redactPathForStatus, redactUrlForStatus } from './redaction.js';
import {
  geminiVertexAdcWillResolveProject,
  getGeminiVertexLocation,
  getGeminiVertexModel,
  getGeminiVertexProjectId,
  resolveGeminiVertexAuthMode,
} from './geminiAuth.js';
import {
  getRouteCredentialEnvVars,
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getRouteLabel,
  getRouteProviderTypeLabel,
  resolveActiveRouteIdFromEnv,
} from '../integrations/routeMetadata.js';
export type Property = {
  label?: string;
  value: React.ReactNode | Array<string>;
};
export type Diagnostic = React.ReactNode;

const API_PROVIDER_LABELS: Partial<Record<APIProvider, string>> = {
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  openai: 'OpenAI-compatible',
  codex: 'Codex',
  gemini: 'Google AI / Gemini',
  'gemini-vertex': 'Google Vertex AI (Gemini)',
  github: 'GitHub Models',
  'nvidia-nim': 'NVIDIA NIM',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  xai: 'xAI',
  'xiaomi-mimo': 'Xiaomi MiMo',
};

const OPENAI_COMPATIBLE_STATUS_METADATA: Partial<
  Record<
    APIProvider,
    {
      baseUrlLabel: string;
      resolveModelMetadata?: boolean;
    }
  >
> = {
  openai: {
    baseUrlLabel: 'OpenAI base URL',
    resolveModelMetadata: true,
  },
  codex: {
    baseUrlLabel: 'Codex base URL',
    resolveModelMetadata: true,
  },
  'nvidia-nim': {
    baseUrlLabel: 'NVIDIA NIM base URL',
  },
  minimax: {
    baseUrlLabel: 'MiniMax base URL',
  },
  xai: {
    baseUrlLabel: 'xAI base URL',
    resolveModelMetadata: true,
  },
  'xiaomi-mimo': {
    baseUrlLabel: 'Xiaomi MiMo base URL',
  },
};

const MIN_CONFIGURED_SECRET_SUBSTRING_LENGTH = 9;
const MAX_CONFIGURED_SECRET_ENCODING_DEPTH = 3;

function formatOpenAICompatibleModelDisplay(
  model: string,
  resolveModelMetadata = false,
): string {
  if (!resolveModelMetadata) {
    return model;
  }

  let modelDisplay = model;
  const resolved = resolveProviderRequest({ model });
  const resolvedModel = resolved.resolvedModel;
  const reasoningEffort = resolved.reasoning?.effort;

  if (resolvedModel && resolvedModel !== model.toLowerCase()) {
    modelDisplay = resolvedModel;
  }

  if (reasoningEffort) {
    modelDisplay = `${modelDisplay} (${reasoningEffort})`;
  }

  return modelDisplay;
}

function pushRedactedProperty(
  properties: Property[],
  label: string,
  value: string | undefined,
  secretSource: SecretValueSource,
): void {
  if (!value) {
    return;
  }

  const secretRedacted = redactSecretValueForDisplay(value, secretSource) ?? value;
  properties.push({
    label,
    value: redactStatusTextForDisplay(secretRedacted, secretSource)
  });
}

function getConfiguredSecretValues(secretSource: SecretValueSource): string[] {
  return Array.from(
    new Set(
      Object.values(secretSource)
        .map(secret => sanitizeApiKey(secret)?.trim())
        .filter((secret): secret is string => Boolean(secret)),
    ),
  );
}

function getConfiguredSecretSubstringSource(
  secretSource: SecretValueSource,
): SecretValueSource {
  const substringSource: SecretValueSource = {};
  for (const [key, value] of Object.entries(secretSource)) {
    const secret = sanitizeApiKey(value)?.trim();
    if (secret && secret.length >= MIN_CONFIGURED_SECRET_SUBSTRING_LENGTH) {
      substringSource[key] = value;
    }
  }
  return substringSource;
}

function encodeURIComponentStrict(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    character =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function addPercentEscapeCaseVariants(
  variants: Set<string>,
  value: string,
): void {
  variants.add(value);
  variants.add(
    value.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()),
  );
}

function addEncodedSecretVariants(
  variants: Set<string>,
  value: string,
): void {
  let encoded = value;
  let strictlyEncoded = value;
  for (let depth = 0; depth < MAX_CONFIGURED_SECRET_ENCODING_DEPTH; depth++) {
    encoded = encodeURIComponent(encoded);
    addPercentEscapeCaseVariants(variants, encoded);

    strictlyEncoded = encodeURIComponentStrict(strictlyEncoded);
    addPercentEscapeCaseVariants(variants, strictlyEncoded);
  }
}

function getConfiguredSecretSubstringVariants(secret: string): string[] {
  const variants = new Set<string>([secret]);
  addEncodedSecretVariants(variants, secret);

  const formEncoded = secret.includes(' ')
    ? secret.replace(/ /g, '+')
    : secret;
  if (formEncoded !== secret) {
    variants.add(formEncoded);
    addEncodedSecretVariants(variants, formEncoded);
  }

  return [...variants].sort((a, b) => b.length - a.length);
}

function redactConfiguredSecretSubstrings(
  value: string,
  secretSource: SecretValueSource,
): string {
  let redacted = value;
  const secrets = getConfiguredSecretValues(secretSource)
    .filter(secret => secret.length >= MIN_CONFIGURED_SECRET_SUBSTRING_LENGTH)
    .sort((a, b) => b.length - a.length);

  for (const secret of secrets) {
    for (const variant of getConfiguredSecretSubstringVariants(secret)) {
      redacted = redacted.split(variant).join('redacted');
    }
  }

  return redacted;
}

function queryValueMatchesConfiguredSecret(
  value: string,
  secrets: ReadonlySet<string>,
): boolean {
  let decoded = value;
  for (let depth = 0; depth < MAX_CONFIGURED_SECRET_ENCODING_DEPTH; depth++) {
    if (secrets.has(decoded)) {
      return true;
    }

    const formDecoded = decoded.includes('+')
      ? decoded.replace(/\+/g, ' ')
      : decoded;
    if (formDecoded !== decoded && secrets.has(formDecoded)) {
      return true;
    }

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }

    if (next === decoded) {
      return false;
    }
    if (secrets.has(next)) {
      return true;
    }
    decoded = next;
  }

  return false;
}

function redactConfiguredSecretUrlQueryValues(
  value: string,
  secretSource: SecretValueSource,
): string {
  const secrets = new Set(getConfiguredSecretValues(secretSource));
  if (secrets.size === 0) {
    return value;
  }

  try {
    const parsed = new URL(value);
    const redactedParams = new URLSearchParams();
    let changed = false;

    for (const [key, queryValue] of parsed.searchParams.entries()) {
      if (queryValueMatchesConfiguredSecret(queryValue, secrets)) {
        redactedParams.append(key, 'redacted');
        changed = true;
      } else {
        redactedParams.append(key, queryValue);
      }
    }

    if (!changed) {
      return value;
    }

    parsed.search = redactedParams.toString();
    return parsed.toString();
  } catch {
    return value;
  }
}

function redactStatusTextForDisplay(
  value: string,
  secretSource: SecretValueSource,
): string {
  const configuredSecretRedacted = redactConfiguredSecretSubstrings(
    value,
    secretSource,
  );
  return (
    redactSecretSubstringsForDisplay(
      configuredSecretRedacted,
      getConfiguredSecretSubstringSource(secretSource),
    ) ??
    configuredSecretRedacted
  );
}

function pushRedactedUrlProperty(
  properties: Property[],
  label: string,
  value: string | undefined,
  secretSource: SecretValueSource,
): void {
  if (!value) {
    return;
  }

  const queryValueRedacted = redactConfiguredSecretUrlQueryValues(
    value,
    secretSource,
  );
  const urlRedacted = redactUrlForStatus(queryValueRedacted);
  properties.push({
    label,
    value: redactStatusTextForDisplay(urlRedacted, secretSource)
  });
}

function readTrimmedEnvValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/**
 * Builds a process env copy whose OpenAI base URL aliases follow the same
 * trimming and fallback rules used by the status display fields.
 */
function buildRouteResolutionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const openAIBaseUrl = readTrimmedEnvValue('OPENAI_BASE_URL');
  const openAIApiBase = readTrimmedEnvValue('OPENAI_API_BASE');

  if (openAIBaseUrl) {
    env.OPENAI_BASE_URL = openAIBaseUrl;
  } else {
    delete env.OPENAI_BASE_URL;
  }

  if (openAIApiBase) {
    env.OPENAI_API_BASE = openAIApiBase;
  } else {
    delete env.OPENAI_API_BASE;
  }

  return env;
}

/**
 * Resolves the active provider route from the environment. Returns the route id
 * when it identifies a concrete gateway/vendor (e.g. "openrouter", "groq",
 * "ollama", "openai"), and null for the generic "custom" fallback, the
 * first-party "anthropic" route, or when route resolution is unavailable.
 */
function resolveDisplayRouteId(): string | null {
  const routeId = resolveActiveRouteIdFromEnv(buildRouteResolutionEnv());
  if (!routeId || routeId === 'custom' || routeId === 'anthropic') {
    return null;
  }
  return routeId;
}

/**
 * Builds a credential source summary (env var names only, never values) for the
 * given route. Returns null when no credential env vars are configured or known.
 */
function buildRouteCredentialSummary(routeId: string): string | null {
  const envVars = getRouteCredentialEnvVars(routeId);
  const configured = envVars.filter(name =>
    Boolean(process.env[name]?.trim()),
  );
  if (configured.length === 0) {
    return null;
  }
  return configured.map(name => `${name} configured`).join(', ');
}

/**
 * Collects route-specific credential env values so status fields redact secrets
 * from descriptor-backed providers, not only legacy provider buckets.
 */
function buildRouteSecretSource(routeId: string | null): SecretValueSource {
  if (!routeId) {
    return {};
  }

  return Object.fromEntries(
    getRouteCredentialEnvVars(routeId).map(name => [name, process.env[name]]),
  );
}

/**
 * Returns the active OpenAI-compatible base URL shown in status, including the
 * legacy OPENAI_API_BASE alias and descriptor defaults for env-only routes.
 */
function getOpenAICompatibleBaseUrlForStatus(
  routeId: string | null,
): string | undefined {
  return (
    readTrimmedEnvValue('OPENAI_BASE_URL') ||
    readTrimmedEnvValue('OPENAI_API_BASE') ||
    (routeId ? getRouteDefaultBaseUrl(routeId) : undefined)
  );
}

/**
 * Returns the active OpenAI-compatible model shown in status, falling back to
 * descriptor defaults for routes selected only by credential env vars.
 */
function getOpenAICompatibleModelForStatus(
  routeId: string | null,
): string | undefined {
  return (
    readTrimmedEnvValue('OPENAI_MODEL') ||
    (routeId ? getRouteDefaultModel(routeId) : undefined)
  );
}
export function buildSandboxProperties(): Property[] {
  if (process.env.USER_TYPE !== 'ant') {
    return [];
  }
  const isSandboxed = SandboxManager.isSandboxingEnabled();
  return [{
    label: 'Bash Sandbox',
    value: isSandboxed ? 'Enabled' : 'Disabled'
  }];
}
export function buildIDEProperties(mcpClients: MCPServerConnection[], ideInstallationStatus: IDEExtensionInstallationStatus | null = null, theme: ThemeName): Property[] {
  const ideClient = mcpClients?.find(client => client.name === 'ide');
  if (ideInstallationStatus) {
    const ideName = toIDEDisplayName(ideInstallationStatus.ideType);
    const pluginOrExtension = isJetBrainsIde(ideInstallationStatus.ideType) ? 'plugin' : 'extension';
    if (ideInstallationStatus.error) {
      return [{
        label: 'IDE',
        value: <Text>
              {color('error', theme)(figures.cross)} Error installing {ideName}{' '}
              {pluginOrExtension}: {ideInstallationStatus.error}
              {'\n'}Please restart your IDE and try again.
            </Text>
      }];
    }
    if (ideInstallationStatus.installed) {
      if (ideClient && ideClient.type === 'connected') {
        if (ideInstallationStatus.installedVersion !== ideClient.serverInfo?.version) {
          return [{
            label: 'IDE',
            value: `Connected to ${ideName} ${pluginOrExtension} version ${ideInstallationStatus.installedVersion} (server version: ${ideClient.serverInfo?.version})`
          }];
        } else {
          return [{
            label: 'IDE',
            value: `Connected to ${ideName} ${pluginOrExtension} version ${ideInstallationStatus.installedVersion}`
          }];
        }
      } else {
        return [{
          label: 'IDE',
          value: `Installed ${ideName} ${pluginOrExtension}`
        }];
      }
    }
  } else if (ideClient) {
    const ideName = getIdeClientName(ideClient) ?? 'IDE';
    if (ideClient.type === 'connected') {
      return [{
        label: 'IDE',
        value: `Connected to ${ideName} extension`
      }];
    } else {
      return [{
        label: 'IDE',
        value: `${color('error', theme)(figures.cross)} Not connected to ${ideName}`
      }];
    }
  }
  return [];
}
export function buildMcpProperties(clients: MCPServerConnection[] = [], theme: ThemeName): Property[] {
  const servers = clients.filter(client => client.name !== 'ide');
  if (!servers.length) {
    return [];
  }

  // Summary instead of a full server list — 20+ servers wrapped onto many
  // rows, dominating the Status pane. Show counts by state + /mcp hint.
  const byState = {
    connected: 0,
    pending: 0,
    needsAuth: 0,
    failed: 0
  };
  for (const s of servers) {
    if (s.type === 'connected') byState.connected++;else if (s.type === 'pending') byState.pending++;else if (s.type === 'needs-auth') byState.needsAuth++;else byState.failed++;
  }
  const parts: string[] = [];
  if (byState.connected) parts.push(color('success', theme)(`${byState.connected} connected`));
  if (byState.needsAuth) parts.push(color('warning', theme)(`${byState.needsAuth} need auth`));
  if (byState.pending) parts.push(color('inactive', theme)(`${byState.pending} pending`));
  if (byState.failed) parts.push(color('error', theme)(`${byState.failed} failed`));
  return [{
    label: 'MCP servers',
    value: `${parts.join(', ')} ${color('inactive', theme)('· /mcp')}`
  }];
}
export async function buildMemoryDiagnostics(): Promise<Diagnostic[]> {
  const files = await getMemoryFiles();
  const largeFiles = getLargeMemoryFiles(files);
  const diagnostics: Diagnostic[] = [];
  largeFiles.forEach(file => {
    const displayPath = getDisplayPath(file.path);
    diagnostics.push(`Large ${displayPath} will impact performance (${formatNumber(file.content.length)} chars > ${formatNumber(MAX_MEMORY_CHARACTER_COUNT)})`);
  });
  return diagnostics;
}
export function buildSettingSourcesProperties(): Property[] {
  const enabledSources = getEnabledSettingSources();

  // Filter to only sources that actually have settings loaded
  const sourcesWithSettings = enabledSources.filter(source => {
    const settings = getSettingsForSource(source);
    return settings !== null && Object.keys(settings).length > 0;
  });

  // Map internal names to user-friendly names
  // For policySettings, distinguish between remote and local (or skip if neither exists)
  const sourceNames = sourcesWithSettings.map(source => {
    if (source === 'policySettings') {
      const origin = getPolicySettingsOrigin();
      if (origin === null) {
        return null; // Skip - no policy settings exist
      }
      switch (origin) {
        case 'remote':
          return 'Enterprise managed settings (remote)';
        case 'plist':
          return 'Enterprise managed settings (plist)';
        case 'hklm':
          return 'Enterprise managed settings (HKLM)';
        case 'file':
          {
            const {
              hasBase,
              hasDropIns
            } = getManagedFileSettingsPresence();
            if (hasBase && hasDropIns) {
              return 'Enterprise managed settings (file + drop-ins)';
            }
            if (hasDropIns) {
              return 'Enterprise managed settings (drop-ins)';
            }
            return 'Enterprise managed settings (file)';
          }
        case 'hkcu':
          return 'Enterprise managed settings (HKCU)';
      }
    }
    return getSettingSourceDisplayNameCapitalized(source);
  }).filter((name): name is string => name !== null);
  return [{
    label: 'Setting sources',
    value: sourceNames
  }];
}
export async function buildInstallationDiagnostics(): Promise<Diagnostic[]> {
  const installWarnings = await checkInstall();
  return installWarnings.map(warning => warning.message);
}
export async function buildInstallationHealthDiagnostics(): Promise<Diagnostic[]> {
  const diagnostic = await getDoctorDiagnostic();
  const items: Diagnostic[] = [];
  const {
    errors: validationErrors
  } = getSettingsWithAllErrors();
  if (validationErrors.length > 0) {
    const invalidFiles = Array.from(new Set(validationErrors.map(error => error.file)));
    const fileList = invalidFiles.join(', ');
    items.push(`Found invalid settings files: ${fileList}. They will be ignored.`);
  }

  // Add warnings from doctor diagnostic (includes leftover installations, config mismatches, etc.)
  diagnostic.warnings.forEach(warning => {
    items.push(warning.issue);
  });
  if (diagnostic.hasUpdatePermissions === false) {
    items.push('No write permissions for auto-updates (requires sudo)');
  }
  return items;
}
export function buildAccountProperties(): Property[] {
  const accountInfo = getAccountInformation();
  if (!accountInfo) {
    return [];
  }
  const properties: Property[] = [];
  if (accountInfo.subscription) {
    properties.push({
      label: 'Login method',
      value: `${accountInfo.subscription} Account`
    });
  }
  if (accountInfo.tokenSource) {
    properties.push({
      label: 'Auth token',
      value: accountInfo.tokenSource
    });
  }
  if (accountInfo.apiKeySource) {
    properties.push({
      label: 'API key',
      value: accountInfo.apiKeySource
    });
  }

  // Hide sensitive account info in demo mode
  if (accountInfo.organization && !process.env.IS_DEMO) {
    properties.push({
      label: 'Organization',
      value: accountInfo.organization
    });
  }
  if (accountInfo.email && !process.env.IS_DEMO) {
    properties.push({
      label: 'Email',
      value: accountInfo.email
    });
  }
  return properties;
}
export function buildAPIProviderProperties(): Property[] {
  const apiProvider = getAPIProvider();
  const properties: Property[] = [];
  const secretSource: SecretValueSource = {};
  for (const key of getKnownProviderSecretEnvKeys()) {
    const envValue = process.env[key];
    if (envValue !== undefined) {
      secretSource[key] = envValue;
    }
  }
  const routeId =
    apiProvider === 'openai' ? resolveDisplayRouteId() : null;
  if (apiProvider !== 'firstParty') {
    // The legacy "openai" bucket collapses many concrete providers (OpenRouter,
    // Groq, Ollama, Fireworks, etc.) into a single "OpenAI-compatible" label.
    // When route resolution identifies a concrete provider, surface its real
    // label instead. Dedicated buckets (nvidia-nim, minimax, codex, github,
    // xai, ...) already have accurate labels and are left untouched.
    const routeLabel = routeId ? getRouteLabel(routeId) : null;
    const providerLabel = routeLabel ?? API_PROVIDER_LABELS[apiProvider];
    properties.push({
      label: routeId ? 'Provider route' : 'API provider',
      value: providerLabel
    });
  }
  if (apiProvider === 'firstParty') {
    pushRedactedUrlProperty(
      properties,
      'Anthropic base URL',
      process.env.ANTHROPIC_BASE_URL,
      secretSource,
    );
  } else if (apiProvider === 'bedrock') {
    pushRedactedUrlProperty(
      properties,
      'Bedrock base URL',
      process.env.BEDROCK_BASE_URL,
      secretSource,
    );
    properties.push({
      label: 'AWS region',
      value: getAWSRegion()
    });
    if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
      properties.push({
        value: 'AWS auth skipped'
      });
    }
  } else if (apiProvider === 'vertex') {
    pushRedactedUrlProperty(
      properties,
      'Vertex base URL',
      process.env.VERTEX_BASE_URL,
      secretSource,
    );
    const gcpProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    if (gcpProject) {
      properties.push({
        label: 'GCP project',
        value: gcpProject
      });
    }
    properties.push({
      label: 'Default region',
      value: getDefaultVertexRegion()
    });
    if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      properties.push({
        value: 'GCP auth skipped'
      });
    }
  } else if (apiProvider === 'foundry') {
    pushRedactedUrlProperty(
      properties,
      'Microsoft Foundry base URL',
      process.env.ANTHROPIC_FOUNDRY_BASE_URL,
      secretSource,
    );
    const foundryResource = process.env.ANTHROPIC_FOUNDRY_RESOURCE;
    if (foundryResource) {
      properties.push({
        label: 'Microsoft Foundry resource',
        value: foundryResource
      });
    }
    if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
      properties.push({
        value: 'Microsoft Foundry auth skipped'
      });
    }
  } else if (apiProvider in OPENAI_COMPATIBLE_STATUS_METADATA) {
    const metadata =
      OPENAI_COMPATIBLE_STATUS_METADATA[apiProvider]!;
    const transportLabel = routeId
      ? getRouteProviderTypeLabel(routeId)
      : null;
    const redactionSource: SecretValueSource = {
      ...secretSource,
      ...buildRouteSecretSource(routeId),
    };
    if (transportLabel) {
      properties.push({
        label: 'Transport',
        value: transportLabel,
      });
    }
    pushRedactedUrlProperty(
      properties,
      metadata.baseUrlLabel,
      getOpenAICompatibleBaseUrlForStatus(routeId),
      redactionSource,
    );
    const openaiModel = getOpenAICompatibleModelForStatus(routeId);
    if (openaiModel) {
      const modelDisplay = formatOpenAICompatibleModelDisplay(
        openaiModel,
        metadata.resolveModelMetadata,
      );
      pushRedactedProperty(
        properties,
        'Model',
        modelDisplay,
        redactionSource,
      );
    }
    if (routeId) {
      const credentialSummary = buildRouteCredentialSummary(routeId);
      if (credentialSummary) {
        properties.push({
          label: 'Credential',
          value: credentialSummary,
        });
      }
    }
  } else if (apiProvider === 'gemini') {
    const geminiBaseUrl = process.env.GEMINI_BASE_URL;
    pushRedactedUrlProperty(properties, 'Gemini base URL', geminiBaseUrl, secretSource);
    const geminiModel = process.env.GEMINI_MODEL;
    pushRedactedProperty(properties, 'Model', geminiModel, secretSource);
  } else if (apiProvider === 'gemini-vertex') {
    // Mirror the /provider summary's native Vertex endpoint/model display. By the
    // time /status runs the explicit provider env has been applied to
    // process.env, matching getAnthropicClient's env-only routing.
    const location = getGeminiVertexLocation(process.env);
    const project = getGeminiVertexProjectId(process.env);
    // An explicit ADC credential lets the native client derive the project at
    // runtime; show a neutral placeholder there instead of an actionable hint.
    const projectSegment =
      project ??
      (geminiVertexAdcWillResolveProject(process.env)
        ? '<ADC-resolved project>'
        : '<set GEMINI_VERTEX_PROJECT>');
    const endpoint = `https://aiplatform.googleapis.com/v1/projects/${projectSegment}/locations/${location}`;
    pushRedactedUrlProperty(properties, 'Vertex endpoint', endpoint, secretSource);
    pushRedactedProperty(properties, 'Model', getGeminiVertexModel(process.env), secretSource);
    properties.push({
      label: 'Credential',
      value:
        resolveGeminiVertexAuthMode(process.env) === 'access-token'
          ? 'access token'
          : 'Google ADC',
    });
  } else if (apiProvider === 'mistral') {
    const mistralBaseUrl = process.env.MISTRAL_BASE_URL;
    pushRedactedUrlProperty(properties, 'Mistral base URL', mistralBaseUrl, secretSource);
    const mistralModel = process.env.MISTRAL_MODEL;
    pushRedactedProperty(properties, 'Model', mistralModel, secretSource);
  }
  const proxyUrl = getProxyUrl();
  pushRedactedUrlProperty(properties, 'Proxy', proxyUrl, secretSource);
  const mtlsConfig = getMTLSConfig();
  if (process.env.NODE_EXTRA_CA_CERTS) {
    properties.push({
      label: 'Additional CA cert(s)',
      value: redactPathForStatus(process.env.NODE_EXTRA_CA_CERTS)
    });
  }
  if (mtlsConfig) {
    if (mtlsConfig.cert && process.env.CLAUDE_CODE_CLIENT_CERT) {
      properties.push({
        label: 'mTLS client cert',
        value: redactPathForStatus(process.env.CLAUDE_CODE_CLIENT_CERT)
      });
    }
    if (mtlsConfig.key && process.env.CLAUDE_CODE_CLIENT_KEY) {
      properties.push({
        label: 'mTLS client key',
        value: 'configured'
      });
    }
  }
  return properties;
}
export function getModelDisplayLabel(mainLoopModel: string | null): string {
  let modelLabel = modelDisplayString(mainLoopModel);
  if (mainLoopModel === null && isClaudeAISubscriber()) {
    const description = getClaudeAiUserDefaultModelDescription();
    modelLabel = `${chalk.bold('Default')} ${description}`;
  }
  return modelLabel;
}
