import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as analytics from '../../services/analytics/index.js'
import * as mcpConfig from '../../services/mcp/config.js'
import * as mcpUtils from '../../services/mcp/utils.js'
import * as config from '../../utils/config.js'
import { mcpRemoveHandler } from './mcp.js'

afterEach(() => {
  mock.restore()
})

test('scoped remove stops after removing the requested scope', async () => {
  // Tests let process.exit return (see cli/exit.ts), so a missing return would
  // fall through into the unscoped lookup and remove the server a second time.
  spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit)
  spyOn(process.stdout, 'write').mockImplementation(() => true)
  spyOn(console, 'error').mockImplementation(() => {})
  spyOn(analytics, 'logEvent').mockImplementation(() => {})
  spyOn(mcpUtils, 'describeMcpConfigFilePath').mockReturnValue('config')
  spyOn(mcpConfig, 'getMcpConfigByName').mockReturnValue(null)
  spyOn(mcpConfig, 'getProjectMcpConfigsFromCwd').mockReturnValue({ servers: {}, errors: [] })
  spyOn(config, 'getCurrentProjectConfig').mockReturnValue({
    mcpServers: { demo: { command: 'demo' } },
  } as unknown as ReturnType<typeof config.getCurrentProjectConfig>)
  spyOn(config, 'getGlobalConfig').mockReturnValue(
    { mcpServers: {} } as unknown as ReturnType<typeof config.getGlobalConfig>,
  )
  const remove = spyOn(mcpConfig, 'removeMcpConfig').mockResolvedValue(undefined)

  await mcpRemoveHandler('demo', { scope: 'local' })

  expect(remove.mock.calls).toEqual([['demo', 'local']])
  expect(process.exit).toHaveBeenCalledTimes(1)
  expect(process.exit).toHaveBeenCalledWith(0)
})
