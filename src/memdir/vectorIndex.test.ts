import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initMemdirIndex,
  searchMemdirIndex,
  rebuildIndex,
  clearAllIndices,
  getIndexPath,
} from './vectorIndex.js'

describe('memdir vectorIndex', () => {
  let memDir: string

  beforeEach(() => {
    memDir = mkdtempSync(join(tmpdir(), 'vector-index-test-'))
    clearAllIndices()
  })

  afterEach(() => {
    clearAllIndices()
    rmSync(memDir, { recursive: true, force: true })
  })

  function writeMem(filename: string, title: string, type: string, description: string, body: string) {
    const content = `---
title: ${title}
type: ${type}
description: ${description}
---

${body}`
    writeFileSync(join(memDir, filename), content, 'utf-8')
  }

  it('builds index from memory files', async () => {
    writeMem('user-role.md', 'Data Scientist', 'user', 'Role info', 'User is a data scientist')
    writeMem('reference-pg.md', 'PostgreSQL Config', 'reference', 'DB setup', 'Database runs on port 5432')

    await initMemdirIndex(memDir)

    const results = await searchMemdirIndex('database', memDir)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(r => r.title.includes('PostgreSQL'))).toBe(true)
  })

  it('finds nothing on empty memory dir', async () => {
    await initMemdirIndex(memDir)
    const results = await searchMemdirIndex('anything', memDir)
    expect(results.length).toBe(0)
  })

  it('searches by description', async () => {
    writeMem('feedback-test.md', 'Testing approach', 'feedback', 'prefer integration tests', 'Always use real DB')
    await initMemdirIndex(memDir)
    const results = await searchMemdirIndex('integration', memDir)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].description).toContain('integration')
  })

  it('rebuilds index after new files', async () => {
    writeMem('project-goal.md', 'Migration', 'project', 'Upgrade to v3', 'Migrate from v2 to v3')
    await initMemdirIndex(memDir)

    const before = await searchMemdirIndex('v3', memDir)
    expect(before.length).toBeGreaterThan(0)

    writeMem('reference-auth.md', 'Auth Config', 'reference', 'OAuth2 setup', 'Using OAuth2 with JWT')
    await rebuildIndex(memDir)

    const after = await searchMemdirIndex('OAuth2', memDir)
    expect(after.length).toBeGreaterThan(0)
  })

  it('index path returns correct location', () => {
    const indexPath = getIndexPath(memDir)
    expect(indexPath).toBe(join(memDir, '.vector-index'))
  })

  it('persists index between inits', async () => {
    writeMem('user-pref.md', 'Theme', 'user', 'Dark mode', 'Prefers dark theme')
    await initMemdirIndex(memDir)

    const r1 = await searchMemdirIndex('dark', memDir)
    expect(r1.length).toBeGreaterThan(0)

    clearAllIndices()
    const r2 = await searchMemdirIndex('dark', memDir)
    expect(r2.length).toBeGreaterThan(0)
  })

  describe('symlink boundary (P1 regression)', () => {
    // CodeRabbit required: symlinked directories inside memory/ must not be
    // traversed, otherwise markdown files outside the auto-memory tree become
    // searchable prompt memory. Symlinked .md files are also rejected — a
    // symlink could point outside the memory root and leak content.

    it('does not follow symlinked directories', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'vector-index-outside-'))
      try {
        writeFileSync(join(outsideDir, 'secret.md'), '---\ntitle: Outside Secret\ntype: reference\ndescription: Outside content\n---\n\nUNIQUE_OUTSIDE_TRIGGER_TOKEN', 'utf-8')

        try {
          symlinkSync(outsideDir, join(memDir, 'linked'), 'dir')
        } catch {
          return
        }

        writeMem('legit.md', 'Legit', 'user', 'Inside memory', 'Inside content')

        await initMemdirIndex(memDir)

        const r = await searchMemdirIndex('UNIQUE_OUTSIDE_TRIGGER_TOKEN', memDir)
        expect(r.length).toBe(0)

        const r2 = await searchMemdirIndex('Inside', memDir)
        expect(r2.length).toBeGreaterThan(0)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('skips symlinked files', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'vector-index-outside-file-'))
      try {
        const outsideFilePath = join(outsideDir, 'outside.md')
        writeFileSync(outsideFilePath, '---\ntitle: Outside File\ntype: reference\ndescription: Outside file\n---\n\nOUTSIDE_FILE_CONTENT', 'utf-8')

        try {
          symlinkSync(outsideFilePath, join(memDir, 'outside.md'), 'file')
        } catch {
          return
        }
        writeMem('legit.md', 'Legit', 'user', 'Inside memory', 'Inside content')

        await initMemdirIndex(memDir)

        // The symlinked file must NOT be indexed
        const r = await searchMemdirIndex('OUTSIDE_FILE_CONTENT', memDir)
        expect(r.length).toBe(0)

        // Legitimate files are still indexed
        const r2 = await searchMemdirIndex('Inside', memDir)
        expect(r2.length).toBeGreaterThan(0)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('skips symlinked markdown files whose target is a directory', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'vector-index-outside-dir-link-'))
      try {
        writeFileSync(join(outsideDir, 'inside.md'), '---\ntitle: Inside Dir Link\ntype: reference\ndescription: Inside link\n---\n\nDIR_LINK_CONTENT', 'utf-8')

        try {
          symlinkSync(outsideDir, join(memDir, 'linked-dir.md'), 'dir')
        } catch {
          return
        }

        await initMemdirIndex(memDir)

        const r = await searchMemdirIndex('DIR_LINK_CONTENT', memDir)
        expect(r.length).toBe(0)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })

  describe('stale index detection (P2 regression)', () => {
    // CodeRabbit requested: regression tests for searching after a loaded memdir
    // file is added, edited, removed, or after persisted index files are missing.
    // The current implementation refreshes an already-loaded index when a new
    // memory file is added, but the tests only covered explicit rebuildIndex()
    // and persisted reload — not the risky stale-index cases this PR fixed.

    it('searching after adding a file refreshes the loaded index', async () => {
      // Initial index with one file
      writeMem('project-v1.md', 'V1 Project', 'project', 'Initial version', 'Version 1 project')
      await initMemdirIndex(memDir)

      // Verify v1 is searchable
      const r1 = await searchMemdirIndex('version 1', memDir)
      expect(r1.length).toBeGreaterThan(0)
      expect(r1.some(r => r.title.includes('V1'))).toBe(true)

      // Add a new file WITHOUT calling rebuildIndex explicitly
      writeMem('project-v2.md', 'V2 Project', 'project', 'New version', 'Version 2 project with features')

      // Search should find the new file (auto-refresh)
      const r2 = await searchMemdirIndex('version 2', memDir)
      expect(r2.length).toBeGreaterThan(0)
      expect(r2.some(r => r.title.includes('V2'))).toBe(true)
    })

    it('searching after editing a file picks up changes', async () => {
      // Create initial file
      writeMem('config.md', 'Config', 'reference', 'Database config', 'Using MySQL')
      await initMemdirIndex(memDir)

      // Verify MySQL is found
      const r1 = await searchMemdirIndex('MySQL', memDir)
      expect(r1.length).toBeGreaterThan(0)

      // Wait 2ms to ensure mtime changes (filesystem mtime resolution can be coarse)
      await new Promise(resolve => setTimeout(resolve, 2))

      // Edit the file to change DB type
      writeMem('config.md', 'Config', 'reference', 'Database config', 'Using PostgreSQL')

      // Search should find updated content
      const r2 = await searchMemdirIndex('PostgreSQL', memDir)
      expect(r2.length).toBeGreaterThan(0)
      expect(r2.some(r => r.description.includes('Database'))).toBe(true)
    })

    it('searching after removing a file updates the index', async () => {
      // Create two files
      writeMem('keep.md', 'Keep', 'user', 'Kept file', 'This stays')
      writeMem('remove.md', 'Remove', 'user', 'Removed file', 'This goes away')
      await initMemdirIndex(memDir)

      // Both should be searchable
      const r1 = await searchMemdirIndex('file', memDir)
      expect(r1.length).toBe(2)

      // Remove one file
      rmSync(join(memDir, 'remove.md'))

      // Search should only find the remaining file
      const r2 = await searchMemdirIndex('Kept', memDir)
      expect(r2.length).toBeGreaterThan(0)
      expect(r2.every(r => r.title !== 'Remove')).toBe(true)

      // Verify removed file is not in results
      const r3 = await searchMemdirIndex('Removed', memDir)
      expect(r3.every(r => r.title !== 'Remove')).toBe(true)
    })

    it('searching when .vector-index file is missing rebuilds from source', async () => {
      // Create files and build index
      writeMem('doc1.md', 'Doc One', 'reference', 'First doc', 'Content one')
      writeMem('doc2.md', 'Doc Two', 'reference', 'Second doc', 'Content two')
      await initMemdirIndex(memDir)

      // Verify both are searchable
      const r1 = await searchMemdirIndex('doc', memDir)
      expect(r1.length).toBe(2)

      // Delete the persisted index file (simulates corruption or manual deletion)
      const indexPath = getIndexPath(memDir)
      if (existsSync(indexPath)) {
        rmSync(indexPath, { force: true })
      }

      // Clear in-memory cache to simulate fresh session
      clearAllIndices()

      // Search should rebuild from source files
      const r2 = await searchMemdirIndex('Content', memDir)
      expect(r2.length).toBe(2)
      expect(r2.some(r => r.title.includes('One'))).toBe(true)
      expect(r2.some(r => r.title.includes('Two'))).toBe(true)
    })

    it('rebuilds when the persisted index checksum does not match', async () => {
      writeMem('checksum.md', 'Checksum Doc', 'reference', 'Integrity check', 'Recoverable content')
      await initMemdirIndex(memDir)

      writeFileSync(getIndexPath(memDir), 'corrupted-index-bytes')
      clearAllIndices()

      const results = await searchMemdirIndex('Recoverable', memDir)
      expect(results.some(result => result.title === 'Checksum Doc')).toBe(true)
    })

    it('searching when .vector-index-meta.json is missing rebuilds', async () => {
      // Create files and build index
      writeMem('meta-test.md', 'Meta Test', 'project', 'Test metadata', 'Metadata test content')
      await initMemdirIndex(memDir)

      const r1 = await searchMemdirIndex('metadata', memDir)
      expect(r1.length).toBeGreaterThan(0)

      // Delete the metadata file
      const metaPath = join(memDir, '.vector-index-meta.json')
      if (existsSync(metaPath)) {
        rmSync(metaPath, { force: true })
      }

      clearAllIndices()

      // Should still work by rebuilding
      const r2 = await searchMemdirIndex('metadata', memDir)
      expect(r2.length).toBeGreaterThan(0)
      expect(r2.some(r => r.title.includes('Meta'))).toBe(true)
    })

    it('searching with mixed stale conditions: files added, edited, and index missing', async () => {
      // Create initial state
      writeMem('original.md', 'Original', 'user', 'Original doc', 'Original content')
      await initMemdirIndex(memDir)

      // Verify original is found
      const r1 = await searchMemdirIndex('Original', memDir)
      expect(r1.length).toBeGreaterThan(0)

      // Edit existing file
      writeMem('original.md', 'Original Updated', 'user', 'Updated doc', 'Updated content')

      // Add new file
      writeMem('new.md', 'New Doc', 'reference', 'Newly added', 'Brand new content')

      // Delete persisted index to force rebuild
      const indexPath = getIndexPath(memDir)
      if (existsSync(indexPath)) {
        rmSync(indexPath, { force: true })
      }
      clearAllIndices()

      // Search should handle all changes correctly
      const r2 = await searchMemdirIndex('content', memDir)
      expect(r2.length).toBe(2)
      expect(r2.some(r => r.title.includes('Updated'))).toBe(true)
      expect(r2.some(r => r.title.includes('New'))).toBe(true)
      expect(r2.every(r => !r.title.includes('Original ') || r.title.includes('Updated'))).toBe(true)
    })
  })

  describe('per-directory isolation (P1 regression)', () => {
    // CodeRabbit required: concurrent indexing of two distinct memory
    // directories must not clobber each other's index state.

    it('maintains separate index state for each memory directory', async () => {
      const memDir2 = mkdtempSync(join(tmpdir(), 'vector-index-test-2-'))
      try {
        writeMem('dog.md', 'Dog', 'user', 'Dog info', 'Dogs are mammals')
        writeFileSync(join(memDir2, 'cat.md'), '---\ntitle: Cat\ntype: user\ndescription: Cat info\n---\n\nCats are mammals', 'utf-8')

        await initMemdirIndex(memDir)
        await initMemdirIndex(memDir2)

        const r1 = await searchMemdirIndex('Dog', memDir)
        expect(r1.some(r => r.title === 'Dog')).toBe(true)
        expect(r1.every(r => r.title !== 'Cat')).toBe(true)

        const r2 = await searchMemdirIndex('Cat', memDir2)
        expect(r2.some(r => r.title === 'Cat')).toBe(true)
        expect(r2.every(r => r.title !== 'Dog')).toBe(true)

        const r3 = await searchMemdirIndex('Cat', memDir)
        expect(r3.length).toBe(0)

        const r4 = await searchMemdirIndex('Dog', memDir2)
        expect(r4.length).toBe(0)
      } finally {
        rmSync(memDir2, { recursive: true, force: true })
      }
    })
  })

  describe('corpus stability', () => {
    it('does not rebuild the index when the corpus is stable', async () => {
      writeMem('doc1.md', 'Doc One', 'user', 'Info', 'Content')
      await initMemdirIndex(memDir)

      // Search should not cause any rebuild
      const r1 = await searchMemdirIndex('Content', memDir)
      expect(r1.length).toBe(1)

      // Delete the index file from disk to ensure we rely purely on the cached
      // in-memory state.db and lastBuiltStats (simulating governance policy / no persistence)
      const indexPath = getIndexPath(memDir)
      if (existsSync(indexPath)) {
        rmSync(indexPath, { force: true })
      }

      // Re-query: because the corpus is stable, it should reuse in-memory state.db
      // and NOT call initMemdirIndex / performRebuildIndex.
      const r2 = await searchMemdirIndex('Content', memDir)
      expect(r2.length).toBe(1)
    })

    it('detects equal-size edits with a preserved mtime (P1 #6)', async () => {
      const { statSync, utimesSync } = require('fs')
      const { join } = require('path')

      // Seed a corpus and build the index.
      writeMem('deploy.md', 'Deployment', 'reference', 'Deploy steps', 'Deploy with oldword on port 5000')
      await initMemdirIndex(memDir)

      const before = await searchMemdirIndex('oldword', memDir)
      expect(before.length).toBeGreaterThan(0)

      // Rewrite the file with an EQUAL-LENGTH replacement and restore the
      // original mtime so the path/size/mtime fingerprint is identical. The
      // content hash alone must reveal the change and serve the new token.
      const filePath = join(memDir, 'deploy.md')
      const originalMtime = statSync(filePath).mtime
      writeMem('deploy.md', 'Deployment', 'reference', 'Deploy steps', 'Deploy with newword on port 5000')
      utimesSync(filePath, originalMtime, originalMtime)

      // Direct search must return the replacement content.
      const direct = await searchMemdirIndex('newword', memDir)
      expect(direct.length).toBeGreaterThan(0)
      expect(direct.some(r => r.content.includes('newword'))).toBe(true)
      expect(direct.some(r => r.content.includes('oldword'))).toBe(false)

      // The old token must no longer be retrievable.
      const stale = await searchMemdirIndex('oldword', memDir)
      expect(stale.some(r => r.content.includes('oldword'))).toBe(false)
    })
  })
})
