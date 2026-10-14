# CI flake/slowness — diagnosis

Status: **root cause found and causally proven on CI's exact bun version (1.3.13).**
No production code changed. Reproducer: `/tmp/opencode/loops/flake-loop.sh`.

## The headline

CI is not merely flaky — **the signal is broken**. `bun test` exits **0** while
running only a fraction of the suite. Green CI does not mean the suite passed.

## Phase 1: the loop

    /tmp/opencode/loops/flake-loop.sh src/cli/printMaxTurns.test.ts src/cli/bgFinalizer.test.ts

Asserts two things: the runner printed a `Ran N tests across` summary, and the
exit code is non-zero when tests fail. A silently-truncated run (exit 0, no
summary) is RED.

- **Fast**: ~2s (was 99s+ for the whole `src/cli` directory).
- **Deterministic**: 5/5 runs RED, identical verdict, exit=0 every time.
- **Version caveat resolved**: CI pins bun **1.3.13** (`.bun-version`); local was
  1.4.2. Re-confirmed on 1.3.13 (`/tmp/opencode/bin1313/bun`).

## Phase 2: minimised repro

Two files, and both are load-bearing:

| Scenario | Result |
|---|---|
| `bgFinalizer` alone | green, `Ran 44 tests across 1 file` (88s) |
| `printMaxTurns` alone | green, `Ran 2 tests` |
| 4 print files, **no** bgFinalizer | green, `Ran 13 tests across 4 files` |
| **`printMaxTurns` + `bgFinalizer`** | **RED** — exit 0, no summary |
| `update` + `bgFinalizer` | green |
| `headlessHeartbeat` + `bgFinalizer` | green |
| whole `src/cli` (11 files) | RED — `Ran ~289`, then dies |

The suite dies *at the top* of `bgFinalizer.test.ts` — zero of its tests run.

## Phase 3/4: hypothesis, then proof

Instrumenting `process.exit` (tag `[DEBUG-a4f2]`, since removed) captured the killer:

    [DEBUG-a4f2] process.exit(0) called from:
        at forceExit (src/utils/gracefulShutdown.ts:226:13)
        at gracefulShutdown (src/utils/gracefulShutdown.ts:561:3)
        at processTicksAndRejections (native:7:39)

Exit code **0**, not 137 — an explicit `process.exit(0)`, not an OOM or signal
death. That ruled out the earlier "signals/OOM" theory.

**Causal chain:**

1. `src/cli/print.ts:1234` — `runHeadless` registers
   `process.on('SIGINT', sigintHandler)` on the **shared test-runner process** and
   never unregisters it. `printMaxTurns.test.ts` calls `runHeadless`, leaking the
   listener into the runner.
2. `src/cli/print.ts:1232` — that handler calls `void gracefulShutdown(0)`.
3. `src/cli/bgFinalizer.test.ts:1326,1340` — a later test sends a **real**
   `SIGINT` to a real child PID.
4. The leaked handler is live on the runner; `gracefulShutdown(0)` runs and
   `forceExit(0)` tears down the entire runner mid-suite. Exit 0. No summary.

Falsification probe: a preload that suppresses only `SIGINT` listener
registration turns the same run green —

    Ran 45 tests across 2 files. [85.76s]

The 2 remaining failures in that run are a **separate, pre-existing** bug
(`passes only settings-source inputs to the detached cleanup worker` passes alone,
fails when run with a sibling — a second ordering dependency, not yet diagnosed).

Note this also explains the "slow" half: when the runner is killed rather than
exiting, the job burns toward the GitHub Actions 6-hour timeout. Same root cause,
two symptoms — which is exactly why it reads as *flaky* rather than as a stable
failure.

## Slowness findings (verified, not yet fixed)

1. **No dependency caching.** `actions/cache` appears **0 times** across all three
   workflows; 5 jobs each run `bun install --frozen-lockfile` cold over a ~100
   devDependency tree.
2. **Whole-suite duplication.** `smoke-and-tests` runs `bun run check`
   (-> `test:full` -> the full suite) and *then* additionally runs
   `test:provider` (**73 files**, confirmed) and `test:provider-recommendation`
   (2 files). All are subsets of the suite that already ran.
3. **Matrix runs everything twice.** `node-version: ["22", "24.11.x"]`, so the
   entire suite runs twice per PR.
4. **Serial tests.** `--max-concurrency=1` on every test invocation.
5. `fetch-depth: 0` (full-history clone) on both matrix legs.

## Next steps

- Fix the SIGINT leak at its source: `runHeadless` must not attach signal
  handlers to the host process when running under test (or must remove them on
  teardown). The durable fix belongs in `print.ts`, not in either test.
- Then diagnose the ordering-dependent `settings-source inputs` failure.
- Then attack the five slowness items; items 2 and 3 are the cheapest large wins.
