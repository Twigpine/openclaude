import { describe, expect, test } from 'bun:test'

import {
  MIN_NODE_ENGINE_RANGE,
  MIN_NODE_MAJOR,
  MIN_NODE_VERSION,
  checkSupportedNodeVersion,
} from './nodeRuntime.js'

describe('node runtime contract', () => {
  test('matches the package engines contract', async () => {
    const packageJson = await Bun.file(
      new URL('../../package.json', import.meta.url),
    ).json()

    expect(MIN_NODE_MAJOR).toBe(24)
    expect(MIN_NODE_VERSION).toBe('24.22.1')
    expect(MIN_NODE_ENGINE_RANGE).toBe('>=24.22.1')
    expect(packageJson.engines.node).toBe(MIN_NODE_ENGINE_RANGE)
  })

  test('accepts supported Node versions', () => {
    expect(checkSupportedNodeVersion('v24.22.1')).toEqual({
      ok: true,
      version: '24.22.1',
      major: 24,
    })
    expect(checkSupportedNodeVersion('24.22.1')).toEqual({
      ok: true,
      version: '24.22.1',
      major: 24,
    })
    expect(checkSupportedNodeVersion('26.12.1')).toEqual({
      ok: true,
      version: '26.12.1',
      major: 26,
    })
  })

  test('rejects unsupported Node versions with an actionable message', () => {
    expect(checkSupportedNodeVersion('20.11.1')).toEqual({
      ok: false,
      version: '20.11.1',
      major: 20,
      message:
        'Detected 20.11.1. OpenClaude requires Node.js >=24.22.1. Install Node 24.22.1 or newer, then reinstall/re-run OpenClaude.',
    })
  })

  test.each(['23.12.0', '24.21.9', '24.22.0', '24.22.1-rc.1'])(
    'rejects %s below the exact minimum', version => {
      expect(checkSupportedNodeVersion(version)).toEqual({
        ok: false,
        version,
        major: Number(version.split('.')[0]),
        message: `Detected ${version}. OpenClaude requires Node.js >=24.22.1. Install Node 24.22.1 or newer, then reinstall/re-run OpenClaude.`,
      })
    },
  )

  test.each(['24.22.1', '24.22.2', '24.23.0', '26.0.0', '26.12.1'])(
    'accepts %s at or above the exact minimum', version => {
      expect(checkSupportedNodeVersion(version)).toEqual({
        ok: true,
        version,
        major: Number(version.split('.')[0]),
      })
    },
  )

  test('rejects malformed Node versions with the same required minimum', () => {
    expect(checkSupportedNodeVersion('nightly')).toEqual({
      ok: false,
      version: 'nightly',
      major: null,
      message:
        'Could not parse Node.js version: nightly. OpenClaude requires Node.js >=24.22.1.',
    })
  })
})
