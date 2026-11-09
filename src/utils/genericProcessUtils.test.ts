import { describe, expect, it } from 'bun:test'
import { getProcessCommandAsync } from './genericProcessUtils.js'

async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' })
  await child.exited
  return child.pid
}

describe('getProcessCommandAsync', () => {
  it('returns the current process command line', async () => {
    const command = await getProcessCommandAsync(process.pid)

    expect(typeof command).toBe('string')
    expect(command!.length).toBeGreaterThan(0)
  })

  it('returns null for a process that is not running', async () => {
    expect(await getProcessCommandAsync(await deadPid())).toBeNull()
  })

  it('returns null for an invalid pid', async () => {
    expect(await getProcessCommandAsync('not-a-pid')).toBeNull()
  })

  it('returns null when the lookup signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    expect(
      await getProcessCommandAsync(process.pid, { signal: controller.signal }),
    ).toBeNull()
  })
})
