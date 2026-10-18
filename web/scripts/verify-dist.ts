// Post-build guard, run by `bun run build` after `astro build`.
// Asserts that the typed data files actually drive the rendered output:
// navigation and the / and /buddy/ routes.
// Kept as a pure function so verify-dist.test.ts can exercise it on fixtures.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { SITE } from '../src/data/site'
import { docsPages } from '../src/data/docsNav'
import { heroes } from '../src/data/buddy'
import { partners, community } from '../src/data/partners'

export function verifyDist(dist: string): string[] {
  const failures: string[] = []

  function page(route: string): string {
    const file = join(dist, route.replace(/^\//, ''), 'index.html')
    if (!existsSync(file)) {
      failures.push(`missing page for route ${route}`)
      return ''
    }
    const html = readFileSync(file, 'utf8')
    if (html.trim() === '') {
      // '' is only ever returned alongside a recorded failure, so expect()
      // skipping falsy html can never silently pass a bad page.
      failures.push(`empty page for route ${route}`)
      return ''
    }
    return html
  }

  function expect(html: string, needle: string, why: string): void {
    if (html !== '' && !html.includes(needle)) failures.push(`${why}: missing ${JSON.stringify(needle)}`)
  }

  function expectReleaseLinks(html: string, why: string): void {
    const releaseLinks = (html.match(/<a\b[^>]*>/g) ?? []).filter(link => link.includes(`href="${SITE.releasesUrl}"`))
    if (html !== '' && (releaseLinks.length === 0 || releaseLinks.some(link => !link.includes('target="_blank"') || !link.includes('rel="noopener"'))))
      failures.push(`${why}: missing safe new-tab release link`)
  }

  const index = page('/')

  // ── navigation exposes every docsNav route, in data AND rendered output ──
  const docsIndex = page('/docs/')
  for (const p of docsPages) {
    page(p.href) // records a failure if the route didn't build
    expect(docsIndex, `href="${p.href}"`, `docs sidebar link ${p.href}`)
  }
  if (!docsPages.some(p => p.href === '/buddy/')) failures.push('docsNav missing /buddy/')
  expect(index, 'href="/buddy/"', 'landing nav link /buddy/')
  expectReleaseLinks(index, 'landing release notes link')
  expectReleaseLinks(docsIndex, 'docs release notes link')

  // ── legacy route continues on the canonical GitHub Releases page ─────────
  const legacyChangelog = page('/changelog/')
  expect(legacyChangelog, SITE.releasesUrl, 'legacy changelog redirect')
  expect(legacyChangelog, `<meta http-equiv="refresh" content="0;url=${SITE.releasesUrl}">`, 'legacy changelog redirect')
  expect(legacyChangelog, '<meta name="robots" content="noindex">', 'legacy changelog noindex')

  // ── /buddy/: every hero renders with its sprite ──────────────────────────
  const buddy = page('/buddy/')
  for (const h of heroes) {
    expect(buddy, `/buddy/${h.id}.svg`, `buddy sprite ${h.id}`)
    expect(buddy, h.attack, `buddy attack ${h.id}`)
    if (!existsSync(join(dist, 'buddy', `${h.id}.svg`)))
      failures.push(`missing sprite asset /buddy/${h.id}.svg`)
  }

  // ── landing: partner and community links render ──────────────────────────
  for (const p of partners) {
    expect(index, `href="${p.url}"`, `partner link ${p.name}`)
    expect(index, p.logo, `partner logo ${p.name}`)
  }
  for (const c of community) expect(index, `href="${c.url}"`, `community link ${c.name}`)

  // ── sitemap covers the new routes ────────────────────────────────────────
  const sitemapFile = join(dist, 'sitemap-0.xml')
  if (existsSync(sitemapFile)) {
    const sitemap = readFileSync(sitemapFile, 'utf8')
    for (const route of ['/buddy/'])
      expect(sitemap, `${SITE.url}${route}`, `sitemap entry ${route}`)
  } else {
    failures.push('missing dist/sitemap-0.xml')
  }

  return [...new Set(failures)]
}

if (import.meta.main) {
  const failures = verifyDist(join(import.meta.dir, '..', 'dist'))
  if (failures.length > 0) {
    console.error(`verify-dist: ${failures.length} failure(s)`)
    for (const f of failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.log('verify-dist: ok — navigation, buddy, and partners verified')
}
