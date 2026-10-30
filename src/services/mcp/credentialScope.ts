/**
 * Where a sign-in finishes what it started.
 *
 * The credential store is chosen from the environment at each read and
 * write: the secure store's backends resolve the config home, the vault
 * service name (which also carries the OAuth namespace) and the vault account
 * when they are called, and the needs-auth cache file sits in that config
 * home. A flow
 * started inside an embedder's turn hands out its URL and then waits for the
 * user's browser, and by the time the callback arrives the turn may have put
 * the process's own environment back, or another session's turn may have
 * applied its own (v2.ts `applySessionEnv`, query.ts). Left to the
 * environment of the moment, the flow would finish — read its registered
 * client, store its tokens, drop its needs-auth cache entry — in another
 * store.
 *
 * So what a flow reads or writes after such a wait runs through its scope,
 * which re-applies the environment the flow started in: the store writes
 * themselves where they stand alone (the XAA tokens, the IdP's id_token),
 * and the code exchange where the SDK reads the client and stores the tokens
 * inside it. The SDK supplies a scope that puts the turn's environment back
 * under the env mutex its turns hold (permissions.ts); the CLI, whose
 * environment does not change, supplies none. A scope is never entered
 * by taking the mutex again while its caller still owns it. A streaming
 * query can instead lend its active environment to the continuation, and
 * waits for that work before restoring it.
 */
export type CredentialScope = <T>(work: () => Promise<T>) => Promise<T>

/** Runs work under an existing owner, or declines once that owner is leaving. */
export type ActiveCredentialScope = <T>(work: () => Promise<T>) => Promise<T> | undefined

/** Runs `work` in `scope` where there is one, and as it is where there is not. */
export function resumeIn<T>(
  scope: CredentialScope | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return scope ? scope(work) : work()
}
