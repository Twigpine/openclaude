/** Filter ordinary suggestions only; explicit saved/custom model IDs stay valid. */
export function isCurrentMiniMaxModelOption(model: string | null): boolean {
  if (model === null) return true
  const name = model.trim().toLowerCase().split('/').at(-1)!.split('?', 1)[0]!
  if (!/^(minimax-(?:m\d|text-|\d)|abab\d)/.test(name)) return true
  return /^(minimax-m3(?:\.1-flash)?)(?::free|-free)?$/.test(name)
}
