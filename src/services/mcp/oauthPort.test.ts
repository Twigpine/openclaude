import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
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
      server.listen(port, '127.0.0.1', resolve)
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
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await new Promise<void>(resolve => server.close(() => resolve()))
    process.env.MCP_OAUTH_CALLBACK_PORT = String(address.port)
    assert.equal(await findAvailablePort(), address.port)
  } finally {
    restoreEnv()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
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
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    assert.ok(address && typeof address === 'object')
    process.env.MCP_OAUTH_CALLBACK_PORT = String(address.port)
    const port = await findAvailablePort()
    assert.notEqual(port, address.port)
    await new Promise<void>((resolve, reject) => {
      selected.once('error', reject)
      selected.listen(port, '127.0.0.1', resolve)
    })
  } finally {
    restoreEnv()
    for (const server of [occupied, selected]) {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
})


test('OAuth callback override remains usable when another interface owns the port', async t => {
  const otherAddress = Object.values(networkInterfaces()).flat()
    .find(address => address?.family === 'IPv4' && !address.internal)?.address
  if (!otherAddress) {
    t.skip('No secondary IPv4 interface available')
    return
  }
  const restoreEnv = snapshotEnv(['MCP_OAUTH_CALLBACK_PORT'])
  const other = createServer()
  const callback = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      other.once('error', reject)
      other.listen(0, otherAddress, resolve)
    })
    const address = other.address()
    assert.ok(address && typeof address === 'object')
    process.env.MCP_OAUTH_CALLBACK_PORT = String(address.port)
    assert.equal(await findAvailablePort(), address.port)
    await new Promise<void>((resolve, reject) => {
      callback.once('error', reject)
      callback.listen(address.port, '127.0.0.1', resolve)
    })
  } finally {
    restoreEnv()
    for (const server of [other, callback]) {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
})
