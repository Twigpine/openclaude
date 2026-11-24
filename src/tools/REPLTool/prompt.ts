export function getReplToolDescription(): string {
  return 'Execute JavaScript that orchestrates available tools in this session'
}

export function getReplToolPrompt(): string {
  return `Use this tool to execute JavaScript in an isolated QuickJS runtime.

Available exact-name async functions correspond to the tools enabled for this session, including hidden primitive tools such as Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, and Agent when allowed. MCP tools keep their canonical names. If a canonical tool name is not a legal JavaScript identifier, call it as tool(name, input). The $ function is an alias for Bash when Bash is available.

Write the complete script as the code input. Use return to produce the final value. Use await for every tool call. Use Promise.all for independent calls. Console output is captured and bounded. The runtime has no require, process, import, host object access, or direct filesystem/network access except through permissioned tool functions.

Foreground execution is limited to ten minutes. Background shell work, background agents, recursive REPL calls, control-plane tools, and unavailable tools fail closed. Inner tool calls keep their normal permission names, hooks, validation, and errors. Prefer one orchestrating script over many small direct tool uses when batching reads, searches, edits, or shell commands.`
}
