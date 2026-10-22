export function snapshotEnv(
  keys: readonly string[],
  options: { clear?: boolean } = {},
): () => void {
  const saved = new Map(
    keys.map(key => [key, process.env[key]] as const),
  )

  if (options.clear) {
    for (const key of saved.keys()) {
      delete process.env[key]
    }
  }

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
