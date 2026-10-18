import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { coerce } from 'semver'

export const OPENCLAUDE_RELEASES_URL =
  'https://github.com/Twigpine/openclaude/releases'

export function normalizePublicVersion(version: string): string {
  const trimmedVersion = version.trim()
  const coercedVersion = coerce(trimmedVersion)
  if (coercedVersion) {
    return coercedVersion.version
  }
  return trimmedVersion.replace(/^v/i, '')
}

function readPackageVersionFromDisk(): string | null {
  let currentDir = dirname(fileURLToPath(import.meta.url))

  while (true) {
    const packageJsonPath = join(currentDir, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
        version?: unknown
      }
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version
      }
    } catch {
      // Keep walking upward until we find the package root.
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }
    currentDir = parentDir
  }
}

const fallbackBuildVersion = (() => {
  try {
    return MACRO.VERSION
  } catch {
    return '0.0.0'
  }
})()

export const publicBuildVersion = normalizePublicVersion(
  readPackageVersionFromDisk() ?? fallbackBuildVersion,
)

export function getReleaseTagUrl(version: string = publicBuildVersion): string {
  return `${OPENCLAUDE_RELEASES_URL}/tag/v${normalizePublicVersion(version)}`
}

export function getPublicBuildVersion(): string {
  return MACRO.DISPLAY_VERSION ?? MACRO.VERSION
}
