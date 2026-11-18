/**
 * Keeps a list's key array in step with its messages. Streaming only appends,
 * so the cached prefix is reused unless the list shrank, its first message
 * changed, or the caller says rows can be replaced in place (focus view
 * swaps rows at an unchanged length). Returns the same array when nothing
 * needed rebuilding past the append.
 */
export function syncItemKeys<M>(
  keys: string[],
  prevMessages: readonly M[],
  messages: readonly M[],
  itemKey: (m: M) => string,
  opts: { itemKeyChanged: boolean; rekeyOnChange: boolean },
): string[] {
  if (
    opts.itemKeyChanged ||
    messages.length < keys.length ||
    messages[0] !== prevMessages[0] ||
    (opts.rekeyOnChange && messages !== prevMessages)
  ) {
    return messages.map(m => itemKey(m))
  }
  for (let i = keys.length; i < messages.length; i++) {
    keys.push(itemKey(messages[i]!))
  }
  return keys
}
