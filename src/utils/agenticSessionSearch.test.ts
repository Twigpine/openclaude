import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test.each(['indices', 'diagnostics'] as const)('deep search validates %s at the model boundary', mode => {
  // Isolate module mocks from the shared test process.
  const child = Bun.spawnSync([process.execPath, '--feature=SLOW_OPERATION_LOGGING', '--eval', `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const debug = [], errors = [], slow = []
    process.env.CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS = '0'
    let clock = 0
    Object.defineProperty(performance, 'now', { value: () => clock += 10 })
    mock.module('../bootstrap/state.js', () => ({ addSlowOperation: text => slow.push(text) }))
    let responseText = 'private-response {"relevant_indices":[0]}'
    let providerFails = false
    let lite = false
    let prompt = ''
    mock.module('./debug.js', () => ({ logForDebugging: text => debug.push(text) }))
    mock.module('./log.js', () => ({ getLogDisplayTitle: log => log.firstPrompt, logError: error => errors.push(String(error)) }))
    mock.module('./model/model.js', () => ({ getSmallFastModel: () => 'configured-test-model' }))
    mock.module('./sessionStorage.js', () => ({ isLiteLog: () => lite, loadFullLog() { throw new Error('private-transcript') } }))
    mock.module('./sideQuery.js', () => ({ sideQuery: async options => {
      prompt = options.messages[0].content
      if (providerFails) throw new Error('private-response')
      return { content: [{ type: 'text', text: responseText }] }
    } }))
    const { jsonParse } = await import('./slowOperations.ts')
    jsonParse('{}')
    assert.ok(slow.length > 0 && debug.length > 0, 'slow-operation logging is active')
    debug.length = slow.length = 0
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
    if (${JSON.stringify(mode)} === 'indices') {
      for (const field of [[], [0], [0, 0.5, null, false, true, '0', '0.0', [], [0], {}, -1, 1], null, 0, '0', {}, undefined]) {
        responseText = JSON.stringify({ relevant_indices: field })
        const result = await agenticSessionSearch('private-query', [log])
        assert.deepEqual(result, Array.isArray(field) && field.includes(0) ? [log] : [])
      }
    } else {
      responseText = '{"relevant_indices":[private-transcript]}'
      await assert.rejects(agenticSessionSearch('private-query', [log]), /^Error: Agentic session search failed$/)
      providerFails = true
      await assert.rejects(agenticSessionSearch('private-query', [log]), /^Error: Agentic session search failed$/)
      providerFails = false
      lite = true
      responseText = '{"relevant_indices":[0]}'
      assert.deepEqual(await agenticSessionSearch('private-query', [log]), [log])
      assert.ok(errors.length > 0, 'failure diagnostics remain available')
    }
    assert.ok(debug.length > 0, 'diagnostics remain available')
    for (const text of ['private-query', 'private-first-message', 'private-transcript', 'private-response']) {
      assert.ok(![...debug, ...errors, ...slow].join('\\n').includes(text), 'diagnostics exposed ' + text)
    }
  `], { cwd: fileURLToPath(new URL('./', import.meta.url)), timeout: 10_000 })
  expect(child.stderr.toString()).toBe('')
  expect(child.exitCode).toBe(0)
}, 15_000)
