# HS: harness store, shared contracts, SDK and entries (area audit)

Read on `main` at `d70ad92` (the working tree at `93906b9`, which adds only
the brief). Scope: `packages/harness/src/shared/`, `effect/`,
`agent/storage/`, `agent/index/`, `agent/memory/`, `agent/workspaceAgents/`,
`transcript/`, `controllers/`, and the entry files at the package root.

## Numbers

| Directory                                                                                        |      Lines |
| ------------------------------------------------------------------------------------------------ | ---------: |
| `shared/` (all)                                                                                  |     17,542 |
| - `shared/session/`                                                                              |      6,838 |
| - `shared/schemas/`                                                                              |      5,609 |
| - `shared/transcript/`                                                                           |      2,277 |
| - `shared/*.ts` (root files)                                                                     |      1,036 |
| - `shared/state/`                                                                                |        812 |
| - `shared/config/`                                                                               |        386 |
| - `shared/tools/`                                                                                |        310 |
| - `shared/runs/`                                                                                 |        216 |
| - `shared/model/`, `shared/utils/`                                                               |         58 |
| `controllers/session/`                                                                           |      6,161 |
| `effect/`                                                                                        |      1,631 |
| `agent/index/`                                                                                   |      1,546 |
| entry files (`index.ts`, `node.ts`, `plugins.ts`, `schemas.ts`, `host.ts`, `transcriptEntry.ts`) |      1,313 |
| `agent/storage/`                                                                                 |      1,178 |
| `agent/workspaceAgents/`                                                                         |        574 |
| `transcript/`                                                                                    |        331 |
| `agent/memory/`                                                                                  |        219 |
| **Total**                                                                                        | **30,495** |

Five largest files: `shared/session/sessionViewUpdate.ts` (1,078),
`controllers/session/databaseLayer.ts` (840),
`shared/state/stateSettings.ts` (645),
`shared/transcript/toolRowSections.ts` (584),
`shared/schemas/sessionEvent.ts` (528).

## HS-1: The trace export's result has three owners, a legacy vocabulary and two false comments

- flags: information leakage, repetition, comment restates code, vague name
- package: harness (touches texra `controllers/server/protocol.ts`,
  `agent/export/standaloneTraceHtml.ts`,
  `controllers/progressView/ChatExportController.ts`; cli
  `commands/history.ts`)
- kind: refactor (with two false comments)
- size: S
- earlier: none (grep of `streamLogs_missing`, `traceAssembler`,
  `TraceDocumentSchema` in `.agents/docs/evidence/` and `proposed/` finds no
  finding on this shape)
- open PR: none (#14953, which touched `protocol.ts`, is merged at `d70ad92`)

**Evidence.**

- The result is a status union typed in the harness,
  `packages/harness/src/transcript/traceAssembler.ts:64-70`
  (`'ok' | 'config_missing' | 'streamLogs_missing'`). The wire restates it as
  a schema, `packages/texra/src/controllers/server/protocol.ts:196-210`,
  including a hand copy of `TraceDocumentSchema`
  (`trace: Schema.Struct({ runId: RunIdSchema, events: Schema.Array(DisplayRowSchema) })`,
  with the comment "A `TraceDocument`"), although
  `packages/harness/src/transcript/traceDocumentSchema.ts:23-26` exports that
  schema through `./schemas` (`packages/harness/src/schemas.ts:196`). The two
  literals are spelled a third time by the app's tagged error,
  `packages/texra/src/agent/export/standaloneTraceHtml.ts:24-27`
  (`TraceUnavailable { status: Schema.Literals(['config_missing', 'streamLogs_missing']) }`),
  and switched on by `packages/cli/src/commands/history.ts:131-134` and
  `packages/texra/src/controllers/progressView/ChatExportController.ts:75-77`.
- The literals name stores that no longer exist. `config_missing` is
  returned when `readRunRecord()` finds no `run.config` row
  (`traceAssembler.ts:81-84`), a `RunRecord`, not a config;
  `streamLogs_missing` is returned when the run's aggregate holds no display
  row (`traceAssembler.ts:89-90`): there are no stream logs in a SQLite
  store. The CLI's message for it still describes the old layout ("only its
  child runs' transcripts remain", `history.ts:136-137`).
- Two false comments. `traceAssembler.ts:5-8` says "Three facts are
  authored ... no parent, no checkpoint and no follow-up support";
  `traceDocumentSchema.ts:19-21` says "four facts ... no owner, no parent,
  no checkpoint and no follow-ups taken". The code authors two
  (`traceAssembler.ts:97-98`: `parent: null, takesFollowUps: false`);
  `run.start` has carried no owner or checkpoint field since #14896
  (`packages/harness/src/shared/schemas/sessionEvent.ts:188-200`).

**The design decision behind it.** "What does a run's trace export answer,
and how does it say it has none?" is decided in the harness as a TS type, in
the app's service protocol as a schema copied from it, and in the app's
export module as an error class copied again.

**The better design.** The harness owns the answer once, as a schema beside
`TraceDocumentSchema` in `transcript/traceDocumentSchema.ts`: an
`AssembleTraceResultSchema` whose `ok` branch embeds `TraceDocumentSchema`
and whose miss literals say what is missing (`no_record`, `no_rows`).
`AssembleTraceResult` becomes its `.Type`; `RUN_RECORDS.readTrace` in
`protocol.ts` is that schema (deleting its 15-line copy);
`TraceUnavailable.status` takes `AssembleTraceResultSchema`'s literal subset
(`Lit.pick`) instead of restating it. The two header comments are cut to
what the code does: the creation row loses its parent and follow-up support,
a decision loses its content.

**What we give up, and risk.** The literal rename is a wire change between
a window and the background service of different builds; both ship together
and 1.0 keeps no compatibility. Nothing persists these literals.

**How I tried to refute it.** Checked whether `protocol.ts` could import
`TraceDocumentSchema`: it already imports from `@texra-ai/harness/schemas`,
which exports it. Checked that `run.start` has no `checkpoint`/owner field
(`sessionEvent.ts:188-200`) and that no reader of the export depends on the
literal spelling beyond the three switch sites (grep over `packages/*/src`,
`src/`, `packages/*/test`: five hits, all listed).

## HS-2: The public `Session` carries a read nobody makes and an open option every production caller passes as `{}`

- flags: overexposure, comment restates code, vague name
- package: harness (touches texra `controllers/server/protocol.ts`,
  `controllers/session/openProjectSession.ts`; tests that pass `host: {}`)
- kind: refactor
- size: S
- earlier: (b) is the remainder of round 3's Q note
  (`../2026-11-07-design-red-flags-round-3/Q-public-surface.md:677-685`,
  repeated in `../2026-11-07-design-red-flags-lenses/interface-comments.md:514`),
  which put `OpenOptions.host` "in the same PR" as R8's `Interactions`
  half (B7/E8, landed by #14802); that PR left it. (a) is the "smaller item"
  of `.agents/docs/proposed/architecture/2026-11-09-decisions-read-the-log-not-the-view.md:146-153`,
  not acted on.
- open PR: none

**Evidence.**

- (a) `RunRecords.readRejection` (`packages/harness/src/effect/sessionReads.ts:78`,
  built at `:229`) has no reader: grep of `readRejection` over
  `packages/*/src`, `src/`, `packages/*/test`, `packages/harness/example`
  finds only its declaration, its builder, its wire schema
  (`packages/texra/src/controllers/server/protocol.ts:191`), the API report
  and the README. Every caller that needs the answer calls
  `checkpointRefusal` directly (`agent/runtime/resumeRun.ts:243`,
  `agent/runtime/leftoverChildren.ts:77`,
  `agent/followUp/ToolUseFollowUp.ts:208`). Its doc in
  `agent/storage/resumability.ts:75-80` says "a host's run record" asks it:
  none does. The README calls it "the same value" `ResumeRefused.reason`
  carries (`packages/harness/README.md:142`), but it can never give
  `blocked` or `notResumable`, which a resume raises after the checkpoint
  check (`sessionReads.ts:76-77` says so itself).
- (b) `OpenOptions.host?: Record<string, never>`
  (`packages/harness/src/effect/sessions.ts:74-89`) is a boolean spelled as an
  empty object: its one reader is `host === undefined`
  (`effect/sessionPrograms.ts:291-293`). The one production open passes it
  constant (`packages/texra/src/controllers/session/openProjectSession.ts:75`,
  `{ persistent: true, host: {} }`, which `openLocalSession` serves to every
  host, `cli/src/runtime/platform/cliService.ts:177`,
  `cli/src/runtime/platform/initPlatform.ts:197`); 19 test sites write
  `host: {}`. The name says "a host" while the fact it carries is "a person
  answers from the view while no host is attached"; the attached host states
  the same fact again, inverted, as `approvalPromptsUnavailable`
  (`effect/requestAnswerer.ts:224-230`,
  `cli/src/runtime/headless/approvalAdapter.ts:200`), so the CLI's headless
  run opens saying a person answers and attaches saying none can.

**The design decision behind it.** (a) "May this run continue?" is a
harness decision with one owner (`checkpointRefusal`); the SDK re-exposed
it as a record read for a host reader that never came. (b) "Who answers a
request while nothing is attached" is asked at open with a placeholder type.

**The better design.** (a) Delete `RunRecords.readRejection`, its builder
line, its `RUN_RECORDS` entry (the service and client derive from that
table, so nothing else changes) and the README clause; fix the
`checkpointRefusal` doc. (b) Make the option say its fact as a boolean with
the attach side's polarity, `OpenOptions.approvalPromptsUnavailable`
(default `true`, as now), so one name means one thing on both sides and the
production open writes `approvalPromptsUnavailable: false`. Deleted:
`Record<string, never>` and the `host === undefined` spread.

**What we give up, and risk.** (a) is an SDK surface removal at 0.x with no
consumer. (b) renames an option every test open passes; mechanical.

**How I tried to refute it.** For (a), checked the service's table-driven
`records.*` procedures (`service.ts:238-246`, `serviceSession.ts:560-568`):
no window calls `records.readRejection`. For (b), checked whether any
production open omits `host` (none: `sessions.open` has one production
caller) and whether `persistent` could carry it instead (no: the SDK
examples open persistent sessions with no person present,
`packages/harness/example/acceptance.ts:191`).

## HS-3: The approval policy names seven denial reasons that nothing branches on, each mapped back to its message by its own function

- flags: special-general mixed, shallow module, repetition, overexposure
- package: harness (`shared/approvalPolicy.ts`; its one reader
  `agent/runtime/requests.ts`, HR's area; the test
  `packages/harness/test/shared/ApprovalPolicy.vitest.ts`)
- kind: refactor
- size: S
- earlier: none (the only mention of these symbols in
  `.agents/docs/` is round 3's export list, Q-public-surface.md:72, 650, for
  `approvalPolicyDenialMessage` as an entry export; it has since left
  `./schemas`, `packages/harness/src/schemas.ts:143-151`)
- open PR: none

**Evidence.** `packages/harness/src/shared/approvalPolicy.ts` has three
deciders, each with its own reason vocabulary and its own reason-to-message
function:

- `decideApproval` (`:63-71`) returns `'deny-policy' | 'deny-unpresentable'`
  (`ApprovalPolicyDecision`, `:42-46`); `isApprovalDenied` (`:48-52`) tests for
  them and `approvalPolicyDenialMessage` (`:54-60`) turns them into text.
- `decideRetryApproval` (`:87-101`) returns
  `{ deny: 'yolo-retry' | 'credential' | 'policy' | 'unpresentable' }`;
  `retryDenialMessage` (`:103-116`) switches them back to text.
- `decideHumanInputRequest` (`:126-133`) returns
  `{ deny: 'yolo-no-human' | 'policy' | 'unpresentable' }`;
  `humanInputDenialMessage` (`:135-146`) switches them back.

The one production reader (`packages/harness/src/agent/runtime/requests.ts`,
the only importer in `packages/*/src`) never branches on a reason: every
denial goes straight into its message function and out as
`{ action: 'deny', reason }` (`requests.ts:187-191, 234-241, 245-251`), and
the remaining uses ask only "denied or not" (`isApprovalDenied` at `:187`
and `:284`; `=== 'allow'` at `:128`). `requests.ts:189` hand-builds a reason
literal (`hook === 'ask' && !canPresent && 'deny-unpresentable'`) only to
feed it to the message function. The same three words "policy" and
"unpresentable" are spelled twice (`deny-policy`/`policy`,
`deny-unpresentable`/`unpresentable`) for the same message constants
(`:33-35`). The only other reader is the test that pins the literals
(`ApprovalPolicy.vitest.ts:11-44`).

**The design decision behind it.** "Why was this request denied?" is a
message to the person, not a kind a caller dispatches on; the module encodes
it as a kind and then decodes it back three times.

**The better design.** Each decider returns
`'allow' | 'present' | { readonly deny: string }` (the message), one type
for all three (`ApprovalAnswer`). `requests.ts` writes
`decision.deny` where it now calls a message function, and "denied" is
`typeof decision === 'object'`. Deleted: `isApprovalDenied`,
`approvalPolicyDenialMessage`, `retryDenialMessage`,
`humanInputDenialMessage` (4 functions, all single-reader),
`ApprovalPolicyDecision`'s two deny literals, `RetryApprovalDecision` and
`HumanInputDecision` (replaced by the one type), and the 7 literals. The
`requests.ts:189` special case becomes a `{ deny: UNPRESENTABLE }` value.
The test asserts the decisions against the message constants or is cut to
the `allow`/`present` table.

**What we give up, and risk.** None of the literals is persisted or on the
wire (the decision recorded is `{ action: 'deny', reason }`, a string). A
future caller that needs to branch on why would add the kind back then.

**How I tried to refute it.** Grepped every literal and function over
`packages/*/src`, `src/`, `packages/*/test`: no host, no CLI code, no
persisted schema reads them; checked `RequestDecision`'s deny shape is a free
`reason` string.

## HS-4: A compaction's result is written as a second row that one reader drops and another pairs back by position

- flags: conjoined methods, non-obvious code, information leakage
- package: harness (`shared/runs/compactionActivityProjection.ts`,
  `shared/schemas/contextManagement.ts`,
  `shared/transcript/projectTranscriptRow.ts`; the writer
  `agent/runtime/run/compaction.ts` and `agent/trace/traceLogs.ts` are HR's)
- kind: refactor (a stored payload shape changes: needs a `log` row version
  bump, so it goes under "Needs your eye")
- size: S
- earlier: none (`compactionActivityProjection` appears in
  `.agents/docs/evidence/` only in the lens names report,
  `../2026-11-07-design-red-flags-lenses/names.md:66,72`, for the word
  "settle")
- open PR: none (#14953, which touched `contextManagement.ts`, is merged)

**Evidence.**

- A client compaction that lands writes, in this order, a
  `CONTEXT_MANAGEMENT` log row with the figures it freed
  (`packages/harness/src/agent/runtime/run/compaction.ts:244-256`,
  `action: 'compaction', tokensBefore, tokensAfter, utilizationBefore,
  utilizationAfter, details`) and then the activity's terminal row
  (`:257`, `summary.activity.finish('completed')`, which writes a
  `CONTEXT_COMPACTION_ACTIVITY` row with `{ operationId, state }` only,
  `agent/trace/traceLogs.ts:104-128`).
- The transcript projection drops the first row
  (`packages/harness/src/shared/transcript/projectTranscriptRow.ts:276-280`:
  "a second row would repeat it") and the activity fold copies its figures
  onto "the latest running block" (`applyFreed`,
  `packages/harness/src/shared/runs/compactionActivityProjection.ts:77-103`),
  re-decoding the payload with its schema and returning nothing on a
  mismatch. The pairing holds only because `compaction.ts` writes the two
  rows back to back with nothing in between that could start another block:
  an ordering fact two packages-worth of files away from the reader.
- So `'compaction'` is a member of `ContextManagementAction`
  (`shared/schemas/contextManagement.ts:5-11, 31-36`) that no transcript row
  ever shows, and `CompactionActivityDataSchema` (`:55-65`) is a terminal
  state with no result: the result of one operation is split across two row
  kinds that cannot be understood apart.

**The design decision behind it.** "What did this compaction free?" is part
of the compaction's outcome, but it is written as a separate
context-management event because that logger existed, and the fold
reassembles the operation by row order.

**The better design.** The activity's `completed` row carries the figures:
`CompactionActivityDataSchema` becomes a union whose `completed` branch adds
`freed: { tokens, utilizationBefore, utilizationAfter }`, which
`activity.finish({ state: 'completed', freed })` writes (`land` already
computes every figure, `compaction.ts:238-253`). Deleted: `applyFreed` and
its `CONTEXT_MANAGEMENT` case in `applyCompactionActivityEvent`
(`compactionActivityProjection.ts:77-103, 125-126`), the `'compaction'`
member of `ContextManagementAction` and of `TokensFreedDataSchema`'s pick,
the suppression in `projectTranscriptRow.ts:278-280`, and the
`logContextManagementEvent` call in `land` (the activity row's text says
the same). The block reads `freed` from its own terminal row.

**What we give up, and risk.** The `log` row payload changes, so `log`'s
row version (`shared/schemas/rowVersions.ts:259`, now 10) is bumped and an
earlier build's compaction rows read as an earlier build's. The
interruption heuristics in the same module (`interruptRunningBlocks`, the
settlement boundary) are untouched.

**How I tried to refute it.** Checked whether any other reader shows the
`compaction` context-management row (grep of `'compaction'` over
`packages/*/src`: only the writer, the suppression and `applyFreed`), and
whether anything is logged between the two rows in `land` (nothing:
`compaction.ts:244-257` is straight-line code).

## HS-5: `SessionView`, `RunView` and `TranscriptView` each name two types, and the module that defines them aliases its own exports to tell them apart

- flags: vague name, information leakage
- package: harness (`shared/session/sessionView.ts`,
  `shared/session/readonlyViews.ts` and 14 harness importers)
- kind: refactor
- size: S
- earlier: lens NM10 (h)
  (`../2026-11-07-design-red-flags-lenses/names.md:733-740`), listed "open,
  no owner" in the catalogue (`catalogue.md:1540`); the code still shows it
- open PR: none

**Evidence.** `packages/harness/src/shared/session/sessionView.ts:43, 191,
333` export the decoded, mutable `TranscriptView`, `RunView` and
`SessionView`; `packages/harness/src/shared/session/readonlyViews.ts:11-22`
exports `ReadonlyDeep` types under the same three names, which
`./schemas` publishes and every app and host file reads. `sessionView.ts`
itself imports the read-only pair back as `RunView as ReadRunView,
SessionView as ReadSessionView` (`:40-41`) and uses the aliases in 14
signatures (`:202-429`): the defining module needs a second name to say
which one it means. In the harness, 14 files import the mutable names from
`@shared/session/sessionView` (for example
`agent/runtime/historyQuery/HistoryQuery.ts:51`,
`agent/runtime/delegation/agentChild.ts:37`,
`agent/runtime/leftoverChildren.ts:19`, `tools/ExecutionsTool.ts:36`,
`tools/executions/executionListing.ts:18`), most of which only read;
`effect/requestAnswerer.ts:37-40` and `controllers/session/readSessionView.ts:24`
import the read-only ones. Which one a file gets depends on which path it
typed.

**The design decision behind it.** "Which view type does a reader hold?"
has two answers under one name; the writer (`sessionViewUpdate.ts`) is the
only module that needs a mutable view, and it already builds one with
`Types.Mutable<SessionView>` (`sessionViewUpdate.ts:264`).

**The better design.** `sessionView.ts` exports the schemas and the
read-only names only (moving the three `ReadonlyDeep` aliases into it and
deleting `readonlyViews.ts`, 26 lines); the updater writes
`Types.Mutable<…>` where it builds a draft. Every importer then gets the
one `RunView`. Deleted: the three duplicate type exports, the two import
aliases, the file.

**What we give up, and risk.** Type-only; a reader that mutated a view
through the mutable name stops compiling, which is the point.

**How I tried to refute it.** Checked that the mutable types are not needed
by a schema decode site (`Schema.decode*` returns the schema's `.Type`
directly, not these names) and that no host imports the mutable names
(grep of `sessionView'` outside `packages/harness/src`: none).

## HS-6 (batched): Smaller instances of two representations, a flag pair, and speculative generality in the shared contracts

- flags: repetition, conjoined methods, overexposure, information leakage
- package: harness (one line each in texra and cli for (a))
- kind: refactor
- size: S (all four together)
- earlier: none for (a)–(d) (grep of `AgentEntry`, `registrationDrafts`,
  `ApprovalGrantSource`, `formatOutputText` in `.agents/docs/`)
- open PR: none

**Evidence and the better design, per item.**

- **(a) `AgentEntry.tools` restates `persona.tools`.**
  `packages/harness/src/agent/index/agentEntry.ts:33` keeps `tools?:
  string[]` "for display" beside `persona: Persona` (`:40`), whose `tools`
  carry the same names. Both writers derive one from the other:
  `agentYamlScanner.ts:337-342` (`persona.tools.map((tool) => tool.name)`,
  then `undefined` for none) and `pluginAgents.ts:103,108` (the same list
  written into both fields). Three readers
  (`packages/cli/src/runtime/agents.ts:134`,
  `packages/texra/src/controllers/settingsView/SettingsAgentCatalogController.ts:155`,
  `packages/texra/src/tools/documents/documentTask.ts:77`) read the copy.
  → Delete the field; the readers write `entry.persona.tools.map((t) => t.name)`
  (or a one-line `agentToolNames(entry)` beside `AgentEntry` if three call
  sites are worth one).
- **(b) `registrationDrafts(…, born, ended)` takes one fact as two
  parameters.** `packages/harness/src/shared/session/runFacts.ts:267-303`
  reads `ended` only when `born` is false (`:290-292`); its one caller passes
  both from one `prior` (`agent/storage/runLifecycle.ts:137-138`:
  `ended = prior ? … : []`, then `!prior, ended`). → One parameter,
  `prior: readonly SessionRowDraft[] | null` (the grants a re-registration
  ends; `null` for a birth), so the impossible "born with grants to end"
  cannot be passed.
- **(c) The approval-grant reads are generic over an id type with one
  instantiation, and restate their own literal set.** Eight exported
  functions and `ApprovalGrantSource<Id>` in
  `packages/harness/src/shared/approvalBypassKind.ts:86-231` are generic in
  `Id`; every caller passes `RunId`
  (`agent/runtime/runApprovalQueue.ts:58,102,131,164`,
  `agent/runtime/requests.ts:280-282`, `agent/runtime/rootLaunch.ts:122`,
  the CLI's `runBypasses` calls, `ui/progress/components/RunHeader.ts:325`).
  `OwnGrant` (`:20`) restates the schema's `['on', 'off', 'parent']`
  (`:47`) by hand, and `runBypasses` (`:182-191`) spells the three kinds
  instead of mapping `APPROVAL_BYPASS_KINDS`, so a fourth kind compiles there
  only because the record type forces it. → `RunId` in place of `Id`;
  `OwnGrant` as the schema's type; `runBypasses` as
  `Object.fromEntries(APPROVAL_BYPASS_KINDS.map(…))` typed by the record.
- **(d) Two copies of "serialize an untyped payload to YAML, falling back
  to `String`".** `packages/harness/src/shared/toolUse.ts:52-69`
  (`formatOutputText`) and
  `packages/harness/src/shared/transcript/transcriptText.ts:91-111`
  (`stringifyPayload`) each wrap `yaml.stringify` in the same `try/catch`
  with a near-identical comment; `toolUse.ts` adds only the empty-object
  rule. → `formatOutputText` keeps its empty-object guard and returns
  `stringifyPayload(content).text.full`.

**What we give up, and risk.** (a) touches one app and one CLI reader; the
rest is harness-internal and type-level.

**How I tried to refute them.** (a): checked that the plugin agent's
`persona.tools` and `entry.tools` are built from the same `tools` list
(`pluginAgents.ts:94-109`). (b): one caller (grep of `registrationDrafts`).
(c): grep of every exported function's callers; none passes a non-`RunId`
id. (d): `stringifyPayload` returns the same text for every non-string,
non-null value `formatOutputText` serializes.

## A thin area, said plainly

This area has had six rounds and two lens passes, and most of what they
found has landed: the session store (round 6 T), the SDK surface (round 3
Q), the session composition (R8), the settings model (round 3 P). The six
findings above are what survived a second read; the store's SQL layer,
the row codec, the session owners and the run-record reads produced
candidates that all died on verification (19, listed in brief below).

## Good modules in this area

- **`effect/sessions.ts`** (`Session`, `Run`, `LocalSession`). Each member
  says what it promises and how it fails, never how it works; the one
  exception is `OpenOptions.host` (HS-2).
- **`effect/requestAnswerer.ts`** (`followPendingRequests`, `attachHost`).
  One `FiberMap` keyed by request, a program per pending request that holds
  its decision until the view drops it: a small interface over the whole
  "answer once, re-ask if not recorded, withdraw when decided elsewhere"
  protocol.
- **`agent/storage/runOwnership.ts`** (`getRunRecords`, `runEndOf`). Every
  record read is a projection of committed rows; the activation-scoped end
  (`readRunEnd(after)`) is one parameter, not a second reader.
- **`controllers/session/storeAside.ts`**. The busy rule, the damaged rule
  and the aside naming are each one predicate with one owner.
- **`shared/approvalBypassKind.ts`'s `resolveBypass`/`ancestry`**. One walk
  of the grants that every surface and the enforcement read (apart from the
  generality in HS-6 c).

## Already settled, left alone

- **`AgentDirectoriesPort.teamMembers?` and `resourcesRoot?`**: kept by
  round 4 X S2 (`../2026-11-07-design-red-flags-round-4/X-compromises-today.md:237`,
  "the harness persists a team selection, and a host's bundle location is
  data"); the catalogue records M8 as landed with these kept
  (`catalogue.md:1260`). The pass-through of `teamMembers` through
  `AgentDirectoryService` → port → `CatalogState` → controller deps is still
  there; no new evidence.
- **`SettingRow.projectMayOptOut`** (one row sets it): kept by round 3 P
  (`../2026-11-07-design-red-flags-round-3/P-settings-model.md:753-754`).
- **`ProcessServicesOptions.toolAvailability`** (only the test kernel
  passes it): kept as the kernel's one seam by R5-12 (#14844) and the lens-2
  pass (`../2026-11-08-design-red-flags-lenses-2/README.md:321-323`).
- **The busy and read retry schedules** (`storeAside.ts:35-46`,
  `currentValues.ts:59-63`): R6-T7 b, held for the owner.
- **`LocalSession.view.events(from, drained?)`**: round 3 Q noted it
  (`Q-public-surface.md:686-688`); its one caller needs the coordinate to
  drain a pruned row (`packages/cli/src/runtime/headless/sessionProgressSubscription.ts:73-79`),
  so it is a contract, not a leak.
- **`RETIRED_ROW_KINDS`** (`shared/schemas/rowVersions.ts:57-93`): not a
  legacy reader but the storage format's rule for an earlier build's row
  (`packages/harness/AGENTS.md` "Storage format").
- **`WorkspaceAgentsController`'s selection kinds**: GS5 landed (#14818).

## Dropped on verification (19)

`teamMembers` pass-through (settled, above); `projectMayOptOut` (settled);
`toolAvailability?` (settled); `view.events` `drained` (justified);
`SessionRequests`' `Effect.die` on a follow-up error (media failures already
arrive as `Rejected`, `mediaInput.ts:224`); `TranscriptSubscriptions.write`
mutating outside the ref's permit (sequential, the union is read inside);
the `as A` casts in `Settings` (the catalog-override contract, settled with
P); `RETIRED_ROW_KINDS` (documented format rule); the name-keyed
`TOOL_DISPLAY_KIND` beside declared cards (it serves external agents' tool
names, which have no contract here); the harness's team vocabulary in
`WorkspaceAgentsController` (documented in `platform/interfaces.ts:97-101`);
`RunWorkspaceFilesSchema` re-decoding fold output (it normalizes, so it does
work); moving `AgentDirectoryService` to the app (`CUSTOM_AGENT_DIR_KEY` is
followed by the harness's catalog follower,
`tools/agentCatalogFollower.ts:54`); the retry schedules (held); service
tags under `shared/` (the layer order needs them below `agent/` and
`controllers/`); `agent/memory/` beside `tools/memory/` (two agent-side
readers, `agent/prompt/templateInputs.ts`,
`agent/runtime/delegation/inputFields.ts`); `readSessionView`'s `orDie`
(caught by `projectViews`' `catchCause`); the lifecycle draft builders in
`runFacts.ts` with one caller each (kept beside the readers of the same
facts on purpose; only HS-6 b's parameter pair survives); `listRuns`'
timestamp round trip (cosmetic); `Database` members with one or two readers
(a store port with one implementation, read by the session's own modules).
