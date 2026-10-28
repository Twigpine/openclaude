// AUTO-GENERATED — do not edit manually.
// Regenerate with: bun scripts/generate-sdk-types.ts
//
// Generated from Zod schemas in coreSchemas.ts

export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}

export type OutputFormatType = "json_schema"

export type BaseOutputFormat = {
  type: "json_schema"
}

export type JsonSchemaOutputFormat = {
  type: "json_schema"
  schema: Record<string, unknown>
}

export type OutputFormat = {
  type: "json_schema"
  schema: Record<string, unknown>
}

export type ApiKeySource = "user" | "project" | "org" | "temporary" | "oauth" | "none"

/** Config scope for settings. */
export type ConfigScope = "local" | "user" | "project"

export type SdkBeta = "context-1m-2025-08-07"

/** Claude decides when and how much to think (Opus 4.6+). */
export type ThinkingAdaptive = {
  type: "adaptive"
}

/** Fixed thinking token budget (older models) */
export type ThinkingEnabled = {
  type: "enabled"
  budgetTokens?: number
}

/** No extended thinking */
export type ThinkingDisabled = {
  type: "disabled"
}

/** Controls Claude's thinking/reasoning behavior. When set, takes precedence over the deprecated maxThinkingTokens. */
export type ThinkingConfig = ({
  type: "adaptive"
}) | ({
  type: "enabled"
  budgetTokens?: number
}) | ({
  type: "disabled"
})

export type McpStdioServerConfig = {
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpSSEServerConfig = {
  type: "sse"
  url: string
  headers?: Record<string, string>
}

export type McpHttpServerConfig = {
  type: "http"
  url: string
  headers?: Record<string, string>
}

export type McpSdkServerConfig = {
  type: "sdk"
  name: string
}

export type McpServerConfigForProcessTransport = ({
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}) | ({
  type: "sse"
  url: string
  headers?: Record<string, string>
}) | ({
  type: "http"
  url: string
  headers?: Record<string, string>
}) | ({
  type: "sdk"
  name: string
})

export type McpClaudeAIProxyServerConfig = {
  type: "claudeai-proxy"
  url: string
  id: string
}

export type McpServerStatusConfig = (({
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}) | ({
  type: "sse"
  url: string
  headers?: Record<string, string>
}) | ({
  type: "http"
  url: string
  headers?: Record<string, string>
}) | ({
  type: "sdk"
  name: string
})) | ({
  type: "claudeai-proxy"
  url: string
  id: string
})

/** Status information for an MCP server connection. */
export type McpServerStatus = {
  name: string
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled"
  serverInfo?: {
    name: string
    version: string
  }
  error?: string
  config?: (({
    type?: "stdio"
    command: string
    args?: string[]
    env?: Record<string, string>
  }) | ({
    type: "sse"
    url: string
    headers?: Record<string, string>
  }) | ({
    type: "http"
    url: string
    headers?: Record<string, string>
  }) | ({
    type: "sdk"
    name: string
  })) | ({
    type: "claudeai-proxy"
    url: string
    id: string
  })
  scope?: string
  tools?: {
    name: string
    description?: string
    annotations?: {
      readOnly?: boolean
      destructive?: boolean
      openWorld?: boolean
    }
  }[]
  capabilities?: {
    experimental?: Record<string, unknown>
  }
}

/** Result of a setMcpServers operation. */
export type McpSetServersResult = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export type PermissionUpdateDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"

export type PermissionBehavior = "allow" | "deny" | "ask"

export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

export type PermissionUpdate = ({
  type: "addRules"
  rules: {
    toolName: string
    ruleContent?: string
  }[]
  behavior: "allow" | "deny" | "ask"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}) | ({
  type: "replaceRules"
  rules: {
    toolName: string
    ruleContent?: string
  }[]
  behavior: "allow" | "deny" | "ask"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}) | ({
  type: "removeRules"
  rules: {
    toolName: string
    ruleContent?: string
  }[]
  behavior: "allow" | "deny" | "ask"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}) | ({
  type: "setMode"
  mode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}) | ({
  type: "addDirectories"
  directories: string[]
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}) | ({
  type: "removeDirectories"
  directories: string[]
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
})

/** Classification of this permission decision for telemetry. SDK hosts that prompt users (desktop apps, IDEs) should set this to reflect what actually happened: user_temporary for allow-once, user_permanent for always-allow (both the click and later cache hits), user_reject for deny. If unset, the CLI infers conservatively (temporary for allow, reject for deny). The vocabulary matches tool_decision OTel events (monitoring-usage docs). */
export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject"

export type PermissionResult = ({
  behavior: "allow"
  updatedInput?: Record<string, unknown>
  updatedPermissions?: (({
    type: "addRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "replaceRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "removeRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "setMode"
    mode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "addDirectories"
    directories: string[]
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "removeDirectories"
    directories: string[]
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }))[]
  toolUseID?: string
  decisionClassification?: "user_temporary" | "user_permanent" | "user_reject"
}) | ({
  behavior: "deny"
  message: string
  interrupt?: boolean
  toolUseID?: string
  decisionClassification?: "user_temporary" | "user_permanent" | "user_reject"
})

/** Permission mode for controlling how tool executions are handled. 'default' - Standard behavior, prompts for dangerous operations. 'acceptEdits' - Auto-accept file edit operations. 'bypassPermissions' - Bypass normal permission prompts while preserving hard safety checks (requires allowDangerouslySkipPermissions). 'fullAccess' - Bypass normal permission prompts and hard safety-check prompts (requires allowDangerouslySkipPermissions). 'plan' - Planning mode, no actual tool execution. 'dontAsk' - Don't prompt for permissions, deny if not pre-approved. */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"

export type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Notification" | "UserPromptSubmit" | "SessionStart" | "SessionEnd" | "Stop" | "StopFailure" | "SubagentStart" | "SubagentStop" | "PreCompact" | "PostCompact" | "PermissionRequest" | "PermissionDenied" | "Setup" | "TeammateIdle" | "TaskCreated" | "TaskCompleted" | "Elicitation" | "ElicitationResult" | "ConfigChange" | "WorktreeCreate" | "WorktreeRemove" | "InstructionsLoaded" | "CwdChanged" | "FileChanged"

export type BaseHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
}

export type PreToolUseHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PreToolUse"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

export type PostToolUseHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PostToolUse"
  tool_name: string
  tool_input: unknown
  tool_response: unknown
  tool_use_id: string
}

export type PostToolUseFailureHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PostToolUseFailure"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  error: string
  is_interrupt?: boolean
}

export type PermissionDeniedHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PermissionDenied"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  reason: string
}

export type NotificationHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Notification"
  message: string
  title?: string
  notification_type: string
}

export type UserPromptSubmitHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "UserPromptSubmit"
  prompt: string
}

export type SessionStartHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SessionStart"
  source: "startup" | "resume" | "clear" | "compact"
  agent_type?: string
  model?: string
}

export type SessionEndHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SessionEnd"
  reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled"
}

export type StopHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Stop"
  stop_hook_active: boolean
  last_assistant_message?: string
}

export type StopFailureHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "StopFailure"
  error: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  error_details?: string
  last_assistant_message?: string
}

export type SubagentStartHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SubagentStart"
  agent_id: string
  agent_type: string
}

export type SubagentStopHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SubagentStop"
  stop_hook_active: boolean
  agent_id: string
  agent_transcript_path: string
  agent_type: string
  last_assistant_message?: string
}

export type PreCompactHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PreCompact"
  trigger: "manual" | "auto"
  custom_instructions: string | null
}

export type PostCompactHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PostCompact"
  trigger: "manual" | "auto"
  compact_summary: string
}

export type PermissionRequestHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PermissionRequest"
  tool_name: string
  tool_input: unknown
  permission_suggestions?: (({
    type: "addRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "replaceRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "removeRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "setMode"
    mode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "addDirectories"
    directories: string[]
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "removeDirectories"
    directories: string[]
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }))[]
}

export type SetupHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Setup"
  trigger: "init" | "maintenance"
}

export type TeammateIdleHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "TeammateIdle"
  teammate_name: string
  team_name: string
}

export type TaskCreatedHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "TaskCreated"
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export type TaskCompletedHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "TaskCompleted"
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

/** Hook input for the Elicitation event. Fired when an MCP server requests user input. Hooks can auto-respond (accept/decline) instead of showing the dialog. */
export type ElicitationHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Elicitation"
  mcp_server_name: string
  message: string
  mode?: "form" | "url"
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}

/** Hook input for the ElicitationResult event. Fired after the user responds to an MCP elicitation. Hooks can observe or override the response before it is sent to the server. */
export type ElicitationResultHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "ElicitationResult"
  mcp_server_name: string
  elicitation_id?: string
  mode?: "form" | "url"
  action: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}

export type ConfigChangeHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "ConfigChange"
  source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills"
  file_path?: string
}

export type InstructionsLoadedHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "InstructionsLoaded"
  file_path: string
  memory_type: "User" | "Project" | "Local" | "Managed"
  load_reason: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact"
  globs?: string[]
  trigger_file_path?: string
  parent_file_path?: string
}

export type WorktreeCreateHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "WorktreeCreate"
  name: string
}

export type WorktreeRemoveHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "WorktreeRemove"
  worktree_path: string
}

export type CwdChangedHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "CwdChanged"
  old_cwd: string
  new_cwd: string
}

export type FileChangedHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "FileChanged"
  file_path: string
  event: "change" | "add" | "unlink"
}

export type HookInput = ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PreToolUse"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PostToolUse"
  tool_name: string
  tool_input: unknown
  tool_response: unknown
  tool_use_id: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PostToolUseFailure"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  error: string
  is_interrupt?: boolean
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PermissionDenied"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  reason: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Notification"
  message: string
  title?: string
  notification_type: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "UserPromptSubmit"
  prompt: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SessionStart"
  source: "startup" | "resume" | "clear" | "compact"
  agent_type?: string
  model?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SessionEnd"
  reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled"
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Stop"
  stop_hook_active: boolean
  last_assistant_message?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "StopFailure"
  error: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  error_details?: string
  last_assistant_message?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SubagentStart"
  agent_id: string
  agent_type: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "SubagentStop"
  stop_hook_active: boolean
  agent_id: string
  agent_transcript_path: string
  agent_type: string
  last_assistant_message?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PreCompact"
  trigger: "manual" | "auto"
  custom_instructions: string | null
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PostCompact"
  trigger: "manual" | "auto"
  compact_summary: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "PermissionRequest"
  tool_name: string
  tool_input: unknown
  permission_suggestions?: (({
    type: "addRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "replaceRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "removeRules"
    rules: {
      toolName: string
      ruleContent?: string
    }[]
    behavior: "allow" | "deny" | "ask"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "setMode"
    mode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "addDirectories"
    directories: string[]
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }) | ({
    type: "removeDirectories"
    directories: string[]
    destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
  }))[]
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Setup"
  trigger: "init" | "maintenance"
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "TeammateIdle"
  teammate_name: string
  team_name: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "TaskCreated"
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "TaskCompleted"
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "Elicitation"
  mcp_server_name: string
  message: string
  mode?: "form" | "url"
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "ElicitationResult"
  mcp_server_name: string
  elicitation_id?: string
  mode?: "form" | "url"
  action: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "ConfigChange"
  source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills"
  file_path?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "InstructionsLoaded"
  file_path: string
  memory_type: "User" | "Project" | "Local" | "Managed"
  load_reason: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact"
  globs?: string[]
  trigger_file_path?: string
  parent_file_path?: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "WorktreeCreate"
  name: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "WorktreeRemove"
  worktree_path: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "CwdChanged"
  old_cwd: string
  new_cwd: string
}) | ({
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} & {
  hook_event_name: "FileChanged"
  file_path: string
  event: "change" | "add" | "unlink"
})

export type AsyncHookJSONOutput = {
  async: true
  asyncTimeout?: number
}

export type PreToolUseHookSpecificOutput = {
  hookEventName: "PreToolUse"
  permissionDecision?: "allow" | "deny" | "ask"
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

export type UserPromptSubmitHookSpecificOutput = {
  hookEventName: "UserPromptSubmit"
  additionalContext?: string
}

export type SessionStartHookSpecificOutput = {
  hookEventName: "SessionStart"
  additionalContext?: string
  initialUserMessage?: string
  watchPaths?: string[]
}

export type SetupHookSpecificOutput = {
  hookEventName: "Setup"
  additionalContext?: string
}

export type SubagentStartHookSpecificOutput = {
  hookEventName: "SubagentStart"
  additionalContext?: string
}

export type PostToolUseHookSpecificOutput = {
  hookEventName: "PostToolUse"
  additionalContext?: string
  updatedMCPToolOutput?: unknown
}

export type PostToolUseFailureHookSpecificOutput = {
  hookEventName: "PostToolUseFailure"
  additionalContext?: string
}

export type PermissionDeniedHookSpecificOutput = {
  hookEventName: "PermissionDenied"
  retry?: boolean
}

export type NotificationHookSpecificOutput = {
  hookEventName: "Notification"
  additionalContext?: string
}

export type PermissionRequestHookSpecificOutput = {
  hookEventName: "PermissionRequest"
  decision: ({
    behavior: "allow"
    updatedInput?: Record<string, unknown>
    updatedPermissions?: (({
      type: "addRules"
      rules: {
        toolName: string
        ruleContent?: string
      }[]
      behavior: "allow" | "deny" | "ask"
      destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
    }) | ({
      type: "replaceRules"
      rules: {
        toolName: string
        ruleContent?: string
      }[]
      behavior: "allow" | "deny" | "ask"
      destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
    }) | ({
      type: "removeRules"
      rules: {
        toolName: string
        ruleContent?: string
      }[]
      behavior: "allow" | "deny" | "ask"
      destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
    }) | ({
      type: "setMode"
      mode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
      destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
    }) | ({
      type: "addDirectories"
      directories: string[]
      destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
    }) | ({
      type: "removeDirectories"
      directories: string[]
      destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
    }))[]
  }) | ({
    behavior: "deny"
    message?: string
    interrupt?: boolean
  })
}

export type CwdChangedHookSpecificOutput = {
  hookEventName: "CwdChanged"
  watchPaths?: string[]
}

export type FileChangedHookSpecificOutput = {
  hookEventName: "FileChanged"
  watchPaths?: string[]
}

/** Hook-specific output for the Elicitation event. Return this to programmatically accept or decline an MCP elicitation request. */
export type ElicitationHookSpecificOutput = {
  hookEventName: "Elicitation"
  action?: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}

/** Hook-specific output for the ElicitationResult event. Return this to override the action or content before the response is sent to the MCP server. */
export type ElicitationResultHookSpecificOutput = {
  hookEventName: "ElicitationResult"
  action?: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}

/** Hook-specific output for the WorktreeCreate event. Provides the absolute path to the created worktree directory. Command hooks print the path on stdout instead. */
export type WorktreeCreateHookSpecificOutput = {
  hookEventName: "WorktreeCreate"
  worktreePath: string
}

export type SyncHookJSONOutput = {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: "approve" | "block"
  systemMessage?: string
  reason?: string
  hookSpecificOutput?: ({
    hookEventName: "PreToolUse"
    permissionDecision?: "allow" | "deny" | "ask"
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    additionalContext?: string
  }) | ({
    hookEventName: "UserPromptSubmit"
    additionalContext?: string
  }) | ({
    hookEventName: "SessionStart"
    additionalContext?: string
    initialUserMessage?: string
    watchPaths?: string[]
  }) | ({
    hookEventName: "Setup"
    additionalContext?: string
  }) | ({
    hookEventName: "SubagentStart"
    additionalContext?: string
  }) | ({
    hookEventName: "PostToolUse"
    additionalContext?: string
    updatedMCPToolOutput?: unknown
  }) | ({
    hookEventName: "PostToolUseFailure"
    additionalContext?: string
  }) | ({
    hookEventName: "PermissionDenied"
    retry?: boolean
  }) | ({
    hookEventName: "Notification"
    additionalContext?: string
  }) | ({
    hookEventName: "PermissionRequest"
    decision: ({
      behavior: "allow"
      updatedInput?: Record<string, unknown>
      updatedPermissions?: (({
        type: "addRules"
        rules: {
          toolName: string
          ruleContent?: string
        }[]
        behavior: "allow" | "deny" | "ask"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "replaceRules"
        rules: {
          toolName: string
          ruleContent?: string
        }[]
        behavior: "allow" | "deny" | "ask"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "removeRules"
        rules: {
          toolName: string
          ruleContent?: string
        }[]
        behavior: "allow" | "deny" | "ask"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "setMode"
        mode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "addDirectories"
        directories: string[]
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "removeDirectories"
        directories: string[]
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }))[]
    }) | ({
      behavior: "deny"
      message?: string
      interrupt?: boolean
    })
  }) | ({
    hookEventName: "Elicitation"
    action?: "accept" | "decline" | "cancel"
    content?: Record<string, unknown>
  }) | ({
    hookEventName: "ElicitationResult"
    action?: "accept" | "decline" | "cancel"
    content?: Record<string, unknown>
  }) | ({
    hookEventName: "CwdChanged"
    watchPaths?: string[]
  }) | ({
    hookEventName: "FileChanged"
    watchPaths?: string[]
  }) | ({
    hookEventName: "WorktreeCreate"
    worktreePath: string
  })
}

export type HookJSONOutput = ({
  async: true
  asyncTimeout?: number
}) | ({
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: "approve" | "block"
  systemMessage?: string
  reason?: string
  hookSpecificOutput?: ({
    hookEventName: "PreToolUse"
    permissionDecision?: "allow" | "deny" | "ask"
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    additionalContext?: string
  }) | ({
    hookEventName: "UserPromptSubmit"
    additionalContext?: string
  }) | ({
    hookEventName: "SessionStart"
    additionalContext?: string
    initialUserMessage?: string
    watchPaths?: string[]
  }) | ({
    hookEventName: "Setup"
    additionalContext?: string
  }) | ({
    hookEventName: "SubagentStart"
    additionalContext?: string
  }) | ({
    hookEventName: "PostToolUse"
    additionalContext?: string
    updatedMCPToolOutput?: unknown
  }) | ({
    hookEventName: "PostToolUseFailure"
    additionalContext?: string
  }) | ({
    hookEventName: "PermissionDenied"
    retry?: boolean
  }) | ({
    hookEventName: "Notification"
    additionalContext?: string
  }) | ({
    hookEventName: "PermissionRequest"
    decision: ({
      behavior: "allow"
      updatedInput?: Record<string, unknown>
      updatedPermissions?: (({
        type: "addRules"
        rules: {
          toolName: string
          ruleContent?: string
        }[]
        behavior: "allow" | "deny" | "ask"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "replaceRules"
        rules: {
          toolName: string
          ruleContent?: string
        }[]
        behavior: "allow" | "deny" | "ask"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "removeRules"
        rules: {
          toolName: string
          ruleContent?: string
        }[]
        behavior: "allow" | "deny" | "ask"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "setMode"
        mode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "addDirectories"
        directories: string[]
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }) | ({
        type: "removeDirectories"
        directories: string[]
        destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
      }))[]
    }) | ({
      behavior: "deny"
      message?: string
      interrupt?: boolean
    })
  }) | ({
    hookEventName: "Elicitation"
    action?: "accept" | "decline" | "cancel"
    content?: Record<string, unknown>
  }) | ({
    hookEventName: "ElicitationResult"
    action?: "accept" | "decline" | "cancel"
    content?: Record<string, unknown>
  }) | ({
    hookEventName: "CwdChanged"
    watchPaths?: string[]
  }) | ({
    hookEventName: "FileChanged"
    watchPaths?: string[]
  }) | ({
    hookEventName: "WorktreeCreate"
    worktreePath: string
  })
})

export type PromptRequestOption = {
  key: string
  label: string
  description?: string
}

export type PromptRequest = {
  prompt: string
  message: string
  options: {
    key: string
    label: string
    description?: string
  }[]
}

export type PromptResponse = {
  prompt_response: string
  selected: string
}

/** Information about an available skill (invoked via /command syntax). */
export type SlashCommand = {
  name: string
  description: string
  argumentHint: string
}

/** Information about an available subagent that can be invoked via the Task tool. */
export type AgentInfo = {
  name: string
  description: string
  model?: string
}

/** Information about an available model. */
export type ModelInfo = {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ("low" | "medium" | "high" | "xhigh" | "max" | "ultracode")[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

/** Information about the logged in user's account. */
export type AccountInfo = {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry" | "openai" | "gemini" | "gemini-vertex" | "github" | "codex" | "nvidia-nim" | "minimax" | "mistral" | "xai" | "xiaomi-mimo"
}

export type AgentMcpServerSpec = string | (Record<string, ({
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}) | ({
  type: "sse"
  url: string
  headers?: Record<string, string>
}) | ({
  type: "http"
  url: string
  headers?: Record<string, string>
}) | ({
  type: "sdk"
  name: string
})>)

/** Definition for a custom subagent that can be invoked via the Agent tool. */
export type AgentDefinition = {
  description: string
  tools?: string[]
  disallowedTools?: string[]
  prompt: string
  model?: string
  mcpServers?: (string | (Record<string, ({
    type?: "stdio"
    command: string
    args?: string[]
    env?: Record<string, string>
  }) | ({
    type: "sse"
    url: string
    headers?: Record<string, string>
  }) | ({
    type: "http"
    url: string
    headers?: Record<string, string>
  }) | ({
    type: "sdk"
    name: string
  })>))[]
  criticalSystemReminder_EXPERIMENTAL?: string
  skills?: string[]
  initialPrompt?: string
  maxTurns?: number
  maxSteps?: number
  background?: boolean
  memory?: "user" | "project" | "local"
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | number
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
}

/** Source for loading filesystem-based settings. 'user' - Global user settings (~/.openclaude/settings.json). 'project' - Project settings (.openclaude/settings.json). 'local' - Local settings (.openclaude/settings.local.json). */
export type SettingSource = "user" | "project" | "local"

/** Configuration for loading a plugin. */
export type SdkPluginConfig = {
  type: "local"
  path: string
}

/** Result of a rewindFiles operation. */
export type RewindFilesResult = {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type SDKAssistantMessageError = "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"

export type SDKStatus = "compacting" | null

export type SDKUserMessage = {
  type: "user"
  message: Record<string, unknown> & { role: "user", content: string | Array<unknown> }
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: "now" | "next" | "later"
  timestamp?: string
  uuid?: string
  session_id?: string
}

export type SDKUserMessageReplay = {
  type: "user"
  message: Record<string, unknown> & { role: "user", content: string | Array<unknown> }
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: "now" | "next" | "later"
  timestamp?: string
  uuid: string
  session_id: string
  isReplay: true
}

/** Rate limit information for claude.ai subscription users. */
export type SDKRateLimitInfo = {
  status: "allowed" | "allowed_warning" | "rejected"
  resetsAt?: number
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage"
  utilization?: number
  overageStatus?: "allowed" | "allowed_warning" | "rejected"
  overageResetsAt?: number
  overageDisabledReason?: "overage_not_provisioned" | "org_level_disabled" | "org_level_disabled_until" | "out_of_credits" | "seat_tier_level_disabled" | "member_level_disabled" | "seat_tier_zero_credit_limit" | "group_zero_credit_limit" | "member_zero_credit_limit" | "org_service_level_disabled" | "org_service_zero_credit_limit" | "no_limits_configured" | "unknown"
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

export type SDKAssistantMessage = {
  type: "assistant"
  message: Record<string, unknown> & { role: "assistant", content: Array<unknown> }
  parent_tool_use_id: string | null
  error?: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  uuid: string
  session_id: string
}

/** Rate limit event emitted when rate limit info changes. */
export type SDKRateLimitEvent = {
  type: "rate_limit_event"
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected"
    resetsAt?: number
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage"
    utilization?: number
    overageStatus?: "allowed" | "allowed_warning" | "rejected"
    overageResetsAt?: number
    overageDisabledReason?: "overage_not_provisioned" | "org_level_disabled" | "org_level_disabled_until" | "out_of_credits" | "seat_tier_level_disabled" | "member_level_disabled" | "seat_tier_zero_credit_limit" | "group_zero_credit_limit" | "member_zero_credit_limit" | "org_service_level_disabled" | "org_service_zero_credit_limit" | "no_limits_configured" | "unknown"
    isUsingOverage?: boolean
    surpassedThreshold?: number
  }
  uuid: string
  session_id: string
}

/** @internal Streamlined text message - replaces SDKAssistantMessage in streamlined output. Text content preserved, thinking and tool_use blocks removed. */
export type SDKStreamlinedTextMessage = {
  type: "streamlined_text"
  text: string
  session_id: string
  uuid: string
}

/** @internal Streamlined tool use summary - replaces tool_use blocks in streamlined output with a cumulative summary string. */
export type SDKStreamlinedToolUseSummaryMessage = {
  type: "streamlined_tool_use_summary"
  tool_summary: string
  session_id: string
  uuid: string
}

export type SDKPermissionDenial = {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

export type SDKResultSuccess = {
  type: "result"
  subtype: "success"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    contextWindow: number
    maxOutputTokens: number
  }>
  permission_denials: {
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }[]
  structured_output?: unknown
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}

export type SDKResultError = {
  type: "result"
  subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    contextWindow: number
    maxOutputTokens: number
  }>
  permission_denials: {
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }[]
  errors: string[]
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}

export type SDKResultMessage = ({
  type: "result"
  subtype: "success"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    contextWindow: number
    maxOutputTokens: number
  }>
  permission_denials: {
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }[]
  structured_output?: unknown
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}) | ({
  type: "result"
  subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    contextWindow: number
    maxOutputTokens: number
  }>
  permission_denials: {
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }[]
  errors: string[]
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
})

export type SDKSystemMessage = {
  type: "system"
  subtype: "init"
  agents?: string[]
  apiKeySource: "user" | "project" | "org" | "temporary" | "oauth" | "none"
  betas?: string[]
  claude_code_version: string
  cwd: string
  tools: string[]
  mcp_servers: {
    name: string
    status: string
  }[]
  model: string
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
  slash_commands: string[]
  output_style: string
  skills: string[]
  plugins: {
    name: string
    path: string
    source?: string
  }[]
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}

export type SDKPartialAssistantMessage = {
  type: "stream_event"
  event: Record<string, unknown>
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

export type SDKCompactBoundaryMessage = {
  type: "system"
  subtype: "compact_boundary"
  compact_metadata: {
    trigger: "manual" | "auto"
    pre_tokens: number
    preserved_segment?: {
      head_uuid: string
      anchor_uuid: string
      tail_uuid: string
    }
  }
  uuid: string
  session_id: string
}

export type SDKStatusMessage = {
  type: "system"
  subtype: "status"
  status: "compacting" | null
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
  uuid: string
  session_id: string
}

/** @internal Background post-turn summary emitted after each assistant turn. summarizes_uuid points to the assistant message this summarizes. */
export type SDKPostTurnSummaryMessage = {
  type: "system"
  subtype: "post_turn_summary"
  summarizes_uuid: string
  status_category: "blocked" | "waiting" | "completed" | "review_ready" | "failed"
  status_detail: string
  is_noteworthy: boolean
  title: string
  description: string
  recent_action: string
  needs_action: string
  artifact_urls: string[]
  uuid: string
  session_id: string
}

/** Emitted when an API request fails with a retryable error and will be retried after a delay. error_status is null for connection errors (e.g. timeouts) that had no HTTP response. */
export type SDKAPIRetryMessage = {
  type: "system"
  subtype: "api_retry"
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  uuid: string
  session_id: string
}

/** Output from a local slash command (e.g. /voice, /cost). Displayed as assistant-style text in the transcript. */
export type SDKLocalCommandOutputMessage = {
  type: "system"
  subtype: "local_command_output"
  content: string
  uuid: string
  session_id: string
}

export type SDKHookStartedMessage = {
  type: "system"
  subtype: "hook_started"
  hook_id: string
  hook_name: string
  hook_event: string
  uuid: string
  session_id: string
}

export type SDKHookProgressMessage = {
  type: "system"
  subtype: "hook_progress"
  hook_id: string
  hook_name: string
  hook_event: string
  stdout: string
  stderr: string
  output: string
  uuid: string
  session_id: string
}

export type SDKHookResponseMessage = {
  type: "system"
  subtype: "hook_response"
  hook_id: string
  hook_name: string
  hook_event: string
  output: string
  stdout: string
  stderr: string
  exit_code?: number
  outcome: "success" | "error" | "cancelled"
  uuid: string
  session_id: string
}

export type SDKToolProgressMessage = {
  type: "tool_progress"
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  task_id?: string
  uuid: string
  session_id: string
}

export type SDKAuthStatusMessage = {
  type: "auth_status"
  isAuthenticating: boolean
  output: string[]
  error?: string
  uuid: string
  session_id: string
}

export type SDKFilesPersistedEvent = {
  type: "system"
  subtype: "files_persisted"
  files: {
    filename: string
    file_id: string
  }[]
  failed: {
    filename: string
    error: string
  }[]
  processed_at: string
  uuid: string
  session_id: string
}

export type SDKTaskNotificationMessage = {
  type: "system"
  subtype: "task_notification"
  task_id: string
  tool_use_id?: string
  status: "completed" | "failed" | "stopped"
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  uuid: string
  session_id: string
}

export type SDKTaskStartedMessage = {
  type: "system"
  subtype: "task_started"
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
  uuid: string
  session_id: string
}

export type SDKTaskProgressMessage = {
  type: "system"
  subtype: "task_progress"
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  uuid: string
  session_id: string
}

/** Mirrors notifySessionStateChanged. 'idle' fires after heldBackResult flushes and the bg-agent do-while exits — authoritative turn-over signal. */
export type SDKSessionStateChangedMessage = {
  type: "system"
  subtype: "session_state_changed"
  state: "idle" | "running" | "requires_action"
  uuid: string
  session_id: string
}

/** Opt-in headless liveness signal emitted while --print output is quiet. */
export type SDKHeartbeatMessage = {
  type: "system"
  subtype: "heartbeat"
  timestamp: string
  elapsed_ms: number
  since_last_activity_ms: number
  state: "starting" | "running" | "requires_action" | "idle" | "shutting_down"
  phase: "startup" | "loading_session" | "connecting_mcp" | "draining_commands" | "in_turn" | "waiting_for_permission" | "waiting_for_agents" | "flushing" | "shutting_down"
  heartbeat_index: number
  pending_permission_requests: number
  background_tasks: Record<string, number>
  uuid: string
  session_id: string
}

export type SDKToolUseSummaryMessage = {
  type: "tool_use_summary"
  summary: string
  preceding_tool_use_ids: string[]
  uuid: string
  session_id: string
}

/** Emitted when an MCP server confirms that a URL-mode elicitation is complete. */
export type SDKElicitationCompleteMessage = {
  type: "system"
  subtype: "elicitation_complete"
  mcp_server_name: string
  elicitation_id: string
  uuid: string
  session_id: string
}

/** Predicted next user prompt, emitted after each turn when promptSuggestions is enabled. */
export type SDKPromptSuggestionMessage = {
  type: "prompt_suggestion"
  suggestion: string
  uuid: string
  session_id: string
}

/** Session metadata returned by listSessions and getSessionInfo. */
export type SDKSessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

export type SDKMessage = ({
  type: "assistant"
  message: Record<string, unknown> & { role: "assistant", content: Array<unknown> }
  parent_tool_use_id: string | null
  error?: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  uuid: string
  session_id: string
}) | ({
  type: "user"
  message: Record<string, unknown> & { role: "user", content: string | Array<unknown> }
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: "now" | "next" | "later"
  timestamp?: string
  uuid?: string
  session_id?: string
}) | ({
  type: "user"
  message: Record<string, unknown> & { role: "user", content: string | Array<unknown> }
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: "now" | "next" | "later"
  timestamp?: string
  uuid: string
  session_id: string
  isReplay: true
}) | (({
  type: "result"
  subtype: "success"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    contextWindow: number
    maxOutputTokens: number
  }>
  permission_denials: {
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }[]
  structured_output?: unknown
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}) | ({
  type: "result"
  subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    contextWindow: number
    maxOutputTokens: number
  }>
  permission_denials: {
    tool_name: string
    tool_use_id: string
    tool_input: Record<string, unknown>
  }[]
  errors: string[]
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
})) | ({
  type: "system"
  subtype: "init"
  agents?: string[]
  apiKeySource: "user" | "project" | "org" | "temporary" | "oauth" | "none"
  betas?: string[]
  claude_code_version: string
  cwd: string
  tools: string[]
  mcp_servers: {
    name: string
    status: string
  }[]
  model: string
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
  slash_commands: string[]
  output_style: string
  skills: string[]
  plugins: {
    name: string
    path: string
    source?: string
  }[]
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}) | ({
  type: "stream_event"
  event: Record<string, unknown>
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "compact_boundary"
  compact_metadata: {
    trigger: "manual" | "auto"
    pre_tokens: number
    preserved_segment?: {
      head_uuid: string
      anchor_uuid: string
      tail_uuid: string
    }
  }
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "status"
  status: "compacting" | null
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "fullAccess" | "plan" | "dontAsk"
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "api_retry"
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "local_command_output"
  content: string
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "hook_started"
  hook_id: string
  hook_name: string
  hook_event: string
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "hook_progress"
  hook_id: string
  hook_name: string
  hook_event: string
  stdout: string
  stderr: string
  output: string
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "hook_response"
  hook_id: string
  hook_name: string
  hook_event: string
  output: string
  stdout: string
  stderr: string
  exit_code?: number
  outcome: "success" | "error" | "cancelled"
  uuid: string
  session_id: string
}) | ({
  type: "tool_progress"
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  task_id?: string
  uuid: string
  session_id: string
}) | ({
  type: "auth_status"
  isAuthenticating: boolean
  output: string[]
  error?: string
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "task_notification"
  task_id: string
  tool_use_id?: string
  status: "completed" | "failed" | "stopped"
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "task_started"
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "task_progress"
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "session_state_changed"
  state: "idle" | "running" | "requires_action"
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "heartbeat"
  timestamp: string
  elapsed_ms: number
  since_last_activity_ms: number
  state: "starting" | "running" | "requires_action" | "idle" | "shutting_down"
  phase: "startup" | "loading_session" | "connecting_mcp" | "draining_commands" | "in_turn" | "waiting_for_permission" | "waiting_for_agents" | "flushing" | "shutting_down"
  heartbeat_index: number
  pending_permission_requests: number
  background_tasks: Record<string, number>
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "files_persisted"
  files: {
    filename: string
    file_id: string
  }[]
  failed: {
    filename: string
    error: string
  }[]
  processed_at: string
  uuid: string
  session_id: string
}) | ({
  type: "tool_use_summary"
  summary: string
  preceding_tool_use_ids: string[]
  uuid: string
  session_id: string
}) | ({
  type: "rate_limit_event"
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected"
    resetsAt?: number
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage"
    utilization?: number
    overageStatus?: "allowed" | "allowed_warning" | "rejected"
    overageResetsAt?: number
    overageDisabledReason?: "overage_not_provisioned" | "org_level_disabled" | "org_level_disabled_until" | "out_of_credits" | "seat_tier_level_disabled" | "member_level_disabled" | "seat_tier_zero_credit_limit" | "group_zero_credit_limit" | "member_zero_credit_limit" | "org_service_level_disabled" | "org_service_zero_credit_limit" | "no_limits_configured" | "unknown"
    isUsingOverage?: boolean
    surpassedThreshold?: number
  }
  uuid: string
  session_id: string
}) | ({
  type: "system"
  subtype: "elicitation_complete"
  mcp_server_name: string
  elicitation_id: string
  uuid: string
  session_id: string
}) | ({
  type: "prompt_suggestion"
  suggestion: string
  uuid: string
  session_id: string
}) | ({
  type: "permission_request"
  request_id: string
  tool_name: string
  tool_use_id: string
  input: Record<string, unknown>
  uuid: string
  session_id: string
})

/** Fast mode state: off, in cooldown after rate limit, or actively enabled. */
export type FastModeState = "off" | "cooldown" | "on"

export type ExitReason = "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled"
