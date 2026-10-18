// Walk src/, tests/, scripts/ and report `any` usage by category.
// Produces reports/any-usage.{json,md} and a budget gate against
// reports/any-usage.baseline.json.
//
// Part of the phased `any`-reduction work landing on fix/reduce-any-types.

import { mkdir, readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'

const ROOT = process.cwd()
const REPORT_DIR = resolve(ROOT, 'reports')
const JSON_OUT = resolve(REPORT_DIR, 'any-usage.json')
const MD_OUT = resolve(REPORT_DIR, 'any-usage.md')
const BASELINE_PATH = resolve(REPORT_DIR, 'any-usage.baseline.json')

const SCAN_DIRS = ['src', 'tests', 'scripts']
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'vendor',
  'web',
  'vscode-extension',
  'coverage',
  'reports',
])

type CategoryCounts = {
  annotation: number
  cast: number
  indexSig: number
  ignore: number
  genericArg: number
}

type FileReport = {
  path: string
  total: number
  byCategory: CategoryCounts
}

type Report = {
  generatedAt: string
  total: number
  byCategory: CategoryCounts
  files: FileReport[]
}

// Regexes (each match counted; multi-line `m`, no `g` so we don't loop with /lastIndex).
// Match `any` as a complete identifier (avoid `many`, `company`, etc.).
const ANNOTATION_RE = /(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/m
// `: any` annotation including optional whitespace.
const ANNOTATION_NEAR_RE = /:\s*(?<![A-Za-z0-9_$.])any(?![A-Za-z0-9_$])/m
const CAST_RE = /\bas\s+(?<![A-Za-z0-9_$.])any(?![A-Za-z0-9_$])/m
const INDEX_SIG_RE = /\[\s*(?:k?e?y?[^:\]]*:\s*[^:\]]*)?:\s*(?<![A-Za-z0-9_$.])any(?![A-Za-z0-9_$])/m
const IGNORE_RE = /\/\/\s*@(ts-ignore|ts-expect-error|ts-nocheck)\b/m
const GENERIC_RE = /<[^>]*\bany\b[^>]*>/m

function emptyCategory(): CategoryCounts {
  return { annotation: 0, cast: 0, indexSig: 0, ignore: 0, genericArg: 0 }
}

async function walk(dir: string, out: string[]): Promise<void> {
  const { readdir, lstat } = await import('fs/promises')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    // Propagate enumeration failures so a partial scan doesn't silently
    // report a too-low count. The caller wraps this in a try and exits
    // nonzero with the original error.
    throw new Error(`readdir failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`)
  }
  for (const name of entries) {
    if (EXCLUDE_DIR_NAMES.has(name)) continue
    const full = resolve(dir, name)
    // Use lstat so we don't follow symlinks — a self-referencing link would
    // recurse forever and stall the budget check.
    const st = await lstat(full)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      await walk(full, out)
    } else if (/\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
}

// Replace the contents of comments, strings, and template literals with
// spaces of equal length so the type-annotation regex only matches real
// TypeScript code. Newlines and offsets are preserved so report line numbers
// stay correct.
function stripNonCode(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    const c2 = i + 1 < n ? source[i + 1] : ''
    // Block comment /* ... */ — preserve @ts-ignore markers in IGNORE_RE
    // by NOT stripping the directive prefix; IGNORE_RE only matches
    // `// @ts-...` (line) so block comments are safe to fully strip.
    if (c === '/' && c2 === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) {
        out += ' '.repeat(n - i)
        i = n
        break
      }
      // Replace with spaces, keep newlines so line numbers stay stable.
      for (let j = i; j < end + 2; j++) {
        out += source[j] === '\n' ? '\n' : ' '
      }
      i = end + 2
      continue
    }
    // Line comment — keep `// @ts-...` markers for IGNORE_RE; strip the
    // rest of the line. This preserves the existing ignore-directive
    // accounting while still excluding `: any` in prose.
    if (c === '/' && c2 === '/') {
      // Find next newline
      let end = i
      while (end < n && source[end] !== '\n') end++
      const segment = source.slice(i, end)
      const isDirective = /^\s*\/\/\s*@(ts-ignore|ts-expect-error|ts-nocheck)\b/.test(segment)
      if (isDirective) {
        out += segment
      } else {
        out += ' '.repeat(segment.length)
      }
      i = end
      continue
    }
    // String literals
    if (c === '"' || c === "'") {
      const quote = c
      let end = i + 1
      while (end < n) {
        if (source[end] === '\\' && end + 1 < n) {
          end += 2
          continue
        }
        if (source[end] === quote) {
          end++
          break
        }
        if (source[end] === '\n') {
          // Unterminated string — bail and keep the rest verbatim.
          break
        }
        end++
      }
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    // Template literal — simpler handling: strip ${...} interpolation
    // contents as well, since the inner expression has its own type scope.
    if (c === '`') {
      let end = i + 1
      while (end < n && source[end] !== '`') {
        if (source[end] === '\\' && end + 1 < n) {
          end += 2
          continue
        }
        if (source[end] === '$' && source[end + 1] === '{') {
          // Strip interpolation body
          let depth = 1
          end += 2
          while (end < n && depth > 0) {
            if (source[end] === '{') depth++
            else if (source[end] === '}') depth--
            if (depth > 0) end++
          }
          continue
        }
        end++
      }
      if (end < n) end++ // consume closing `
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    out += c
    i++
  }
  return out
}

function countMatches(source: string, re: RegExp): number {
  // Rebuild with `g` for counting while preserving the anchored pattern.
  const flags = re.flags.replace('g', '') + 'g'
  const global = new RegExp(re.source, flags)
  let n = 0
  while (global.exec(source) !== null) {
    n++
    if (global.lastIndex === 0) break
  }
  return n
}

function categorize(source: string): CategoryCounts {
  const counts = emptyCategory()
  counts.annotation = countMatches(source, ANNOTATION_NEAR_RE)
  counts.cast = countMatches(source, CAST_RE)
  counts.indexSig = countMatches(source, INDEX_SIG_RE)
  counts.ignore = countMatches(source, IGNORE_RE)
  counts.genericArg = countMatches(source, GENERIC_RE)
  return counts
}

function totalOf(c: CategoryCounts): number {
  return c.annotation + c.cast + c.indexSig + c.ignore + c.genericArg
}

async function scan(): Promise<Report> {
  const files: FileReport[] = []
  const totals = emptyCategory()
  for (const dir of SCAN_DIRS) {
    const root = resolve(ROOT, dir)
    const found: string[] = []
    await walk(root, found)
    for (const absPath of found) {
      const raw = await readFile(absPath, 'utf8')
      // Strip comments, strings, and template literals so `: any` in prose
      // and `': any'` literals don't count as type annotations.
      const source = stripNonCode(raw)
      if (!ANNOTATION_RE.test(source) && !CAST_RE.test(source) && !IGNORE_RE.test(source)) {
        continue
      }
      const byCategory = categorize(source)
      const total = totalOf(byCategory)
      if (total === 0) continue
      files.push({
        path: absPath.slice(ROOT.length + 1),
        total,
        byCategory,
      })
      for (const k of Object.keys(totals) as (keyof CategoryCounts)[]) {
        totals[k] += byCategory[k]
      }
    }
  }
  files.sort((a, b) => b.total - a.total)
  return {
    generatedAt: new Date().toISOString(),
    total: totalOf(totals),
    byCategory: totals,
    files,
  }
}

function renderMarkdown(report: Report, baselineTotal: number | null): string {
  const lines: string[] = []
  lines.push('# `any` Usage Report')
  lines.push('')
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push('')
  lines.push('## Totals')
  lines.push('')
  lines.push(`| Category | Count |`)
  lines.push(`| --- | ---: |`)
  lines.push(`| \`: any\` annotation | ${report.byCategory.annotation} |`)
  lines.push(`| \`as any\` cast | ${report.byCategory.cast} |`)
  lines.push(`| \`[key: ...]: any\` index signature | ${report.byCategory.indexSig} |`)
  lines.push(`| \`// @ts-ignore\` (and friends) | ${report.byCategory.ignore} |`)
  lines.push(`| Generic \`any\` arg | ${report.byCategory.genericArg} |`)
  lines.push(`| **Total** | **${report.total}** |`)
  if (baselineTotal !== null) {
    const delta = report.total - baselineTotal
    const sign = delta > 0 ? '+' : ''
    lines.push('')
    lines.push(`Baseline: ${baselineTotal}  Delta: ${sign}${delta}`)
  }
  lines.push('')
  lines.push(`## Top offenders (${Math.min(20, report.files.length)} of ${report.files.length})`)
  lines.push('')
  lines.push('| File | Total | Annot | Cast | IndexSig | Ignore | Generic |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const f of report.files.slice(0, 20)) {
    lines.push(
      `| ${f.path} | ${f.total} | ${f.byCategory.annotation} | ${f.byCategory.cast} | ${f.byCategory.indexSig} | ${f.byCategory.ignore} | ${f.byCategory.genericArg} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

async function readBaselineTotal(): Promise<number | null> {
  try {
    const raw = await readFile(BASELINE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Report
    return typeof parsed.total === 'number' ? parsed.total : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check')
  await mkdir(REPORT_DIR, { recursive: true })

  const report = await scan()
  const baselineTotal = await readBaselineTotal()

  await writeFile(JSON_OUT, JSON.stringify(report, null, 2) + '\n')
  await writeFile(MD_OUT, renderMarkdown(report, baselineTotal))

  // Always refresh baseline file unless --check (we don't want CI to clobber it).
  if (!checkMode) {
    await writeFile(BASELINE_PATH, JSON.stringify({ total: report.total, generatedAt: report.generatedAt }, null, 2) + '\n')
  }

  if (checkMode) {
    if (baselineTotal === null) {
      console.error(`any-usage baseline is missing or invalid: ${BASELINE_PATH}`)
      process.exit(1)
    }
    if (report.total > baselineTotal) {
      console.error(
        `any-usage budget exceeded: current=${report.total} > baseline=${baselineTotal} (delta=+${report.total - baselineTotal})`,
      )
      process.exit(1)
    }
    console.log(`any-usage budget ok: current=${report.total} baseline=${baselineTotal}`)
    return
  }

  console.log(`any-usage report written: total=${report.total} files=${report.files.length}`)
}

await main()