import { defineModel } from '../define.js'

const geminiCapabilities = {
  supportsVision: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: true,
  supportsPreciseTokenCount: false,
}

function geminiModel(id: string, label: string, maxOutputTokens: number) {
  return defineModel({
    id,
    label,
    brandId: 'gemini',
    vendorId: 'gemini',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: id,
    capabilities: geminiCapabilities,
    contextWindow: 1_048_576,
    maxOutputTokens,
  })
}

function gemmaModel(id: string, label: string, contextWindow: number, maxOutputTokens: number) {
  return defineModel({
    id,
    label,
    brandId: 'gemini',
    vendorId: 'gemini',
    classification: ['chat', 'reasoning', 'coding', 'vision'],
    defaultModel: id,
    capabilities: geminiCapabilities,
    contextWindow,
    maxOutputTokens,
  })
}

export default [
  geminiModel('gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', 65_536),
  geminiModel('gemini-3.1-pro', 'Gemini 3.1 Pro', 65_536),
  geminiModel('gemini-2.5-flash', 'Gemini 2.5 Flash', 65_536),
  geminiModel('gemini-2.5-pro', 'Gemini 2.5 Pro', 65_536),
  geminiModel('gemini-2.0-flash', 'Gemini 2.0 Flash', 8_192),
  geminiModel('gemini-3.5-flash', 'Gemini 3.5 Flash', 65_536),
  geminiModel('google/gemini-3.1-pro-preview', 'Google Gemini 3.1 Pro Preview', 64_000),
  geminiModel('google/gemini-3.1-flash-lite', 'Google Gemini 3.1 Flash Lite', 65_536),
  geminiModel('google/gemini-2.5-pro', 'Google Gemini 2.5 Pro', 65_536),
  geminiModel('google/gemini-2.0-flash', 'Google Gemini 2.0 Flash', 8_192),

  gemmaModel('gemma-4-26b-a4b-it', 'Gemma 4 26B A4B', 262_144, 65_536),
  gemmaModel('gemma-4-31b-it', 'Gemma 4 31B', 262_144, 65_536),
]
