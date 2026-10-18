import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const MISSING_CLI_ENTRYPOINT_MESSAGE =
  'Unable to resolve the current OpenClaude CLI entrypoint. Start OpenClaude through its installed launcher and try again.'

export function resolveCurrentCliEntrypoint({
  argv1 = process.argv[1],
  cwd,
  getCwd = process.cwd,
  pathExists = existsSync,
}: {
  argv1?: string
  cwd?: string
  getCwd?: () => string
  pathExists?: (path: string) => boolean
} = {}): string {
  if (!argv1) {
    throw new Error(MISSING_CLI_ENTRYPOINT_MESSAGE)
  }

  const entrypoint = isAbsolute(argv1)
    ? argv1
    : resolve(cwd ?? getCwd(), argv1)
  if (!pathExists(entrypoint)) {
    throw new Error(MISSING_CLI_ENTRYPOINT_MESSAGE)
  }

  return entrypoint
}
