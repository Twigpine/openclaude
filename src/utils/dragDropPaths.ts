import { existsSync } from 'fs'
import { isAbsolute } from 'path'

// Inlined to avoid pulling the full `imagePaste.ts` module (which imports
// `bun:bundle`) into this file's dependency graph. Must stay in sync with
// `IMAGE_EXTENSION_REGEX` in `./imagePaste.ts`.
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

/**
 * Detect absolute file paths in pasted text (typically from drag-and-drop).
 * Returns the cleaned paths if ALL segments are existing non-image files,
 * or an empty array otherwise.
 *
 * Split before absolute paths, including quoted paths, and at newlines.
 */
export function extractDraggedFilePaths(text: string): string[] {
  const segments = text
    .split(/ (?=["']?(?:\/|[A-Za-z]:\\))/)
    .flatMap(part => part.split('\n'))
    .map(s => s.trim())
    .filter(Boolean)

  if (segments.length === 0) return []

  const cleaned: string[] = []

  for (const raw of segments) {
    // Strip outer quotes and shell-escape backslashes
    let p = raw
    if (
      (p.startsWith('"') && p.endsWith('"')) ||
      (p.startsWith("'") && p.endsWith("'"))
    ) {
      p = p.slice(1, -1)
    }
    if (process.platform !== 'win32') {
      p = p.replace(/\\(.)/g, '$1')
    }

    // Image files are handled by the upstream image paste handler.
    // Check against the cleaned path so quoted/escaped image paths like
    // `"/foo/shot.png"` or `/foo/my\ shot.png` are reliably excluded.
    if (IMAGE_EXTENSION_REGEX.test(p)) return []
    if (!isAbsolute(p)) return []
    // Verify the path actually exists on disk. Plain `fs.existsSync` is
    // used intentionally here instead of the wrapped `getFsImplementation`
    // to keep this module free of the heavy `fsOperations` dependency
    // chain — this is a pure existence check with no permission semantics.
    if (!existsSync(p)) return []
    cleaned.push(p)
  }

  return cleaned
}
