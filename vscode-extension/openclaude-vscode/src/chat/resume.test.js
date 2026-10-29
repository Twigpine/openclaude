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
      constructor() {
        this.emitter = new EventEmitter();
        this.event = listener => {
          this.emitter.on('event', listener);
          return { dispose: () => this.emitter.off('event', listener) };
        };
      }
      fire(value) { this.emitter.emit('event', value); }
      dispose() { this.emitter.removeAllListeners(); }
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
        child.kill = signal => { child.killed = true; child.killSignal = signal; };
        children.push(child);
        return child;
      } };
      return originalLoad.call(this, name, ...rest);
    };
    const { SessionManager } = require('./sessionManager');
    const { ChatController, OpenClaudeChatViewProvider, OpenClaudeChatPanelManager } = require('./chatProvider');
    const { ProcessManager } = require('./processManager');
    const { renderChatHtml } = require('./chatRenderer');
    const vm = require('node:vm');
    (async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-resume-'));
      const controller = new ChatController(new SessionManager());
      try {
        cwd = path.join(root, 'a'.repeat(100), 'b'.repeat(100));
        // The host resolves this root here; the CLI starts from the workspace.
        process.chdir(root);
        process.env.OPENCLAUDE_CONFIG_DIR = 'config with spaces & %PATH% !';
        const id = '38f67e50-946e-4d74-b0b6-c19759b99623';
        const prefix = cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
        const file = path.join(root, process.env.OPENCLAUDE_CONFIG_DIR, 'projects', prefix + '-alternate', id + '.jsonl');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ type: 'user', cwd, message: { content: 'saved prompt' } }) + '\n');
        const manager = controller.sessionManager;
        manager.setCwd(cwd);
        const [selected] = await manager.listSessions();
        assert.equal(selected.id, id);
        await controller.startSession({ sessionId: selected.id });
        assert.equal(controller.sessionId, id);
        const resumeValue = () => calls.at(-1).args[calls.at(-1).args.indexOf('--resume') + 1];
        assert.equal(calls.at(-1).options.cwd, cwd);
        assert.equal(path.resolve(calls.at(-1).options.cwd, resumeValue()), file,
          'the CLI must resolve the selected transcript from its own cwd');
        assert.equal(resumeValue(), file);
        children.at(-1).emit('close', 0);
        controller._doSend = async () => {}; // Only inspect the restart launch, no model traffic.
        await controller.sendMessage('continue');
        assert.equal(resumeValue(), file);
        assert.equal(controller.sessionId, id);
        controller.stopSession();

        // Both UI entry points must reset identity/history, not reconnect it.
        const fresh = new ChatController(manager);
        try {
          for (const Provider of [OpenClaudeChatViewProvider, OpenClaudeChatPanelManager]) {
            await fresh.startSession({ sessionId: id });
            children.at(-1).stdout.write(JSON.stringify({ type: 'system', session_id: id }) + '\n');
            let receive;
            const updates = [];
            const elements = new Map();
            const element = () => ({ style: {}, value: '', scrollHeight: 20, listeners: {},
              classList: { toggle() {} }, appendChild() {},
              addEventListener(name, listener) { this.listeners[name] = listener; } });
            const getElement = name => {
              if (!elements.has(name)) elements.set(name, element());
              return elements.get(name);
            };
            let receiveInRenderer;
            let lastAction;
            const rendererSends = [];
            const webview = {
              onDidReceiveMessage: handler => { receive = handler; },
              postMessage: message => {
                updates.push(message);
                receiveInRenderer?.({ data: message });
              },
            };
            const html = renderChatHtml({ nonce: 'test', platform: 'linux' });
            vm.runInNewContext(html.match(/<script nonce="test">([\s\S]*?)<\/script>/)[1], {
              document: { getElementById: getElement, createElement: element, addEventListener() {} },
              window: { addEventListener(_name, listener) { receiveInRenderer = listener; } },
              acquireVsCodeApi: () => ({ getState: () => null, postMessage: message => {
                if (message.type === 'send_message') rendererSends.push(message.text);
                lastAction = receive?.(message);
              } }),
              requestAnimationFrame: callback => callback(),
            });
            const submitPrompt = text => {
              getElement('chatInput').value = text;
              getElement('sendBtn').listeners.click();
              return lastAction;
            };
            const otherUpdates = [];
            const registrations = [fresh.registerWebview(webview),
              fresh.registerWebview({ postMessage: message => otherUpdates.push(message) })];
            new Provider(fresh)._attachMessageHandler(webview);
            const oldChild = children.at(-1);
            const oldDelivery = new Promise(resolve => oldChild.stdin.once('data', resolve));
            await submitPrompt('old prompt');
            await oldDelivery;
            const loadForResume = manager.loadSession;
            let releaseResume;
            manager.loadSession = () => new Promise(resolve => { releaseResume = resolve; });
            try {
              const selectedId = '48f67e50-946e-4d74-b0b6-c19759b99623';
              const loading = receive({ type: 'resume_session', sessionId: selectedId });
              assert.deepEqual(fresh.getMessages(), [], 'pending resume must not retain old controller history');
              assert.equal(otherUpdates.at(-1).type, 'session_cleared', 'resume clears every registered view');
              const launchCount = calls.length;
              const sendCount = rendererSends.length;
              await submitPrompt('must not reach the previous session');
              assert.equal(rendererSends.length, sendCount);
              assert.equal(calls.length, launchCount);
              assert.equal(oldChild.stdin.read(), null);
              releaseResume([{ role: 'user', text: 'selected transcript' }]);
              await loading;
              assert.equal(fresh.sessionId, selectedId);
              assert.equal(resumeValue(), selectedId);
              const selectedChild = children.at(-1);
              selectedChild.stdout.write(JSON.stringify({ type: 'system', session_id: selectedId }) + '\n');
              const selectedDelivery = new Promise(resolve => selectedChild.stdin.once('data', resolve));
              await submitPrompt('continue selected session');
              assert.ok((await selectedDelivery).toString().includes('continue selected session'));
            } finally {
              manager.loadSession = loadForResume;
            }
            await receive({ type: 'new_session' });
            assert.equal(fresh.sessionId, null);
            assert.deepEqual(fresh.getMessages(), []);
            assert.ok(updates.some(message => message.type === 'session_cleared' && message.resetStreaming));
            assert.ok(otherUpdates.some(message => message.type === 'session_cleared' && message.resetStreaming));
            updates.length = 0;
            await receive({ type: 'restore_request' });
            assert.ok(!updates.some(message => message.type === 'restore_messages'));
            const next = submitPrompt('fresh prompt');
            const child = children.at(-1);
            const freshDelivery = new Promise(resolve => child.stdin.once('data', resolve));
            assert.ok(!calls.at(-1).args.includes('--resume'));
            child.stdout.write(JSON.stringify({ type: 'system', session_id: 'new-id' }) + '\n');
            await next;
            const deliveredPrompt = await freshDelivery;
            assert.equal(fresh.sessionId, 'new-id');
            assert.deepEqual(fresh.getMessages(), [{ role: 'user', text: 'fresh prompt' }]);
            assert.ok(deliveredPrompt.toString().includes('fresh prompt'));
            fresh.stopSession();
            const loadSession = manager.loadSession;
            let finishLoad;
            manager.loadSession = () => new Promise(resolve => { finishLoad = resolve; });
            try {
              const resume = receive({ type: 'resume_session', sessionId: id });
              await receive({ type: 'new_session' });
              const count = calls.length;
              finishLoad([{ role: 'user', text: 'late old history' }]);
              await resume;
              assert.equal(calls.length, count);
              assert.equal(fresh.sessionId, null);
              assert.deepEqual(fresh.getMessages(), []);
              assert.ok(!updates.some(message => message.type === 'restore_messages'));

              // Newer selections win in both views, even across a shared controller.
              for (const OtherProvider of [OpenClaudeChatViewProvider, OpenClaudeChatPanelManager]) {
                for (const olderFinishesFirst of [true, false]) {
                  let receiveOther;
                  const newerUpdates = [];
                  new OtherProvider(fresh)._attachMessageHandler({
                    onDidReceiveMessage: handler => { receiveOther = handler; },
                    postMessage: message => newerUpdates.push(message),
                  });
                  updates.length = 0;
                  const older = receive({ type: 'resume_session', sessionId: id });
                  const finishOlder = finishLoad;
                  const newerId = 'newer-session';
                  const newer = receiveOther({ type: 'resume_session', sessionId: newerId });
                  const finishNewer = finishLoad;
                  const before = calls.length;
                  if (olderFinishesFirst) {
                    finishOlder([{ role: 'user', text: 'stale history' }]);
                    await older;
                    assert.equal(calls.length, before, 'stale selection cannot launch while newer load is pending');
                  }
                  finishNewer([{ role: 'user', text: 'newer history' }]);
                  await newer;
                  if (!olderFinishesFirst) {
                    finishOlder([{ role: 'user', text: 'stale history' }]);
                    await older;
                  }
                  assert.equal(calls.length, before + 1, 'only the newest selection launches');
                  assert.equal(resumeValue(), newerId);
                  assert.equal(fresh.sessionId, newerId);
                  assert.deepEqual(fresh.getMessages(), [{ role: 'user', text: 'newer history' }]);
                  assert.ok(newerUpdates.some(message => message.type === 'restore_messages' &&
                    message.messages.some(item => item.text === 'newer history')));
                  assert.ok(![...updates, ...newerUpdates].some(message => message.type === 'restore_messages' &&
                    message.messages.some(item => item.text === 'stale history')));
                  fresh.stopSession();
                }
              }

              fresh.resetForNewSession();
              // An ordinary send must not cancel the selected history load.
              const ordinaryResume = receive({ type: 'resume_session', sessionId: id });
              const ordinarySend = fresh.sendMessage('sent while loading');
              await new Promise(setImmediate);
              children.at(-1).stdout.write(JSON.stringify({ type: 'system', session_id: 'interim-id' }) + '\n');
              await ordinarySend;
              finishLoad([{ role: 'user', text: 'selected history' }]);
              await ordinaryResume;
              assert.equal(fresh.sessionId, id);
              assert.deepEqual(fresh.getMessages(), [{ role: 'user', text: 'selected history' }]);
              assert.equal(resumeValue(), file);
              fresh.stopSession();
            } finally {
              manager.loadSession = loadSession;
              registrations.forEach(registration => registration.dispose());
            }
          }
          // An old send waiting for CLI readiness must not enter the new chat.
          await fresh.startSession({ sessionId: id });
          const releaseOldReady = fresh._readyResolve;
          const oldSend = fresh.sendMessage('stale pending prompt');
          await new Promise(setImmediate);
          fresh.resetForNewSession();
          const newSend = fresh.sendMessage('new pending prompt');
          await new Promise(setImmediate);
          const newReady = fresh._readyPromise;
          releaseOldReady();
          await oldSend;
          assert.equal(fresh._readyPromise, newReady);
          assert.deepEqual(fresh.getMessages(), []);
          children.at(-1).stdout.write(JSON.stringify({ type: 'system', session_id: 'fresh-id' }) + '\n');
          await newSend;
          assert.deepEqual(fresh.getMessages(), [{ role: 'user', text: 'new pending prompt' }]);
        } finally {
          fresh.stopSession();
        }

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

        // Stop/Abort Generation must cancel a reconnect before it has a child.
        // Hold the real resolver's directory read so the user action arrives
        // during discovery, without replacing the controller's send method.
        delete manager.getResumeTarget;
        const aborting = new ChatController(manager);
        const updates = [];
        const states = [];
        aborting.registerWebview({ postMessage: message => updates.push(message) });
        aborting.onDidChangeState(state => states.push(state));
        const realReaddir = fs.readdir;
        let releaseRead;
        const lookupStarted = new Promise(resolve => {
          fs.readdir = async (directory, ...args) => {
            if (directory === path.join(process.env.OPENCLAUDE_CONFIG_DIR, 'projects') && !releaseRead) {
              await new Promise(release => { releaseRead = release; resolve(); });
            }
            return realReaddir(directory, ...args);
          };
        });
        try {
          // The saved session has already exited; sending now reconnects.
          aborting._currentSessionId = id;
          const cancelledOne = aborting.sendMessage('abort one');
          const cancelledTwo = aborting.sendMessage('abort two');
          await lookupStarted;
          const beforeAbort = calls.length;
          aborting.abort();
          releaseRead();
          await new Promise(setImmediate);
          // If broken startup launches a child, let its real send path settle
          // so the no-launch assertion, rather than a timeout, catches it.
          if (calls.length > beforeAbort) children.at(-1).stdout.write('{"type":"system"}\n');
          await Promise.all([cancelledOne, cancelledTwo]);
          assert.equal(calls.length, beforeAbort, 'Abort must not launch the pending reconnect');
          assert.ok(updates.some(message => message.type === 'stream_end' && message.final));
          assert.equal(states.at(-1), 'idle');
        } finally {
          releaseRead?.();
          fs.readdir = realReaddir;
          aborting.stopSession();
        }
        // Cancelling discovery must leave ordinary running-process SIGINT intact.
        await aborting.startSession({ sessionId: id });
        const activeChild = children.at(-1);
        aborting.abort();
        assert.equal(activeChild.killSignal, 'SIGINT');
        aborting.stopSession();

        // An exact copy under a relative root also needs a stable file target.
        delete manager.getResumeTarget;
        let hash = 0;
        for (const char of cwd) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
        const exact = path.join(root, process.env.OPENCLAUDE_CONFIG_DIR, 'projects', prefix + '-' + Math.abs(hash).toString(36), id + '.jsonl');
        await fs.mkdir(path.dirname(exact), { recursive: true });
        await fs.copyFile(file, exact);
        await controller.startSession({ sessionId: id });
        assert.equal(resumeValue(), exact,
          'relative config roots must preserve exact-copy identity across cwd changes');

        // With an absolute root, the exact Node copy retains UUID resume.
        process.env.OPENCLAUDE_CONFIG_DIR = path.resolve(process.env.OPENCLAUDE_CONFIG_DIR);
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
        assert.ok(win.args[5].includes('"--resume" "C:'));
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
