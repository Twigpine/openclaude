import { GrpcServer } from '../src/grpc/server.ts'
import { init } from '../src/entrypoints/init.ts'

// Polyfill MACRO which is normally injected by the bundler
Object.assign(globalThis, {
  MACRO: {
    VERSION: '0.1.7',
    DISPLAY_VERSION: '0.1.7',
    PACKAGE_URL: '@twigpine/openclaude',
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
  const host = process.env.GRPC_HOST || 'localhost'
  const server = new GrpcServer()

  server.start(port, host)
}

main().catch((err) => {
  console.error('Fatal error starting gRPC server:', err)
  process.exit(1)
})
