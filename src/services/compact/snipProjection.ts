export function isSnipBoundaryMessage(message: unknown): boolean {
  return Boolean((message as { snipMetadata?: unknown } | null | undefined)?.snipMetadata)
}

/**
 * Filter a message array to exclude messages removed by prior snip operations.
 * Reads all snipMetadata.removedUuids across all snip boundaries in the array.
 * Used by getMessagesAfterCompactBoundary when HISTORY_SNIP is enabled.
 */
export function projectSnippedView<T>(messages: T[]): T[] {
  const removedUuids = new Set<string>()
  for (const msg of messages) {
    const uuids = (msg as { snipMetadata?: { removedUuids?: unknown } } | null | undefined)?.snipMetadata?.removedUuids
    if (!Array.isArray(uuids)) continue
    for (const uuid of uuids) {
      if (typeof uuid === 'string') removedUuids.add(uuid)
    }
  }
  if (removedUuids.size === 0) return messages
  return messages.filter(msg => {
    const uuid = (msg as { uuid?: string } | null | undefined)?.uuid
    return !uuid || !removedUuids.has(uuid)
  })
}
