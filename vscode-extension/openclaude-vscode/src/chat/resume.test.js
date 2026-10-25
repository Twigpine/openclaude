const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Isolate VS Code/process doubles from Bun's shared module cache. The controller,
// resolver, and argument builder below are the production CommonJS modules.
// Leave five seconds beyond the child deadline for assertions and cleanup.
test('resume hands the selected transcript to the CLI, including reconnect and Windows paths', { timeout: 20000 }, () => {
  const result = spawnSync('node', ['-e', String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const os = require('node:os');
    const Module = require('node:module');
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const calls = [];
    const children = [];
    class Emitter {
      constructor() { this.event = () => ({ dispose() {} }); }
      fire() {}
      dispose() {}
    }
    let cwd;
    const originalLoad = Module._load;
    Module._load = function(name, ...rest) {
      if (name === 'vscode') return {
        EventEmitter: Emitter,
        workspace: {
          get workspaceFolders() { return [{ uri: { fsPath: cwd } }]; },
          getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        },
      };
      if (name === 'child_process') return { spawn(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => { child.killed = true; };
        children.push(child);
        return child;
      } };
      return originalLoad.call(this, name, ...rest);
    };
    const { SessionManager } = require('./sessionManager');
    const { ChatController } = require('./chatProvider');
    const { ProcessManager } = require('./processManager');
    (async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-resume-'));
      const controller = new ChatController(new SessionManager());
      try {
        cwd = path.join(root, 'a'.repeat(100), 'b'.repeat(100));
        process.env.OPENCLAUDE_CONFIG_DIR = path.join(root, 'config with spaces & %PATH% !');
        const id = '38f67e50-946e-4d74-b0b6-c19759b99623';
        const prefix = cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
        const file = path.join(process.env.OPENCLAUDE_CONFIG_DIR, 'projects', prefix + '-alternate', id + '.jsonl');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ type: 'user', cwd, message: { content: 'saved prompt' } }) + '\n');
        const manager = controller.sessionManager;
        manager.setCwd(cwd);
        const [selected] = await manager.listSessions();
        assert.equal(selected.id, id);
        await controller.startSession({ sessionId: selected.id });
        assert.equal(controller.sessionId, id);
        const resumeValue = () => calls.at(-1).args[calls.at(-1).args.indexOf('--resume') + 1];
        assert.equal(resumeValue(), file);
        assert.equal(calls.at(-1).options.cwd, cwd);
        children.at(-1).emit('close', 0);
        controller._doSend = async () => {}; // Only inspect the restart launch, no model traffic.
        await controller.sendMessage('continue');
        assert.equal(resumeValue(), file);
        assert.equal(controller.sessionId, id);
        controller.stopSession();

        // A stop during the new asynchronous lookup must not spawn an orphan.
        let finish;
        manager.getResumeTarget = () => new Promise(resolve => { finish = resolve; });
        const pending = controller.startSession({ sessionId: id });
        controller.stopSession();
        const count = calls.length;
        finish(file);
        await pending;
        assert.equal(calls.length, count);

        // Two sends share the pending restart and both reach the new process.
        const sent = [];
        controller._doSend = async text => {
          assert.ok(controller._process?.running);
          sent.push(text);
        };
        const one = controller.sendMessage('one');
        const two = controller.sendMessage('two');
        const before = calls.length;
        finish(file);
        await Promise.all([one, two]);
        assert.equal(calls.length, before + 1);
        assert.deepEqual(sent, ['one', 'two']);
        controller.stopSession();

        const stoppedOne = controller.sendMessage('cancel one');
        const stoppedTwo = controller.sendMessage('cancel two');
        controller.stopSession();
        const stoppedCount = calls.length;
        finish(file);
        await Promise.all([stoppedOne, stoppedTwo]);
        assert.equal(calls.length, stoppedCount);
        assert.deepEqual(sent, ['one', 'two']);

        // The exact Node copy remains the normal UUID route.
        delete manager.getResumeTarget;
        let hash = 0;
        for (const char of cwd) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
        const exact = path.join(process.env.OPENCLAUDE_CONFIG_DIR, 'projects', prefix + '-' + Math.abs(hash).toString(36), id + '.jsonl');
        await fs.mkdir(path.dirname(exact), { recursive: true });
        await fs.copyFile(file, exact);
        await controller.startSession({ sessionId: id });
        assert.equal(resumeValue(), id);
        assert.equal(await manager.getResumeTarget('missing'), 'missing');
        await controller.startSession();
        assert.ok(!calls.at(-1).args.includes('--resume'));
        controller.stopSession();

        Object.defineProperty(process, 'platform', { value: 'win32' });
        const winPath = 'C:\\config with spaces & %PATH% !\\' + id + '.jsonl';
        const pm = new ProcessManager({ command: 'openclaude', sessionId: id, resumeTarget: winPath });
        pm.start();
        const win = calls.at(-1);
        assert.equal(win.options.env.OPENCLAUDE_VSCODE_RESUME_PATH, undefined);
        assert.notEqual(win.options.shell, true);
        assert.equal(win.options.windowsVerbatimArguments, true);
        assert.deepEqual(win.args.slice(0, 5), ['/d', '/e:on', '/v:off', '/s', '/c']);
        assert.ok(win.args[5].includes('--resume "C:'));
        assert.ok(!win.args[5].includes('OPENCLAUDE_VSCODE_RESUME_PATH'));
        assert.equal(pm.sessionId, id);
        pm.dispose();
      } finally {
        controller.stopSession();
        await fs.rm(root, { recursive: true, force: true });
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: __dirname, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
