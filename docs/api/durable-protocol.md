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

The run loop commits rows at seven boundaries (`packages/harness/docs/spec.md`) and reads its next step from the reducer output:

| Write point                   | Committed row(s)                                                                             | Recovery behavior if the process crashes immediately after                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1 — Run admission**        | `run.start`, `run.config`, initial `approval.policy`, initial `user` message                 | Replays the initial configuration and starts step 1.                                                                                           |
| **W2 — Step & model attempt** | `tools.offered` (when tools/prompt/hooks changed) + `model.message` (`attempt`)              | Counts the interrupted attempt against the invocation's retry budget and either resends under the retry gate or opens a human `retry` request. |
| **W3 — Model response**       | `model.message` (`response`) with assistant content, tool calls, and token usage             | Reuses the committed assistant response (never re-invokes the model for that turn) and proceeds to tool dispatch.                              |
| **W4 — Tool intent**          | `tool.intent` (after pre-call hooks, workspace path guards, and human approvals succeed)     | Re-runs the tool if `replay: 'safe'`; records an `"outcome unknown"` tool result for the model if `replay: 'unsafe'`.                          |
| **W5 — Tool result**          | `tool.result` (plus any `plugin.fact` rows emitted by the call)                              | Reuses the committed `tool.result` without re-executing the tool and advances to the next pending call or next model turn.                     |
| **W6 — Human request / wait** | `request.opened`, `request.decided`, or `run.position` (`waiting`)                           | Re-presents any open `request.opened` (without a matching `request.decided`) to the attached `approve` handler.                                |
| **W7 — Terminal outcome**     | `run.end` (`completed`, `failed`, `cancelled`, `budget_exceeded`, `max_iterations_exceeded`) | Run is finished; `session.resume` fails with [`ResumeRefused`](./harness/#resumerefused).                                                      |

### Model retries and durable permits

- A failed model attempt commits a `failed` row recording the next step (`retry`, `unchain`, `ask`, `stop`, or `cancel`).
- Automatic resends run under the process's route-scoped `ModelRetryGate` within a budget counted from the invocation's committed attempt rows, so a crash never resets the retry counter.
- When automatic retries are exhausted, the `failed` row opens a `retry` request in the same transaction; a human's `request.decided` row authorizes the next attempt.

### Owned child runs and `context.edit`

- **Owned children**: when a parent run calls `agent` and awaits the child, the child's `runId` is derived deterministically from `(parentRunId, responseId, callId, attempt)` and `run.start.parent.callId` names the owning call. On recovery, the parent's open `agent` call reattaches to that child (reading its result if finished, or resuming it under the same `runId`). Calling `session.resume(childRunId)` on an owned child resumes the parent and sets [`run.redirectedFrom`](./harness/#run).
- **Context edits (`context.edit`) and forks (`run.fork`)**: compaction and forking both write `context.edit` rows that replace a message slice `[from, to)` against a recorded `base` edit. `run.fork` creates a new run whose `run.start.provenance` is `{ kind: 'fork', from, at }` seeded with a `context.edit` snapshot at `at`.

## Crash-conformance invariants (`I1`–`I9`)

`src/test-kernel/runtime/crashConformance.vitest.ts` runs a multi-step agent workflow against SQLite, truncates the store at every commit `1..N`, reopens the session, resumes the run, and asserts nine invariants:

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
| **S4** | [`DatabaseWriteFailed`](./harness/#databasewritefailed)                                                                     | Transaction rolls back completely and the active run terminates with a typed failure.                                                                                                  |
| **S5** | [`DatabaseNotOwner`](./harness/schemas#databasenotowner) / [`DatabaseClaimRefused`](./harness/schemas#databaseclaimrefused) | Write is rejected; a live run that lost its claim halts immediately, and `resume` or `request` against a foreign-held run fails with [`NotOwner`](./harness/#notowner).                |
