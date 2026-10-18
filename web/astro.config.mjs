import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://openclaude.twigpine.com',
  trailingSlash: 'always',
  redirects: {
    '/changelog/': 'https://github.com/Twigpine/openclaude/releases',
  },
  integrations: [sitemap()],
})
