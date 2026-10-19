import { expect, test } from 'bun:test'

import {
  AIMLAPI_MCP_URL,
  DEFAULT_PARTNER_ID,
} from '../../integrations/aimlapi/config.js'
import { getMcpServerHeaders } from './headersHelper.js'

test('requests to the AI/ML API MCP host carry the attribution headers', async () => {
  const headers = await getMcpServerHeaders('aimlapi', {
    type: 'http',
    url: AIMLAPI_MCP_URL,
    headers: { Authorization: 'Bearer test-key' },
  })

  expect(headers).toEqual({
    Authorization: 'Bearer test-key',
    'X-AIMLAPI-Partner-ID': DEFAULT_PARTNER_ID,
    'X-AIMLAPI-Source': 'agent/openclaude',
  })
})

test('other MCP servers never receive AI/ML API attribution', async () => {
  for (const url of [
    'https://mcp.example.test/mcp',
    'https://mcp.aimlapi.com.attacker.test/mcp',
  ]) {
    const headers = await getMcpServerHeaders('other', {
      type: 'http',
      url,
      headers: { Authorization: 'Bearer other-key' },
    })
    expect(headers).toEqual({ Authorization: 'Bearer other-key' })
  }
})
