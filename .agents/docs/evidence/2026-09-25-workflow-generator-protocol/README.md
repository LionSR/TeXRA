# Workflow generator protocol: prototype and tests

This probe supports the
[workflow generator protocol proposal](../../proposed/architecture/2026-09-25-workflow-script-generator-protocol.md).
It is a standalone prototype, deliberately outside the product: nothing in
`src/` or `packages/` imports it, and none of the repository's lint,
typecheck, knip or test tiers scan this directory.

## What it is

About 500 lines in three files, with 18 behavioral tests:

| File                 | Role                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops.ts`             | The wire protocol: a Zod discriminated union of operations (`Agent`, `All`, `Attempt`, `Retry`, `Timeout`, and `Branch` for a generator-function step), and the reply one step returns.                                           |
| `realm.ts`           | The QuickJS side. The script body is wrapped as a generator; the realm keeps generator instances in its own table and exposes two trusted handles, `step` and `registerMain`, that guest code cannot reach. No promises, no pump. |
| `interpreter.ts`     | The host side. One Effect combinator per operation, and a branch loop that steps a generator, runs what it yields and feeds the value or the failure back.                                                                        |
| `protocol.vitest.ts` | The tests, against a fake agent runner that records peak concurrency, every call and every interruption.                                                                                                                          |

## Pins

Taken on `main` at `b4569d4c` (2026-09-25), Node.js v22.22.2, with the
repository's locked dependencies: `effect` 4.0.0-rc.117,
`quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` 0.32.0,
`zod` 4.4.3, `vitest` 5.0.1.

## Running it

From the repository root, after `corepack pnpm install`:

```bash
npx vitest run --config .agents/docs/evidence/2026-09-25-workflow-generator-protocol/vitest.config.mjs
npx tsc -p .agents/docs/evidence/2026-09-25-workflow-generator-protocol/tsconfig.json
```

Recorded result: 18 of 18 tests pass, identically across repeated runs, in
about 1.3 s; the typecheck is clean.

## What the tests establish

- Sequential `agent()` calls return plain data; building operations
  (`items.map((x) => agent(x))`) runs nothing.
- `all()` fans out under the smaller of its own `concurrency` and the host
  budget, and nested fan-out stays under the host budget. A budget of 1
  completes, because a branch holds no permit while it waits on its children.
- `all()` fails fast: the first failure interrupts siblings still running.
- `attempt()` turns a failure into a `Success`/`Failure` value; a failed
  operation otherwise throws inside the script as an `Error` whose `name` is
  its tag (`AgentFailed`, `TimedOut`), so `try/catch` sees it.
- `retry()` re-runs a call, or a whole multi-step branch from its start.
- A script's own uncaught error (a `RangeError`, a `TypeError`) is a script
  fault, not an operation failure: it ends the run even inside `attempt()`.
- `timeout()` interrupts the call and throws `TimedOut` into the script.
- Multi-step generator branches run concurrently, one fiber each.
- Interrupting the run interrupts every in-flight agent call.
- A synchronous `while (true) {}` between yields is preempted by the per-step
  CPU budget, and the script's own `try/catch` cannot stop the preemption.
- An `await`-format script fails with a hint to write `yield*`; yielding a
  non-operation fails with a named error.
- `process`, `require`, `Function`, constructor escapes, `Math.random` and
  `Date.now` are unreachable or refused.

## Checking the tests themselves

Each guarantee was broken on purpose and re-run:

| Deliberate breakage                              | Result                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempt()` catches nothing                      | 1 test fails                                                                                                                                                                                                                    |
| `all()` collects results instead of failing fast | 3 tests fail                                                                                                                                                                                                                    |
| The host budget `Semaphore` removed from `Agent` | Passed at first: with one `all()`, its own cap equalled the budget. The nested fan-out test was added because of this, and now fails without the semaphore. The two bounds are both needed, as §6.5 of the runtime design says. |

## What it does not cover

The durable journal and resume, call identity and the duplicate-key check,
`meta.tasks` and phases, progress cards, `files`/`args`, dependency
fingerprints, `maxAgentCalls`, skip/retry control, the wall-clock run
timeout, the real agent runner, and the production determinism prelude. Each
sits under the `Agent` case or around the interpreter unchanged; the
proposal's §6 lists where each moves.
