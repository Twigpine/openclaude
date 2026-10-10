import { GrpcServer } from '../src/grpc/server.ts'
import { GRPC_AUTH_TOKEN_ENV, resolveGrpcBind } from '../src/grpc/auth.ts'
import { init } from '../src/entrypoints/init.ts'

// Polyfill MACRO which is normally injected by the bundler
Object.assign(globalThis, {
  MACRO: {
    VERSION: '0.1.7',
    DISPLAY_VERSION: '0.1.7',
    PACKAGE_URL: '@gitlawb/openclaude',
  }
})

async function main() {
  console.log('Starting OpenClaude gRPC Server...')
  await init()

  // Mirror CLI bootstrap: hydrate secure tokens and resolve provider profile
  const { enableConfigs } = await import('../src/utils/config.js')
  enableConfigs()
  const { applySafeConfigEnvironmentVariables } = await import('../src/utils/managedEnv.js')
  applySafeConfigEnvironmentVariables()
  const { hydrateGeminiAccessTokenFromSecureStorage } = await import('../src/utils/geminiCredentials.js')
  hydrateGeminiAccessTokenFromSecureStorage()
  const { hydrateGithubModelsTokenFromSecureStorage } = await import('../src/utils/githubModelsCredentials.js')
  hydrateGithubModelsTokenFromSecureStorage()

  const { applyStartupEnvFromProfile } = await import('../src/utils/providerProfile.js')
  const { validateProviderEnvOrExit } = await import('../src/utils/providerValidation.js')
  await applyStartupEnvFromProfile({
    processEnv: process.env,
    onValidationError: message => {
      console.warn(message)
    },
  })
  await validateProviderEnvOrExit()

  const port = process.env.GRPC_PORT ? parseInt(process.env.GRPC_PORT, 10) : 50051
  const requestedHost = process.env.GRPC_HOST
  const authToken = process.env[GRPC_AUTH_TOKEN_ENV] || undefined

  // Refuse to expose the agent service on a non-loopback interface unless a
  // bearer token is configured. Binding 0.0.0.0 without auth turns any code
  // execution in a reachable client into remote command execution here.
  const bind = resolveGrpcBind(requestedHost, authToken)
  if (!bind.ok) {
    console.error(bind.reason)
    process.exit(1)
  }

  const server = new GrpcServer(authToken)

  server.start(port, bind.host)
}

main().catch((err) => {
  console.error('Fatal error starting gRPC server:', err)
  process.exit(1)
})
