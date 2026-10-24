type CaptureOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
}

type CaptureResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

/** Capture development command output without throwing on launch or exit failure. */
export function captureSync(
  command: string,
  args: string[],
  options: CaptureOptions = {},
): CaptureResult {
  try {
    const result = Bun.spawnSync([command, ...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      status: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      ...(result.exitedDueToTimeout || result.exitedDueToMaxBuffer
        ? { error: new Error(`spawnSync ${command} ${result.exitedDueToTimeout ? 'ETIMEDOUT' : 'ENOBUFS'}`) }
        : {}),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: code === 'ENOENT'
        ? new Error(`spawnSync ${command} ENOENT`)
        : error as Error,
    }
  }
}
