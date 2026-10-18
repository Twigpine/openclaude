// Seeded from the commander option definitions in src/main.tsx.
// Hidden/internal flags (hideHelp) are intentionally excluded.

export interface CliFlag {
  flag: string
  arg?: string
  description: string
}

export interface FlagGroup {
  id: string
  label: string
  intro?: string
  flags: CliFlag[]
}

export interface Subcommand {
  name: string
  usage: string
  description: string
}

export const flagGroups: FlagGroup[] = [
  {
    id: 'core',
    label: 'core',
    flags: [
      { flag: '-v, --version', description: 'Show the installed version and exit.' },
      { flag: '-h, --help', description: 'Display help for the command.' },
      { flag: '-p, --print', description: 'Print the response and exit (useful for pipes and scripts). The workspace trust dialog is skipped — only use in directories you trust.' },
      { flag: '--bare', description: 'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, keychain reads, and CLAUDE.md auto-discovery. Provide context explicitly via --system-prompt, --add-dir, --mcp-config, --settings, --agents, or --plugin-dir.' },
      { flag: '-d, --debug', arg: '[filter]', description: 'Enable debug mode with optional category filtering (e.g. "api,hooks" or "!file").' },
      { flag: '--debug-file', arg: '<path>', description: 'Write debug logs to a specific file path (implicitly enables debug mode).' },
      { flag: '--verbose', description: 'Override the verbose mode setting from config.' },
    ],
  },
  {
    id: 'io',
    label: 'input & output formats',
    intro: 'These flags shape non-interactive runs with --print, e.g. in scripts and CI.',
    flags: [
      { flag: '--output-format', arg: '<format>', description: 'Output format (with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming).' },
      { flag: '--input-format', arg: '<format>', description: 'Input format (with --print): "text" (default) or "stream-json" (realtime streaming input).' },
      { flag: '--json-schema', arg: '<schema>', description: 'JSON Schema for structured output validation of the final result.' },
      { flag: '--include-hook-events', description: 'Include hook lifecycle events in the output stream (stream-json only).' },
      { flag: '--include-partial-messages', description: 'Include partial message chunks as they arrive (stream-json only).' },
      { flag: '--replay-user-messages', description: 'Re-emit user messages from stdin back on stdout for acknowledgment (stream-json in and out).' },
      { flag: '--heartbeat', arg: '<duration>', description: 'Emit a headless liveness heartbeat while output is quiet (only with --print; e.g. 30s, 2m).' },
    ],
  },
  {
    id: 'model',
    label: 'model & provider',
    flags: [
      { flag: '--model', arg: '<model>', description: "Model for the session: an alias like 'sonnet' or 'opus', or a full model name." },
      { flag: '--provider', arg: '<provider>', description: 'AI provider to use (anthropic, openai, gemini, github, bedrock, vertex, ollama, …).' },
      { flag: '--effort', arg: '<level>', description: 'Effort level for model usage: low, medium, high, xhigh, max, or ultracode.' },
      { flag: '--fallback-model', arg: '<model>', description: 'Automatic fallback model when the default model is overloaded.' },
      { flag: '--agent', arg: '<agent>', description: "Agent for the current session. Overrides the 'agent' setting." },
      { flag: '--betas', arg: '<betas...>', description: 'Beta headers to include in API requests (API key users only).' },
    ],
  },
  {
    id: 'session',
    label: 'sessions',
    flags: [
      { flag: '-c, --continue', description: 'Continue the most recent conversation in the current directory.' },
      { flag: '-r, --resume', arg: '[id]', description: 'Resume a conversation by session ID, or open the interactive picker with an optional search term.' },
      { flag: '--fork-session', description: 'When resuming, branch the conversation into a new session ID. This does not create filesystem or worktree isolation.' },
      { flag: '--from-pr', arg: '[pr]', description: 'Resume a session linked to a PR by number/URL, or open the interactive picker.' },
      { flag: '--session-id', arg: '<uuid>', description: 'Use a specific session ID for the conversation (must be a valid UUID).' },
      { flag: '-n, --name', arg: '<name>', description: 'Set a display name for this session (shown in /resume and the terminal title).' },
      { flag: '--no-session-persistence', description: 'Disable session persistence — sessions are not saved to disk and cannot be resumed (--print only).' },
      { flag: '-w, --worktree', arg: '[name]', description: 'Run the session in an isolated git worktree, optionally named.' },
      { flag: '--tmux', description: 'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; pass --tmux=classic for traditional tmux.' },
    ],
  },
  {
    id: 'permissions',
    label: 'permissions & tools',
    flags: [
      { flag: '--permission-mode', arg: '<mode>', description: 'Permission mode for the session (e.g. auto, plan, acceptEdits, bypassPermissions).' },
      { flag: '--allowed-tools', arg: '<tools...>', description: 'Comma or space-separated list of tool rules to allow (e.g. "Bash(git:*) Edit").' },
      { flag: '--disallowed-tools', arg: '<tools...>', description: 'Comma or space-separated list of tool rules to deny.' },
      { flag: '--tools', arg: '<tools...>', description: 'Restrict the built-in tool set: "" disables all tools, "default" enables all, or list names like "Bash,Edit,Read".' },
      { flag: '--yolo, --dangerously-skip-permissions', description: 'Bypass all permission checks. Recommended only for sandboxes with no internet access.' },
      { flag: '--allow-dangerously-skip-permissions', description: 'Make permission bypass available as an option without enabling it by default.' },
      { flag: '--add-dir', arg: '<dirs...>', description: 'Additional directories to allow tool access to.' },
    ],
  },
  {
    id: 'prompt',
    label: 'system prompt',
    flags: [
      { flag: '--system-prompt', arg: '<prompt>', description: 'Replace the default system prompt for the session.' },
      { flag: '--append-system-prompt', arg: '<prompt>', description: 'Append to the default system prompt instead of replacing it.' },
    ],
  },
  {
    id: 'mcp',
    label: 'mcp',
    flags: [
      { flag: '--mcp-config', arg: '<configs...>', description: 'Load MCP servers from JSON files or strings (space-separated).' },
      { flag: '--strict-mcp-config', description: 'Only use MCP servers from --mcp-config, ignoring all other MCP configurations.' },
    ],
  },
  {
    id: 'config',
    label: 'configuration',
    flags: [
      { flag: '--settings', arg: '<file-or-json>', description: 'Path to a settings JSON file, or a JSON string, with additional settings.' },
      { flag: '--setting-sources', arg: '<sources>', description: 'Comma-separated list of setting sources to load: user, project, local.' },
      { flag: '--agents', arg: '<json>', description: 'JSON object defining custom agents for the session.' },
      { flag: '--plugin-dir', arg: '<path>', description: 'Load plugins from a directory (repeatable).' },
      { flag: '--ide', description: 'Automatically connect to your IDE on startup if exactly one valid IDE is available.' },
      { flag: '--chrome', description: 'Enable Claude in Chrome integration.' },
      { flag: '--no-chrome', description: 'Disable Claude in Chrome integration.' },
      { flag: '--disable-slash-commands', description: 'Disable all slash commands, including skill-backed ones.' },
      { flag: '--provider-env-file', arg: '<path>', description: 'Load provider environment variables from a file before validation (repeatable; existing values win).' },
      { flag: '--file', arg: '<specs...>', description: 'File resources to download at startup, as file_id:relative_path.' },
    ],
  },
]

// Note: in -p/--print mode subcommands are skipped entirely.
export const subcommands: Subcommand[] = [
  {
    name: 'mcp',
    usage: 'openclaude mcp [add|remove|list|doctor]',
    description: 'Manage MCP server configuration from the command line.',
  },
  {
    name: 'auth',
    usage: 'openclaude auth <login|status|logout>',
    description: 'Manage authentication.',
  },
  {
    name: 'auth xai',
    usage: 'openclaude auth xai <login|device|logout|status>',
    description: 'Sign in to xAI (Grok) with browser OAuth, or device code for remote hosts.',
  },
  {
    name: 'skills',
    usage: 'openclaude skills <list|show|validate|install|remove>',
    description: 'List, inspect, validate, and manage OpenClaude skills.',
  },
  {
    name: 'plugin',
    usage: 'openclaude plugin <validate|list|install|uninstall|enable|disable|update|marketplace>',
    description: 'Manage OpenClaude plugins and marketplaces.',
  },
  {
    name: 'agents',
    usage: 'openclaude agents',
    description: 'List configured agents.',
  },
  {
    name: 'doctor',
    usage: 'openclaude doctor [report]',
    description: "Check installation health; 'doctor report' prints a redacted diagnostic report for GitHub issues.",
  },
  {
    name: 'update',
    usage: 'openclaude update',
    description: 'Check for updates and install if available (alias: upgrade).',
  },
  {
    name: 'install',
    usage: 'openclaude install [stable|latest|<version>]',
    description: 'Install the OpenClaude native build.',
  },
  {
    name: 'setup-token',
    usage: 'openclaude setup-token',
    description: 'Set up a long-lived authentication token (requires Claude subscription).',
  },
  {
    name: 'aimlapi',
    usage: 'openclaude aimlapi topup',
    description: 'Top up an AI/ML API balance and configure the provider.',
  },
  {
    name: 'ssh',
    usage: 'openclaude ssh <host> [dir]',
    description: 'Run OpenClaude on a remote host over SSH. Deploys the binary and tunnels API auth back through your local machine — no remote setup needed.',
  },
]
