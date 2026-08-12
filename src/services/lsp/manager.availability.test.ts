import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'

// Keep a pristine Bun module graph: tools.lsp.test.ts installs a process-wide
// mock for manager.js, so in-process behavior would depend on test-file order.
test('reports restartable servers but hides exhausted servers in every state', () => {
  const managerModuleUrl = new URL('./manager.ts', import.meta.url).href
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `
        const {
          _resetLspManagerForTesting,
          _setLspManagerForTesting,
          isLspConnected,
        } = await import(${JSON.stringify(managerModuleUrl)})

        const install = (state, isCrashRecoveryExhausted) => {
          const server = { state, isCrashRecoveryExhausted }
          _setLspManagerForTesting({
            getAllServers: () => new Map([['typescript', server]]),
          })
        }

        const results = [isLspConnected()]
        install('error', false)
        results.push(isLspConnected())
        install('error', true)
        results.push(isLspConnected())
        install('stopped', true)
        results.push(isLspConnected())
        _resetLspManagerForTesting()
        process.stdout.write(JSON.stringify(results))
      `,
    ],
    { encoding: 'utf8' },
  )

  expect(JSON.parse(output)).toEqual([false, true, false, false])
})
