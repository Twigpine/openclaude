// Imported only by disposable test entrypoints; never discovered as a suite.
import { expect, mock, test } from 'bun:test'
import {
  attributionModulesNeedIsolation,
  providerModuleIsMocked,
  REAL_PROVIDER_TEST_CHILD_ENV,
  REAL_PROVIDER_TEST_TIMEOUT_MS,
} from '../providerModuleIsolation.js'

const scenario = process.env.ISOLATION_FIXTURE_SCENARIO
const inChild = process.env[REAL_PROVIDER_TEST_CHILD_ENV] === '1'

if (scenario === 'early-exit') {
  test('premature successful exit', () => process.exit(0))
  test('unreached assertion', () => expect(true).toBe(false))
} else if (scenario === 'complete') {
  test('completed child sentinel', () => expect(inChild).toBe(true))
} else if (scenario === 'assertion-failure') {
  test('child assertion failure sentinel', () => {
    expect('actual child value').toBe('expected child value')
  })
} else if (scenario?.startsWith('suite-')) {
  if (!inChild) {
    const auth = await import('../../utils/auth.js')
    mock.module('../../utils/auth.js', () => ({
      ...auth,
      isClaudeAISubscriber: () => false,
    }))
    // Any real-suite hook in the parent must fail, including cleanup hooks.
    mock.module('../sharedMutationLock.js', () => ({
      acquireSharedMutationLock: () => {
        throw new Error('parent setup sentinel')
      },
      releaseSharedMutationLock: () => {
        throw new Error('parent cleanup sentinel')
      },
    }))
  }
  if (scenario === 'suite-sideQuery') {
    await import('../../utils/sideQuery.attribution.test.js')
  } else {
    await import('../../services/api/authRouting.attribution.test.js')
  }
} else {
  if (scenario === 'auth') {
    const auth = await import('../../utils/auth.js')
    mock.module('../../utils/auth.js', () => ({
      ...auth,
      isClaudeAISubscriber: () => false,
    }))
    // Provider restoration must not hide independent auth pollution.
    const realProviders = await import(
      `../../utils/model/providers.js?fixtureReal=${Math.random()}`
    )
    mock.module('../../utils/model/providers.js', () => ({ ...realProviders }))
    const providers = await import('../../utils/model/providers.js')
    expect(providerModuleIsMocked(providers, realProviders)).toBe(false)
  } else if (scenario === 'betas') {
    const betas = await import('../../utils/betas.js')
    mock.module('../../utils/betas.js', () => ({
      ...betas,
      shouldUseGlobalCacheScope: () => false,
    }))
  } else if (scenario === 'routing') {
    const routing = await import('../../services/api/authRouting.js')
    mock.module('../../services/api/authRouting.js', () => ({
      ...routing,
      shouldUseCustomAnthropicBearerAuth: () => true,
    }))
  } else if (scenario === 'metadata') {
    const metadata = await import('../../integrations/routeMetadata.js')
    mock.module('../../integrations/routeMetadata.js', () => ({
      ...metadata,
      getRouteLabel: () => 'polluted route',
    }))
  } else if (scenario === 'client') {
    const client = await import('../../services/api/client.js')
    mock.module('../../services/api/client.js', () => ({
      ...client,
      CLIENT_REQUEST_ID_HEADER: 'polluted-header',
    }))
  } else if (scenario === 'missing') {
    // Register before loading: Bun retains omitted exports when replacing an
    // already-loaded namespace, which would not exercise a missing surface.
    mock.module('../../utils/model/providers.js', () => ({}))
    const loaded = await import('../../utils/model/providers.js')
    expect(Object.keys(loaded)).toHaveLength(0)
    expect(loaded.isFirstPartyAnthropicBaseUrl).toBeUndefined()
  } else if (scenario === 'unsupported' || scenario === 'native-function') {
    const providers = await import('../../utils/model/providers.js')
    mock.module('../../utils/model/providers.js', () => ({
      ...providers,
      getAPIProvider: scenario === 'unsupported'
        ? {}
        : providers.getAPIProvider.bind(null),
    }))
  } else if (scenario === 'import-failure') {
    mock.module('../../utils/model/providers.js', () => {
      throw new Error('module inspection sentinel')
    })
  } else if (scenario === 'child-marker') {
    process.env[REAL_PROVIDER_TEST_CHILD_ENV] = '1'
    mock.module('../../utils/model/providers.js', () => {
      throw new Error('child detector imported providers')
    })
  }

  // Cold attribution imports can exceed the default test timeout under shard
  // load. Use the isolation budget, below the outer fixture process deadline.
  test(`attribution isolation detector: ${scenario}`, async () => {
    expect(await attributionModulesNeedIsolation()).toBe(
      scenario !== 'clean' && scenario !== 'child-marker',
    )
  }, { timeout: REAL_PROVIDER_TEST_TIMEOUT_MS })
}
