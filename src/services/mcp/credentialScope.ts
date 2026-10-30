/**
 * Where a sign-in finishes what it started.
 *
 * The credential store is chosen from the environment at each read and
 * write: `getSecureStorage()` and the needs-auth cache both resolve
 * `OPENCLAUDE_CONFIG_DIR` when called. A flow started inside an embedder's
 * turn hands out its URL and then waits for the user's browser, and by the
 * time the callback arrives the turn may have put the process's own
 * environment back, or another session's turn may have applied its own
 * (v2.ts `applySessionEnv`, query.ts). Left to the environment of the moment,
 * the flow would finish — read its registered client, store its tokens, drop
 * its needs-auth cache entry — in another store.
 *
 * So what a flow reads or writes after such a wait runs through its scope,
 * which re-applies the environment the flow started in: the store writes
 * themselves where they stand alone (the XAA tokens, the IdP's id_token),
 * and the code exchange where the SDK reads the client and stores the tokens
 * inside it. The SDK supplies a scope that puts the turn's variable back
 * under the env mutex its turns hold (permissions.ts); the CLI, whose
 * environment does not change, supplies none. A scope is never entered
 * while the caller is still waiting on the flow: a turn holding the env
 * mutex would then wait on itself.
 */
export type CredentialScope = <T>(work: () => Promise<T>) => Promise<T>

/** Runs `work` in `scope` where there is one, and as it is where there is not. */
export function resumeIn<T>(
  scope: CredentialScope | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return scope ? scope(work) : work()
}
