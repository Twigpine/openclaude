/**
 * MockQueryEngine — deterministic mock for SDK happy-path tests.
 *
 * Replaces the real QueryEngine via Bun.mock.module().
 * submitMessage() yields a fixed message sequence:
 *   1. assistant text response
 *   2. result (success)
 */
import type { QueryEngineConfig } from '../../../src/QueryEngine.js'
import type { Message } from '../../../src/types/message.js'
import type { SDKMessage } from '../../../src/entrypoints/sdk/index.js'

export class MockQueryEngine {
  config = {
    mcpClients: [] as QueryEngineConfig['mcpClients'],
    tools: [] as QueryEngineConfig['tools'],
    agents: [] as QueryEngineConfig['agents'],
  }

  private _messages: Message[] = []
  private _sessionId = 'mock-session-id'
  private _aborted = false

  async *submitMessage(
    prompt: string,
    _options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    if (this._aborted) return

    // Yield an assistant response
    yield {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Mock response to: ${prompt}` }],
        model: 'mock-model',
      },
    } as unknown as SDKMessage

    // Yield a result message
    yield {
      type: 'result',
      subtype: 'success',
      result: `Completed: ${prompt}`,
      session_id: this._sessionId,
      cost_usd: 0,
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: false,
      num_turns: 1,
      total_cost: 0,
    } as unknown as SDKMessage
  }

  injectMessages(messages: Message[]): void {
    this._messages.push(...messages)
  }

  injectAgents(agents: QueryEngineConfig['agents']): void {
    this.config.agents = agents
  }

  updateTools(tools: QueryEngineConfig['tools']): void {
    this.config.tools = tools
  }

  getMcpClients(): Readonly<QueryEngineConfig['mcpClients']> {
    return this.config.mcpClients
  }

  setMcpClients(clients: QueryEngineConfig['mcpClients']): void {
    this.config.mcpClients = clients
  }

  getMessages(): Message[] {
    return this._messages
  }

  getSessionId(): string {
    return this._sessionId
  }

  interrupt(): void {
    this._aborted = true
  }
}
