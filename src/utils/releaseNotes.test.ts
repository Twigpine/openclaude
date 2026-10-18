import { expect, test } from 'bun:test'
import {
  formatReleaseNotesForDisplay,
  getRecentReleaseNotes,
  getReleaseNotesForVersion,
  parseGitHubReleaseBody,
  sliceReleaseNotesForDisplay,
  serializeGitHubReleasesAsChangelog,
} from './releaseNotes.js'
import { getReleaseTagUrl } from './version.js'

test('parseGitHubReleaseBody strips markdown links and trailing refs', () => {
  expect(
    parseGitHubReleaseBody(`### Features
* add thing ([#1](https://example.com)) ([abc1234](https://example.com))
### Bug Fixes
* **api:** fix bug`),
  ).toEqual([
    '__section__:Features',
    'add thing',
    '__section__:Bug Fixes',
    'api: fix bug',
  ])
})

test('parseGitHubReleaseBody preserves snake_case identifiers', () => {
  expect(
    parseGitHubReleaseBody(
      '* add OPENCLAUDE_DISABLE_TOOL_REMINDERS env var to suppress reminders',
    ),
  ).toEqual([
    'add OPENCLAUDE_DISABLE_TOOL_REMINDERS env var to suppress reminders',
  ])
})

test('serializeGitHubReleasesAsChangelog keeps versioned notes accessible', () => {
  const changelog = serializeGitHubReleasesAsChangelog([
    {
      tag_name: 'v0.8.0',
      body: `* add thing ([#1](https://example.com)) ([abc1234](https://example.com))
* fix another thing`,
    },
  ])

  expect(getReleaseNotesForVersion('0.8.0', changelog)).toEqual([
    'add thing',
    'fix another thing',
  ])
})

test('getRecentReleaseNotes treats legacy internal seen versions as unseen', () => {
  expect(
    getRecentReleaseNotes('0.8.0', '99.0.0', '## 0.8.0\n- latest change'),
  ).toEqual(['latest change'])
})

test('release-please changelog headings are normalized for version lookups', () => {
  const changelog = `# Changelog

## [0.8.0](https://github.com/Twigpine/openclaude/compare/v0.7.0...v0.8.0) (2026-05-02)

### Features

* add thing

## [0.7.0](https://github.com/Twigpine/openclaude/compare/v0.6.0...v0.7.0) (2026-04-26)

### Bug Fixes

* fix thing`

  expect(getReleaseNotesForVersion('0.8.0', changelog)).toEqual(['add thing'])
  expect(getRecentReleaseNotes('0.8.0', '0.7.0', changelog)).toEqual([
    'add thing',
  ])
})

test('getReleaseTagUrl normalizes build metadata to the public tag', () => {
  expect(getReleaseTagUrl('0.8.0+abc123')).toBe(
    'https://github.com/Twigpine/openclaude/releases/tag/v0.8.0',
  )
})

test('formatReleaseNotesForDisplay renders section headers and bullets', () => {
  expect(
    formatReleaseNotesForDisplay([
      '__section__:Features',
      'add thing',
      '__section__:Bug Fixes',
      'fix bug',
    ]),
  ).toBe('Features:\n- add thing\n\nBug Fixes:\n- fix bug')
})

test('sliceReleaseNotesForDisplay preserves headers without counting them', () => {
  expect(
    sliceReleaseNotesForDisplay(
      [
        '__section__:Features',
        'add thing',
        '__section__:Bug Fixes',
        'fix bug',
      ],
      1,
    ),
  ).toEqual([])
})

test('sliceReleaseNotesForDisplay keeps total rendered lines within budget', () => {
  expect(
    sliceReleaseNotesForDisplay(
      [
        '__section__:Features',
        'add thing',
        '__section__:Bug Fixes',
        'fix bug',
      ],
      3,
    ),
  ).toEqual(['__section__:Features', 'add thing'])
})
