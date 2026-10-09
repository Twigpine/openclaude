export const SITE = {
  url: 'https://openclaude.gitlawb.com',
  name: 'openclaude',
  title: 'openclaude — open-source coding agent CLI for any model',
  description:
    'Open-source coding agent that runs in your terminal and talks to any model: OpenAI, Gemini, Ollama, GitHub Models, and 200+ more. One install, every provider.',
  installCommand: 'npm install -g @gitlawb/openclaude@latest',
  npmUrl: 'https://www.npmjs.com/package/@gitlawb/openclaude',
  github: 'https://github.com/Twigpine/openclaude',
  releasesUrl: 'https://github.com/Twigpine/openclaude/releases',
  twigpine: 'https://twigpine.com',
  // The node mirror path is unchanged: twigpine.com/node/repos/... redirects to
  // the same explorer.gitlawb.com endpoint that gitlawb.com does, and neither
  // currently serves this repo (404). Left as-is rather than swapped to a host
  // that resolves no better.
  gitlawbRepo: 'https://gitlawb.com/node/repos/z6MkqDnb/openclaude',
  ogDefault: '/og/default.png',
  ogDocs: '/og/docs.png',
} as const
