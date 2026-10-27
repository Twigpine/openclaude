import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('deep search sends session content to the model without copying it into debug logs', () => {
  // Isolate module mocks from the shared test process.
  const child = Bun.spawnSync([process.execPath, '--eval', `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const debug = []
    let prompt = ''
    mock.module('./debug.js', () => ({ logForDebugging: text => debug.push(text) }))
    mock.module('./log.js', () => ({ getLogDisplayTitle: log => log.firstPrompt, logError() {} }))
    mock.module('./model/model.js', () => ({ getSmallFastModel: () => 'configured-test-model' }))
    mock.module('./sessionStorage.js', () => ({ isLiteLog: () => false, loadFullLog() { throw new Error('unexpected load') } }))
    mock.module('./sideQuery.js', () => ({ sideQuery: async options => {
      prompt = options.messages[0].content
      return { content: [{ type: 'text', text: 'private-response {"relevant_indices":[0]}' }] }
    } }))
    const { agenticSessionSearch } = await import('./agenticSessionSearch.ts')
    const log = {
      firstPrompt: 'private-first-message',
      messages: [{ type: 'user', message: { content: 'private-transcript' } }],
    }
    const result = await agenticSessionSearch('private-query', [log])
    assert.equal(result[0], log)
    for (const text of ['private-query', 'private-first-message', 'private-transcript']) {
      assert.ok(prompt.includes(text), 'search input must retain ' + text)
    }
    assert.ok(debug.length > 0, 'diagnostics remain available')
    for (const text of ['private-query', 'private-first-message', 'private-transcript', 'private-response']) {
      assert.ok(!debug.join('\\n').includes(text), 'debug output exposed ' + text)
    }
  `], { cwd: fileURLToPath(new URL('./', import.meta.url)), timeout: 10_000 })
  expect(child.stderr.toString()).toBe('')
  expect(child.exitCode).toBe(0)
}, 15_000)
