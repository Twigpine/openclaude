import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test.each([false, true])('deep search keeps real hydration diagnostics private (instrumentation: %s)', loggingEnabled => {
  const directory = mkdtempSync(join(tmpdir(), 'session-search-'))
  try {
    const child = Bun.spawnSync([process.execPath,
      ...(loggingEnabled ? ['--feature=SLOW_OPERATION_LOGGING'] : []), '--eval', String.raw`
      import assert from 'node:assert/strict'
      import { writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { mock, spyOn } from 'bun:test'
      process.env.CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS = '0'
      delete process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP
      let clock = 0
      Object.defineProperty(performance, 'now', { value: () => clock += 10 })
      const debug = await import('./debug.ts')
      const state = await import('../bootstrap/state.ts')
      const diagnostics = []
      spyOn(debug, 'logForDebugging').mockImplementation(text => diagnostics.push(String(text)))
      spyOn(state, 'addSlowOperation').mockImplementation(text => diagnostics.push(String(text)))
      const model = await import('./model/model.ts')
      mock.module('./model/model.js', () => ({ ...model, getSmallFastModel: () => 'test-model' }))
      let prompt = ''
      mock.module('./sideQuery.js', () => ({ sideQuery: async options => {
        prompt = options.messages[0].content
        return { content: [{ type: 'text', text: '{"relevant_indices":[0]}' }] }
      } }))
      const { jsonParse } = await import('./slowOperations.ts')
      jsonParse('{}')
      const enabled = process.env.SEARCH_TEST_INSTRUMENTATION === 'true'
      assert.equal(diagnostics.length > 0, enabled, 'instrumentation control')
      const { agenticSessionSearch } = await import('./agenticSessionSearch.ts')
      // Keep the actual storage reader and both JSONL parsing passes.
      const { loadFullLog } = await import('./sessionStorage.ts')
      const { SKIP_PRECOMPACT_THRESHOLD } = await import('./sessionStoragePortable.ts')
      const sessionId = '38f67e50-946e-4d74-b0b6-c19759b99623'
      const oldId = '00000000-0000-4000-8000-000000000001'
      const boundaryId = '00000000-0000-4000-8000-000000000002'
      const currentId = '00000000-0000-4000-8000-000000000003'
      const user = (uuid, parentUuid, content) => ({
        type: 'user', message: { role: 'user', content }, uuid, parentUuid,
        sessionId, timestamp: '2026-10-27T00:00:00.000Z', isSidechain: false,
      })
      for (const compacted of [false, true]) {
        const file = join(process.env.OPENCLAUDE_CONFIG_DIR, compacted ? 'large.jsonl' : 'small.jsonl')
        const entries = [
          { type: 'custom-title', customTitle: 'private-title', sessionId },
          { type: 'tag', tag: 'private-tag', sessionId },
        ]
        if (compacted) {
          entries.push(user(oldId, null, 'discarded-history-marker' + 'x'.repeat(SKIP_PRECOMPACT_THRESHOLD)))
          entries.push({ type: 'system', subtype: 'compact_boundary', uuid: boundaryId,
            parentUuid: null, sessionId, timestamp: '2026-10-27T00:00:00.000Z',
            content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 123 } })
        }
        entries.push(user(currentId, compacted ? boundaryId : null, 'private-transcript'))
        writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
        const lite = { fullPath: file, messages: [], sessionId, firstPrompt: 'public',
          modified: new Date(), created: new Date(), date: '', value: 0,
          messageCount: 1, isSidechain: false }
        diagnostics.length = 0
        const result = await agenticSessionSearch('private-query', [lite])
        assert.equal(result.length, 1)
        assert.equal(result[0].customTitle, 'private-title', 'pre-boundary title restored')
        assert.equal(result[0].tag, 'private-tag', 'pre-boundary tag restored')
        assert.ok(prompt.includes('private-transcript'), 'model retains transcript content')
        if (compacted) assert.ok(!prompt.includes('discarded-history-marker'), 'compaction preserved')
        for (const text of ['private-title', 'private-tag', 'private-transcript', 'private-query']) {
          assert.ok(!diagnostics.join('\n').includes(text), 'hydration diagnostics exposed ' + text)
        }
        diagnostics.length = 0
        // A quiet search must not suppress diagnostics for other loader callers.
        assert.deepEqual(result, [await loadFullLog(lite)])
        assert.equal(diagnostics.some(text => text.includes('private-title')), enabled,
          'ordinary loading retains its existing diagnostic behavior')
      }
    `], {
      cwd: fileURLToPath(new URL('./', import.meta.url)), timeout: 30_000,
      env: { ...process.env, OPENCLAUDE_CONFIG_DIR: directory,
        SEARCH_TEST_INSTRUMENTATION: String(loggingEnabled) },
    })
    expect(child.stderr.toString()).toBe('')
    expect(child.exitCode).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 35_000)
