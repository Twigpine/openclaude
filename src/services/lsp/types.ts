// Stub — recreated type surface for the LSP service (not included in source
// snapshot). Pure types: no runtime exports, no import-time effects.
// LspServerConfig mirrors LspServerConfigSchema in utils/plugins/schemas.ts
// (transport is optional here because the schema applies a default on parse,
// while inline plugin/manifest definitions may omit it).

/** Configuration for a single LSP server (plugin-provided). */
export type LspServerConfig = {
  /** Command to execute the LSP server (e.g. "typescript-language-server") */
  command: string
  /** Command-line arguments to pass to the server */
  args?: string[]
  /** Mapping from file extension to LSP language ID */
  extensionToLanguage: Record<string, string>
  /** Communication transport mechanism (default: 'stdio') */
  transport?: 'stdio' | 'socket'
  /** Environment variables to set when starting the server */
  env?: Record<string, string>
  /** Initialization options passed during server initialization */
  initializationOptions?: unknown
  /** Settings passed via workspace/didChangeConfiguration */
  settings?: unknown
  /** Workspace folder path to use for the server */
  workspaceFolder?: string
  /** Maximum time to wait for each server startup phase (default: 30000 ms) */
  startupTimeout?: number
  /** Maximum time to wait for graceful shutdown (ms) */
  shutdownTimeout?: number
  /** Whether to restart the server if it crashes */
  restartOnCrash?: boolean
  /** Maximum number of restart attempts before giving up */
  maxRestarts?: number
}

/**
 * An LSP server config with plugin scoping applied
 * (see addPluginScopeToLspServers in utils/plugins/lspPluginIntegration.ts).
 */
export type ScopedLspServerConfig = LspServerConfig & {
  scope:
    | 'user'
    | 'project'
    | 'local'
    | 'dynamic'
    | 'enterprise'
    | 'claudeai'
    | 'managed'
  /** Originating plugin name */
  source: string
}

/** Lifecycle state of a managed LSP server instance. */
export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'
