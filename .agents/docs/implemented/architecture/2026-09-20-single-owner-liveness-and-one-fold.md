---
created: 2026-09-20
status: implemented
---

# Single-owner liveness and one fold

## 1. Rule

One durable authority, one interpreter per shared fact, derived caches, and
one in-process record per run. A race guard exists only for inherent
concurrency, never because two in-process authorities answer the same
question. Every in-memory copy that shadowed the rows without being derived
from them (a run snapshot restating row facts, a second fold, parallel
liveness maps, a per-instance app-state map) produced a class of bugs
(stale snapshots failing a run as inconsistent, a row type folded into one
reader and not the other, a process believing it owned a run the database
had reassigned, another process's writes invisible), and each was removed
rather than synchronized.

## 2. How it holds today

- **The event table is the only durable authority for run facts.** Every
  append is stamped with the owner in the same SQL statement
  (`event_sequence.owner_id`, `packages/harness/src/controllers/session/Database.ts`),
  so a lost claim writes nothing.
- **No snapshot restates rows.** A run resumes from `foldRunState` over its
  rows (`packages/harness/src/shared/session/runState.ts`); the facts a
  snapshot once carried each have their own row.
- **One reducer for the rows both folds read.** `runState` (what the
  loop continues from) and `sessionFold` (what people see) apply
  `run.position`, `request.opened`, `request.decided`, `followup.queued`
  and `followup.consumed` through one module,
  `shared/session/runRows.ts` (`applyRunRow`); a type listed there and not
  handled is a compile error. A new shared row type has one place to land.
- **One in-process record per run.** `RunRegistry`
  (`packages/harness/src/agent/runtime/runRegistry.ts`) keeps one `RunEntry`
  per run: the fiber running it, a hold, the tracked handle, a native child
  loop's activation and its serial lane. The entry exists exactly while one
  of those does, so it is the single in-process answer to "is a generation
  of this run live here" (`LiveRun.live`). Admission, stop, deletion and
  follow-up routing all read that one record; a stop's reason is recorded on
  the entry before the interrupt.
- **App state reads SQLite on every operation**
  (`controllers/session/appStateStore.ts`), so another process's writes are
  visible without a cached map. See the
  [current-value note](./2026-09-22-current-value-state-decision.md).

## 3. What stays, and why

These guard inherent concurrency, not a duplicated authority:

- the `SessionEvents` publisher: many producers, one commit order;
- the claim and its liveness proof, SQLite's `busy_timeout`, and the
  `PRAGMA data_version` poll (two processes on one root);
- `ModelRetryGate` (the provider);
- webview reconnect generations (`SessionFramer`, `SessionBridge`);
- `jsonStore` file write lanes;
- per-key lanes (`withPerKeyLane`) where overlapping writes to one key must
  commit in invocation order.
