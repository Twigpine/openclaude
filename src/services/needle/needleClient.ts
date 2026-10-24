import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { randomUUID } from 'node:crypto'

export const NEEDLE_WORKER_MODEL = 'needle-worker'
export const DEFAULT_NEEDLE_TIMEOUT_MS = 5_000

const NEEDLE_RUNTIME = String.raw`
import json, sys, needle

def main():
    agent = None
    agent_tools = None
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if agent is None or agent_tools != request["tools"]:
                agent_tools = request["tools"]
                agent = needle.Needle(tools=agent_tools, generation=3)
            result = agent.complete(request["prompt"], max_new_tokens=request.get("max_new_tokens", 256))
            print(json.dumps({"id": request["id"], "result": result}, separators=(",", ":")), flush=True)
        except Exception as error:
            request_id = request.get("id") if isinstance(request, dict) else None
            print(json.dumps({"id": request_id, "error": str(error)}, separators=(",", ":")), flush=True)

main()
`

export type NeedleTool = {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export type NeedleRequest = {
  prompt: string
  tools: NeedleTool[]
  maxNewTokens?: number
  signal?: AbortSignal
}

export type NeedleFunctionCall = {
  name: string
  arguments: Record<string, unknown>
}

export type NeedleResponse = {
  functionCalls: NeedleFunctionCall[]
  text?: string
  decodeTps?: number
  prefillTps?: number
}

type PendingRequest = {
  resolve: (response: NeedleResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  abortCleanup?: () => void
}

type RuntimeResponse = {
  id: string
  error?: string
  result?: {
    function_calls?: Array<{ name?: unknown; arguments?: unknown }>
    text?: unknown
    decode_tps?: unknown
    prefill_tps?: unknown
  }
}

export function getNeedlePythonCommand(
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const configured = process.env.OPENCLAUDE_NEEDLE_PYTHON?.trim()
  if (configured) return { command: configured, args: [] }
  return platform === 'win32'
    ? { command: 'py', args: ['-3'] }
    : { command: 'python3', args: [] }
}

export async function checkNeedleAvailability(): Promise<{
  available: boolean
  error?: string
}> {
  const { command, args } = getNeedlePythonCommand()
  return new Promise(resolve => {
    const child = spawn(command, [...args, '-c', 'import needle'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ available: false, error: 'Needle availability check timed out' })
    }, 5_000)
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('error', error => {
      clearTimeout(timer)
      resolve({ available: false, error: error.message })
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code === 0
        ? { available: true }
        : { available: false, error: stderr.trim() || `Python exited with code ${code ?? 'unknown'}` })
    })
  })
}

export function getNeedleTimeoutMs(): number {
  const value = Number(process.env.OPENCLAUDE_NEEDLE_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 120_000)
    : DEFAULT_NEEDLE_TIMEOUT_MS
}

export function buildNeedleToolPayload(
  tools: Array<{
    name: string
    description?: string
    input_schema?: Record<string, unknown>
    parameters?: Record<string, unknown>
  }>,
): NeedleTool[] {
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters ?? tool.input_schema ?? { type: 'object', properties: {} },
  }))
}

function normalizeResponse(response: RuntimeResponse): NeedleResponse {
  if (response.error) throw new Error(`Needle worker error: ${response.error}`)
  if (!response.result || typeof response.result !== 'object') {
    throw new Error('Needle worker returned no result')
  }
  const functionCalls = (response.result.function_calls ?? []).map(call => {
    if (typeof call.name !== 'string' || !call.name) {
      throw new Error('Needle worker returned a function call without a name')
    }
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error(`Needle worker returned invalid arguments for ${call.name}`)
    }
    return { name: call.name, arguments: call.arguments as Record<string, unknown> }
  })
  return {
    functionCalls,
    ...(typeof response.result.text === 'string' ? { text: response.result.text } : {}),
    ...(typeof response.result.decode_tps === 'number' ? { decodeTps: response.result.decode_tps } : {}),
    ...(typeof response.result.prefill_tps === 'number' ? { prefillTps: response.result.prefill_tps } : {}),
  }
}

export class NeedleClient {
  private process?: ChildProcessWithoutNullStreams
  private lines?: Interface
  private readonly pending = new Map<string, PendingRequest>()
  private readonly timeoutMs: number
  private toolsKey = ''

  constructor(timeoutMs = getNeedleTimeoutMs()) {
    this.timeoutMs = timeoutMs
  }

  async complete(request: NeedleRequest): Promise<NeedleResponse> {
    this.ensureProcess(request.tools)
    const id = randomUUID()
    const payload = {
      id,
      prompt: request.prompt,
      tools: request.tools,
      max_new_tokens: request.maxNewTokens ?? 256,
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        pending.abortCleanup?.()
        this.restart(new Error(`Needle worker timed out after ${this.timeoutMs}ms`))
        reject(new Error(`Needle worker timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      const pending: PendingRequest = { resolve, reject, timer }
      if (request.signal) {
        const abort = () => {
          this.pending.delete(id)
          clearTimeout(timer)
          this.restart(new Error('Needle worker request aborted'))
          reject(new Error('Needle worker request aborted'))
        }
        if (request.signal.aborted) return abort()
        request.signal.addEventListener('abort', abort, { once: true })
        pending.abortCleanup = () => request.signal?.removeEventListener('abort', abort)
      }
      this.pending.set(id, pending)
      this.process!.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return
        this.restart(new Error(`Unable to write to Needle worker: ${error.message}`))
      })
    })
  }

  close(): void {
    this.lines?.close()
    this.process?.kill()
    this.rejectAll(new Error('Needle worker closed'))
    this.lines = undefined
    this.process = undefined
    this.toolsKey = ''
  }

  private restart(error: Error): void {
    const child = this.process
    this.lines?.close()
    this.process = undefined
    this.lines = undefined
    this.toolsKey = ''
    child?.kill()
    this.rejectAll(error)
  }

  private ensureProcess(tools: NeedleTool[]): void {
    const key = JSON.stringify(tools)
    if (this.process && this.toolsKey === key) return
    if (this.process) this.close()
    const { command, args } = getNeedlePythonCommand()
    const child = spawn(command, [...args, '-u', '-c', NEEDLE_RUNTIME], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process = child
    this.toolsKey = key
    this.lines = createInterface({ input: child.stdout })
    child.stderr.resume()
    this.lines.on('line', line => {
      try {
        const response = JSON.parse(line) as RuntimeResponse
        const pending = response.id ? this.pending.get(response.id) : undefined
        if (!pending) return
        if (response.error) {
          this.pending.delete(response.id)
          clearTimeout(pending.timer)
          pending.abortCleanup?.()
          pending.reject(new Error(`Needle worker error: ${response.error}`))
        } else {
          const normalized = normalizeResponse(response)
          this.pending.delete(response.id)
          clearTimeout(pending.timer)
          pending.abortCleanup?.()
          pending.resolve(normalized)
        }
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)))
      }
    })
    const fail = (error: Error) => {
      if (this.process === child) this.restart(error)
    }
    child.once('error', fail)
    child.stdin.on('error', fail)
    child.once('exit', code => {
      if (this.process === child) {
        fail(new Error(`Needle worker exited with code ${code ?? 'unknown'}`))
      }
    })
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.abortCleanup?.()
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
