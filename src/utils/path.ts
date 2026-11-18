import { homedir } from 'os'
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'path'
import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

/**
 * Expands a path that may contain tilde notation (~) to an absolute path.
 *
 * On Windows, POSIX-style paths (e.g., `/c/Users/...`) are automatically converted
 * to Windows format (e.g., `C:\Users\...`). The function always returns paths in
 * the native format for the current platform.
 *
 * @param path - The path to expand, may contain:
 *   - `~` - expands to user's home directory
 *   - `~/path` - expands to path within user's home directory
 *   - absolute paths - returned normalized
 *   - relative paths - resolved relative to baseDir
 *   - POSIX paths on Windows - converted to Windows format
 * @param baseDir - The base directory for resolving relative paths (defaults to current working directory)
 * @returns The expanded absolute path in the native format for the current platform
 *
 * @throws {Error} If path is invalid
 *
 * @example
 * expandPath('~') // '/home/user'
 * expandPath('~/Documents') // '/home/user/Documents'
 * expandPath('./src', '/project') // '/project/src'
 * expandPath('/absolute/path') // '/absolute/path'
 */
export function expandPath(path: string, baseDir?: string): string {
  // Set default baseDir to getCwd() if not provided
  const actualBaseDir = baseDir ?? getCwd() ?? getFsImplementation().cwd()

  // Input validation
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof path}`)
  }

  if (typeof actualBaseDir !== 'string') {
    throw new TypeError(
      `Base directory must be a string, received ${typeof actualBaseDir}`,
    )
  }

  // Security: Check for null bytes
  if (path.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  // Handle empty or whitespace-only paths
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize('NFC')
  }

  // Handle home directory notation
  if (trimmedPath === '~') {
    return homedir().normalize('NFC')
  }

  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  }

  // On Windows, convert POSIX-style paths (e.g., /c/Users/...) to Windows format
  let processedPath = trimmedPath
  if (getPlatform() === 'windows' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath)
    } catch {
      // If conversion fails, use original path
      processedPath = trimmedPath
    }
  }

  // Handle absolute paths
  if (isAbsolute(processedPath)) {
    return normalize(processedPath).normalize('NFC')
  }

  // Handle relative paths
  return resolve(actualBaseDir, processedPath).normalize('NFC')
}

/**
 * Converts an absolute path to a relative path from cwd, to save tokens in
 * tool output. If the path is outside cwd (relative path would start with ..),
 * returns the absolute path unchanged so it stays unambiguous.
 *
 * @param absolutePath - The absolute path to relativize
 * @returns Relative path if under cwd, otherwise the original absolute path
 */
export function toRelativePath(absolutePath: string): string {
  const relativePath = relative(getCwd(), absolutePath)
  // If the relative path would go outside cwd (starts with ..), keep absolute
  return relativePath.startsWith('..') ? absolutePath : relativePath
}

/**
 * Relativizes the file-path portion of a ripgrep content-mode line.
 *
 * A content row is `<absolute path><delimiter><rest>`, where the delimiter is
 * `:` / `:<n>:` for match rows and `-` / `-<n>-` for context rows (`-A`/`-B`/
 * `-C`). Locating that delimiter by inspection is unreliable on Windows: drive
 * colons, dashes inside directory/file names (e.g. a `proj-2024-01-15` cwd), and
 * line-number-less context rows (`path-content`, emitted when line numbers are
 * disabled) all defeat a delimiter heuristic.
 *
 * Instead we strip the known absolute search root. Every path ripgrep emits for
 * a search under the root begins with `<root><sep>`, so removing exactly that
 * prefix yields the relative path plus the original delimiter and content
 * verbatim — independent of the delimiter and of whether line numbers are on.
 * Paths not under the root keep their absolute form, matching {@link
 * toRelativePath}.
 *
 * @param line - A single ripgrep content line (match or context row)
 * @param root - The absolute search root to relativize against (defaults to the
 *   current working directory; injectable for deterministic tests)
 * @returns The line with its leading path made relative, or unchanged when the
 *   path is not under `root`
 */
export function relativizeContentLine(
  line: string,
  root: string = getCwd(),
): string {
  // Windows roots (drive-letter or backslash) compare case-insensitively and
  // treat `/` and `\` as equivalent — mirroring toRelativePath's path.win32
  // behavior — so `getCwd()` and ripgrep spelling the same root with different
  // casing/slashes still relativizes. POSIX roots compare exactly. We normalize
  // only for the comparison and slice the ORIGINAL line by the prefix length
  // (case/slash normalization preserves length), so content is returned verbatim.
  const isWindowsRoot = /^[A-Za-z]:[\\/]/.test(root) || root.includes('\\')
  const norm = (s: string): string =>
    isWindowsRoot ? s.toLowerCase().replace(/\//g, '\\') : s
  // Try both separators so the same logic works for Windows (`\`) and POSIX
  // (`/`) roots regardless of the host OS the tests run on. The trailing
  // separator is required so a sibling like `C:\proj2` is not treated as being
  // under `C:\proj`.
  for (const sep of ['/', '\\']) {
    const prefix = root.endsWith(sep) ? root : root + sep
    if (norm(line).startsWith(norm(prefix))) {
      return line.slice(prefix.length)
    }
  }
  return line
}

/**
 * Gets the directory path for a given file or directory path.
 * If the path is a directory, returns the path itself.
 * If the path is a file or doesn't exist, returns the parent directory.
 *
 * @param path - The file or directory path
 * @returns The directory path
 */
export function getDirectoryForPath(path: string): string {
  const absolutePath = expandPath(path)
  // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return dirname(absolutePath)
  }
  try {
    const stats = getFsImplementation().statSync(absolutePath)
    if (stats.isDirectory()) {
      return absolutePath
    }
  } catch {
    // Path doesn't exist or can't be accessed
  }
  // If it's not a directory or doesn't exist, return the parent directory
  return dirname(absolutePath)
}

/**
 * Checks if a path contains directory traversal patterns that navigate to parent directories.
 *
 * @param path - The path to check for traversal patterns
 * @returns true if the path contains traversal (e.g., '../', '..\', or ends with '..')
 */
export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
}

// Re-export from the shared zero-dep source.
export { sanitizePath } from './sessionStoragePortable.js'

/**
 * Normalizes a path for use as a JSON config key.
 * On Windows, paths can have inconsistent separators (C:\path vs C:/path)
 * depending on whether they come from git, Node.js APIs, or user input.
 * This normalizes to forward slashes for consistent JSON serialization.
 *
 * @param path - The path to normalize
 * @returns The normalized path with consistent forward slashes
 */
export function normalizePathForConfigKey(path: string): string {
  // First use Node's normalize to resolve . and .. segments
  const normalized = normalize(path)
  // Then convert all backslashes to forward slashes for consistent JSON keys
  // This is safe because forward slashes work in Windows paths for most operations
  return normalized.replace(/\\/g, '/')
}

/**
 * Lexical containment check: true when `child` is `dir` itself or nested
 * inside it. Cross-drive safe: on Windows, path.relative across drives
 * returns the target as an absolute path, which correctly reads as outside.
 * Does not resolve symlinks; canonicalize inputs first when that matters.
 */
export function isPathInsideDir(child: string, dir: string): boolean {
  const rel = relative(dir, child)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}
