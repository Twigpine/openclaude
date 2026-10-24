/**
 * memlawb — durable, end-to-end-encrypted agent memory as an opt-in MCP server.
 *
 * memlawb is a zero-knowledge memory backend. The `memlawb mcp` process runs
 * locally, holds the passphrase, and encrypts before anything leaves the
 * machine, so the remote server stores ciphertext it could not decrypt.
 *
 * Two shapes of this plugin are deliberate rather than incidental:
 *
 * 1. It contributes an MCP server and NOTHING else — no skill, no hook, no
 *    agent. openclaude's own memdir pipeline and team memory keep working
 *    untouched, so enabling this adds a tool surface and no prompting.
 *
 * 2. Every environment value is a `${VAR}` reference, never a literal, and the
 *    passphrase rides as a PATH to a file rather than as the secret itself.
 *
 * Why the path, specifically. Plugin MCP env goes through
 * resolvePluginMcpEnvironment, which expands from openclaude's own process
 * environment, and the stdio transport then spawns each child with
 * `{ ...subprocessEnv(), ...serverRef.env }` (src/services/mcp/client.ts:1056)
 * — and `subprocessEnv()` returns `process.env` itself
 * (src/utils/subprocessEnv.ts:79-98). So whatever a user exports for this
 * server is handed to every other stdio MCP server they run. A path survives
 * that: knowing where a secret lives is not knowing the secret, and a file can
 * carry permissions an environment variable cannot. The value would not.
 *
 * What this buys, stated honestly: the SECRET no longer rides the shared
 * environment. The path still does, along with the rest of `process.env`, and
 * any MCP server running as the same user could read that file. This narrows
 * the exposure from "every configured MCP server already has your passphrase"
 * to "every configured MCP server knows where it is"; it is not isolation.
 *
 * Path alone, never both. memlawb's startup lets MEMLAWB_PASSPHRASE_FILE win
 * over MEMLAWB_PASSPHRASE when both are set, but its misexpansion check still
 * refuses to start on an unexpanded MEMLAWB_PASSPHRASE (memlawb
 * src/mcp/startup.ts:129,196-205). Declaring both here would therefore break
 * the very configuration this is for — file set, raw variable unset — because
 * openclaude leaves an unset reference as literal `${MEMLAWB_PASSPHRASE}`
 * text. Verified against memlawb's preflight before choosing.
 *
 * Setup is two steps: write the passphrase into a file only you can read
 * (`umask 077`), then export MEMLAWB_PASSPHRASE_FILE pointing at it, alongside
 * MEMLAWB_URL, MEMLAWB_API_KEY and MEMLAWB_NAMESPACE.
 *
 * MEMLAWB_PASSPHRASE_FILE needs memlawb 0.1.0 or newer; earlier builds read
 * only MEMLAWB_PASSPHRASE and would refuse to start with no passphrase at all,
 * which reads as a configuration mistake rather than an out-of-date binary.
 */

import { registerBuiltinPlugin } from '../builtinPlugins.js'

export function registerMemlawbPlugin(): void {
  registerBuiltinPlugin({
    name: 'memlawb',
    description:
      'End-to-end-encrypted agent memory via the memlawb MCP server. Needs memlawb 0.1.0 or newer on PATH, and MEMLAWB_URL, MEMLAWB_API_KEY, MEMLAWB_NAMESPACE and MEMLAWB_PASSPHRASE_FILE (a path to a file holding the passphrase) in the environment.',
    version: '1.0.0',
    defaultEnabled: false,
    mcpServers: {
      memlawb: {
        type: 'stdio',
        command: 'memlawb',
        args: ['mcp'],
        env: {
          MEMLAWB_URL: '${MEMLAWB_URL}',
          MEMLAWB_API_KEY: '${MEMLAWB_API_KEY}',
          MEMLAWB_NAMESPACE: '${MEMLAWB_NAMESPACE}',
          MEMLAWB_PASSPHRASE_FILE: '${MEMLAWB_PASSPHRASE_FILE}',
        },
      },
    },
  })
}
