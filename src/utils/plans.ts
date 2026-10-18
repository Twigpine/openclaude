import { randomUUID } from 'crypto'
import type { Stats } from 'fs'
import { copyFile, writeFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import type { AgentId, SessionId } from 'src/types/ids.js'
import type { LogOption } from 'src/types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  SystemFileSnapshotMessage,
  UserMessage,
} from 'src/types/message.js'
import { getPlanSlugCache, getSessionId } from '../bootstrap/state.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isENOENT } from './errors.js'
import { getEnvironmentKind } from './filePersistence/outputsScanner.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { resolveConfigDirEnv } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'
import { generateWordSlug } from './words.js'

const MAX_SLUG_RETRIES = 10

/**
 * Encoded agent plans live in this dedicated subdirectory of the plans dir so
 * their filenames can never collide with a legacy (pre-escape) plan written
 * directly under it. Two distinct teammates `writer@a/b` and `writer@a%2Fb`
 * otherwise both map onto `{slug}-agent-writer@a%2Fb.md` -- one as the new
 * escaped name, the other as its raw legacy name -- and read or clobber each
 * other's plan. A real path separator is the one thing a raw single-component
 * legacy name can never contain, so a subdirectory is what makes the escaped
 * and legacy namespaces provably disjoint.
 *
 * Exported so the permission carve-out recognizes the same location.
 */
export const AGENT_PLANS_SUBDIR = 'agents'

export function getDefaultPlansDirectory({
  configDirEnv = resolveConfigDirEnv({
    openClaudeConfigDir: process.env.OPENCLAUDE_CONFIG_DIR,
    legacyConfigDir: process.env.CLAUDE_CONFIG_DIR,
  }),
  homeDir = homedir(),
}: {
  configDirEnv?: string
  homeDir?: string
} = {}): string {
  if (configDirEnv) {
    return join(configDirEnv.normalize('NFC'), 'plans')
  }
  return join(homeDir, '.openclaude', 'plans').normalize('NFC')
}

/**
 * Get or generate a word slug for the current session's plan.
 * The slug is generated lazily on first access and cached for the session.
 * If a plan file with the generated slug already exists, retries up to 10 times.
 */
export function getPlanSlug(sessionId?: SessionId): string {
  const id = sessionId ?? getSessionId()
  const cache = getPlanSlugCache()
  let slug = cache.get(id)
  if (!slug) {
    const plansDir = getPlansDirectory()
    // Try to find a unique slug that doesn't conflict with existing files
    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
      slug = generateWordSlug()
      const filePath = join(plansDir, `${slug}.md`)
      if (!getFsImplementation().existsSync(filePath)) {
        break
      }
    }
    cache.set(id, slug!)
  }
  return slug!
}

/**
 * Set a specific plan slug for a session (used when resuming a session)
 */
export function setPlanSlug(sessionId: SessionId, slug: string): void {
  getPlanSlugCache().set(sessionId, slug)
}

/**
 * Clear the plan slug for the current session.
 * This should be called on /clear to ensure a fresh plan file is used.
 */
export function clearPlanSlug(sessionId?: SessionId): void {
  const id = sessionId ?? getSessionId()
  getPlanSlugCache().delete(id)
}

/**
 * Clear ALL plan slug entries (all sessions).
 * Use this on /clear to free sub-session slug entries.
 */
export function clearAllPlanSlugs(): void {
  getPlanSlugCache().clear()
}

// Memoized: called from render bodies (FileReadTool/FileEditTool/FileWriteTool UI.tsx)
// and permission checks. Inputs (initial settings + cwd) are fixed at startup, so the
// mkdirSync result is stable for the session. Without memoization, each rendered tool
// message triggers a mkdirSync syscall (regressed in #20005).
export const getPlansDirectory = memoize(function getPlansDirectory(): string {
  const settings = getInitialSettings()
  const settingsDir = settings.plansDirectory
  let plansPath: string

  if (settingsDir) {
    // Settings.json (relative to project root)
    const cwd = getCwd()
    const resolved = resolve(cwd, settingsDir)

    // Validate path stays within project root to prevent path traversal
    if (!resolved.startsWith(cwd + sep) && resolved !== cwd) {
      logError(
        new Error(`plansDirectory must be within project root: ${settingsDir}`),
      )
      plansPath = getDefaultPlansDirectory()
    } else {
      plansPath = resolved
    }
  } else {
    // Default
    plansPath = getDefaultPlansDirectory()
  }

  // Ensure directory exists (mkdirSync with recursive: true is a no-op if it exists)
  try {
    getFsImplementation().mkdirSync(plansPath)
  } catch (error) {
    logError(error)
  }

  return plansPath
})

/**
 * Escape the path separators an agent ID may legitimately contain so it always
 * lands in a single filename component.
 *
 * A teammate's ID is `{name}@{teamName}`, and neither producer strips
 * separators from the team name, so a team called `a/b` would otherwise emit
 * `{slug}-agent-writer@a/b.md` -- a path in a *subdirectory* of the plans dir,
 * not a plan file. Percent-escaping is reversible and leaves every ordinary ID
 * (which contains none of these characters) byte-identical, so existing plan
 * files keep their paths.
 *
 * Exported for testing.
 */
export function encodeAgentIdForPlanFile(agentId: string): string {
  return agentId
    .replaceAll('%', '%25')
    .replaceAll('/', '%2F')
    .replaceAll('\\', '%5C')
}

/**
 * Inverse of {@link encodeAgentIdForPlanFile}. The escapes must be undone in the
 * reverse order they were applied -- `%25` last -- so a literal `%2F` in the id
 * (encoded as `%252F`) is not mis-decoded to `/`.
 *
 * Exported for testing.
 */
export function decodeAgentIdForPlanFile(encoded: string): string {
  return encoded
    .replaceAll('%5C', '\\')
    .replaceAll('%2F', '/')
    .replaceAll('%25', '%')
}

/**
 * Whether a `{slug}-agent-` filename component is exactly what
 * {@link encodeAgentIdForPlanFile} would emit -- i.e. a canonical plan path.
 *
 * The encoder only ever produces the escapes `%25`, `%2F`, `%5C` and no raw
 * separators, so a component is canonical iff re-encoding its decode reproduces
 * it byte-for-byte. This rejects lookalikes that `getPlanFilePath` never emits:
 * a raw separator (`writer@a%2Fb` decodes to `writer@a/b`, whose canonical form
 * is `writer@a%252Fb`), or a raw/partial `%` such as `writer@100%` (canonical
 * form `writer@100%25`). Both would otherwise pass a naive separator-only check
 * and grant unprompted read/write to a sibling `.md` outside this session's plan.
 *
 * Exported for testing.
 */
export function isCanonicalPlanFileEncoding(component: string): boolean {
  return (
    component.length > 0 &&
    encodeAgentIdForPlanFile(decodeAgentIdForPlanFile(component)) === component
  )
}

/**
 * Get the file path for a session's plan
 * @param agentId Optional agent ID for subagents. If not provided, returns main session plan.
 * For main conversation (no agentId), returns {planSlug}.md
 * For subagents (agentId provided), returns
 * {AGENT_PLANS_SUBDIR}/{planSlug}-agent-{encodedAgentId}.md
 */
export function getPlanFilePath(agentId?: AgentId): string {
  const planSlug = getPlanSlug(getSessionId())

  // Main conversation: simple filename with word slug
  if (!agentId) {
    return join(getPlansDirectory(), `${planSlug}.md`)
  }

  // Subagents: include agent ID, in the dedicated subdirectory that keeps the
  // escaped filename namespace disjoint from legacy plans (see AGENT_PLANS_SUBDIR).
  const agentPlansDir = join(getPlansDirectory(), AGENT_PLANS_SUBDIR)
  try {
    getFsImplementation().mkdirSync(agentPlansDir)
  } catch (error) {
    logError(error)
  }
  return join(
    agentPlansDir,
    `${planSlug}-agent-${encodeAgentIdForPlanFile(agentId)}.md`,
  )
}

/**
 * Get the plan content for a session
 * @param agentId Optional agent ID for subagents. If not provided, returns main session plan.
 */
export function getPlan(agentId?: AgentId): string | null {
  const filePath = getPlanFilePath(agentId)
  let contents: string
  try {
    contents = getFsImplementation().readFileSync(filePath, {
      encoding: 'utf-8',
    })
  } catch (error) {
    if (!isENOENT(error)) {
      logError(error)
      return null
    }
    return readLegacyUnescapedPlan(agentId, filePath)
  }
  // An empty/whitespace escaped file is not a real plan. isPlanFilePath allows a
  // direct FileWrite/FileEdit to the canonical escaped path before migration has
  // run, and such a stub would otherwise permanently shadow a legacy plan that
  // still holds the real content. Fall through to legacy recovery in that case;
  // recovery's no-clobber guard returns the legacy contents without renaming
  // over the stub, so a genuine concurrent escaped write is never lost.
  if (contents.trim() === '') {
    const legacy = readLegacyUnescapedPlan(agentId, filePath)
    if (legacy !== null) return legacy
  }
  return contents
}

/**
 * Whether a legacy plan path (built from an unescaped, attacker-influenced
 * agent id) still resolves inside the plans directory after `..` collapse.
 *
 * Exported for testing.
 */
export function isPathWithinPlansDir(
  candidatePath: string,
  plansDir: string,
): boolean {
  return candidatePath === plansDir || candidatePath.startsWith(plansDir + sep)
}

/**
 * Like {@link isPathWithinPlansDir} but resolves symlinks. The lexical check
 * above cannot see a symlinked intermediate directory (e.g. a slash-bearing
 * legacy id `writer@a/b` whose `{slug}-agent-writer@a` parent is a symlink to
 * outside the plans dir); recovery would then read/migrate through it. Resolve
 * the deepest existing ancestor of the legacy path and require it to stay inside
 * the resolved plans directory.
 *
 * Exported for testing.
 */
export function isResolvedPathWithinPlansDir(
  candidatePath: string,
  plansDir: string,
): boolean {
  const fs = getFsImplementation()
  let realPlansDir: string
  try {
    realPlansDir = fs.realpathSync(plansDir)
  } catch {
    return false
  }
  let probe = candidatePath
  for (;;) {
    try {
      const real = fs.realpathSync(probe)
      return real === realPlansDir || real.startsWith(realPlansDir + sep)
    } catch (error) {
      if (!isENOENT(error)) return false
      const parent = dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/**
 * Read a path that must be a regular file, proving the object did not change
 * across the read. A pathname pre-check (`lstat`) followed by a separate
 * `readFileSync` is a TOCTOU: an attacker who can write the plans directory can
 * swap the checked regular file for a symlink in the gap, so recovery would
 * read the link target. Without a no-follow file handle in the fs abstraction we
 * instead bracket the read with `lstat` and require the same inode/device and a
 * regular file both before and after -- so a swap in the window is detected and
 * the read is discarded rather than trusted.
 */
function readRegularFileStable(path: string): string | null {
  const fs = getFsImplementation()
  let before: Stats
  try {
    before = fs.lstatSync(path)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
  if (!before.isFile()) return null

  let contents: string
  try {
    contents = fs.readFileSync(path, { encoding: 'utf-8' })
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }

  let after: Stats
  try {
    after = fs.lstatSync(path)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
  if (
    !after.isFile() ||
    after.ino !== before.ino ||
    after.dev !== before.dev
  ) {
    return null
  }
  return contents
}

export function readAndMigrateLegacyPlan(
  legacyPath: string,
  escapedPath: string,
): string | null {
  if (legacyPath === escapedPath) return null

  const fs = getFsImplementation()

  // SECURITY: recovery reads and then migrates this path, so it must be a real
  // regular file. A symlink planted at the legacy slot would otherwise let
  // recovery return the contents of an arbitrary target outside the plans
  // directory. Capture the file identity up front; the migration below pins that
  // inode via an atomic hard link so a later swap cannot redirect the read.
  let legacyStat: Stats
  try {
    legacyStat = fs.lstatSync(legacyPath)
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
  if (!legacyStat.isFile()) return null

  // Genuine no-clobber move: `linkSync` fails with EEXIST if the escaped path
  // already exists, so it never replaces a live plan the way a check-then-act
  // `existsSync` + `renameSync` would under a concurrent writer. On success the
  // escaped name is a hard link to the exact inode we just lstat'd, immune to a
  // symlink swap of the legacy pathname.
  try {
    fs.linkSync(legacyPath, escapedPath)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return null
    if (code === 'EEXIST') {
      // A live plan is already at the escaped path: do not migrate. Return the
      // legacy contents (read with swap detection) without touching either file.
      return readRegularFileStable(legacyPath)
    }
    // Hard links may be unsupported (e.g. cross-device, some Windows FS). Fall
    // back to reading the legacy file in place without migrating.
    logForDebugging(
      `Could not link legacy plan file ${legacyPath} to ${escapedPath}: ${error instanceof Error ? error.message : error}`,
      { level: 'warn' },
    )
    return readRegularFileStable(legacyPath)
  }

  // Confirm the linked inode is the regular file we captured -- a swap between
  // the lstat and the link would otherwise pin an attacker's object.
  try {
    const linked = fs.lstatSync(escapedPath)
    if (
      !linked.isFile() ||
      linked.ino !== legacyStat.ino ||
      linked.dev !== legacyStat.dev
    ) {
      try {
        fs.unlinkSync(escapedPath)
      } catch {
        // best effort
      }
      return null
    }
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }

  // Read from the pinned escaped hard link, then drop the legacy name to
  // complete the move. Reading the link (not legacyPath) means a swap of the
  // legacy pathname after this point cannot affect the returned contents.
  let contents: string
  try {
    contents = fs.readFileSync(escapedPath, { encoding: 'utf-8' })
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return null
  }
  try {
    fs.unlinkSync(legacyPath)
  } catch (error) {
    logForDebugging(
      `Could not remove legacy plan file ${legacyPath} after migration: ${error instanceof Error ? error.message : error}`,
      { level: 'warn' },
    )
  }
  return contents
}

/**
 * Recover a plan written before agent IDs were escaped into the filename,
 * confining the read/rename to a legitimate per-agent slot inside the plans dir.
 *
 * Exported for testing.
 */
export function readLegacyUnescapedPlan(
  agentId: AgentId | undefined,
  escapedPath: string,
  plansDir: string = getPlansDirectory(),
  slug: string = getPlanSlug(getSessionId()),
): string | null {
  if (!agentId) return null
  // SECURITY: agentId is intentionally left unescaped here so the pre-escape
  // filename can be recovered, so it can still carry `/`, `\`, or `..`. A `..`
  // segment lets join() climb back into the plans dir onto a *different* plan
  // (`a/../{slug}` -> the main plan; `a/../{slug}-agent-victim` -> a sibling),
  // which the migrate step would then read and rename -- moving another agent's
  // file. Reject any traversal segment before building the path.
  //
  // Split on the host platform's real separators: on POSIX only `/` is a
  // separator, and `\` is a legal filename character, so a legitimate legacy id
  // such as `a\..\b` was persisted as one flat filename and must still recover.
  // On Windows both `/` and `\` are separators (keep that safeguard).
  const traversalSeparators = sep === '\\' ? /[/\\]/ : /\//
  if (agentId.split(traversalSeparators).includes('..')) return null

  const legacyPath = join(plansDir, `${slug}-agent-${agentId}.md`)
  // Defense in depth: the legacy file must still sit inside the plans dir and
  // under this session's `{slug}-agent-` prefix after separator collapse, so a
  // stray path can never resolve onto the main plan or another agent's file.
  const agentPrefix = join(plansDir, `${slug}-agent-`)
  if (!isPathWithinPlansDir(legacyPath, plansDir)) return null
  if (!legacyPath.startsWith(agentPrefix)) return null
  // SECURITY: a slash-bearing legacy id lands the file under an intermediate
  // directory; if that directory is a symlink the lexical checks above still
  // pass. Require the resolved path to stay inside the plans dir before reading.
  if (!isResolvedPathWithinPlansDir(legacyPath, plansDir)) return null
  return readAndMigrateLegacyPlan(legacyPath, escapedPath)
}

/**
 * Extract the plan slug from a log's message history.
 */
function getSlugFromLog(log: LogOption): string | undefined {
  return log.messages.find(m => m.slug)?.slug
}

/**
 * Restore plan slug from a resumed session.
 * Sets the slug in the session cache so getPlanSlug returns it.
 * If the plan file is missing, attempts to recover it from a file snapshot
 * (written incrementally during the session) or from message history.
 * Returns true if a plan file exists (or was recovered) for the slug.
 * @param log The log to restore from
 * @param targetSessionId The session ID to associate the plan slug with.
 *                        This should be the ORIGINAL session ID being resumed,
 *                        not the temporary session ID from before resume.
 */
export async function copyPlanForResume(
  log: LogOption,
  targetSessionId?: SessionId,
): Promise<boolean> {
  const slug = getSlugFromLog(log)
  if (!slug) {
    return false
  }

  // Set the slug for the target session ID (or current if not provided)
  const sessionId = targetSessionId ?? getSessionId()
  setPlanSlug(sessionId, slug)

  // Attempt to read the plan file directly — recovery triggers on ENOENT.
  const planPath = join(getPlansDirectory(), `${slug}.md`)
  try {
    await getFsImplementation().readFile(planPath, { encoding: 'utf-8' })
    return true
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      // Don't throw — called fire-and-forget (void copyPlanForResume(...)) with no .catch()
      logError(e)
      return false
    }
    // Only attempt recovery in remote sessions (CCR) where files don't persist
    if (getEnvironmentKind() === null) {
      return false
    }

    logForDebugging(
      `Plan file missing during resume: ${planPath}. Attempting recovery.`,
    )

    // Try file snapshot first (written incrementally during session)
    const snapshotPlan = findFileSnapshotEntry(log.messages, 'plan')
    let recovered: string | null = null
    if (snapshotPlan && snapshotPlan.content.length > 0) {
      recovered = snapshotPlan.content
      logForDebugging(
        `Plan recovered from file snapshot, ${recovered.length} chars`,
        { level: 'info' },
      )
    } else {
      // Fall back to searching message history
      recovered = recoverPlanFromMessages(log)
      if (recovered) {
        logForDebugging(
          `Plan recovered from message history, ${recovered.length} chars`,
          { level: 'info' },
        )
      }
    }

    if (recovered) {
      try {
        await writeFile(planPath, recovered, { encoding: 'utf-8' })
        return true
      } catch (writeError) {
        logError(writeError)
        return false
      }
    }
    logForDebugging(
      'Plan file recovery failed: no file snapshot or plan content found in message history',
    )
    return false
  }
}

/**
 * Copy a plan file for a forked session. Unlike copyPlanForResume (which reuses
 * the original slug), this generates a NEW slug for the forked session and
 * writes the original plan content to the new file. This prevents the original
 * and forked sessions from clobbering each other's plan files.
 */
export async function copyPlanForFork(
  log: LogOption,
  targetSessionId: SessionId,
): Promise<boolean> {
  const originalSlug = getSlugFromLog(log)
  if (!originalSlug) {
    return false
  }

  const plansDir = getPlansDirectory()
  const originalPlanPath = join(plansDir, `${originalSlug}.md`)

  // Generate a new slug for the forked session (do NOT reuse the original)
  const newSlug = getPlanSlug(targetSessionId)
  const newPlanPath = join(plansDir, `${newSlug}.md`)
  try {
    await copyFile(originalPlanPath, newPlanPath)
    return true
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    logError(error)
    return false
  }
}

/**
 * Recover plan content from the message history. Plan content can appear in
 * three forms depending on what happened during the session:
 *
 * 1. ExitPlanMode tool_use input — normalizeToolInput injects the plan content
 *    into the tool_use input, which persists in the transcript.
 *
 * 2. planContent field on user messages — set during the "clear context and
 *    implement" flow when ExitPlanMode is approved.
 *
 * 3. plan_file_reference attachment — created by auto-compact to preserve the
 *    plan across compaction boundaries.
 */
function recoverPlanFromMessages(log: LogOption): string | null {
  for (let i = log.messages.length - 1; i >= 0; i--) {
    const msg = log.messages[i]
    if (!msg) {
      continue
    }

    if (msg.type === 'assistant') {
      const { content } = (msg as AssistantMessage).message
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            block.name === EXIT_PLAN_MODE_V2_TOOL_NAME
          ) {
            const input = block.input as Record<string, unknown> | undefined
            const plan = input?.plan
            if (typeof plan === 'string' && plan.length > 0) {
              return plan
            }
          }
        }
      }
    }

    if (msg.type === 'user') {
      const userMsg = msg as UserMessage
      if (
        typeof userMsg.planContent === 'string' &&
        userMsg.planContent.length > 0
      ) {
        return userMsg.planContent
      }
    }

    if (msg.type === 'attachment') {
      const attachmentMsg = msg as AttachmentMessage
      if (attachmentMsg.attachment?.type === 'plan_file_reference') {
        const plan = (attachmentMsg.attachment as { planContent?: string })
          .planContent
        if (typeof plan === 'string' && plan.length > 0) {
          return plan
        }
      }
    }
  }
  return null
}

/**
 * Find a file entry in the most recent file-snapshot system message in the transcript.
 * Scans backwards to find the latest snapshot.
 */
function findFileSnapshotEntry(
  messages: LogOption['messages'],
  key: string,
): { key: string; path: string; content: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (
      msg?.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'file_snapshot' &&
      'snapshotFiles' in msg
    ) {
      const files = msg.snapshotFiles as Array<{
        key: string
        path: string
        content: string
      }>
      return files.find(f => f.key === key)
    }
  }
  return undefined
}

/**
 * Persist a snapshot of session files (plan, todos) to the transcript.
 * Called incrementally whenever these files change. Only active in remote
 * sessions (CCR) where local files don't persist between sessions.
 */
export async function persistFileSnapshotIfRemote(): Promise<void> {
  if (getEnvironmentKind() === null) {
    return
  }
  try {
    const snapshotFiles: SystemFileSnapshotMessage['snapshotFiles'] = []

    // Snapshot plan file
    const plan = getPlan()
    if (plan) {
      snapshotFiles.push({
        key: 'plan',
        path: getPlanFilePath(),
        content: plan,
      })
    }

    if (snapshotFiles.length === 0) {
      return
    }

    const message: SystemFileSnapshotMessage = {
      type: 'system',
      subtype: 'file_snapshot',
      content: 'File snapshot',
      level: 'info',
      isMeta: true,
      timestamp: new Date().toISOString(),
      uuid: randomUUID(),
      snapshotFiles,
    }

    const { recordTranscript } = await import('./sessionStorage.js')
    await recordTranscript([message])
  } catch (error) {
    logError(error)
  }
}
