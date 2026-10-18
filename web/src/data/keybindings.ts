// Seeded from src/keybindings/defaultBindings.ts. User overrides live in
// ~/.openclaude/keybindings.json (open it with /keybindings).

export interface Keybinding {
  keys: string
  action: string
  context: string
}

export const keybindings: Keybinding[] = [
  { keys: 'Ctrl+C', action: 'Interrupt the current turn', context: 'global' },
  { keys: 'Ctrl+D', action: 'Exit the REPL', context: 'global' },
  { keys: 'Ctrl+L', action: 'Redraw the screen', context: 'global' },
  { keys: 'Ctrl+T', action: 'Toggle the todo list', context: 'global' },
  { keys: 'Ctrl+O', action: 'Toggle the transcript view', context: 'global' },
  { keys: 'Ctrl+R', action: 'Search prompt history', context: 'global' },
  { keys: 'Shift+Tab', action: 'Cycle permission modes', context: 'prompt' },
  { keys: 'Ctrl+V', action: 'Paste an image from the clipboard (Alt+V on Windows). If the image exceeds the 5MB or 8000px API limit, the prompt shows that error instead of “No image found”.', context: 'prompt' },
  { keys: 'Ctrl+S', action: 'Stash the current prompt draft', context: 'prompt' },
  { keys: 'Ctrl+G', action: 'Edit the prompt in your external $EDITOR', context: 'prompt' },
  { keys: 'Ctrl+_ / Ctrl+Shift+-', action: 'Undo in the prompt input', context: 'prompt' },
  { keys: 'Ctrl+P / Ctrl+N', action: 'Previous / next item', context: 'menus & pickers' },
  { keys: 'Ctrl+E', action: 'Toggle the explanation panel', context: 'permission dialogs' },
  { keys: 'Esc', action: 'Cancel / close the current dialog', context: 'dialogs' },
  { keys: 'Shift+Enter', action: 'Insert a newline (install via /terminal-setup)', context: 'prompt' },
]
