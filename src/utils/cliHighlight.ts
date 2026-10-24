import chalk from 'chalk'
import { extname } from 'path'

export type CliHighlight = {
  highlight: (code: string, options: { language: string }) => string
  supportsLanguage: (name: string) => boolean
}

// Preserve the terminal palette used by the code and Markdown renderers.
// Unlisted tokens, including titles, parameters and substitutions, are plain.
const tokenStyles = new Map<string, (text: string) => string>([
  ['keyword', chalk.blue], ['literal', chalk.blue], ['class', chalk.blue],
  ['built_in', chalk.cyan], ['type', chalk.cyan.dim], ['attr', chalk.cyan],
  ['number', chalk.green], ['comment', chalk.green], ['doctag', chalk.green],
  ['addition', chalk.green], ['regexp', chalk.red], ['string', chalk.red],
  ['deletion', chalk.red], ['function', chalk.yellow], ['meta', chalk.gray],
  ['tag', chalk.gray], ['name', chalk.blue], ['emphasis', chalk.italic],
  ['strong', chalk.bold], ['link', chalk.underline],
])

const entities: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'",
}

// Only consume highlight.js's generated spans and its five escaped entities.
// Source markup is escaped by highlight.js, so it cannot become a span here.
// A stack preserves nested styles and unprefixed sublanguage spans without a
// general HTML parser. Keep the previous renderer's CR/LF and NUL handling.
function terminalHighlight(html: string): string {
  const stack: { token?: string; text: string }[] = [{ text: '' }]
  for (const part of html.replace(/\r\n?/g, '\n').replace(/\0/g, '')
    .split(/(<span class="[^"]*">|<\/span>)/g)) {
    if (part.startsWith('<span class="')) {
      stack.push({ token: /hljs-(\w+)/.exec(part)?.[1], text: '' })
    } else if (part === '</span>') {
      const frame = stack.pop()!
      const style = frame.token ? tokenStyles.get(frame.token) : undefined
      stack[stack.length - 1]!.text += style ? style(frame.text) : frame.text
    } else {
      stack[stack.length - 1]!.text += part.replace(
        /&(?:amp|lt|gt|quot|#x27);/g, entity => entities[entity]!,
      )
    }
  }
  return stack[0]!.text
}

// Share one lazy registry load across code, Markdown and telemetry consumers.
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

let loadedGetLanguage: typeof import('highlight.js').getLanguage | undefined

async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const highlightJs = await import('highlight.js')
    loadedGetLanguage = highlightJs.getLanguage
    return {
      highlight: (code, options) => terminalHighlight(
        highlightJs.highlight(code, options).value,
      ),
      supportsLanguage: name => Boolean(highlightJs.getLanguage(name)),
    }
  } catch {
    return null
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}

/**
 * Resolves a filename's extension to a language name after the shared load,
 * then reads highlight.js's language registry. All callers are telemetry
 * (OTel counter attributes, permission-dialog unary events) — none block
 * on this, they fire-and-forget or the consumer already handles Promise<string>.
 */
export async function getLanguageName(file_path: string): Promise<string> {
  await getCliHighlightPromise()
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  return loadedGetLanguage?.(ext)?.name ?? 'unknown'
}
