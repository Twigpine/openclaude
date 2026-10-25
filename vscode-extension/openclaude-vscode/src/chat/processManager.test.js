const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const managerPath = require.resolve('./processManager');
const nodeExecutable = process.versions.bun ? 'node' : process.execPath;

// Isolate the VS Code host stub and platform override from other test files.
const hostStub = `
  const Module = require('node:module');
  const { EventEmitter } = require('node:events');
  const load = Module._load;
  class HostEvent {
    constructor() { this.emitter = new EventEmitter(); }
    event = listener => { this.emitter.on('event', listener); return { dispose() {} }; };
    fire(value) { this.emitter.emit('event', value); }
    dispose() { this.emitter.removeAllListeners(); }
  }
  Module._load = function(id, ...rest) {
    if (id === 'vscode') return { EventEmitter: HostEvent };
    return load.call(this, id, ...rest);
  };
`;

function run(script) {
  return JSON.parse(execFileSync(nodeExecutable, ['-e', hostStub + script], {
    encoding: 'utf8', timeout: 15000,
  }));
}

test('Windows launch preserves shell quoting through the production manager', () => {
  const result = run(`
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const cp = require('node:child_process');
    let launch;
    cp.spawn = (...args) => {
      launch = args;
      const child = new EventEmitter();
      child.stdout = child.stderr = { setEncoding() {}, on() {} };
      return child;
    };
    const { ProcessManager } = require(${JSON.stringify(managerPath)});
    new ProcessManager({
      command: 'openclaude',
      model: 'model"&echo INJECTED',
      sessionId: '%SESSION%',
      extraArgs: ['', 'tail\\\\', '!literal!'],
    }).start();
    console.log(JSON.stringify(launch));
  `);
  assert.equal(path.basename(result[0]).toLowerCase(), 'cmd.exe');
  assert.deepEqual(result[1].slice(0, 5), ['/d', '/e:on', '/v:off', '/s', '/c']);
  assert.equal(result[2].windowsVerbatimArguments, true);
  assert.notEqual(result[2].shell, true);
  assert.ok(result[1][5].includes('"model""&echo INJECTED"'));
  assert.ok(result[1][5].includes('"%%cd:~,%SESSION%%cd:~,%"'));
});

test('Windows CR/LF arguments are rejected before any process is started', () => {
  const result = run(`
    Object.defineProperty(process, 'platform', { value: 'win32' });
    require('node:child_process').spawn = () => { throw Error('spawn was reached'); };
    const { ProcessManager } = require(${JSON.stringify(managerPath)});
    const errors = ['bad\\nvalue', 'bad\\rvalue'].map(value => {
      try { new ProcessManager({ command: 'openclaude', extraArgs: [value] }).start(); }
      catch (error) { return error.message; }
    });
    console.log(JSON.stringify(errors));
  `);
  for (const error of result) assert.match(error, /line break/i);
});

test('real launcher preserves argv and NDJSON through executable and Windows npm-style shims', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaude launcher '));
  try {
    const cli = path.join(dir, 'cli.cjs');
    fs.writeFileSync(cli, `#!/usr/bin/env node
      console.log(JSON.stringify({ type: 'system', argv: process.argv.slice(2) }));
      const timer = setTimeout(() => process.exit(2), 5000);
      process.stdin.once('data', chunk => {
        console.log(JSON.stringify({ type: 'result', received: JSON.parse(chunk.toString()) }));
        clearTimeout(timer);
        process.exit(0);
      });
    `);
    fs.chmodSync(cli, 0o755);
    const commands = [{ command: cli, env: {} }];
    if (process.platform === 'win32') {
      commands[0].command = '"' + process.execPath + '" "' + cli + '"';
      // Match npm's generated shim: setlocal, quoted node/script, then raw %*.
      // Exercise global and local .bin locations; neither may need a different escape count.
      for (const subdir of ['npm global', 'node_modules/.bin']) {
        const folder = path.join(dir, subdir);
        fs.mkdirSync(folder, { recursive: true });
        const shim = path.join(folder, 'openclaude.cmd');
        fs.writeFileSync(shim, `@ECHO off\r\nSETLOCAL\r\n"${process.execPath}" "${cli}" %*\r\n`);
        commands.push({ command: '"' + shim + '"', env: {} });
        if (subdir === 'npm global') {
          const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
          commands.push({ command: 'openclaude', env: { [pathKey]: folder + path.delimiter + process.env[pathKey] } });
        }
      }
    }
    const values = ['model"&echo INJECTED>injected.txt', '%OPENCLAUDE_TEST_VALUE%', '!OPENCLAUDE_TEST_VALUE!', '', 'trailing\\', 'space & | < > ( ) ^', 'quote\\\"tail'];
    for (const { command, env } of commands) {
      const result = run(`
        const { ProcessManager } = require(${JSON.stringify(managerPath)});
        const pm = new ProcessManager({
          command: ${JSON.stringify(command)}, cwd: ${JSON.stringify(dir)},
          env: { ...${JSON.stringify(env)}, OPENCLAUDE_TEST_VALUE: 'EXPANDED' },
          model: ${JSON.stringify(values[0])}, sessionId: ${JSON.stringify(values[1])},
          extraArgs: ${JSON.stringify(values.slice(2))},
        });
        const messages = [];
        pm.onMessage(message => {
          messages.push(message);
          if (message.type === 'system') pm.sendUserMessage('literal & message');
        });
        pm.onError(error => { console.error(error); process.exitCode = 1; });
        pm.onExit(({ code }) => {
          pm.dispose();
          console.log(JSON.stringify({ code, messages }));
        });
        pm.start();
      `);
      assert.equal(result.code, 0);
      assert.deepEqual(result.messages[0].argv, [
        '--print', '--verbose', '--input-format=stream-json', '--output-format=stream-json',
        '--include-partial-messages', '--permission-mode', 'acceptEdits',
        '--resume', values[1], '--model', values[0], ...values.slice(2),
      ]);
      assert.equal(result.messages[1].received.message.content, 'literal & message');
      assert.equal(fs.existsSync(path.join(dir, 'injected.txt')), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
