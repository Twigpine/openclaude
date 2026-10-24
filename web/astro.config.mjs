import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://openclaude.twigpine.com',
  trailingSlash: 'always',
  // Preserve HTML-aware whitespace compression across the Astro 7 upgrade.
  compressHTML: true,
  redirects: {
    '/changelog/': 'https://github.com/Twigpine/openclaude/releases',
  },
  integrations: [sitemap()],
})
