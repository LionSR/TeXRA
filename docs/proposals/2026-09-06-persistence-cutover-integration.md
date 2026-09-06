# Persistence cutover integration audit (2026-09-06)

This is a reviewable integration checkpoint for #11972, not the completed
persistence cutover or a release candidate. Production still opens file-backed
transcripts and composes `SessionEventLog.memoryLayer`; the SQLite foundation
has no production consumer. Passing substrate tests cannot establish cutover.

## Inputs and preservation

- Main: `fb1ac8a52d1af719d02b41b2f1070799e4a0eba2` (initial validation base
  `542aea6e8425ec574ffa0fa9fd4fd05a878feb03`; the two later commits are documentation).
- Previous cutover: `b094461710bb0ce6c3186511a93564af4fafcb7d`.
- Persistent-open #11971: `f8919a26a879d7928e393e7e21fd0850c52133a3`.
  Includes the previously inspected `514271cd1b` main merge and the stage
  owner's subsequent complete CLI policy cleanup.
  Its merge already contains main and the previous cutover, preserving the
  qualified aggregate subscriptions, SDK Effect surface, shared trace fold,
  and removed transcript spill paths. The existing main merge was reused by fast-forward, without replaying
  or rewriting those commits.
- SQLite foundation #11948: `7b51a258b40de8ef2144e3a25164cc86b789da9c`,
  merged with its original ancestry. The original stage branches are unchanged.

The user's main worktree and its untracked proposals are untouched. Integration
and validation run in a separate worktree.

## Incorporated scope and review

Existing cutover work isolates aggregate lifecycles by kind, shares the trace
fold between recording and exported trace reconstruction, removes truncation
and spill writes, and propagates recorder teardown failures.

The SQLite foundation adds the two STRICT tables, foreign-key cascades and
indexes; scoped connection acquisition; verified WAL and foreign keys;
busy timeout before configuration; batch sequence and commit allocation under
one semaphore and transaction; rollback and post-commit wake level. The CLI
Node floor is raised to 22.13.0. This is a substrate writer, not the C6 production
publisher: it does not yet validate/redact published batches or check claims.

Persistent-open changes remove automatic ephemeral fallback from extension,
desktop and CLI. Open failures reach the existing host error boundaries.
Explicit SDK ephemeral stores remain supported. Integration removes the now
unreachable CLI ephemeral-policy/warning branch while retaining delayed TUI
cleanup and immediate headless/resume cleanup.

Review repairs in this integration:

- The existing C2 schema and qualified constructors resolve the foundation's
  raw aggregate-key review finding; merged SQL fixtures now use those keys.
- Strip all six envelope fields from SQLite payloads, including when a stamped
  event is structurally passed as a draft. Extend the existing read-back test.
- Include the SDK in the database-writer scan and recognize static, dynamic,
  and CommonJS forms of both SQLite specifiers.
- Enable foreign keys explicitly on the test reader. Name tests accurately:
  another connection is not another process, and EXPLAIN index checks are not
  an implemented C7 reader.
- Use the contract's `texra.db` filename before any production adoption.
- Remove the stage's new dead-code exemption for `Database.ts`. No baseline
  widening conceals its lack of a production consumer. The resulting dead-code
  failure is a remaining integration gate, to be resolved by the real C7 reader
  and production composition, not by a dummy caller.

## Requirement ledger

The contract is
[substrate decision §6.1–§8](2026-09-03-persistence-substrate-decision.md).
The newer owner rulings in
[Effect migration PRD, Phase 2](../prds/2026-08-26-effect-4-runtime-migration.md#phase-2--the-agent-runtime-on-the-ledger-lane-d-of-the-cutover)
override its old checkpoint-import requirement. The following is the remaining
work at this integration, distinguished from foundations already present.

| Requirement                                                | Present                                                                                                             | Still unimplemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 / stages 0–1: local schema and single durable authority | Tables, indexes, WAL/foreign-key verification, busy timeout, scoped writer, Node floor                              | Network/shared-filesystem rejection before open; production DB composition; replacement of app-state files; a guard covering all non-allowlisted durable writes and private ledger reads. The current guard covers SQLite imports and C1 SQL writes only. Host-floor, contention and crash evidence from stage 0 has not been rerun here.                                                                                                                                                           |
| C2: aggregate placement and lifecycle                      | Branded canonical kind-qualified IDs, event-kind validation, qualified subscriptions, canonical process-owner tuple | Native execution/workflow-checkpoint ledger facts; first-event atomic claim and run.start seq-1 enforcement; owning parent rows; parentStartCommit incarnation checks; durable checkpoint anchor shared by launches. Database NEXT_SEQ currently permits any typed draft as an aggregate's first row and leaves ownership/parent null.                                                                                                                                                              |
| C3 / stage 3: durable events and redaction                 | Shared trace fold/redaction, removed spill/truncation writes                                                        | Replace transcript.entry/file persistence with the durable trace vocabulary; schema validation and redaction at the production publish boundary; private byte-exact execution rows with scrubbed display/export access only; hydrate from the same stored events.                                                                                                                                                                                                                                   |
| C4: text durability                                        | Live append-only text chunks; no new partial-text checkpoint mechanism                                              | Completed-message SQLite commit as sole durable text writer and end-to-end kill-9 recovery proof. File-backed whole-array saving remains.                                                                                                                                                                                                                                                                                                                                                           |
| C5 / stage 6: ownership                                    | Canonical hostname/pid/start identity stamped on events                                                             | Atomic stream/execution/checkpoint claim, takeover, own-claim release, liveness recheck inside transaction, local admission guard, per-append owner and closed checks; wake on claim-only changes; replacement of file leases.                                                                                                                                                                                                                                                                      |
| C6: publication                                            | Database batch atomicity, ordered ordinals, returned batch, local commit wake                                       | Wire SessionEvents to Database; validate/redact before insert; verify every target claim; await durability; fold returned batches before exposing state; coupled tool.result/tool.end and model follow-up/flow.step batches. No durable payload delivery through subscribers.                                                                                                                                                                                                                       |
| C7: reads and reconciliation                               | Memory listing/all/aggregate and transient input framing                                                            | All five indexed SQL queries, inclusive bounded reads in one transaction with aggregate state and AUTOINCREMENT high-water mark; one data_version poll; wake generation independent of commit ordinal; per-subscription checked scope; explicit released claims/removals in Drained and ReplayComplete; transport buffering and reconciliation across frame splits and reconnects.                                                                                                                  |
| C8 / stage 2: two-tier SQL residency                       | Existing memory listing/subscribed transcript tiers                                                                 | SQL latest-of-type listing plus outstanding approvals in commit order; launcher/resume/rail/executions query conversion; delete summary cache, mtime heuristic, directory scans and background hydration.                                                                                                                                                                                                                                                                                           |
| Stage 4: stream-state hydrate                              | Current live snapshot event updates                                                                                 | Rebuild usage, plan, outputs, missing outputs and compile failures from SQL; delete six sidecars, SidecarWriteCoordinator, StagedDeletionCoordinator, staged directories, snapshot readers and DiskState.                                                                                                                                                                                                                                                                                           |
| D4 / stage 5 and C10: runtime ledger                       | Main's SDK Effect surface; runtime decision documented                                                              | Six ledger schemas, RunLedger, foldRunState, byte-exact messages and compaction, tool intents/results with state deltas, byte-amortized snapshots without copied messages, both Effect flow loops, workflow journal conversion, bounded resume, display flow coordinate. Delete node engine, persistedFlow writes, checkpoint parses and conversation reconstruction; remove persisted derived summaries.                                                                                           |
| C9 / stage 6: deletion and retention                       | Existing file-store deletion policy; in-memory stream.removed                                                       | Transactional tombstone and recursive closure; dependent/inquiry reparent checks; independent child/checkpoint lifecycles; parent incarnation routing; reference-safe checkpoint collection; claim-held retryable artifact cleanup before final cascade; saved-history preservation and remote existence reconciliation.                                                                                                                                                                            |
| §8: retained histories and metadata                        | Existing file readers remain                                                                                        | Registered conversion and canonical access for every ExecutionKVStore namespace (config, report, result, workspace files, turn tokens, child edges, external session IDs, workflow checkpoints, delegation attempts/sequences); history/sidecar/spill import with quiescence, deterministic manifest, idempotent verification, file-level backup and artifact-path preservation, stale-writer exclusion, and eventual retirement of applicable import-only readers. See checkpoint exception below. |
| Acceptance and release                                     | Integration checks recorded in PR #11972                                                                            | Copied TNLean-bucket inventory and repeat-open checks; preserved typed reads and artifacts; <2 s chat readiness with 4,148 executions; streaming crash recovery; competing workflow checkpoint claims; transactional deletion/crash retry and remote convergence; all ratchets green; release upgrade notes. None is inferred from unit tests.                                                                                                                                                      |

### Latest main's joint runtime/LLM gate

Main `fb1ac8a52d` also includes the accepted joint contract in
[runtime proposal §0.1](2026-09-04-agent-runtime-on-effect.md#01-current-implementation-contract-runtime-and-llm-package).
This is part of the remaining D4 work, not a second ledger migration:
`packages/llm` owns provider protocols and immutable prepared invocations;
canonical Zod turn/continuation values are persisted directly, with exact
opaque provider data. Prepared intent precedes submission; an accepted remote
operation (binding, retrieval data and original deadline) commits before
observation. Completed turns commit before tool dispatch. Continuations bind
to the exact history prefix and encoding; compaction/model switching validates
or replaces that binding. Per-call state operations, immutable attachments and
terminal display facts settle atomically; early meaningful state commits before
waiting. Both reflection and tool-use paths must preserve stage order, limits,
accounting and waiting semantics. Invocation-scoped resource selection and
observed durable settlement must fence late I/O before releasing claims.

None of those new ledger/LLM boundaries is implemented here. Existing handler
SDK unions are not the permanent new row API. Validate the contract's changed
settings after remote acceptance, compaction/model-switch continuation,
concurrent tool-state/attachment, cancellation and post-crash tool-dispatch
scenarios when implementing that lane.

### Checkpoint import is retired; history preservation is not

The September 6 third ruling explicitly deletes the `flow_<id>.json` importer
and its cursor/action mapping and three-month retirement machinery. These are
**not missing implementations to build**. Its replacement requirements remain:
report old-checkpoint-only runs as not resumable with the release named, leave
the record for explicit deletion, rename it to `.json.superseded` before the
first ledger append, and never read its old format. These paths are not yet
implemented. The ruling preserves separate conversation history, transcripts
and results; it does not authorize discarding every other file-backed history.

The substrate proposal still labels D4 unratified and requires checkpoint import;
the newer PRD authorizes the runtime replacement and explicitly strikes that
import. Reconcile those stale passages before cutover release. Stage 7's old
blanket importer-retirement description must distinguish retired checkpoint
machinery from any retained history-conversion window.

## Source anchors for the remaining work

- `src/controllers/session/sessionLayer.ts`: production `SessionEventLog.memoryLayer`.
- `src/controllers/session/Database.ts`: only appendAll/level; no queries or claims.
- `src/agent/runtime/SessionEvents.ts`: memory log, transcript references, three reads.
- `src/shared/session/sessionEvents.ts`: current event-plane interface.
- `src/controllers/session/sessionInputs.ts`, `src/shared/session/sessionFrames.ts`:
  drained cursors without C7 existence/claim reconciliation.
- `src/shared/schemas/sessionEvent.ts`: current vocabulary and run.start fields.
- `src/transcript/StreamLogStore.ts`: 300 ms saving, writeStream, hydrateStream,
  parsePersistedEntries and preservedRawEntries.
- `src/transcript/StreamSnapshotStore.ts`, `SidecarWriteCoordinator.ts`,
  `StagedDeletionCoordinator.ts`, `StreamSummaryCacheStore.ts`: live file substrate.
- `src/agent/node/persistedFlow.ts`: whole-flow KV writes remain.
- `src/agent/storage/executionListing.ts`, `executionLease.ts`, `SessionStores.ts`,
  `ExecutionKVStore.ts`: directory listing, file claims, cleanup and metadata.

## Validation record

PR #11972 records exact integration commits and command outcomes. Local logs are
`/private/tmp/texra-cutover-{install,format,typecheck,lint,test,compile,effect,dead}.log`.
The SQL suite checks atomic rollback, sequence/commit ordering, payload envelopes,
WAL read-back, cascades, high-water reuse prevention and query-plan indexes.
It does not exercise a production database-backed session or multiple processes.

Validation outcomes:

- Frozen-lockfile install, full lint, full typecheck (all six targets), extension build,
  browser-safe utilities, guidance references and package contributes passed.
- `npm run format` completed; the final audit and touched files were formatted
  again after stage integration. `git diff --check` passed.
- The full suite during integration passed: 765 suites, 9,088 tests; one suite
  and five tests skipped. This run began before the final stage refresh; it is
  not claimed as a full-suite run at the final commit.
- After the final refresh, ten affected CLI/SQLite/architecture suites passed
  with `--maxWorkers=2`: 273 tests. The earlier concurrent focused run had one
  10-second CLI dynamic-import timeout; its isolated retry passed (four tests)
  and the final ten-suite run also passed without changing timeout settings.
- Dead-code ratchet fails only for dormant `Database.ts` (one new production-dead
  file). Effect ratchet fails on the same six growth findings and one adapter
  marker reproduced on initial main `542aea6e84`; the two stale ceilings were
  reduced here. Neither failure is waived or presented as passing.
- No copied-user-bucket import, multi-process host experiment, kill-9 acceptance,
  packaged host launch or <2-second startup measurement was run here.

## Review follow-up: retained spill content

Review of integration head `a09b0e1004` found that removing the old full-output
buttons/readers made pre-cutover spill content unreachable while file-backed
history still accepts `spillPath`. `StreamLogStore.hydratePersistedEntries`
now resolves those artifacts at the storage boundary for cold reads, resident
hydration and deletion rollback preservation. It replaces previews with full
text/tool output and removes the reference from the hydrated row; every
renderer receives the same canonical content. No spill writer or host-specific
reader is restored. Summary listing does not open artifacts. Invalid paths or
unreadable artifacts reject hydration, preserving the original stored history.
The reader is limited to recorder-owned `executions/<id>/toolOutput/*.txt`
paths and retires with the cutover's retained-history importer.

One regression in the existing `StreamLogStoreLoad` suite covers retained tool
and model output through cold and resident reads; all 64 tests in that suite
passed. Exact follow-up checks and CI/review results are recorded on #11972.
The initial integration's CI passed both kernel shards, Linux build artifacts
and macOS webview smoke. Static checks failed on the single dormant Database
finding, as predicted; that gate remains open.

Follow-up local validation: full lint, full typecheck, formatting and extension
build passed. The full suite with `--maxWorkers=4` passed on the repair tree:
765 suites / 9,085 tests passed; one suite / five tests skipped. Logs are under
`/private/tmp/texra-11972-review-*.log`.
