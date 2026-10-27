const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderChatHtml } = require('./chatRenderer');

test('New Chat during streaming enables sending the next prompt', () => {
  // Execute the production webview script against the DOM operations used here.
  const element = () => {
    const classes = new Set();
    return {
      style: {}, listeners: {}, value: '', scrollHeight: 20,
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      appendChild() {},
    };
  };
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const sent = [];
  let receive;
  const html = renderChatHtml({ nonce: 'test', platform: 'linux' });
  const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    document: { getElementById: getElement, createElement: element, addEventListener() {} },
    window: { addEventListener(_name, listener) { receive = listener; } },
    acquireVsCodeApi: () => ({ postMessage: message => sent.push(message), getState: () => null }),
    requestAnimationFrame: callback => callback(),
  });
  getElement('chatInput').value = 'old prompt';
  getElement('sendBtn').listeners.click();
  assert.equal(getElement('sendBtn').disabled, true);
  getElement('newChatBtn').listeners.click();
  assert.equal(sent.at(-1).type, 'new_session');
  receive({ data: { type: 'session_cleared', resetStreaming: true } });
  assert.equal(getElement('sendBtn').disabled, false);
  assert.equal(getElement('abortBtn').style.display, 'none');
  assert.equal(getElement('statusText').textContent, 'Ready');
  getElement('chatInput').value = 'fresh prompt';
  getElement('sendBtn').listeners.click();
  assert.equal(sent.at(-1).type, 'send_message');
  assert.equal(sent.at(-1).text, 'fresh prompt');
  assert.equal(getElement('sendBtn').disabled, true);
});
