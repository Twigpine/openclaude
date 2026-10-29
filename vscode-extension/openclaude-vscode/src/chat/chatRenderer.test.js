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

test('assistant Markdown links allow safe schemes without injecting attributes or markup', () => {
  const created = [];
  const element = () => {
    const el = {
      style: {}, value: '', textContent: '', scrollHeight: 20,
      classList: { toggle() {} }, addEventListener() {}, appendChild() {},
    };
    created.push(el);
    return el;
  };
  const elements = new Map();
  let receive;
  const script = renderChatHtml({ nonce: 'test', platform: 'linux' })
    .match(/<script nonce="test">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }, createElement: element, addEventListener() {} },
    window: { addEventListener(_name, listener) { receive = listener; } },
    acquireVsCodeApi: () => ({ postMessage() {}, getState: () => null }),
    requestAnimationFrame: callback => callback(),
  });
  const render = text => {
    receive({ data: { type: 'stream_delta', text } });
    return created.find(el => el.className === 'md-content').innerHTML;
  };
  for (const href of ['https://example.com/?a=1&b=2', 'http://example.com', 'mailto:test@example.com', 'HTTPS://example.com']) {
    assert.match(render('[safe](' + href + ')'), /<a href="[^\"]+" title="[^\"]+">safe<\/a>/);
  }
  for (const href of ['javascript:alert', 'JaVaScRiPt:alert', 'data:text/html,test', 'command:workbench.action', '//example.com', 'file:///tmp/test', 'java\nscript:alert', 'javascript&#58;alert']) {
    const html = render('[unsafe](' + href + ')');
    assert.ok(!html.includes('<a '), href);
    assert.ok(html.includes('unsafe'), href);
  }
  const injected = render('[safe](https://example.com/" onmouseover="alert)');
  assert.match(injected, /href="https:\/\/example.com\/&quot; onmouseover=&quot;alert"/);
  assert.ok(!injected.includes('" onmouseover="'));
  const formatted = render('[**safe**](https://example.com/?a=1&b=2)');
  assert.ok(formatted.includes('<strong>safe</strong>'));
  assert.ok(formatted.includes('href="https://example.com/?a=1&amp;b=2"'));
});


test('tool file links escape attribute delimiters on initial render and input updates', () => {
  const created = [];
  const inserted = [];
  const element = () => {
    const children = new Map();
    const el = {
      style: {}, value: '', textContent: '', scrollHeight: 20, dataset: {},
      classList: { toggle() {}, add() {} }, addEventListener() {}, appendChild() {},
      querySelector(selector) {
        if (selector === '.tool-path' || selector === '[data-tool-output]') return null;
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
      insertAdjacentHTML(_position, html) { inserted.push(html); },
    };
    created.push(el);
    return el;
  };
  const elements = new Map();
  let receive;
  const script = renderChatHtml({ nonce: 'test', platform: 'linux' })
    .match(/<script nonce="test">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element, addEventListener() {},
      querySelector: () => created.find(el => el.dataset.toolId === 'file-tool'),
    },
    window: { addEventListener(_name, listener) { receive = listener; } },
    acquireVsCodeApi: () => ({ postMessage() {}, getState: () => null }),
    requestAnimationFrame: callback => callback(),
  });
  const filePath = '/tmp/a" onclick="bad & <tag> \' name.txt';
  const escaped = '/tmp/a&quot; onclick=&quot;bad &amp; &lt;tag&gt; &#39; name.txt';
  receive({ data: { type: 'tool_use', toolUse: {
    id: 'file-tool', name: 'Read', input: { file_path: filePath }, inputPreview: filePath,
  } } });
  const card = created.find(el => el.dataset.toolId === 'file-tool');
  const checkLinks = (html, count) => {
    const paths = [...html.matchAll(/data-filepath="([^"]*)"/g)].map(match => match[1]);
    assert.deepEqual(paths, Array(count).fill(escaped));
    assert.ok(!/<a\b[^>]*" onclick="/.test(html));
    assert.ok(!html.includes('<tag>'));
  };
  checkLinks(card.innerHTML, 2);
  receive({ data: { type: 'tool_input_ready', toolUseId: 'file-tool', input: { path: filePath }, name: 'Read' } });
  checkLinks(inserted.at(-1), 1);
  checkLinks(card.querySelector('.tool-body').innerHTML, 1);
});
