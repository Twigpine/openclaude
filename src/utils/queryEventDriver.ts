/**
 * Consume a query event generator while preserving the REPL's activity policy:
 * only events yielded to the consumer count as QueryGuard progress.
 */
export async function driveQueryEvents<TEvent extends { type: string }, TReturn>(
  queryGenerator: AsyncGenerator<TEvent, TReturn>,
  registerActivity: (reason: string) => void,
  onEvent: (event: TEvent) => void,
): Promise<TReturn> {
  let generatorDone = false
  try {
    while (true) {
      const next = await queryGenerator.next()
      if (next.done) {
        generatorDone = true
        return next.value
      }
      registerActivity(`query_event:${next.value.type}`)
      onEvent(next.value)
    }
  } finally {
    if (!generatorDone) {
      try {
        await queryGenerator.return(undefined as never)
      } catch {
        // Preserve the generator or event-handler failure that triggered cleanup.
      }
    }
  }
}
