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

  test('multi-component wildcard ranges are valid', () => {
    for (const range of ['x.x', 'x.x.x', '0.x', '0.36.x', '0.*']) {
      expect(
        pluginEnginesIncompatibility(
          manifest({ 'claude-code': range }),
          APP_VERSION,
        ),
      ).toBeNull()
    }
  })

  test('caret, tilde, comparator set, hyphen, and or ranges are valid', () => {
    const compatible = [
      '^0.36.0',
      '~0.36.0',
      '>=0.30.0 <1.0.0',
      '0.30.0 - 0.40.0',
      '>=99.0.0 || >=0.30.0',
    ]
    for (const range of compatible) {
      expect(
        pluginEnginesIncompatibility(
          manifest({ 'claude-code': range }),
          APP_VERSION,
        ),
      ).toBeNull()
    }
  })

  test('whitespace between comparator and version is accepted', () => {
    // npm semver accepts `>= 0.30.0` and `^ 0.36.0`; the range grammar and
    // the satisfies check must handle them rather than rejecting or
    // silently treating the input as a wildcard.
    for (const range of ['>= 0.30.0', '^ 0.36.0', '~ 0.36.0']) {
      expect(
        pluginEnginesIncompatibility(
          manifest({ 'claude-code': range }),
          APP_VERSION,
        ),
      ).toBeNull()
    }
    const error = pluginEnginesIncompatibility(
      manifest({ 'claude-code': '^ 1.0.0' }),
      APP_VERSION,
    )
    expect(error).not.toBeNull()
    expect(error).not.toContain('invalid')
  })

  test('malformed text around a valid range is invalid, not compatible', () => {
    for (const range of [
      '>=0.30.0 definitely-invalid',
      '>=0.30.0 ||',
      '||',
      '1.2.3.4',
      '>=',
    ]) {
      const error = pluginEnginesIncompatibility(
        manifest({ 'claude-code': range }),
        APP_VERSION,
      )
      expect(error).not.toBeNull()
      expect(error).toContain('invalid')
    }
  })
})
