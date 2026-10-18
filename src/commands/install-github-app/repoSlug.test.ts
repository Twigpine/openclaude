import assert from 'node:assert/strict'
import test from 'node:test'

import { extractGitHubRepoSlug } from './repoSlug.ts'

test('keeps owner/repo input as-is', () => {
  assert.equal(extractGitHubRepoSlug('Twigpine/openclaude'), 'Twigpine/openclaude')
})

test('extracts slug from https GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('https://github.com/Twigpine/openclaude'),
    'Twigpine/openclaude',
  )
  assert.equal(
    extractGitHubRepoSlug('https://www.github.com/Twigpine/openclaude.git'),
    'Twigpine/openclaude',
  )
})

test('extracts slug from ssh GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('git@github.com:Twigpine/openclaude.git'),
    'Twigpine/openclaude',
  )
  assert.equal(
    extractGitHubRepoSlug('ssh://git@github.com/Twigpine/openclaude'),
    'Twigpine/openclaude',
  )
})

test('rejects malformed or non-GitHub URLs', () => {
  assert.equal(extractGitHubRepoSlug('https://gitlab.com/Twigpine/openclaude'), null)
  assert.equal(extractGitHubRepoSlug('https://github.com/Twigpine'), null)
  assert.equal(extractGitHubRepoSlug('not actually github.com/Twigpine/openclaude'), null)
  assert.equal(
    extractGitHubRepoSlug('https://evil.example/?next=github.com/Twigpine/openclaude'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://github.com.evil.example/Twigpine/openclaude'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://example.com/github.com/Twigpine/openclaude'),
    null,
  )
})
