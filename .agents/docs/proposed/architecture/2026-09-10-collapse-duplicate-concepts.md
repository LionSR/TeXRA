# Collapsing duplicate concepts for TeXRA 1.0

Status: proposed — a census of duplicated vocabulary and the order in which to
retire it. The primary collapse is specified; the remaining families are
recorded as candidates with measured evidence, not as accepted work.

This note examines `main` merged into `claude/collapse-duplicate-concepts-5flo1e`
at `487f5c1` on 2026-09-10. It applies one rule from the accepted
[1.0 direction](../../../../AGENTS.md#texra-10-direction) — "prefer the current
supported APIs and one coherent implementation" — to the project's own
vocabulary rather than to its dependencies.

## 1. The rule being applied

A finding qualifies only when two or more **named** things are **one** concept:
duplicate vocabulary, parallel types, twin stores, synonym fields, two channels
carrying the same fact, or a value derivable from another value. Code that is
merely long, awkward, or repetitive does not qualify. The test is whether a
single source of truth would **delete a vocabulary**, not whether it would
tidy one.

The calibration example is the owner's own: `StreamTabId` is
`getCleanAgentName(name) + '#' + executionId`, so a stream id is an execution
id with a display name glued to the front. The display name is not new
information — it is already persisted on the run and already derived by the
same function the prefix calls. Two names, one concept, one of them derivable.

Findings are ranked by **vocabulary deleted per unit of blast radius**. A large
mechanical rename that erases a whole type ranks above a small edit that only
moves an indirection.

## 2. Verification status

This is an honest limitation of the present draft. A ten-lens census ran to
completion and produced 49 candidates. The adversarial verification pass that
was to follow — three independent refutation lenses per candidate — reached
only two candidates before the run terminated on an account quota limit; 47
verifier agents and the completeness critic never executed.

Consequently:

- **Section 3 (the primary collapse) is verified.** Its load-bearing claims
  were re-checked directly against live code, cite by cite, and are recorded
  below with what was confirmed.
- **Section 4 (the families) is unverified.** Each entry carries measured grep
  counts and file citations from its finder, but none has survived a refutation
  pass. Treat every entry as a lead to confirm, not a decision to implement.
- **Section 6 records the two candidates that were verified and refuted.**

The two completed verifications both came back `refuted`, which is itself
information: the census's confidence scores run optimistic, and the highest
confidence score in the set (0.93) belonged to a candidate that did not
survive contact with the code. Do not implement any Section 4 entry without
running its refutation first.

## 3. Primary collapse: `StreamTabId` into `ExecutionId`

`StreamTabIdSchema` is `z.string().min(1)`
([identifiers.ts:3](../../../../src/shared/schemas/identifiers.ts));
`ExecutionIdSchema` is hex ([identifiers.ts:13](../../../../src/shared/schemas/identifiers.ts)).
Both `z.infer` to a plain unbranded `string`, so to the compiler they are
today the same type already.

### What was confirmed

| Claim                                                                  | Status                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One minting formula, `` `${getCleanAgentName(name)}#${executionId}` `` | Confirmed — [streamTab.ts:24](../../../../src/agent/runtime/streamTab.ts), the only producer                                                                                       |
| The display half is already the single source of truth elsewhere       | Confirmed — `runIdentityDisplayName` is `getCleanAgentName(runIdentityName(id))`, the same function ([runIdentity.ts:54](../../../../src/shared/schemas/runIdentity.ts))           |
| Nothing in production addresses a run by parsing the format            | Confirmed — the sole `#` reader is an equality assertion between the two ids ([ToolUseFollowUpQueueManager.ts:135](../../../../src/agent/followUp/ToolUseFollowUpQueueManager.ts)) |
| A hand-rolled reverse index exists between the two ids                 | Confirmed — `getAgentHandleByStream` is an O(n) scan over handles keyed by execution id ([executionRegistry.ts:435](../../../../src/agent/runtime/executionRegistry.ts))           |
| One struct carries the composite _and_ both its components             | Confirmed — `RunScope` declares `streamId`, `executionId` and `agentName` together ([RunScope.ts:16](../../../../src/agent/runtime/RunScope.ts))                                   |
| No ratchet or architecture test pins the current shape                 | Confirmed — zero hits across `config/ratchets/` and `src/test-kernel/architecture/`                                                                                                |

`RunScope` is the clearest statement of the problem: it holds a value and, in
the same struct, both of the values that value is made of.

### The surviving single source of truth

`ExecutionIdSchema` becomes the one run identifier.
`RunIdentitySchema` / `runIdentityDisplayName` remains the one owner of a run's
human-orienting name — it already is, via
[sessionFold.ts:464](../../../../src/shared/session/sessionFold.ts).
`aggregateId(kind, logicalId)`
([sessionEvent.ts:131](../../../../src/shared/schemas/sessionEvent.ts)) remains
the one owner of the stream-versus-execution _lifecycle_ distinction.

This last point decides the main objection. The stream and execution
**aggregates** are separate rows with separate sequence counters and a
parent/child edge, and they stay separate. The event log already anticipates
this: `AggregateKeySchema` tags each id with its kind precisely so that two
aggregates can share a logical id. **The collapse deletes a vocabulary, not a
lifecycle.**

### Deleted

`src/agent/runtime/streamTab.ts` and its test; `StreamTabIdSchema` and the
`StreamTabId` type; `getStreamTabId` (7 production, 12 test call sites);
`BASH_CHILD_STREAM_PREFIX` and the four prefix literals (`bash@tool`,
`workflow-script`, `codex@codex-sdk`, `claude@agent-sdk`); the `streamPrefix`
option and its 9 threading sites; `streamTabIdOverride`, whose entire purpose
is re-supplying a value already in scope; the `endsWith('#' + executionId)`
guard, whose failure becomes unrepresentable; and the `getAgentHandleByStream`
reverse index, which collapses to a map lookup across 5 callers.

### Blast radius

784 `StreamTabId` occurrences across 146 production files; 1557 production
`streamId` occurrences; 88 production files carry both identifiers, and 56
declaration sites list them within two lines of each other. That adjacency
_is_ the duplicate vocabulary. Persisted surfaces are three opaque-key stores
(the SQLite aggregate id, the workspace-state goal key, the Supabase
`stream_id` column); under the no-legacy-migration policy none needs a
dual-read or a version branch, which is what would otherwise make this
expensive.

### Step order, and why step 1 is not optional

1. **Brand `ExecutionIdSchema`** with `.brand<'ExecutionId'>()`, the pattern
   `AggregateIdSchema` already uses. Both types are plain `string` today, so
   aliasing them without branding first makes the entire migration invisible
   to `npm run typecheck`. Branding is what converts this from a risky
   grep-and-rename into a compiler-checked one.
2. Pass `executionId` at the 7 mint sites; delete `streamTab.ts`.
3. Delete `streamPrefix` and its four literals from the child-stream and
   agent-CLI launch options.
4. Render the run's label instead of the raw id at the one place a stream id
   is shown to a human ([GoalTab.ts:120](../../../../packages/extension/src/settingsView/frontend/tabs/GoalTab.ts)).
5. Re-base `StreamSelectionSchema` on `ExecutionIdSchema`; delete
   `StreamTabIdSchema`.
6. Give `CLI_LOCAL_STREAM_ID` its own type — it is process-local and never
   reaches a schema parse.
7. Delete the now-tautological carriers.

### The honest counterarguments

Two live values are stream ids that are not execution ids: the empty-string
`StreamSelection` sentinel and `CLI_LOCAL_STREAM_ID`. Neither is deleted here;
the sentinel survives as a union member (better, as `nullable`, since
`HostInteractions` already normalizes `''` to `undefined`), and `cli-local`
gets its own type in step 6.

The prefix genuinely reads better in logs — roughly 15 `logger.warn` sites
become bare hex. That is a real loss. The mitigation is log annotation carrying
the identity, which the observability-plane note already specifies.

## 4. Candidate families

Unverified. Counts are the finders' measurements; citations are theirs.

**A. Run identity beyond the primary collapse.** `parentStreamId` and
`parentExecutionId` are one edge with 1:1 conversions in both directions (101
and 186 occurrences). `executionId` is also spelled `runId` and `storageKey`
(83 and 13 occurrences) with no distinction and no type — though `storageKey`
is frozen by the NDJSON vocabulary and can only be demoted, not renamed.
`isSubagent`, `background` and `isChildExecution` are three booleans for a fact
the parent edge already carries. A child's parent edge is persisted in four
records, and "is a direct child of X" is implemented twice off two of them.

**B. Folds of the same stream.** `StreamSnapshot` and `StreamView` are two
folds of one `SessionEvent` stream into two names; `StreamSnapshotStore` and
`SessionView.streams` are two homes for the per-stream fold. `StreamTabInfo` is
a wire twin of `StreamView` whose type name survives in three production files
and which has no producer left — the smallest entry in the census and the
cheapest to close. The grouped stream tree (Running / Waiting on you /
Interrupted / Recent) is derived once per host. `StreamView.usage` is a map
every consumer immediately totals, in four places.

**C. Status vocabularies.** A tool call's outcome is modeled four ways —
`ToolResult.status`, `TOOL_USE_STATUS`, `ToolStatus`, and the
`ToolUseLog.isError` boolean — and the code round-trips between them lossily
across 121 references. `ExecutionStatus` and `RunOutcome` are the same
three-member terminal vocabulary joined by a pure 1:1 translate that has
escaped its one frozen boundary. `WORKFLOW_EXECUTION_LIFECYCLE` is
`StreamPhase` with `running` renamed to `active`. Workflow calls carry two
nine-value status enums for one concept.

**D. Terminal result.** `AgentFlowResult`, `AgentFinalResult` and `ResultEvent`
are three declarations of one run result (141 references across 38 files), with
`totalCostUsd` and `cost` as two names for one number. The outcome is persisted
twice and reconciled at read time. A run's description is carried by two
durable event types that are always published together.

**E. Event channels.** `AgentEvent`, `TranscriptEventSchemas` and the durable
`durable(...)` arms are one run-event vocabulary declared three times — 21
duplicated interfaces in `src/agent/trace/events.ts` alone. `goalPaused` and
`goalStateChanged{status:'paused'}` are the same fact published twice on the
same aggregate.

**F. Requests awaiting a human.** The largest family. Four declarations of the
decision vocabulary (`PermissionDecisionByKind`, `RuntimeRequest.decision.*`,
`HostInteractionResultByKind`, `ApprovalDecision` — 67 occurrences across 19
files); four registries of "requests currently awaiting the user", kept in sync
by an event; `externalInquiry` running a wholly parallel pending/settle
protocol beside approvals despite being one of the seven permission kinds; the
refusal wording written as three switch tables over one `_tag` union;
`useOwnApiKey` being `decision.retry` with `credentials:'personal'` in
disguise. The finder's own counterargument here is strong and specific — an
inquiry is durable across restarts and multi-turn where an approval dies with
its run — so this family needs its refutation pass most.

**G. Model, provider and credential identity.** One paid-route identity is
spelled five ways across five catalogs. `ReasoningLevel` and llm-zoo's
`ReasoningEffort` are joined by a hand-written identity map and its runtime
inverse, with a silent drop-on-miss. `UsageProvider` is a hand-maintained copy
of `ModelProvider` bridged by an unchecked cast. Model availability is one fact
shipped as four wire fields and re-derived per host.

**H. Delegation plumbing.** `ChildStreamPort` is a hand-written copy of
`ChildStream` that exists only because the file sits on the wrong side of the
dependency rule — one file moved, one interface deleted, seven imports
rewritten, no behavior change. Two implementations of "queue a follow-up onto a
live child run" have already diverged.

## 5. Sequencing

The primary collapse is **time-critical**, and this is the census's most
actionable result.

Two proposed notes are already building on the two-identifier vocabulary:

- [PR1 run ledger foundation](2026-09-08-pr1-run-ledger-foundation.md) declares
  `interface RunAggregates { executionId; streamId }` and documents it as a
  **deviation it was forced into**, reasoning that "nothing on the execution
  aggregate names its stream, so a one-argument signature would need a reverse
  index, a second source of truth for an edge the launcher already owns". Under
  this collapse the two-key signature is unnecessary and the deviation
  disappears. Landing the collapse first removes a documented compromise from
  PR1 rather than shipping it.
- [The agent SDK architecture](2026-09-05-agent-sdk-architecture.md) freezes
  "`StreamTabId`, `ExecutionId`" as public SDK vocabulary. Once the Tier-1
  public manifest names both, the collapse stops being an internal rename.

So: **before PR1 is implemented, and before the Tier-1 manifest is written.**
The rest of the 1.0 retirement work is independent of it.

Within Section 4, family **B**'s `StreamTabInfo` entry and family **H**'s
`ChildStreamPort` entry are self-contained and could be confirmed and closed
immediately. Families **C**, **D** and **E** overlap the persistence and
observability work and are cheapest taken with it. Family **F** is large enough
to need its own note.

## 6. Rejected

- **`cliState` and `Surface` are one interaction record.** Refuted twice
  independently. The sentinels are opposites and the difference is load-bearing:
  `Surface.selected: null` is a sticky navigable destination (the New-task
  composer), while `cliState.activeStreamId: undefined` means _unset_ and is
  adopted by the first arriving fact. `CLI_LOCAL_STREAM_ID` is by construction
  never in `view.streams`, and `pruneSurface` is built on the explicitly
  opposite invariant that an id is never reused — so adopting `Surface` in the
  TUI would push terminal-only knowledge into `src/shared/`, which the
  dependency rule forbids. Of `Surface`'s 18 fields the TUI would use three or
  four and hold fourteen permanently empty.

  One genuine finding survives, and it runs the _other_ way: `ExpansionOverride`
  is a two-value enum doing a boolean's job. `'collapsed'` is produced at
  exactly one site as a toggle target and is never read as distinct from
  absent, because `isExpanded` tests `=== 'expanded'`. The SSOT-restoring
  change is inside `Surface` — make `expanded` a `ReadonlyMap<StreamTabId,
boolean>` and delete `ExpansionOverrideSchema` and a persisted string enum.

## 7. Effect-native requirements

Per the [1.0 direction](../../../../AGENTS.md#texra-10-direction), a collapse
whose end state is a Promise-shaped rename plus a compatibility alias has not
collapsed anything — it has renamed one indirection and added another. The
repo pins `effect` at `4.0.0-rc.112`, an Effect 4 release candidate, so any
implementation note must confirm its APIs against the installed package rather
than against Effect 3 recall.

Three constraints bind every entry above:

- **No transitional aliases that outlive their PR.** `export type StreamTabId =
ExecutionId` is admissible _within_ the migration and must not survive it;
  the repo already fails `check:effect-migration` on any `@adapter-until`
  marker, and the owner has ruled that there are no temporary adapters.
- **A collapse must shrink a ratchet, never widen one.** A design that would
  widen `config/ratchets/effect-migration-baseline.json` is a design error to
  fix, not a cost to accept.
- **Do not Effect-ify what is pure.** Identifier branding, schema derivation,
  and status-enum unification are compile-time and stay plain TypeScript.
  Effect belongs where these collapses touch registries, pending-request
  lifetimes and store ownership — families **F** and **B** — where a single
  owner means a scoped resource that releases on success, failure _and_
  interruption.

## 8. A single-source-of-truth defect in the guidance itself

[CLAUDE.md](../../../../CLAUDE.md) instructs "Serialize async work with
`p-queue`, never a hand-rolled promise chain".
[AGENTS.md:774](../../../../AGENTS.md) instructs the opposite under the
accepted 1.0 direction: "Do not introduce `p-queue` orchestration or
hand-written Promise chains". AGENTS.md governs. The stale CLAUDE.md bullet
should be corrected to point at the Effect concurrency rule — a contradiction
between the two files that agents and contributors read first is the same
defect this note is about, in the project's own instructions.

## 9. Not in scope

The [observability plane](2026-09-09-observability-plane.md) owns the run-event
emission path; family **E** should be read as input to it, not as competing
work. The [PR1 run ledger](2026-09-08-pr1-run-ledger-foundation.md) owns
execution-state persistence. The
[1.0 implementation plan](2026-09-09-texra-1-0-implementation-plan.md) owns the
retirement of `KVStore`, `PersistedFlow`, the file-based lease, `JsonStore`
application state and the old model-handler hierarchy; none of the collapses
above should be used to re-open the internal design of a mechanism already
scheduled for deletion.
