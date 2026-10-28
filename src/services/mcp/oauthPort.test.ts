import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { snapshotEnv } from '../../test/envSnapshot.js'
import { getPlatform } from '../../utils/platform.js'
import { buildRedirectUri, findAvailablePort } from './oauthPort.js'

test('OAuth callback port selection works without weak randomness and releases its socket', async () => {
  const restoreEnv = snapshotEnv(['MCP_OAUTH_CALLBACK_PORT'], { clear: true })
  const originalRandom = Math.random
  const server = createServer()
  Math.random = () => {
    throw new Error('OAuth callback ports must not use Math.random')
  }

  try {
    const port = await findAvailablePort()
    const windows = getPlatform() === 'windows'
    assert.ok(Number.isInteger(port))
    assert.ok(port === 3118 || (port >= (windows ? 39152 : 49152) && port <= (windows ? 49151 : 65535)))
    assert.equal(buildRedirectUri(port), `http://localhost:${port}/callback`)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, resolve)
    })
  } finally {
    Math.random = originalRandom
    restoreEnv()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  }
})

test('OAuth callback port selection preserves the configured port override', async () => {
  const restoreEnv = snapshotEnv(['MCP_OAUTH_CALLBACK_PORT'])
  process.env.MCP_OAUTH_CALLBACK_PORT = '43210'
  try {
    assert.equal(await findAvailablePort(), 43210)
  } finally {
    restoreEnv()
  }
})


test('OAuth callback port overrides reject incomplete and out-of-range values', async () => {
  const restoreEnv = snapshotEnv(['MCP_OAUTH_CALLBACK_PORT'])
  try {
    for (const value of ['70000', '12345abc', '12345.5', '-1', '0', ' 12345', '12345\n']) {
      process.env.MCP_OAUTH_CALLBACK_PORT = value
      const port = await findAvailablePort()
      const windows = getPlatform() === 'windows'
      assert.ok(port === 3118 || (port >= (windows ? 39152 : 49152) && port <= (windows ? 49151 : 65535)), value)
    }
  } finally {
    restoreEnv()
  }
})

test('OAuth callback port selection skips an occupied override and releases the selected socket', async () => {
  const restoreEnv = snapshotEnv(['MCP_OAUTH_CALLBACK_PORT'])
  const occupied = createServer()
  const selected = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, resolve)
    })
    const address = occupied.address()
    assert.ok(address && typeof address === 'object')
    process.env.MCP_OAUTH_CALLBACK_PORT = String(address.port)
    const port = await findAvailablePort()
    assert.notEqual(port, address.port)
    await new Promise<void>((resolve, reject) => {
      selected.once('error', reject)
      selected.listen(port, resolve)
    })
  } finally {
    restoreEnv()
    for (const server of [occupied, selected]) {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
})
