const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  chooseLaunchWorkspace,
  describeProviderState,
  findCommandPath,
  isPathInsideWorkspace,
  parseProfileFile,
  resolveCommandCheckPath,
} = require('./state');
const { buildControlCenterViewModel } = require('./presentation');
const { ChatController, OpenClaudeChatViewProvider, OpenClaudeChatPanelManager } = require('./chat/chatProvider');
const { SessionManager } = require('./chat/sessionManager');
const { DiffContentProvider, SCHEME: DIFF_SCHEME } = require('./chat/diffController');

const OPENCLAUDE_REPO_URL = 'https://github.com/Twigpine/openclaude';
const OPENCLAUDE_SETUP_URL = 'https://github.com/Twigpine/openclaude/blob/main/README.md#quick-start';
const PROFILE_FILE_NAME = '.openclaude-profile.json';
const SECRET_AZURE_API_KEY = 'openclaude.azure.apiKey';

/** @type {vscode.ExtensionContext | null} */
let extensionContext = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function isCommandAvailable(command, launchCwd) {
  return Boolean(findCommandPath(command, { cwd: launchCwd }));
}

function getExecutableFromCommand(command) {
  const normalized = String(command || '').trim();
  if (!normalized) {
    return '';
  }

  const doubleQuotedMatch = normalized.match(/^"([^"]+)"/);
  if (doubleQuotedMatch) {
    return doubleQuotedMatch[1];
  }

  const singleQuotedMatch = normalized.match(/^'([^']+)'/);
  if (singleQuotedMatch) {
    return singleQuotedMatch[1];
  }

  return normalized.split(/\s+/)[0];
}

/**
 * @param {string} raw
 */
function normalizeAzureEndpoint(raw) {
  const t = (raw || '').trim();
  if (!t) {
    return '';
  }
  try {
    const u = new URL(t);
    const pathname = u.pathname.replace(/\/+$/, '');
    return `${u.origin}${pathname}`;
  } catch {
    return t.replace(/\/+$/, '');
  }
}

/**
 * @param {vscode.ExtensionContext | null} context
 * @param {vscode.WorkspaceConfiguration} configured
 */
async function resolveAzureApiKey(context, configured) {
  if (!context) {
    return '';
  }
  const fromSecret = await context.secrets.get(SECRET_AZURE_API_KEY);
  if (fromSecret) {
    return fromSecret;
  }
  return (configured.get('azure.apiKey', '') || '').trim();
}

/**
 * @param {vscode.WorkspaceConfiguration} configured
 */
async function buildLaunchAzureEnv(configured) {
  const env = {};
  const ctx = extensionContext;
  if (!ctx) {
    return env;
  }

  const azureEnabled = configured.get('azure.enabled', false);
  const endpoint = normalizeAzureEndpoint(configured.get('azure.endpoint', ''));
  const apiVersion = (configured.get('azure.apiVersion', '2024-12-01-preview') || '').trim();
  const deployment = (configured.get('azure.deployment', '') || '').trim();
  const forceStyle = configured.get('azure.forceAzureUrlStyle', true);

  if (!azureEnabled) {
    return env;
  }

  const apiKey = await resolveAzureApiKey(ctx, configured);
  if (!endpoint || !deployment) {
    void vscode.window.showWarningMessage(
      'OpenClaude Azure chat is enabled but endpoint or deployment is missing. Run "OpenClaude: Configure Azure / Foundry Chat" or set openclaude.azure.* in settings.',
    );
    return env;
  }
  if (!apiKey) {
    void vscode.window.showWarningMessage(
      'OpenClaude Azure chat is enabled but no API key is set. Use "OpenClaude: Set Azure / Foundry API Key" or openclaude.azure.apiKey (not recommended).',
    );
    return env;
  }

  env.CLAUDE_CODE_USE_OPENAI = '1';
  env.OPENAI_BASE_URL = endpoint;
  env.OPENAI_API_KEY = apiKey;
  env.OPENAI_MODEL = deployment;
  env.AZURE_OPENAI_API_VERSION = apiVersion || '2024-12-01-preview';
  if (forceStyle) {
    env.OPENAI_AZURE_STYLE = '1';
  }
  return env;
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function setAzureApiKey(context) {
  const key = await vscode.window.showInputBox({
    title: 'OpenClaude — Azure / Foundry API key',
    prompt: 'Stored in VS Code Secret Storage (not committed to the repo).',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v && v.trim() ? null : 'Enter a non-empty key'),
  });
  if (key == null) {
    return;
  }
  await context.secrets.store(SECRET_AZURE_API_KEY, key.trim());
  void vscode.window.showInformationMessage('OpenClaude Azure / Foundry API key saved to Secret Storage.');
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function clearAzureApiKey(context) {
  await context.secrets.delete(SECRET_AZURE_API_KEY);
  void vscode.window.showInformationMessage('OpenClaude Azure / Foundry API key removed from Secret Storage.');
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function configureAzureChat(context) {
  const cfg = vscode.workspace.getConfiguration('openclaude');
  const target = vscode.ConfigurationTarget.Global;

  const endpoint = await vscode.window.showInputBox({
    title: 'OpenClaude — Azure / Foundry API endpoint',
    prompt: 'Resource base URL only (no api-version query). Example: https://YOUR_RESOURCE.openai.azure.com',
    ignoreFocusOut: true,
    value: cfg.get('azure.endpoint', ''),
    validateInput: v => (v && v.trim() ? null : 'Required'),
  });
  if (endpoint == null) {
    return;
  }

  const apiVersion = await vscode.window.showInputBox({
    title: 'OpenClaude — Azure API version',
    prompt: 'Matches the api-version used by your deployment (e.g. 2024-12-01-preview).',
    value: (cfg.get('azure.apiVersion', '2024-12-01-preview') || '').trim(),
    ignoreFocusOut: true,
    validateInput: v => (v && v.trim() ? null : 'Required'),
  });
  if (apiVersion == null) {
    return;
  }

  const deployment = await vscode.window.showInputBox({
    title: 'OpenClaude — Azure deployment / model',
    prompt: 'Deployment name in Azure (this becomes OPENAI_MODEL for the OpenAI shim).',
    value: cfg.get('azure.deployment', ''),
    ignoreFocusOut: true,
    validateInput: v => (v && v.trim() ? null : 'Required'),
  });
  if (deployment == null) {
    return;
  }

  const key = await vscode.window.showInputBox({
    title: 'OpenClaude — Azure / Foundry API key',
    prompt: 'Stored in VS Code Secret Storage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v && v.trim() ? null : 'Required'),
  });
  if (key == null) {
    return;
  }

  await cfg.update('azure.endpoint', normalizeAzureEndpoint(endpoint), target);
  await cfg.update('azure.apiVersion', apiVersion.trim(), target);
  await cfg.update('azure.deployment', deployment.trim(), target);
  await cfg.update('azure.forceAzureUrlStyle', true, target);
  await cfg.update('azure.enabled', true, target);
  await context.secrets.store(SECRET_AZURE_API_KEY, key.trim());

  void vscode.window.showInformationMessage(
    'OpenClaude Azure / Foundry chat saved. Launch OpenClaude from the Control Center or command palette.',
  );
}

function getWorkspacePaths() {
  return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
}

function getActiveWorkspacePath() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return null;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  return workspaceFolder ? workspaceFolder.uri.fsPath : null;
}

function getActiveFilePath() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return null;
  }

  return editor.document.uri.fsPath || null;
}

function resolveLaunchTargets({ activeFilePath, workspacePath, workspaceSourceLabel, executable } = {}) {
  const activeFileDirectory = isPathInsideWorkspace(activeFilePath, workspacePath)
    ? path.dirname(activeFilePath)
    : null;
  const normalizedExecutable = String(executable || '').trim();
  const commandPath = normalizedExecutable
    ? resolveCommandCheckPath(normalizedExecutable, workspacePath)
    : null;
  const relativeCommandRequiresWorkspaceRoot = Boolean(
    workspacePath && commandPath && !path.isAbsolute(normalizedExecutable),
  );

  if (relativeCommandRequiresWorkspaceRoot) {
    return {
      projectAwareCwd: workspacePath,
      projectAwareCwdLabel: workspacePath,
      projectAwareSourceLabel: 'workspace root (required by relative launch command)',
      workspaceRootCwd: workspacePath,
      workspaceRootCwdLabel: workspacePath,
      launchActionsShareTarget: true,
      launchActionsShareTargetReason: 'relative-launch-command',
    };
  }

  if (activeFileDirectory) {
    return {
      projectAwareCwd: activeFileDirectory,
      projectAwareCwdLabel: activeFileDirectory,
      projectAwareSourceLabel: 'active file directory',
      workspaceRootCwd: workspacePath || null,
      workspaceRootCwdLabel: workspacePath || 'No workspace open',
      launchActionsShareTarget: false,
      launchActionsShareTargetReason: null,
    };
  }

  if (workspacePath) {
    return {
      projectAwareCwd: workspacePath,
      projectAwareCwdLabel: workspacePath,
      projectAwareSourceLabel: workspaceSourceLabel || 'workspace root',
      workspaceRootCwd: workspacePath,
      workspaceRootCwdLabel: workspacePath,
      launchActionsShareTarget: true,
      launchActionsShareTargetReason: null,
    };
  }

  return {
    projectAwareCwd: null,
    projectAwareCwdLabel: 'VS Code default terminal cwd',
    projectAwareSourceLabel: 'VS Code default terminal cwd',
    workspaceRootCwd: null,
    workspaceRootCwdLabel: 'No workspace open',
    launchActionsShareTarget: false,
    launchActionsShareTargetReason: null,
  };
}

function resolveLaunchWorkspace() {
  return chooseLaunchWorkspace({
    activeWorkspacePath: getActiveWorkspacePath(),
    workspacePaths: getWorkspacePaths(),
  });
}

function getWorkspaceSourceLabel(source) {
  switch (source) {
    case 'active-workspace':
      return 'active editor workspace';
    case 'first-workspace':
      return 'first workspace folder';
    default:
      return 'no workspace open';
  }
}

function getProviderSourceLabel(source) {
  switch (source) {
    case 'profile':
      return 'saved profile';
    case 'env':
      return 'environment';
    case 'shim':
      return 'launch setting';
    default:
      return 'unknown';
  }
}

function readWorkspaceProfile(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) {
    return {
      profile: null,
      statusLabel: 'Missing',
      statusHint: `${PROFILE_FILE_NAME} not found in the workspace root`,
      filePath: null,
    };
  }

  try {
    const raw = fs.readFileSync(profilePath, 'utf8');
    const profile = parseProfileFile(raw);
    if (!profile) {
      return {
        profile: null,
        statusLabel: 'Invalid',
        statusHint: `${profilePath} has invalid JSON or an unsupported profile`,
        filePath: profilePath,
      };
    }

    return {
      profile,
      statusLabel: 'Found',
      statusHint: profilePath,
      filePath: profilePath,
    };
  } catch (error) {
    return {
      profile: null,
      statusLabel: 'Unreadable',
      statusHint: `${profilePath} (${error instanceof Error ? error.message : 'read failed'})`,
      filePath: profilePath,
    };
  }
}

async function collectControlCenterState() {
  const configured = vscode.workspace.getConfiguration('openclaude');
  const launchCommand = configured.get('launchCommand', 'openclaude');
  const terminalName = configured.get('terminalName', 'OpenClaude');
  const shimEnabled = configured.get('useOpenAIShim', false);
  const executable = getExecutableFromCommand(launchCommand);
  const launchWorkspace = resolveLaunchWorkspace();
  const workspaceFolder = launchWorkspace.workspacePath;
  const workspaceSourceLabel = getWorkspaceSourceLabel(launchWorkspace.source);
  const launchTargets = resolveLaunchTargets({
    activeFilePath: getActiveFilePath(),
    workspacePath: workspaceFolder,
    workspaceSourceLabel,
    executable,
  });
  const installed = await isCommandAvailable(executable, launchTargets.projectAwareCwd);
  const profilePath = workspaceFolder
    ? path.join(workspaceFolder, PROFILE_FILE_NAME)
    : null;

  const profileState = workspaceFolder
    ? readWorkspaceProfile(profilePath)
    : {
        profile: null,
        statusLabel: 'No workspace',
        statusHint: 'Open a workspace folder to detect a saved profile',
        filePath: null,
      };

  const providerState = describeProviderState({
    shimEnabled,
    env: process.env,
    profile: profileState.profile,
  });

  return {
    installed,
    executable,
    launchCommand,
    terminalName,
    shimEnabled,
    workspaceFolder,
    workspaceSourceLabel,
    launchCwd: launchTargets.projectAwareCwd,
    launchCwdLabel: launchTargets.projectAwareCwdLabel,
    launchCwdSourceLabel: launchTargets.projectAwareSourceLabel,
    workspaceRootCwd: launchTargets.workspaceRootCwd,
    workspaceRootCwdLabel: launchTargets.workspaceRootCwdLabel,
    launchActionsShareTarget: launchTargets.launchActionsShareTarget,
    launchActionsShareTargetReason: launchTargets.launchActionsShareTargetReason,
    canLaunchInWorkspaceRoot: Boolean(workspaceFolder),
    profileStatusLabel: profileState.statusLabel,
    profileStatusHint: profileState.statusHint,
    workspaceProfilePath: profileState.filePath,
    providerState,
    providerSourceLabel: getProviderSourceLabel(providerState.source),
  };
}

async function launchOpenClaude(options = {}) {
  const { requireWorkspace = false } = options;
  const configured = vscode.workspace.getConfiguration('openclaude');
  const launchCommand = configured.get('launchCommand', 'openclaude');
  const terminalName = configured.get('terminalName', 'OpenClaude');
  const shimEnabled = configured.get('useOpenAIShim', false);
  const executable = getExecutableFromCommand(launchCommand);
  const launchWorkspace = resolveLaunchWorkspace();

  if (requireWorkspace && !launchWorkspace.workspacePath) {
    await vscode.window.showWarningMessage(
      'Open a workspace folder before using Launch in Workspace Root.',
    );
    return;
  }

  const launchTargets = resolveLaunchTargets({
    activeFilePath: getActiveFilePath(),
    workspacePath: launchWorkspace.workspacePath,
    workspaceSourceLabel: getWorkspaceSourceLabel(launchWorkspace.source),
    executable,
  });
  const targetCwd = requireWorkspace
    ? launchTargets.workspaceRootCwd
    : launchTargets.projectAwareCwd;
  const installed = await isCommandAvailable(executable, targetCwd);

  if (!installed) {
    const action = await vscode.window.showErrorMessage(
      `OpenClaude command not found: ${executable}. Install it with: npm install -g @gitlawb/openclaude@latest`,
      'Open Setup Guide',
      'Open Repository',
    );

    if (action === 'Open Setup Guide') {
      await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_SETUP_URL));
    } else if (action === 'Open Repository') {
      await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_REPO_URL));
    }

    return;
  }

  const env = await buildLaunchAzureEnv(configured);
  if (shimEnabled && !env.CLAUDE_CODE_USE_OPENAI) {
    env.CLAUDE_CODE_USE_OPENAI = '1';
  }

  const terminalOptions = {
    name: terminalName,
    env,
  };

  if (targetCwd) {
    terminalOptions.cwd = targetCwd;
  }

  const terminal = vscode.window.createTerminal(terminalOptions);
  terminal.show(true);
  terminal.sendText(launchCommand, true);
}

async function openWorkspaceProfile() {
  const state = await collectControlCenterState();

  if (!state.workspaceProfilePath) {
    await vscode.window.showInformationMessage(
      `No ${PROFILE_FILE_NAME} file was found for the current workspace.`,
    );
    return;
  }

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(state.workspaceProfilePath),
  );
  await vscode.window.showTextDocument(document, { preview: false });
}

function getToneClass(tone) {
  switch (tone) {
    case 'accent':
      return 'tone-accent';
    case 'positive':
      return 'tone-positive';
    case 'warning':
      return 'tone-warning';
    case 'critical':
      return 'tone-critical';
    default:
      return 'tone-neutral';
  }
}

function renderHeaderBadge(badge) {
  return `<div class="rail-pill ${getToneClass(badge.tone)}" title="${escapeHtml(badge.label)}: ${escapeHtml(badge.value)}">
    <span class="rail-label">${escapeHtml(badge.label)}</span>
    <span class="rail-value">${escapeHtml(badge.value)}</span>
  </div>`;
}

function renderSummaryCard(card) {
  const detail = card.detail || '';
  return `<section class="summary-card" aria-label="${escapeHtml(card.label)}">
    <div class="summary-label">${escapeHtml(card.label)}</div>
    <div class="summary-value" title="${escapeHtml(card.value)}">${escapeHtml(card.value)}</div>
    ${detail ? `<div class="summary-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
  </section>`;
}

function renderDetailRow(row) {
  return `<div class="detail-row ${getToneClass(row.tone)}">
    <div class="detail-label">${escapeHtml(row.label)}</div>
    <div class="detail-summary" title="${escapeHtml(row.summary)}">${escapeHtml(row.summary)}</div>
    ${row.detail ? `<div class="detail-meta" title="${escapeHtml(row.detail)}">${escapeHtml(row.detail)}</div>` : ''}
  </div>`;
}

function renderDetailSection(section) {
  const sectionId = `section-${String(section.title || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return `<section class="detail-module" aria-labelledby="${escapeHtml(sectionId)}">
    <h2 class="module-title" id="${escapeHtml(sectionId)}">${escapeHtml(section.title)}</h2>
    <div class="detail-list">${section.rows.map(renderDetailRow).join('')}</div>
  </section>`;
}

function renderActionButton(action, variant = 'secondary') {
  return `<button class="action-button ${variant}" id="${escapeHtml(action.id)}" type="button" ${action.disabled ? 'disabled aria-disabled="true"' : ''}>
    <span class="action-label">${escapeHtml(action.label)}</span>
    <span class="action-detail">${escapeHtml(action.detail)}</span>
  </button>`;
}

function renderProfileEmptyState(detail) {
  return `<div class="action-empty" role="status" aria-live="polite">
    <div class="action-empty-title">No workspace profile yet</div>
    <div class="action-empty-detail">${escapeHtml(detail)}</div>
  </div>`;
}

function getPrimaryLaunchActionDetail(status) {
  if (status.launchActionsShareTargetReason === 'relative-launch-command' && status.launchCwd) {
    return `Project-aware launch is anchored to the workspace root by the relative command · ${status.launchCwdLabel}`;
  }

  if (status.launchCwd && status.launchCwdSourceLabel === 'active file directory') {
    return `Starts beside the active file · ${status.launchCwdLabel}`;
  }

  if (status.launchCwd) {
    return `Project-aware launch. Currently resolves to ${status.launchCwdSourceLabel} · ${status.launchCwdLabel}`;
  }

  return 'Project-aware launch. Uses the VS Code default terminal cwd';
}

function getWorkspaceRootActionDetail(status, fallbackDetail) {
  if (!status.canLaunchInWorkspaceRoot) {
    return fallbackDetail;
  }

  if (status.launchActionsShareTargetReason === 'relative-launch-command') {
    return `Same workspace-root target as Launch OpenClaude because the relative command resolves from the workspace root · ${status.workspaceRootCwdLabel}`;
  }

  return `Always starts at the workspace root · ${status.workspaceRootCwdLabel}`;
}

function getRenderableViewModel(status) {
  const viewModel = buildControlCenterViewModel(status);
  const summaryCards = viewModel.summaryCards.map(card => {
    if (card.key !== 'launchCwd' || card.detail) {
      return card;
    }

    return {
      ...card,
      detail: status.launchCwdSourceLabel || '',
    };
  });

  return {
    ...viewModel,
    summaryCards,
    actions: {
      ...viewModel.actions,
      primary: {
        ...viewModel.actions.primary,
        detail: getPrimaryLaunchActionDetail(status),
      },
      launchRoot: {
        ...viewModel.actions.launchRoot,
        detail: getWorkspaceRootActionDetail(status, viewModel.actions.launchRoot.detail),
      },
    },
  };
}

function renderControlCenterHtml(status, options = {}) {
  const nonce = options.nonce || crypto.randomBytes(16).toString('base64');
  const platform = options.platform || process.platform;
  const viewModel = getRenderableViewModel(status);
  const profileActionOrEmpty = viewModel.actions.openProfile
    ? renderActionButton(viewModel.actions.openProfile)
    : renderProfileEmptyState(status.profileStatusHint || 'Open a workspace folder to detect a saved profile');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --oc-bg: #050505;
      --oc-panel: #110d0c;
      --oc-panel-strong: #17110f;
      --oc-panel-soft: #1d1512;
      --oc-border: #645041;
      --oc-border-soft: rgba(220, 195, 170, 0.14);
      --oc-text: #f7efe5;
      --oc-text-dim: #dcc3aa;
      --oc-text-soft: #aa9078;
      --oc-accent: #d77757;
      --oc-accent-bright: #f09464;
      --oc-accent-soft: rgba(240, 148, 100, 0.18);
      --oc-positive: #e8b86b;
      --oc-warning: #f3c969;
      --oc-critical: #ff8a6c;
      --oc-focus: #ffd3a1;
    }
    * {
      box-sizing: border-box;
    }
    h1, h2, p {
      margin: 0;
    }
    html, body {
      margin: 0;
      min-height: 100%;
    }
    body {
      padding: 16px;
      font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
      color: var(--oc-text);
      background:
        radial-gradient(circle at top right, rgba(240, 148, 100, 0.16), transparent 34%),
        radial-gradient(circle at 20% 0%, rgba(215, 119, 87, 0.14), transparent 28%),
        linear-gradient(180deg, #090706, #050505 58%, #090706);
      line-height: 1.45;
    }
    button {
      font: inherit;
    }
    .shell {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--oc-border-soft);
      border-radius: 20px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 16%),
        linear-gradient(180deg, rgba(17, 13, 12, 0.98), rgba(9, 7, 6, 0.98));
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .shell::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 2px;
      background: linear-gradient(90deg, #ffb464, #f09464, #d77757, #814334);
      opacity: 0.95;
    }
    .sunset-gradient {
      background: linear-gradient(90deg, #ffb464, #f09464, #d77757, #814334);
    }
    .frame {
      display: grid;
      gap: 18px;
      padding: 18px;
    }
    .hero {
      display: grid;
      gap: 14px;
      padding: 18px;
      border-radius: 16px;
      background:
        linear-gradient(135deg, rgba(240, 148, 100, 0.06), rgba(215, 119, 87, 0.02) 55%, transparent),
        var(--oc-panel);
      border: 1px solid var(--oc-border-soft);
    }
    .hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .brand {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--oc-text-soft);
    }
    .wordmark {
      font-size: 24px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--oc-text);
    }
    .wordmark-accent {
      color: var(--oc-accent-bright);
    }
    .headline {
      display: grid;
      gap: 4px;
      max-width: 44ch;
    }
    .headline-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--oc-text);
    }
    .headline-subtitle {
      font-size: 12px;
      color: var(--oc-text-dim);
    }
    .status-rail {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
      flex: 1 1 250px;
    }
    .rail-pill {
      display: grid;
      gap: 2px;
      min-width: 94px;
      padding: 8px 10px;
      border-radius: 999px;
      border: 1px solid var(--oc-border-soft);
      background: rgba(255, 255, 255, 0.02);
    }
    .rail-label {
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--oc-text-soft);
    }
    .rail-value {
      font-size: 12px;
      font-weight: 700;
      color: var(--oc-text);
    }
    .refresh-button {
      border: 1px solid rgba(240, 148, 100, 0.28);
      border-radius: 999px;
      padding: 8px 12px;
      background: rgba(240, 148, 100, 0.08);
      color: var(--oc-text-dim);
      cursor: pointer;
      white-space: nowrap;
    }
    .summary-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }
    .summary-card {
      display: grid;
      gap: 6px;
      min-width: 0;
      padding: 14px;
      border-radius: 14px;
      background: var(--oc-panel-strong);
      border: 1px solid var(--oc-border-soft);
    }
    .summary-label,
    .detail-label,
    .module-title,
    .action-section-title,
    .support-title {
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--oc-text-soft);
    }
    .summary-value,
    .detail-summary {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
      color: var(--oc-text);
    }
    .summary-detail,
    .detail-meta,
    .action-detail,
    .action-empty-detail,
    .support-copy,
    .footer-note {
      font-size: 12px;
      color: var(--oc-text-dim);
    }
    .modules {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .detail-module,
    .support-card {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-radius: 16px;
      background: var(--oc-panel);
      border: 1px solid var(--oc-border-soft);
    }
    .detail-list,
    .action-stack,
    .support-stack {
      display: grid;
      gap: 10px;
    }
    .detail-row {
      display: grid;
      gap: 4px;
      min-width: 0;
      padding: 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(220, 195, 170, 0.08);
    }
    .actions-layout {
      display: grid;
      gap: 14px;
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
      align-items: start;
    }
    .action-panel {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-radius: 16px;
      background: var(--oc-panel);
      border: 1px solid var(--oc-border-soft);
    }
    .action-button {
      width: 100%;
      display: grid;
      gap: 4px;
      padding: 14px;
      text-align: left;
      border-radius: 14px;
      border: 1px solid rgba(220, 195, 170, 0.14);
      background: rgba(255, 255, 255, 0.02);
      color: var(--oc-text);
      cursor: pointer;
      transition: border-color 140ms ease, transform 140ms ease, background 140ms ease, box-shadow 140ms ease;
    }
    .action-button.primary {
      border-color: rgba(240, 148, 100, 0.44);
      background:
        linear-gradient(135deg, rgba(255, 180, 100, 0.22), rgba(215, 119, 87, 0.12) 58%, rgba(129, 67, 52, 0.12)),
        #241713;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .action-button.secondary:hover:enabled,
    .action-button.primary:hover:enabled,
    .refresh-button:hover {
      border-color: rgba(240, 148, 100, 0.48);
      transform: translateY(-1px);
      background-color: rgba(240, 148, 100, 0.1);
    }
    .action-button:disabled {
      cursor: not-allowed;
      opacity: 0.58;
      transform: none;
    }
    .action-label,
    .action-empty-title,
    .support-link-label {
      font-size: 13px;
      font-weight: 700;
      color: var(--oc-text);
    }
    .action-empty {
      display: grid;
      gap: 4px;
      padding: 14px;
      border-radius: 14px;
      border: 1px dashed rgba(220, 195, 170, 0.16);
      background: rgba(255, 255, 255, 0.015);
    }
    .support-link {
      width: 100%;
      display: grid;
      gap: 4px;
      padding: 12px 0;
      border: 0;
      border-top: 1px solid rgba(220, 195, 170, 0.08);
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }
    .support-link:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
    .tone-positive .rail-value,
    .tone-positive .detail-summary {
      color: var(--oc-positive);
    }
    .tone-warning .rail-value,
    .tone-warning .detail-summary {
      color: var(--oc-warning);
    }
    .tone-critical .rail-value,
    .tone-critical .detail-summary {
      color: var(--oc-critical);
    }
    .tone-accent .rail-value,
    .tone-accent .detail-summary {
      color: var(--oc-accent-bright);
    }
    .action-button:focus-visible,
    .support-link:focus-visible,
    .refresh-button:focus-visible {
      outline: 2px solid var(--oc-focus);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px rgba(255, 211, 161, 0.16);
    }
    code {
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid rgba(240, 148, 100, 0.18);
      background: rgba(240, 148, 100, 0.08);
      color: var(--oc-accent-bright);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 11px;
    }
    .footer-note {
      padding-top: 2px;
    }
    @media (max-width: 720px) {
      body {
        padding: 12px;
      }
      .frame,
      .hero {
        padding: 14px;
      }
      .actions-layout {
        grid-template-columns: 1fr;
      }
      .status-rail {
        justify-content: flex-start;
      }
      .rail-pill {
        min-width: 0;
      }
    }
  </style>
</head>
<body>
  <main class="shell" aria-labelledby="control-center-title">
    <div class="frame">
      <header class="hero">
        <div class="hero-top">
          <div class="brand">
            <div class="eyebrow">${escapeHtml(viewModel.header.eyebrow)}</div>
            <div class="wordmark" aria-label="OpenClaude wordmark">Open<span class="wordmark-accent">Claude</span></div>
            <div class="headline">
              <h1 class="headline-title" id="control-center-title">${escapeHtml(viewModel.header.title)}</h1>
              <p class="headline-subtitle">${escapeHtml(viewModel.header.subtitle)}</p>
            </div>
          </div>
          <div class="status-rail" role="group" aria-label="Runtime, provider, and profile status">
            ${viewModel.headerBadges.map(renderHeaderBadge).join('')}
            <button class="refresh-button" id="refresh" type="button">Refresh</button>
          </div>
        </div>
        <section class="summary-grid" aria-label="Current launch summary">
          ${viewModel.summaryCards.map(renderSummaryCard).join('')}
        </section>
      </header>

      <section class="modules" aria-label="Control center details">
        ${viewModel.detailSections.map(renderDetailSection).join('')}
      </section>

      <section class="actions-layout" aria-label="Control center actions">
        <section class="action-panel" aria-labelledby="actions-title">
          <h2 class="action-section-title" id="actions-title">Launch & Project</h2>
          ${renderActionButton(viewModel.actions.primary, 'primary')}
          <div class="action-stack">
            ${renderActionButton(viewModel.actions.launchRoot)}
            ${profileActionOrEmpty}
          </div>
        </section>

        <section class="support-card" aria-labelledby="quick-links-title">
          <h2 class="support-title" id="quick-links-title">Quick Links</h2>
          <div class="support-copy">Settings and workspace status stay in view here. Reference links stay secondary.</div>
          <div class="support-stack">
            <button class="support-link" id="setup" type="button">
              <span class="support-link-label">Open Setup Guide</span>
              <span class="summary-detail">Jump to install and provider setup docs.</span>
            </button>
            <button class="support-link" id="repo" type="button">
              <span class="support-link-label">Open Repository</span>
              <span class="summary-detail">Browse the upstream OpenClaude project.</span>
            </button>
            <button class="support-link" id="commands" type="button">
              <span class="support-link-label">Open Command Palette</span>
              <span class="summary-detail">Access VS Code and OpenClaude commands quickly.</span>
            </button>
            <button class="support-link" id="azureFoundry" type="button">
              <span class="support-link-label">Azure / Foundry settings</span>
              <span class="summary-detail">Configure endpoint, API version, deployment, and API key for chat.</span>
            </button>
          </div>
        </section>
      </section>

      <p class="footer-note">
        Quick trigger: use <code>${escapeHtml(platform === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P')}</code> for the command palette, then refresh this panel after workspace or profile changes.
      </p>
    </div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('launch').addEventListener('click', () => vscode.postMessage({ type: 'launch' }));
    document.getElementById('launchRoot').addEventListener('click', () => vscode.postMessage({ type: 'launchRoot' }));
    document.getElementById('repo').addEventListener('click', () => vscode.postMessage({ type: 'repo' }));
    document.getElementById('setup').addEventListener('click', () => vscode.postMessage({ type: 'setup' }));
    document.getElementById('commands').addEventListener('click', () => vscode.postMessage({ type: 'commands' }));
    document.getElementById('azureFoundry').addEventListener('click', () => vscode.postMessage({ type: 'azureSettings' }));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    const profileButton = document.getElementById('openProfile');
    if (profileButton) {
      profileButton.addEventListener('click', () => vscode.postMessage({ type: 'openProfile' }));
    }
  </script>
</body>
</html>`;
}

class OpenClaudeControlCenterProvider {
  constructor() {
    this.webviewView = null;
  }

  async resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) {
        this.webviewView = null;
      }
    });

    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case 'launch':
          await launchOpenClaude();
          break;
        case 'launchRoot':
          await launchOpenClaude({ requireWorkspace: true });
          break;
        case 'openProfile':
          await openWorkspaceProfile();
          break;
        case 'repo':
          await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_REPO_URL));
          break;
        case 'setup':
          await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_SETUP_URL));
          break;
        case 'commands':
          await vscode.commands.executeCommand('workbench.action.showCommands');
          break;
        case 'azureSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'openclaude.azure');
          break;
        case 'refresh':
        default:
          break;
      }

      await this.refresh();
    });

    await this.refresh();
  }

  async refresh() {
    if (!this.webviewView) {
      return;
    }

    try {
      const status = await collectControlCenterState();
      this.webviewView.webview.html = this.getHtml(status);
    } catch (error) {
      this.webviewView.webview.html = this.getErrorHtml(error);
    }
  }

  getErrorHtml(error) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const message =
      error instanceof Error ? error.message : 'Unknown Control Center error';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .panel {
      border: 1px solid var(--vscode-errorForeground);
      border-radius: 8px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, black);
    }
    .title {
      color: var(--vscode-errorForeground);
      font-weight: 700;
      margin-bottom: 8px;
    }
    .message {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
      line-height: 1.5;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 8px 10px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="title">Control Center Error</div>
    <div class="message">${escapeHtml(message)}</div>
    <button id="refresh">Refresh</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
  </script>
</body>
</html>`;
  }

  getHtml(status) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return renderControlCenterHtml(status, { nonce, platform: process.platform });
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  extensionContext = context;

  // ── Control Center (existing) ──
  const provider = new OpenClaudeControlCenterProvider();
  const refreshProvider = () => {
    void provider.refresh();
  };

  // ── Chat system ──
  const sessionManager = new SessionManager();
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    sessionManager.setCwd(folders[0].uri.fsPath);
  }

  const chatController = new ChatController(sessionManager);
  const chatViewProvider = new OpenClaudeChatViewProvider(chatController);
  const chatPanelManager = new OpenClaudeChatPanelManager(chatController);

  // ── Diff content provider ──
  const diffProvider = new DiffContentProvider();
  const diffProviderReg = vscode.workspace.registerTextDocumentContentProvider(
    DIFF_SCHEME,
    diffProvider,
  );

  // ── Status bar ──
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = '$(comment-discussion) OpenClaude';
  statusBarItem.tooltip = 'Open OpenClaude Chat';
  statusBarItem.command = 'openclaude.openChat';
  statusBarItem.show();

  chatController.onDidChangeState((state) => {
    switch (state) {
      case 'streaming':
        statusBarItem.text = '$(sync~spin) OpenClaude';
        statusBarItem.tooltip = 'OpenClaude is generating...';
        break;
      case 'connected':
        statusBarItem.text = '$(comment-discussion) OpenClaude';
        statusBarItem.tooltip = 'OpenClaude connected';
        break;
      default:
        statusBarItem.text = '$(comment-discussion) OpenClaude';
        statusBarItem.tooltip = 'Open OpenClaude Chat';
        break;
    }
  });

  // ── Existing commands ──
  const startCommand = vscode.commands.registerCommand('openclaude.start', async () => {
    await launchOpenClaude();
  });

  const startInWorkspaceRootCommand = vscode.commands.registerCommand(
    'openclaude.startInWorkspaceRoot',
    async () => {
      await launchOpenClaude({ requireWorkspace: true });
    },
  );

  const openDocsCommand = vscode.commands.registerCommand('openclaude.openDocs', async () => {
    await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_REPO_URL));
  });

  const openSetupDocsCommand = vscode.commands.registerCommand(
    'openclaude.openSetupDocs',
    async () => {
      await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_SETUP_URL));
    },
  );

  const openWorkspaceProfileCommand = vscode.commands.registerCommand(
    'openclaude.openWorkspaceProfile',
    async () => {
      await openWorkspaceProfile();
    },
  );

  const openUiCommand = vscode.commands.registerCommand('openclaude.openControlCenter', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.openclaude');
  });

  // ── New chat commands ──
  const newChatCommand = vscode.commands.registerCommand('openclaude.newChat', () => {
    chatController.stopSession();
    chatController.broadcast({ type: 'session_cleared' });
  });

  const openChatCommand = vscode.commands.registerCommand('openclaude.openChat', () => {
    chatPanelManager.openPanel();
  });

  const resumeSessionCommand = vscode.commands.registerCommand('openclaude.resumeSession', async () => {
    const sessions = await sessionManager.listSessions();
    if (sessions.length === 0) {
      await vscode.window.showInformationMessage('No sessions found to resume.');
      return;
    }
    const items = sessions.slice(0, 30).map(s => ({
      label: s.title || s.id,
      description: s.timeLabel,
      detail: s.preview,
      sessionId: s.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a session to resume',
    });
    if (picked) {
      chatController.stopSession();
      chatController.broadcast({ type: 'session_cleared' });
      await chatController.startSession({ sessionId: picked.sessionId });
    }
  });

  const abortChatCommand = vscode.commands.registerCommand('openclaude.abortChat', () => {
    chatController.abort();
  });

  const setAzureApiKeyCommand = vscode.commands.registerCommand('openclaude.setAzureApiKey', async () => {
    await setAzureApiKey(context);
  });

  const clearAzureApiKeyCommand = vscode.commands.registerCommand('openclaude.clearAzureApiKey', async () => {
    await clearAzureApiKey(context);
  });

  const configureAzureChatCommand = vscode.commands.registerCommand('openclaude.configureAzureChat', async () => {
    await configureAzureChat(context);
  });

  const openAzureSettingsCommand = vscode.commands.registerCommand('openclaude.openAzureSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'openclaude.azure');
  });

  // ── Register providers ──
  const controlCenterProviderReg = vscode.window.registerWebviewViewProvider(
    'openclaude.controlCenter',
    provider,
  );

  const chatViewProviderReg = vscode.window.registerWebviewViewProvider(
    'openclaude.chat',
    chatViewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const profileWatcher = vscode.workspace.createFileSystemWatcher(`**/${PROFILE_FILE_NAME}`);

  context.subscriptions.push(
    // existing
    startCommand,
    startInWorkspaceRootCommand,
    openDocsCommand,
    openSetupDocsCommand,
    openWorkspaceProfileCommand,
    openUiCommand,
    controlCenterProviderReg,
    // new chat
    newChatCommand,
    openChatCommand,
    resumeSessionCommand,
    abortChatCommand,
    setAzureApiKeyCommand,
    clearAzureApiKeyCommand,
    configureAzureChatCommand,
    openAzureSettingsCommand,
    chatViewProviderReg,
    diffProviderReg,
    statusBarItem,
    // watchers
    profileWatcher,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('openclaude')) {
        refreshProvider();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      refreshProvider();
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        sessionManager.setCwd(folders[0].uri.fsPath);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(refreshProvider),
    profileWatcher.onDidCreate(refreshProvider),
    profileWatcher.onDidChange(refreshProvider),
    profileWatcher.onDidDelete(refreshProvider),
    // disposables
    { dispose: () => chatController.dispose() },
    { dispose: () => chatPanelManager.dispose() },
    { dispose: () => diffProvider.dispose() },
  );
}

function deactivate() {
  extensionContext = null;
}

module.exports = {
  activate,
  deactivate,
  OpenClaudeControlCenterProvider,
  renderControlCenterHtml,
  resolveLaunchTargets,
  ChatController,
  OpenClaudeChatViewProvider,
  OpenClaudeChatPanelManager,
};
