/**
 * chatRenderer — produces the full self-contained HTML document for the chat
 * webview.  All CSS and JS are inlined (no external bundles).
 *
 * The webview JS communicates with the extension host via postMessage.
 * Incoming messages update the DOM incrementally so streaming feels fluid.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderChatHtml({ nonce, platform }) {
  const modKey = platform === 'darwin' ? 'Cmd' : 'Ctrl';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --oc-bg: #0a0908;
      --oc-panel: #110d0c;
      --oc-panel-strong: #17110f;
      --oc-panel-soft: #1d1512;
      --oc-border: #645041;
      --oc-border-soft: rgba(220,195,170,0.14);
      --oc-text: #f7efe5;
      --oc-text-dim: #dcc3aa;
      --oc-text-soft: #aa9078;
      --oc-accent: #d77757;
      --oc-accent-bright: #f09464;
      --oc-accent-soft: rgba(240,148,100,0.18);
      --oc-positive: #e8b86b;
      --oc-warning: #f3c969;
      --oc-critical: #ff8a6c;
      --oc-focus: #ffd3a1;
      --oc-user-bg: rgba(240,148,100,0.12);
      --oc-user-border: rgba(240,148,100,0.28);
      --oc-assistant-bg: rgba(255,255,255,0.03);
      --oc-assistant-border: rgba(220,195,170,0.10);
      --oc-code-bg: #1a1310;
      --oc-code-border: rgba(220,195,170,0.12);
      --oc-tool-bg: rgba(232,184,107,0.06);
      --oc-tool-border: rgba(232,184,107,0.22);
      --oc-perm-bg: rgba(255,138,108,0.08);
      --oc-perm-border: rgba(255,138,108,0.35);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
      font-size: 13px;
      color: var(--oc-text);
      background: var(--oc-bg);
      display: flex;
      flex-direction: column;
      position: relative;
    }

    /* ── Header ── */
    .chat-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--oc-border-soft);
      background: var(--oc-panel);
      flex-shrink: 0;
    }
    .chat-header .brand {
      font-weight: 700;
      font-size: 14px;
      color: var(--oc-text);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-header .brand-accent { color: var(--oc-accent-bright); }
    .header-btn {
      border: 1px solid var(--oc-border-soft);
      border-radius: 6px;
      background: rgba(255,255,255,0.04);
      color: var(--oc-text-dim);
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .header-btn:hover { border-color: var(--oc-accent); color: var(--oc-text); }
    .header-btn.danger { border-color: var(--oc-critical); color: var(--oc-critical); }
    .header-btn.danger:hover { background: rgba(255,138,108,0.12); }
    #abortBtn { display: none; }

    /* ── Status bar ── */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      font-size: 11px;
      color: var(--oc-text-soft);
      border-bottom: 1px solid var(--oc-border-soft);
      background: var(--oc-panel);
      flex-shrink: 0;
    }
    .status-bar .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--oc-text-soft);
      flex-shrink: 0;
    }
    .status-bar .status-dot.connected { background: var(--oc-positive); }
    .status-bar .status-dot.streaming { background: var(--oc-accent-bright); animation: pulse 1s infinite; }
    .status-bar .status-dot.error { background: var(--oc-critical); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .status-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-usage { color: var(--oc-text-soft); }

    /* ── Message list ── */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .messages::-webkit-scrollbar { width: 6px; }
    .messages::-webkit-scrollbar-track { background: transparent; }
    .messages::-webkit-scrollbar-thumb { background: rgba(220,195,170,0.18); border-radius: 3px; }

    /* ── Welcome screen ── */
    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      text-align: center;
      padding: 32px 16px;
      gap: 16px;
    }
    .welcome-title { font-size: 20px; font-weight: 700; color: var(--oc-text); }
    .welcome-title .accent { color: var(--oc-accent-bright); }
    .welcome-sub { font-size: 13px; color: var(--oc-text-dim); max-width: 36ch; }
    .welcome-hint { font-size: 11px; color: var(--oc-text-soft); }
    .welcome-hint kbd {
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--oc-border-soft);
      background: rgba(255,255,255,0.04);
      font-family: inherit;
      font-size: 11px;
    }

    /* ── User message ── */
    .msg-user {
      align-self: flex-end;
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 14px 14px 4px 14px;
      background: var(--oc-user-bg);
      border: 1px solid var(--oc-user-border);
      word-break: break-word;
      white-space: pre-wrap;
    }

    /* ── Assistant message ── */
    .msg-assistant {
      align-self: flex-start;
      max-width: 95%;
      padding: 10px 14px;
      border-radius: 4px 14px 14px 14px;
      background: var(--oc-assistant-bg);
      border: 1px solid var(--oc-assistant-border);
      word-break: break-word;
    }
    .msg-assistant .md-content { line-height: 1.55; }
    .msg-assistant .md-content:empty { display: none; }
    .msg-assistant .md-content p { margin-bottom: 8px; }
    .msg-assistant .md-content p:last-child { margin-bottom: 0; }
    .msg-assistant .md-content ul,
    .msg-assistant .md-content ol { padding-left: 20px; margin-bottom: 8px; }
    .msg-assistant .md-content li { margin-bottom: 4px; }
    .msg-assistant .md-content h1,
    .msg-assistant .md-content h2,
    .msg-assistant .md-content h3 {
      color: var(--oc-text);
      margin: 12px 0 6px;
      font-size: 14px;
      font-weight: 700;
    }
    .msg-assistant .md-content h1 { font-size: 16px; }
    .msg-assistant .md-content a { color: var(--oc-accent-bright); text-decoration: underline; }
    .msg-assistant .md-content strong { color: var(--oc-text); font-weight: 700; }
    .msg-assistant .md-content em { font-style: italic; color: var(--oc-text-dim); }
    .msg-assistant .md-content blockquote {
      border-left: 3px solid var(--oc-accent);
      padding: 4px 12px;
      margin: 8px 0;
      color: var(--oc-text-dim);
    }
    .msg-assistant .md-content hr {
      border: none;
      border-top: 1px solid var(--oc-border-soft);
      margin: 12px 0;
    }

    /* inline code */
    .md-content code:not(.code-block code) {
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--oc-code-bg);
      border: 1px solid var(--oc-code-border);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
      color: var(--oc-accent-bright);
    }

    /* fenced code */
    .code-wrapper {
      position: relative;
      margin: 8px 0;
      border-radius: 8px;
      border: 1px solid var(--oc-code-border);
      background: var(--oc-code-bg);
      overflow: hidden;
    }
    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      font-size: 11px;
      color: var(--oc-text-soft);
      border-bottom: 1px solid var(--oc-code-border);
      background: rgba(255,255,255,0.02);
    }
    .code-copy-btn {
      border: none;
      background: transparent;
      color: var(--oc-text-soft);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .code-copy-btn:hover { background: rgba(255,255,255,0.08); color: var(--oc-text); }
    .code-block {
      display: block;
      padding: 10px 12px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
      color: var(--oc-text-dim);
    }
    .code-block::-webkit-scrollbar { height: 4px; }
    .code-block::-webkit-scrollbar-thumb { background: rgba(220,195,170,0.2); border-radius: 2px; }

    /* keyword highlighting */
    .hl-keyword { color: #c586c0; }
    .hl-string { color: #ce9178; }
    .hl-comment { color: #6a9955; font-style: italic; }
    .hl-number { color: #b5cea8; }
    .hl-func { color: #dcdcaa; }
    .hl-type { color: #4ec9b0; }

    /* ── Tool use card ── */
    .tool-card {
      margin: 8px 0;
      border-radius: 8px;
      border: 1px solid var(--oc-tool-border);
      background: var(--oc-tool-bg);
      overflow: hidden;
    }
    .tool-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
    }
    .tool-icon { font-size: 14px; flex-shrink: 0; }
    .tool-name { font-weight: 600; font-size: 12px; color: var(--oc-text); flex: 1; }
    .tool-status { font-size: 11px; color: var(--oc-text-soft); }
    .tool-status.running { color: var(--oc-accent-bright); }
    .tool-status.error { color: var(--oc-critical); }
    .tool-status.complete { color: var(--oc-positive); }
    .tool-chevron {
      font-size: 10px;
      color: var(--oc-text-soft);
      transition: transform 150ms;
    }
    .tool-card.expanded .tool-chevron { transform: rotate(90deg); }
    .tool-body {
      display: none;
      padding: 0 10px 10px;
      font-size: 12px;
      border-top: 1px solid var(--oc-tool-border);
    }
    .tool-card.expanded .tool-body { display: block; }
    .tool-input-label,
    .tool-output-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--oc-text-soft);
      margin: 8px 0 4px;
    }
    .tool-input-content,
    .tool-output-content {
      padding: 6px 8px;
      border-radius: 6px;
      background: rgba(0,0,0,0.2);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 11px;
      color: var(--oc-text-dim);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
    }
    .tool-output-content.error { color: var(--oc-critical); }
    .tool-path {
      font-weight: 400;
      color: var(--oc-text-soft);
      font-size: 11px;
      margin-left: 4px;
    }
    .file-link {
      color: var(--oc-accent-bright);
      cursor: pointer;
      text-decoration: none;
      border-bottom: 1px dotted var(--oc-accent);
      transition: color 120ms, border-color 120ms;
    }
    .file-link:hover {
      color: var(--oc-focus);
      border-bottom-color: var(--oc-focus);
    }
    .tool-input-content.tool-diff-old {
      border-left: 3px solid var(--oc-critical);
      padding-left: 10px;
      color: #ff9e8a;
      text-decoration: line-through;
      opacity: 0.7;
    }
    .tool-input-content.tool-diff-new {
      border-left: 3px solid var(--oc-positive);
      padding-left: 10px;
      color: #c8e6a0;
    }
    .tool-diff-btn {
      margin-top: 6px;
      border: 1px solid var(--oc-accent);
      border-radius: 6px;
      background: rgba(240,148,100,0.08);
      color: var(--oc-accent-bright);
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
    }
    .tool-diff-btn:hover { background: rgba(240,148,100,0.16); }

    /* ── Permission card ── */
    .perm-card {
      margin: 8px 0;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--oc-perm-border);
      background: var(--oc-perm-bg);
    }
    .perm-title { font-weight: 700; font-size: 12px; color: var(--oc-critical); margin-bottom: 6px; }
    .perm-desc { font-size: 12px; color: var(--oc-text-dim); margin-bottom: 8px; }
    .perm-input {
      padding: 6px 8px;
      margin-bottom: 8px;
      border-radius: 6px;
      background: rgba(0,0,0,0.2);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 11px;
      color: var(--oc-text-dim);
      white-space: pre-wrap;
      max-height: 120px;
      overflow-y: auto;
    }
    .perm-actions { display: flex; gap: 6px; }
    .perm-btn {
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid;
    }
    .perm-btn.allow {
      background: rgba(232,184,107,0.14);
      border-color: var(--oc-positive);
      color: var(--oc-positive);
    }
    .perm-btn.deny {
      background: rgba(255,138,108,0.1);
      border-color: var(--oc-critical);
      color: var(--oc-critical);
    }
    .perm-btn.allow-session {
      background: rgba(232,184,107,0.08);
      border-color: rgba(232,184,107,0.4);
      color: var(--oc-text-dim);
    }
    .perm-btn:hover { filter: brightness(1.15); }

    /* ── Status pill ── */
    .msg-status {
      align-self: center;
      font-size: 11px;
      color: var(--oc-text-soft);
      padding: 4px 12px;
      border-radius: 999px;
      border: 1px solid var(--oc-border-soft);
      background: rgba(255,255,255,0.02);
    }

    /* ── Rate limit ── */
    .msg-rate-limit {
      align-self: center;
      font-size: 11px;
      color: var(--oc-warning);
      padding: 6px 14px;
      border-radius: 8px;
      border: 1px solid rgba(243,201,105,0.3);
      background: rgba(243,201,105,0.06);
    }

    /* ── Thinking block ── */
    .thinking-block {
      display: none;
      align-self: flex-start;
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid rgba(200,160,255,0.25);
      background: rgba(160,120,220,0.08);
      margin: 4px 0;
      gap: 6px;
      flex-direction: column;
    }
    .thinking-block.visible { display: flex; }
    .thinking-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #c4a0ff;
      font-weight: 600;
    }
    .thinking-spinner {
      width: 12px; height: 12px;
      border: 2px solid rgba(200,160,255,0.3);
      border-top-color: #c4a0ff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .thinking-meta {
      font-size: 11px;
      color: var(--oc-text-soft);
    }

    /* ── Typing indicator ── */
    .typing-indicator {
      display: none;
      align-self: flex-start;
      padding: 10px 14px;
      gap: 4px;
    }
    .typing-indicator.visible { display: flex; }
    .typing-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--oc-accent);
      animation: typingBounce 1.2s infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typingBounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-4px); opacity: 1; }
    }

    /* ── Input area ── */
    .input-area {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--oc-border-soft);
      background: var(--oc-panel);
      flex-shrink: 0;
      align-items: flex-end;
    }
    .input-area textarea {
      flex: 1;
      min-height: 36px;
      max-height: 160px;
      padding: 8px 12px;
      border: 1px solid var(--oc-border-soft);
      border-radius: 10px;
      background: rgba(255,255,255,0.04);
      color: var(--oc-text);
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
      line-height: 1.4;
    }
    .input-area textarea::placeholder { color: var(--oc-text-soft); }
    .input-area textarea:focus { border-color: var(--oc-accent); }
    .send-btn {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      border: 1px solid var(--oc-accent);
      background: linear-gradient(135deg, rgba(240,148,100,0.2), rgba(215,119,87,0.12));
      color: var(--oc-accent-bright);
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .send-btn:hover { background: rgba(240,148,100,0.25); }
    .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* ── Session list overlay ── */
    .session-overlay {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 100;
      background: rgba(5,5,5,0.92);
      flex-direction: column;
    }
    .session-overlay.visible { display: flex; }
    .session-overlay-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--oc-border-soft);
    }
    .session-overlay-header h2 { font-size: 14px; font-weight: 700; flex: 1; }
    .session-search {
      margin: 8px 12px;
      padding: 8px 10px;
      border: 1px solid var(--oc-border-soft);
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
      color: var(--oc-text);
      font-size: 13px;
      outline: none;
    }
    .session-search:focus { border-color: var(--oc-accent); }
    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
    }
    .session-group-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--oc-text-soft);
      padding: 8px 0 4px;
    }
    .session-item {
      padding: 10px;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
      margin-bottom: 4px;
    }
    .session-item:hover { background: rgba(255,255,255,0.04); border-color: var(--oc-border-soft); }
    .session-item-title { font-weight: 600; font-size: 13px; color: var(--oc-text); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-item-preview { font-size: 11px; color: var(--oc-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-item-time { font-size: 10px; color: var(--oc-text-soft); margin-top: 2px; }
    .session-empty { text-align: center; padding: 32px; color: var(--oc-text-soft); }
  </style>
</head>
<body>
  <div class="chat-header">
    <div class="brand">Open<span class="brand-accent">Claude</span></div>
    <button class="header-btn" id="historyBtn" title="Session history">History</button>
    <button class="header-btn" id="newChatBtn" title="New chat">+ New</button>
    <button class="header-btn danger" id="abortBtn" title="Abort generation">Stop</button>
  </div>
  <div class="status-bar">
    <span class="status-dot" id="statusDot"></span>
    <span class="status-text" id="statusText">Ready</span>
    <span class="status-usage" id="statusUsage"></span>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcomeScreen">
      <div class="welcome-title">Open<span class="accent">Claude</span></div>
      <div class="welcome-sub">Ask a question, request a code change, or start a new task.</div>
      <div class="welcome-hint">Press <kbd>${escapeHtml(modKey)}+L</kbd> to focus input</div>
    </div>
  </div>

  <div class="thinking-block" id="thinkingBlock">
    <div class="thinking-header">
      <div class="thinking-spinner"></div>
      <span id="thinkingLabel">Thinking...</span>
    </div>
    <div class="thinking-meta" id="thinkingMeta"></div>
  </div>

  <div class="typing-indicator" id="typingIndicator">
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  </div>

  <div class="input-area">
    <textarea id="chatInput" placeholder="Message OpenClaude..." rows="1"></textarea>
    <button class="send-btn" id="sendBtn" title="Send message">&#x27A4;</button>
  </div>

  <!-- Session list overlay -->
  <div class="session-overlay" id="sessionOverlay">
    <div class="session-overlay-header">
      <h2>Session History</h2>
      <button class="header-btn" id="closeSessionsBtn">Close</button>
    </div>
    <input class="session-search" id="sessionSearch" type="text" placeholder="Search sessions..." />
    <div class="session-list" id="sessionList">
      <div class="session-empty">No sessions found</div>
    </div>
  </div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const welcomeEl = document.getElementById('welcomeScreen');
  const inputEl = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const abortBtn = document.getElementById('abortBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const historyBtn = document.getElementById('historyBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusUsage = document.getElementById('statusUsage');
  const typingIndicator = document.getElementById('typingIndicator');
  const sessionOverlay = document.getElementById('sessionOverlay');
  const closeSessionsBtn = document.getElementById('closeSessionsBtn');
  const sessionSearch = document.getElementById('sessionSearch');
  const sessionList = document.getElementById('sessionList');

  let isStreaming = false;
  let currentAssistantEl = null;
  let currentTextEl = null;
  const toolResultMap = {};

  /* ── Markdown renderer ── */
  function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeForMd(text);

    // fenced code blocks
    html = html.replace(/\`\`\`(\\w*?)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
      const langLabel = lang || 'text';
      const highlighted = highlightCode(code, langLabel);
      const id = 'cb-' + Math.random().toString(36).slice(2, 8);
      return '<div class="code-wrapper"><div class="code-header">' +
        '<span>' + langLabel + '</span>' +
        '<button class="code-copy-btn" data-copy-id="' + id + '">Copy</button></div>' +
        '<code class="code-block" id="' + id + '">' + highlighted + '</code></div>';
    });

    // inline code
    html = html.replace(/\`([^\`]+?)\`/g, '<code>$1</code>');

    // headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // hr
    html = html.replace(/^---$/gm, '<hr/>');

    // bold / italic
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

    // links
    html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" title="$2">$1</a>');

    // unordered lists (simple)
    html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\\/li>\\n?)+)/g, '<ul>$1</ul>');

    // ordered lists
    html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');

    // paragraphs (double newline)
    html = html.replace(/\\n\\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p><\\/p>/g, '');
    html = html.replace(/<p>(<h[123]>)/g, '$1');
    html = html.replace(/(<\\/h[123]>)<\\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\\/ul>)<\\/p>/g, '$1');
    html = html.replace(/<p>(<blockquote>)/g, '$1');
    html = html.replace(/(<\\/blockquote>)<\\/p>/g, '$1');
    html = html.replace(/<p>(<hr\\/>)/g, '$1');
    html = html.replace(/(<hr\\/>)<\\/p>/g, '$1');
    html = html.replace(/<p>(<div class="code-wrapper">)/g, '$1');
    html = html.replace(/(<\\/div>)<\\/p>/g, '$1');

    return html;
  }

  function escapeForMd(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function highlightCode(code, lang) {
    let result = code;
    const kwPattern = /\\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|typeof|instanceof|switch|case|break|default|continue|do|in|of|yield|void|delete|true|false|null|undefined|this|super|extends|implements|interface|type|enum|public|private|protected|static|readonly|abstract|def|print|self|elif|except|finally|with|as|lambda|pass|raise|None|True|False)\\b/g;
    const strPattern = /(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|'[^']*?'|"[^"]*?")/g;
    const commentPattern = /(\\/{2}.*$|#.*$)/gm;
    const numPattern = /\\b(\\d+\\.?\\d*)\\b/g;

    result = result.replace(commentPattern, '<span class="hl-comment">$1</span>');
    result = result.replace(strPattern, '<span class="hl-string">$1</span>');
    result = result.replace(kwPattern, '<span class="hl-keyword">$1</span>');
    result = result.replace(numPattern, '<span class="hl-number">$1</span>');

    return result;
  }

  /* ── DOM helpers ── */
  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function hideWelcome() {
    if (welcomeEl) welcomeEl.style.display = 'none';
  }

  function showWelcome() {
    if (welcomeEl) welcomeEl.style.display = 'flex';
  }

  function setStreaming(val, label) {
    isStreaming = val;
    abortBtn.style.display = val ? 'block' : 'none';
    sendBtn.disabled = val;
    typingIndicator.classList.toggle('visible', val);
    statusDot.className = 'status-dot ' + (val ? 'streaming' : 'connected');
    statusText.textContent = label || (val ? 'Generating...' : 'Ready');
  }

  function setStatusLabel(label) {
    statusText.textContent = label;
  }

  function appendUserMessage(text) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg-user';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function getOrCreateAssistantEl() {
    if (!currentAssistantEl) {
      hideWelcome();
      currentAssistantEl = document.createElement('div');
      currentAssistantEl.className = 'msg-assistant';
      currentTextEl = document.createElement('div');
      currentTextEl.className = 'md-content';
      currentAssistantEl.appendChild(currentTextEl);
      messagesEl.appendChild(currentAssistantEl);
    }
    return { container: currentAssistantEl, textEl: currentTextEl };
  }

  function finalizeAssistant() {
    // Hide the text div if it's empty (model went straight to tool use)
    if (currentTextEl && !currentTextEl.textContent.trim()) {
      currentTextEl.style.display = 'none';
    }
    // Remove the entire bubble if it has no visible content at all
    if (currentAssistantEl) {
      const hasText = currentTextEl && currentTextEl.textContent.trim();
      const hasToolCards = currentAssistantEl.querySelector('.tool-card');
      if (!hasText && !hasToolCards) {
        currentAssistantEl.remove();
      }
    }
    currentAssistantEl = null;
    currentTextEl = null;
  }

  function appendToolCard(toolUse) {
    const { container } = getOrCreateAssistantEl();
    const card = document.createElement('div');
    card.className = 'tool-card expanded';
    card.dataset.toolId = toolUse.id || '';
    const statusClass = toolUse.status || 'running';
    const statusLabel = statusClass === 'running' ? 'Running...'
      : statusClass === 'error' ? 'Error' : 'Done';

    var inputSummary = '';
    if (toolUse.input && typeof toolUse.input === 'object') {
      if (toolUse.input.file_path || toolUse.input.path) {
        inputSummary = (toolUse.input.file_path || toolUse.input.path);
      }
      if (toolUse.input.command) {
        inputSummary = toolUse.input.command;
      }
    }
    if (!inputSummary) inputSummary = toolUse.inputPreview || '';

    var inputDetail = '';
    if (toolUse.input && typeof toolUse.input === 'object') {
      if (toolUse.input.new_string || toolUse.input.content) {
        var content = toolUse.input.new_string || toolUse.input.content || '';
        if (content.length > 500) content = content.slice(0, 500) + '... (truncated)';
        inputDetail = '<div class="tool-input-label">Changes</div>' +
          '<div class="tool-input-content">' + escapeForMd(content) + '</div>';
      }
      if (toolUse.input.old_string && toolUse.input.new_string) {
        var oldStr = toolUse.input.old_string;
        var newStr = toolUse.input.new_string;
        if (oldStr.length > 300) oldStr = oldStr.slice(0, 300) + '...';
        if (newStr.length > 300) newStr = newStr.slice(0, 300) + '...';
        inputDetail = '<div class="tool-input-label">Replace</div>' +
          '<div class="tool-input-content tool-diff-old">' + escapeForMd(oldStr) + '</div>' +
          '<div class="tool-input-label">With</div>' +
          '<div class="tool-input-content tool-diff-new">' + escapeForMd(newStr) + '</div>';
      }
    }

    var isFileTool = inputSummary && !toolUse.input?.command;
    var fileLink = isFileTool
      ? '<a class="file-link" data-filepath="' + escapeForMd(inputSummary) + '" title="Open in editor">' + escapeForMd(inputSummary.split(/[\\/]/).pop() || inputSummary) + '</a>'
      : (inputSummary ? escapeForMd(inputSummary.split(/[\\/]/).pop() || inputSummary) : '');
    var pathDisplay = isFileTool
      ? '<div class="tool-input-label">Path</div><div class="tool-input-content"><a class="file-link" data-filepath="' + escapeForMd(inputSummary) + '" title="Open in editor">' + escapeForMd(inputSummary) + '</a></div>'
      : (inputSummary ? '<div class="tool-input-label">' + (toolUse.input?.command ? 'Command' : 'Path') + '</div><div class="tool-input-content">' + escapeForMd(inputSummary) + '</div>' : '');

    card.innerHTML =
      '<div class="tool-header">' +
        '<span class="tool-icon">' + (toolUse.icon || '') + '</span>' +
        '<span class="tool-name">' + escapeForMd(toolUse.displayName || toolUse.name || 'Tool') +
          (fileLink ? ' <span class="tool-path">' + fileLink + '</span>' : '') +
        '</span>' +
        '<span class="tool-status ' + statusClass + '">' + statusLabel + '</span>' +
        '<span class="tool-chevron">&#9654;</span>' +
      '</div>' +
      '<div class="tool-body">' +
        pathDisplay +
        inputDetail +
        '<div class="tool-output-label">Output</div>' +
        '<div class="tool-output-content" data-tool-output="' + (toolUse.id || '') + '">Running...</div>' +
      '</div>';
    card.querySelector('.tool-header').addEventListener('click', () => {
      card.classList.toggle('expanded');
    });
    container.appendChild(card);
    scrollToBottom();
    return card;
  }

  function updateToolResult(toolUseId, content, isError) {
    const outputEl = document.querySelector('[data-tool-output="' + toolUseId + '"]');
    if (outputEl) {
      outputEl.textContent = content || '(done)';
      if (isError) outputEl.classList.add('error');
    }
    const card = document.querySelector('[data-tool-id="' + toolUseId + '"]');
    if (card) {
      const statusEl = card.querySelector('.tool-status');
      if (statusEl) {
        statusEl.className = 'tool-status ' + (isError ? 'error' : 'complete');
        statusEl.textContent = isError ? 'Error' : 'Done';
      }
    }
  }

  function updateToolProgress(toolUseId, content) {
    const outputEl = document.querySelector('[data-tool-output="' + toolUseId + '"]');
    if (outputEl && (outputEl.textContent === 'Waiting...' || outputEl.textContent === 'Running...')) {
      outputEl.textContent = content || '';
    }
  }

  function updateToolInput(toolUseId, input, toolName) {
    const card = document.querySelector('[data-tool-id="' + toolUseId + '"]');
    if (!card) return;
    const body = card.querySelector('.tool-body');
    if (!body) return;

    if (!input || typeof input !== 'object') return;

    // Update the header with clickable file path
    const nameEl = card.querySelector('.tool-name');
    if (nameEl && (input.file_path || input.path)) {
      const fp = input.file_path || input.path;
      const shortName = fp.split(/[\\/]/).pop() || fp;
      if (!nameEl.querySelector('.tool-path')) {
        nameEl.insertAdjacentHTML('beforeend', ' <span class="tool-path"><a class="file-link" data-filepath="' + escapeForMd(fp) + '" title="Open in editor">' + escapeForMd(shortName) + '</a></span>');
      }
    }

    // Update path display
    var pathHtml = '';
    if (input.file_path || input.path) {
      var fp = input.file_path || input.path;
      pathHtml = '<div class="tool-input-label">Path</div><div class="tool-input-content">' +
        '<a class="file-link" data-filepath="' + escapeForMd(fp) + '" title="Open in editor">' + escapeForMd(fp) + '</a></div>';
    }
    if (input.command) {
      pathHtml = '<div class="tool-input-label">Command</div><div class="tool-input-content">' +
        escapeForMd(input.command) + '</div>';
    }

    // Build diff display for edit operations
    var diffHtml = '';
    if (input.old_string && input.new_string) {
      var oldStr = input.old_string;
      var newStr = input.new_string;
      if (oldStr.length > 500) oldStr = oldStr.slice(0, 500) + '... (truncated)';
      if (newStr.length > 500) newStr = newStr.slice(0, 500) + '... (truncated)';
      diffHtml = '<div class="tool-input-label">Replace</div>' +
        '<div class="tool-input-content tool-diff-old">' + escapeForMd(oldStr) + '</div>' +
        '<div class="tool-input-label">With</div>' +
        '<div class="tool-input-content tool-diff-new">' + escapeForMd(newStr) + '</div>';
    } else if (input.content || input.new_string) {
      var content = input.content || input.new_string || '';
      if (content.length > 800) content = content.slice(0, 800) + '... (truncated)';
      diffHtml = '<div class="tool-input-label">Content</div>' +
        '<div class="tool-input-content tool-diff-new">' + escapeForMd(content) + '</div>';
    }

    // Keep the output element
    const outputEl = body.querySelector('[data-tool-output]');
    const outputHtml = outputEl ? outputEl.outerHTML : '';
    const outputLabel = '<div class="tool-output-label">Output</div>';

    body.innerHTML = pathHtml + diffHtml + outputLabel + outputHtml;
    card.classList.add('expanded');
    scrollToBottom();
  }

  function appendPermissionCard(perm) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'perm-card';
    el.dataset.requestId = perm.requestId || '';
    el.innerHTML =
      '<div class="perm-title">Permission Required: ' + escapeForMd(perm.displayName || perm.toolName || 'Tool') + '</div>' +
      (perm.description ? '<div class="perm-desc">' + escapeForMd(perm.description) + '</div>' : '') +
      (perm.inputPreview ? '<div class="perm-input">' + escapeForMd(perm.inputPreview) + '</div>' : '') +
      '<div class="perm-actions">' +
        '<button class="perm-btn allow" data-action="allow">Allow</button>' +
        '<button class="perm-btn deny" data-action="deny">Deny</button>' +
        '<button class="perm-btn allow-session" data-action="allow-session">Allow for session</button>' +
      '</div>';
    el.querySelectorAll('.perm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        vscode.postMessage({
          type: 'permission_response',
          requestId: perm.requestId,
          toolUseId: perm.toolUseId || null,
          action: action,
        });
        el.querySelectorAll('.perm-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
        btn.style.opacity = '1';
      });
    });
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendStatusMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg-status';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendRateLimitMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg-rate-limit';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  /* ── Thinking block ── */
  const thinkingBlock = document.getElementById('thinkingBlock');
  const thinkingLabel = document.getElementById('thinkingLabel');
  const thinkingMeta = document.getElementById('thinkingMeta');

  function showThinkingBlock() {
    thinkingBlock.classList.add('visible');
    thinkingLabel.textContent = 'Thinking...';
    thinkingMeta.textContent = '';
    setStatusLabel('Thinking...');
    scrollToBottom();
  }

  function updateThinkingBlock(tokens, elapsed) {
    const elapsedStr = elapsed >= 60
      ? Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's'
      : elapsed + 's';
    thinkingLabel.textContent = 'Thinking...';
    thinkingMeta.textContent = elapsedStr + ' · ~' + tokens + ' tokens';
    setStatusLabel('Thinking... (' + elapsedStr + ')');
  }

  function hideThinkingBlock() {
    thinkingBlock.classList.remove('visible');
    setStatusLabel('Generating...');
  }

  /* ── Session list ── */
  function renderSessionList(sessions) {
    if (!sessions || sessions.length === 0) {
      sessionList.innerHTML = '<div class="session-empty">No sessions found</div>';
      return;
    }
    const groups = groupByDate(sessions);
    let html = '';
    for (const [label, items] of groups) {
      html += '<div class="session-group-label">' + escapeForMd(label) + '</div>';
      for (const s of items) {
        html += '<div class="session-item" data-session-id="' + (s.id || '') + '">' +
          '<div class="session-item-title">' + escapeForMd(s.title || s.id || 'Untitled') + '</div>' +
          '<div class="session-item-preview">' + escapeForMd(s.preview || '') + '</div>' +
          '<div class="session-item-time">' + escapeForMd(s.timeLabel || '') + '</div>' +
        '</div>';
      }
    }
    sessionList.innerHTML = html;
    sessionList.querySelectorAll('.session-item').forEach(el => {
      el.addEventListener('click', () => {
        vscode.postMessage({ type: 'resume_session', sessionId: el.dataset.sessionId });
        sessionOverlay.classList.remove('visible');
      });
    });
  }

  function groupByDate(sessions) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    const weekAgo = today - 604800000;
    const groups = new Map();
    for (const s of sessions) {
      const t = s.timestamp || 0;
      let label;
      if (t >= today) label = 'Today';
      else if (t >= yesterday) label = 'Yesterday';
      else if (t >= weekAgo) label = 'This Week';
      else label = 'Older';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(s);
    }
    return groups;
  }

  /* ── Input handling ── */
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;
    appendUserMessage(text);
    vscode.postMessage({ type: 'send_message', text });
    inputEl.value = '';
    autoResizeInput();
    setStreaming(true);
  }

  function autoResizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  }

  inputEl.addEventListener('input', autoResizeInput);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
  newChatBtn.addEventListener('click', () => vscode.postMessage({ type: 'new_session' }));
  historyBtn.addEventListener('click', () => {
    sessionOverlay.classList.toggle('visible');
    if (sessionOverlay.classList.contains('visible')) {
      vscode.postMessage({ type: 'request_sessions' });
      sessionSearch.focus();
    }
  });
  closeSessionsBtn.addEventListener('click', () => sessionOverlay.classList.remove('visible'));
  sessionSearch.addEventListener('input', () => {
    const q = sessionSearch.value.toLowerCase();
    sessionList.querySelectorAll('.session-item').forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(q) ? '' : 'none';
    });
  });

  // Copy code handler (event delegation)
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.code-copy-btn');
    if (copyBtn) {
      const id = copyBtn.dataset.copyId;
      const codeEl = document.getElementById(id);
      if (codeEl) {
        const text = codeEl.textContent;
        vscode.postMessage({ type: 'copy_code', text });
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      }
      return;
    }

    const fileLink = e.target.closest('.file-link');
    if (fileLink) {
      e.preventDefault();
      e.stopPropagation();
      const filepath = fileLink.dataset.filepath;
      if (filepath) {
        vscode.postMessage({ type: 'open_file', path: filepath });
      }
      return;
    }
  });

  /* ── Message handling from extension ── */
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.type) {
      case 'stream_start':
        setStreaming(true, 'Generating...');
        getOrCreateAssistantEl();
        break;

      case 'stream_delta': {
        setStatusLabel('Generating...');
        const { textEl } = getOrCreateAssistantEl();
        textEl.innerHTML = renderMarkdown(msg.text || '');
        scrollToBottom();
        break;
      }

      case 'stream_end':
        if (msg.text) {
          const { textEl } = getOrCreateAssistantEl();
          textEl.innerHTML = renderMarkdown(msg.text);
        }
        finalizeAssistant();
        if (msg.usage) {
          const u = msg.usage;
          statusUsage.textContent = (u.input_tokens || 0) + ' in / ' + (u.output_tokens || 0) + ' out';
        }
        if (msg.final) {
          setStreaming(false);
        }
        scrollToBottom();
        break;

      case 'tool_use':
        appendToolCard(msg.toolUse);
        setStatusLabel('Running: ' + (msg.toolUse.displayName || msg.toolUse.name || 'tool') + '...');
        break;

      case 'tool_result':
        updateToolResult(msg.toolUseId, msg.content, msg.isError);
        break;

      case 'tool_input_ready':
        updateToolInput(msg.toolUseId, msg.input, msg.name);
        break;

      case 'tool_progress':
        updateToolProgress(msg.toolUseId, msg.content);
        break;

      case 'permission_request':
        appendPermissionCard(msg);
        break;

      case 'status':
        setStatusLabel(msg.content || 'Working...');
        break;

      case 'rate_limit':
        appendRateLimitMessage(msg.message || 'Rate limited');
        break;

      case 'thinking_start':
        showThinkingBlock();
        break;

      case 'thinking_delta':
        updateThinkingBlock(msg.tokens || 0, msg.elapsed || 0);
        break;

      case 'thinking_end':
        hideThinkingBlock();
        break;

      case 'system_info':
        if (msg.model) {
          statusUsage.textContent = msg.model;
        }
        break;

      case 'error':
        setStreaming(false);
        finalizeAssistant();
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Error: ' + (msg.message || 'Unknown error');
        break;

      case 'session_list':
        renderSessionList(msg.sessions);
        break;

      case 'session_cleared':
        // Resume also clears the view before the selected session is ready.
        if (msg.resetStreaming) setStreaming(false);
        messagesEl.innerHTML = '';
        if (welcomeEl) {
          messagesEl.appendChild(welcomeEl);
          showWelcome();
        }
        currentAssistantEl = null;
        currentTextEl = null;
        statusUsage.textContent = '';
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Ready';
        break;

      case 'restore_messages':
        hideWelcome();
        if (msg.messages) {
          for (const m of msg.messages) {
            if (m.role === 'user') {
              appendUserMessage(m.text || '');
            } else if (m.role === 'assistant') {
              const { textEl } = getOrCreateAssistantEl();
              textEl.innerHTML = renderMarkdown(m.text || '');
              if (m.toolUses && m.toolUses.length > 0) {
                for (const tu of m.toolUses) {
                  var displayName = tu.name || 'Tool';
                  var icon = '';
                  var inputPreview = '';
                  if (tu.input && typeof tu.input === 'object') {
                    inputPreview = tu.input.file_path || tu.input.path || tu.input.command || '';
                  }
                  var card = appendToolCard({
                    id: tu.id,
                    name: tu.name,
                    displayName: displayName,
                    icon: icon,
                    inputPreview: inputPreview,
                    input: tu.input,
                    status: tu.status || 'complete',
                  });
                  if (tu.input) {
                    updateToolInput(String(tu.id), tu.input, tu.name);
                  }
                  if (tu.result !== undefined && tu.result !== null) {
                    updateToolResult(String(tu.id), tu.result, tu.isError || false);
                  } else {
                    updateToolResult(String(tu.id), '(done)', false);
                  }
                }
              }
              finalizeAssistant();
            }
          }
        }
        scrollToBottom();
        break;

      case 'connected':
        setStreaming(false);
        statusDot.className = 'status-dot connected';
        statusText.textContent = msg.message || 'Connected';
        break;

      default:
        break;
    }
  });

  // Focus input on Ctrl/Cmd+L
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      e.preventDefault();
      inputEl.focus();
    }
  });

  // Restore state
  const prevState = vscode.getState();
  if (prevState && prevState.hasMessages) {
    vscode.postMessage({ type: 'restore_request' });
  }

  // Notify ready
  vscode.postMessage({ type: 'webview_ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { renderChatHtml };
