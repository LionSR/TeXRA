# J. The UI kit and the shared contracts: design red flags

Area: `packages/texra/src/ui/` and `packages/texra/src/shared/`. Read-only, at
the working tree of 2026-11-06. Paths below are relative to
`packages/texra/src` unless they start with `packages/`. Consumer counts are
over `packages/*/src`. `shared/constants/latexToolchain.ts` (722 lines, 27%
comments) is area I's ("the toolchain constants") and is not read here.

Every "better design" names the one Effect primitive that is the thing; the
table at the end ("Effect-native mapping") was verified against
`node_modules/effect` 4.1.2 `.d.ts` after `corepack pnpm install` finished.
One correction that verification forced: `Schema.ReadonlyMap`'s _encoded_
form is still a `ReadonlyMap` (`Schema.d.ts:6959`); its JSON form is the
schema's `Iso`, entry arrays (`:6972`), reached through `Schema.toIso` /
`Schema.toCodecIso` (`:12719,12361`). Finding 4 is written against that.

## Numbers

Lines (`.ts`, 223 files, 34,236 lines): `ui/progress/components` 12,505;
`ui/progress` (root files) 2,709; `ui/styles` 2,379; `shared/settingsView`
1,957 (+ `handlers/` 135); `ui/wa` 1,783; `shared/session` 1,660; `ui/copy`
1,605; `ui/markdown` 1,383; `shared` (root files) 1,288; `ui/progress/styles`
946; `shared/constants` 946; `shared/plugins` 930; `ui/progress/formatters`
738 + `logFormatters` 585 + `toolFormatters` 360; `shared/commands` 518;
`shared/utils` 465; `ui/litControllers` 462; `shared/model` 291; `ui/monaco`
223; `shared/state` 160; `ui/highlighting` 100; `shared/launcher` 51;
`shared/tools` 31; `ui/formatting` 26.

Five largest: `shared/settingsView/settingsViewMessages.ts` 761,
`shared/constants/latexToolchain.ts` 722 (area I), `ui/styles/controlStyles.ts`
692, `ui/progress/components/SessionComposer.ts` 645,
`ui/progress/components/TaskGroupList.ts` 634 (then `RunHeader.ts` 620,
`shared/session/surface.ts` 620, `ui/progress/sessionSurfaces.ts` 619).

Comment share, worst files ≥ 200 lines (`^\s*(/\*|\*|//)` over total):
`shared/utils/dispatcher.ts` 44% (96/217), `ui/progress/formatters/htmlBuilders.ts`
31% (143/449), `shared/plugins/documentOutputs.ts` 28% (90/319),
`shared/constants/latexToolchain.ts` 27% (196/722, area I),
`ui/copy/modelAccess.ts` 26% (84/315), `ui/markdown/createMarkdownProcessor.ts`
26% (57/213), `shared/session/surfaceDecision.ts` 26% (55/206). Only the
first two are design signals (findings 6 and 8); the rest explain domain
rules, which is what comments are for.

Primitives: `Date.now()` 4 code sites (`ui/litControllers/TickerController.ts:18,46`
a clock; `shared/subscriptionUsagePresentation.ts:75` staleness; `shared/utils/pastedImageName.ts:7`
a file name minted in the renderer); `crypto.randomUUID` 2
(`ui/progress/sessionSurfaces.ts:140` request ids; `pastedImageName.ts:7`);
`new Promise` 2 (`ui/progress/components/TerminalOutput.ts:307`,
`shared/utils/clipboardImages.ts:59`); `.then(` 9, all `updateComplete.then`
for focus or scroll; `setTimeout`/`setInterval`/`requestAnimationFrame` 15;
`querySelector*` 14 (focus, measurement, and `RequestPanels`' card lookup);
`Deferred.makeUnsafe` 1 (`ui/progress/sessionTransport.ts:239`); a hand-rolled
debounce 1 (`shared/utils/flushableDebounce.ts`, 3 consumers); a generation
counter 1 (`sessionTransport.ts:69,323`, known by 8 files across the wire and
the hosts); module-level mutable singletons 4 (`ui/litControllers/TooltipController.ts:43-46`);
in-flight sets 3 (`Surface.sending`, `Surface.polishing`,
`ui/progress/components/RunTabs.ts:90` `deleting`); `new Set`/`new Map` 67,
mostly immutable-update copies in `surface.ts` and `sessionSurfaces.ts`.

Renderer compensation, as the brief asked: `Date.now()` and synthetic ids do
not stand in for the data model anywhere except `pastedImageName.ts` (finding
9); DOM existence checks are confined to focus management; the dedups that
matter are `FileList`'s round join and `RequestPanels`' retry key (finding 9).

---

## Finding 1. The webview transport is a hand-rolled RPC and subscription layer beside its own Effect runtime, and the surface layer drives it with Promises and in-flight Sets

**Red flags:** reinvented Effect primitives (a `Deferred` map, a timeout, a
generation counter, a "scope closed" check by identity); Promise orchestration
in app code; a state machine in Sets; a sentinel key.

**Evidence.**

- `installWebviewTransport` holds an Effect `ManagedRuntime`
  (`shared/session/webviewSessionLayer.ts:80-93`) and then re-implements
  request/response on top of `postMessage` by hand: a `pending:
  Map<requestId, Deferred>` per session (`ui/progress/sessionTransport.ts:109`),
  `Deferred.makeUnsafe` per request (`:239`), `Effect.timeoutOrElse` to turn a
  late host into a `Rejected` (`:246-257`), a scope finalizer that interrupts
  every pending Deferred (`:292`), and `Cause.hasInterruptsOnly` mapped to a
  `CANCELLED` sentinel result (`:125,263`), all surfaced as
  `runtime.runPromise` (`:260`). Request ids are minted by the renderer with
  `crypto.randomUUID()` (`sessionSurfaces.ts:140`).
- The subscription is a generation counter: `WebviewSession.generation` is a
  mutable field (`sessionTransport.ts:69`), incremented in `subscribe`
  (`:323`), carried on `Subscribe` and `EventsFrame`
  (`shared/session/sessionFrames.ts:59,74`), compared in `SessionFrames.feed`
  (`:251`), echoed by the host's framer (`controllers/session/SessionFramer.ts:110`),
  explained by the bridge ("the frames a dying fiber still cuts echo its
  generation and the decoder drops them", `controllers/session/SessionBridge.ts:251-253`)
  and re-implemented for the service path (`controllers/server/serviceSession.ts:302-325`).
  Eight files know what a generation is for one fact: "the frames of the
  subscription that is current".
- `sessionSurfaces.ts` wraps the transport in `async` functions
  (`hostRequestFor` `:353`, `runtimeRequestFor` `:402`) that `await` the
  Promise and then check `if (held.get(entry.key) !== entry) return;`
  (`:386,440`), a hand-rolled "the session closed while I waited", which a
  request forked into the session's scope would make impossible.
- "A request is in flight" is kept as Sets added to before the `await` and
  deleted from after it: `polishing` (`:365-369,387-391`), `sending` for the
  launcher (`:374-378,393-397`) and for a follow-up (`:410-414,459-463`),
  both declared on the shared record (`shared/session/surface.ts:182,185`)
  under "Never persisted", keyed by `RunId | 'launch'`, where `'launch'` is a
  pseudo-stream (`surface.ts:185`, `sessionSurfaces.ts:363,374,377,396`,
  `SessionComposer.ts:286,548,593`: 8 sites). The same fact has a third home
  for deletes: `RunTabs.deleting`, a component-private `Set<RunId>` pruned in
  `willUpdate` against the view and `surface.rejected`
  (`ui/progress/components/RunTabs.ts:90-101`).
- The transcript subscription re-derives "which transcript am I subscribed
  to" as a joined string compared on every change
  (`sessionSurfaces.ts:130,144-158,210-212`) and guards the first prune with a
  captured `beforeReplay` reference (`:187,207`).

**The design decision behind it.** The transport was designed as a decoder of
host messages into signals, so the Effect runtime it installs is used only to
run the view fold; every lifetime question (a request waiting, a subscription
superseded, a session closing mid-request) is answered again outside Effect,
and the surface record absorbs the in-flight state because the Promises have
nowhere else to put it.

**The better design.** Three primitives, each the thing:

- Request/response: `RpcClient.make(group)` over a `RpcClient.Protocol.make`
  whose `send` is `hostBridge.postMessage` and whose `run` installs the
  window `message` listener (`rpc/RpcClient.d.ts:140,230,190-193`). The
  request id, the pending table, the per-session cancellation and the
  decode of the answer are the protocol's; a request is
  `Effect<Outcome, RequestError>` and a timeout is `Effect.timeout`
  (`Effect.d.ts:8266`, fails with `TimeoutError`). `rpc` is `@stability
  unstable` in 4.1.2; the stable fallback that is still not hand-rolled is
  one `PubSub<DownMessage>` published by `receive` (`PubSub.d.ts:279,1074`)
  and a request as `Stream.fromPubSub(bus)` → `Stream.filter(isMyResponse)`
  → `Stream.runHead` (`Stream.d.ts:1050,5253,15903`), forked with
  `Effect.forkIn(sessionScope)` (`Effect.d.ts:17126`) so closing the scope
  is the `Cancelled` case.
- In flight: a `FiberMap<RunId | 'launch', …>` made in the session scope
  (`FiberMap.d.ts:115`); `FiberMap.run` drops the entry when the fiber ends
  (`:1016-1026`) and `FiberMap.has` is the busy read (`:792`). `sending`,
  `polishing` and `RunTabs.deleting` become `FiberMap.has(map, key)`; the
  add-before/delete-after pairs go. The composer reads it as a
  `SubscriptionRef<ReadonlySet<key>>` the map's `acquireRelease` maintains
  (`SubscriptionRef.d.ts:93,134`), projected to a signal by `toSignal`.
- The subscription: `Stream.switchMap` over `SubscriptionRef.changes(subscribe$)`
  (`Stream.d.ts:2505`: "interrupting the previous stream when a new element
  arrives"): the superseded generation is interrupted, so no frame needs a
  number to be dropped, and the wire's `generation` field goes once the
  host's framer is cut over (areas G and N). `transcriptTier`'s string
  compare becomes `Stream.changes` on the tier.

Deletes (counts over `packages/*/src`): `OpenSession.pending` and the
`Deferred` per request (1 map, 5 sites), `CANCELLED` (2), the `timeoutMs`
parameter on `request`/`answer` (2 declarations, passed by nobody in
`ui/`), `WebviewSession.generation` (3 sites) and, with the host side,
`Subscribe.generation`/`EventsFrame.generation`/`SessionFrames.begin` (8
files), `held.get(...) !== entry` (2), `Surface.sending`/`Surface.polishing`
(2 fields, 11 sites), `RunTabs.deleting` (5 sites), the `'launch'` key of the
in-flight sets (8 sites, the literal stays as the record `action.target`),
`subscribedTranscript`/`transcriptTier` (4 sites), `beforeReplay` (2).

**What we give up.** `answer()`'s Promise face for the desktop renderer
(`packages/desktop/src/renderer/main.ts:194`) becomes an Effect run at that
host's edge; the desktop is an Effect-run site already. A late host answer is
dropped either way. `rpc`'s instability: pin or take the PubSub form.

**Change amplification.** "A fourth in-flight kind" (say, a rename awaiting
its answer): today a `Surface` field, two add/delete sites in
`sessionSurfaces.ts`, one `.has` in the composer or tab, and a prune rule
(4 files, 6 edits); after: one key in the `FiberMap` (1 file).

**Depends on:** none to land in the webview alone; the generation's deletion
needs the host framer (R10's addendum, areas G/N) in the same PR.

---

## Finding 2. The response carries both request kinds' outcomes and an encoded error; the error is then decoded twice and said twice

**Red flags:** two representations of one fact; an error the shape could
refuse, handled by throwing.

**Evidence.**

- `Response.result.outcome` is `Schema.Union([OutcomeSchema, HostOutcomeSchema])`
  (`shared/session/sessionFrames.ts:123`): one response shape for both
  `runtime.request` and `host.request`. `answer()` therefore narrows by
  switching on five runtime outcome kinds and throwing "The host answered a
  host request with a runtime outcome" (`ui/progress/sessionTransport.ts:349-361`),
  and `settleHost` checks `outcome.kind !== 'files'` and the like per case
  (`ui/progress/sessionSurfaces.ts:260-345`).
- The error travels as `Schema.toEncoded(RequestErrorSchema)` (`sessionFrames.ts:131`)
  although `DownMessageSchema` is decoded once at `receive`
  (`sessionTransport.ts:189`); `refusal()` decodes the class a second time
  with `decodeUnknownSync` (`sessionSurfaces.ts:248`), and `answer()` reads
  `'reason' in result.error` on the encoded form (`sessionTransport.ts:365`).
- A runtime refusal is then written to two places: `Surface.requestError`
  (`sessionSurfaces.ts:255`, the global notice) and `Surface.rejected[runId]`
  (`:450`, the run's own controls). Readers: `requestError` 14 sites in 5
  files, `rejected` 6 sites in 4 files.

**The design decision behind it.** The wire was given one `Response` for two
request families so the transport could route by `requestId` alone; the
families' outcome types were then recovered by narrowing in every consumer.
The error class was kept encoded on the wire for a `postMessage` that strips
prototypes, but decoded at the wrong layer.

**The better design.** The primitive is the typed request: an `RpcGroup`
with one `Rpc` per request kind, each declaring its own `success` and
`error` schema (`rpc/Rpc.d.ts`), so `client.launch(...)` is
`Effect<HostOutcome, RequestError>` and no union needs narrowing; the
`RequestErrorSchema` class is decoded by the serialization layer
(`RpcSerialization.json`, `rpc/RpcSerialization.d.ts:120`). Without `rpc`:
two response kinds, `runtime.response` and `host.response`, and
`DownMessageSchema` carrying `RequestErrorSchema` itself so `result.error`
is the class after the one decode. `requestError` stays as the one notice;
`rejected` is a projection of it keyed by the run the request named.

Deletes: `answer()`'s five-case switch and its throw (12 lines), `refusal()`
(1 function, 2 callers), the second decode, `Surface.rejected` (1 field, 6
sites) or `requestError` (the owner chooses which spelling survives).

**What we give up.** Nothing user-visible.

**Change amplification.** "A new host outcome kind": today the union
(`sessionFrames.ts`), `answer()`'s switch, and each `settleHost` case that
must exclude it (3 files); after: the one `Rpc`'s success schema and the
case that consumes it (2 files).

**Depends on:** none; naturally lands with finding 1.

---

## Finding 3. "What the shell shows" is three nullable fields whose invariants every action re-establishes

**Red flags:** a state machine in optional fields; sentinel `null`; a derived
lookup (`editedProposal`) repeated.

**Evidence.**

- `Surface.selected: RunId | null` (`shared/session/surface.ts:170`),
  `pendingSelection: {runId, cursor} | null` (`:176`), `editing: ProposalRef | null`
  (`:194`). The legal combinations are four states: New task, a run, a run
  arriving (host-selected before the view holds it), and the launch form open
  on a proposal (which requires `selected === null`). Nothing names them.
- `applySurfaceAction` (`:514-612`) keeps the invariants by hand: `select`
  resets `pendingSelection`, `drawerOpen`, `editing` (`:526-533`); `selectNew`
  resets five fields (`:539-547`); `editProposal` sets `selected: null`,
  clears `pendingSelection`, sets `editing` and patches `launch` (`:549-557`).
  `pruneSurface` decides the arriving case and whether the edited proposal is
  still pending (`:349-392`, `editingGone` at `:377`). `editedProposal`
  re-finds the request in `view.requests` for every reader
  (`ui/progress/proposalEdit.ts:47-58`; 4 callers in `ProgressApp.ts`,
  `sessionSurfaces.ts`, `SessionComposer.ts`).
- Readers: `.selected` 12 sites in 6 files, `pendingSelection` 10 in 2,
  `.editing` 4 in 3.

**The design decision behind it.** "The shown thing" was modelled as a run id
with `null` for the empty state, and the two later states (arriving, editing
a proposal) were added as further nullable fields beside it rather than as
cases of the one thing.

**The better design.** The primitive is a `Schema.TaggedUnion` (AGENTS.md
"Effect Schema Patterns") held in the surface's one `SubscriptionRef<Surface>`:
`shown: Shown` with cases `New`, `Run {runId}`, `Arriving {runId, cursor}`,
`Proposal {runId, requestId}`; `applySurfaceAction`'s three cases each set
`shown` and nothing else (the drawer closes on any `shown` change in one
place). `pruneSurface` maps `Arriving` → `Run` or `New` and `Proposal` →
`Run` when the request is gone; `editedProposal` reads `shown._tag ===
'Proposal'`. Persisted form: `shown` encoded by the same schema, with
`Arriving` and `Proposal` mapped to `New` at encode.

Deletes: `pendingSelection` (10 sites), `editing` (4), `ProposalRef`, the
`editingGone` scan, the four-field resets in three cases.

**What we give up.** A proposal form can no longer coexist with a selected
run in the record (it cannot today either; `editProposal` nulls `selected`).

**Change amplification.** "A fifth shell state" (a settings pane in the
reading column, say): today a new nullable field, resets in 3 cases, a prune
rule, and every reader's null check (3 files, ~8 edits); after: one union
case and one `render` branch (2 files).

**Depends on:** none.

---

## Finding 4. Per-run surface state is five parallel maps with a hand-written codec, where `Schema.ReadonlyMap` and its `Iso` already do the work

**Red flags:** a reinvented Effect primitive; a mapped type substituting for
structure; comments substituting for design; two representations of one
record.

**Evidence.**

- `Surface` holds `drafts`, `rejected`, `expanded`, `groups`, `seen`, each a
  `ReadonlyMap<RunId, _>` (`shared/session/surface.ts:180,188,197,199,203`).
  `pruneSurface` retains each one separately (`:357-363`) and a mapped type
  `RunKeyedMapField` (`:319-324`) exists so that "a new one is a compile error
  here until it is pruned" (`:365-367`): the type system is recruited to
  enforce what one map would make structural.
- The persisted form is a second record, `PersistedSurfaceSchema` (`:220-245`),
  with maps spelled as entry arrays through a local `entries()` helper
  (`:212-216`), and the two are converted by hand in `loadSurface` (`:259-289`,
  ten fields) and `persistSurface` (`:291-306`, ten fields again). The header
  explains why: "a `Map` serializes to `{}`, so the persisted form beside it
  is a schema whose maps are entry arrays, rebuilt into `Map`s at load"
  (`:10-13`). That is exactly `Schema.ReadonlyMap`'s `Iso`
  (`ReadonlyMapIso = ReadonlyArray<readonly [Key["Iso"], Value["Iso"]]>`,
  `node_modules/effect/dist/Schema.d.ts:6972`), reached with
  `Schema.toCodecIso(schema)` (`:12361`) or synchronously `Schema.toIso`
  (`:12719`, "Reading through the `Iso` encodes the schema value, while
  replacing through it decodes"). The harness already types four view fields
  with `Schema.ReadonlyMap` (`packages/harness/src/shared/session/sessionView.ts:310-334`).
- Nine fields are marked "Never persisted" (`:160-208`) inside the same record
  as the persisted ones, so `persistSurface` is also a hand-written `pick`.

**The design decision behind it.** The surface was modelled as one flat bag of
everything a view instance owns, keyed per concern rather than per run, and
its persistence as a separate record because the first bag was not a schema.

**The better design.** `Surface.runs: ReadonlyMap<RunId, RunSurface>` with
`RunSurface = { draft, expanded, groups, seen }` a `Schema.Struct`; the
persisted `Surface` _is_ `Schema.Struct({ shown, launch, runs:
Schema.ReadonlyMap(RunIdSchema, RunSurfaceSchema), inquiryDrafts:
Schema.ReadonlyMap(...), drawerOpen, storageHintDismissed, workbench })`, and
`PersistedState` (which already takes a codec, `shared/state/PersistedState.ts:84`)
stores and loads it through `Schema.toCodecIso(SurfaceSchema)`: entry arrays
in the host state, `Map`s in memory, one declaration. The transient fields
(`requestError`, in-flight, `search`, `toolsSheetOpen`) move to the
`FiberMap`/`SubscriptionRef` of finding 1 or a sibling transient record, so
nothing needs a "Never persisted" comment. `pruneSurface`'s retain is one
filter over `runs`.

Deletes: `loadSurface` (1 caller), `persistSurface` (1 caller), `entries()`,
`RunKeyedMapField`, `retain` (5 calls → 1), `withEntry` (5 calls → 1 nested
update), `EMPTY_DRAFT` spreads in `drafts` reads (4 sites) become a
`RunSurface` default.

**What we give up.** A per-concern map is marginally cheaper to update than a
nested record; irrelevant at this size. `toIso` throws on a failing decode,
so the loud warn-and-reset stays on `PersistedState`'s `Result` path.

**Change amplification.** "A new per-run surface fact" (a per-run composer
height, say): today a field, a `loadSurface` line, a `persistSurface` line, an
`entries` schema line, a `retain` line, a `withEntry` case (6 edits in one
file plus the reader); after: one field on `RunSurfaceSchema` (1 edit plus
the reader).

**Depends on:** none; finding 3 and this one touch the same file and land
best together.

---

## Finding 5. The settings view pushes sixteen message kinds for one host record; a new pushed fact touches seven files

**Red flags:** change amplification; information leakage (a message's shape
known by a constant, a schema, a controller, a dispatcher, a signal, the app,
a tab); two architectures for one need; a false comment.

**Evidence.**

- `SettingsViewOutboundMessageSchema` is a union of 16 message structs
  (`shared/settingsView/settingsViewMessages.ts:451-469`), each with its own
  `command` literal from `SETTINGS_VIEW_COMMANDS` (`shared/ipc.ts:24-109`, 66
  constants), its own payload shape and, on the frontend, its own handler in
  `settingsViewHandlers` (`packages/extension/src/settingsView/frontend/messageDispatcher.ts:46-167`,
  16 cases) writing one or more of 27 module-level `trackedSignal`s
  (`.../settingsState.ts:89-241`).
- The path of one fact, the GitHub token status: `ipc.ts:77` (constant),
  `settingsViewMessages.ts:359-363` (schema) and `:462` (union member),
  `controllers/settingsView/settingsGitCommands.ts:35-37,68,80,106` (sender),
  `messageDispatcher.ts:141-143` (handler), `settingsState.ts:218` (signal),
  `SettingsApp.ts:322` (prop plumbing), `tabs/GitTab.ts:178` (reader): seven
  files for a three-valued string.
- The progress view, by contrast, pushes one `HostSnapshot` record
  (`shared/session/hostSnapshot.ts:91-125`) for every host-owned fact the
  shell reads, held as one `SubscriptionRef<HostSnapshot | null>`
  (`sessionFrames.ts:228`) and read as one property (`ui/progress/ProgressApp.ts:105`).
  The settings view already has the better shape for seven of its snapshots:
  `snapshotMessage` derives the payload from the catalog
  (`settingsViewMessages.ts:111-124`) and one builder fills it
  (`shared/settingsView/handlers/settingsSnapshot.ts:19-33`). The other
  fourteen push messages (`UPDATE_MODEL_SELECTION`, `UPDATE_AGENT_SELECTION`,
  `UPDATE_CUSTOM_AGENT_DIR`, `UPDATE_AGENT_MODE_PRESETS`, `UPDATE_SKILLS_LIST`,
  `UPDATE_PLUGINS`, `UPDATE_GITHUB_TOKEN_STATUS`,
  `UPDATE_SUBSCRIPTION_AUTH_STATUS`, `UPDATE_SUBSCRIPTION_USAGE`,
  `UPDATE_PR_SUBSCRIPTIONS`, `UPDATE_LATEX_SETTINGS_STATUS`, `UPDATE_PROFILE`,
  `UPDATE_MEMORY`, `UPDATE_MEMORY_PREVIEW`) are each a hand-shaped slice of
  the same "what the host knows" record.
- `ipc.ts:95` says "Outbound-only commands (backend → frontend, not
  schema-validated)"; every one of them is a member of the validated outbound
  union (`settingsViewMessages.ts:451-469`). A false comment is a bug
  (AGENTS.md "Plain names and comments").
- Two `*Loaded` booleans (`gitSettingsLoaded`, `latexSettingsLoaded`,
  `settingsState.ts:217,241`) and a `settingsSnapshotRevisions` counter
  (`:193`, bumped in `messageDispatcher.ts:122-128`) exist to tell "has the
  first snapshot arrived" apart from "the value is the default": a `null`
  initial value, as `host$` has (`sessionTransport.ts:66`), would carry that.

**The design decision behind it.** The settings view grew one message per
backend concern (memory, profile, models, agents, teams, skills, plugins,
tokens, subscriptions, PRs, LaTeX) because each concern had its own
controller; the frontend mirrored each with a signal. The progress view
later decided that host-owned data is one record; the settings view never
adopted the decision.

**The better design.** The primitive is one `SubscriptionRef<SettingsSnapshot
| null>` on the frontend (`SubscriptionRef.d.ts:93`), projected to Lit by the
existing `toSignal` over `SubscriptionRef.changes` (`:134`), fed by one
`settings.snapshot` message (whole, or `Partial<SettingsSnapshot>` patches
applied with `SubscriptionRef.update`, `:1248`); on the host, one
`SubscriptionRef<SettingsSnapshot>` the controllers `update` and one fiber
that forwards `changes` to the view (`Stream.runForEach`). Tabs read fields.
The catalog-derived snapshots stay derived (keep `snapshotMessage`'s
construction as the field schemas). `SET_TAB` and `UPDATE_MEMORY_PREVIEW` (an
item-level patch) are the two that are not state and stay as commands.

Deletes: 14 `Update*MessageSchema` structs and their union members, 14
`SETTINGS_VIEW_COMMANDS.UPDATE_*` constants, 14 dispatcher cases, ~22 of the
27 `trackedSignal`s and `createTrackedSignalRegistry` with them,
`gitSettingsLoaded`/`latexSettingsLoaded`/`settingsSnapshotRevisions`, the
16 `bindings.post` sites in `controllers/settingsView/*` (8 files), and with
them `createDispatcher`'s one consumer (finding 6).

**What we give up.** Per-message granularity on the wire; a patch of one
field is the same bytes. The desktop's `unsupported(...)` answers
(`packages/desktop/src/main/desktopSettingsIpc.ts:186-188`) are inbound and
unaffected.

**Change amplification.** "A new host-pushed settings fact": 7 files today;
after: the field on the snapshot schema, the controller that `update`s it,
the tab that reads it (3 files).

**Depends on:** none. The files it deletes are areas G (`controllers/settingsView/`)
and N (`settingsView/frontend/`); the shared schema is this area's.

---

## Finding 6. Two generic dispatchers in `shared/`, one of them 217 lines around a three-line decode-and-index, with a test-mode switch in production code

**Red flags:** shallow module; comments substituting for design; a
"defense-in-depth" guard for a condition the type refuses; an environment
switch read off `globalThis`; two mechanisms for one need.

**Evidence.**

- `createDispatcher` (`shared/utils/dispatcher.ts:85-139`) decodes a union
  and indexes a record; its one production consumer is
  `dispatchSettingsViewOutbound` (`shared/settingsView/settingsViewMessages.ts:476`),
  used by one file (`packages/extension/src/settingsView/frontend/SettingsApp.ts:89`).
  Fourteen of its lines are a comment on a missing registry key "(an
  `as`-cast that lies, a dynamically constructed registry, etc.)" (`:105-116`)
  guarding a case the `HandlerRegistry` type makes a compile error (`:56-62`).
- `assertKnownOutboundMessage` (`:203-217`) and `isDevAssertionMode`
  (`:176-187`) run only under `NODE_ENV=test` or `TEXRA_DEV_ASSERTIONS=1`,
  read `process.env` off `globalThis` to stay browser-safe (`:170-175`), and
  are explained for 40 lines (`:153-202`). Consumers: 2 files in the desktop
  main process. The sender's parameter type (`SettingsViewOutboundMessage`)
  already refuses a payload that does not match the schema at compile time;
  the assertion checks the same thing at run time only in tests.
- `unsupported()`/`isUnsupported`/`UnsupportedCommandError` (`:18-50`) have
  one producer (`desktopSettingsIpc.ts:186-188`) and one consumer that
  branches on the class (`controllers/settingsView/sharedSettingsCommands.ts`).
- `shared/commands/registry.ts` (105 lines) is a second generic dispatcher
  (`dispatchCommandFromRegistry`, `definedHandler`) for command ids with
  positional arguments, used by the extension's command registration and the
  desktop's palette. Two dispatch frameworks, two failure vocabularies
  (`onError(error)` vs `onFailure({kind:'unhandled'|'invalidArguments'})`).

**The design decision behind it.** "Route a decoded message to a handler" was
made a library twice, once per message family, and each library then grew
guards for failure modes its own types exclude.

**The better design.** The primitive is the schema itself:
`Schema.decodeUnknownResult(SettingsViewInboundMessageSchema)` at the two
host edges (`SettingsViewMessageHandler`, `desktopSettingsIpc`) followed by
`handlers[message.command](message)` (3 lines each); the `Result` is the
failure channel, no `onError` callback. With finding 5 there is no outbound
dispatcher at all. `Unsupported` stays as a 10-line value type if the
desktop's "not on this host" answer is wanted as data, else it is a handler
that returns the reason. The dev-only assertion is deleted: the compile-time
type is the check. `shared/commands/registry.ts` stays as the one command
dispatcher.

Deletes: `createDispatcher`, `DispatcherFn`, the defense-in-depth block,
`isUnrecognizedCommand` (1 consumer, which exists only because the desktop
multiplexes settings and `desktop:*` commands on one channel: with one
decoded union per channel it is not needed), `assertKnownOutboundMessage`,
`isDevAssertionMode`: about 170 of 217 lines.

**What we give up.** The dev-time outbound check; the compile-time type
covers every call site that exists.

**Change amplification.** "A new inbound settings command": today the
constant, the schema, the union member, the handler in the shared body, the
host's registry entry (4 files, unchanged by this finding); the dispatcher
adds nothing per command today and is deleted for being a layer, not an
amplifier.

**Depends on:** finding 5 for the outbound half; the inbound half can land
alone.

---

## Finding 7. The UI re-derives status from the view's nine fields and keeps three tone tables, two of which already disagree (R6, found; the UI-side count)

**Red flags:** two representations; a derived predicate re-derived per
component. R6 lists the harness's fields and the hosts' re-derivations
(F1's table); this is the webview's share.

**Evidence.**

- `RunHeader.ts:362-366` computes `canContinue = run.group !== 'running' &&
  run.group !== 'waiting' && acceptsFollowUp(run)` and `:369-372` `idle =
  run.status === 'waiting' && run.group === 'running' && run.approval ===
  'none'`, then paints `'Ready'` instead of `runStatusLabel(run.statusKey)`
  when `canContinue`: a fourth spelling of "can it continue" beside
  `actions.includes('resume')` (R6, C9).
- Tone → glyph is written three times: `RunHeader.ts:70-76`
  (`TONE_INDICATOR_CLASS`), `RunTab.ts:46-52` (`TONE_ICONS`: danger
  `circle-exclamation`, warning `triangle-exclamation`),
  `BackgroundTasksPanel.ts:60-66` (`TONE_ICONS`: danger `circle-xmark`,
  warning `circle-dot`). The two icon tables disagree on two of five tones.
- `RunTab.ts:174-181` re-decides "needs approval" from `run.approval !==
  'none'` ahead of `tone`; `RunTabs.ts:212` groups by `run.group`;
  `TaskGroupList.ts:366` reads `group === 'interrupted'` and `:580`
  `working`; 24 files in `ui/` read one of `statusKey`, `group`, `tone`,
  `status`, `durableOutcome`, `working`, `live`, `statusNotice`.

**The better design.** R6's: `position`, `outcome`, `holder`, `pendingRequest`,
`actions` on the view; one pure function in `ui/copy/runStatus.ts` returns
`{ word, tone, glyph, indicatorClass, section }` (the primitive here is the
view's one fold, R6's; the UI adds nothing but words); the three tables
collapse into that function's one `tone → glyph` row, and `canContinue`/`idle`
become `actions.includes(...)` reads.

Deletes: `TONE_INDICATOR_CLASS`, both `TONE_ICONS`, `canContinue`, `idle`,
`RUN_GROUP_LABELS`/`RUN_GROUP_ORDER`'s dependence on `group` (the function
returns the section).

**What we give up.** Nothing; the disagreement is a defect today.

**Change amplification.** "A new tone": today 3 tables plus
`statusIndicatorStyles` and `RunTab.styles` classes (5 files); after: 1.

**Depends on:** R6.

---

## Finding 8. `htmlBuilders.ts` and the toolkit: a sentinel icon name, two producers' vocabularies known by the painter, options that are constant per caller, and two mechanisms each for tooltips and copy feedback

**Red flags:** sentinel value; information leakage; an option for a special
case; two mechanisms for one need; shared mutable state; 31% comments.

**Evidence.**

- `SPINNER_ICON_NAME = '__spinner__'` widens `IconName` with a magic string
  (`ui/progress/formatters/htmlBuilders.ts:155`; 5 sites in 3 files) so that
  `renderIconOrSpinner` can branch on it (`:179-188`). Every caller already
  holds the boolean it stands for (`running`, `toolFormatters.ts:78-80`).
- `triStateStatusIcon` recognises `'running'` and `'in_progress'` because "it
  therefore has to recognize both producer vocabularies: the Codex turn
  state's ... and `McpToolOutputSchema.status`'s" (`:157-172`): the painter
  knows two tool plugins' status enums. The harness's `ToolRowModel` status
  section (`toolSections.ts:167`) should carry one tri-state; the painter
  then switches on it.
- `buildCodeBlock`'s `showLanguage` and `showCopy` are `true` at both callers
  (`toolFormatters/helpers.ts:139-140`, `components/BashRequestPanel.ts:53-54`):
  two options for no case. `buildCopyButton(title, { content, labeled })`
  is called with and without `labeled` by its two callers; a labeled copy
  button is a different control, not a flag.
- Three path builders over one model field: `renderFileSection` switches on
  `section.namespace` to choose `buildMemoryPathDisplay`,
  `buildExecutionsPathDisplay` or `buildFileLinkWithLines`
  (`toolSections.ts:70-93`, `htmlBuilders.ts:347-397`); one
  `buildPath(section)` would own the switch.
- Comments: a 20-line explanation of `<wa-details>`' keydown handling
  (`:92-116`) and the "IMPORTANT: Lit templates preserve whitespace" notice
  twice in this file (`:5,327`) and again in `toolFormatters.ts:13-15`,
  `helpers.ts:4-6`, `toolSections.ts:11-12`: a formatting rule the formatter
  (oxfmt) could hold, repeated as prose in five files.
- Two tooltip mechanisms: `renderActionButtonParts` emits `<wa-tooltip for=id>`
  when the caller passed an `id`, else a native `title`
  (`ui/wa/actionButtons.ts:141-151,174`); `installToolbarTooltips`
  (`ui/litControllers/TooltipController.ts:134`) then hooks every
  `WA-BUTTON` with a `title` and draws its own fixed-position `div` from four
  module-level mutables (`:43-46`), listing `VSCODE-TOOLBAR-BUTTON` (`:24`), a
  tag no source file renders. Which mechanism a button gets is decided by
  whether its caller thought of an `id`.
- Two copy-feedback mechanisms: `copyWithFeedback` keeps its reset timer id
  in `button.dataset.copyResetTimeoutId` (`shared/utils/clipboard.ts:41-82`;
  used by `htmlBuilders.ts`), and `CopyButtonController` keeps it in a
  `FlushableDebounce` (`ui/litControllers/CopyButtonController.ts:72`; 3
  components). Same 2-second rule, two implementations.

**The design decision behind it.** The builders were written as a bag of
template helpers with an option per caller's wish, and the toolkit added a
second tooltip and a second copy mechanism when the first did not fit a
caller instead of changing the first.

**The better design.** `renderIconOrSpinner(running: boolean, icon:
IconName)`; the harness's tool section carries `status: 'running' | 'failed'
| 'done'` (the plugins normalise at their boundary, area H); `buildCodeBlock(text,
language)` with the header always; `buildCopyButton` and a separate
`buildLabeledCopyButton` or one call site that passes its own content; one
`buildPath(section)`. One tooltip: `wa-tooltip` for every action button
(`id` becomes required on icon buttons, which is also what `aria` wants) and
`TooltipController.ts` is deleted (2 callers). One copy feedback, and its
timer is Effect's, not a hand-rolled debounce: a `copy-button` element whose
controller runs `copy.pipe(Effect.andThen(Effect.sleep(COPY_RESET)))` under
a `FiberHandle` (`FiberHandle.d.ts:110,542`: a new copy interrupts the
previous reset), forked on the webview's `ManagedRuntime` (`runFork`,
`ManagedRuntime.d.ts:125`); `copyWithFeedback`'s dataset protocol and
`createFlushableDebounce`'s copy consumer go.

Deletes: `SPINNER_ICON_NAME` (5 sites), `triStateStatusIcon`'s second
vocabulary, `showLanguage`/`showCopy`/`labeled`, two of three path builders,
`TooltipController.ts` (160 lines, 4 module-level mutables),
`copyWithFeedback` + `COPY_RESET_DELAY_MS` dataset protocol (40 lines), four
copies of the whitespace notice.

**What we give up.** Buttons rendered without an `id` lose their hover hint
until given one; the formatter-level rule for single-line templates must be
stated once somewhere (the `ui/README.md`).

**Change amplification.** "A new tool status vocabulary" (a third plugin):
today `htmlBuilders.ts:169` and the comment; after: none in the UI.

**Depends on:** the status tri-state needs the harness's `toolRowModel`
(area M's `transcript/`); everything else lands alone.

---

## Finding 9. Renderers that rebuild what the data model split

**Red flags:** a renderer compensating for the data model (dedup, a second
copy of state, a synthetic name, an identity rule); temporal decomposition
in the data (facts split by concern and rejoined per round).

**Evidence.**

- `documentsOf(run)` takes `rounds: RoundOutput[]`, one record per round
  with `outputs`, `missingOutputs`, `compileFailures`, `latexdiffs`, `reply`,
  and splits it into five by-round records (`shared/plugins/documents.ts:140-167`);
  `WorkflowRunContent` passes the five as five properties
  (`ui/progress/components/WorkflowRunContent.ts:54-60`); `FileList` then
  rebuilds the round list as `[...new Set(four records' keys)].toSorted()`
  (`FileList.ts:161-169`) and an index `failureByPath` keyed
  `"${round}:${path}"` (`:155,171-178`). The shape the renderer wants is the
  shape the plugin started from.
- `ExternalInquiryPanel` keeps its own `answerText`/`sessionLinksText` plus a
  `draftRestored` flag and a debounce that writes them back to
  `Surface.inquiryDrafts` (`ExternalInquiryPanel.ts:70-83,98-115`), while
  `SessionComposer` "holds no draft of its own" (`SessionComposer.ts:15`)
  and reads the surface on every render. Two owners of a draft in one
  shell. It also decodes `permission.data` with `decodeUnknownSync` and caches
  the result by reference (`:119-127`) because the view hands it a `JsonValue`
  record for a plugin request.
- `RequestPanels.requestKey` decides that "Retry is keyed by `runId` instead
  of `requestId`: one pending retry per run, a new one replaces it"
  (`RequestPanels.ts:69-79`): an identity rule of the request model written
  in the renderer. The view's `requests` list could carry stable keys (or a
  retry could keep its id).
- `TaskGroupList.transcriptTimeline` re-roots groups whose parent is absent
  (`TaskGroupList.ts:119-121,509-514`), a shape the group rows could refuse
  (a `parentGroupId` must name a group in the same transcript, else it is
  `null`).
- `generatePastedImageName` mints `pasted_<Date.now()>_<6 hex>.<ext>` in the
  renderer (`shared/utils/pastedImageName.ts:7`) and the host stores under
  that name (`savePastedImage` → `savedImage.fileName`,
  `sessionFrames.ts:101-104`): the name is an identity the store should mint
  (content address or sequence), returned in the outcome as it already is.

**The better design.** The primitive is the view's one record: `RunView.facts`
→ `documentRoundsOf(run)` is passed as `rounds` to `FileList` (one property);
`documentsOf` is deleted (2 callers) and `sortedRounds`/`failureByPath` with
it. The inquiry panel reads `surface.inquiryDrafts.get(key)` for its field
values and dispatches `inquiryDraft` on input as the composer does;
`draftRestored` and the debounce go (the surface write is one
`SubscriptionRef.update`, and the host state write it feeds is already
coalesced). Pending request keys: the harness gives a retry a stable
`requestId` per run (R7's row) or the view carries `key`. Group rows: refuse
an orphan at the fold. Pasted names: the host answers with the name it chose
from the bytes; the renderer sends `{ ext, base64 }`.

**What we give up.** Nothing user-visible; the inquiry draft loses a
250 ms write coalescing it does not need.

**Change amplification.** "A new per-round document fact" (a word count,
say): today `RoundOutput`, `documentsOf`, a `FileList` property, the
`sortedRounds` union, the `WorkflowRunContent` binding (4 files, 5 edits);
after: the field on `RoundOutput` and its reader (2).

**Depends on:** none for the documents and inquiry items; the retry key on
R7.

---

## Finding 10. `commandCatalog` carries membership columns that its consumers' own tables already state

**Red flags:** a declarative table with derivable columns; two
representations; a hand-ordered list.

**Evidence.**

- `extensionRegistry?: true` (`shared/commands/catalog.ts:34`) is set on 25
  of the 28 non-desktop rows; its only reader is a type,
  `Extract<..., { extensionRegistry: true }>`
  (`packages/extension/src/commands/extensionCommandHandlers.ts:47-52`), used
  to make `EXTENSION_COMMAND_HANDLERS` `satisfies Record<…>` (`:166`). The
  handler map's keys _are_ the membership; the flag exists to let the type
  checker compare the map against itself. The three untagged rows
  (`replyComment`, `resolveCommentThread`, `unresolveCommentThread`,
  `:263-278`) are registered elsewhere and nothing in the catalog says where.
- `host?: 'desktop'` (`:42`) marks nine rows whose ids all start with
  `texra.desktop.`; its readers filter them out of the manifest (`:360-378`)
  and the desktop reads them through `commandCatalogById`. Two owners
  (extension, desktop) in one table, told apart by a column.
- `commandKeybindingOrder` (`:401-405`) lists the three non-desktop rows
  that have a `keybinding`, in an order different from the catalog's, and
  `commandKeybindings` (`:407-413`) throws if one lacks a keybinding: a list
  that restates "rows with a keybinding and no host" so the manifest's
  keybindings come out in a chosen order.
- `setupInvokable?: true` (`:48`) is an allowlist for `InvokeCommandTool`
  (`tools/setup/InvokeCommandTool.ts:12-15`); a security decision, kept, but
  it belongs with the tool that enforces it.

**The better design.** Two tables, one per owner: the extension's catalog
(what `package.json` publishes and `EXTENSION_COMMAND_HANDLERS` keys, with
the three comment commands in their own module) and the desktop's; the
palette merges them. `commandKeybindings` is `catalog.filter(r =>
r.keybinding)` in catalog order. `setupInvokable` moves to the tool as its
list of ids, typed over `CommandId`. (Plain data; no runtime primitive
applies.)

Deletes: `extensionRegistry` (26 sites), `host` (10 sites and the filter),
`commandKeybindingOrder` and the throw, `SettingsTabCommandId`'s cast (the
map stays).

**What we give up.** One table for the palette becomes two merged at one
site.

**Change amplification.** "A new desktop-only command": today a catalog
row with `host`, plus the desktop's handler (2 files); after: the desktop's
own row and handler (1-2 files). "A new extension command": today a row with
`extensionRegistry` plus the handler map entry (2); after: the same 2, with
no flag to forget.

**Depends on:** none.

---

## Batched smaller items

- **`hostSnapshot.banners`** spells "shown" as `{ visible }` assigned onto
  records whose data fields are `optional(NullOr(...))`
  (`shared/session/hostSnapshot.ts:22,30-33,49-51,115-118`): `dependency:
  MissingTool[] | null` and `agentConfig: {...} | null` would carry the
  visibility in the type (two representations of "is there a banner").
- **`surfaceDecision.approvalDecisionArm`** throws when `runId === ''`
  (`shared/session/surfaceDecision.ts:136-140`) although
  `PendingRequest.data.runId` is `RunIdSchema`
  (`packages/harness/src/shared/schemas/request.ts:126`): a check for a value
  the schema refuses. Delete the branch.
- **`BaseRequestPanel`** declares seven hooks; `primaryIcon`, `notePrompt`,
  `emitRuntimeArm`, `declineTakesNote` are each overridden by exactly one of
  the seven cards (`ui/progress/components/BaseRequestPanel.ts:143,170,200;
  ExternalInquiryPanel.ts`, `RetryRequestPanel.ts`, `UserQuestionPanel.ts`,
  `ToolEditRequestPanel.ts`): a base class with hooks one subclass fills.
  The card's "declaration" (`ask`, `primary`, `decline`, `grant`, keys) is a
  record a card returns, not a method set to override; one `request-card`
  element taking that record would replace the abstract class.
- **DOM id grammar**: `GROUP_DOM_IDS` prefixes are composed in templates and
  parsed back with `details.id.slice(prefix.length)`
  (`TaskGroupList.ts:427`), and `handleRevealOlderRows` reads its arguments
  from `dataset.revealKind`/`revealScope` (`:377-378`); `ELEMENT_IDS` (14
  sites) names ids the tests and `@query` share. An event's `currentTarget`
  already identifies the group; Lit's `ref` or a per-row closure carries the
  argument without an id grammar.
- **`TerminalOutput.writeTerminalText`** races xterm's write callback
  against a 100 ms `setTimeout` inside `new Promise`
  (`ui/progress/components/TerminalOutput.ts:303-311`): a wait with a
  guessed bound, where `terminal.write(text, cb)` alone is the completion
  (`Effect.callback` with `Effect.timeout` if a bound is wanted).
- **`subscribeToSignalChanges`** (`shared/signals.ts:81-110`) is a hand-rolled
  watcher with microtask coalescing and a re-arm-in-`finally` rule explained
  in 12 lines; its two consumers (`sessionSurfaces.ts:201`, settings state)
  could be `Stream`s off the `SubscriptionRef`s the runtime already holds,
  since `toSignal` (`:18-37`) is the one bridge the file says should exist.
- **`ipc.ts:95`** false comment (finding 5).

---

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

`corepack pnpm install` completed while this report was being written; every
signature below was read from `node_modules/effect/dist/*.d.ts`. Line
numbers are into those files.

| Hand-rolled today                                                                                                                            | Effect primitive                                                                                                                                                                                                                                                                | Note                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenSession.pending: Map<id, Deferred>` + `Deferred.makeUnsafe` per request + `requestId()` + `CANCELLED` + `Cause.hasInterruptsOnly` (F1)  | `RpcClient.make(group)` over `RpcClient.Protocol.make({ send, run })` (`rpc/RpcClient.d.ts:140,230,190-193`): `send` is `hostBridge.postMessage`, `run` the window listener; ids, correlation and per-client cancellation are the protocol's                                    | `@stability unstable`; stable fallback: `PubSub.make` + `Stream.fromPubSub` → `filter` → `runHead` (`PubSub.d.ts:279`, `Stream.d.ts:1050,5253,15903`) forked with `Effect.forkIn(scope)` (`Effect.d.ts:17126`) |
| `Effect.timeoutOrElse` building a `Rejected` by hand (F1)                                                                                    | `Effect.timeout` (`Effect.d.ts:8266`, fails with `TimeoutError`) mapped once at the edge                                                                                                                                                                                        |                                                                                                                                                                                                                |
| `Surface.sending` / `Surface.polishing` Sets, add-before/delete-after; `RunTabs.deleting` (F1)                                               | `FiberMap<RunId \| 'launch', …>` in the session scope (`FiberMap.d.ts:115`); `FiberMap.run` removes on completion (`:1016-1026`); busy is `FiberMap.has` (`:792`); a `SubscriptionRef<ReadonlySet<key>>` kept by `Effect.acquireRelease` (`Effect.d.ts:12676`) for the composer | the composer reads the ref through `toSignal` (`shared/signals.ts:18`)                                                                                                                                         |
| `WebviewSession.generation` + `SessionFrames.begin` + `Subscribe.generation` + `EventsFrame.generation` + host echo (F1)                     | `Stream.switchMap` over `SubscriptionRef.changes(subscribe$)` (`Stream.d.ts:2505` "interrupting the previous stream when a new element arrives"; `SubscriptionRef.d.ts:134`)                                                                                                    | host side: the bridge's replay fiber is already interrupted per `Subscribe` (`SessionBridge.ts:250-253`); with `switchMap` the number is redundant on both ends                                                |
| `held.get(key) !== entry` after an `await` (F1)                                                                                              | `Effect.forkIn(sessionScope)` (`Effect.d.ts:17126`: "interrupted when the scope is closed"); `Scope.make`/`Scope.close` already used (`sessionTransport.ts:281,225`)                                                                                                            |                                                                                                                                                                                                                |
| `subscribedTranscript` string compare (F1)                                                                                                   | `Stream.changes` (`Stream.d.ts:13273`) on the tier derived from the view and surface refs                                                                                                                                                                                       |                                                                                                                                                                                                                |
| `Response.result.outcome: Union([Outcome, HostOutcome])` + `answer()`'s narrowing throw + `toEncoded(RequestErrorSchema)` + `refusal()` (F2) | one `Rpc` per request kind with its own `success`/`error` schema (`rpc/Rpc.d.ts`); `RpcSerialization.json` decodes the error class (`rpc/RpcSerialization.d.ts:120`)                                                                                                            | without `rpc`: two response kinds and `RequestErrorSchema` inside `DownMessageSchema`                                                                                                                          |
| `selected` / `pendingSelection` / `editing` nullable trio (F3)                                                                               | `Schema.TaggedUnion` `Shown` inside the one `SubscriptionRef<Surface>` (`SubscriptionRef.d.ts:93,1248`)                                                                                                                                                                         | pure data; the ref is the one owner                                                                                                                                                                            |
| five `ReadonlyMap<RunId, _>` fields + `RunKeyedMapField` + `loadSurface`/`persistSurface` + `entries()` (F4)                                 | `Schema.ReadonlyMap(RunIdSchema, RunSurfaceSchema)` (`Schema.d.ts:6981`) persisted through its `Iso` (`ReadonlyMapIso`, `:6972`) with `Schema.toCodecIso` (`:12361`) or `Schema.toIso` (`:12719`)                                                                               | **correction:** `ReadonlyMap`'s `Encoded` is still a `ReadonlyMap` (`:6959`); the entries form is the `Iso`. The harness uses `Schema.ReadonlyMap` for four view fields (`sessionView.ts:310-334`), in memory  |
| 14 `UPDATE_*` messages + 27 `trackedSignal`s + `createTrackedSignalRegistry` + `*Loaded` flags + `settingsSnapshotRevisions` (F5)            | one `SubscriptionRef<SettingsSnapshot \| null>` (`SubscriptionRef.d.ts:93`) fed by `update` (`:1248`), projected by `toSignal` over `changes` (`:134`); on the host one `SubscriptionRef` whose `changes` a `Stream.runForEach` (`Stream.d.ts:15953`) forwards to the view      | mirrors `SessionFrames.host` (`sessionFrames.ts:228`), the one pattern the progress view already has                                                                                                           |
| `createDispatcher` + defense-in-depth + `assertKnownOutboundMessage` + `isDevAssertionMode` (F6)                                             | `Schema.decodeUnknownResult(Union)` at the two host edges; the `Result` is the failure channel                                                                                                                                                                                  | `shared/commands/registry.ts` stays as the one command dispatcher                                                                                                                                              |
| `copyWithFeedback`'s `dataset.copyResetTimeoutId` + `CopyButtonController`'s `createFlushableDebounce` (F8)                                  | `FiberHandle` (`FiberHandle.d.ts:110,542`: a new `run` interrupts the previous) around `copy.pipe(Effect.andThen(Effect.sleep(COPY_RESET)))`, forked on the webview `ManagedRuntime` (`ManagedRuntime.d.ts:125`)                                                                | `TooltipController`'s delay is the same shape, or goes with the controller (one tooltip)                                                                                                                       |
| `ExternalInquiryPanel`'s `answerText`/`draftRestored`/debounce (F9)                                                                          | the surface's `SubscriptionRef.update` on input; the component holds nothing                                                                                                                                                                                                    | as `SessionComposer` already does                                                                                                                                                                              |
| `subscribeToSignalChanges` watcher + microtask coalescing (batched)                                                                          | `Stream.zipLatest`/`Stream.runForEach` over the three `SubscriptionRef.changes` the transport already exposes, through the one `toSignal` bridge                                                                                                                                |                                                                                                                                                                                                                |
| `TerminalOutput.writeTerminalText`'s `new Promise` + 100 ms race (batched)                                                                   | `Effect.callback` over `terminal.write(text, cb)`, `Effect.timeout` if a bound is wanted                                                                                                                                                                                        |                                                                                                                                                                                                                |
| `TickerController` (`setInterval` + `Date.now()`)                                                                                            | keep: a render clock, not state; a `Stream.tick`/`Schedule.spaced` fiber would be the same thing with a runtime dependency a leaf controller does not need                                                                                                                      | good                                                                                                                                                                                                           |
| `webviewSessionLayer.ts` `LayerMap.Service` + `Layer.fresh` + `ManagedRuntime.make` (`LayerMap.d.ts:316`, `Layer.d.ts:3494`)                 | keep: already the primitive                                                                                                                                                                                                                                                     | good                                                                                                                                                                                                           |
| `toSignal` (`Stream.runForEachArray` → `signal.set`, `Fiber.interrupt` on dispose; `shared/signals.ts:18-37`)                                | keep: the one Effect→Lit bridge; every ref above reaches a component through it                                                                                                                                                                                                 | good                                                                                                                                                                                                           |

**Browser safety.** None of the modules named above (`Effect`, `Stream`,
`PubSub`, `SubscriptionRef`, `FiberMap`, `FiberHandle`, `Scope`,
`ManagedRuntime`, `Schema`, `LayerMap`) import a `node:` module in its
`.d.ts` (`grep -l 'from "node:'` over those files returns nothing), and the
webview bundles already run `ManagedRuntime`, `LayerMap`, `SubscriptionRef`,
`Queue`, `Stream` and `Scope` today (`shared/session/webviewSessionLayer.ts`,
`sessionFrames.ts`, `sessionTransport.ts`). `rpc/RpcClient` with a custom
`Protocol.make` is browser-safe (its `send`/`run` are the caller's); only
`makeProtocolHttp`/`makeProtocolSocket`/`makeProtocolWorker` bring platform
services, and none is needed over `postMessage`. What the frontend reads: one
`SubscriptionRef` per record (`view$`, `surface$`, `host$`, and for the
settings view `settings$`) projected to a Lit signal by `toSignal`; no
component or module-level store beside them (`trackedSignal` registries,
`TooltipController`'s globals, `RunTabs.deleting`, `ExternalInquiryPanel`'s
fields all go).

---

## Good modules in this area

- `shared/session/surface.ts` `applySurfaceAction` (`:514-612`): one pure
  reducer over one action union that components and the host's
  `surface.action` both speak; the right owner for every interaction fact,
  which is why findings 3 and 4 are about its fields, not its shape.
- `shared/session/uiEvents.ts`: three events carrying one case of the record
  they change, "nothing translates in between".
- `shared/session/surfaceDecision.ts` `REQUEST_ACTIONS` + `approvalDecisionArm`:
  one table that the progress view, the TUI and the headless prompt answer
  from; the one place a `y`/`n`/`a` means one thing.
- `ui/progress/formatters/index.ts` `ROW_FORMATTERS`: exhaustive over
  `TranscriptRowKind`, so a new row kind is a compile error, not a blank line.
- `shared/settingsView/handlers/settingsSnapshot.ts` + `snapshotMessage`: the
  catalog-derived snapshot is the shape finding 5 wants for the rest of the
  settings view.
- `shared/settingsView/settingSurfaces.ts` `HARNESS_ROW_SURFACES` (fails at
  startup on a missing placement) and `handlers/stateSettingWrite.ts`
  `applyStateSettingUpdate`: one write path for three surfaces.
- `shared/session/webviewSessionLayer.ts`: a `LayerMap` per session key over
  one `ManagedRuntime`; the Effect-native half of finding 1.
- `shared/session/sessionFrames.ts` `SessionFrames.host`: a
  `SubscriptionRef<HostSnapshot | null>` as the one host record; the shape
  finding 5 copies.
- `shared/signals.ts` `toSignal`: the one meeting point between Effect and
  Lit, with `dispose` as the fiber's interrupt.
- `shared/state/PersistedState.ts`: decodes with the schema, warns and resets
  loudly, never `catchDecoding` (the accepted exception for view state).
- `ui/copy/*`: one owner per word (`runStatus.ts`, `nestedRuns.ts`,
  `modelAccess.ts`); the tables finding 7 keeps.
- `ui/wa/actionButtons.ts`: four thin names over one `renderActionButtonParts`
  body; the names are the API, the body is one.
- `ui/progress/proposalEdit.ts` and `shared/session/unseenRuns.ts`: pure
  functions of the two records, no component state.

## Already settled, left alone

- Two webview architectures (request/response settings view, event-driven
  progress view): named in `packages/extension/src/AGENTS.md` "Webviews" as
  coexisting; finding 5 narrows the first toward the second without adding a
  third.
- `ui/styles/index.ts` as a barrel: a documented exception to "no
  convenience barrels" (`ui/styles/index.ts:1-8`).
- `TickerController`'s `Date.now()`: a clock for elapsed time over a
  `runStartedAt` the view owns, not a stand-in for the model.
- `PersistedState`'s warn-and-reset: AGENTS.md "Silent degradation" allows a
  logged reset on non-authoritative view state.
- `clipboardImages.readFileAsBase64`'s `new Promise`: a `FileReader` callback
  boundary, converted once (`Effect.callback` would be the same boundary).
- The R6 fields the UI reads (`group`, `tone`, `statusKey`, `status`, ...):
  found in round 1 (C1, C2, C9); finding 7 adds only the UI-side count and
  the disagreeing tables.
- `settingsView/frontend` living under `packages/extension/src` yet mounted by
  the desktop (`packages/desktop/src/renderer/settingsDialog.ts:4`): AGENTS.md
  lists it as a VS Code-free zone; area N's.
- `flushableDebounce`'s re-entrancy rule: documented against a measured
  library defect (`shared/utils/flushableDebounce.ts:12-18`); of its three
  consumers, finding 8 replaces the copy reset with a `FiberHandle`, the
  tooltip delay goes with the controller, and finding 9 deletes the inquiry
  draft save, after which the module has no consumer.
- `shared/constants/latexToolchain.ts`: area I's.
