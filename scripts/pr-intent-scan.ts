import { captureSync } from './subprocess.ts'

export type FindingSeverity = 'high' | 'medium'

export type DiffLine = {
  file: string
  line: number
  content: string
}

export type Finding = {
  severity: FindingSeverity
  code: string
  file: string
  line: number
  detail: string
  excerpt: string
}

type CliOptions = {
  baseRef: string
  headRef: string
  json: boolean
  failOn: FindingSeverity
}

const SELF_EXCLUDED_FILES = new Set([
  'scripts/pr-intent-scan.ts',
  'scripts/pr-intent-scan.test.ts',
])

const SHORTENER_DOMAINS = [
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  't.co',
  'is.gd',
  'rb.gy',
  'cutt.ly',
]

const SUSPICIOUS_DOWNLOAD_DOMAINS = [
  'dropbox.com',
  'dl.dropboxusercontent.com',
  'drive.google.com',
  'docs.google.com',
  'mega.nz',
  'mediafire.com',
  'transfer.sh',
  'anonfiles.com',
  'catbox.moe',
]

const URL_REGEX = /\bhttps?:\/\/[^\s)>"']+/gi
const LONG_BASE64_REGEX = /\b(?:[A-Za-z0-9+/]{80,}={0,2}|[A-Za-z0-9_-]{80,})\b/
const EXECUTABLE_PATH_REGEX =
  /\.(?:sh|bash|zsh|ps1|exe|msi|pkg|deb|rpm|zip|tar|tgz|gz|xz|dmg|appimage)(?:$|[?#])/i
const SENSITIVE_PATH_REGEX =
  /^(?:\.github\/workflows\/|scripts\/|bin\/|install(?:\/|\.|$)|.*(?:Dockerfile|docker-compose|compose\.ya?ml)$)/i

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseRef: 'origin/main',
    headRef: 'HEAD',
    json: false,
    failOn: 'high',
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--base') {
      const next = argv[index + 1]
      if (next && !next.startsWith('--')) {
        options.baseRef = next
        index++
      }
      continue
    }
    if (arg === '--head') {
      const next = argv[index + 1]
      if (next && !next.startsWith('--')) {
        options.headRef = next
        index++
      }
      continue
    }
    if (arg === '--fail-on') {
      const next = argv[index + 1]
      if (next === 'high' || next === 'medium') {
        options.failOn = next
        index++
      }
    }
  }

  return options
}

function trimExcerpt(content: string): string {
  const compact = content.trim().replace(/\s+/g, ' ')
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact
}

function uniqueFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter(finding => {
    const key = `${finding.code}:${finding.file}:${finding.line}:${finding.detail}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function parseAddedLines(diffText: string): DiffLine[] {
  const lines = diffText.split('\n')
  const added: DiffLine[] = []
  let currentFile: string | null = null
  let currentLine = 0

  for (const rawLine of lines) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice('+++ b/'.length)
      continue
    }

    if (rawLine.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(rawLine)
      if (match) {
        currentLine = Number(match[1])
      }
      continue
    }

    if (!currentFile) {
      continue
    }

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      added.push({
        file: currentFile,
        line: currentLine,
        content: rawLine.slice(1),
      })
      currentLine += 1
      continue
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      continue
    }

    if (!rawLine.startsWith('\\')) {
      currentLine += 1
    }
  }

  return added
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function hasSuspiciousDownloadIndicators(url: URL): boolean {
  const combined = `${url.pathname}${url.search}`.toLowerCase()
  return (
    combined.includes('dl=1') ||
    combined.includes('raw=1') ||
    combined.includes('export=download') ||
    combined.includes('/download') ||
    combined.includes('/uc?export=download')
  )
}

function findUrlFindings(line: DiffLine): Finding[] {
  const findings: Finding[] = []
  const matches = line.content.match(URL_REGEX) ?? []

  for (const match of matches) {
    const parsed = tryParseUrl(match)
    if (!parsed) continue

    const hostname = parsed.hostname.toLowerCase()

    for (const domain of SHORTENER_DOMAINS) {
      if (hostMatches(hostname, domain)) {
        findings.push({
          severity: 'medium',
          code: 'shortened-url',
          file: line.file,
          line: line.line,
          detail: `Added shortened URL: ${hostname}`,
          excerpt: trimExcerpt(line.content),
        })
      }
    }

    const isSuspiciousHost = SUSPICIOUS_DOWNLOAD_DOMAINS.some(domain =>
      hostMatches(hostname, domain),
    )
    const isExecutableDownload = EXECUTABLE_PATH_REGEX.test(
      `${parsed.pathname}${parsed.search}`,
    )

    if (isSuspiciousHost) {
      findings.push({
        severity:
          hasSuspiciousDownloadIndicators(parsed) || isExecutableDownload
            ? 'high'
            : 'medium',
        code: 'suspicious-download-link',
        file: line.file,
        line: line.line,
        detail: `Added external file-hosting link: ${hostname}`,
        excerpt: trimExcerpt(line.content),
      })
    } else if (isExecutableDownload) {
      findings.push({
        severity: 'high',
        code: 'executable-download-link',
        file: line.file,
        line: line.line,
        detail: `Added direct link to executable or archive payload: ${hostname}`,
        excerpt: trimExcerpt(line.content),
      })
    }
  }

  return findings
}

function findSensitivePathFindings(line: DiffLine): Finding[] {
  if (!SENSITIVE_PATH_REGEX.test(line.file)) {
    return []
  }

  const lower = line.content.toLowerCase()

  if (
    /\b(curl|wget|invoke-webrequest|iwr|powershell|bash|sh|chmod\s+\+x)\b/i.test(
      line.content,
    ) ||
    URL_REGEX.test(line.content) ||
    lower.includes('download')
  ) {
    return [
      {
        severity: 'medium',
        code: 'sensitive-automation-change',
        file: line.file,
        line: line.line,
        detail:
          'Added network, execution, or download-related content in a sensitive automation file',
        excerpt: trimExcerpt(line.content),
      },
    ]
  }

  return []
}

function findCommandFindings(line: DiffLine): Finding[] {
  const findings: Finding[] = []
  const lower = line.content.toLowerCase()

  const highPatterns: Array<[string, RegExp, string]> = [
    [
      'download-exec-chain',
      /\b(curl|wget|invoke-webrequest|iwr)\b.*(\|\s*(sh|bash|zsh)|;\s*chmod\s+\+x|&&\s*\.\.?\/|>\s*\/tmp\/)/i,
      'Added remote download followed by execution or staging',
    ],
    [
      'powershell-encoded',
      /\bpowershell(?:\.exe)?\b.*(?:-enc|-encodedcommand)\b/i,
      'Added encoded PowerShell invocation',
    ],
    [
      'shell-eval-remote',
      /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i,
      'Added shell pipe from remote content into interpreter',
    ],
    [
      'binary-lolbin',
      /\b(mshta|rundll32|regsvr32|certutil)\b/i,
      'Added living-off-the-land binary often used for payload staging',
    ],
    [
      'invoke-expression',
      /\b(iex|invoke-expression)\b/i,
      'Added PowerShell expression execution',
    ],
  ]

  const mediumPatterns: Array<[string, RegExp, string]> = [
    [
      'download-command',
      /\b(curl|wget|invoke-webrequest|iwr)\b.*https?:\/\//i,
      'Added command that downloads remote content',
    ],
    [
      'archive-extract-exec',
      /\b(unzip|tar|7z)\b.*(&&|;).*\b(chmod|node|python|bash|sh)\b/i,
      'Added archive extraction followed by execution',
    ],
    [
      'base64-decode',
      /\b(base64\s+-d|openssl\s+base64\s+-d|python .*b64decode)\b/i,
      'Added explicit payload decode step',
    ],
  ]

  for (const [code, pattern, detail] of highPatterns) {
    if (pattern.test(line.content)) {
      findings.push({
        severity: 'high',
        code,
        file: line.file,
        line: line.line,
        detail,
        excerpt: trimExcerpt(line.content),
      })
    }
  }

  for (const [code, pattern, detail] of mediumPatterns) {
    if (code === 'download-command' && !SENSITIVE_PATH_REGEX.test(line.file)) {
      continue
    }
    if (pattern.test(line.content)) {
      findings.push({
        severity: 'medium',
        code,
        file: line.file,
        line: line.line,
        detail,
        excerpt: trimExcerpt(line.content),
      })
    }
  }

  if (LONG_BASE64_REGEX.test(line.content) && !lower.includes('sha256') && !lower.includes('sha512')) {
    findings.push({
      severity: 'medium',
      code: 'long-encoded-payload',
      file: line.file,
      line: line.line,
      detail: 'Added long encoded blob or token-like payload',
      excerpt: trimExcerpt(line.content),
    })
  }

  return findings
}

export function scanAddedLines(lines: DiffLine[]): Finding[] {
  const findings = lines
    .filter(line => !SELF_EXCLUDED_FILES.has(line.file))
    .flatMap(line => [
    ...findUrlFindings(line),
    ...findCommandFindings(line),
    ...findSensitivePathFindings(line),
  ])
  return uniqueFindings(findings)
}

export function getGitDiff(baseRef: string, headRef = 'HEAD'): string {
  const mergeBase = captureSync('git', ['merge-base', baseRef, headRef])

  if (mergeBase.status !== 0) {
    throw new Error(
      `Could not determine merge-base between ${baseRef} and ${headRef}: ${mergeBase.stderr.trim() || mergeBase.stdout.trim()}`,
    )
  }

  const base = mergeBase.stdout.trim()
  const diff = captureSync(
    'git',
    ['diff', '--unified=0', '--no-ext-diff', `${base}...${headRef}`],
  )

  if (diff.status !== 0) {
    throw new Error(`git diff failed: ${diff.stderr.trim() || diff.stdout.trim()}`)
  }

  return diff.stdout
}

function shouldFail(findings: Finding[], failOn: FindingSeverity): boolean {
  if (failOn === 'medium') {
    return findings.length > 0
  }
  return findings.some(finding => finding.severity === 'high')
}

function renderText(findings: Finding[]): string {
  if (findings.length === 0) {
    return 'PR intent scan: no suspicious additions found.'
  }

  const high = findings.filter(f => f.severity === 'high')
  const medium = findings.filter(f => f.severity === 'medium')
  const lines = [
    `PR intent scan: ${findings.length} finding(s)`,
    `- high: ${high.length}`,
    `- medium: ${medium.length}`,
    '',
  ]

  for (const finding of findings) {
    lines.push(
      `[${finding.severity.toUpperCase()}] ${finding.file}:${finding.line} ${finding.detail}`,
    )
    lines.push(`  ${finding.excerpt}`)
  }

  return lines.join('\n')
}

export function run(options: CliOptions): number {
  const diff = getGitDiff(options.baseRef, options.headRef)
  const addedLines = parseAddedLines(diff)
  const findings = scanAddedLines(addedLines)

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          baseRef: options.baseRef,
          headRef: options.headRef,
          addedLines: addedLines.length,
          findings,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(`${renderText(findings)}\n`)
  }

  return shouldFail(findings, options.failOn) ? 1 : 0
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2))
    process.exitCode = run(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`PR intent scan failed: ${message}`)
    process.exitCode = 1
  }
}
