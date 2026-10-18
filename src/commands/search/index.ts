import type { Command } from '../../commands.js'

const search = {
  type: 'local-jsx',
  name: 'search',
  description: 'Choose the web search backend (Exa by default) and manage its API key',
  argumentHint: '[status | test | key | remove-key | auto | exa | tavily | brave | …]',
  // API keys are credentials — keep inline args (e.g. a key pasted after
  // `/search key`) out of the transcript and model context.
  isSensitive: true,
  load: () => import('./search.js'),
} satisfies Command

export default search
