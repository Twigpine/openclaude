/** Filter ordinary suggestions only; explicit saved/custom model IDs stay valid. */
export function isCurrentMiniMaxModelOption(model: string | null, routeId?: string | null): boolean {
  // Ollama owns the availability and names of its installed/cloud models.
  // MiniMax's direct retirement policy does not apply to that server's list.
  if (model === null || routeId === 'ollama') return true
  const name = model.trim().toLowerCase().split('/').at(-1)!.split('?', 1)[0]!
  if (!/^(minimax-(?:m\d|text-|\d)|abab\d)/.test(name)) return true
  // Retired Zen "-free" IDs remain raw metadata for explicit saved selections.
  return /^(minimax-m3(?:\.1-flash)?)(?::free)?$/.test(name)
}
