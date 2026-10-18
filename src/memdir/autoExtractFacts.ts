/**
 * Auto-extract facts from message content into memdir memory files.
 *
 * Ported from the knowledgeGraph-based fact extraction in conversationArc.ts.
 * Instead of calling addGlobalEntity(), this writes structured .md files
 * into the auto-memory directory with proper frontmatter.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { getAutoMemPath } from './paths.js'
import { isAutoMemoryEnabled } from './paths.js'
import { isMemoryWriteApprovalRequired } from '../utils/governancePolicy.js'
import {
  containsMemoryRedaction,
  looksLikeMemorySecretValue,
  sanitizeMemoryIdentifier,
  sanitizeMemoryText,
} from './memorySecurity.js'

const FACTS_SUBDIR = '.facts'

function ensureFactsDir(memoryDir: string): string | null {
  const dir = join(memoryDir, FACTS_SUBDIR)
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  } catch {
    // Memory directory may be read-only / permission-denied. Writes must
    // degrade non-fatally; the surrounding callers (query.ts) run this on
    // every turn and must not throw before the model request starts.
    return null
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (
    /^\/(etc|proc|sys|dev|var|tmp|root|boot|lost\+found|mnt|media|run|srv)\b/.test(normalized)
  ) {
    return true
  }
  if (
    /^[a-z]:\/(windows|system volume information|recovery)\b/.test(normalized)
  ) {
    return true
  }
  if (
    /\.(ssh|aws|docker|kube|gnupg|npmrc|netrc|pgpass|history)\b/.test(normalized)
  ) {
    return true
  }
  return false
}

// Opaque-secret heuristic: token-like identifiers (Diceware passphrases,
// hex blobs, mixed-case+digit tokens) must not become durable facts because
// they are later indexed and injected into prompts. Returns true when the
// segment looks like a secret/token rather than a meaningful name.
function looksLikeSecret(segment: string): boolean {
  const s = segment.trim()
  if (s.length === 0) return true
  if (looksLikeMemorySecretValue(s)) return true
  // Extra low-entropy cases the shared detector intentionally skips: pure
  // lowercase hex blobs and separator-joined lowercase tokens (e.g.
  // "super-secret-access-token") that are still opaque secrets.
  if (s.length >= 16 && /^[a-f0-9]+$/.test(s)) return true
  if (s.length >= 12 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(s)) return true
  return false
}

// Strip token-like path components from a URL path, keeping only the host and
// any benign structural segments. Returns null when every path segment is
// opaque (in which case the URL carries no durable signal worth persisting).
function scrubUrlPath(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean)
  const safeSegments: string[] = []
  for (const seg of segments) {
    if (looksLikeSecret(seg)) continue
    safeSegments.push(seg)
  }
  // Keep the scheme+host always; append only non-secret path components.
  return `${url.protocol}//${url.host}${safeSegments.length ? '/' + safeSegments.join('/') : ''}`
}

function yamlQuote(val: string): string {
  const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
  return `"${escaped}"`
}

function getShortHash(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return (hash >>> 0).toString(36).slice(0, 6)
}

function writeFactMemory(
  memoryDir: string,
  factType: string,
  name: string,
  description: string,
  attributes: Record<string, string> = {},
): boolean {
  // Treat this as the final security boundary, not merely a formatter. Every
  // extractor above operates on untrusted conversation text, and future
  // extractors must not be able to persist a credential by omitting a local
  // heuristic.
  const safeName = sanitizeMemoryIdentifier(name)
  if (!safeName) return false

  const safeDescriptionResult = sanitizeMemoryText(description)
  if (safeDescriptionResult.wholeSecret) return false
  const safeDescription = safeDescriptionResult.text

  const safeAttributes: Record<string, string> = {}
  for (const [key, value] of Object.entries(attributes)) {
    const safeKey = sanitizeMemoryIdentifier(key)
    if (!safeKey) continue
    const sanitizedValue = sanitizeMemoryText(value)
    if (sanitizedValue.wholeSecret) continue
    safeAttributes[safeKey] = sanitizedValue.text
  }

  const factsDir = ensureFactsDir(memoryDir)
  if (!factsDir) return false
  const slug = `${slugify(safeName)}-${getShortHash(safeName)}`
  const filename = `fact-${factType}-${slug}.md`
  const filePath = join(factsDir, filename)

  const now = new Date().toISOString()
  const content = `---
type: reference
title: ${yamlQuote(safeName)}
description: ${yamlQuote(safeDescription)}
factType: ${yamlQuote(factType)}
detectedAt: ${now}
${Object.keys(safeAttributes).length > 0 ? `attributes:\n${Object.entries(safeAttributes).map(([k, v]) => `  ${k}: ${yamlQuote(v)}`).join('\n')}` : ''}
---

Auto-detected fact: **${safeName}**

${safeDescription}

${Object.keys(safeAttributes).length > 0 ? `**Details:**\n${Object.entries(safeAttributes).map(([k, v]) => `- ${k}: ${v}`).join('\n')}` : ''}
`

  try {
    // Skip rewriting when the stable fact content is identical, ignoring the
    // volatile detectedAt timestamp, so repeated turns do not trigger
    // unnecessary rebuildIndex() calls (P1).
    if (existsSync(filePath) && stableFactContent(readFileSync(filePath, 'utf-8')) === stableFactContent(content)) {
      return false
    }
    writeFileSync(filePath, content, 'utf-8')
    return true
  } catch {
    // Fact write failures are non-fatal — continue without this fact.
    return false
  }
}

// Strips the volatile detectedAt line so byte-equality reflects semantic
// content only (P1).
function stableFactContent(raw: string): string {
  return raw.replace(/^detectedAt: .*$/m, 'detectedAt: <ignored>')
}

const MAX_FACTS_PER_CALL = 20

export async function extractFactsIntoMemdir(
  content: string,
  memoryDir?: string,
): Promise<boolean> {
  const dir = memoryDir || getAutoMemPath()
  if (!dir) return false

  // Respect the same memory-write approval policy as the rest of the memory
  // system. extractMemories() returns early when approval is required, so
  // automatic fact extraction must not silently persist conversation content
  // (paths, URLs, filenames, IPs, concepts) without the approval prompt.
  if (!isAutoMemoryEnabled() || isMemoryWriteApprovalRequired()) return false

  let factsWritten = 0
  const countsByType = new Map<string, number>()

  function cappedWrite(
    ...args: Parameters<typeof writeFactMemory>
  ): void {
    if (factsWritten >= MAX_FACTS_PER_CALL) return
    const factType = args[1]
    const typeLimit = (factType === 'concept' || factType === 'rule') ? 10 : 5
    const currentTypeCount = countsByType.get(factType) || 0
    if (currentTypeCount >= typeLimit) return

    if (writeFactMemory(...args)) {
      factsWritten++
      countsByType.set(factType, currentTypeCount + 1)
    }
  }

  // Value pattern: double-quoted, single-quoted, or bare non-whitespace.
  // Quoted alternatives come first so a multi-word value like "my secret"
  // is consumed as one unit and no word-tokens leak into scrubbedContent.
  const envValuePattern = `(?:${[
    '"[^"]*"',
    "'[^']*'",
    '[^\\s\\n]+',
  ].join('|')})`

  // Build scrubbed content for downstream extractors so env values (which may
  // contain secrets, paths, or code) are not re-extracted as concept facts.
  // Apply the repository's full secret redaction (known prefixes, JWTs, opaque
  // tokens, provider-specific values) so no credential reaches any extractor.
  const contentWithoutEnvValues = content.replace(
    new RegExp(`(?:export\\s+)?[A-Za-z_][A-Za-z_0-9]{2,}=${envValuePattern}`, 'g'),
    match => `${match.split('=')[0]}=[REDACTED]`,
  )
  const scrubbedContent = sanitizeMemoryText(contentWithoutEnvValues).text

  // 1. Detect Environment Variables (KEY=VALUE) — operates on raw content so
  //    the actual value is available for redaction metadata.
  //    Supports keys with digits and values wrapped in quotes.
  //    Aligned to support lowercase-leading keys as well.
  const envMatches = content.matchAll(
    new RegExp(`(?:export\\s+)?([A-Za-z_][A-Za-z_0-9]{2,})=${envValuePattern}`, 'g'),
  )
  for (const match of envMatches) {
    cappedWrite(dir, 'env', match[1], `${match[1]} environment variable`, { value: '[REDACTED]' })
  }

  // 2. Detect Absolute Paths — strip URLs first so path-like URL segments are not
  //    extracted as filesystem paths, then scan the remaining text.
  const noUrlContent = scrubbedContent.replace(/https?:\/\/[^\s\n]+/g, '')
  // Matches POSIX absolute paths, Windows drive-letter paths (C:\ or C:/), and UNC paths
  const pathRegex = /(?:\b[A-Za-z]:[\\/](?:[\w.-]+[\\/])+[\w.-]+|\\\\[\w.-]+\\(?:[\w.-]+\\)+[\w.-]+|(?<![\w.-])\/(?:[\w.-]+\/)+[\w.-]+)/g
  const pathMatches = noUrlContent.matchAll(pathRegex)
  for (const match of pathMatches) {
    const path = match[0]
    if (isSensitivePath(path)) continue

    const hasDrive = /^[A-Za-z]:[\\/]/.test(path)
    const hasUNC = path.startsWith('\\\\')
    const hasSlash = path.startsWith('/')
    const segs = path.replace(/^[A-Za-z]:[\\/]/, '').replace(/^\\\\/, '').split(/[\\/]/).filter(Boolean)
    const safeSegs = segs.filter(s => !looksLikeSecret(s))
    if (safeSegs.length === 0) continue

    const separator = path.includes('\\') ? '\\' : '/'
    let safePath = ''
    if (hasDrive) {
      safePath = path.slice(0, 3) + safeSegs.join(separator)
    } else if (hasUNC) {
      safePath = '\\\\' + safeSegs.join(separator)
    } else if (hasSlash) {
      safePath = '/' + safeSegs.join(separator)
    } else {
      safePath = safeSegs.join(separator)
    }

    if (safePath.length > 8 && !safePath.includes('node_modules')) {
      cappedWrite(dir, 'path', safePath, `Project path: ${safePath}`, { type: 'absolute' })
    }
  }

  // 3. Detect Versions
  const versionMatches = scrubbedContent.matchAll(/(?:v|version\s+)(\d+\.\d+(?:\.\d+)?)/gi)
  for (const match of versionMatches) {
    cappedWrite(dir, 'version', match[0].toLowerCase(), `Version ${match[1]}`, { semver: match[1] })
  }

  // 4. Detect Hostnames/URLs
  const urlMatches = scrubbedContent.matchAll(/(https?:\/\/[^\s\n"']+)/g)
  for (const match of urlMatches) {
    try {
      const url = new URL(match[1])
      if (url.hostname.includes('.')) {
        const safeUrl = scrubUrlPath(url)
        if (!safeUrl) continue
        cappedWrite(dir, 'endpoint', url.hostname, `Endpoint: ${url.hostname}`, { url: safeUrl })
      }
    } catch {
      /* ignore */
    }
  }

  // 5. Detect IPv4 — use a local context window for tagging
  const ipMatches = scrubbedContent.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)
  for (const match of ipMatches) {
    const ip = match[1]
    const octets = ip.split('.').map(Number)
    if (octets.some(o => o > 255)) continue
    const start = Math.max(0, (match.index ?? 0) - 80)
    const end = Math.min(scrubbedContent.length, (match.index ?? 0) + ip.length + 80)
    const localContext = scrubbedContent.slice(start, end).toLowerCase()
    const tags: Record<string, string> = { type: 'ipv4' }
    if (/\b(database|db)\b/.test(localContext)) tags.role = 'database'
    if (/\bprod\b/.test(localContext)) tags.env = 'production'
    if (/\bworker\b/.test(localContext)) tags.role = 'worker'
    cappedWrite(dir, 'ip', ip, `Server IP: ${ip}`, tags)
  }

  // 6. Detect backtick symbols — treat content as untrusted.
  // Only write backtick values that reliably look like technical identifiers.
  const backtickMatches = scrubbedContent.matchAll(/`([^`]+)`/g)
  for (const match of backtickMatches) {
    const symbol = match[1]
    if (symbol.length > 2 && symbol.length < 60) {
      if (!sanitizeMemoryIdentifier(symbol)) continue
      if (looksLikeSecret(symbol)) continue
      cappedWrite(dir, 'concept', symbol, `Technical concept: ${symbol}`, { source: 'backticks' })
    }
  }

  // 7. Detect Technical Concepts (PascalCase, camelCase, hyphenated)
  const technicalMatches = scrubbedContent.matchAll(
    /\b([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+|[A-Z][a-z]+[A-Z][\w]*|[a-z]+[A-Z][\w]*)\b/g,
  )
  const seen = new Set<string>()
  for (const match of technicalMatches) {
    const word = match[1]
    if (seen.has(word)) continue
    seen.add(word)
    // Reject hyphenated/token-like identifiers that look like secrets.
    if (looksLikeSecret(word)) continue
    if (!['The', 'This', 'That', 'With', 'From', 'Here', 'There'].includes(word)) {
      cappedWrite(dir, 'concept', word, `Technical term: ${word}`, { source: 'auto_discovery' })
    }
  }

  // 8. Specific tech detection
  if (scrubbedContent.toLowerCase().includes('redux'))
    cappedWrite(dir, 'tech', 'Redux', 'Redux state management', { category: 'state_management' })
  if (scrubbedContent.toLowerCase().includes('react'))
    cappedWrite(dir, 'tech', 'React', 'React frontend library', { category: 'frontend' })

  // 9. Project File Signatures
  const fileMatches = scrubbedContent.matchAll(/\b([\w.-]+\.(?:xml|json|yaml|yml|gradle|toml|bazel))\b/gi)
  for (const match of fileMatches) {
    cappedWrite(dir, 'file', match[1].toLowerCase(), `Project file: ${match[1]}`, { category: 'configuration' })
  }

  // 10. Passive project-rule extraction — restore the behavior the legacy
  //     conversation arc provided via addGlobalRule(): surface explicit
  //     directives ("Always use pnpm", "Never commit secrets", "Prefer SQLite
  //     WAL") as durable facts so they are injected into later prompts.
  //     Operates on scrubbedContent (not raw content) and rejects secret-like
  //     rule bodies so that "Always use sk-ant-..." does not persist a token.
  const rulePatterns = [
    /\b(?:always|must|should)\s+(?:use|implement|follow)\b\s+([^.!?]+)/gi,
    /\b(?:never|cannot|should\s+not)\b\s+([^.!?]+)/gi,
    /\b(?:prefer)\b\s+([^.!?]+)/gi,
  ]
  for (const pattern of rulePatterns) {
    for (const match of scrubbedContent.matchAll(pattern)) {
      const rule = match[0].trim().replace(/\s+/g, ' ')
      if (rule.length > 4 && rule.length < 200) {
        if (containsMemoryRedaction(rule) || !sanitizeMemoryIdentifier(rule)) continue

        // Tokenize rule bodies and run looksLikeSecret per token; reject rules containing token-shaped substrings
        const tokens = rule.split(/[\s,.;:!?()\[\]{}'"`]+/).filter(Boolean)
        let hasSecret = false
        for (const token of tokens) {
          if (looksLikeSecret(token)) {
            hasSecret = true
            break
          }
        }
        if (hasSecret) continue

        cappedWrite(dir, 'rule', rule, `Project rule: ${rule}`, { source: 'auto_discovery' })
      }
    }
  }

  return factsWritten > 0
}
