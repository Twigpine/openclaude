import { describe, expect, test } from 'bun:test'
import { captureSync } from './subprocess.ts'

describe('development subprocess capture', () => {
  test('captures both streams and a nonzero status without shell expansion', () => {
    const literal = 'space ; $value & "quoted"'
    const result = captureSync(process.execPath, ['-e', `
      process.stdout.write(process.argv[1])
      process.stderr.write('diagnostic\\n')
      process.exit(7)
    `, literal])
    expect(result).toEqual({ status: 7, stdout: literal, stderr: 'diagnostic\n' })
  })

  test('preserves cwd, the supplied environment, and closed piped stdin', () => {
    const result = captureSync(process.execPath, ['-e', `
      process.stdin.resume()
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify([process.cwd(), process.env.PROCESS_CAPTURE_TEST]))
      })
    `], { cwd: import.meta.dir, env: { PROCESS_CAPTURE_TEST: 'present' }, timeout: 1000 })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([import.meta.dir, 'present'])
  })

  test('returns a missing executable error instead of throwing', () => {
    const result = captureSync('missing-development-command-l2', [])
    expect(result.status).toBeNull()
    expect(result.error?.message).toContain('ENOENT')
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  // The child deadline must expire before the test's own deadline.
  test('reports timeouts while keeping diagnostics', () => {
    const result = captureSync(process.execPath, ['-e', `
      process.stderr.write('before timeout')
      setInterval(() => {}, 1000)
    `], { timeout: 200 })
    expect(result.status).toBeNull()
    expect(result.error?.message).toContain('ETIMEDOUT')
    expect(result.stderr).toBe('before timeout')
  }, 2000)

  test('reports bounded output capture failures', () => {
    const result = captureSync(process.execPath, ['-e', `
      process.stdout.write('x'.repeat(1024 * 1024))
      setInterval(() => {}, 1000)
    `], { maxBuffer: 1024, timeout: 1000 })
    expect(result.error?.message).toContain('ENOBUFS')
    expect(result.status).toBeNull()
  }, 2000)
})
