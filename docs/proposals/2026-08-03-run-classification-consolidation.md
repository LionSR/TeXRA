# One run identity: one struct, one home, one wire

Status: Part I implemented (steps 1–7, 9 — `RunIdentity` struct + durable
`ExecutionMeta.identity` with idempotent entrance stamping, descriptor
deletion, Lit + CLI recuts onto the identity struct, resume/rerun/restore
gating, lineage predicate dedup, per-tool delegation availability), together
with Axis S (steps 10–11: `RunOutcome` as the sole persisted terminal fact,
`ExecutionStatus` demoted to an export/NDJSON boundary projection), Axis R
(step 14: the roster pair collapse onto category-keyed records with entrance
migrations), and the Axis-T retirements (the per-read legacy rescan of
stamped rows and the sidecar description/taskState mirrors, both retired
early and deliberately). Three legacy readers this document proposed were
subsequently retired outright rather than shipped: legacy `terminalStatus`
bytes are never converted to `outcome` (pre-consolidation rows have no
recorded terminal state), the roster-selection v1 pair vocabulary and the
versioned `.v2` key are gone (one unversioned key, canonical shape only,
malformed values warn and read as inherited), and the pre-FK sidecar
`runDescriptor` is never lifted (the unknown key is stripped; such sidecars
carry no execution FK). Subsequently landed in the same PR: **step 8**
(honest `RunRecord` union — `executions/{id}/config.json` is
`AgentConfig | {name, instruction, workingDirectory?, model?}`, bash and the
workflow-script container persist the honest arm, `readRunRecord()` at the
store seam, `PROCESS_HIDDEN_FIELDS` deleted, the trace document embeds the
union; codex/claude stay on the agent arm since they stamp
`kind:'agent'`); **the rest of Axis T** (opaque `${name}#${executionId}`
mint with no model segment and no model-required launch guard;
`legacyExecutionIdentity.ts` deleted whole with no replacement walker —
`meta.streamId` is the one execution→stream mapping, suffix resemblance is
never ownership, and pre-registration rows simply have no persisted stream;
`streamIdSource`/`registeredStreamId` deleted; CLI resume reads the stamped
FK); and **Axis U** (the `StreamSnapshotStore` is the one accumulator for
round artifacts and usage — the CLI's merge layer/revision counters/second
live spread and dual usage sum deleted, taskGroups incremental in the TUI,
`reportMissingOutputs` emits row+fact together, the edited-files
conversation scraper deleted outright in favor of the persisted list,
`StatusBarUsageTracker` and both webview components project from the store,
and workflow delivery summaries travel typed beside row text). **Step 17
(one command layer)** also landed: `resolveCliHistoryStatus` was already
gone (shared `resolveHistoryRunStatus`); `texra resume` now funnels through
`resolveAndResumeStream` — the tool-use arm reopens the chat TUI, the
workflow arm gains headless workflow resume under the persisted execution
id (honoring the stored `--output` via `resumeWorkflowOutputFile`) — with
`sessionResume.ts`'s five-way vocabulary deleted and chat resume resolving
inline over the shared retrieval; `userStartedCliHistoryEntries` deleted
(the visibility rule's one home is `isUserVisibleExecution` at the
listing; menu builders trust their input); `AgentRosterForm` consumes
`AgentRosterController.allPresets()`. Two step-17 items were found stale
against the tree and deliberately not forced: the CLI has no auto-open
action, so `selectAutoOpenFinalOutput` (a GUI editor-opening policy) has
nothing to unify — the `--output` copy and stdout result line keep their
explicit-flag/stdout semantics; and the chat-defaults tier already reads
the shared listing primitives (`listExecutions` + `isUserVisibleExecution`)
— its extra filters are tier-specific projection, not a duplicated rule.
After the main PR (#9705) merged, two step-16 slices landed as follow-up
PRs: **#9710** promoted the CLI's discriminated `StreamStage` to shared and
gave `stage.start` normalization one home (`src/shared/streams/stage.ts` —
all four inline guard clones deleted), and **#9712** adopted the single
`stage` slot across the Lit stack end-to-end (`StreamStageSchema` in
`src/shared/schemas/streamState.ts` as SSOT; `StreamExecutionState.stage`;
`UPDATE_ROUND_STAGE` → `UPDATE_STAGE`; `StreamMetadata` and the
`SYNC_STREAM_CONTENT` active state carry `stage`; frontend readers dispatch
on `kind` via `formatStageLabel`; delivery policy unchanged — phases ride
the metadata patch so parent viewports see them, rounds go targeted to the
active stream; the frozen public NDJSON wire keeps
`updateRoundStage`/`RoundStage`).
Still remaining — detailed handoff in the tracking issue for step 16/18
(see "Remaining work" below and #9713): the `taskRuns` legacy directory
probe (#6981, its own dated retention policy). Step 16 remainder + step 18
gate sweep landed in #9716.
Date: 2026-08-03
Revision: 10 (holistic build order; open-problems register)

TeXRA classifies "what kind of thing is running" in six places, and represents
"X is a child of Y" in twenty-six. Most are false at some write site, derived
by string-parsing, or independently authored copies of a fact something else
already owns. No single declaration of either fact is authoritative.

This proposal establishes **one struct** (`RunIdentity`), **one durable home**
(`ExecutionMeta.identity`, made required by a one-shot migration), and **one
wire** (the struct itself travels; hosts add display fields beside it, never
re-encodings of it). The same discipline is then applied to the orchestration
lineage graph. `AgentCategory` remains, unchanged, as the agent's
execution-mode fact with its `setting → config` authority chain.

## Revision notes

Revision 1: shared `RUN_SURFACE` chrome table — rejected (host policy in the
shared layer). Revision 2: one authority plus dated compatibility readers —
the dated `ExecutionMeta` reader would have broken old agent histories and,
through `TraceDocumentSchema.meta` embedding `ExecutionMetaSchema`
(`src/transcript/traceDocumentSchema.ts:10,20`), old exported traces.
Revision 3: compatibility classes and a removal inventory, but with
"readers treat `identity == null` as legacy" — every reader branching.
Revision 4: one choke-point resolver and a "provisional category hint".

Revision 5 removes the last two compromises and widens scope to everything
previously deferred:

- **No resolver.** A read-path fixup function makes every read pay for history
  forever. Instead: a **one-shot migration** stamps `identity` into every
  pre-existing agent row's `meta.json` (small JSON files, all terminal, no
  lease contention, atomic per-file write; agent name from the `config.json`
  beside it). After migration the persisted schema **requires** `identity`.
  One shape on disk and in memory, zero optional fields, zero branches. The
  migration module is the only legacy artifact and lives in no hot path.
- **No projections.** The descriptor's identity copy, the descriptor's
  category copy, and `TraceDocument.identity` are all deleted from the plan:
  the stream sidecar keeps a **foreign key** (`executionId`), the trace
  already embeds `ExecutionMeta` wholesale, and the identity struct itself
  travels on `run.start` (which already carries it — `childStream.ts:135`)
  and sits verbatim on `StreamTabInfo` and `StreamSlice`.
- **Orchestration lineage is in scope.** A full audit found 26 distinct
  representations of the parent–child edge. Same treatment: one durable
  authority, one in-memory authority, derived wire copies reduced to one,
  duplicate predicates and registries deleted.
- **The previously deferred removals are in scope**: the
  `DELEGATION_AVAILABILITY_CATEGORY` fabricated row, the fabricated
  per-run `config.json` lies, and `ActiveChildInfo.kind` — whose `process`
  arm turns out to be **dead code** (never constructed in production).

Revision 6 adds **Part II**: three further audits (lifecycle state,
string-encoded identity + legacy healing, derived-data recomputation) found
four more axes with the same disease — 19 state vocabularies with 18
independent re-derivation sites and 20 middle-layer healing sites; a
374-line legacy identity resolver that pays an O(all-streams) scan on hot
paths and is contractually forbidden from retiring itself; round artifacts
accumulated in four places and usage deltas in five; and 39
`workflow*`/`toolUse*` field-pair declarations re-shaping one durable value.
Part II applies the same rulings — one authority, migrate at the entrance,
delete the middle layers — as steps 10–15.

Revision 7 collapsed the staged delivery into a single change. Revision 8 is
the adversarial pass: three independent red-team reviews attacked the
migration story, the "safe to delete" claims, and the runtime semantics.
Five load-bearing claims were refuted and the core mechanism was redesigned:

- **"Required with zero optional fields" is impossible, twice over.** The
  shared `ExecutionMetaSchema` is transitively the _export_ schema
  (`TraceDocumentSchema.meta` embeds it, `traceDocumentSchema.ts:20`), and
  `parseTraceData` throws on any mismatch — a required `identity` bricks
  every pre-migration exported trace before any fallback can run. And the
  schema is `z.object`, so a not-yet-updated binary's read-modify-write
  (`enqueueMetaUpdate`, `executionLifecycle.ts:93-101`) **strips** the
  stamped field from disk. The design is now: required at the **write
  boundary** (`RegisteredExecutionMetaSchema`, used only by
  `registerExecution`), optional on the shared read schema.
- **The store-generation marker is abandoned.** An old binary un-migrating
  rows, the extension's own legacy-bucket merge injecting v1 rows post-mark
  (`workspaceStorage.ts:26-33` merges `executions/` child-by-child), lease
  fences throwing on live rows, and restored backups all defeat a one-time
  marker. Stamping is instead **idempotent at the store entrance**: skip
  rows that carry `identity`, re-stamp on absence, every time. Healing is a
  property of the store, not an event that mixed-version writers can undo.
- The full findings and the per-step amendments are in "Red-team findings
  and amendments" below; refuted claims are corrected inline where they
  appeared.

Revision 9 adds **Part III**: a two-sided audit of the last dual system —
the CLI versus the extension+desktop stack. Four subscribers attach to the
same `SessionEventHub` with the same dispatch idiom and four independent
handler tables; two full state engines maintain ~20 field-for-field paired
facts under different names and shapes; and the command layer (history,
resume, launch, roster, defaults, output) is reimplemented in
`packages/cli/src/runtime/` with eleven behavioral divergences. Part III is
the "one language" ruling: one session view-model, one subscription, one
command layer — hosts keep only rendering and input policy.

Revision 10 re-derives the build order holistically. The step numbers
(1–18) reflect **discovery order, not build order** — and followed
literally they would create the very intermediate layers this plan forbids:
steps 2–3 recut the Lit wire shapes and add `StreamSlice.identity`, which
step 16 then deletes when the unified view-model replaces `StreamSlice`
entirely. The "Build order — holistic" section supersedes the step
numbering with eight dependency-ordered phases in which **nothing is built
twice and nothing is built to be deleted**; the steps survive as the
per-area Add/Delete/Test/Gate specifications that the phases reference.
An "Open problems" register consolidates what is genuinely undecided.

## Problem

`AgentCategory` (`src/shared/schemas/agent.ts:10-16`) is a real and irreducible
fact about an _agent_: it is `AgentConfigSchema`'s persisted discriminant
(`src/agent/core/definition/AgentConfig.ts:67-70`). It is not a fact about a
_run_. A stream can carry a native agent, an external agent CLI, a background
bash process, or a deterministic multi-agent script, and only the first two are
agents at all.

`RunKind` (`src/shared/schemas/runDescriptor.ts:8-9`) is the correct axis and
already exists with the right three members. Nothing treats it as
authoritative, and `RunKindSchema` stays unexported, so no boundary ever
validates a kind.

| Vocabulary                                      | file:line                                                         | What it actually discriminates                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunKind` `{agent, process, workflowScript}`    | `runDescriptor.ts:8-9`                                            | What owns the stream. The correct axis. The type is exported at `:9` and consumed at `childStream.ts:17,28`; only `RunKindSchema` stays unexported, so nothing validates a kind at a boundary. |
| `RunDescriptor.agent` + `.category`             | `runDescriptor.ts:21-22`                                          | Nothing, for 2 of 3 kinds. `z.strictObject` demands both beside `kind`, so process and script runs fabricate them.                                                                             |
| `RunConfigReferenceSchema`                      | `runDescriptor.ts:11-15`                                          | Nothing. Three persisted fields for one reachable value; `path` is hardcoded at `:47`.                                                                                                         |
| `CreateChildStreamOptions.streamCategory`       | `src/tools/delegation/childStream.ts:27`                          | Nothing. False at 2 of 3 writers: `bash.ts:428` passes `ToolUse` beside `runKind: 'process'`; `WorkflowScriptTool.ts:426` passes `Workflow` beside `runKind: 'workflowScript'`.                |
| `ExecutionMeta.category: z.string().optional()` | `src/shared/schemas/stream.ts:86`                                 | Mixes `'process'` (a RunKind) with `'toolUse'`/`'workflow'` (an AgentCategory) in one untyped persisted string.                                                                                |
| `StreamTabInfo.kind`                            | `stream.ts:300-317`                                               | The same three literals declared a second time, while the shared base still requires `agentCategory` on all three arms (`stream.ts:280`).                                                      |
| `ProgressStreamRunDetails.kind`                 | `src/controllers/progressView/backend/ProgressViewState.ts:49-69` | The same three literals a third time, with correct per-arm payloads.                                                                                                                           |
| `StreamState.kind: AgentCategory`               | `src/shared/schemas/streamState.ts:195` (union at `:206-209`)     | A field named `kind` carrying the other axis: `kind: z.literal(AgentCategory.Workflow)`. `createStreamState` files everything non-ToolUse as Workflow (`:229-243`).                            |
| `isProcessAgent` over `Set(['bash'])`           | `src/shared/streams/agentKind.ts:14-18`                           | RunKind recovered by string-matching an agent name. Five production call sites.                                                                                                                |
| `resolveExecutionDisplayCategory`               | `src/tools/executionFormatters.ts:13-20`                          | A sixth spelling of the same decision.                                                                                                                                                         |
| `DELEGATION_AVAILABILITY_CATEGORY`              | `src/shared/constants/delegationTools.ts:37-42`                   | `DELEGATION_TOOL_CATEGORY` plus one fabricated row mapping `delegate_multi_agents` to `Workflow` — a tool that is in fact bi-categorical (`workflowScriptAgentRunner.ts:250,271`).             |
| CLI `StreamSlice.category`                      | `packages/cli/src/chat/tui/state/cliState.ts:188-191`             | The CLI's entire model. Cannot express process or workflowScript, so the TUI re-derives kind from a stream-id regex, a tool name, and transcript entry roles.                                  |

Three consequences follow.

**Fabricated identity.** `bash.ts:409-413` invents an `AgentConfig` with
`agent: 'bash', agentCategory: ToolUse`. `WorkflowScriptTool.ts:353-356` borrows
a real workflow agent's name and source for the script run itself. Worse,
`normalizeWriterCategory` (`src/agent/storage/executionLifecycle.ts:50-63`)
then rewrites the persisted bytes of bash/codex/claude configs to
`agentCategory: Workflow` — when the agent registry happens to be loaded — so
the same run can persist different bytes on different launches, and
`/executions` displays external CLI sessions as `workflow`.

**Render-time reconstruction.** `ProgressViewState.ts:320-323` recovers the run
kind by calling `isProcessAgent(config.agent)`, and therefore can never yield
`workflowScript`. This violates the "never compensate for a data-model problem
at render time" rule in CLAUDE.md at the source of the progress model.

**Hosts disagree.** The extension models three kinds; the CLI models two and
gates workflow affordances on `AgentCategory.Workflow`
(`appInteractionPolicy.ts:286-288`, `App.tsx:310-313`).

### Three live defects

1. `kind` was added at `runDescriptor.ts:24` inside a `z.strictObject` without
   bumping the version at `:6`. Descriptors written before that change fail
   parsing and are warn-and-dropped today.
2. Four of six `registerExecution` call sites omit `category`. Full inventory:
   omitted at `agentCliShared.ts:197`, `subagentExecution.ts:165`,
   `WorkflowScriptTool.ts:371`, `inBandSubagentExecution.ts:446`; passed at
   `bash.ts:415` (`'process'`) and `runAgent.ts:102` (`config.agentCategory`).
   That is why no execution on disk is ever tagged `workflowScript`.
3. **The progress-view Resume button relaunches borrowed identity.**
   `ProgressViewHost.resumeStream` (`ProgressViewHost.ts:62-79`) branches only
   on `config.agentCategory`; for a workflow-script stream the persisted
   category is `Workflow`, so Resume re-executes the _borrowed default agent's
   config_ as a plain workflow run — not the script. Post-demotion
   bash/codex/claude streams take the same branch. `RESTORE_STATE`
   (`ProgressViewCommandHandlers.ts:457-459`) similarly pushes a synthetic
   bash config into the main-view launcher form.

### Two prior beliefs that did not survive checking

- `texra.enabledAgents` and `texra.enabledToolUseAgents` have **no production
  reader**. `texra.enabledAgents` appears exactly once, in the test fixture
  `src/test-kernel/common/WorktreeMemento.vitest.ts:34`;
  `texra.enabledToolUseAgents` has **zero** hits anywhere in the tree. The live
  key is `texra.agentRosterSelection` (`src/shared/state/stateKeys.ts:21`).
  What is established is that the workflow roster resolves empty on the
  `software-engineer` and `lean-project` teams; the mechanism is not.
- `packages/trace-viewer/src/traceDataSchema.ts` does **not** hand-mirror
  `ExecutionMeta`. It is 38 lines that import `TraceDocumentSchema` from
  `@transcript`. The `_IsExact` breakage hazard is stale for that file.

## Compatibility classes

The ruling: **native agent-run history in the VS Code extension is inviolable;
bash and workflow-script session history may break; everything desktop-side
and everything in the TUI may break.**

One structural fact shapes how that applies: **all three hosts share the same
`~/.texra` store.** Desktop resolves `resolveDesktopDataRoot()` to
`DEFAULT_NODE_STORAGE_ROOT` (`packages/desktop/src/main/platform/paths.ts:45-52`,
`src/platform/defaults/nodeStorage.ts:15-18`); the extension migrates its
legacy `storageUri` data into that same root
(`packages/extension/src/frontend/vscode/sharedStorageRoot.ts`); the CLI uses
it too (`packages/agent/src/node.ts:109`). So breakability is a property of
**row cohorts and surface classes, not hosts**:

| Class                 | Members                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Regime                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Protected durable** | `executions/*/meta.json` + `config.json` rows whose run is a native agent; exported traces of agent runs (the trace embeds `ExecutionMeta` and `AgentConfig` wholesale)                                                                                                                                                                                                                                                                                                                                                                                         | Upgraded by the one-shot migration, or (traces — immutable) read via one confined fallback. |
| **Breakable durable** | The same files' `process` and `workflowScript` rows; `streamData/*/meta.json` sidecars; main-view `sessionType` webview state (`mainView/state.ts:151-171`)                                                                                                                                                                                                                                                                                                                                                                                                     | Version-bump freely; degradation acceptable.                                                |
| **Ephemeral**         | Every UI wire shape on every host (`StreamTabInfo`, `StreamMetadata`, `SYNC_STREAM_CONTENT`, proposals, history messages, `StreamState`, `ProgressStreamRunDetails`, CLI `StreamSlice`, desktop IPC, `ActiveChildInfo` roster — safe only because `assembleSnapshot` never populates `subagents`, `streamSnapshotRead.ts:184-201`). Audited: none persisted. **Exception: the headless NDJSON vocabulary is a declared frozen public contract** (`cliNdjsonProgressEvents.ts:26-34`, texra-cli skill: byte-identical) — projected at its boundary, never recut. | Recut atomically. Zero compatibility machinery, ever.                                       |     |

Two UI stacks, not three: desktop reuses the extension's Lit frontends and the
identical `ProgressBackend`/`WebviewUpdater` wire
(`packages/desktop/src/renderer/main.ts:22-53`,
`desktopAgentExecution.ts:256-266`). Recutting the webview shapes recuts
desktop for free. The other stack is the Ink TUI, whose only external contract
is headless output parity.

## Target model

### One struct

New `src/shared/schemas/runIdentity.ts`.

```ts
export const RunIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    agent: AgentNameSchema,
    /** External CLI driving this agent ("codex", "claude_code"); absent for native. */
    tool: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('process'), tool: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('workflowScript'),
    workflowName: z.string().min(1),
  }),
]);

export type RunIdentity = z.infer<typeof RunIdentitySchema>;
export type RunKind = RunIdentity['kind']; // derived, not a parallel enum

export function runIdentityName(id: RunIdentity): string {
  switch (id.kind) {
    case 'agent':
      return id.agent;
    case 'process':
      return id.tool;
    case 'workflowScript':
      return id.workflowName;
  }
}
```

No `category` field, anywhere in it. Category's authority chain is
`setting → config`, enforced at launch (`AgentLaunchContext.ts:276-293`), and
the behavior audit found no legitimate runtime consumer of any other copy.

### One home

`ExecutionMeta.identity: RunIdentitySchema` — **required at the write
boundary** (`RegisteredExecutionMetaSchema`, used only by `registerExecution`
inside the fresh-lease scope, at all six call sites) and **optional on the
shared read schema**, which is transitively the trace-export schema and must
keep accepting immutable pre-migration exports. Old rows are brought forward
by idempotent entrance stamping (below), not by read-path branches: readers
read `identity`; a row without one is an un-healed row and flows into the
existing `incomplete` handling at the one listing boundary.

There are **no projections**:

- **The stream sidecar keeps a foreign key.** `streamData/{id}/meta.json`
  shrinks to `{schemaVersion, executionId}` plus tab-local fields. The claimed
  contract for a descriptor identity copy — "display is keyed by stream id and
  renders before config resolves" — does not survive scrutiny: at rehydration
  the descriptor read is a disk read _and so is reading
  `executions/{executionId}/meta.json`_ — same timing, and the sidecar already
  stores the executionId. For live launches there is no window at all:
  `childStream` emits `run.start` (with identity) and `run.config`
  back-to-back (`childStream.ts:135-141`). `buildRunDescriptor`,
  `PersistedRunDescriptorSchema`, and `RUN_DESCRIPTOR_SCHEMA_VERSION` reduce
  to one FK field; `descriptorFromConfig` (`StreamSnapshotStore.ts:232-241`)
  is deleted with them.
- **The trace already carries the identity.** `TraceDocumentSchema.meta`
  embeds `ExecutionMeta` wholesale (`traceDocumentSchema.ts:20`), so every
  post-migration export has `meta.identity` for free. No `TraceDocument.identity`
  field. Replay reads `trace.meta.identity`; the single surviving fallback in
  the tree — one line, confined to the trace viewer — treats a pre-migration
  export (immutable artifact) as an agent run, which is what every
  pre-migration export is.
- **The wire carries the struct verbatim.** `run.start` already does.
  `StreamTabInfo.identity: RunIdentity`, `StreamSlice.identity: RunIdentity`,
  roster rows carry `identity` — the same struct from schema to disk to wire
  to component. Hosts add display fields _beside_ it (label, model, command),
  never re-encodings of it. The three per-arm union re-declarations
  (`StreamTabInfo.kind` arms, `ProgressStreamRunDetails`, and the CLI shape
  that would have been fourth) are all deleted.

### One migration

`stampExecutionStore()` runs at store entrance, **every time, with no
generation marker** — it is idempotent and cheap because rows already
carrying `identity` are skipped. Red-team findings that forced this shape: an
old binary's `z.object` read-modify-write strips stamped fields; the
extension's legacy-bucket merge injects v1 rows into an already-migrated
store; execution-lease fences throw on live or freshly-crashed rows; and
users restore backups. Mechanics:

- **Per row**: stamp `identity` (only — the proposed `terminalStatus` →
  `outcome` conversion was retired; legacy rows keep no terminal state)
  under `runWithInactiveExecutionLease`, skipping rows with an active lease
  (they heal on the next entrance) and rows younger than the lease-stale
  horizon (registration writes `meta.json`/`config.json` via
  `Promise.allSettled` — a half-born row must not be classified).
- **Identity rule**: quarantined stream-id-prefix evidence (`meta.streamId`
  is the one surviving legacy discriminator; this migration function is the
  ONLY production code allowed to read prefixes): `workflow-script#` →
  `{kind:'multiAgentWorkflow', workflowName: config?.agent ??
'workflow-script'}`; `codex@` / `claude@` → `{kind:'agent', agent:
config.agent, tool}`; `bash@` → `{kind:'process', tool:'bash'}`; otherwise
  `{kind:'agent', agent: config.agent}`. Rows whose rule needs a config but
  have none readable are **left unstamped** — the read schema is optional, so
  they keep parsing and keep listing as `incomplete`, exactly today's
  behavior. No sentinel names are fabricated.
- **`streamId` stamping is evidence-gated**: only the resolver's
  `metaMatched.length === 1` branch may stamp (the identical condition the
  live backfill uses today, `legacyExecutionIdentity.ts:223-234`); suffix
  matches are never stamped, and `streamIdSource` provenance is **kept** so
  a wrong stamp remains demotable. The walk is inverted — one scan of
  `streamData/` into a `Map<executionId, streamId[]>`, then stamp — O(N+M),
  not the resolver's per-row scan.
- The stamper is the only writer of these fields outside `registerExecution`,
  imports nothing from the hot path, and nothing imports it back.

## Responsibilities

**1. `AgentCategory` is an execution-mode fact owned by the agent definition.
Authority chain: `setting → config`, enforced at launch.** Every substantive
behavior branch reads it there: flow-engine selection (`executeAgent.ts:468`),
resume-type routing (`SessionResumeRetrieval.ts:111-124`,
`resolveAndResumeStream.ts:123`), structured-output injection
(`runToolUseFlow.ts:228-231`), model-handler mode and token budgets
(`ModelHandler.ts:325-335,1873`), background-mode eligibility
(`modelHandlerOpenAIResponse.ts:434`), skill-catalog loading
(`userVars.ts:192`), usage accounting (`UsageMonitor.ts:200`), helper-model
refusal (`helperModelPreference.ts:37-42`), workflow-output opening
(`runAgent.ts:139-141`). `deriveResumability` has no classification branch at
all. `RunIdentity` never becomes a second behavioral source for category.

**2. `RunIdentity.kind` is a launch-site fact, persisted once by
`registerExecution`.** Every current recovery of kind is name-parsing:
`isProcessAgent` (5 sites), the CLI's four-prefix stream-id regex
(`subscribeStreamLog.ts:138-142`), `meta.category === 'process'` sniffing
(`executionListing.ts:149`), `replayTrace.ts:159`, and the webview icon
heuristics (`BackgroundTasksPanel.ts:513-527`: `toolName === 'codex'`,
`bash → terminal`). All replaced by `identity.kind`.

**3. UI is a per-host projection of the parsed identity, ephemeral, no
compatibility machinery.**

**4. Lineage has one durable authority and one in-memory authority.**
Durable: `ExecutionMeta.parentExecutionId` (single writer,
`executionLifecycle.ts:136`). In-memory: `AgentExecutionHandle`
(`_parentStreamId`, `childStreamId`, `isChildExecution`,
`deliveryTargetStreamId` — `ExecutionHandle.ts:103-200`). Everything else in
the 26-representation inventory below is either a derived wire copy (reduced
to one), an index (kept, labeled), or a duplicate (deleted).

### Responsibility violations to correct

1. **Runtime semantics sourced from a display projection.**
   `AgentExecutionHandle.category` reads the descriptor
   (`ExecutionHandle.ts:159-161`) and drives `waitCoordination.ts:43-50`,
   `summaryFormat.ts:46`, and the `attachToolFlow` guard
   (`ExecutionHandle.ts:211`). Re-sourced from config.
2. **Write-time mutation serving a UI default.** `normalizeWriterCategory` —
   deleted; `loadHistoryDefaults` (`chatDefaults.ts:108-114`) and
   `isUserVisibleExecution` filter on `identity.kind`. `runtimeCategory`,
   which exists purely to hide the demotion, goes with it.
3. **Destructive guard, pinned but out of scope.** `runExecution.ts:115-120`
   deletes the flow record when a CLI command's demanded category
   (`texra run` → Workflow, chat → ToolUse) mismatches the resolved run.
   Red-team correction: this guards a _user-command_ mismatch, not
   classification drift — `RunIdentity` has no bearing on it. It is pinned
   by a fixture and otherwise left alone.
4. **Duplicated lineage predicates.** `isChildExecution` open-coded at
   `childStream.ts:335`, `waitCoordination.ts:47`, `summaryFormat.ts:47`,
   `DelegationTools.ts:300` beside the canonical `ExecutionHandle.ts:188-190`;
   caller-ownership authorization open-coded 4× (`DelegationTools.ts:306`,
   `agentCliShared.ts:99`, `summaryFormat.ts:48`, `ExecutionsTool.ts:727`).
   One home each, on the handle.
5. **Stale parallel registries.** `agentCliSessionStores.ts:12-30` stores its
   own `parentStreamId`/`childStreamId`, unsynced with `handle.detach()`
   (`executionRegistry.ts:576-587` updates only handle + approvals + events) —
   the follow-up authorization can contradict the live handle. The registry
   drops the copies and reads the handle.

## Orchestration: the lineage graph

The audit found **26 distinct representations** of the parent–child edge
(2 durable authored, 1 in-memory authority, ~10 derived wire/UI copies,
~10 hand-threaded parameters and duplicate registries, plus hashes and
string-encoded stream ids parsed back at three sites). The full inventory
lives in the audit; what matters here is the ruling per group:

**Kept, as authorities.** `ExecutionMeta.parentExecutionId` (durable, single
writer) and the handle's `_parentStreamId` (live, sole mutator `detach()`).

**Kept, as a labeled index.** The parent-store `child-{id}` KV records
(`ExecutionKVStore.ts:85-94`) — a parent→children index over the durable
edge, written in the same `registerExecution` transaction. It is an index,
not a second truth; its comment says so after this work.

**Kept, by design.** Lineage folded into derived-id hashes
(`checkpointKey.ts:20-33`, `workflowScriptAgentRunner.ts:218-222`) — that is
checkpoint identity, deliberate and load-bearing (the double-launch guard at
`WorkflowScriptTool.ts:378-393` depends on it). The in-band vs async
delegation split (`subagentExecution.ts:125`) — different durability
contracts, not duplication; only their _birth preamble_ is unified (step 6).

**Reduced to one.** The parent edge travels on **one** webview message:
`StreamTabInfo.parentStreamId`. `UPDATE_PARENT_STREAM` (`outbound.ts:95-98`)
and the `activeState.parentStreamId` copy (`outbound.ts:304`,
`ProgressFactApplier.ts:697-706`) are deleted — all ephemeral. The two
stream-id formulas that "must stay in lockstep" (`subagentExecution.ts:162-164`
vs `AgentLaunchContext.ts:566-572`, hazard documented at
`subagentExecution.ts:155-161`) become one function. The three names for the
orchestrator stream in one call chain (`orchestratorStreamId` /
`parentStreamId` / `deliveryTargetStreamId`) become one, and the delivery
target is always resolved from the **live handle**
(`nativeSubagentStrategy.ts:145-146` is the pattern); the static
`ChildRunLoopParams.parentStreamId` fallback (`childRunLoop.ts:214`), which
contradicts the handle after `detach()`, is deleted. The two finalize arms'
three independent `isSubagent` spellings (`childStream.ts:335`,
`childRunLoop.ts:894`, `nativeSubagentStrategy.ts:226`) collapse to
`handle.isChildExecution`.

**Deleted as dead or duplicate.** `ActiveChildInfo`'s `kind` union: the
`'process'` arm is **never constructed in production** (`getActiveChildren`
hard-codes `'subagent'`, `executionRegistry.ts:721-740`; the only
`kind:'process'` constructions are test fixtures) — so the union, the CLI
roster filter that drops `process` rows (`childExecutions.ts:259-268`), and
the webview `isAgentTool` tool-name sniffing (`BackgroundTasksPanel.ts:513-527`)
are all recut: one flat row shape carrying `identity`, `childStreamId`
always present, icons and clickability keyed on `identity.kind`.
`workflowPhase` stays as display data; the roster↔task-card join uses
`childStreamId` (both sides already carry it — `workflowCallProgress.ts:31-37`,
roster rows via the handle), not the phase-label string. The desktop's
hand-built `child.activity` re-emission (`desktopAgentExecution.ts:443-450`)
becomes a registry method call so the fact has one author.

## Host projections

**Extension + desktop (one Lit stack).** `buildStreamTabInfo` reads
`metadata.identity`; the `streamId.split('@')[0]` parse, `isProcessAgent`,
and the `?? Workflow` defaults die. `StreamHeader`'s parent-label
`split('@')` (`StreamHeader.ts:521-527`) reads the parent's tab info instead.
The naming trap dies: `StreamMetadataSchema.kind`, `StreamState.kind`, and
`SYNC_STREAM_CONTENT.kind` all carry _category_ under the name `kind`; all
ephemeral, renamed in place.

**CLI.** `StreamSlice.identity: RunIdentity`, projected from the `run.start`
fact the CLI already receives and currently discards
(`sessionProgressSubscription.ts:74-83`, `subscribeRuntimeHost.ts:144`).
The nine local reconstructions collapse:

| CLI reconstruction today                                                                                                                 | Replaced by                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `isFullLogChildStream` regex over four hardcoded stream prefixes (`subscribeStreamLog.ts:138-142`)                                       | a CLI predicate over `identity.kind`                 |
| `category === Workflow && entries.some(role === 'workflowTask')` (`App.tsx:310-313`, byte-duplicate at `panes/SubagentList.tsx:728-732`) | `identity.kind === 'workflowScript'`                 |
| `view.toolName === DELEGATE_MULTI_AGENTS_TOOL_NAME` (`StaticConversationTranscript.tsx:104-108`)                                         | `identity.kind === 'workflowScript'`                 |
| `session.toolName !== 'bash'` model suppression (`SubagentList.tsx:176-180`)                                                             | `identity.kind !== 'process'`                        |
| Two-hop AgentCategory walk (`appInteractionPolicy.ts:286-288`)                                                                           | `parent.identity.kind === 'workflowScript'`, one hop |
| `category === ToolUse` offers resume (`resumeHint.ts:151`)                                                                               | a CLI resume predicate over `identity`               |

Both ends of the CLI wire ship in one binary; the recut is atomic. Headless
`texra run` / `--print` output parity is checked per the `texra-cli` skill.

## Removals

All steps land in one change — no re-export shims, no orphaned exports (`npm run check:dead-code-ratchet`). Stage labels
map onto the executable plan below.

### Shared schemas and types

| Removed                                                                                                             | Location                           | Replaced by                                                | PR  |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- | --- |
| `CreateChildStreamOptions.streamCategory`, `.runKind`, `.agentName`, `.toolName` (four overlapping identity fields) | `childStream.ts:27-34`             | single `run: RunIdentity`; the launch sites pass the truth | 1   |
| `RunKind` as an independent enum declaration                                                                        | `runDescriptor.ts:8-9`             | `RunIdentity['kind']` derived type                         | 1   |
| `RunDescriptor` as a concept: `.agent`, `.category`, `.kind`, `buildRunDescriptor`, `PersistedRunDescriptorSchema`  | `runDescriptor.ts`                 | sidecar FK `executionId`; identity on the `run.start` fact | 5   |
| `RunConfigReferenceSchema`                                                                                          | `runDescriptor.ts:11-15`           | `runConfigPath(executionId)` helper                        | 5   |
| `descriptorFromConfig` rebuild fallback                                                                             | `StreamSnapshotStore.ts:232-241`   | nothing — hydration reads `ExecutionMeta` by FK            | 5   |
| `ExecutionMeta.category` untyped string                                                                             | `stream.ts:86`                     | `ExecutionMeta.identity` (required; one-shot migration)    | 4   |
| `StreamMetadataSchema.kind` (category misnamed `kind`)                                                              | `streamState.ts:143`               | renamed/retyped on the recut wire shape                    | 2   |
| `SYNC_STREAM_CONTENT.kind` naming trap                                                                              | `progressView/outbound.ts:314,325` | recut with explicit category naming                        | 2   |
| `StreamTabInfo` per-arm union + base `agentCategory` on all arms                                                    | `stream.ts:280,300-317`            | `StreamTabInfo.identity: RunIdentity` + display fields     | 2   |
| `ProgressStreamRunDetails`                                                                                          | `ProgressViewState.ts:49-69`       | `ProgressStreamMetadata.identity`                          | 2   |
| `TraceDocument.identity` (planned in rev 2-4, never built)                                                          | —                                  | `trace.meta.identity` (already embedded)                   | —   |

### Classification recovery helpers

| Removed                                               | Location                                        | Replaced by                                                                                                       | PR  |
| ----------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --- |
| `isProcessAgent` + `agentKind.ts` (5 call sites)      | `src/shared/streams/agentKind.ts:14-18`         | `identity.kind === 'process'` at each consumer                                                                    | 2-5 |
| `resolveExecutionDisplayCategory`                     | `executionFormatters.ts:13-20`                  | listing rows carry `identity`                                                                                     | 4   |
| `getAvailablePaths` category-string switch            | `executionFormatters.ts:50-72`                  | keyed on `identity.kind` + config category                                                                        | 4   |
| `normalizeWriterCategory`                             | `src/agent/storage/executionLifecycle.ts:50-63` | listing/defaults filter on `identity.kind`                                                                        | 4   |
| `runtimeCategory`                                     | `executionListing.ts:146,157` + readers         | nothing — the demotion it hides no longer happens                                                                 | 4   |
| `meta.category === 'process'` sniff                   | `executionListing.ts:149`                       | `meta.identity.kind`                                                                                              | 4   |
| `handle.toolName` mutable slot                        | `ExecutionHandle.ts:112`                        | `identity` on the handle, immutable                                                                               | 4   |
| `ExecutionHandle.category` sourced from descriptor    | `ExecutionHandle.ts:159-161`                    | sourced from config (consumers: `waitCoordination.ts:43-50`, `summaryFormat.ts:46,118`, `ExecutionHandle.ts:211`) | 4   |
| `replayTrace` kind re-derivation via `isProcessAgent` | `replayTrace.ts:159`                            | `trace.meta.identity`; one confined agent-fallback for old exports                                                | 5   |

### CLI reconstructions (ephemeral, deleted atomically in step 3)

`StreamSlice.category` (`cliState.ts:188-191`); `isFullLogChildStream`
(`subscribeStreamLog.ts:138-142`, consumers `:184,758-760`); workflow-root
detection (`App.tsx:310-313`) and its byte-duplicate
(`panes/SubagentList.tsx:728-732`); the `DELEGATE_MULTI_AGENTS_TOOL_NAME`
check (`StaticConversationTranscript.tsx:104-108`); `toolName !== 'bash'`
model suppression (`SubagentList.tsx:176-180`); the two-hop category walk
(`appInteractionPolicy.ts:286-288`); the `category === ToolUse` resume filter
(`resumeHint.ts:151`); `SetActiveStreamPayload.agentCategory`
(`progressEvents.ts:29-31`).

### Silent defaults

`metadata.agentCategory ?? AgentCategory.Workflow` (`streamTabInfo.ts:32`);
`runningCategory ?? getStreamCategory(streamId) ?? Workflow`
(`ProgressFactApplier.ts:756-757`); remaining `?? AgentCategory.Workflow`
sites (grep at implementation). Absent ≠ Workflow: absent renders as pending.
All step 2.

### Orchestration lineage (step 6)

| Removed                                                                                                                                                                                         | Location                                                                                         | Replaced by                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 4 open-coded `isChildExecution` copies                                                                                                                                                          | `childStream.ts:335`, `waitCoordination.ts:47`, `summaryFormat.ts:47`, `DelegationTools.ts:300`  | `handle.isChildExecution`                                                                                                            |
| 4 open-coded caller-ownership checks                                                                                                                                                            | `DelegationTools.ts:306`, `agentCliShared.ts:99`, `summaryFormat.ts:48`, `ExecutionsTool.ts:727` | one `handle.isOwnedBy(callerStreamId)`                                                                                               |
| `UPDATE_PARENT_STREAM` message + `activeState.parentStreamId` copy                                                                                                                              | `outbound.ts:95-98,304`; `ProgressFactApplier.ts:697-706`; `WebviewUpdater.ts:312-317`           | `StreamTabInfo.parentStreamId`, the one wire copy                                                                                    |
| second stream-id formula                                                                                                                                                                        | `subagentExecution.ts:162-164` (vs `AgentLaunchContext.ts:566-572`)                              | one shared function                                                                                                                  |
| static `ChildRunLoopParams.parentStreamId` delivery fallback                                                                                                                                    | `childRunLoop.ts:214,427-434`                                                                    | delivery target from the live handle, one name                                                                                       |
| `orchestratorStreamId` / `parentStreamId` naming split                                                                                                                                          | `nativeSubagentStrategy.ts:74`, `inBandSubagentExecution.ts:71`                                  | one name                                                                                                                             |
| 3 independent `isSubagent` spellings at finalize                                                                                                                                                | `childStream.ts:335`, `childRunLoop.ts:894`, `nativeSubagentStrategy.ts:226`                     | `handle.isChildExecution`                                                                                                            |
| `ResumableAgentCliSession.parentStreamId`/`childStreamId` copies + duplicated follow-up authorization                                                                                           | `agentCliSessionStores.ts:12-30`, `agentCliShared.ts:97-102`                                     | read the live handle; shared ownership check                                                                                         |
| `ActiveChildInfo` kind union (dead `process` arm) + CLI roster filter + webview tool-name icon sniffing                                                                                         | `streamState.ts:61-71`, `childExecutions.ts:259-268`, `BackgroundTasksPanel.ts:513-527`          | flat roster row carrying `identity` + `childStreamId`                                                                                |
| desktop hand-built `child.activity` re-emission                                                                                                                                                 | `desktopAgentExecution.ts:443-450`                                                               | a registry re-seed method (one author for the fact)                                                                                  |
| phase-label join scoped, not deleted (red-team: planned/cached/skipped calls have **no** `childStreamId`, `workflowCallProgress.ts:31-36` — the phase join is what makes `1/5` headers correct) | `SubagentList.tsx:661-716`                                                                       | `childStreamId` joins row→task-card (both launched sides); `workflowPhase` remains the join key for phase-group headers and counters |

### Delegation gating (step 7)

| Removed                                             | Location                   | Replaced by                                                                                                                                                         |
| --------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELEGATION_AVAILABILITY_CATEGORY` (fabricated row) | `delegationTools.ts:37-42` | per-tool roster declaration on `ToolDefinition` (a `z.looseObject`, documented as forward-compatible — `ToolDefinition.ts:18-30`), read by `annotateDelegationTool` |

Evidence the removal is safe: `requireVisibleAgent` and
`selectAvailableDelegationModel` already take category **literals**
(`WorkflowScriptTool.ts:287,346-351`; `workflowScriptAgentRunner.ts:250,271` —
which is bi-categorical, making the map's single `Workflow` row wrong, not
merely fabricated). The map's only production effect is description
annotation, and `delegate_multi_agents`' description has **no anchors**, so
both blocks are appended as trailing paragraphs today
(`delegationDescriptionBlock.ts:29-46`; anchors absent from
`WorkflowScriptTool.ts:184-232`). `DELEGATION_TOOL_CATEGORY` stays: it is an
honest two-row map for the two proposal-bearing tools, and webview bundles
import it (`proposalInput.ts:84-91`, `toolFormatters.ts:203-211`).

### Honest run records (step 8)

The fabricated `config.json` stops lying. What non-agent readers actually
consume, per the audit: `agent` (name), `instruction` (command/script label),
`workingDirectory` — never a real `model` or a meaningful `agentCategory`
(`configFieldFilter.ts:25` already hides `{model, agentCategory, toolConfig}`
for process rows — an admission). With `identity` durable and every
classification reader keyed on it (PRs 2–5), the record becomes a union:

| Removed                                                                | Location                                                                                                    | Replaced by                                                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| fabricated `agentCategory`/`model` on bash/codex/claude/script records | `bash.ts:409-413`, `codexConfig.ts:97-104`, `claudeAgentConfig.ts:248-255`, `WorkflowScriptTool.ts:353-369` | `RunRecord` union: agent arm = `AgentConfigSchema` unchanged (protected); non-agent arm = `{name, instruction, workingDirectory, model?}` |
| `PROCESS_HIDDEN_FIELDS` display filter                                 | `configFieldFilter.ts:25`                                                                                   | nothing to hide — the fields no longer exist on non-agent records                                                                         |

Old non-agent rows parse as the agent arm (they are `AgentConfig`s) — a
breakable cohort, readable either way. The trace document's `config` becomes
the union; old exported agent traces are the agent arm by construction.
Readers keyed by cohort switch on `identity.kind`, which steps 2–5 establish. Resume/rerun/restore affordances are gated on
`identity.kind === 'agent'` (fixes live defect 3, step 2).

## Result, stated honestly

**Singular:** one struct (`RunIdentitySchema`), one durable home
(`ExecutionMeta.identity`, required), one wire (the struct travels verbatim).
For lineage: one durable authority, one in-memory authority, one wire copy.

**Remains, by design:** `AgentCategory` on the agent definition and config,
with its enforced `setting → config` chain; the `child-{id}` KV records as a
labeled index; lineage inside checkpoint hashes; the in-band/async delegation
split; host display fields beside the struct.

**Deleted:** the inventory above — six classification vocabularies, five
name-parsers, one write-time byte mutation, six silent defaults, nine CLI
reconstructions, the descriptor as a concept, one dead union arm, eight
duplicate lineage predicates/authorization checks, two redundant wire
messages, one fabricated gating row, and the fabricated config fields.
Per-PR element deltas are counted against the tree at implementation time.

## Implementation plan — one shot

**One change, one branch, no staged merges.** Staged delivery is itself a
compatibility generator: every intermediate PR that must stay green forces
bridge code — a `buildRunDescriptor` still deriving v1 fields, sequencing
arguments about which writer dies first, a migration walker visiting the
store three times. Those transitional shapes exist only to keep intermediate
merges green, which is precisely the layering this proposal removes. Landing
everything at once means the tree goes from the current state directly to the
final state, and the only compatibility artifacts that **ever exist** are the
two entrance migrations. In particular, the three migration generations of
the staged plan collapse into **one walker, one pass**: `identity`,
`outcome`, and the resolved `streamId` are stamped together.

The steps below are the build-and-review checklist **inside the single
change** — implementation order and review grouping, not merge stages. The
whole change ships when the full acceptance battery passes: `npm run
typecheck` plus the trace-viewer tsc, `npm test`, `npm run
check:dead-code-ratchet` with smaller baselines, every grep gate listed per
step, and headless output parity per the `texra-cli` skill. Each step lists
Add / Delete / Tests / grep-able gates; the deletes are the point.

### Step 1 — `RunIdentity` exists; launch sites speak it

_Ephemeral._ **Add:** `runIdentity.ts`; `CreateChildStreamOptions.run:
RunIdentity` (bash → `{kind:'process', tool:'bash'}`; WorkflowScriptTool →
`{kind:'workflowScript', workflowName: meta.name}`; agent-CLI/subagent →
`{kind:'agent', agent, tool?}`); `run.start` carries identity (internal
representation; persisted descriptor untouched this PR).
**Delete:** the four `CreateChildStreamOptions` identity fields; the
independent `RunKind` enum.
**Tests:** `runIdentityName`; the three launch-site emissions.
**Acceptance:** `rg -c 'streamCategory' src/` → 0.

### Step 2 — Lit stack (extension + desktop) reads identity

_Ephemeral._ **Add:** `ProgressFactApplier` consumes `run.start` identity at
stream birth; `StreamTabInfo.identity` (struct verbatim, display fields
beside it); explicit category naming on `StreamMetadata`/`SYNC_STREAM_CONTENT`;
resume/rerun/restore gated on `identity.kind === 'agent'`
(`ProgressViewHost.ts:62-88`, `ProgressViewCommandHandlers.ts:457-459` —
fixes live defect 3).
**Delete:** `ProgressStreamRunDetails`; the `streamId.split('@')` parse and
`isProcessAgent` in `buildStreamTabInfo` and `ProgressViewState.ts:320-323`;
`StreamHeader.ts:521-527` parent-label string parsing; the `?? Workflow`
defaults (`streamTabInfo.ts:32`, `ProgressFactApplier.ts:756-757`).
**Tests:** progressView suites; first-render classification fixture for
process and workflow-script streams; a non-agent stream shows no
resume/rerun/restore affordance.
**Acceptance:** `rg -c 'isProcessAgent|\?\? AgentCategory.Workflow' src/controllers/` → 0.

### Step 3 — CLI recut, atomic

_Ephemeral. Delivers the TUI workflow-display and workflow-script fixes._
**Add:** `projectCliRunFact` projects `run.start` identity;
`TUI_RUN_FACT_HANDLERS['run.start']`; `StreamSlice.identity`.
**Delete:** all nine reconstructions (list above) and
`SetActiveStreamPayload.agentCategory`.
**Tests:** TUI snapshots for a workflow-script child pane and a process
stream; headless parity per the `texra-cli` skill.
**Acceptance:** `rg -c 'isFullLogChildStream' packages/cli/` → 0.

### Step 4 — the durable authority + one-shot migration

**Add:** `ExecutionMeta.identity` **required**; `migrateExecutionStore()`
(store-generation marker, atomic per-file stamp, agent name from adjacent
config); `registerExecution` requires identity at all six sites, written
inside the lease.
**Delete:** `meta.category` writes; `normalizeWriterCategory` + application
site; `runtimeCategory` + readers; the `'process'` sniff;
`resolveExecutionDisplayCategory`; `handle.toolName`;
`ExecutionHandle.category` descriptor-sourcing (→ config);
`getAvailablePaths` string switch.
**Tests:** migration fixtures (agent row, `category:'process'` row,
config-less row stays `incomplete`; idempotent re-run); post-migration listing
and resume identical; parentless synthetic-config row does not poison
`loadHistoryDefaults`; the `runExecution.ts:115-120` destructive path pinned.
**Acceptance:** `rg -c 'normalizeWriterCategory|runtimeCategory|resolveExecutionDisplayCategory' src/` → 0.
Fixes live defect 2.

### Step 5 — the descriptor dies; trace reads embedded meta

**Add:** stream sidecar FK (`StreamTabMeta.executionId`, split
`STREAM_TAB_META_SCHEMA_VERSION` from the descriptor version first —
`streamData.ts:38-40`); hydration reads `ExecutionMeta` by FK; `replayTrace`
reads `trace.meta.identity` with the one confined agent-fallback for
pre-migration exports.
**Delete:** `RunDescriptor` as a concept (`buildRunDescriptor`,
`PersistedRunDescriptorSchema`, `RUN_DESCRIPTOR_SCHEMA_VERSION`,
`RunConfigReferenceSchema`); `descriptorFromConfig`; `agentKind.ts` with its
last consumer (`replayTrace.ts:159`).
**Tests:** hydration from FK; old sidecar (descriptor-bearing) rehydrates via
FK-or-legacy-resolution; old exported trace replays; new trace round-trips;
trace-viewer tsc (not covered by root typecheck).
**Acceptance:** `rg -c 'isProcessAgent|buildRunDescriptor' .` → 0 (production
tree). Subsumes live defect 1.

### Step 6 — orchestration lineage dedup

_Ephemeral + in-memory._ **Add:** `handle.isOwnedBy(callerStreamId)`; one
stream-id derivation function; a registry re-seed method for presentation
attach; roster rows carry `identity` (+ `childStreamId` always); roster↔task
row→task-card join on `childStreamId`, phase-group headers still keyed by `workflowPhase` (see the scoped ruling in the step 6 table); unify the child-birth preamble (id mint +
`registerExecution` + stream-id derivation) into one function used by the
async, in-band, agent-CLI, and script paths — loop semantics untouched.
**Delete:** the step 6 table above — 4 `isChildExecution` copies, 4 ownership
checks, 2 redundant parent wire messages, the second stream-id formula, the
static delivery fallback, the naming split, 3 `isSubagent` spellings, the
agent-CLI registry lineage copies + duplicated authorization, the
`ActiveChildInfo` union + CLI filter + icon sniffing, the desktop hand-built
fact.
**Tests:** detach → follow-up authorization agrees with the handle;
delivery-target after detach; roster row for bash/codex/script children
renders by `identity.kind`; join-by-childStreamId fixture.
**Acceptance:** `rg -c 'parentStreamId !== .*childStreamId|childStreamId !== .*parentStreamId' src/ | grep -v ExecutionHandle` → 0;
`rg -c "kind: 'process'" src/shared/schemas/streamState.ts` → 0.

### Step 7 — delegation gating without the fabricated row

**Add:** roster declaration on `ToolDefinition` (looseObject field), set by
each delegation tool; `annotateDelegationTool` reads it; anchors added to
`delegate_multi_agents`' description so the appended blocks land where
intended.
**Delete:** `DELEGATION_AVAILABILITY_CATEGORY`.
**Tests:** description annotation parity for all three tools; the
bi-categorical script runner keeps both roster namespaces.
**Acceptance:** `rg -c 'DELEGATION_AVAILABILITY_CATEGORY' src/` → 0.

### Step 8 — honest run records

**Add:** `RunRecord` union (agent arm = `AgentConfigSchema` unchanged;
non-agent arm = `{name, instruction, workingDirectory, model?}`); store-level
`readRunRecord()` typed by `identity.kind`; trace document `config` becomes
the union.
**Delete:** fabricated `agentCategory`/`model` writes at the four sites;
`PROCESS_HIDDEN_FIELDS`.
**Tests:** `/executions/{id}` summary/config/paths for each cohort; trace
export + replay for a new process run and an old agent trace; workspace-file
resolution on the non-agent arm.
**Acceptance:** `rg -c "agentCategory: AgentCategory" src/tools/` → 0 outside
delegation launch of real agents.

### Step 9 — Part I gate sweep

Shrink `config/ratchets/knip-baseline.json` (never widen); no new `@agent/*`
deep-import specifier in any host; update `src/agent/core/README.md` and this
proposal's status.
**Acceptance:** all ratchets pass with smaller baselines.

## Part II — further axes

Three audits beyond run identity found the same disease on four more axes.
The rulings follow the same discipline: one authority per fact, migration at
the entrance (one-shot, quarantined), no read-path branches, no recomputation
of what an authority already holds. Each axis gets its ruling, its removals,
and its PR.

### Axis S — lifecycle state (steps 10–11)

**Findings.** 19 distinct state vocabularies; the persisted terminal fact is
_two_ fields (`ExecutionMeta.terminalStatus`, an untyped string, plus
`outcome: RunOutcome`), kept consistent by a `superRefine`
(`stream.ts:98-110`) and healed by a `.transform` on **every read and write**
(`stream.ts:112-119`, applied via `ExecutionKVStore.ts:290`) — a permanent
middle-layer fix for a write-side problem. 18 sites re-derive status
independently of the `StreamStatusMachine`, including:
`WorkflowScriptTool.ts:505` deciding a script call's success by comparing the
raw `terminalStatus` string; `AgentRunLifecycle.ts:183-189` reading the phase
back out of the machine and silently **overriding the caller's outcome** with
it; two parallel history-status projections reading _different_ source fields
into _different_ vocabularies (`resolveHistoryRunStatus` over `outcome` →
`HistoryRunStatus`; CLI `resolveCliHistoryStatus` over raw `terminalStatus` →
plain string, `history.ts:426-434`); and the TUI detecting child errors by
lowercasing arbitrary strings and regexing for exit codes
(`childExecutionStatus.ts:6-15`).

**Ruling.** Two vocabularies survive as authorities: **`StreamPhase`** for
live state (owned solely by the `StreamStatusMachine`) and **`RunOutcome`**
for terminal state (owned solely by `ExecutionMeta.outcome`).
`ExecutionStatus` becomes an export-boundary projection (old traces carry it;
the exporter keeps projecting via `runOutcomeToExecutionStatus` at that one
boundary). Everything else is a display projection computed in one place.

**Step 10 — one terminal field.** As landed, **`terminalStatus` is no longer
written or read at all** — `writeTerminalOutcome` writes `outcome` alone, and
the proposed legacy conversion (stamping `outcome` from `terminalStatus`
bytes) was retired: pre-consolidation rows simply have no recorded terminal
state.
_Delete:_ the `superRefine`, the read/write `.transform`, every raw-string
reader (`WorkflowScriptTool.ts:505` → `outcome === RUN_OUTCOME.COMPLETED`;
`executionListing` carries `outcome`; `getExecutionStatusInfo` merges live
phase ⊕ persisted `outcome`, its `StreamPhase | ExecutionStatus | 'unknown'`
union narrowing to `StreamPhase | RunOutcome`).
_Tests:_ migration fixtures incl. an unmappable legacy string; resumability
parity before/after.
_Acceptance:_ `rg -c 'terminalStatus' src/ packages/` → only the export
projection and the migration module.

**Step 11 — one projection per display decision.** One shared
`resolveHistoryRunStatus` over `{resumable, outcome}` used by both hosts
(the CLI's parallel string-typed variant deleted); the phase→outcome
authority inversion at `AgentRunLifecycle.ts:183-189` replaced by an explicit
`settleRun(outcome)` in which the machine's terminal transition and the meta
write happen together — with the resolution performed **inside** the
machine: `resolved = isTerminalOutcomePhase(observedPhase) ? observedPhase :
reportedOutcome`, preserving the user-stop-wins contract the current code at
`AgentRunLifecycle.ts:176-189` implements (red-team: a naive
`settleRun(callerOutcome)` would write `COMPLETED` over a `CANCELLED` phase
and the fail-closed rule at `executionLifecycle.ts:283-285` would then
**delete the flow record of a run the user merely stopped**). Fixture: stop →
CANCELLED → runner reports COMPLETED → meta, phase, and `ResultEvent` all
read CANCELLED and the flow record survives;
`isChildExecutionErrorStatus`'s string-lowercasing regex deleted (roster rows
carry a typed `StreamPhase`; use `isTerminalOutcomePhase`); the retired
7-value `StreamStatus` confined to the trace-viewer read boundary.
_Acceptance:_ `rg -c 'resolveCliHistoryStatus|isChildExecutionErrorStatus' packages/cli/` → 0.

### Axis T — opaque stream ids, and retiring the legacy resolver (step 12)

**Findings.** The `@model` segment of
`${cleanAgent}@${model}#${executionId}` has **no display or logic parser**
— uniqueness comes from the `#executionId` suffix alone
(`streamTab.vitest.ts:29-33`). Red-team correction, twice: the CLI's child
prefix regex reads the segment as a kind encoding (dies in step 3 anyway),
and — load-bearing — the CLI resume paths **re-derive an existing id** from
`config.agent + config.model` (`toolUseResumeData.ts:20`;
`SessionResumeRetrieval.ts:196` → `executeAgent.ts:556`; workflow arm via
`runAgent.ts:103`). The id is a _reproduction contract_, not a display
string. Therefore: before the mint format changes, those call sites read
`registeredStreamId(meta) ?? getStreamTabId(...)` — the stamped FK first,
the legacy formula as fallback — with a resume fixture over a pre-migration
`name@model#id` bucket, and an acceptance rule that every remaining
`getStreamTabId` caller is a birth site. Yet it costs: `AgentLaunchContext.ts:564`
hard-fails a launch when `model` is missing _purely to mint the id_, and the
fabricated display models (`CODEX_DISPLAY_MODEL`, `CLAUDE_AGENT_DISPLAY_MODEL`,
the `DEFAULT_AGENT_MODEL` prefault leaking into bash stream ids —
`streamTabInfo.ts:105-110` documents the leak) exist substantially to feed a
dead segment. Separately, `legacyExecutionIdentity.ts` (374 lines) is the
largest permanent middle-layer in the tree: every execution→stream read
without registration provenance pays a bounded O(all-streams) sidecar scan
**on hot paths** (every completed `/executions/{id}` summary, every
`assembleTrace()`), and its backfill writes a cache that its own contract
(`registeredStreamId`, `stream.ts:121-134`) forbids from ever becoming
authoritative.

**Ruling.** A stream id is an **opaque handle**, minted once as
`${name}#${executionId}` — no model segment, no parsing, ever. The
execution→stream mapping is resolved **once, at the entrance**: the one migration walker runs the existing resolver per unresolved row, stamps a
unique match as the authoritative `streamId`, and leaves genuinely ambiguous
rows unresolved (exactly what the resolver reports today, computed once
instead of per read).
_Delete:_ the model segment for new ids and the `model`-required launch guard
(`AgentLaunchContext.ts:564`); `legacyExecutionIdentity.ts` whole (374
lines), the `streamIdSource` enum and `registeredStreamId` contract;
`parseLegacyTaskState` + `TaskState.ts` + the `StreamTabMeta.taskState` read
shim (breakable sidecar cohort); the sidecar `description` mirrors and
`hydrateDescriptionsFromExecutionMeta`'s per-stream meta read on every load
(#9627, folded in); the `legacyRuns: 'taskRuns'` directory probe (one-shot
rename). In the final tree the last stream-id parsers are gone (steps 2/3/5),
so the format change is safe for new runs and old ids stay opaque strings.
_Kept, permanent by nature:_ the filename-era workflow-output grammar
(`workflowOutput.ts:57-106`) — it parses **user files on the user's disk**,
which no migration of our store can rewrite.
_Tests:_ migration resolves a legacy fixture bucket; ambiguous rows stay
unresolved with the same user-visible result; trace assembly and
`/executions` summaries never invoke a scan.
_Acceptance:_ `rg -c 'legacyExecutionIdentity|streamIdSource|LEGACY_RESOLUTION' src/` → 0;
launches without a model succeed for non-agent runs.

### Axis U — derived data: one accumulator per fact (step 13)

**Findings.** Round artifacts (`outputFiles`/`missingOutputs`/
`compileFailures`) are accumulated in **four** places (the
`StreamSnapshotStore` sidecar accumulators; the CLI's live+durable merge with
generation counters, `subscribeStreamArtifacts.ts:47-75` +
`cliState.ts:327-345`; the CLI's independent live spread,
`subscribeRuntimeHost.ts:169-189`; the extension frontend's third copy).
Usage deltas are summed in **five** (store sidecar; extension webview
per-render sums ×2; `StatusBarUsageTracker`'s own map; the CLI's dual
`usage`/`cumulativeUsage`). `missingOutputs` has two representations that
**disagree**: three `XmlOutputManager` paths write the transcript row without
emitting the run fact, so the sidecar and the transcript diverge. The
workspace-files fallback is read-time conversation-scraping that one reader
uses and the other doesn't (`history.ts:181-185` vs
`HistoryMessageBuilder.ts:33-38`). `UserMessage.ts:217` re-parses structured
data **out of rendered message text**.

**Ruling.** Facts carry deltas; **one accumulator per fact** — the
`StreamSnapshotStore` — and every consumer reads the accumulated state
through it. Derivations that exist to compensate for missing writes move to
the write site.
_Changes:_ the CLI consumes store-projected artifact/usage state (its merge
machinery, generation counters, and second live accumulation deleted; the
NDJSON delta events stay — external contract); the extension's per-render
usage sums become one selector; `StatusBarUsageTracker` projects from the
store; one `reportMissingOutputs` helper emits row + fact together (the three
fact-less paths deleted); the conversation-scrape for edited files runs
**once at finalize** and persists, so both history readers read the persisted
list and the read-time scraper dies; taskGroups use the incremental
projection engine in both hosts (the CLI's full re-projection per sync tick
deleted); `UserMessage`'s text re-parse replaced by structured data carried
beside the text.
_Acceptance:_ `rg -c 'mergeArtifactSnapshot|streamArtifactRevision' packages/cli/` → 0;
`rg -c 'listExecutionEditedFiles' src/` → only the finalize-time site.

### Axis R — the roster pair collapse (step 14)

**Findings.** 39 `workflow*`/`toolUse*` field-pair declarations across four
packages (7 roster-key pairs, 8 roster-list pairs, 11 record-keyed
partitions, 11 main-view form-state pairs, 1 team-roster pair, 1 prompt-var
pair) — and **exactly two of them are durable**
(`WorkspaceStateKey.AGENT_ROSTER_SELECTION`). Every other pair is a
re-shaping of that one value or of the preset catalog for a different
consumer.

**Ruling.** One generic shape, `ByCategory<T> = Record<AgentCategory, T>`,
replaces every pair. **Both** durable values migrate at their entrances —
`AGENT_ROSTER_SELECTION` _and_ `CUSTOM_AGENT_PRESETS`
(`agentPresets.ts:48-57` carries the pair in user-authored teams; a recut
without migration would silently drop them — red-team fixture required). And
"its entrance" is three entrances, not one: the extension's VS Code memento,
plus the `state.json` shared by desktop **and** CLI
(`packages/desktop/src/main/platform/index.ts:97-99`,
`packages/cli/src/runtime/cliStateStores.ts:26-27`). As landed, the
versioned-key dance this section proposed was retired: one unversioned key
(`texra.agentRosterSelection`) holds the canonical record shape only, and
`readAgentRosterSelection` uses `safeParse` with a loud inherited-roster
fallback — a pair-shaped legacy value reads as inherited until the next
write replaces it. The prompt
variables `WORKFLOW_AGENTS`/`TOOL_USE_AGENTS` keep their names — they are an
external prompt contract — but are built from the record.
_Delete:_ all 38 non-durable pair declarations and their branch-per-category
read/write sites; the paired wire messages collapse to record-keyed ones (all
ephemeral).
_Tests:_ memento migration fixture (old pair → record); roster resolution
parity per category; settings/main-view round-trip.
_Acceptance:_ `rg -c 'workflowAgentKeys|toolUseAgentKeys|workflowAgents|toolUseAgents' src/ packages/`
→ the memento migration module and prompt-var builder only.

### Step 15 — final gate battery

Run the full acceptance battery: all grep gates from every step, both
typechecks, tests, ratchets with shrunk baselines (never widen), no new
`@agent/*` deep-import specifiers, headless parity, and this proposal's
status updated.

## Red-team findings and amendments

Three independent adversarial reviews (migration & persistence; deletion
claims; runtime semantics) ran against revision 7. The corrections above are
inline; this section records the remaining amendments, each now binding on
the step it names. Claims that **survived** full adversarial scrutiny: the
dead `ActiveChildInfo` `process` arm, and the descriptor early-render timing
argument (both disk reads on the same hydration path; no path found where
the sidecar exists but the execution meta does not — deletion order always
removes stream state first, `SessionStores.ts:251-268`).

**A. The write/read seam (steps 4, 10).** `RegisteredExecutionMetaSchema`
(identity and outcome required) exists only at `registerExecution` and the
finalize writers; the shared `ExecutionMetaSchema` keeps both optional
forever, because it is transitively the trace-export schema and because old
binaries' `z.object` read-modify-writes strip unknown fields. Fixture: a
pre-migration exported `trace.json` parses and replays.

**B. Idempotent entrance stamping, no marker (step 4).** Specified in "One
migration". Neutralizes: old-binary stripping, the extension legacy-bucket
merge injecting v1 rows, lease-fenced live rows, half-born rows, restored
backups. The stamper's lease helper deletes stale lease files as a side
effect (`executionLease.ts:854-856`) — stated, accepted.

**C. Category is still a runtime fact for children (steps 4, 6, 8).**
`handle.category` is sourced from the **launch-time in-memory config** —
never the persisted record, never the descriptor. `waitCoordination` and
report suppression become `handle.identity.kind === 'agent' &&
handle.category === 'toolUse'`; a workflow subagent parked WAITING must keep
blocking (`waitCoordination.ts:38-42`). Additional `handle.category`
consumers the removal table missed, all sourced the same way:
`ResultEvent.category` (required, `events.ts:329`), the running-summary
`Category:` line (`summaryFormat.ts:94`), and the completion notice
(`ExecutionSubscriptionBinder.ts:123`).

**D. codex/claude stay on the agent arm (step 8).** The non-agent
`RunRecord` arm is restricted to `process` + `workflowScript`; external-CLI
runs keep a real `AgentConfig` (their `ToolUse` category is consumed by live
machinery). The resume/rerun/restore gate is `identity.kind === 'agent' &&
identity.tool === undefined` — otherwise defect 3 changes shape instead of
dying for the codex cohort. Migrated pre-existing codex rows have `tool`
absent; icon and gating predicates must tolerate that cohort.

**E. `readConfig()` is deleted, not left nullable (step 8).** All ~19 call
sites move to `readRunRecord()` in the same change so the typechecker
enumerates them; a new-format bash record must never reach a reader that
warn-and-nulls it into `incomplete`/"Execution not found". The read union
stays permanently tolerant of `AgentConfig`-shaped non-agent rows (old
binaries can rewrite them). `getAvailablePaths` becomes an explicit
identity-keyed table with no `default` fallthrough. A workflow-script
relaunch re-registers over the stamped meta — fixture asserts the overwrite
yields `{kind:'workflowScript'}`, not a merge.

**F. The birth preamble is a callback, and the lease error is sacred
(step 6).** The in-band path invokes the shared preamble **after** its
attempt-ledger reservation (`inspectStableAttempt` treats keys-without-marker
as a hard reconciliation error, `inBandSubagentExecution.ts:222-227`); the
preamble rethrows `ExecutionLeaseActiveError` untouched from all four
callers (the double-launch guard at `WorkflowScriptTool.ts:381` is an
`instanceof` check; the agent-CLI path's bare `catch` must not be the
template). Crash-window fixtures at reserve↛register and register↛launched.

**G. NDJSON is frozen; project at the boundary (steps 3, 8, 10, 11).**
`setActiveStream.agentCategory` stays on the NDJSON payload as a
projection-local field; `agentConfigToTaskState` gains an explicit non-agent
arm (today it **throws** on an unknown category, on the event path);
`history-entry.status` keeps the `ExecutionStatus` vocabulary via
`runOutcomeToExecutionStatus` at that one boundary; stream-id format changes
apply to new runs only. The byte-parity test lands **before** the deletions.

**H. Provisional kinds are forbidden (steps 2, 3).** The `StreamState`
kind-flip reset is lossy (it drops the user's typed follow-up text, todos,
plan, `runUsage`, output files — `streamStateMerge.ts:39-46` preserves only
`taskGroups`). Identity must be known before the first `createStreamState`:
live paths have it at birth (`run.start`), rehydration reads it from the
store, and the CLI populates `StreamSlice.identity` on cold read from the
store FK before the prefix regex is deleted (a rehydrated terminal child
stream never re-emits `run.start` — red-team S6). Fixture: focus a terminal
child stream in a fresh process; assert no kind flip in normal flows.

**I. `setRunConfig` without `run.start` (step 5).** The live synthesis path
in `setRunConfig` (`StreamSnapshotStore.ts:1538-1552`) is specified, not
silently deleted: a run that never emitted `run.start` leaves `identity`
absent (renders pending, per "absent ≠ Workflow") and the
description-reset-on-execution-change behavior is preserved explicitly.

**J. Acceptance gates rewritten.** `terminalStatus` gate: zero hits outside
the export projection (`traceDocumentSchema.ts:24` stays a required nullable
trace field), the NDJSON boundary projection, the stamper, and
`resumability.ts`'s unmappable-legacy escape. `legacyExecutionIdentity`
gate: the forward per-read resolver is deleted; the ~30-line
`legacyExecutionIdFromStreamSuffix` **survives as the deletion-admission
boundary** (`SessionStores.ts:286-293,351,360`) — deleting it would orphan
`executions/` directories of pre-descriptor streams forever. `streamIdSource`
survives as stamp provenance. The step-14 grep excludes `agentPresets.ts`'s
migration.

## Part III — one language across hosts (steps 16–18)

**Findings.** Extension and desktop already speak one language (the shared
`ProgressBackend` → Lit stack). The CLI is a full parallel dialect:

- **Four hub subscribers, four dispatch tables** (`ProgressBackend.ts:433`,
  `subscribeRuntimeHost.ts:299-304`, `runProgressRenderer.ts:159`,
  `sessionProgressSubscription.ts:196`), each an `as`-narrowed table with an
  `assertNever` tail — and the round/phase stage `index`/`total` guard is
  cloned **byte-for-byte in all four**.
- **Two state engines with ~20 paired fields** under different names/shapes
  (`outputFilesByRound` ↔ `files`; one discriminated `stage` slot ↔ two
  fields; nested `bypass` ↔ three flat booleans; category stored in three
  places on the Lit side). The child-roster tombstone cap is even a
  value-copy with a comment admitting it mirrors the other engine's constant
  "as a value, not an import" (`childExecutions.ts:74`).
- **The sharing asymmetry proves the thesis**: display formatters
  (`streamStatusDisplay`, `formatWorkflowCallLine`, `taskGroupProjection`,
  `normalizeToolUseData`) are already consumed by all three hosts; every
  _derivation_ module (`childActivityReducer`, `streamMetadata`,
  `buildStreamTabInfo`, `streamOrdering`) is shared only inside the Lit
  stack — the CLI re-derives status mirrors, roster reconciliation, parent
  topology, tombstoning, artifact merges, phase grouping, transcript role
  classification, labels, and an `subagentExecutionLabels` map that exists
  under the same name with independent implementations on both sides.
- **The command layer diverges behaviorally, eleven ways**: two
  history-status projections over different source fields; a CLI-only
  second resumability gate; the workspace-file fallback on one side only;
  `runtimeCategory` honored on one side only; a second CLI resume entry
  (`resolveCliResume`, `sessionResume.ts:34-58`) bypassing
  `resolveAndResumeStream` with its own five-way outcome vocabulary;
  workflow resume supported by ext/desktop but rejected by the CLI; CLI
  stream-id re-derivation vs snapshot read; launcher validation ordering;
  the chat-defaults history tier re-implementing a filtered listing;
  `AgentRosterForm.tsx:21-25` bypassing `AgentRosterController.allPresets()`
  (custom presets visible in settings, invisible in the TUI — a live lead
  for the separated roster bug); and the CLI not calling
  `selectAutoOpenFinalOutput`.
- **Fact-coverage deltas are silent UX divergence**: `followUpSent` (Lit
  no-op, TUI refresh), `goalPaused` (Lit no-op, TUI transcript row),
  `goalStateChanged` and `inquiryThreadUpdated` (Lit handled, TUI ignored).

**Ruling.** One host-neutral **session view-model** — the Lit backend's
fact-applier/state store generalized into `src/controllers/session/` — is
the single consumer of the hub and the single owner of derived session
state (streams, roster, parent topology, artifacts, usage, todos/plan,
status, one discriminated `stage` slot). Hosts are renderers over it:
the `WebviewUpdater` projects it over postMessage exactly as today; the Ink
TUI reads it through a signals adapter; the headless renderer and the
frozen NDJSON vocabulary are boundary projections of the same store. No
projection layers between hosts and the model — the model's types _are_
the language, `StreamTabInfo.identity`-style, per Part I.

**Step 16 — one view-model, one subscription.** Generalize
`ProgressViewState` + `ProgressFactApplier` into the session view-model
(no `vscode`, no postMessage — they already comply); adopt the canonical
field shapes (single `stage` slot from the CLI; three-kind info and
per-round maps as named in Part I). The TUI consumes it.
_Delete:_ the CLI's parallel derivations — `setStreamStatusInCliState`
mirror, `applySubagentRoster` + `ParentProvenance` reconciliation +
tombstone value-copy, `mergeArtifactSnapshot` + revision guard (the store
is the accumulator per Axis U), the full-rebuild task-group driver, the
duplicate `subagentExecutionLabels`, the duplicated phase grouping, three
of the four dispatch tables and all four stage-guard clones.
_Keep (host-genuine):_ Ink layout, keyboard/interaction policy,
`<Static>` settlement ordering, terminal capabilities, ANSI repaint, VS
Code placement/theme, postMessage batching.
_Tests:_ TUI snapshots unchanged; headless byte-parity (frozen NDJSON);
the fact-coverage delta table reconciled deliberately — each of
`followUpSent`/`goalPaused`/`goalStateChanged`/`inquiryThreadUpdated` gets
one decided behavior, same on every host.
_Gate:_ `rg -c 'TUI_RUN_FACT_HANDLERS|applySubagentRoster|mergeArtifactSnapshot' packages/cli/` → 0.

**Step 17 — one command layer.** One history service (listing, details,
status via the one shared projection from step 11, delete + goal cleanup,
export-outcome mapping) with host ports only for surface verbs (toast vs
stdout vs renderer); `resolveCliResume` deleted — `texra resume` funnels
through `resolveAndResumeStream`, which gives the CLI workflow resume for
free; launcher validation unified in `executionRequests` (input-file rule
and toolConfig normalization included); `AgentRosterForm` consumes
`AgentRosterController.allPresets()`; the chat-defaults history tier reads
the shared listing; the CLI adopts `selectAutoOpenFinalOutput`.
_Gate:_ `rg -c 'resolveCliResume|resolveCliHistoryStatus|userStartedCliHistoryEntries' packages/cli/` → 0.

**Step 18 — Part III gate sweep.** Ratchets shrink; no new `@agent/*`
specifiers; the NDJSON byte-parity suite passes against the unified stack.

## Remaining work — handoff (2026-08-04, updated after #9716)

What is done, what is left, and the load-bearing facts a fresh session
needs. Step 16's canonical field shapes, the session view-model + TUI
renderer port, and the step-18 gate sweep are landed; only #6981 remains
from this handoff.

**Landed (do not redo):**

- `StreamStageSchema` / `StreamStage` in `src/shared/schemas/streamState.ts`
  is the discriminated slot's SSOT; `src/shared/streams/stage.ts` holds the
  `stage.start` normalizers (`streamStageFromStageStart`,
  `roundStageFromStageStart`; the phase helper is module-private). All four
  stage-guard clones are gone.
- The Lit stack carries `stage` end-to-end (state, wire `UPDATE_STAGE`,
  `StreamMetadata`, `SYNC_STREAM_CONTENT` active state, frontend). Delivery
  policy: phase → per-stream metadata patch (parent viewports read a child's
  phase), round → targeted message to the active stream only.
- The CLI TUI already holds the canonical slot (`StreamSlice.stage`), and
  the frozen public NDJSON vocabulary keeps `updateRoundStage` /
  `UpdateRoundStagePayload` — never migrate that wire.
- **Step 16 remainder (#9716):** `src/controllers/session/` owns
  `SessionState` + `SessionFactApplier` + `SessionRendererPort`; Lit via
  `LitSessionRenderer`; TUI via `attachSessionSignalsAdapter`. Deleted
  `ProgressViewState` / `ProgressFactApplier` /
  `subscribeRuntimeHost` / `TUI_RUN_FACT_HANDLERS`. Gate
  `TUI_RUN_FACT_HANDLERS|applySubagentRoster|mergeArtifactSnapshot` → 0 in
  `packages/cli/`. Fact coverage: `followUpSent` refreshes the queue;
  `goalPaused` notifies (TUI transcript); `goalStateChanged` /
  `inquiryThreadUpdated` notify (TUI chrome-thin OK). Attachment vs focus
  are separate; host registration is applier-local
  (`registeredWithRenderer`), not `streamLogs.has`. `StreamTabInfo.inputFile`
  removed from the wire.
- **Step 18 (#9716):** host-agent mock/import, shared-schemas-deep-import,
  and architecture-edges baselines shrunk; dead-code ratchet ≤ 18.

**Intentional residuals (boundary projections — do not fold into the store):**

- Headless `runProgressRenderer` / `sessionProgressSubscription` (NDJSON).
- `setStreamStatusInCliState` + `subscribeStreamStatus` (TUI skips `status`
  session facts so eviction does not key off `SessionState.activeStream`).
- `projectChildRoster` (+ `ParentProvenance` / tombstones in
  `childExecutions.ts`) and `subagentExecutionLabels` — CLI topology
  projection fed from roster badges, not a second fact engine.

**Open C — `taskRuns` legacy directory probe.** Tracked in #6981 with its
own dated retention policy; independent of the session view-model work.

## Build order — holistic

Ordering criterion, applied adversarially to every phase: _is anything
built here that a later phase deletes?_ The answer must be no. The two
violations found in the step numbering and removed: (a) `StreamSlice.identity`
and the CLI reconstruction-by-reconstruction recut (old step 3) — deleted
by the view-model adoption; the TUI never touches an upgraded `StreamSlice`,
it moves straight onto the shared model; (b) the Lit wire-shape recut as a
separate act (old step 2) — it is the view-model's projection, built once.

**Phase 0 — schemas and stampers (pure additions, fixture-tested against
old-format buckets before anything consumes them).** `RunIdentitySchema`,
`ByCategory<T>`, `RunRecord` union, `RegisteredExecutionMetaSchema` (write
boundary), the trace-boundary schema split; the idempotent entrance stamper
(identity + outcome + streamId in one pass, lease-aware, no marker) and the
two roster/preset entrance migrations. Nothing else changes; every fixture
from the red-team passes runs here (old trace parses, old bucket stamps,
ambiguous streamId stays unstamped, config-less row stays incomplete).

**Phase 1 — runtime authorities.** Launch sites speak identity
(`childStream.run`, six `registerExecution` sites); `handle` carries
identity + launch-time in-memory category; `settleRun` with in-machine
resolution; outcome-only terminal writes; delete `normalizeWriterCategory`,
`meta.category` writes, the descriptor concept's writers. (Old steps 1, 4,
10 core.)

**Phase 2 — storage reads.** `readRunRecord()` replaces `readConfig()` at
all ~19 sites; `executionListing` keyed on identity; **resume goes FK-first**
(`registeredStreamId(meta) ?? legacy formula`) — a hard precondition for
the id-format change; the forward legacy resolver dies, the ~30-line suffix
helper survives as deletion admission; opaque mint format for new ids.
(Old steps 5, 12.)

**Phase 3 — orchestration lineage.** Handle predicates (`isChildExecution`,
`isOwnedBy`) as the only spellings; birth preamble as post-reservation
callback rethrowing `ExecutionLeaseActiveError`; one parent wire copy; flat
roster rows carrying identity; agent-CLI registries read the handle.
(Old step 6.)

**Phase 4 — the session view-model.** Generalize `ProgressViewState` +
`ProgressFactApplier` into `src/controllers/session/` with the final
canonical shapes (identity verbatim, single `stage` slot, per-round maps,
flat roster). One hub subscription. This is built **before** any UI is
touched, so both stacks land directly on it. (Old steps 13-store, 16 core.)

**Phase 5 — hosts as renderers.** Lit: `WebviewUpdater` projects the
view-model (desktop free); resume/rerun gates on `identity.kind` (defect 3).
TUI: signals adapter over the view-model; the parallel engine deleted in
one motion (`StreamSlice`, `subscribeRuntimeHost` tables, `childExecutions`,
artifact merge, stage-guard clones); transcript layout and settlement stay
TUI-local over the shared projections. Headless renderer + NDJSON as
boundary projections with byte-parity asserted. Fact-coverage deltas get
their decided behaviors here. (Old steps 2, 3, 11-display, 13-UI, 16.)

**Phase 6 — one command layer.** History service (with the one status
projection), one resume funnel (delete `resolveCliResume`; CLI gains
workflow resume), unified launcher validation, roster form on the
controller, defaults on the shared listing, `selectAutoOpenFinalOutput`
everywhere. (Old steps 11, 17.)

**Phase 7 — gating, records, sweep.** Per-tool roster declaration replaces
`DELEGATION_AVAILABILITY_CATEGORY`; honest `RunRecord` writes at the four
fabrication sites; `getAvailablePaths` table; silent defaults; `ByCategory`
recut of the 39 pairs; ratchets, full grep battery, both typechecks,
headless parity. (Old steps 7, 8, 9, 14, 15, 18.)

Dependency spine: 0 → 1 → 2 → {3, 4} → 5 → 6 → 7. Phases 3 and 4 are
independent of each other. Review still proceeds phase-by-phase inside the
single change; nothing merges separately.

## Open problems

Genuinely undecided or deferred items, so they are decided deliberately
rather than discovered during implementation:

1. **Wait/report predicate target.** Chosen: `identity.kind === 'agent' &&
handle.category === 'toolUse'` from launch-time config. The red-team's
   alternative — an explicit `deliversResultPerTurn` flag set by the
   launchers, naming the actual fact — is arguably cleaner; decide at
   phase 1 review.
2. **NDJSON non-agent `setTaskState` shape.** `agentConfigToTaskState`
   needs an explicit non-agent arm that projects without inventing deleted
   fields (today's default arm throws). Exact field set is fixed by the
   byte-parity suite, decided at phase 5.
3. **Fact-coverage deltas.** One decision each, applied to all hosts:
   `followUpSent` (refresh or no-op), `goalPaused` (transcript row or
   not), `goalStateChanged` and `inquiryThreadUpdated` in the TUI.
4. **Old-host display degradation is accepted, not mitigated.** New rows
   (outcome-only, no `terminalStatus`) show blank terminal status in
   not-yet-updated binaries. The red-team's dual-write-for-one-release
   option is **rejected** as a compatibility layer; the degradation is
   cosmetic, bounded by update lag, and heals on update.
5. **Migrated codex/claude rows lack `identity.tool`.** Icon and gating
   predicates must tolerate the cohort; no healing possible (the fact was
   never persisted).
6. **The workflow-roster empty mechanism** (separated track) — now with a
   concrete lead: `AgentRosterForm` bypasses
   `AgentRosterController.allPresets()`, so custom presets are invisible
   to the TUI. Phase 6 fixes the bypass; whether it is the whole
   mechanism still requires the deterministic repro before any
   nullability change.
7. **Disk-scale numbers.** Still unmeasured; the stamper's dry-run count
   is the measurement, logged before its first write.
8. **`EXECUTION_META_SCHEMA_VERSION` stays 1.** Optional-field additions
   are non-breaking under `z.object`; a bump would itself warn-and-null
   old rows (red-team S11). Confirmed: no bump.

## Separated work

**The workflow-roster failure stays out.** The symptom (empty workflow roster
on `software-engineer` / `lean-project`) is established; the mechanism is not.
Sequence on its own track: reproduce deterministically, distinguishing roster
resolution (`AgentRosterController`, `texra.agentRosterSelection`) from the
admission gate (`WorkflowScriptTool.ts:287`); fix at the implicated boundary;
only then revisit nullability. The checkpoint-salt hazard stands regardless:
`deriveWorkflowScriptCheckpointId` feeds `deriveExecutionId`, hence the
executions directory, stream id, journal key, and lease — altering the salt
re-roots every checkpoint and defeats the double-launch guard
(`WorkflowScriptTool.ts:378-393`).

## Risks and open questions

- **The migration is the one irreversible step.** Mitigations: idempotent
  (re-runnable), atomic per file, stamps only rows lacking `identity`, and the
  pre-stamp bytes remain valid v1 rows if interrupted. A dry-run count is
  logged before the first write.
- **`descriptorFromConfig` deletion moves hydration onto the FK.** Sidecars
  predating the FK field hydrate through the existing legacy stream-id
  resolution (`legacyExecutionIdentity.ts`) — breakable cohorts; agent-run
  sidecars carry descriptors whose `executionId` field _is_ the FK, so they
  hydrate unchanged.
- **The birth-preamble unification (step 6) must not touch loop semantics.**
  The in-band path's durability ledger (`stableSubagentAttempt.ts`) and the
  async path's follow-up queue are contracts, not duplication; only the
  register/stream-id/strategy-params preamble is shared.
- **`RunRecord` union and external consumers.** The NDJSON `setTaskState`
  projection of `run.config` (`sessionProgressSubscription.ts:86-94`) is an
  external contract; the non-agent arm must project without inventing the
  deleted fields. Checked in the parity test.
- **Deleting `normalizeWriterCategory` rests on one traced consumer**
  (`chatDefaults.loadHistoryDefaults`). Grep for other readers of
  `config.agentCategory` on non-agent executions before landing; keep the
  parentless-row fixture.
- **Disk-scale numbers remain unmeasured** (rev 1's 142-of-478). The
  migration's dry-run count supplies the real figure before anything depends
  on it.
- **Part II: the terminal-outcome migration changes semantics for unmappable
  legacy strings** (stamped `failed`; today they are non-resumable via the
  `TERMINAL_STATUS` cause — same user-visible result, asserted by fixture).
- **Part II: retiring `legacyExecutionIdentity` fixes resolution at migration
  time.** A row the resolver would have resolved differently _later_ (new
  sidecars appearing) loses that chance; accepted — post-birth-registration
  rows never need it, and the ambiguous cohort's behavior is unchanged.
- **Part II: the CLI's artifact merge deletion assumes the store is loaded in
  TUI mode.** Headless NDJSON keeps delta events as the external contract;
  parity is asserted per the `texra-cli` skill before the merge machinery is
  removed.
- **Part II: the roster memento migration is the second entrance migration**
  (after the executions store). Same rules: idempotent, one-shot, quarantined.
