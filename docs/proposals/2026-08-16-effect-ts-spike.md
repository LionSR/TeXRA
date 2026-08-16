# Effect-TS for TeXRA's error handling — bounded spike result

**Status:** Spike complete, **recommendation: do not adopt.** The branch
`claude/error-handling-effect-ts-mz7lqx` carries a working, behaviour-parity
Effect port of the retry owner purely as evidence. **It must not be merged.**
**Question asked:** "Maybe effect-ts can massively help us to remove many code."
**Answer, measured:** on the single best-case target in the repo, Effect
produced **7 more lines**, not fewer.

## Method

Ported `Node._exec` (`src/agent/node/index.ts`) — the flow engine's retry
owner — from `p-retry` to `effect@3.22.1` (`Effect.retry` + `Schedule` +
fiber interruption). This is the fairest possible test: retry with backoff,
conditional retry predicates, and cancellation are precisely what Effect's
`Schedule` and interruption model are built for. If Effect cannot win here,
it cannot win anywhere in this codebase.

Parity was measured against the 14 pre-existing tests in
`src/test-kernel/agent/PocketFlowNode.vitest.ts` and the 57 in
`src/test-kernel/agent/runtime/RetryState.vitest.ts`, which pin the retry
semantics including four separate abort-interleaving races.

## Result

| Measure                     | p-retry (before)            | Effect (after)                    |
| --------------------------- | --------------------------- | --------------------------------- |
| `Node._exec` body           | **77 lines**                | **84 lines**                      |
| Whole file                  | —                           | +9 (70 ins / 61 del)              |
| Bundle, tree-shaken minimum | 4.2 KB min / **1.67 KB gz** | 221.8 KB min / **73.06 KB gz**    |
| Agent suite                 | 3114 passing                | 3113 passing, 1 deliberate change |
| `p-retry` still required?   | —                           | **Yes**                           |

**+71 KB gzipped, ×44, to write seven more lines.** (Line counts are
post-`prettier`, the repo's enforced format.)

### The 66-line version was a mirage

The first Effect draft came in at 66 lines — a genuine-looking 14% cut. It
failed **3 of 14** parity tests. Closing them cost +18 lines:

1. **Abort must beat a late-resolving attempt.** `p-retry`'s `signal:` option
   gave this free. Effect needed `Effect.runPromise(program, { signal })`.
2. **…but fiber interruption cancels `tryPromise`'s `catch`,** losing the
   record of _which_ error the fallback must forward — so the attempt needs
   `Effect.uninterruptible` plus an explicit post-attempt abort check, which
   is the original algorithm rewritten in Effect vocabulary.
3. **Abort during the inter-retry delay** (`RetryState.vitest.ts`, "keeps
   interruption active throughout the automatic retry delay") — another
   `p-retry` freebie, and a silent regression in the naive port. Recovering it
   required combining (1) and (2): signal-driven interruption for the delay,
   deferred around uninterruptible attempts.

### Effect's error channel could not carry the domain state

The ported version still needs three pieces of mutable closure state —
`lastExecError`, `attemptThrew`, `manualPhase`. This is the load-bearing
finding. The complexity in this code was never the retry _mechanics_ (Effect
does express those elegantly, in ~8 lines). It is the **abort/error-forwarding
policy**: which of several candidate errors the user should be shown when a
cancellation races an in-flight attempt. That is domain logic. It survives the
framework unchanged.

### `p-retry` cannot be removed anyway

`AbortError` is load-bearing in `src/tools/timeouts.ts`, `WebFetchTool.ts`,
`WebSearchTool.ts`, `LoogleTool.ts`, and `src/latex/arxivProcessor.ts`. Since
a tool can throw that wrapper up into a node's `exec`, the Effect port had to
**import `p-retry` back into `node/index.ts`** to unwrap it. Adopting Effect
here means running both engines, which is the two-error-models cost made
concrete.

### One deliberate behaviour change

`normalizes a non-Error thrown by an approved attempt` still fails: p-retry
emits `TypeError: Non-error was thrown: "raw failure". You should only throw
errors.`; the Effect port emits `Error: raw failure`. Better for users, worse
for whoever is debugging the bad throw. Left failing rather than silently
rewriting the test.

## Why this generalises

The retry owner was Effect's best case. The rest of the error surface is worse
for it:

- **74% of `src/common/errors/` (1,484 of 2,005 lines) is provider forensics** —
  parsing vendor error bodies to distinguish a relay monthly cap from upstream
  credit depletion from a Kimi Code quota rejection. Effect deletes none of it.
- **Only 16 of 913 `catch` sites are pure rethrow ceremony.** The rest log,
  classify, or convert to tool results. The seven-plane
  [catch budget](./2026-06-10-error-pipeline-and-ownership.md) already governs
  them at ~87% compliance.
- **`neverthrow` has been a dependency for months and is used in 2 files.** A
  Result type was already available here and did not spread.
- **Zod v4 is the declared schema SSOT.** Effect brings `Schema`; coexistence
  or rewrite, both expensive.

## What to do instead

Mapped to the four stated pains:

| Pain                   | Real lever                                                                                                                                              | Cost               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Errors get swallowed   | Execute [`2026-08-16-overdefensive-top10.md`](./2026-08-16-overdefensive-top10.md) — already adjudicated at file:line                                   | **−660..−710 LoC** |
| No compile-time safety | Widen `AgentErrorKind` behind the existing verified-producer rule; the `Symbol.for` marker pattern already gives typed classification without a runtime | Small, incremental |
| Too much boilerplate   | Largely not there to remove — see the 16/913 measurement                                                                                                | —                  |
| Bad user-facing errors | Presentation-layer work at `terminalResultToast.ts` and the host surfaces; unrelated to control flow                                                    | Scoped separately  |

The `effect` dependency added for this spike should be dropped with the branch.
