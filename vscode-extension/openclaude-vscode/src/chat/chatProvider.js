/**
 * chatProvider — WebviewViewProvider (sidebar) and WebviewPanel manager
 * (editor tab) that wire ProcessManager events to the chat UI.
 */

const vscode = require('vscode');
const crypto = require('crypto');
const { ProcessManager } = require('./processManager');
const { buildPermissionControlResult } = require('./permissionResponse');
const { toViewModel } = require('./messageParser');
const { renderChatHtml } = require('./chatRenderer');
const { isAssistantMessage, isStreamEvent,
        isControlRequest, isToolProgressMessage,
        isStatusMessage, isRateLimitEvent, getTextContent,
        getToolUseBlocks } = require('./protocol');

async function openFileInEditor(filePath) {
  try {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    vscode.window.showWarningMessage(`Could not open file: ${filePath}`);
  }
}

function getLaunchConfig() {
  const cfg = vscode.workspace.getConfiguration('openclaude');
  const command = cfg.get('launchCommand', 'openclaude');
  const shimEnabled = cfg.get('useOpenAIShim', false);
  const permissionMode = cfg.get('permissionMode', 'acceptEdits');
  const env = {};
  if (shimEnabled) env.CLAUDE_CODE_USE_OPENAI = '1';
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  return { command, cwd, env, permissionMode };
}

class ChatController {
  constructor(sessionManager) {
    this._sessionManager = sessionManager;
    this._process = null;
    this._startGeneration = 0;
    this._resetGeneration = 0;
    this._pendingStart = null;
    this._webviews = new Set();
    this._accumulatedText = '';
    this._toolUses = [];
    this._messages = [];
    this._currentSessionId = null;
    this._streaming = false;
    this._lastResult = null;
    this._thinkingTokens = 0;
    this._thinkingStartTime = null;
    this._currentBlockType = null;
    /** @type {Map<string, { input: Record<string, unknown>, permissionSuggestions: unknown[], toolUseId: string | null }>} */
    this._pendingPermissions = new Map();

    this._onDidChangeState = new vscode.EventEmitter();
    this.onDidChangeState = this._onDidChangeState.event;
  }

  get sessionId() { return this._currentSessionId; }
  get isStreaming() { return this._process && this._process.running; }
  get sessionManager() { return this._sessionManager; }

  registerWebview(webview) {
    this._webviews.add(webview);
    return { dispose: () => this._webviews.delete(webview) };
  }

  broadcast(msg) {
    for (const wv of this._webviews) {
      try { wv.postMessage(msg); } catch { /* webview might be disposed */ }
    }
  }

  _broadcast(msg) {
    this.broadcast(msg);
  }

  startSession(opts = {}) {
    this.stopSession();
    const pending = this._startSession(opts).finally(() => {
      if (this._pendingStart === pending) this._pendingStart = null;
    });
    this._pendingStart = pending;
    return pending;
  }

  async _startSession(opts) {
    this._accumulatedText = '';
    this._toolUses = [];
    // Only clear messages if this is a brand new session (not continuing)
    if (!opts.continueSession && !opts.sessionId) {
      this._messages = [];
    }
    this._currentSessionId = opts.sessionId || this._currentSessionId || null;

    const { command, cwd, env, permissionMode } = getLaunchConfig();

    const generation = this._startGeneration;
    const resumeTarget = opts.sessionId
      ? await this._sessionManager.getResumeTarget(opts.sessionId)
      : undefined;
    // A stop or another selection can arrive while resolving the transcript.
    if (generation !== this._startGeneration) return;

    this._process = new ProcessManager({
      command,
      cwd,
      env,
      sessionId: opts.sessionId,
      resumeTarget,
      continueSession: opts.continueSession || false,
      model: opts.model,
      permissionMode,
      extraArgs: opts.extraArgs || [],
    });

    this._readyResolve = null;
    this._readyPromise = new Promise(resolve => { this._readyResolve = resolve; });

    this._process.onMessage((msg) => {
      if (msg.type === 'system' && this._readyResolve) {
        this._readyResolve();
        this._readyResolve = null;
      }
      this._handleMessage(msg);
    });
    this._process.onError((err) => {
      this._broadcast({ type: 'error', message: err.message || String(err) });
    });
    this._process.onExit(({ code }) => {
      // Flush any remaining streamed text
      if (this._streaming && this._accumulatedText) {
        this._broadcast({ type: 'stream_end', text: this._accumulatedText, usage: null, final: true });
      } else if (this._streaming) {
        this._broadcast({ type: 'stream_end', text: '', usage: (this._lastResult || {}).usage || null, final: true });
      }
      this._streaming = false;
      this._accumulatedText = '';
      this._toolUses = [];
      this._lastResult = null;
      this._broadcast({
        type: 'connected',
        message: code === 0 ? 'Ready' : `Process exited (code ${code})`,
      });
      this._onDidChangeState.fire('idle');
    });

    try {
      this._process.start();
      this._broadcast({ type: 'connected', message: 'Connected' });
      this._onDidChangeState.fire('connected');
    } catch (err) {
      this._broadcast({ type: 'error', message: `Failed to start: ${err.message}` });
    }
  }

  stopSession() {
    this._startGeneration++;
    this._pendingStart = null;
    if (this._process) {
      this._process.dispose();
      this._process = null;
    }
    this._pendingPermissions.clear();
  }

  resetForNewSession() {
    this._resetGeneration++;
    this.stopSession();
    this._currentSessionId = null;
    this._messages = [];
    this.broadcast({ type: 'session_cleared', resetStreaming: true });
  }

  async sendMessage(text) {
    // Reuse a pending restart so simultaneous sends retain both messages.
    // A stop or a new selection cancels sends waiting on the old startup.
    const pending = this._pendingStart || ((!this._process || !this._process.running)
      ? this.startSession({ sessionId: this._currentSessionId || undefined })
      : null);
    const generation = this._startGeneration;
    if (pending) await pending;
    if (generation !== this._startGeneration) return;
    await this._doSend(text);
  }

  async _doSend(text) {
    if (!this._process) return;
    const process = this._process;
    const generation = this._startGeneration;
    // On first message after process start, wait for CLI to be ready.
    // On subsequent messages, the process is already running and accepting input.
    if (this._readyPromise) {
      const grace = new Promise(resolve => setTimeout(resolve, 8000));
      await Promise.race([this._readyPromise, grace]);
      if (generation !== this._startGeneration || process !== this._process) return;
      this._readyPromise = null;
    }
    this._accumulatedText = '';
    this._toolUses = [];
    try {
      this._process.sendUserMessage(text);
      this._messages.push({ role: 'user', text });
    } catch (err) {
      this._broadcast({ type: 'error', message: err.message });
    }
  }

  abort() {
    if (this._pendingStart && !this._process) {
      // Discovery has no child to signal yet. Invalidate its startup and all
      // sends waiting on it, just as stopping or replacing the session does.
      this.stopSession();
      this._broadcast({ type: 'stream_end', text: '', usage: null, final: true });
      this._onDidChangeState.fire('idle');
      return;
    }
    if (this._process) {
      this._process.abort();
      this._broadcast({ type: 'stream_end', text: this._accumulatedText, usage: null });
      this._onDidChangeState.fire('idle');
    }
  }

  sendPermissionResponse(requestId, action, toolUseId) {
    if (!this._process) return;
    const pending = this._pendingPermissions.get(requestId);
    this._pendingPermissions.delete(requestId);
    const result = buildPermissionControlResult(action, {
      input: pending?.input,
      toolUseId: toolUseId || pending?.toolUseId || null,
      permissionSuggestions: pending?.permissionSuggestions,
    });
    try {
      this._process.sendControlResponse(requestId, result);
    } catch (err) {
      this._broadcast({ type: 'error', message: err.message });
    }
  }

  getMessages() { return this._messages; }

  _handleMessage(msg) {
    if (msg.session_id && !this._currentSessionId) {
      this._currentSessionId = msg.session_id;
    }

    // System message — extract model and session info
    if (msg.type === 'system') {
      this._broadcast({
        type: 'system_info',
        model: msg.model || null,
        sessionId: msg.session_id || msg.sessionId || null,
      });
      return;
    }

    // Control request (permission prompt) — check EARLY before other handlers
    if (msg.type === 'control_request' || isControlRequest(msg)) {
      const req = msg.request || {};
      const { toolDisplayName, parseToolInput } = require('./messageParser');
      const requestId = msg.request_id;
      const toolInput =
        req.input && typeof req.input === 'object' && !Array.isArray(req.input)
          ? req.input
          : {};
      if (requestId) {
        this._pendingPermissions.set(requestId, {
          input: toolInput,
          permissionSuggestions: Array.isArray(req.permission_suggestions)
            ? req.permission_suggestions
            : [],
          toolUseId: req.tool_use_id || null,
        });
      }
      this._broadcast({
        type: 'permission_request',
        requestId,
        toolName: req.tool_name || 'Unknown',
        displayName: req.display_name || req.title || toolDisplayName(req.tool_name),
        description: req.description || '',
        inputPreview: parseToolInput(req.input),
        toolUseId: req.tool_use_id || null,
      });
      return;
    }

    // Control cancel request
    if (msg.type === 'control_cancel_request') {
      return;
    }

    // Handle Anthropic raw stream events (the primary streaming mechanism)
    if (isStreamEvent(msg)) {
      this._handleStreamEvent(msg);
      return;
    }

    // Assistant message — always mid-turn; true completion comes from 'result'
    if (isAssistantMessage(msg)) {
      const inner = msg.message || msg;
      const text = getTextContent(inner);
      const toolBlocks = getToolUseBlocks(inner);
      const { toolDisplayName, toolIcon } = require('./messageParser');
      const toolUseVms = toolBlocks.map(tu => ({
        id: tu.id,
        name: tu.name,
        displayName: toolDisplayName(tu.name),
        icon: toolIcon(tu.name),
        inputPreview: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || ''),
        input: tu.input,
        status: 'running',
      }));
      this._messages.push({ role: 'assistant', text, toolUses: toolUseVms });
      const usage = inner.usage || msg.usage || null;

      // Finalize current text bubble but stay streaming — true completion
      // is signaled by the 'result' message, not by the assistant message.
      this._broadcast({ type: 'stream_end', text, usage, final: false });
      this._accumulatedText = '';

      if (toolBlocks.length > 0) {
        for (const tu of toolBlocks) {
          this._broadcast({
            type: 'tool_input_ready',
            toolUseId: tu.id,
            input: tu.input,
            name: tu.name,
          });
        }
        this._broadcast({ type: 'status', content: 'Using tools...' });
      }
      return;
    }

    // User message with tool_use_result — this is the tool output
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(b => b.text || '').join('')
                : '';
            this._broadcast({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content: resultText.slice(0, 2000) || '(done)',
              isError: block.is_error || false,
            });
          }
        }
      }
      this._broadcast({ type: 'status', content: 'Thinking...' });
      return;
    }

    // Session result — turn is complete. Go idle. The process stays alive
    // in stream-json mode for multi-turn conversation.
    if (msg.type === 'result' && msg.subtype) {
      this._lastResult = msg;
      // Only use result text if nothing was shown via streaming yet
      const text = this._accumulatedText || '';
      this._broadcast({ type: 'stream_end', text, usage: msg.usage || null, final: true });
      // Show turn info: if the model stopped without using tools (num_turns=1),
      // the user knows the model chose not to edit
      if (msg.num_turns !== undefined) {
        this._broadcast({
          type: 'status',
          content: msg.num_turns > 1
            ? 'Completed (' + msg.num_turns + ' turns)'
            : 'Ready',
        });
      }
      this._accumulatedText = '';
      this._toolUses = [];
      this._streaming = false;
      this._onDidChangeState.fire('idle');
      return;
    }

    if (isToolProgressMessage(msg)) {
      const vm = toViewModel(msg)[0];
      this._broadcast({
        type: 'tool_progress',
        toolUseId: vm.toolUseId,
        content: vm.content,
      });
      return;
    }

    if (isStatusMessage(msg)) {
      const vm = toViewModel(msg)[0];
      this._broadcast({ type: 'status', content: vm.content });
      return;
    }

    if (isRateLimitEvent(msg)) {
      const vm = toViewModel(msg)[0];
      this._broadcast({ type: 'rate_limit', message: vm.message });
      return;
    }

    // Log unhandled message types for debugging
    if (msg.type && msg.type !== 'stream_event') {
      this._broadcast({ type: 'status', content: '[debug] unhandled: ' + msg.type });
    }
  }

  _handleStreamEvent(msg) {
    const event = msg.event;
    if (!event) return;

    switch (event.type) {
      case 'message_start':
        this._accumulatedText = '';
        this._thinkingTokens = 0;
        this._currentBlockType = null;
        if (!this._streaming) {
          this._streaming = true;
          this._toolUses = [];
          this._onDidChangeState.fire('streaming');
        }
        this._broadcast({ type: 'stream_start' });
        break;

      case 'content_block_start':
        if (event.content_block) {
          this._currentBlockType = event.content_block.type;
          if (event.content_block.type === 'tool_use') {
            const tu = event.content_block;
            this._toolUses.push({ id: tu.id, name: tu.name, input: '' });
            const { toolDisplayName, toolIcon } = require('./messageParser');
            this._broadcast({
              type: 'tool_use',
              toolUse: {
                id: tu.id,
                name: tu.name,
                displayName: toolDisplayName(tu.name),
                icon: toolIcon(tu.name),
                inputPreview: '',
                input: tu.input || null,
                status: 'running',
              },
            });
          } else if (event.content_block.type === 'thinking') {
            this._thinkingTokens = 0;
            this._thinkingStartTime = Date.now();
            this._broadcast({ type: 'thinking_start' });
          }
        }
        break;

      case 'content_block_delta':
        if (event.delta) {
          if (event.delta.type === 'text_delta' && event.delta.text) {
            this._accumulatedText += event.delta.text;
            this._broadcast({ type: 'stream_delta', text: this._accumulatedText });
          } else if (event.delta.type === 'thinking_delta') {
            this._thinkingTokens += (event.delta.thinking || '').length;
            const elapsed = Math.round((Date.now() - (this._thinkingStartTime || Date.now())) / 1000);
            this._broadcast({
              type: 'thinking_delta',
              tokens: this._thinkingTokens,
              elapsed,
            });
          } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            const lastTool = this._toolUses[this._toolUses.length - 1];
            if (lastTool) {
              lastTool.input = (lastTool.input || '') + event.delta.partial_json;
            }
          }
        }
        break;

      case 'content_block_stop':
        if (this._currentBlockType === 'thinking') {
          this._broadcast({ type: 'thinking_end' });
        }
        this._currentBlockType = null;
        break;

      case 'message_delta':
        break;

      case 'message_stop':
        break;

      default:
        break;
    }
  }

  dispose() {
    this.stopSession();
    this._onDidChangeState.dispose();
  }
}

class OpenClaudeChatViewProvider {
  constructor(chatController) {
    this._chatController = chatController;
    this._webviewView = null;
  }

  resolveWebviewView(webviewView, _context, _token) {
    this._webviewView = webviewView;
    const webview = webviewView.webview;
    webview.options = { enableScripts: true };

    const registration = this._chatController.registerWebview(webview);
    webviewView.onDidDispose(() => {
      registration.dispose();
      if (this._webviewView === webviewView) this._webviewView = null;
    });

    webview.html = this._getHtml(webview);
    this._attachMessageHandler(webview);
  }

  _getHtml() {
    const nonce = crypto.randomBytes(16).toString('hex');
    return renderChatHtml({ nonce, platform: process.platform });
  }

  _attachMessageHandler(webview) {
    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send_message':
          this._chatController.sendMessage(msg.text);
          break;
        case 'abort':
          this._chatController.abort();
          break;
        case 'new_session':
          this._chatController.resetForNewSession();
          break;
        case 'resume_session':
          this._chatController.stopSession();
          webview.postMessage({ type: 'session_cleared' });
          {
            const generation = this._chatController._resetGeneration;
            await this._loadAndDisplaySession(webview, msg.sessionId);
            if (generation !== this._chatController._resetGeneration) break;
            await this._chatController.startSession({ sessionId: msg.sessionId });
          }
          break;
        case 'permission_response':
          this._chatController.sendPermissionResponse(msg.requestId, msg.action, msg.toolUseId);
          break;
        case 'copy_code':
          if (msg.text) await vscode.env.clipboard.writeText(msg.text);
          break;
        case 'open_file':
          if (msg.path) await openFileInEditor(msg.path);
          break;
        case 'request_sessions':
          await this._sendSessionList(webview);
          break;
        case 'restore_request':
          this._restoreMessages(webview);
          break;
        case 'webview_ready':
          break;
      }
    });
  }

  async _sendSessionList(webview) {
    if (!this._chatController.sessionManager) return;
    try {
      const sessions = await this._chatController.sessionManager.listSessions();
      webview.postMessage({ type: 'session_list', sessions });
    } catch {
      webview.postMessage({ type: 'session_list', sessions: [] });
    }
  }

  _restoreMessages(webview) {
    const messages = this._chatController.getMessages();
    if (messages.length > 0) {
      webview.postMessage({ type: 'restore_messages', messages });
    }
  }

  async _loadAndDisplaySession(webview, sessionId) {
    if (!this._chatController.sessionManager) return;
    try {
      const generation = this._chatController._resetGeneration;
      const messages = await this._chatController.sessionManager.loadSession(sessionId);
      if (generation !== this._chatController._resetGeneration) return;
      if (messages && messages.length > 0) {
        this._chatController._messages = messages;
        webview.postMessage({ type: 'restore_messages', messages });
      }
    } catch { /* session may not be loadable */ }
  }
}

class OpenClaudeChatPanelManager {
  constructor(chatController) {
    this._chatController = chatController;
    this._panel = null;
  }

  openPanel() {
    if (this._panel) {
      this._panel.reveal();
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'openclaude.chatPanel',
      'OpenClaude Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const webview = this._panel.webview;
    const registration = this._chatController.registerWebview(webview);

    this._panel.onDidDispose(() => {
      registration.dispose();
      this._panel = null;
    });

    const nonce = crypto.randomBytes(16).toString('hex');
    webview.html = renderChatHtml({ nonce, platform: process.platform });
    this._attachMessageHandler(webview);

    const messages = this._chatController.getMessages();
    if (messages.length > 0) {
      webview.postMessage({ type: 'restore_messages', messages });
    }
  }

  _attachMessageHandler(webview) {
    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send_message':
          this._chatController.sendMessage(msg.text);
          break;
        case 'abort':
          this._chatController.abort();
          break;
        case 'new_session':
          this._chatController.resetForNewSession();
          break;
        case 'resume_session':
          this._chatController.stopSession();
          webview.postMessage({ type: 'session_cleared' });
          {
            const generation = this._chatController._resetGeneration;
            await this._loadAndDisplaySession(webview, msg.sessionId);
            if (generation !== this._chatController._resetGeneration) break;
            await this._chatController.startSession({ sessionId: msg.sessionId });
          }
          break;
        case 'permission_response':
          this._chatController.sendPermissionResponse(msg.requestId, msg.action, msg.toolUseId);
          break;
        case 'copy_code':
          if (msg.text) await vscode.env.clipboard.writeText(msg.text);
          break;
        case 'open_file':
          if (msg.path) await openFileInEditor(msg.path);
          break;
        case 'request_sessions':
          await this._sendSessionList(webview);
          break;
        case 'restore_request':
          this._restoreMessages(webview);
          break;
        case 'webview_ready':
          break;
      }
    });
  }

  async _sendSessionList(webview) {
    if (!this._chatController.sessionManager) return;
    try {
      const sessions = await this._chatController.sessionManager.listSessions();
      webview.postMessage({ type: 'session_list', sessions });
    } catch {
      webview.postMessage({ type: 'session_list', sessions: [] });
    }
  }

  _restoreMessages(webview) {
    const messages = this._chatController.getMessages();
    if (messages.length > 0) {
      webview.postMessage({ type: 'restore_messages', messages });
    }
  }

  async _loadAndDisplaySession(webview, sessionId) {
    if (!this._chatController.sessionManager) return;
    try {
      const generation = this._chatController._resetGeneration;
      const messages = await this._chatController.sessionManager.loadSession(sessionId);
      if (generation !== this._chatController._resetGeneration) return;
      if (messages && messages.length > 0) {
        this._chatController._messages = messages;
        webview.postMessage({ type: 'restore_messages', messages });
      }
    } catch { /* session may not be loadable */ }
  }

  dispose() {
    if (this._panel) {
      this._panel.dispose();
      this._panel = null;
    }
  }
}

module.exports = {
  ChatController,
  OpenClaudeChatViewProvider,
  OpenClaudeChatPanelManager,
};
