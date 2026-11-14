import { describe, expect, test } from 'bun:test'
import type { PluginManifest } from '../../types/plugin.js'
import { pluginEnginesIncompatibility } from './pluginLoader.js'
import { PluginManifestSchema } from './schemas.js'

const APP_VERSION = '0.36.0'

function manifest(engines?: Record<string, string>): PluginManifest {
  return {
    name: 'test-plugin',
    ...(engines ? { engines } : {}),
  } as PluginManifest
}

describe('plugin engines compatibility', () => {
  test('schema accepts an engines field', () => {
    const result = PluginManifestSchema().safeParse({
      name: 'test-plugin',
      engines: { 'claude-code': '>=0.30.0' },
    })
    expect(result.success).toBe(true)
  })

  test('manifest without engines is compatible', () => {
    expect(pluginEnginesIncompatibility(manifest(), APP_VERSION)).toBeNull()
  })

  test('unknown engine names are ignored', () => {
    expect(
      pluginEnginesIncompatibility(
        manifest({ 'some-other-host': '>=99.0.0' }),
        APP_VERSION,
      ),
    ).toBeNull()
  })

  test('compatible range is accepted', () => {
    expect(
      pluginEnginesIncompatibility(
        manifest({ 'claude-code': '>=0.30.0' }),
        APP_VERSION,
      ),
    ).toBeNull()
  })

  test('incompatible range reports plugin, range, and running version', () => {
    const error = pluginEnginesIncompatibility(
      manifest({ 'claude-code': '>=1.0.0' }),
      APP_VERSION,
    )
    expect(error).toContain('test-plugin')
    expect(error).toContain('>=1.0.0')
    expect(error).toContain(APP_VERSION)
  })

  test('unparseable range is reported as invalid', () => {
    const error = pluginEnginesIncompatibility(
      manifest({ 'claude-code': 'not-a-range' }),
      APP_VERSION,
    )
    expect(error).not.toBeNull()
    expect(error).toContain('test-plugin')
  })
})
