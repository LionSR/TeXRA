# PRD: Proven execution liveness (presence sockets), full retirement of heartbeat leases

**Date:** 2026-08-16
**Status:** Approved for implementation
**Owner:** Ray
**Replaces:** the wall-clock heartbeat/staleness layer of `src/agent/storage/executionLease.ts`

## 1. Problem

Live runs are being killed by their own gating system. Observed repeatedly as:
a run "suddenly disconnects", then every follow-up fails with
`No active session for follow-up on stream <id>. Status: failed`.

Root cause, confirmed in code and on an affected machine:

- Execution ownership is a lease file renewed by a 15 s heartbeat
  (`EXECUTION_LEASE_HEARTBEAT_MS`); any observer treats
  `Date.now() - heartbeatAt > 120_000` (`EXECUTION_LEASE_STALE_MS`) as proof
  the owner is dead and may reclaim (restart repair marks the stream FAILED,
  finalizes the execution, deletes the lease).
- **System sleep freezes every process's heartbeats while wall-clock time keeps
  advancing.** After any sleep longer than the stale horizon, every live owner
  looks dead at the moment of wake — precisely when reaper timers queued during
  sleep (`RestartRepairRetryScheduler`, scheduled at `heartbeatAt + 120s + 1`)
  all fire. Whoever wins the file lock decides whether a live run is destroyed.
- A second kill path needs no reaper: `handleHeartbeatFailure` declares
  ownership lost when one heartbeat errors while
  `Date.now() - lastConfirmedHeartbeatAt > 120s`. After any >2 min sleep that
  delta is always exceeded, so a single transient error at wake (e.g. lock
  contention from the wake stampede of all owned leases renewing at once) is an
  instant, retry-free self-kill.
- Two hosts sharing one workspace (two TUIs, or TUI + extension) each run
  restart repair over the other's RUNNING streams, so a reaper timer is always
  pending across any sleep. Confirmed on the affected machine: two `texra`
  processes per workspace, `pmset` sleep windows of 522–939 s, and one
  workspace with 115 concurrently heartbeated leases.

The failure is not a bug in the implementation of the heartbeat protocol. The
protocol's core inference — _"heartbeat older than the horizon ⇒ owner is
dead"_ — is false on a machine that suspends. No tuning of the horizon fixes
that; it only moves the race.

## 2. Principle

**Liveness is proven, never inferred.** No wall-clock (or monotonic-clock)
reading anywhere in any liveness decision. Every verdict is one of:

- **Alive — proven** by a kernel fact (an accepted connection to the owner's
  presence socket carrying the owner's instance banner).
- **Dead — proven** by a kernel fact (`ECONNREFUSED`/`ENOENT` on the recorded
  socket path: the kernel states no such listener exists; a crashed or
  SIGKILLed process cannot keep a socket listening, and suspend does not stop
  one from listening).
- **Unprovable** (probe timeout, permission error, banner mismatch beyond the
  known-stale-file case, foreign hostname): **fail safe — treat as alive,
  refuse reclamation, log loud.** We never destroy on ambiguity.

Heartbeat leases are the tested pattern for _distributed_ systems (Chubby,
ZooKeeper, Kubernetes Leases) because across machines nothing better exists —
and even there they are known to be unsafe against pauses without fencing.
TeXRA's coordination is same-machine by construction (mtime file locks on the
local data root), where the kernel offers an exact oracle. Prior art for the
oracle chosen here: tmux server sockets, ssh-agent, the Docker daemon socket,
and Electron's `app.requestSingleInstanceLock()` — which the TeXRA desktop
already relies on (`desktopProtocolCallbacks.ts`).

What the old system conflated, and what happens to each job:

| Job                        | Old mechanism                                  | New mechanism                             |
| -------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Mutual exclusion + fencing | file lock + `ownerToken` compare-on-write      | **unchanged** (this part was correct)     |
| Failure detection          | wall-clock heartbeat age                       | presence-socket probe (kernel fact)       |
| Reclamation trigger        | reaper retry timer at `heartbeatAt + 120s + 1` | owner-exit event (watch connection close) |

## 3. Design

### 3.1 Instance presence (`src/agent/storage/instancePresence.ts`, new)

- Each TeXRA process lazily binds **one** Unix domain socket (Windows: named
  pipe `\\.\pipe\texra-<instanceId>`) the first time it acquires any execution
  lease: `<globalStoragePath>/instances/<instanceId>.sock`, dir mode 0700,
  `instanceId` random (12+ hex chars). The `net.Server` is `unref()`ed; on
  graceful exit the socket is closed and unlinked; after a crash the stale
  file yields `ECONNREFUSED` (a death proof), and reboot removes it entirely.
- On every accepted connection the server writes a banner
  `texra-presence:<instanceId>\n` and **holds the connection open**.
- `probeInstance(owner)` → `'alive' | 'dead' | 'unprovable'`: connect with a
  short timeout, read the banner, verify the instance id, destroy.
  - banner matches → `alive`
  - `ECONNREFUSED` / `ENOENT`, or a _valid_ banner naming a different instance
    (path reused by a newer TeXRA process) → `dead`
  - timeout, other errors, non-TeXRA banner, or `owner.hostname` differing
    from `os.hostname()` (shared home directory across machines) →
    `unprovable` → treated as alive, logged at `warn`
- `watchInstanceExit(owner, listener)` → shared per-socket-path held
  connection; the kernel closes it when the owner process dies, firing the
  listeners. This replaces polling entirely: death is pushed, not sampled.
- If the socket path would exceed the platform `sun_path` limit (~104 bytes on
  macOS), fall back to a directory under `os.tmpdir()` with a `warn` log. In
  that fallback `ENOENT` remains a death verdict; the residual risk (tmp
  cleanup unlinking a live socket file) is bounded by the retained write
  fence, and the fallback should be rare enough to be an incident, not a mode.

### 3.2 Lease record v2

```jsonc
{
  "version": 2,
  "executionId": "…",
  "ownerToken": "<uuid>", // fencing token, unchanged role
  "acquiredAt": 1786868997829, // display/diagnostics only — never a liveness input
  "owner": {
    "instanceId": "…",
    "socketPath": "…",
    "pid": 12345, // diagnostics only — never a liveness input
    "hostname": "…", // cross-host guard → unprovable, never a death proof
  },
}
```

Written once at acquisition. **Never renewed.** Deleted at release. A process
that owned 115 executions previously rewrote 115 files every 15 s; it now
maintains one socket and zero renewals.

### 3.3 Consumer semantics

- `acquireFreshExecutionLease` / `acquireResumedExecutionLease`: under the
  existing file lock, read the record; probe; `alive`/`unprovable` →
  `ExecutionLeaseActiveError`; `dead`/missing → overwrite and own. The
  in-process resume fast path keeps its local-ownership check, minus the
  heartbeat dance.
- `runWithInactiveExecutionLease`: probe instead of freshness; `alive`/
  `unprovable` → `{status:'active'}` (now carrying owner diagnostics instead
  of `heartbeatAt`); proven dead → perform maintenance and delete the record.
- `inspectExecutionLease` presence taxonomy becomes
  `missing | owned | foreign | orphaned` (`orphaned` = record present, owner
  proven dead). Reported metadata: `acquiredAt` + owner diagnostics.
- `renewOwnedExecutionLease` → renamed `validateOwnedExecutionLease`: a pure
  fencing check (read under lock, compare `ownerToken`), no write. Its two
  call sites in `SessionHandle.releaseExecutionLease` keep their positions as
  durability-boundary validations.
- Restart repair: on `active` skip, register `watchInstanceExit`; on owner
  exit, re-run repair for those streams immediately. `nextLeaseCheckAt` and
  `RestartRepairRetryScheduler` are deleted. Repair actions on a proven-dead
  owner are unchanged in this PRD (the FAILED verdict is now accurate by
  construction).
- `onOwnedExecutionLeaseLost` remains, as the fencing backstop only: it fires
  when a write-boundary validation finds a foreign or missing record (manual
  file deletion, tmp-fallback edge, bugs). Nothing fires it on a schedule.

### 3.4 Deliberate consequence: no automatic takeover of live owners

Previously a hung-but-alive owner could be displaced after 120 s. Now a live
owner can never be displaced automatically — `ExecutionLeaseActiveError` is
returned for as long as the owner process exists. The user's recourse for a
wedged owner is to quit that process; the kernel then closes its sockets and
every verdict flips to proven-dead instantly. Cooperative handoff ("ask the
owner to yield") is a natural future use of the presence channel and an
explicit non-goal here.

## 4. Complete retirement — nothing survives

Per the decision to retire the previous system outright, with no compatibility
arms:

**Deleted:** `EXECUTION_LEASE_STALE_MS`, `EXECUTION_LEASE_HEARTBEAT_MS`, the
heartbeat interval timer, `renewHeartbeat`/`heartbeat`, `heartbeatInFlight`,
`lastConfirmedHeartbeatAt`, `handleHeartbeatFailure` and the ECOMPROMISED
self-kill, `isFresh`, the `heartbeatAt` field and every consumer of it
(`DeleteExecutionResult`, restart-repair results, presence results),
`RestartRepairRetryScheduler` and `nextLeaseCheckAt`, and the v1 record
schema.

**Version-1 lease records are tombstones.** No v1 semantics survive — no
freshness fallback, no classification logic, no transition reader. The only
recognition that remains is `{version: 1} ⇒ garbage from the retired
protocol`: any locked code path deletes such a file on contact and proceeds
as if it were absent, logged at `warn`, so upgrades self-heal without asking
users to clean lease directories by hand. The unlocked classifier
(`inspectExecutionLease`) reports a tombstone as `orphaned` and leaves the
delete to the next locked path — an unlocked delete could race a concurrent
acquisition that just replaced the file. Release note: restart every TeXRA
host after upgrading (a still-running pre-upgrade host's live lease is a
tombstone to the new code and will be reclaimed). (Consistent with the
standing ruling that intermediate-era data gets deleted early and loudly
rather than age-gated.)

**Kept:** `withLeaseLock` (proper-lockfile mutual exclusion for record
read-modify-write), `ownerToken` fencing and `runWithExecutionLeaseWriteFence`,
the `AsyncLocalStorage` ownership-generation scoping
(`captureOwnedExecutionLease`), durability retention
(`markOwnedExecutionLeaseUndurable` / abandon / complete), and the
acquisition/maintenance quiescence coordination.

## 5. Non-goals

- Cooperative handoff / force-takeover of live owners (future presence-channel
  work).
- The broker/daemon architecture (runs living in a per-workspace daemon,
  UIs as attaching clients). It remains the endpoint that eliminates the
  multi-UI category entirely; this PRD's presence socket is a stepping stone,
  not a substitute decision.
- Non-destructive restart repair (reap to _resumable_ instead of FAILED +
  flow-record delete). Worth doing; separate change.
- The lease-release leak observed in the wild (115 still-owned records for
  executions acquired over three days). Orthogonal bug in the release path;
  under the new system it is inert load but still wrongly blocks resume of
  those executions while the owner lives. Needs its own investigation.

## 6. Testing

Rewrite `src/test-kernel/agent/storage/ExecutionLease.vitest.ts` and
`executionLeaseFixtures.ts` against the new oracle (real sockets on a temp
root: alive/refused/missing/banner-mismatch/foreign-hostname verdicts,
watch-fires-on-close, fencing unchanged). Restart-repair suites lose their
staleness-clock cases and gain one owner-exit-event case. No new test files;
existing suites are adapted. The sleep race itself needs no simulation — the
design contains no clock to race.
