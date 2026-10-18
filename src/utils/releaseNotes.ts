import axios from 'axios'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { coerce } from 'semver'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { toError, getErrnoCode } from './errors.js'
import { logError } from './log.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import { gt } from './semver.js'
import {
  normalizePublicVersion,
  OPENCLAUDE_RELEASES_URL,
  publicBuildVersion,
} from './version.js'

const MAX_RELEASE_NOTES_SHOWN = 5
const RELEASES_API_URL =
  'https://api.github.com/repos/Twigpine/openclaude/releases?per_page=10'
const SECTION_HEADER_PREFIX = '__section__:'

type GitHubRelease = {
  body?: string | null
  draft?: boolean
  prerelease?: boolean
  tag_name?: string | null
}

/**
 * We fetch OpenClaude release notes from GitHub instead of bundling them with
 * the build.
 *
 * This is necessary because Ink's static rendering makes it difficult to
 * dynamically update/show components after initial render. By storing the
 * fetched notes in config, we ensure they're available on the next startup
 * without requiring a full re-render of the current UI.
 *
 * The flow is:
 * 1. User updates to a new version
 * 2. We fetch GitHub release notes in the background and store them in config
 * 3. Next startup, the cached release notes are available immediately
 */
export const RELEASES_URL = OPENCLAUDE_RELEASES_URL

/**
 * Get the path for the cached changelog file.
 * The changelog is stored at ~/.claude/cache/changelog.md
 */
function getChangelogCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'changelog.md')
}

// In-memory cache populated by async reads. Sync callers (React render, sync
// helpers) read from this cache after setup.ts awaits checkForReleaseNotes().
let changelogMemoryCache: string | null = null

/** @internal exported for tests */
export function _resetChangelogCacheForTesting(): void {
  changelogMemoryCache = null
}

function sanitizeReleaseNote(note: string): string {
  let sanitized = note
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|[\s([{])_([^_\s][^_]*?[^_\s])_(?=$|[\s)\]}:;,.!?])/g, '$1$2')
    .trim()

  while (true) {
    const next = sanitized
      .replace(/\s*\((?:#\d+|[0-9a-f]{7,40})\)\s*$/i, '')
      .trim()
    if (next === sanitized) {
      break
    }
    sanitized = next
  }

  return sanitized.replace(/,\s*closes\s+#\d+$/i, '').trim()
}

function encodeSectionHeader(title: string): string {
  return `${SECTION_HEADER_PREFIX}${title}`
}

export function isReleaseSectionHeader(note: string): boolean {
  return note.startsWith(SECTION_HEADER_PREFIX)
}

export function getReleaseSectionHeaderTitle(note: string): string {
  return isReleaseSectionHeader(note)
    ? note.slice(SECTION_HEADER_PREFIX.length)
    : note
}

export function parseGitHubReleaseBody(body: string): string[] {
  const notes: string[] = []
  let pendingSection: string | null = null

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    if (line.startsWith('### ')) {
      const title = sanitizeReleaseNote(line.slice(4))
      pendingSection = title || null
      continue
    }

    if (!line.startsWith('- ') && !line.startsWith('* ')) {
      continue
    }

    const note = sanitizeReleaseNote(line.slice(2).trim())
    if (!note) {
      continue
    }

    if (pendingSection) {
      notes.push(encodeSectionHeader(pendingSection))
      pendingSection = null
    }

    notes.push(note)
  }

  return notes
}

function releaseTagToVersion(tagName: string): string {
  return normalizePublicVersion(tagName)
}

export function serializeGitHubReleasesAsChangelog(
  releases: GitHubRelease[],
): string {
  return releases
    .filter(release => !release.draft && !release.prerelease)
    .map(release => {
      const version = release.tag_name
        ? releaseTagToVersion(release.tag_name)
        : ''
      const notes = parseGitHubReleaseBody(release.body ?? '')
      if (!version || notes.length === 0) {
        return null
      }

      return [`## ${version}`, ...notes.map(note => `- ${note}`)].join('\n')
    })
    .filter((section): section is string => section !== null)
    .join('\n\n')
}

export function getReleaseNotesForVersionFromReleases(
  version: string,
  releases: GitHubRelease[],
): string[] {
  const normalizedVersion = normalizePublicVersion(version)
  const release = releases.find(candidate => {
    if (!candidate.tag_name || candidate.draft || candidate.prerelease) {
      return false
    }
    return releaseTagToVersion(candidate.tag_name) === normalizedVersion
  })

  return release ? parseGitHubReleaseBody(release.body ?? '') : []
}

async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
  const response = await axios.get<GitHubRelease[]>(RELEASES_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'openclaude',
    },
  })

  if (!Array.isArray(response.data)) {
    return []
  }

  return response.status === 200 ? response.data : []
}

async function storeSerializedChangelog(changelogContent: string): Promise<void> {
  // Skip write if content unchanged — writing Date.now() defeats the
  // dirty-check in saveGlobalConfig since the timestamp always differs.
  if (changelogContent === changelogMemoryCache) {
    return
  }

  const cachePath = getChangelogCachePath()

  // Ensure cache directory exists
  await mkdir(dirname(cachePath), { recursive: true })

  // Write changelog to cache file
  await writeFile(cachePath, changelogContent, { encoding: 'utf-8' })
  changelogMemoryCache = changelogContent

  // Update timestamp in config
  const changelogLastFetched = Date.now()
  saveGlobalConfig(current => ({
    ...current,
    changelogLastFetched,
  }))
}

/**
 * Migrate changelog from old config-based storage to file-based storage.
 * This should be called once at startup to ensure the migration happens
 * before any other config saves that might re-add the deprecated field.
 */
export async function migrateChangelogFromConfig(): Promise<void> {
  const config = getGlobalConfig()
  if (!config.cachedChangelog) {
    return
  }

  const cachePath = getChangelogCachePath()

  // Ensure cache directory exists
  try {
    await mkdir(dirname(cachePath), { recursive: true })
  } catch (error) {
    // Directory already exists (EEXIST) is fine - skip silently
    if (getErrnoCode(error) !== 'EEXIST') {
      throw error
    }
  }

  // If cache file doesn't exist, create it from old config
  try {
    await writeFile(cachePath, config.cachedChangelog, {
      encoding: 'utf-8',
      flag: 'wx', // Write only if file doesn't exist
    })
  } catch (error) {
    // File already exists (EEXIST) is fine - skip silently
    if (getErrnoCode(error) !== 'EEXIST') {
      throw error
    }
  }

  // Remove the deprecated field from config only after successful write
  // or if file already existed
  saveGlobalConfig(({ cachedChangelog: _, ...rest }) => rest)
}

/**
 * Fetch the changelog from GitHub and store it in cache file
 * This runs in the background and doesn't block the UI
 */
export async function fetchAndStoreChangelog(): Promise<void> {
  // Skip in noninteractive mode
  if (getIsNonInteractiveSession()) {
    return
  }

  // Skip network requests if nonessential traffic is disabled
  if (isEssentialTrafficOnly()) {
    return
  }

  const releases = await fetchGitHubReleases()
  await storeSerializedChangelog(serializeGitHubReleasesAsChangelog(releases))
}

export async function fetchReleaseNotesForVersion(
  version: string,
): Promise<string[]> {
  if (getIsNonInteractiveSession()) {
    return []
  }

  if (isEssentialTrafficOnly()) {
    return []
  }

  const releases = await fetchGitHubReleases()
  const notes = getReleaseNotesForVersionFromReleases(version, releases)

  if (notes.length > 0) {
    await storeSerializedChangelog(serializeGitHubReleasesAsChangelog(releases))
  }

  return notes
}

/**
 * Get the stored changelog from cache file if available.
 * Populates the in-memory cache for subsequent sync reads.
 * @returns The cached changelog content or empty string if not available
 */
export async function getStoredChangelog(): Promise<string> {
  if (changelogMemoryCache !== null) {
    return changelogMemoryCache
  }
  const cachePath = getChangelogCachePath()
  try {
    const content = await readFile(cachePath, 'utf-8')
    changelogMemoryCache = content
    return content
  } catch {
    changelogMemoryCache = ''
    return ''
  }
}

/**
 * Synchronous accessor for the changelog, reading only from the in-memory cache.
 * Returns empty string if the async getStoredChangelog() hasn't been called yet.
 * Intended for React render paths where async is not possible; setup.ts ensures
 * the cache is populated before first render via `await checkForReleaseNotes()`.
 */
export function getStoredChangelogFromMemory(): string {
  return changelogMemoryCache ?? ''
}

/**
 * Parses a cached release-notes string into a structured format.
 * @param content - The changelog content string
 * @returns Record mapping version numbers to arrays of release notes
 */
export function parseChangelog(content: string): Record<string, string[]> {
  try {
    if (!content) return {}

    // Parse the content
    const releaseNotes: Record<string, string[]> = {}

    // Split by heading lines (## X.X.X)
    const sections = content.split(/^## /gm).slice(1) // Skip the first section which is the header

    for (const section of sections) {
      const lines = section.trim().split('\n')
      if (lines.length === 0) continue

      // Normalize public versions so plain headings, dated headings, and
      // release-please markdown links all map to the same lookup key.
      const versionLine = lines[0]
      if (!versionLine) continue

      const version = normalizePublicVersion(versionLine)
      if (!version) continue

      // Extract bullet points
      const notes = lines
        .slice(1)
        .filter(line => {
          const trimmed = line.trim()
          return trimmed.startsWith('- ') || trimmed.startsWith('* ')
        })
        .map(line => line.trim().substring(2).trim())
        .filter(Boolean)

      if (notes.length > 0) {
        releaseNotes[version] = notes
      }
    }

    return releaseNotes
  } catch (error) {
    logError(toError(error))
    return {}
  }
}

/**
 * Gets release notes to show based on the previously seen version.
 * Shows up to MAX_RELEASE_NOTES_SHOWN items total, prioritizing the most recent versions.
 *
 * @param currentVersion - The current app version
 * @param previousVersion - The last version where release notes were seen (or null if first time)
 * @param readChangelog - Function to read the changelog (defaults to readChangelogFile)
 * @returns Array of release notes to display
 */
export function getRecentReleaseNotes(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent: string = getStoredChangelogFromMemory(),
): string[] {
  try {
    const releaseNotes = parseChangelog(changelogContent)

    // Strip SHA from both versions to compare only the base versions
    const baseCurrentVersion = coerce(currentVersion)
    let basePreviousVersion = previousVersion ? coerce(previousVersion) : null

    // Older OpenClaude builds stored the internal compatibility version
    // (e.g. 99.0.0) as the "seen" marker. Treat that as unseen so users
    // can start receiving release notes keyed to the public version.
    if (
      baseCurrentVersion &&
      basePreviousVersion &&
      gt(basePreviousVersion.version, baseCurrentVersion.version)
    ) {
      basePreviousVersion = null
    }

    if (
      !basePreviousVersion ||
      (baseCurrentVersion &&
        gt(baseCurrentVersion.version, basePreviousVersion.version))
    ) {
      // Get all versions that are newer than the last seen version
      return Object.entries(releaseNotes)
        .filter(
          ([version]) =>
            !basePreviousVersion || gt(version, basePreviousVersion.version),
        )
        .sort(([versionA], [versionB]) => (gt(versionA, versionB) ? -1 : 1)) // Sort newest first
        .flatMap(([_, notes]) => notes)
        .filter(Boolean)
        .slice(0, MAX_RELEASE_NOTES_SHOWN)
    }
  } catch (error) {
    logError(toError(error))
    return []
  }
  return []
}

export function getReleaseNotesForVersion(
  version: string,
  changelogContent: string = getStoredChangelogFromMemory(),
): string[] {
  try {
    const releaseNotes = parseChangelog(changelogContent)
    return releaseNotes[normalizePublicVersion(version)] ?? []
  } catch (error) {
    logError(toError(error))
    return []
  }
}

export function formatReleaseNotesForDisplay(notes: string[]): string {
  const lines: string[] = []

  for (const note of notes) {
    if (isReleaseSectionHeader(note)) {
      if (lines.length > 0) {
        lines.push('')
      }
      lines.push(`${getReleaseSectionHeaderTitle(note)}:`)
      continue
    }

    lines.push(`- ${note}`)
  }

  return lines.join('\n')
}

export function sliceReleaseNotesForDisplay(
  notes: string[],
  maxItems: number,
): string[] {
  if (maxItems <= 0) {
    return []
  }

  const result: string[] = []

  for (const note of notes) {
    if (result.length >= maxItems) {
      break
    }

    if (isReleaseSectionHeader(note)) {
      if (result.length + 1 >= maxItems) {
        break
      }
      result.push(note)
      continue
    }

    result.push(note)
  }

  while (result.length > 0 && isReleaseSectionHeader(result[result.length - 1]!)) {
    result.pop()
  }

  return result
}

/**
 * Gets all release notes as an array of [version, notes] arrays.
 * Versions are sorted with oldest first.
 *
 * @param readChangelog - Function to read the changelog (defaults to readChangelogFile)
 * @returns Array of [version, notes[]] arrays
 */
export function getAllReleaseNotes(
  changelogContent: string = getStoredChangelogFromMemory(),
): Array<[string, string[]]> {
  try {
    const releaseNotes = parseChangelog(changelogContent)

    // Sort versions with oldest first
    const sortedVersions = Object.keys(releaseNotes).sort((a, b) =>
      gt(a, b) ? 1 : -1,
    )

    // Return array of [version, notes] arrays
    return sortedVersions
      .map(version => {
        const versionNotes = releaseNotes[version]
        if (!versionNotes || versionNotes.length === 0) return null

        const notes = versionNotes.filter(Boolean)
        if (notes.length === 0) return null

        return [version, notes] as [string, string[]]
      })
      .filter((item): item is [string, string[]] => item !== null)
  } catch (error) {
    logError(toError(error))
    return []
  }
}

/**
 * Checks if there are release notes to show based on the last seen version.
 * Can be used by multiple components to determine whether to display release notes.
 * Also triggers a fetch of the latest changelog if the version has changed.
 *
 * @param lastSeenVersion The last version of release notes the user has seen
 * @param currentVersion The current application version, defaults to MACRO.VERSION
 * @returns An object with hasReleaseNotes and the releaseNotes content
 */
export async function checkForReleaseNotes(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = publicBuildVersion,
): Promise<{ hasReleaseNotes: boolean; releaseNotes: string[] }> {
  // For Ant builds, use VERSION_CHANGELOG bundled at build time
  if (process.env.USER_TYPE === 'ant') {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return {
        hasReleaseNotes: commits.length > 0,
        releaseNotes: commits,
      }
    }
    return {
      hasReleaseNotes: false,
      releaseNotes: [],
    }
  }

  // Ensure the in-memory cache is populated for subsequent sync reads
  const cachedChangelog = await getStoredChangelog()

  // If the version has changed or we don't have a cached changelog, fetch a new one
  // This happens in the background and doesn't block the UI
  if (lastSeenVersion !== currentVersion || !cachedChangelog) {
    fetchAndStoreChangelog().catch(error => logError(toError(error)))
  }

  const releaseNotes = getRecentReleaseNotes(
    currentVersion,
    lastSeenVersion,
    cachedChangelog,
  )
  const hasReleaseNotes = releaseNotes.length > 0

  return {
    hasReleaseNotes,
    releaseNotes,
  }
}

/**
 * Synchronous variant of checkForReleaseNotes for React render paths.
 * Reads only from the in-memory cache populated by the async version.
 * setup.ts awaits checkForReleaseNotes() before first render, so this
 * returns accurate results in component render bodies.
 */
export function checkForReleaseNotesSync(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = publicBuildVersion,
): { hasReleaseNotes: boolean; releaseNotes: string[] } {
  // For Ant builds, use VERSION_CHANGELOG bundled at build time
  if (process.env.USER_TYPE === 'ant') {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return {
        hasReleaseNotes: commits.length > 0,
        releaseNotes: commits,
      }
    }
    return {
      hasReleaseNotes: false,
      releaseNotes: [],
    }
  }

  const releaseNotes = getRecentReleaseNotes(currentVersion, lastSeenVersion)
  return {
    hasReleaseNotes: releaseNotes.length > 0,
    releaseNotes,
  }
}
