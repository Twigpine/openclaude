export function isolateProcessExitCode(initialCode = process.exitCode): () => void {
  const originalProcess = globalThis.process
  let exitCode = initialCode

  globalThis.process = new Proxy(originalProcess, {
    get(target, property) {
      return property === 'exitCode'
        ? exitCode
        : Reflect.get(target, property, target)
    },
    set(target, property, value) {
      if (property === 'exitCode') {
        exitCode = value
        return true
      }
      return Reflect.set(target, property, value, target)
    },
  })

  return () => {
    globalThis.process = originalProcess
  }
}
