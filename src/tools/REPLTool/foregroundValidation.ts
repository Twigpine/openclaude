export function validateReplForegroundOnlyInput(toolName: string, input: unknown): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return
  const record = input as Record<string, unknown>
  if ('run_in_background' in record) {
    throw new Error(`${toolName} run_in_background is unavailable inside REPL foreground scripts`)
  }
  if (toolName === 'Agent') {
    for (const key of ['name', 'team_name', 'mode', 'isolation', 'model'] as const) {
      if (record[key] !== undefined) {
        throw new Error(`Agent ${key} override is unavailable inside REPL foreground scripts`)
      }
    }
  }
}
