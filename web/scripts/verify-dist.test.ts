import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verifyDist } from './verify-dist'
import { SITE } from '../src/data/site'
import { docsPages } from '../src/data/docsNav'
import { heroes } from '../src/data/buddy'
import { partners, community } from '../src/data/partners'

function writePage(dist: string, route: string, html: string): void {
  const dir = join(dist, route.replace(/^\//, ''))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}

/** Build a minimal dist/ that satisfies every verifyDist assertion. */
function writeValidFixture(dist: string): void {
  const navLinks = [`<a href="/buddy/">x</a>`, `<a href="${SITE.releasesUrl}" target="_blank" rel="noopener">x</a>`].join('')
  writePage(
    dist,
    '/',
    `<html>${navLinks}${partners
      .map(p => `<a href="${p.url}"><img src="${p.logo}"></a>`)
      .join('')}${community.map(c => `<a href="${c.url}">x</a>`).join('')}</html>`,
  )
  const sidebar = `${docsPages.map(p => `<a href="${p.href}">x</a>`).join('')}<a href="${SITE.releasesUrl}" target="_blank" rel="noopener">x</a>`
  for (const p of docsPages) writePage(dist, p.href, `<html>${sidebar}</html>`)
  writePage(dist, '/changelog/', `<html><meta http-equiv="refresh" content="0;url=${SITE.releasesUrl}"><meta name="robots" content="noindex">${SITE.releasesUrl}</html>`)
  writePage(
    dist,
    '/buddy/',
    `<html>${heroes.map(h => `<img src="/buddy/${h.id}.svg"><p>${h.attack}</p>`).join('')}</html>`,
  )
  mkdirSync(join(dist, 'buddy'), { recursive: true })
  for (const h of heroes) writeFileSync(join(dist, 'buddy', `${h.id}.svg`), '<svg/>')
  writeFileSync(
    join(dist, 'sitemap-0.xml'),
    `<urlset><loc>${SITE.url}/buddy/</loc></urlset>`,
  )
}

function withFixture(mutate: (dist: string) => void): string[] {
  const dist = mkdtempSync(join(tmpdir(), 'verify-dist-'))
  try {
    writeValidFixture(dist)
    mutate(dist)
    return verifyDist(dist)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
}

describe('verifyDist', () => {
  test('passes on a complete fixture', () => {
    expect(withFixture(() => {})).toEqual([])
  })

  test('flags a missing page', () => {
    const failures = withFixture(dist => rmSync(join(dist, 'buddy', 'index.html')))
    expect(failures).toContain('missing page for route /buddy/')
  })

  test('flags a present-but-empty page instead of skipping its assertions', () => {
    const failures = withFixture(dist => writeFileSync(join(dist, 'index.html'), '  \n'))
    expect(failures).toContain('empty page for route /')
    // and it must not drown the report in per-needle noise for that page
    expect(failures.filter(f => f.startsWith('landing '))).toEqual([])
  })

  test('flags a docs sidebar that lost a navigation link', () => {
    const failures = withFixture(dist => {
      const sidebar = docsPages.map(p => `<a href="${p.href}">x</a>`).join('')
      writePage(dist, '/docs/', `<html>${sidebar}</html>`)
    })
    expect(failures).toContain('docs release notes link: missing safe new-tab release link')
  })

  test('flags a landing release link that lost target=_blank', () => {
    const failures = withFixture(dist => {
      const index = join(dist, 'index.html')
      writeFileSync(index, readFileSync(index, 'utf8').replace(' target="_blank" rel="noopener"', ' rel="noopener"'))
    })
    expect(failures).toContain('landing release notes link: missing safe new-tab release link')
  })

  test('flags a docs release link that lost rel=noopener', () => {
    const failures = withFixture(dist => {
      const docs = join(dist, 'docs', 'index.html')
      writeFileSync(docs, readFileSync(docs, 'utf8').replace(' target="_blank" rel="noopener"', ' target="_blank"'))
    })
    expect(failures).toContain('docs release notes link: missing safe new-tab release link')
  })

  test('flags an unsafe release link even when another release link is safe', () => {
    const failures = withFixture(dist => {
      const index = join(dist, 'index.html')
      writeFileSync(index, `${readFileSync(index, 'utf8')}<a href="${SITE.releasesUrl}" target="_blank">x</a>`)
    })
    expect(failures).toContain('landing release notes link: missing safe new-tab release link')
  })

  test('flags a legacy changelog page that lost its redirect', () => {
    const failures = withFixture(dist => {
      const changelog = join(dist, 'changelog', 'index.html')
      writeFileSync(changelog, readFileSync(changelog, 'utf8').replace(`<meta http-equiv="refresh" content="0;url=${SITE.releasesUrl}">`, ''))
    })
    expect(failures).toContain(`legacy changelog redirect: missing "<meta http-equiv=\\"refresh\\" content=\\"0;url=${SITE.releasesUrl}\\">"`)
  })

  test('flags a legacy changelog redirect that lost noindex', () => {
    const failures = withFixture(dist => {
      const changelog = join(dist, 'changelog', 'index.html')
      writeFileSync(changelog, readFileSync(changelog, 'utf8').replace('<meta name="robots" content="noindex">', ''))
    })
    expect(failures).toContain('legacy changelog noindex: missing "<meta name=\\"robots\\" content=\\"noindex\\">"')
  })

  test('flags a missing sprite asset', () => {
    const hero = heroes[0]!
    const failures = withFixture(dist => rmSync(join(dist, 'buddy', `${hero.id}.svg`)))
    expect(failures).toContain(`missing sprite asset /buddy/${hero.id}.svg`)
  })

  test('flags a stale landing page missing a partner link', () => {
    const failures = withFixture(dist => {
      const html = `<html><a href="/buddy/">x</a><a href="${SITE.releasesUrl}" target="_blank">x</a>${community
        .map(c => `<a href="${c.url}">x</a>`)
        .join('')}</html>`
      writeFileSync(join(dist, 'index.html'), html)
    })
    expect(failures.some(f => f.startsWith(`partner link ${partners[0]!.name}`))).toBe(true)
  })

  test('flags a sitemap missing the new routes', () => {
    const failures = withFixture(dist =>
      writeFileSync(join(dist, 'sitemap-0.xml'), `<urlset><loc>${SITE.url}/</loc></urlset>`),
    )
    expect(failures.some(f => f.startsWith('sitemap entry /buddy/'))).toBe(true)
  })

  test('flags a missing sitemap', () => {
    const failures = withFixture(dist => rmSync(join(dist, 'sitemap-0.xml')))
    expect(failures).toContain('missing dist/sitemap-0.xml')
  })

})
