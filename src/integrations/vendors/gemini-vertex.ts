import { defineVendor } from '../define.js'

// Only real credential sources belong here (like every other vendor):
// generic consumers (getProviderPresetUiMetadata / getRouteCredentialValue)
// treat these as "the credential", so routing/config vars such as
// CLAUDE_CODE_USE_GEMINI_VERTEX or GEMINI_VERTEX_PROJECT must not be included —
// otherwise the preset flow would prefill apiKey with non-secret config.
// access-token mode → GEMINI_ACCESS_TOKEN; ADC mode → GOOGLE_APPLICATION_CREDENTIALS
// (ambient ADC has no env var and is resolved at runtime).
const geminiVertexCredentialEnvVars = [
  'GEMINI_ACCESS_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
]

export default defineVendor({
  id: 'gemini-vertex',
  label: 'Google Vertex AI Gemini',
  classification: 'native',
  // The native client builds its own aiplatform.googleapis.com URL from
  // project+location, so this field is reused to carry the Google Cloud project
  // id. Use a placeholder (not the endpoint URL) so the preset routes through
  // the full setup form to collect the project instead of silently saving the
  // endpoint URL as the project.
  defaultBaseUrl: '<your-gcp-project-id>',
  defaultModel: 'gemini-2.5-flash',
  setup: {
    requiresAuth: true,
    authMode: 'adc',
    credentialEnvVars: geminiVertexCredentialEnvVars,
  },
  transportConfig: {
    kind: 'gemini-vertex',
  },
  preset: {
    id: 'gemini-vertex',
    description: 'Gemini on Google Vertex AI',
    modelEnvVars: ['GEMINI_VERTEX_MODEL'],
    fallbackModel: 'gemini-2.5-flash',
  },
  validation: {
    kind: 'gemini-credential',
    routing: {
      enablementEnvVar: 'CLAUDE_CODE_USE_GEMINI_VERTEX',
    },
    missingCredentialMessage:
      'Gemini Vertex requires GEMINI_VERTEX_PROJECT, GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or GOOGLE_PROJECT_ID.',
  },
  catalog: {
    source: 'static',
    models: [
      {
        id: 'gemini-2.5-flash',
        apiName: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
      },
      {
        id: 'gemini-2.5-pro',
        apiName: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
      },
      // Thinking model — available on global endpoint only
      {
        id: 'gemini-3.5-flash',
        apiName: 'gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
      },
    ],
  },
  usage: { supported: false },
})
