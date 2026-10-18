import * as nodeModule from 'node:module'

/** @typedef {{ enableCompileCache?: () => unknown }} CompileCacheModule */

/**
 * @param {CompileCacheModule} [module=nodeModule]
 */
export function enableNodeCompileCacheIfAvailable(module = nodeModule) {
  const enable = module.enableCompileCache
  if (typeof enable !== 'function') return

  try {
    enable()
  } catch {
    // Compile caching is optional and must never block startup.
  }
}
