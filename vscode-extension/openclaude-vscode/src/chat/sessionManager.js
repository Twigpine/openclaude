/**
 * sessionManager — reads JSONL session history from disk, lists sessions,
 * and provides metadata for the session list UI.
 *
 * Session files live under:
 *   ~/.openclaude/projects/<sanitized-cwd>/<sessionId>.jsonl
 *
 * OPENCLAUDE_CONFIG_DIR overrides the config root, matching the CLI.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const readline = require('readline');
require('crypto');

// Keep in sync with src/utils/sessionStoragePortable.ts.
const MAX_SANITIZED_LENGTH = 200;

function sanitizePath(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  const hash = simpleHash(name);
  return sanitized.slice(0, MAX_SANITIZED_LENGTH) + '-' + hash;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function resolveConfigDir() {
  // Match src/utils/envUtils.ts: OpenClaude and Claude Code are independent.
  return (process.env.OPENCLAUDE_CONFIG_DIR || path.join(os.homedir(), '.openclaude')).normalize('NFC');
}

function getProjectsDir() {
  return path.join(resolveConfigDir(), 'projects');
}

/** Same rule as resolveSessionFilePath: a zero-byte file is not a session. */
async function hasTranscriptBytes(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Return the Node directory first, followed by alternate long-path hashes. */
async function getProjectDirs(cwd) {
  const sanitized = sanitizePath(cwd);
  const exact = path.join(getProjectsDir(), sanitized);
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return [exact];
  try {
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH) + '-';
    const entries = await fsp.readdir(getProjectsDir(), { withFileTypes: true });
    return [exact, ...entries
      .filter(e => e.isDirectory() && e.name !== sanitized && e.name.startsWith(prefix))
      .map(e => path.join(getProjectsDir(), e.name))];
  } catch {
    return [exact];
  }
}

class SessionManager {
  constructor() {
    this._cwd = null;
  }

  setCwd(cwd) {
    this._cwd = cwd;
  }

  async listSessions() {
    const cwd = this._cwd;
    const dirs = cwd ? await getProjectDirs(cwd) : await this._allProjectDirs();

    const sessions = [];
    const seenIds = new Set();
    for (const [index, dir] of dirs.entries()) {
      const items = await this._readSessionDir(dir, cwd && index > 0 ? cwd : null);
      for (const item of items) {
        if (cwd && seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        sessions.push(item);
      }
    }

    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  }

  async _allProjectDirs() {
    const base = getProjectsDir();
    if (!fs.existsSync(base)) return [];
    try {
      const entries = await fsp.readdir(base, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => path.join(base, e.name));
    } catch {
      return [];
    }
  }

  async _readSessionDir(dir, expectedCwd = null) {
    if (!fs.existsSync(dir)) return [];
    try {
      const files = await fsp.readdir(dir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
      const results = [];

      for (const file of jsonlFiles) {
        const filePath = path.join(dir, file);
        try {
          if (!await hasTranscriptBytes(filePath)) continue;
          if (expectedCwd && !await this._matchesWorkspace(filePath, expectedCwd)) continue;
          const meta = await this._extractSessionMeta(filePath);
          if (meta) results.push(meta);
        } catch { /* skip unreadable */ }
      }

      return results;
    } catch {
      return [];
    }
  }

  /** Verify alternate hashes using the first transcript cwd, not just a shared prefix. */
  async _matchesWorkspace(filePath, cwd) {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry && (entry.type === 'user' || entry.type === 'assistant') && typeof entry.cwd === 'string') {
          return entry.cwd === cwd;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      lines.close();
      input.destroy();
    }
  }

  async _extractSessionMeta(filePath) {
    const sessionId = path.basename(filePath, '.jsonl');
    const stat = await fsp.stat(filePath);
    // Read a larger head because JSONL files often start with system/snapshot
    // entries before the first user message.
    const head = await this._readHead(filePath, 65536);
    const lines = head.split('\n').filter(Boolean);

    let title = null;
    let preview = '';
    let timestamp = stat.mtimeMs;
    let firstTimestamp = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (!preview && entry.type === 'user' && entry.message) {
          const content = entry.message.content;
          if (typeof content === 'string') {
            preview = content.slice(0, 120);
          } else if (Array.isArray(content)) {
            const textBlock = content.find(b => b.type === 'text');
            preview = textBlock ? (textBlock.text || '').slice(0, 120) : '';
          }
        }

        if (entry.type === 'custom-title' || entry.type === 'session-title') {
          title = entry.title || entry.name || null;
        }

        if (entry.type === 'summary' && entry.summary && !title) {
          title = entry.summary;
        }

        if (entry.timestamp && !firstTimestamp) {
          const t = typeof entry.timestamp === 'number'
            ? entry.timestamp
            : new Date(entry.timestamp).getTime();
          if (t && !isNaN(t)) firstTimestamp = t;
        }
      } catch { /* skip bad line */ }
    }

    if (firstTimestamp) timestamp = firstTimestamp;
    const timeLabel = formatRelativeTime(timestamp);

    return {
      id: sessionId,
      title: title || preview.slice(0, 60) || 'Untitled session',
      preview: preview || '',
      timestamp,
      timeLabel,
      filePath,
    };
  }

  /** Resolve the same transcript used by the history view and CLI resume. */
  async resolveSessionPath(sessionId) {
    // History IDs name a single transcript, never a relative or absolute path.
    if (typeof sessionId !== 'string' || !sessionId || /[/\\\0]/.test(sessionId)) {
      return null;
    }

    const cwd = this._cwd;
    const dirs = cwd ? await getProjectDirs(cwd) : await this._allProjectDirs();

    for (const [index, dir] of dirs.entries()) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      if (await hasTranscriptBytes(filePath)) {
        if (cwd && index > 0 && !await this._matchesWorkspace(filePath, cwd)) continue;
        return filePath;
      }
    }
    return null;
  }

  /** Keep UUID resume for exact absolute stores; stabilize all other file targets. */
  async getResumeTarget(sessionId) {
    const filePath = await this.resolveSessionPath(sessionId);
    const exact = this._cwd && path.join(getProjectsDir(), sanitizePath(this._cwd), `${sessionId}.jsonl`);
    return filePath && (filePath !== exact || !path.isAbsolute(filePath))
      ? path.resolve(filePath)
      : sessionId;
  }

  async loadSession(sessionId) {
    const filePath = await this.resolveSessionPath(sessionId);
    return filePath ? this._parseSessionFile(filePath) : null;
  }

  async _parseSessionFile(filePath) {
    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const messages = [];
    const toolResults = new Map();

    // First pass: collect tool results from user messages
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const resultText = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map(b => b.text || '').join('')
                  : '';
              toolResults.set(String(block.tool_use_id), {
                content: resultText.slice(0, 2000),
                isError: block.is_error || false,
              });
            }
          }
        }
      } catch { /* skip */ }
    }

    // Second pass: build messages with tool use details
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message) {
          const c = entry.message.content;
          // Skip tool result messages (they're user messages with tool_result blocks)
          if (Array.isArray(c) && c.length > 0 && c[0].type === 'tool_result') continue;
          const text = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.filter(b => b.type === 'text').map(b => b.text).join('')
              : '';
          if (text) messages.push({ role: 'user', text });
        } else if (entry.type === 'assistant' && entry.message) {
          const c = entry.message.content;
          const text = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.filter(b => b.type === 'text').map(b => b.text).join('')
              : '';
          const toolUses = Array.isArray(c)
            ? c.filter(b => b.type === 'tool_use').map(tu => {
                const result = toolResults.get(String(tu.id));
                return {
                  id: tu.id,
                  name: tu.name,
                  input: tu.input || null,
                  status: result ? (result.isError ? 'error' : 'complete') : 'complete',
                  result: result ? result.content : null,
                  isError: result ? result.isError : false,
                };
              })
            : [];
          messages.push({ role: 'assistant', text, toolUses });
        }
      } catch { /* skip */ }
    }

    return messages;
  }

  async _readHead(filePath, bytes) {
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fd.read(buf, 0, bytes, 0);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally {
      await fd.close();
    }
  }
}

function formatRelativeTime(ts) {
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString();
}

module.exports = { SessionManager };
