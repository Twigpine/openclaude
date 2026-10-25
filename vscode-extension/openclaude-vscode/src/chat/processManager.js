/**
 * ProcessManager — spawns OpenClaude in print/SDK mode and manages the
 * NDJSON stdin/stdout lifecycle.
 *
 * Usage:
 *   const pm = new ProcessManager({ command, cwd, env });
 *   pm.onMessage(msg => { ... });
 *   pm.onError(err => { ... });
 *   pm.onExit(code => { ... });
 *   await pm.start();
 *   pm.sendUserMessage('Hello');
 *   pm.abort();          // SIGINT (graceful)
 *   pm.kill();           // SIGTERM (hard)
 *   pm.dispose();
 */

const { spawn } = require('child_process');
const vscode = require('vscode');
const { buildWindowsCommand } = require('./windowsArguments');
const { parseStdoutLine, serializeStdinMessage, buildUserMessage, buildControlResponse } = require('./protocol');

class ProcessManager {
  /**
   * @param {object} opts
   * @param {string} opts.command - The openclaude binary (e.g. 'openclaude')
   * @param {string} [opts.cwd] - Working directory
   * @param {Record<string,string>} [opts.env] - Extra env vars
   * @param {string} [opts.sessionId] - Session to resume
   * @param {boolean} [opts.continueSession] - Use --continue instead of --resume
   * @param {string} [opts.model] - Model override
   * @param {string[]} [opts.extraArgs] - Additional CLI flags
   */
  constructor(opts) {
    this._command = opts.command || 'openclaude';
    this._cwd = opts.cwd || undefined;
    this._env = opts.env || {};
    this._sessionId = opts.sessionId || null;
    this._continueSession = opts.continueSession || false;
    this._model = opts.model || null;
    this._permissionMode = opts.permissionMode || 'acceptEdits';
    this._extraArgs = opts.extraArgs || [];
    this._process = null;
    this._buffer = '';
    this._disposed = false;

    this._onMessageEmitter = new vscode.EventEmitter();
    this._onErrorEmitter = new vscode.EventEmitter();
    this._onExitEmitter = new vscode.EventEmitter();
    this.onMessage = this._onMessageEmitter.event;
    this.onError = this._onErrorEmitter.event;
    this.onExit = this._onExitEmitter.event;
  }

  get running() {
    return this._process !== null && !this._process.killed;
  }

  get sessionId() {
    return this._sessionId;
  }

  start() {
    if (this._disposed) throw new Error('ProcessManager is disposed');
    if (this._process) throw new Error('Process already started');

    const args = [
      '--print',
      '--verbose',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--permission-mode', this._permissionMode || 'acceptEdits',
    ];

    if (this._sessionId) {
      args.push('--resume', this._sessionId);
    } else if (this._continueSession) {
      args.push('--continue');
    }

    if (this._model) {
      args.push('--model', this._model);
    }

    args.push(...this._extraArgs);

    const spawnEnv = { ...process.env, ...this._env };
    const isWin = process.platform === 'win32';

    if (isWin) {
      // npm installs use .cmd shims. Keep argument quotes balanced through
      // both cmd.exe and the shim's %* forwarding; disable delayed expansion.
      this._process = spawn(process.env.ComSpec || 'cmd.exe', [
        '/d', '/e:on', '/v:off', '/s', '/c',
        buildWindowsCommand(this._command, args),
      ], {
        cwd: this._cwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
        windowsHide: true,
      });
    } else {
      this._process = spawn(this._command, args, {
        cwd: this._cwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }

    this._process.stdout.setEncoding('utf8');
    this._process.stderr.setEncoding('utf8');

    this._process.stdout.on('data', (chunk) => this._onData(chunk));
    this._process.stderr.on('data', (chunk) => this._onStderr(chunk));
    this._process.on('error', (err) => this._onErrorEmitter.fire(err));
    this._process.on('close', (code, signal) => {
      this._process = null;
      this._onExitEmitter.fire({ code, signal });
    });
  }

  _onData(chunk) {
    this._buffer += chunk;
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';

    for (const line of lines) {
      const msg = parseStdoutLine(line);
      if (msg) {
        this._extractSessionId(msg);
        this._onMessageEmitter.fire(msg);
      }
    }
  }

  _extractSessionId(msg) {
    if (msg.session_id && !this._sessionId) {
      this._sessionId = msg.session_id;
    }
  }

  _onStderr(chunk) {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    // Suppress common non-error noise from the CLI (deprecation warnings, etc.)
    if (/^\(node:\d+\)|^DeprecationWarning|^ExperimentalWarning/i.test(trimmed)) return;
    this._onErrorEmitter.fire(new Error(trimmed));
  }

  sendUserMessage(text) {
    this._write(buildUserMessage(text));
  }

  sendControlResponse(requestId, result) {
    this._write(buildControlResponse(requestId, result));
  }

  write(msg) {
    if (!this._process || !this._process.stdin.writable) {
      throw new Error('Process is not running');
    }
    this._process.stdin.write(serializeStdinMessage(msg));
  }

  _write(msg) {
    this.write(msg);
  }

  abort() {
    if (this._process && !this._process.killed) {
      if (process.platform === 'win32') {
        this._process.kill('SIGINT');
      } else {
        this._process.kill('SIGINT');
      }
    }
  }

  kill() {
    if (this._process && !this._process.killed) {
      this._process.kill('SIGTERM');
    }
  }

  dispose() {
    this._disposed = true;
    this.kill();
    this._onMessageEmitter.dispose();
    this._onErrorEmitter.dispose();
    this._onExitEmitter.dispose();
  }
}

module.exports = { ProcessManager };
