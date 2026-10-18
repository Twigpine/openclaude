import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  generateIntegrationArtifacts,
  generatedIntegrationArtifactsAreCurrent,
} from './artifactGenerator.js'

// Resolve generated artifacts by filename rather than tuple position, so a
// swap of the manifest/descriptor outputs can't pass these assertions.
function splitGeneratedArtifacts(
  artifacts: Awaited<ReturnType<typeof generateIntegrationArtifacts>>,
): { manifestContent: string; artifactsContent: string } {
  const byName = (name: string): string => {
    const artifact = artifacts.find(a => path.basename(a.path) === name)
    if (!artifact) {
      throw new Error(`Expected a generated ${name}`)
    }
    // Assert the full destination path, not just the basename, so a wrong
    // output directory can't slip through and break runtime imports.
    const expectedSuffix = path.join('src', 'integrations', 'generated', name)
    expect(artifact.path.endsWith(expectedSuffix)).toBe(true)
    return artifact.content
  }
  return {
    manifestContent: byName('integrationManifest.generated.ts'),
    artifactsContent: byName('integrationArtifacts.generated.ts'),
  }
}

const FIXTURE_DIRS = [
  'src/integrations/vendors',
  'src/integrations/gateways',
  'src/integrations/anthropicProxies',
  'src/integrations/brands',
  'src/integrations/models',
] as const

async function withFixtureRepo(
  files: Record<string, string>,
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(
    path.join(os.tmpdir(), 'openclaude-integration-artifacts-'),
  )

  try {
    for (const dir of FIXTURE_DIRS) {
      await mkdir(path.join(repoRoot, dir), { recursive: true })
    }

    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(repoRoot, relativePath)
      await mkdir(path.dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, content, 'utf8')
    }

    await callback(repoRoot)
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}

describe('integration artifact generator', () => {
  test('checked-in generated artifacts are current', async () => {
    await expect(generatedIntegrationArtifactsAreCurrent()).resolves.toBe(true)
  })

  test('pins aimlapi.com as the second provider preset', async () => {
    const { manifestContent } = splitGeneratedArtifacts(
      await generateIntegrationArtifacts(),
    )
    const orderedMatch = manifestContent.match(
      /export const ORDERED_PROVIDER_PRESETS = \[\n([\s\S]*?)\n\] as const/,
    )
    expect(orderedMatch).not.toBeNull()
    const orderedPresetIds = Array.from(
      orderedMatch![1]!.matchAll(/"([^"]+)"/g),
      match => match[1]!,
    )
    expect(orderedPresetIds.slice(0, 3)).toEqual([
      'gitlawb-opengateway',
      'aimlapi',
      'anthropic',
    ])
  })

  test('derives loader and preset manifest entries for a preset gateway from descriptor files', async () => {
    await withFixtureRepo(
      {
        'src/integrations/vendors/openai.ts': `export default {
  id: 'openai',
  label: 'OpenAI',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5-mini',
  setup: { requiresAuth: true, authMode: 'api-key', credentialEnvVars: ['OPENAI_API_KEY'] },
  transportConfig: { kind: 'openai-compatible' },
  usage: { supported: false },
}
`,
        'src/integrations/gateways/acme.ts': `export default {
  id: 'acme',
  label: 'Acme Gateway',
  defaultBaseUrl: 'https://gateway.acme.test/v1',
  setup: { requiresAuth: true, authMode: 'api-key', credentialEnvVars: ['ACME_API_KEY'] },
  transportConfig: { kind: 'openai-compatible' },
  preset: {
    id: 'acme-gateway',
    description: 'Acme hosted gateway',
    vendorId: 'openai',
    apiKeyEnvVars: ['ACME_API_KEY'],
  },
  catalog: {
    source: 'static',
    models: [{ id: 'acme-fast', apiName: 'acme-fast' }],
  },
  usage: { supported: false },
}
`,
      },
      async repoRoot => {
        const { manifestContent, artifactsContent } = splitGeneratedArtifacts(
          await generateIntegrationArtifacts({ repoRoot }),
        )

        expect(artifactsContent).toContain(
          "import gatewayAcme from '../gateways/acme.js'",
        )
        expect(manifestContent).toContain('"preset": "acme-gateway"')
        expect(manifestContent).toContain('"gatewayId": "acme"')
        expect(manifestContent).toContain('"routeId": "acme"')
      },
    )
  })

  test('derives loader and preset manifest entries for a direct first-party vendor from descriptor files', async () => {
    await withFixtureRepo(
      {
        'src/integrations/vendors/acme-first-party.ts': `export default {
  id: 'acme-first-party',
  label: 'Acme First Party',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.acme.test/v1',
  defaultModel: 'acme-fast',
  setup: { requiresAuth: true, authMode: 'api-key', credentialEnvVars: ['ACME_API_KEY'] },
  transportConfig: { kind: 'openai-compatible' },
  preset: {
    id: 'acme-direct',
    description: 'Acme direct API',
    apiKeyEnvVars: ['ACME_API_KEY'],
  },
  catalog: {
    source: 'static',
    models: [{ id: 'acme-fast', apiName: 'acme-fast' }],
  },
  usage: { supported: false },
}
`,
      },
      async repoRoot => {
        const { manifestContent, artifactsContent } = splitGeneratedArtifacts(
          await generateIntegrationArtifacts({ repoRoot }),
        )

        expect(artifactsContent).toContain(
          "import vendorAcmeFirstParty from '../vendors/acme-first-party.js'",
        )
        expect(manifestContent).toContain('"preset": "acme-direct"')
        expect(manifestContent).toContain('"routeId": "acme-first-party"')
        expect(manifestContent).toContain('"vendorId": "acme-first-party"')
      },
    )
  })

  test('pins anthropic to the top, sorts the rest by description, and keeps custom at the bottom', async () => {
    await withFixtureRepo(
      {
        'src/integrations/vendors/anthropic.ts': `export default {
  id: 'anthropic',
  label: 'Anthropic',
  classification: 'anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-sonnet-4-6',
  setup: { requiresAuth: true, authMode: 'api-key', credentialEnvVars: ['ANTHROPIC_API_KEY'] },
  transportConfig: { kind: 'anthropic-native' },
  preset: {
    id: 'anthropic',
    description: 'Zulu direct API',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
  },
  usage: { supported: false },
}
`,
        'src/integrations/vendors/openai.ts': `export default {
  id: 'openai',
  label: 'OpenAI',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5-mini',
  setup: { requiresAuth: true, authMode: 'api-key', credentialEnvVars: ['OPENAI_API_KEY'] },
  transportConfig: { kind: 'openai-compatible' },
  usage: { supported: false },
}
`,
        'src/integrations/gateways/zeta.ts': `export default {
  id: 'zeta',
  label: 'Zeta',
  defaultBaseUrl: 'https://zeta.test/v1',
  setup: { requiresAuth: true, authMode: 'api-key', credentialEnvVars: ['ZETA_API_KEY'] },
  transportConfig: { kind: 'openai-compatible' },
  preset: {
    id: 'zeta',
    description: 'Zeta 10',
    vendorId: 'openai',
    apiKeyEnvVars: ['ZETA_API_KEY'],
  },
  catalog: { source: 'static', models: [{ id: 'zeta', apiName: 'zeta', default: true }] },
  usage: { supported: false },
}
`,
        'src/integrations/gateways/alpha.ts': `export default {
  id: 'alpha',
  label: 'Alpha',
  defaultBaseUrl: 'https://alpha.test/v1',
  setup: { requiresAuth: true, authMode: 'api-key', credentialEnvVars: ['ALPHA_API_KEY'] },
  transportConfig: { kind: 'openai-compatible' },
  preset: {
    id: 'alpha',
    description: 'Alpha 2',
    vendorId: 'openai',
    apiKeyEnvVars: ['ALPHA_API_KEY'],
  },
  catalog: { source: 'static', models: [{ id: 'alpha', apiName: 'alpha', default: true }] },
  usage: { supported: false },
}
`,
        'src/integrations/gateways/custom.ts': `export default {
  id: 'custom',
  label: 'Custom',
  setup: { requiresAuth: false, authMode: 'api-key' },
  transportConfig: { kind: 'openai-compatible' },
  preset: {
    id: 'custom',
    description: 'Any OpenAI-compatible provider',
    vendorId: 'openai',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    fallbackBaseUrl: 'http://localhost:11434/v1',
    fallbackModel: 'local-model',
  },
  catalog: { source: 'static', models: [] },
  usage: { supported: false },
}
`,
      },
      async repoRoot => {
        const { manifestContent } = splitGeneratedArtifacts(
          await generateIntegrationArtifacts({ repoRoot }),
        )

        const orderedMatch = manifestContent.match(
          /export const ORDERED_PROVIDER_PRESETS = \[\n([\s\S]*?)\n\] as const/,
        )
        expect(orderedMatch).not.toBeNull()
        const orderedPresetIds = Array.from(
          orderedMatch![1]!.matchAll(/"([^"]+)"/g),
          match => match[1]!,
        )

        expect(orderedPresetIds).toEqual(['anthropic', 'alpha', 'zeta', 'custom'])
      },
    )
  })
})
