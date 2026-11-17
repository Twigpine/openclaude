import assert from 'node:assert/strict'
import axios from 'axios'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { enableConfigs, saveGlobalConfig } from '../../utils/config.js'
import { rememberLoadedEnvFileValues } from '../../utils/envFile.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { applyProviderFlagFromArgs } from '../../utils/providerFlag.js'
import { configureGlobalAgents, getProxyUrl } from '../../utils/proxy.js'

// The entire transport lifecycle is confined to this process: dispatcher
// ownership and proxy caches must not leak into the surrounding unit suite.
enableConfigs()
const requestProxy = async () => (await axios.get<string>('https://provider.example.test', {
  // Exercise the real global request interceptor without network I/O.
  adapter: async config => ({
    data: (config.httpsAgent as { proxy?: URL } | undefined)?.proxy?.href,
    status: 200, statusText: 'OK', headers: {}, config,
  }),
})).data
process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'
process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'
assert.equal(applyProviderFlagFromArgs(['--provider', 'custom-anthropic'], {
  rememberForSettingsEnv: true,
})?.error, undefined)
const oldProxy = 'http://old-proxy.example.test:8080/'
const newProxy = 'http://new-proxy.example.test:8080/'
process.env.HTTPS_PROXY = oldProxy
configureGlobalAgents()
assert.equal(await requestProxy(), oldProxy)
// These flags are introduced by replay, not by the settings object.
rememberLoadedEnvFileValues({ CLAUDE_CODE_USE_OPENAI: '1', OPENAI_API_KEY: 'file-key' })
const invalidEnv = { ANTHROPIC_BASE_URL: ' ', HTTPS_PROXY: newProxy }
saveGlobalConfig(current => ({ ...current, env: invalidEnv }))
const oldState = getDefaultAppState()

onChangeAppState({ oldState, newState: {
  ...oldState,
  settings: { ...oldState.settings, env: invalidEnv },
} })

assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://proxy.example/v1')
assert.equal(process.env.CLAUDE_CODE_USE_OPENAI, undefined)
assert.equal(process.env.OPENAI_API_KEY, undefined)
assert.equal(getProxyUrl(), oldProxy)
assert.equal(await requestProxy(), oldProxy)
saveGlobalConfig(current => ({ ...current, env: {
  ANTHROPIC_BASE_URL: 'https://proxy.example/v1', HTTPS_PROXY: newProxy,
} }))
applyConfigEnvironmentVariables()
assert.equal(process.env.CLAUDE_CODE_USE_OPENAI, undefined)
assert.equal(getProxyUrl(), newProxy)
assert.equal(await requestProxy(), newProxy)
console.log('MANAGED_ENV_TRANSPORT_OK')
