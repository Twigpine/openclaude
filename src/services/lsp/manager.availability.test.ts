import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

// Keep a pristine Bun module graph: tools.lsp.test.ts installs a process-wide
// mock for manager.js, so in-process behavior would depend on test-file order.
test('bounds failed starts before advertising server availability', () => {
  const managerModuleUrl = new URL('./manager.ts', import.meta.url).href
  const instanceModuleUrl = new URL(
    './LSPServerInstance.ts',
    import.meta.url,
  ).href
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `
        const manager = await import(${JSON.stringify(managerModuleUrl)})
        const { createLSPServerInstance } = await import(${JSON.stringify(instanceModuleUrl)})
        const {
          _resetLspManagerForTesting,
          _setLspManagerForTesting,
          isLspConnected,
        } = manager

        const config = {
          command: 'test-lsp',
          extensionToLanguage: { '.ts': 'typescript' },
          maxRestarts: 1,
          scope: 'project',
          source: 'test',
        }

        const runScenario = async failurePhase => {
          let failureEnabled = true
          let initialized = false
          let startCalls = 0
          let initializeCalls = 0
          const client = {
            get capabilities() { return {} },
            get isInitialized() { return initialized },
            async start() {
              startCalls++
              if (failureEnabled && failurePhase === 'spawn') {
                throw new Error('spawn failed')
              }
            },
            async initialize() {
              initializeCalls++
              if (failureEnabled && failurePhase === 'initialize-timeout') {
                return await new Promise(() => {})
              }
              initialized = true
              return { capabilities: {} }
            },
            async sendRequest() {},
            async sendNotification() {},
            async sendNotificationStrict() {},
            onNotification() {},
            onRequest() {},
            async stop() { initialized = false },
          }
          const instance = createLSPServerInstance(
            'typescript',
            config,
            {
              createClient: () => client,
              defaultStartupTimeoutMs: 0,
            },
          )
          _setLspManagerForTesting({
            getAllServers: () => new Map([['typescript', instance]]),
          })

          const availability = [isLspConnected()]
          const errors = []
          for (let attempt = 0; attempt < 2; attempt++) {
            await instance.start().catch(error => errors.push(error.message))
            availability.push(isLspConnected())
          }
          await instance.start().catch(error => errors.push(error.message))
          availability.push(isLspConnected())

          failureEnabled = false
          await instance.restart()
          availability.push(isLspConnected())

          return {
            availability,
            errors,
            generation: instance.generation,
            initializeCalls,
            startCalls,
          }
        }

        const results = {
          initiallyAvailable: isLspConnected(),
          spawn: await runScenario('spawn'),
          timeout: await runScenario('initialize-timeout'),
        }
        _resetLspManagerForTesting()
        process.stdout.write(JSON.stringify(results))
      `,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  )

  expect(JSON.parse(output)).toEqual({
    initiallyAvailable: false,
    spawn: {
      availability: [true, true, false, false, true],
      errors: [
        'spawn failed',
        'spawn failed',
        "LSP server 'typescript' exceeded max automatic recovery attempts (1)",
      ],
      generation: 1,
      initializeCalls: 1,
      startCalls: 3,
    },
    timeout: {
      availability: [true, true, false, false, true],
      errors: [
        "LSP server 'typescript' timed out after 0ms during initialization",
        "LSP server 'typescript' timed out after 0ms during initialization",
        "LSP server 'typescript' exceeded max automatic recovery attempts (1)",
      ],
      generation: 1,
      initializeCalls: 3,
      startCalls: 3,
    },
  })
})
