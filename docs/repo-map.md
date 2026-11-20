# Codebase Intelligence — Repo Map

The repo map feature gives the AI model structural awareness of your codebase at the start of each session. Instead of the model needing to explore the repository with `Grep`, `Glob`, and `Read` calls, it starts with a ranked summary of the most important files and their key signatures.

## How it works

1. **File enumeration** — Lists tracked files plus untracked, unignored files via `git ls-files --cached --others --exclude-standard` (falls back to a manual directory walk when not in a git repo)
2. **Symbol extraction** — Parses each supported source file with tree-sitter to extract function, class, type, and interface definitions, plus cross-file references
3. **Reference graph** — Builds a directed graph where an edge from file A to file B means A references a symbol defined in B. Edges are weighted by reference count multiplied by the IDF (inverse document frequency) of the symbol name — common names like `get`, `set`, `value` contribute less
4. **PageRank** — Ranks files by structural importance using PageRank. Files imported by many others rank highest
5. **Rendering** — Walks ranked files top-down, emitting file paths and definition signatures, stopping when the token budget is reached

Results are cached to disk (`~/.openclaude/repomap-cache/`) keyed by file path, mtime, and size. Only changed files are re-parsed on subsequent runs.

## Supported languages

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
- Python (`.py`)
- Go (`.go`)
- Rust (`.rs`)
- C (`.c`)
- C++ (`.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`, and `.h`)

Go, Rust, C, and C++ files are parsed with their bundled tree-sitter grammars from
`tree-sitter-wasms`, so no extra install step is needed. The Go query captures
package-level functions, methods, type declarations (including aliases), and
call references. The Rust query captures functions and methods (including those
inside `impl` blocks and bodyless trait signatures such as `fn handle(&self);`),
structs, enums, traits, modules, `impl` type references (including generic
`impl<T> Store<T>`), and call references (including explicit type arguments such
as `helper::<u8>()` and `Store::<u8>::count()`).

The C query captures structs, unions and enums that have a body, `typedef`
aliases (including array aliases), and functions and header prototypes
(including pointer-returning signatures such as `char *dup_string(...)`). The
C++ query captures classes, structs, unions, enums, namespaces, `using` and
`typedef` aliases, and functions and methods — in-class declarations,
out-of-class definitions (including nested names such as `app::Store::count`),
constructors, destructors and operators. Both capture call references, including
`object->method()`, `ns::function()`, nested qualified calls, and explicit
template calls such as `helper<int>(1)`.

`.h` is ambiguous between C and C++. It is parsed with the C++ grammar, which is
a superset of C, so C headers parse correctly while C++ headers keep their
classes, namespaces and templates. Bodyless specifiers (`struct Node;` or a
`struct Node *next;` field) are references, not definitions, so a forward
declaration never adds a duplicate signature line.

Additional language grammars will be added in future releases.

## Enabling auto-injection

The repo map is gated behind the `REPO_MAP` feature flag, **off by default**. To enable auto-injection into the session context:

Set the environment variable before launching:

```bash
REPO_MAP=1 openclaude
```

Or add it to your shell profile for persistent use.

When enabled, the map is built once per session and prepended to the system context alongside git status and CLAUDE.md content. The auto-injected map uses a 1024-token budget.

Auto-injection is skipped in:
- Bare mode (`--bare`)
- Remote sessions (`CLAUDE_CODE_REMOTE`)

## The /repomap slash command

The `/repomap` command is always available regardless of the feature flag. It lets you inspect and tune the map interactively.

```text
/repomap                          # Show the map with default settings (2048 tokens)
/repomap --tokens 4096            # Increase the token budget for a larger map
/repomap --focus src/tools/       # Boost specific paths in the ranking
/repomap --focus src/context.ts   # Can use multiple --focus flags
/repomap --focus-symbols buildTool # Boost files that define specific symbols
/repomap --stats                  # Show cache statistics
/repomap --invalidate             # Clear cache and rebuild from scratch
```

## The RepoMap tool

The model can also call the `RepoMap` tool on demand during a session. This is useful when:
- The model needs structural context mid-conversation
- The user asks about specific areas (the model can pass `focus_files` or `focus_symbols`)
- A larger token budget is needed than the auto-injected default

## Known limitations

- **Signatures only** — The map shows function/class/type declarations, not implementations. The model still needs `Read` to see function bodies.
- **Cold build time** — First build on large repos (2000+ files) can take 20-30 seconds due to WASM-based parsing. Subsequent builds use the disk cache and complete in under 100ms.
- **Language coverage** — Only TypeScript, JavaScript, Python, Go, Rust, C, and C++ are supported. Files in other languages are skipped.
- **TypeScript references** — The TypeScript query captures type annotations, constructor (`new`) expressions, and plain function calls, so the ranking follows call edges as well as type edges. Member calls (`object.method()`) are not captured: method names such as `.log()`, `.get()` or `.map()` collide across unrelated classes and would add mostly-noise edges. `require(...)` is excluded to match the JavaScript query, and common callee names stay heavily down-weighted by the graph's IDF penalty.
- **Git dependency** — File enumeration uses `git ls-files --cached --others --exclude-standard` by default, so untracked files that are not ignored can appear in the map. Non-git repos fall back to a directory walk with hardcoded exclusions.
