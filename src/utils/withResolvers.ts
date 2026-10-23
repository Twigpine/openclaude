/**
 * Polyfill for Promise.withResolvers() (ES2024, Node 22+).
 * Native on every supported runtime (engines.node >=24.22.1); kept as a
 * thin wrapper so call sites stay stable and downstream embeds running older Node
 * (despite the warning) don't crash.
 */
// Local copy of the ES2024 lib type — tsconfig lib is ES2023, which predates it.
export interface PromiseWithResolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
