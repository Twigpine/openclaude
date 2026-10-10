# CI flake/slowness — Phase 1 finding (diagnosis, not yet a fix)

Status: red-capable repro built. Root cause identified for the truncated-suite symptom.
Not yet fixed. No production code changed.

## The headline

CI is not merely flaky — **the signal is broken**. `bun test` exits **0** while running
only a fraction of the suite. Green CI does not mean the suite passed.

## Evidence (all commands run locally, bun 1.4.2, node v22.23.2)

### 1. The full suite dies mid-run and reports success

    bun test --feature=UNATTENDED_RETRY --max-concurrency=1
    # exit=0  wall=99s  no "Ran N tests across" summary line
    # stops during src/cli/bgFinalizer.test.ts

With `--dots`: 690 tests, then the process ends. No summary.

With `--reporter=junit --reporter-outfile=...`: the report file is **never written**,
which rules out mere stdout truncation — the process dies before it can report.

    723 total test files under src/
    -> only ~28 files execute

### 2. `src/cli` alone reproduces the death; `src/utils` alone is healthy

    bun test ... src/cli     # exit=0, no summary, dies in bgFinalizer.test.ts
    bun test ... src/utils   # exit=1, "Ran 3700 tests across 271 files" [467.07s], 38 fail

So the truncation is not a runner-wide condition; it is bound to a specific file.

### 3. The suspect hangs on its own, deterministically

    timeout 75 bun test --feature=UNATTENDED_RETRY --max-concurrency=1 src/cli/bgFinalizer.test.ts

    run 1: exit=124 (timeout) wall=75s no summary
    run 2: exit=124 (timeout) wall=76s no summary
    run 3: exit=124 (timeout) wall=75s no summary

3/3 hang. Meanwhile the same file, running after its siblings in `src/cli`, kills the
process outright instead of hanging. Two distinct failure modes from one file.

## Why this explains "flaky AND slow"

- When bgFinalizer kills the runner: job goes green in ~100s while skipping ~96% of
  the suite. Silent false pass.
- When bgFinalizer hangs: the job burns to the GitHub Actions 6-hour job timeout.
  That is the "slow".

Same root cause, different symptom, depending on ordering/timing. That also explains
why it reads as *flaky* rather than as a stable failure.

`src/cli/bgFinalizer.test.ts` mutates the runner's own `process.exitCode`
(lines 229-236, 484-519, 564-591) and sends real signals to real PIDs
(lines 663-667, 1240-1315, 1467-1507, 1635-1655), including SIGSTOP/SIGCONT on a
child with no guaranteed resume path.

## Caveat that must be resolved before fixing

Local bun is **1.4.2**; CI pins **1.3.13** (`.bun-version`). The repro must be
re-confirmed on 1.3.13 before any fix is trusted.

## Independent slowness findings (not yet measured end-to-end)

1. **No dependency caching.** No `actions/cache` anywhere; 5 jobs each run
   `bun install --frozen-lockfile` cold over a ~100 devDependency tree
   (sharp, tree-sitter-wasms, AWS/Azure/Bedrock/Foundry SDKs).
2. **Whole-suite duplication.** `smoke-and-tests` runs `bun run check`
   (-> `test:full` -> full 723-file suite) and then additionally runs
   `test:provider` (73 files) and `test:provider-recommendation` (2 files).
   All 75 are subsets of the full suite that already ran.
3. **Matrix runs everything twice.** `smoke-and-tests` has
   `node-version: ["22", "24.11.x"]`, so the entire suite runs twice per PR.
4. **Serial tests.** `--max-concurrency=1` on every test invocation.
5. `fetch-depth: 0` (full-history clone) on both matrix legs.

## Next measurement

Sample the 38 `src/utils` failures to separate genuinely flaky tests from
environment-dependent ones.