# Durable Protocol & Recovery

A run's state in [`@texra-ai/harness`](./harness/) is the reduction of the append-only rows committed to its session database (`texra.db`). If a process exits or crashes mid-run, the next process that opens the storage root inspects the committed rows and resumes the run from its last write point.

## Approvals, commands, and resume in code

### Attaching an approval handler and resuming interrupted runs

Attach a [`SessionHost`](./harness/#sessionhost) with [`session.attach({ approve })`](./harness/#session) to answer pending requests (`bash`, `toolEdit`, `planApproval`, `retry`, `userQuestion`), and call [`session.resume(runId)`](./harness/#session) to continue an interrupted run (see [`04-approvals-and-requests.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/04-approvals-and-requests.ts) and [`05-durable-resume-and-fork.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/05-durable-resume-and-fork.ts)):

```ts
import { Effect } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { isLiveRun, type PendingRequest } from '@texra-ai/harness/schemas';

const resumeInterruptedRuns = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots, { persistent: true });

  yield* session.attach({
    approve: (request: PendingRequest) =>
      Effect.sync(() => {
        if (request.payload.kind === 'retry') {
          return { action: 'retry' as const };
        }
        if (request.payload.kind === 'bash') {
          return { action: 'approve' as const };
        }
        return {
          action: 'reject' as const,
          feedback: 'Requires manual review.',
        };
      }),
  });

  const view = session.view.current();
  for (const runView of view.runs.values()) {
    if (runView.durableOutcome === null && !isLiveRun(runView)) {
      const resumed = yield* session.resume(runView.id);
      const end = yield* resumed.result;
      console.log(`Resumed ${resumed.runId} -> ${end.outcome}`);
    }
  }
});
```

### Sending runtime commands (`session.request`)

Host commands go through [`session.request(runtimeRequest)`](./harness/#session) (validated by [`RuntimeRequestSchema`](./harness/schemas#runtimerequestschema)) so each decision commits to SQLite before taking effect:

```ts
// Send a follow-up message to a waiting or stopped interactive run:
yield *
  session.request({
    kind: 'followUp.send',
    runId: run.runId,
    text: 'Check Lemma 2 and update the appendix.',
  });

// Answer a pending request by id:
yield *
  session.request({
    kind: 'request.decide',
    runId: run.runId,
    requestId: pendingRequest.requestId,
    decision: { action: 'approve' },
  });

// Fork a conversation at a settled step `at` (or the latest settled step):
const forked =
  yield *
  session.request({
    kind: 'run.fork',
    runId: run.runId,
  });

// Stop a running or waiting turn:
yield *
  session.request({
    kind: 'run.stop',
    runId: run.runId,
    reason: 'user',
  });
```

## Storage model and ownership claims

When opened with `{ persistent: true }`, a [`Session`](./harness/#session) opens `texra.db` under `roots.storage`; without `persistent: true`, it runs the same SQLite schema in memory.

Every durable event is a row in the `event` table with two sequence numbers:

- **`commit`**: monotonic integer ordering rows across the store.
- **`seq`**: dense `1..N` integer ordering rows within one aggregate—either a run (`run:<runId>`) or a plugin state stream (`plugin:<id>:<key>`).

Repeated immutable values (the system prompt, offered tool schemas, and the resolved agent config) are stored once by SHA-256 digest as `context.blob` rows.

Each aggregate has an ownership row holding the active writer's [`ProcessIdentity`](./harness/node#processidentity) (`[hostname, pid, processStart]`):

- Every write transaction checks the caller's claim before inserting. If another process has claimed the aggregate, the write fails with [`DatabaseNotOwner`](./harness/schemas#databasenotowner) and the run halts immediately.
- When a process dies abruptly, its OS identity no longer matches a live process. The next session that opens the store sees that the owner is gone, marks the unfinished run as interrupted in [`SessionView`](./harness/schemas#sessionview), and lets `session.resume(runId)` claim and continue it.
- `sessions.close(roots)` stops active runs within `SESSION_CLOSE_DEADLINE_MS` and commits their terminal `cancelled` rows before closing the database.

## Write points (`W1`–`W7`)

The run loop commits a row before each step that depends on it. These are the
seven write points of the [spec](https://github.com/LionSR/TeXRA/blob/main/packages/harness/docs/spec.md)
(section 4), with what a resume does if the process stops right after each
one (section 9):

| Write point                         | Committed row(s)                                                   | What a resume does                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1 — Model attempt**              | `model.message` (`attempt`), before the request leaves the process | The attempt has no outcome, so it is sent again, or, if a person approved a retry of that call, the person is asked again. An operation the provider accepted is observed, not resubmitted.                                                                                                     |
| **W2 — Model response**             | `model.message` (`response`) with `run.position` `response.ready`  | Reuses the committed response; the model is not called again for it.                                                                                                                                                                                                                            |
| **W3 — Tool intent**                | `tool.intent`, after pre-call hooks and the guard, before the body | If the call's approval request still stands, or was decided since the run resumed, the call rejoins it. Otherwise it is re-run only if the tool declares `replay: 'safe'`, its stored arguments still validate, and it has not already started three times; else it settles as outcome unknown. |
| **W4 — Tool result**                | `tool.result` with the call's card rows                            | Reuses the result; the tool is not run again.                                                                                                                                                                                                                                                   |
| **W5 — Position**                   | `run.position` at every wait and every halt                        | Continues from the recorded position. A `halted` position commits with `run.end`: a recipe task stays finished (`resume` answers `finished`), and a conversation continues in a new lifecycle.                                                                                                  |
| **W6 — Failed attempt**             | `model.message` (`failed`), naming the next action                 | Follows the recorded action: send the next attempt (`retry`, `unchain`), wait for a person (`ask`), or end the call (`stop`, `cancel`).                                                                                                                                                         |
| **W7 — Request opened and decided** | `request.opened`, then one `request.decided`                       | An open request stays pending under the same id and is presented again to the attached `approve` handler.                                                                                                                                                                                       |

### Model retries and durable permits

- A failed model attempt commits a `failed` row recording the next step (`retry`, `unchain`, `ask`, `stop`, or `cancel`).
- Automatic resends run under the process's route-scoped `ModelRetryGate` within a budget counted from the invocation's committed attempt rows, so a crash never resets the retry counter.
- When automatic retries are exhausted, the `failed` row opens a `retry` request in the same transaction; a human's `request.decided` row authorizes the next attempt.

### Owned child runs and `context.edit`

- **Owned children**: when a parent run calls `agent` and awaits the child, the child's `runId` is derived deterministically from `(parentRunId, responseId, callId, attempt)` and `run.start.parent.callId` names the owning call. On recovery, the parent's open `agent` call reattaches to that child (reading its result if finished, or resuming it under the same `runId`). Calling `session.resume(childRunId)` on an owned child resumes the parent and sets [`run.redirectedFrom`](./harness/#run).
- **Context edits (`context.edit`) and forks (`run.fork`)**: compaction and forking both write `context.edit` rows that replace a message slice `[from, to)` against a recorded `base` edit. `run.fork` creates a new run whose `run.start.provenance` is `{ kind: 'fork', from, at }` seeded with a `context.edit` snapshot at `at`.

## Crash-conformance invariants (`I1`–`I9`)

`src/test-kernel/support/crashConformance.ts` runs a multi-step agent workflow against SQLite, truncates the store at every commit `1..N`, reopens the session, resumes the run, and asserts nine invariants:

| ID     | Invariant                                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | **Outcome equivalence**: recovery from any commit point reaches the clean run's outcome, preserving committed answers, tool results, owned children, and context edits.      |
| **I2** | **Single tool result**: a tool call with a committed `tool.result` is never executed a second time.                                                                          |
| **I3** | **At most one response per model invocation**: recovery never appends a second `response` row to an invocation that already committed one.                                   |
| **I4** | **Approval and uncertain side effects**: an approval-gated call never runs before its approval commits, and an interrupted `replay: 'unsafe'` call never re-runs unprompted. |
| **I5** | **Owned child reattachment**: an owned child that finished answers its parent call on recovery; owned children always finish before their parent.                            |
| **I6** | **Exactly-once child delivery**: results from detached children, scripts, and background commands are queued and consumed once.                                              |
| **I7** | **Context edit and fork preservation**: committed compactions and forks recover with the exact message history they committed.                                               |
| **I8** | **Atomic stop**: a stopped run's halt and `run.end` commit together, so recovery never mistakes an acknowledged stop for an interrupted run.                                 |
| **I9** | **Durable policy revocation**: revoking an approval bypass is acknowledged only after the `approval.policy` row commits to SQLite.                                           |

## Storage failure outcomes (`S1`–`S5`)

| ID     | Failure class                                                                                                               | Behavior                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** | [`DatabaseOpenFailed`](./harness/#databaseopenfailed)                                                                       | Session open fails with the underlying cause; a pre-1.0 or corrupt SQLite file is moved aside (`texra.db.pre1`, [`SessionStoreMovedAside`](./harness/schemas#sessionstoremovedaside)). |
| **S2** | `DatabaseStoreNewer`                                                                                                        | Store written by a newer schema version is rejected whole without partial reads or writes.                                                                                             |
| **S3** | [`DatabaseReadFailed`](./harness/#databasereadfailed) (`DatabaseRowCorrupt`, `DatabaseRowEarlier`)                          | A run with an undecodable or pre-1.0 row is marked unreadable in listings and refused on resume without blocking other runs in the store.                                              |
| **S4** | [`DatabaseWriteFailed`](./harness/host#databasewritefailed)                                                                 | Transaction rolls back completely and the active run terminates with a typed failure.                                                                                                  |
| **S5** | [`DatabaseNotOwner`](./harness/schemas#databasenotowner) / [`DatabaseClaimRefused`](./harness/schemas#databaseclaimrefused) | Write is rejected; a live run that lost its claim halts immediately, and `resume` or `request` against a foreign-held run fails with [`NotOwner`](./harness/#notowner).                |
