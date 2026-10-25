import { execa } from 'execa'
import { spawnSync } from 'node:child_process'

async function whichNodeAsync(command: string): Promise<string | null> {
  if (process.platform === 'win32') {
    // On Windows, use where.exe and return the first result
    const result = await execa('where.exe', [command], {
      stderr: 'ignore',
      reject: false,
    })
    if (result.exitCode !== 0 || !result.stdout) {
      return null
    }
    // where.exe returns multiple paths separated by newlines, return the first
    return result.stdout.trim().split(/\r?\n/)[0] || null
  }

  // On POSIX systems (macOS, Linux, WSL), use which
  // Cross-platform safe: Windows is handled above
  // eslint-disable-next-line custom-rules/no-cross-platform-process-issues
  const result = await execa('which', [command], {
    stderr: 'ignore',
    reject: false,
  })
  if (result.exitCode !== 0 || !result.stdout) {
    return null
  }
  return result.stdout.trim()
}

function whichNodeSync(command: string): string | null {
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where.exe', [command], {
        shell: false,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (result.status !== 0 || !result.stdout) {
        return null
      }
      const output = result.stdout.toString().trim()
      return output.split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  try {
    const result = spawnSync('which', [command], {
      shell: false,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status !== 0 || !result.stdout) {
      return null
    }
    return result.stdout.toString().trim() || null
  } catch {
    return null
  }
}

const bunWhich =
  typeof Bun !== 'undefined' && typeof Bun.which === 'function'
    ? Bun.which
    : null

/**
 * Finds the full path to a command executable.
 * Uses Bun.which when running in Bun (fast, no process spawn),
 * otherwise spawns the platform-appropriate command.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const which: (command: string) => Promise<string | null> = bunWhich
  ? async command => bunWhich(command)
  : whichNodeAsync

/**
 * Synchronous version of `which`.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const whichSync: (command: string) => string | null =
  bunWhich ?? whichNodeSync
