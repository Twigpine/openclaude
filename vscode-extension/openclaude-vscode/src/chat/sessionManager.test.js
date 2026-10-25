const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spyOn } = require('bun:test');
const { acquireEnvMutex, releaseEnvMutex } = require('../../../../src/entrypoints/sdk/shared.js');
const { resolveClaudeConfigHomeDir } = require('../../../../src/utils/envUtils.js');
const { sanitizePath } = require('../../../../src/utils/sessionStoragePortable.js');
const { SessionManager } = require('./sessionManager');

let root;
let home;
let homedirSpy;
let savedEnv;
const sessionId = '38f67e50-946e-4d74-b0b6-c19759b99623';

test.beforeEach(async () => {
  const result = await acquireEnvMutex();
  assert.ok(result.acquired);
  savedEnv = {
    OPENCLAUDE_CONFIG_DIR: process.env.OPENCLAUDE_CONFIG_DIR,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-sessions-'));
  home = path.join(root, 'home');
  homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);
  delete process.env.OPENCLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

test.afterEach(async () => {
  try {
    homedirSpy?.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  } finally {
    releaseEnvMutex();
  }
});

async function writeSession(configDir, cwd, text) {
  // Use the CLI's production path rules rather than the extension's helper.
  const directory = path.join(configDir, 'projects', sanitizePath(cwd));
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  await fs.writeFile(filePath, JSON.stringify({
    type: 'user', message: { role: 'user', content: text },
  }) + '\n');
  return filePath;
}

test('list and load use the CLI config override and ignore Claude Code history', async () => {
  const cwd = '/workspace/demo';
  process.env.OPENCLAUDE_CONFIG_DIR = path.join(root, 'cafe\u0301');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-code');
  const configDir = resolveClaudeConfigHomeDir({
    configDirEnv: process.env.OPENCLAUDE_CONFIG_DIR,
  });
  const expectedPath = await writeSession(configDir, cwd, 'OpenClaude session');
  await writeSession(process.env.CLAUDE_CONFIG_DIR, cwd, 'Unrelated session');
  const manager = new SessionManager();
  manager.setCwd(cwd);
  const sessions = await manager.listSessions();
  assert.deepEqual(sessions.map(s => s.filePath), [expectedPath]);
  assert.deepEqual(await manager.loadSession(sessionId), [{ role: 'user', text: 'OpenClaude session' }]);
  manager.setCwd(null);
  assert.deepEqual((await manager.listSessions()).map(s => s.filePath), [expectedPath]);
});

test('default discovery never falls back to an existing Claude Code directory', async () => {
  const cwd = '/workspace/demo';
  await writeSession(path.join(home, '.claude'), cwd, 'Unrelated session');
  const manager = new SessionManager();
  manager.setCwd(cwd);
  assert.deepEqual(await manager.listSessions(), []);
  assert.equal(await manager.loadSession(sessionId), null);
  const expectedPath = await writeSession(resolveClaudeConfigHomeDir({ homeDir: home }), cwd, 'Default session');
  assert.deepEqual((await manager.listSessions()).map(s => s.filePath), [expectedPath]);
  assert.deepEqual(await manager.loadSession(sessionId), [{ role: 'user', text: 'Default session' }]);
});

test('list and load match CLI project directories at truncation boundaries', async () => {
  const configDir = resolveClaudeConfigHomeDir({ homeDir: home });
  for (const length of [80, 81, 200, 201]) {
    const cwd = '/' + 'p'.repeat(length - 1);
    const expectedPath = await writeSession(configDir, cwd, `Session ${length}`);
    const manager = new SessionManager();
    manager.setCwd(cwd);
    assert.deepEqual((await manager.listSessions()).map(s => s.filePath), [expectedPath], `path length ${length}`);
    assert.deepEqual(await manager.loadSession(sessionId), [{ role: 'user', text: `Session ${length}` }]);
  }
});
