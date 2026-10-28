import { defineVendor } from '../define.js'

export default defineVendor({
  id: 'gemini-vertex',
  label: 'Google Vertex AI Gemini',
  classification: 'native',
  defaultBaseUrl: 'https://aiplatform.googleapis.com',
  defaultModel: 'gemini-2.5-flash',
  setup: {
    requiresAuth: true,
    authMode: 'adc',
    credentialEnvVars: ['GEMINI_ACCESS_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS'],
  },
  transportConfig: {
    kind: 'gemini-vertex',
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
