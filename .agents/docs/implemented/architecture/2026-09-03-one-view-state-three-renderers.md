# One fold, three renderers

> **Consolidated into `.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md` on 2026-09-03.** That PRD governs where the two differ; this proposal is kept for its evidence and history.

Status: proposal, version 2, 2026-09-03. Governs the conversation-shell
redesign (`2026-09-03-conversation-shell-directions.md`) and the projection
ledger (`2026-09-03-projection-adapter-ledger.md`), and binds both to the
persistence cutover (`2026-09-03-persistence-substrate-decision.md`, a
companion in flight in another branch, not in this tree yet). Owner
rule being applied: no dual systems, no projection or adapter layers between
the state and the pixels; the TUI, the desktop, and the extension render the
same state; cross-cutting minimized; the cleanest shape, not the cheapest.

Version 1 of this document chose a runtime-side fold with a patch transport
into a webview mirror, a slice key on the patch, per-command host handlers on
the write path, a new view type beside the existing state class, a live
"active stream" fact kept for multicast, host-side formatting, a read-only
cross-paper index, and allowlist tests as pins. Four adversarial reviews
broke every one of those with evidence. Section 9 records what changed and
why; the body below is the clean end state.

## 1. What is already right

- **One fact bus.** `SessionEvents`: run-scoped `AgentEvent`, session-scoped
  `SessionFact` (`src/agent/runtime/SessionEvents.ts`).
- **One reducer.** `SessionFactApplier` into the host-neutral `SessionState`
  (`src/controllers/session/`), constructed by all three hosts.
- **Pure shared folds** under `src/shared/`: `projectTranscriptRow`
  (exhaustive over message types), `taskGroupProjection`,
  `compactionActivityProjection`, `workflowRunModel` ("hosts render the
  result; they never regroup, re-sort, or re-count"), `streamStatusDisplay`,
  `streamOrdering`, `childElapsed`. The extension webview already runs the
  row folds itself over entries it receives; the desktop renderer loads the
  same bundle.
- **The substrate.** The database keeps only `event` keyed `(stream_id, seq)`
  and `event_sequence`. Nothing else is persisted. Every surface is a fold.
- **Many live sessions per process.** `SessionHandle` keeps a set of live
  sessions and resolves the current one through `RunContext`
  (`SessionHandle.ts:679-687, 805-838`); every run already carries its own
  `workingDirectory` (`RunScope.ts:21`, `AgentConfig.ts:59`).

## 2. The rule

**One pure fold, run by every process that shows a session. The transport
carries the fold's input, never its output.** There is no mirror of a fold
anywhere. A process that renders holds `fold(view, event)` and the events;
a process that only controls holds the same. What a host owns beyond the
fold is a `Surface`: the interaction state of one view instance. The line is
"facts versus interaction", never "backend versus frontend".

Consequences, each a deletion:

- `SessionRendererPort` and its three implementations, `LitSessionRenderer`
  and its twenty-one commands, the nine webview slices and the state merge,
  the view-side re-derivations, the TUI's own fold driving and row mapping,
  the headless private event fold: gone. The fold returns a value; nothing
  needs notifying.
- The patch vocabulary and the slice key of version 1: never built. A
  generic setter applying patches is a second reducer imitating the first.
- `LOG_DELTA`, `StreamLogDelta`, the bridge's delta buffering: gone. Events
  and text chunks cross the bridge framed per 16 ms exactly as entries do
  today; volume is equal, and a row-per-update patch would have shipped
  every text twice.
- `StreamTabInfo`, `StreamMetadata`, both `StreamState` variants,
  `StreamExecutionState`, `SessionStreamMetadata`, `ActiveChildInfo`: gone.
  They were four slices of one record. One value type remains.

## 3. The state

One Zod value type, `SessionView`, owned by the `SessionState` class as
`state.view`. `SessionState` stays a class because it owns stores and
lifecycle; the value it owns is what crosses a bridge.

```
SessionView
  streams: Map<StreamTabId, StreamView>
  order: StreamTabId[]                   // top-level, one shared rule
  approvals: ApprovalRequest[]           // from approval.requested, each with streamId
  policy: Map<StreamTabId, ApprovalPolicySnapshot>   // latest-of-type per run
  inquiries, goal, queuedFollowUps       // facts the runtime consumes

StreamView = discriminated on `category` (toolUse | workflow), never optional columns
  identity, label, description, model, modelLabel, worktree
  status, substate, statusDetail, runStartedAt, lastTimestamp, conversationProgress, stage
  followUpSupport
  parentId, ancestors[{id,label}], childIds        // ordered by streamOrdering
  rollup {total, running, finished}                // waiting never collapses
  approval: 'none' | 'own' | 'descendant'
  group: 'running' | 'waiting' | 'recent'          // waiting requires a live sequence owner
  usage, todos, plan, outputs, missingOutputs, compileFailures   // per category arm
  transcript:                                      // per stream, appended by settledSeq
    rows: TranscriptRow[]
    taskGroups, compaction
    settledSeq
    run?: WorkflowRunModel                         // retained-phase filter folded in
```

Rows carry every string that is a function of facts alone: label, preview,
one status label, `tone`, settled duration text, metadata parts, notices,
section labels, copy. Hosts carry every function of width, locale, color
depth, and the clock: head and tail budgets, `Intl` timestamps, glyph maps,
the tone-to-color map per medium, the terminal safety pass, and live elapsed
through one shared `(row, now)` formatter. This is the rule the shared tier
already follows in five places (`toolRowSections.ts:565`,
`workflowRunModel.ts:534-545`, `transcriptRow.ts:108-113, 222-227,
237-241`); version 1 had left it unstated.

## 4. The surface

One `Surface` per view instance, owned entirely by the renderer, never a
session fact, never persisted as one: the selected stream, drafts and pasted
images by stream, recording, expansion overrides, the focused row, scroll,
the drawer flag, workbench layout. Two surfaces on one session may select
different streams. The transport carries a subscription set: which streams'
transcripts this surface wants, from which seq.

This deletes the `setActiveStream` fact and its payload,
`ProgressPresentationState`, the applier's ensure-and-hint path, the
`StreamState.ui` block, and the pending-approval focus gate. The fact was
three concerns fused: stream creation, a metadata hint, and a focus request,
and it existed only because launch emitted it before `run.start`
(`AgentLaunchContext.ts:412-421`, `SessionFactApplier.ts:671-690`). The
fix is at the source: `run.start` moves to the reservation commit point and
becomes the existence fact; `identity` on it already yields category and
remote-ness (`streamTabInfo.ts:57-63`). Launch returns the stream id
(`onBeforeActivation` already hands it out, `AgentLaunchContext.ts:93`), and
the launching surface selects it. The failure-compensation boundary
(`AgentLaunchContext.ts:602-605`) and the tombstone-reopen gate
(`SessionFactApplier.ts:286-300`) are re-keyed on `run.start` plus live
owner evidence.

## 5. The protocol

Three messages, all hosts, the CLI calling the same in process.

- **Down: `events`.** Frames of durable events plus live text chunks, seq
  ordered, per 16 ms. A surface subscribes from a seq; the event table
  answers replay from N once it exists, and the retained log answers replay
  from 0 until then. One explicit in-flight text frame rides with a resync
  because text deltas are not durable.
- **Up: `runtime.request(RuntimeRequest)`.** One discriminated union handled
  by one `SessionHandle.request()` that validates, checks interaction
  ownership through the scope that `ownership.open()` already returns
  (`executionInteractionOwnership.ts:36-56`), runs the transaction, and
  returns a typed outcome. Arms: stop, delete, compact, resume, run new,
  follow-up, retry, the five decisions, bypass toggles, compile fixer,
  polish, export, workflow skip and retry, kill. Bypass toggling becomes one
  runtime transaction instead of the read, set, drop sequence hand-rolled in
  the shared handler (`ProgressViewCommandHandlers.ts:378-395`). The
  follow-up admission latch already lives in the controller; its result
  returns as the outcome, which deletes the ack command.
- **Up: `host.request(HostRequest)`.** Capabilities mapped onto `platform()`
  and `@hosts/*` ports: open file, spill artifact, task storage, compare,
  accept, merge, latexdiff, open label, pack, clean, restore into the
  launcher, diff and preview for a pending edit, recording, pop-out, pickers.
  The one honest exception: the own-API-key retry is a host credential flow
  whose completion issues a `runtime.request`.

The decoupling PRD's "translate a UI message into one runtime request" sets
a ceiling, not a floor; the inbound union is already a request union, and
the translation becomes identity. Deleted: `ProgressViewCommandHandlers`,
the registry halves of both GUI message handlers, `eventHandlers.ts`, the
desktop's unsupported-command list, `FOLLOW_UP_RESULT`,
`SETTLE_STREAM_SELECTION`, and the CLI's submit and approval engines as one
lane. Nine toasts hardcoded in the shared handler become outcomes the host
renders, per the push-UI-to-the-caller rule.

## 6. Many papers on the desktop

One desktop process holds N `SessionHandle`s, one per open paper, each
owning its workspace root, storage root, config, workspace state, and its
database handle. The rail is N `SessionView`s rendered by the same row. No
relaunch, no index, no foreign-run row kind.

The per-workspace roots move off the frozen `platform()` object onto a
`WorkspaceRoots` record on `SessionHandle`, resolved through
`currentSession()` exactly as interactions and executions already are.
`platform()` keeps the process-true ports: `fs`, `globalState`, `secrets`,
`lifecycle`, `processes`, `fileLocks`. The cheap and correct route for the
117 `StorageFS` and 154 `WorkspaceFS` production call sites is that the two static
classes read their base path from `currentSession()`; only their two
`getBasePath` bodies change, because every caller is run-scoped or
host-scoped. `additionalDirectories` inference in `agentWorkspaceOptions.ts`
goes with it. The cutover's stage 1 `Database` layer takes a root as a
layer parameter from day one and never reads the process singleton; one
database per `SessionHandle`, N handles per process, is the normal SQLite
shape under WAL.

Deleted: `desktopWorkspaceRelaunch.ts`, `DESKTOP_WORKSPACE_PATH_STATE_KEY`
and the argv plumbing, version 1's phase 2 index reader (a fourth reader of a
file layout the cutover deletes in the same release), the foreign-run
read-only mode, and the phase 4 "per-run root" step, which the runtime
already half-has. Sequencing: both programs edit `SessionHandle`, so if
the root move is ready before the cutover branch is cut it lands first and
saves a merge; otherwise the cutover passes the process storage path at its
single construction site and the root move swaps that one line later.

## 7. Enforcement by construction

Version 1 proposed nine allowlist tests. Seven become types or lint; two
remain tests.

- `HostInteractions`: already one implementation
  (`HostInteractions.ts:403`); hosts attach through `interactions.use()`.
  The dual was the decision mappers, which section 5 deletes. No pin needed.
- `SessionRendererPort`: deleted by section 2. No pin needed.
- Workflow skip, retry, and kill: methods on the `ExecutionInteractionScope`
  that `ownership.open()` returns. Nothing outside a scope can call them.
- `@lit/context`: both providers deleted; an eslint `no-restricted-imports`
  on the webview directories is the pin.
- Status tone: a `tone` field on the one `STREAM_STATUS_LABELS` table, so
  there is no second map to write; a duplicate is dead code knip catches.
- File-list enumeration, default agent, default model: shared `as const`
  tables and one function each; duplicates become dead exports.
- Validated launch: `ValidatedExecutionRequest.config` becomes a tagged type
  constructible only inside `executionRequests.ts`, and `runAgent` and
  `resumeRun` take that type, so the four raw host-side parses fail
  typecheck. This is the repo's first tagged type; the two core-side
  synthetic configs (`bash.ts:505`, `claudeAgentConfig.ts:252`) route through
  the same function.
- Tests that remain: `sessionPresentationBoundary` extended to fail on
  draft, recording, polish, transcription, and focus names in any shared
  schema (a type cannot forbid a field name); and, transitionally, one
  renderer per host until section 2 lands.

## 8. Contract with the persistence cutover

The substrate persists events; this program folds them. The only shared
contract is the durable event set. Agreed with the substrate owner on
2026-09-03, with fold rules:

1. `approval.requested` and `approval.resolved`, run-scoped, resolved
   carrying the request id. "Waiting on you" is requested without resolved
   and a live sequence owner; without a live owner the pair folds to
   "interrupted, resumable". Persisted payload is what the UI shows, never
   host handles.
2. An approval-policy event carrying the full snapshot after the change,
   emitted by the single policy authority; the fold is latest-of-type.
3. `setActiveStream` is not durable. Version 2 goes further: it is deleted
   as a fact (section 4).

Two additions from the adversarial pass, ruled by the substrate owner the
same day:

4. `run.start` moves to the reservation commit point and is the existence
   fact for a stream: a stream exists iff its `event_sequence` row exists,
   and `run.start` is seq 1 that creates it. Conditions: every stream kind
   gets one (agent, process, workflow script) through `RunIdentity.kind`; a
   launch that fails after reservation reaches its terminal `status` fact
   (`STREAM_PHASE.FAILED`, `compensateActivatedFailure`) on the same
   failure path - there is no `run.end` event and the PRD adds none - so a reserved-but-never-run stream folds to failed,
   never to a ghost; `category` and `isRemote` are explicit fields on the
   `run.start` payload and are never derived from `identity`: `RunIdentity`
   deliberately does not encode `AgentCategory`, a process or
   workflow-script stream has no agent to derive from, and remoteness is a
   registry lookup a browser fold cannot make, so the launcher writes both
   and the fold reads both (PRD section 6, item 6; contract C3);
   `suppressViewSwitch` is surface state and travels with the
   surface, never as an event; the importer emits `run.start` for every
   legacy stream with `identity` nullish where the descriptor has none, and
   the fold already labels an identity-less stream from its id prefix.
5. Worktree goes on the `run.start` payload, nullish. The launcher has the
   cwd before the reservation commit and the lookup is cached, so the fold
   never shells out and there is no new event type. Legacy imports carry
   null. Cut before add.

Four rules from the adversarial audit of all five proposals (substrate
owner, 2026-09-04), binding on lane 1 and written in full in PRD sections 5
and 6; the PRD's section 6 is the one count of event changes (eight):

6. No new durable fact lands on `main` before the event table exists. The
   recorder's exhaustive `AgentEvent` switch maps the approval events and
   the policy snapshot to no persisted entry; they are live-only until the
   cutover, which is today's behavior for a pending approval.
7. Liveness is probed per distinct owner process (pid plus process start),
   never one lease per run; `liveOwners` is a fold input computed that way.
8. Every fact lives on the aggregate of its logical target (contract C2);
   the event key is `(aggregate_id, seq)`. The queued-follow-ups snapshot
   (`UpdateQueuedFollowUpsPayload`, `FollowUpSentPayload`,
   `src/shared/schemas/progressEvents.ts:133-139`) and `stream.removed`
   (`RemoveStreamPayload`, `progressEvents.ts:48-50`) carry `streamId` and
   ride the stream's own aggregate; an inquiry thread's facts ride an aggregate whose id is
   the thread id; the one session aggregate carries singleton facts only.
   `SessionView` reads each field from the aggregate its type declares.
9. Residency is two-tier: listing facts come from latest-of-type indexed
   queries, transcript rows fold only for subscribed aggregates (the stream
   aggregate and, through the `run.start` edge, its execution aggregate,
   each with its own `fromSeq`; contract C7), in the runtime as much as in a
   webview.

Legacy transcripts are normalized into the canonical events of PRD section
6 at the import boundary (PRD decision 5): no `legacy.entry` event kind
exists and the fold has no entry arm. `settledSeq` is the last session commit
ordinal folded, never an aggregate seq (PRD 5.2).

## 9. What version 2 changed, and why

| Version 1                                                      | Version 2                                                                        | Broken by                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Runtime fold, patches into a webview mirror                    | One pure fold in every process; events cross the bridge                          | The webview already runs the row folds; a generic setter is a second reducer; patches ship text twice       |
| `{streamId, slice, value}`                                     | No patches, no slice key                                                         | Only the Lit renderer ever used the slice key; the TUI folds all eight into two revision bumps              |
| Per-command host handlers, duplicates folded                   | `runtime.request` and `host.request`, identity translation                       | Handlers hold no invariant a forwarder loses; ownership belongs in the runtime; the toasts move to outcomes |
| `SessionView` beside four wire types                           | One value type owned by the state class; the four die                            | They were slices of one record                                                                              |
| `setActiveStream` kept live for multicast                      | Deleted; `run.start` is existence, `Surface` is focus                            | The fact fused creation, hint, and focus; multicast focus is the leak                                       |
| Formatting in hosts from a shared table                        | Rows carry fact-only strings and `tone`; hosts carry width, locale, color, clock | The shared tier already emitted final strings in five places                                                |
| Read-only cross-paper index, relaunch kept, per-run root later | N sessions per process, roots on the session                                     | The runtime is already multi-session; the index read a layout the cutover deletes                           |
| Nine allowlist tests                                           | Types and lint; two tests                                                        | Allowlists rot; construction makes the dual unwritable                                                      |

## 10. Build order

Three programs are in flight on the same tree: the persistence cutover (one
branch, one release, stages 0 to 7), the startup-repair companion (S1 to S4
on the executions tuple), and this one. The order below is arranged for the
shortest critical path with at most three worktree lanes open at once, and
with each host switched in one pull request so no host ever runs half of the
old path and half of the new.

**Decisions before the first line of code.** Add `@effect/vitest` at the
pinned release candidate. Amend the CLAUDE.md `p-queue` rule for Effect
code. Ratify the migration PRD's rules R1 to R3 and R5 to R10; lane 2 is the
first code written under them (R4 is PocketFlow and is not needed here).

**Critical path:** lane 1, then lane 2, then lane 4, then lane 8. Everything
else runs beside it.

| Lane                           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Depends on                                                                                                             | Parallel with   | Touches                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| 1. Foundation                  | `sessionView.ts` (Zod), `sessionFold.ts` (pure, incremental per stream arm, run memoized as PRD 5.2 says), `runtimeRequest.ts`, `requestErrors.ts`, the pure-fold vitest. The event changes of PRD section 6 (eight; that section is the one count): approval requested and resolved, policy snapshot, `run.start` moved to the reservation point, `worktree` on its payload, category and remoteness on its payload (`ownerId` is on every event envelope, stamped by the substrate, never a payload field), `setActiveStream` deleted, snapshots for the invalidation hints, `run.activate`; compensation and tombstone gates re-keyed. | nothing; in-memory work that stays out of `src/transcript` stores, `src/agent/storage`, `persistedFlow`                | lane 6, lane 7a | `src/shared/session`, `src/agent/trace/events.ts`, `AgentLaunchContext.ts`, `SessionFactApplier.ts`      |
| 2. Effect services             | `SessionEvents` (the three reads and payload-free wakes of PRD 7.1; publish under one permit with a durable-write step the cutover fills in), `SessionView` (ref plus changes, fold forked under the layer scope), `WorkspaceRoots`, `sessionLayer` through `LayerMap`, `toSignal`, the `SessionRequests` methods with `Data.TaggedError`s and the ownership scope. The process runtime at each entry. `loopbackLogin` off the default runtime. `it.effect` suites with `TestClock`.                                                                                                                                                      | lane 1                                                                                                                 | lane 6, lane 7a | `src/controllers/session`, `src/agent/runtime/SessionEvents.ts`, `src/shared/signals.ts`, host entries |
| 3. TUI                         | Reads the fold and issues requests in process. Deletes `transcriptFold` driving, `streamViews`, `childExecutions` topology, `approvalQueue` row mapping, the retained-phase filter, `chatSubmitDriver`, the CLI approval mappers. `Surface` for selection, drafts, focus. One pull request.                                                                                                                                                                                                                                                                                                                                               | lane 2                                                                                                                 | lane 4, lane 5  | `packages/cli` only                                                                                      |
| 4. Extension and desktop       | Events over the bridge (framer with `groupedWithin` and a suspending `buffer`, PRD 7.4), the fold in the webview under a module-owned runtime with page-hide and hot-reload dispose, `Surface` in the webview, the two request messages up. Deletes `LitSessionRenderer`, the 21 commands, the 9 slices, `streamStateMerge`, `progressState` re-derivations, `streamTree`, `TranscriptIndex`, the 11 contexts, `ProgressPresentationState`, `StreamState.ui`, `ProgressViewCommandHandlers`, both GUI registries, `eventHandlers.ts`. Both hosts in one pull request because they load one bundle. Measure the bundle delta here.         | lane 2                                                                                                                 | lane 3, lane 5  | `packages/extension`, `packages/desktop`, `src/controllers/progressView`                                 |
| 5. Headless and SDK            | `runProgressRenderer` reads the fold; the NDJSON subscription stays a per-event projection of `SessionEvents.all(now)` and never reads `SessionView` (PRD 10.3); `workflowPlainOutput` renders the run model; `packages/agent` exports the fold and the request union.                                                                                                                                                                                                                                                                                                                                                                    | lane 2                                                                                                                 | lanes 3, 4      | `packages/cli/src/runtime`, `packages/agent`                                                             |
| 6. Session roots               | `WorkspaceRoots` on `SessionHandle`; `StorageFS` and `WorkspaceFS` base paths from context; `additionalDirectories` inference removed; desktop relaunch, argv plumbing, and state key deleted; N sessions per desktop process.                                                                                                                                                                                                                                                                                                                                                                                                            | nothing in this program; coordinate with the cutover: land before its branch is cut if ready, else swap one line after | lanes 1, 2      | `SessionHandle.ts`, `storageFS.ts`, `workspaceFS.ts`, `packages/desktop/src/main`                        |
| 7a. Ledger collapses, disjoint | Desktop tour; catalog refresh quadruple and `loadOptions` twice; CLI team plan and default agent and model duals; desktop settings handlers; resume wrappers; file-list enumeration; status tone column and one terminal-state vocabulary and the copy moves; validated-launch tagged type. Small independent pull requests, simplifier-style, any time.                                                                                                                                                                                                                                                                                  | nothing                                                                                                                | lanes 1, 2, 6   | files lanes 3 and 4 do not touch                                                                         |
| 7b. Ledger collapses, in-lane  | Bypass mirrors, decision mappers, inquiry dismiss, merge config, launch parses, `UserMessage` summary, tool-row predicates, `childRowMetadataText`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ride inside lanes 3 and 4                                                                                              |                 |                                                                                                          |
| 8. Shell                       | Direction A with E1 and E2, W0 as a restyle of the proposal panel, W1 with skip and retry through the ownership scope, the Tools sheet, the paper sections and the PDF workbench tab. Renders fields, issues requests. The design harness stays for iteration.                                                                                                                                                                                                                                                                                                                                                                            | lanes 4 and 6                                                                                                          |                 | `packages/extension` frontends, `packages/desktop/src/renderer`                                          |

**Ordering rules.** Deletions ship in the same pull request as the
replacement (R10), so a lane is not done until its "deletes" column is
empty. Lanes 3 and 4 are disjoint by package and run at the same time; lane
6 is disjoint from both and runs early because the cutover prefers it first.
Lane 7a is filler for idle capacity, never a blocker. Lane 8 starts only when
its inputs are fields and requests; drawing it earlier repeats the harness
work, not the product work.

## 11. Verified and not verified

Every file reference was read in this session or reported by a read-only
audit and spot-checked. Not verified: net lines after each deletion, the
render cost of a whole-stream `workflowRunModel` rebuild per frame in the
webview at fan-out scale (it is what the webview does today at
`progressState.ts:385`, so no regression is expected, but it is measured),
and the resync path's in-flight text frame under a dropped `postMessage`.

## 12. Effect shape

Superseded. The Effect shape of this program is PRD sections 7 and 8
(`.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md`): `SessionEvents`
exposes three reads, `listing()`, `all(fromCommit)`, and
`aggregate(id, fromSeq)`; its wakes carry no payload; and every subscriber
holds one commit cursor for the tail plus one `folded` seq per subscribed
aggregate. The single-stream `events(streamId, fromSeq)` read, the
payload-carrying `PubSub`, and the resubscribe-on-overflow repair that an
earlier version of this section defined are deleted, not amended; nothing
here overrides the PRD.
