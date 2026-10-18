import { expect, test } from 'bun:test'

import {
  exchangeJwtAuthGrant,
  requestJwtAuthorizationGrant,
} from './xaa.js'

const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'

function requestTokenExchange(body: unknown) {
  return requestJwtAuthorizationGrant({
    tokenEndpoint: 'https://idp.example.test/token',
    audience: 'https://as.example.test',
    resource: 'https://mcp.example.test/mcp',
    idToken: 'identity-token',
    clientId: 'idp-client',
    fetchFn: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  })
}

test('XAA token-exchange errors never include provider-controlled secret text', async () => {
  const echoedSecret = 'identity-secret-value-7Qm2'

  const request = requestJwtAuthorizationGrant({
    tokenEndpoint: 'https://idp.example.test/token',
    audience: 'https://as.example.test',
    resource: 'https://mcp.example.test/mcp',
    idToken: echoedSecret,
    clientId: 'idp-client',
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: `provider echoed ${echoedSecret}`,
        }),
        { status: 400 },
      ),
  })

  await expect(request).rejects.not.toThrow(echoedSecret)
  await expect(request).rejects.toThrow(/HTTP 400/)
})

test('XAA jwt-bearer errors never include provider-controlled secret text', async () => {
  const echoedSecret = 'assertion-secret-value-9Vr4'

  const request = exchangeJwtAuthGrant({
    tokenEndpoint: 'https://as.example.test/token',
    assertion: echoedSecret,
    clientId: 'as-client',
    clientSecret: 'client-secret',
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: `provider echoed ${echoedSecret}`,
        }),
        { status: 400 },
      ),
  })

  await expect(request).rejects.not.toThrow(echoedSecret)
  await expect(request).rejects.toThrow(/HTTP 400/)
})

test('XAA token-exchange schema errors redact successful response data', async () => {
  const echoedSecret = 'schema-secret-value-3Fs8'
  const request = requestTokenExchange({
    access_token: 'id-jag',
    issued_token_type: ID_JAG_TOKEN_TYPE,
    expires_in: { echoedSecret },
  })

  await expect(request).rejects.not.toThrow(echoedSecret)
  await expect(request).rejects.toThrow(/did not match expected shape/)
})

test('XAA missing-token errors redact successful response data', async () => {
  const echoedSecret = 'missing-token-secret-value-4Gt9'
  const request = requestTokenExchange({
    issued_token_type: ID_JAG_TOKEN_TYPE,
    scope: echoedSecret,
  })

  await expect(request).rejects.not.toThrow(echoedSecret)
  await expect(request).rejects.toThrow(/missing access_token/)
})

test('XAA unexpected-token-type errors redact successful response data', async () => {
  const echoedSecret = 'token-type-secret-value-5Hu0'
  const request = requestTokenExchange({
    access_token: echoedSecret,
    issued_token_type: `unexpected-${echoedSecret}`,
  })

  await expect(request).rejects.not.toThrow(echoedSecret)
  await expect(request).rejects.toThrow(/unexpected issued_token_type/)
})

test('XAA jwt-bearer schema errors redact successful response data', async () => {
  const echoedSecret = 'jwt-schema-secret-value-6Iv1'
  const request = exchangeJwtAuthGrant({
    tokenEndpoint: 'https://as.example.test/token',
    assertion: 'assertion',
    clientId: 'as-client',
    clientSecret: 'client-secret',
    fetchFn: async () =>
      new Response(
        JSON.stringify({ access_token: { echoedSecret } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  })

  await expect(request).rejects.not.toThrow(echoedSecret)
  await expect(request).rejects.toThrow(/did not match expected shape/)
})
