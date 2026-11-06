# J. The UI kit and the shared contracts: design red flags

Area: `packages/texra/src/ui/` and `packages/texra/src/shared/`. Read-only, at
the working tree of 2026-11-06. Paths below are relative to
`packages/texra/src` unless they start with `packages/`. Consumer counts are
over `packages/*/src`. `shared/constants/latexToolchain.ts` (722 lines, 27%
comments) is area I's ("the toolchain constants") and is not read here.

The one Effect fact this report relies on: `Schema.ReadonlyMap(K, V)` exists
in the installed Effect and is already used by the harness's own view schema
(`packages/harness/src/shared/session/sessionView.ts:310,327,332,334`). The
`node_modules` tree is not present in this checkout, so no other Effect API
is cited from its sources.

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
  (`shared/session/webviewSessionLayer.ts:84-93`) and then re-implements
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
  (`sessionSurfaces.ts:130,148-158,205-207`) and guards the first prune with a
  captured `beforeReplay` reference (`:187,201`).

**The design decision behind it.** The transport was designed as a decoder of
host messages into signals, so the Effect runtime it installs is used only to
run the view fold; every lifetime question (a request waiting, a subscription
superseded, a session closing mid-request) is answered again outside Effect,
and the surface record absorbs the in-flight state because the Promises have
nowhere else to put it.

**The better design.** One scoped session: `WebviewSessions.open(key)` already
returns a graph under a `Scope`. A request is `Effect<Response['result']>`
run in that scope (`FiberMap<requestId>` or simply `Effect.forkIn(scope)`):
closing the scope interrupts it, which is the `Cancelled` case; the timeout is
`Effect.timeout`; the response arrives through one `PubSub<DownMessage>` the
`receive` function publishes to, and a request is
`Stream.filter(m => m.kind === 'response' && m.requestId === id)` →
`Stream.runHead`. In-flight is the existence of the fiber: `sending`,
`polishing` and `RunTabs.deleting` become reads of a
`FiberMap<RunId | 'launch', …>` (or one `SubscriptionRef<Set>` the fiber's
`acquireRelease` maintains), so the add-before/delete-after pairs go. The
generation is a `Stream.switchMap` over a `SubscriptionRef<Subscribe>`: the
previous generation's stream is interrupted when the next begins, so no frame
needs a number to be dropped, and the wire's `generation` field can go once
the host's framer is cut over (areas G and N).

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
dropped either way.

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
  host request with a runtime outcome" (`ui/progress/sessionTransport.ts:349-360`),
  and `settleHost` checks `outcome.kind !== 'files'` and the like per case
  (`ui/progress/sessionSurfaces.ts:268-290`).
- The error travels as `Schema.toEncoded(RequestErrorSchema)` (`sessionFrames.ts:131`)
  although `DownMessageSchema` is decoded once at `receive`
  (`sessionTransport.ts:181`); `refusal()` decodes the class a second time
  with `decodeUnknownSync` (`sessionSurfaces.ts:248`), and `answer()` reads
  `'reason' in result.error` on the encoded form (`sessionTransport.ts:363`).
- A runtime refusal is then written to two places: `Surface.requestError`
  (`sessionSurfaces.ts:255`, the global notice) and `Surface.rejected[runId]`
  (`:450`, the run's own controls). Readers: `requestError` 14 sites in 5
  files, `rejected` 6 sites in 4 files.

**The design decision behind it.** The wire was given one `Response` for two
request families so the transport could route by `requestId` alone; the
families' outcome types were then recovered by narrowing in every consumer.
The error class was kept encoded on the wire for a `postMessage` that strips
prototypes, but decoded at the wrong layer.

**The better design.** Two response kinds, `runtime.response` and
`host.response`, each with its own outcome type, or one `Response` whose
`outcome` is typed by the request the transport correlates it with (a typed
`request<K>(message): Effect<OutcomeOf<K>>`); `DownMessageSchema` carries
`RequestErrorSchema` itself so `result.error` is the class after the one
decode. `requestError` stays as the one notice; `rejected` becomes a
projection of it keyed by the run the request named (or the notice carries
the run and the composer reads it): one write.

Deletes: `answer()`'s five-case switch and its throw (12 lines), `refusal()`
(1 function, 2 callers), the second decode, `Surface.rejected` (1 field, 6
sites) or `requestError` (the owner chooses which spelling survives).

**What we give up.** Nothing user-visible.

**Change amplification.** "A new host outcome kind": today the union
(`sessionFrames.ts`), `answer()`'s switch, and each `settleHost` case that
must exclude it (3 files); after: the host response's union and the one
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
- `applySurfaceAction` keeps the invariants by hand: `select` resets
  `pendingSelection`, `drawerOpen`, `editing` (`:526-533`); `selectNew` resets
  five fields (`:539-547`); `editProposal` sets `selected: null`, clears
  `pendingSelection`, sets `editing` and patches `launch` (`:549-557`).
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

**The better design.** One field, `shown: { kind: 'new' } | { kind: 'run';
runId } | { kind: 'arriving'; runId; cursor } | { kind: 'proposal'; runId;
requestId }`, with `applySurfaceAction`'s three cases each setting `shown`
and nothing else (the drawer closes on any `shown` change in one place).
`pruneSurface` maps `arriving` → `run` or `new` and `proposal` → `run` when
the request is gone; `editedProposal` reads `shown.kind === 'proposal'`.
Persisted form: `shown` as `{kind:'run'; runId} | {kind:'new'}` only.

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

## Finding 4. Per-run surface state is five parallel maps with a hand-written codec, where `Schema.ReadonlyMap` is already in use next door

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
  (`:10-13`). That is exactly what `Schema.ReadonlyMap` encodes and decodes,
  and the harness's `SessionViewSchema` uses it for four fields
  (`packages/harness/src/shared/session/sessionView.ts:310-334`).
- Nine fields are marked "Never persisted" (`:160-208`) inside the same record
  as the persisted ones, so `persistSurface` is also a hand-written `pick`.

**The design decision behind it.** The surface was modelled as one flat bag of
everything a view instance owns, keyed per concern rather than per run, and
its persistence as a separate record because the first bag was not a schema.

**The better design.** `Surface.runs: ReadonlyMap<RunId, RunSurface>` with
`RunSurface = { draft, expanded, groups, seen, rejected? }` and
`RunSurfaceSchema` a `Schema.Struct`; the persisted `Surface` *is*
`Schema.Struct({ shown, launch, runs: Schema.ReadonlyMap(RunIdSchema,
RunSurfaceSchema), inquiryDrafts: Schema.ReadonlyMap(...), drawerOpen,
storageHintDismissed, workbench })`, encoded with `Schema.encodeSync` into the
host state and decoded with the same schema at load (`PersistedState` takes
a codec already, `shared/state/PersistedState.ts:84`). The transient fields
(`requestError`, in-flight, `search`, `toolsSheetOpen`) move to a sibling
`Transient` record or, with finding 1, to the fiber map, so nothing needs a
"Never persisted" comment. `pruneSurface`'s retain is one
`Map.filter(runs, (_, id) => view.runs.has(id))`.

Deletes: `loadSurface` (1 caller), `persistSurface` (1 caller), `entries()`,
`RunKeyedMapField`, `retain` (5 calls → 1), `withEntry` (5 calls → 1 nested
update), `EMPTY_DRAFT` spreads in `drafts` reads (4 sites) become a
`RunSurface` default.

**What we give up.** A per-concern map is marginally cheaper to update than a
nested record; irrelevant at this size.

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
  `settingsViewHandlers` (`packages/extension/src/settingsView/frontend/messageDispatcher.ts:45-167`,
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
  shell reads, and the shell reads it as one property (`ui/progress/ProgressApp.ts:105`).
  The settings view already has the better shape for seven of its snapshots:
  `snapshotMessage` derives the payload from the catalog
  (`settingsViewMessages.ts:111-124`) and one builder fills it
  (`shared/settingsView/handlers/settingsSnapshot.ts:20-33`). The other nine
  push messages (`UPDATE_MODEL_SELECTION`, `UPDATE_AGENT_SELECTION`,
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
  first snapshot arrived" apart from "the value is the default": a nullable
  record (`null` until the first push, as `host$` is in the progress view,
  `sessionTransport.ts:73`) would carry that.

**The design decision behind it.** The settings view grew one message per
backend concern (memory, profile, models, agents, teams, skills, plugins,
tokens, subscriptions, PRs, LaTeX) because each concern had its own
controller; the frontend mirrored each with a signal. The progress view
later decided that host-owned data is one record; the settings view never
adopted the decision.

**The better design.** One `SettingsSnapshot` record schema (`values` of the
derived snapshots plus `models`, `agents`, `teams`, `skills`, `plugins`,
`github`, `subscriptions`, `prSubscriptions`, `latex`, `memory` as fields),
pushed whole or as `Partial<SettingsSnapshot>` patches under one command;
the frontend holds one `SubscriptionRef`/signal of `SettingsSnapshot | null`
and tabs read fields. Each controller fills its field instead of posting its
message; the catalog-derived snapshots stay derived (keep `snapshotMessage`'s
construction as the field schemas). `SET_TAB` and `UPDATE_MEMORY_PREVIEW`
(an item-level patch) are the two that are not state and stay as commands.

Deletes: 14 `Update*MessageSchema` structs and their union members, 14
`SETTINGS_VIEW_COMMANDS.UPDATE_*` constants, 14 dispatcher cases, ~22 of the
27 `trackedSignal`s, `gitSettingsLoaded`/`latexSettingsLoaded`/
`settingsSnapshotRevisions`, the 16 `bindings.post` sites in
`controllers/settingsView/*` (8 files), and with them `createDispatcher`'s
one consumer (finding 6).

**What we give up.** Per-message granularity on the wire; a patch of one
field is the same bytes. The desktop's `unsupported(...)` answers
(`packages/desktop/src/main/desktopSettingsIpc.ts:186-188`) are inbound and
unaffected.

**Change amplification.** "A new host-pushed settings fact": 7 files today;
after: the field on the snapshot schema, the controller that fills it, the
tab that reads it (3 files).

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
  guarding a case the `HandlerRegistry` type makes a compile error (`:57-62`).
- `assertKnownOutboundMessage` (`:203-217`) and `isDevAssertionMode`
  (`:176-187`) run only under `NODE_ENV=test` or `TEXRA_DEV_ASSERTIONS=1`,
  read `process.env` off `globalThis` to stay browser-safe (`:168-175`), and
  are explained for 40 lines (`:153-202`). Consumers: 2 files in the desktop
  main process. The sender's parameter type (`SettingsViewOutboundMessage`)
  already refuses a payload that does not match the schema at compile time;
  the assertion checks the same thing at run time only in tests.
- `unsupported()`/`isUnsupported`/`UnsupportedCommandError` (`:17-50`) have
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

**The better design.** With finding 5 there is one outbound message and no
outbound dispatcher. Inbound, the two host edges (`SettingsViewMessageHandler`,
`desktopSettingsIpc`) write
`Schema.decodeUnknownResult(SettingsViewInboundMessageSchema)(raw)` and
`handlers[message.command](message)` inline (3 lines each); `Unsupported`
stays as a 10-line value type if the desktop's "not on this host" answer is
wanted as data, else it is a handler that returns the reason. The dev-only
assertion is deleted: the compile-time type is the check.
`shared/commands/registry.ts` stays as the one command dispatcher.

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
- `RunTab.ts:174-179` re-decides "needs approval" from `run.approval !==
  'none'` ahead of `tone`; `RunTabs.ts:212` groups by `run.group`;
  `TaskGroupList.ts:366` reads `group === 'interrupted'` and `:580`
  `working`; 24 files in `ui/` read one of `statusKey`, `group`, `tone`,
  `status`, `durableOutcome`, `working`, `live`, `statusNotice`.

**The better design.** R6's: `position`, `outcome`, `holder`, `pendingRequest`,
`actions` on the view; one app function in `ui/copy/runStatus.ts` returns
`{ word, tone, glyph, indicatorClass }`; the three tables collapse into that
function's one `tone → glyph` row, and `canContinue`/`idle` become
`actions.includes(...)` reads.

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
  `renderIconOrSpinner` can branch on it (`:180-188`). Every caller already
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
  twice in this file (`:5,327`) and again in `toolFormatters.ts:13-15` and
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
`TooltipController.ts` is deleted (2 callers). One copy feedback: the
controller, with `copyWithFeedback` deleted (2 callers move to a
`copy-button` element or the controller).

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
  `Surface.inquiryDrafts` (`ExternalInquiryPanel.ts:70-83,98-113`), while
  `SessionComposer` "holds no draft of its own" (`SessionComposer.ts:14-15`)
  and reads the surface on every render. Two owners of a draft in one
  shell. It also decodes `permission.data` with `decodeUnknownSync` and caches
  the result by reference (`:116-126`) because the view hands it a `JsonValue`
  record for a plugin request.
- `RequestPanels.requestKey` decides that "Retry is keyed by `runId` instead
  of `requestId`: one pending retry per run, a new one replaces it"
  (`RequestPanels.ts:70-79`): an identity rule of the request model written
  in the renderer. The view's `requests` list could carry stable keys (or a
  retry could keep its id).
- `TaskGroupList.transcriptTimeline` re-roots groups whose parent is absent
  (`TaskGroupList.ts:119-121,511-514`), a shape the group rows could refuse
  (a `parentGroupId` must name a group in the same transcript, else it is
  `null`).
- `generatePastedImageName` mints `pasted_<Date.now()>_<6 hex>.<ext>` in the
  renderer (`shared/utils/pastedImageName.ts:7`) and the host stores under
  that name (`savePastedImage` → `savedImage.fileName`,
  `sessionFrames.ts:97-100`): the name is an identity the store should mint
  (content address or sequence), returned in the outcome as it already is.

**The better design.** `RunView.facts` → `documentRoundsOf(run)` is passed as
`rounds` to `FileList` (one property); `documentsOf` is deleted (2 callers)
and `sortedRounds`/`failureByPath` with it. The inquiry panel reads
`surface.inquiryDrafts.get(key)` for its field values and dispatches
`inquiryDraft` on input as the composer does; `draftRestored` and the
debounce go (the surface's `PersistedState` write is already debounced by
the host). Pending request keys: the harness gives a retry a stable
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
  (`packages/extension/src/commands/extensionCommandHandlers.ts:47-53`), used
  to make `EXTENSION_COMMAND_HANDLERS` `satisfies Record<…>` (`:166`). The
  handler map's keys *are* the membership; the flag exists to let the type
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
list of ids, typed over `CommandId`.

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
  (`shared/session/hostSnapshot.ts:22,29-32,49-51,115-118`): `dependency:
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
  guessed bound, where `terminal.write(text, cb)` alone is the completion.
- **`subscribeToSignalChanges`** (`shared/signals.ts:76-110`) is a hand-rolled
  watcher with microtask coalescing and a re-arm-in-`finally` rule explained
  in 12 lines; its two consumers (`sessionSurfaces.ts:201`, settings state)
  could be `Stream`s off the `SubscriptionRef`s the runtime already holds,
  since `toSignal` (`:17-37`) is the one bridge the file says should exist.
- **`ipc.ts:95`** false comment (finding 5).

---

## Good modules in this area

- `shared/session/surface.ts` `applySurfaceAction` (`:519-612`): one pure
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
  boundary, converted once.
- The R6 fields the UI reads (`group`, `tone`, `statusKey`, `status`, ...):
  found in round 1 (C1, C2, C9); finding 7 adds only the UI-side count and
  the disagreeing tables.
- `settingsView/frontend` living under `packages/extension/src` yet mounted by
  the desktop (`packages/desktop/src/renderer/settingsDialog.ts:4`): AGENTS.md
  lists it as a VS Code-free zone; area N's.
- `flushableDebounce`'s re-entrancy rule: documented against a measured
  library defect (`shared/utils/flushableDebounce.ts:12-18`); its three
  consumers are UI timers (tooltip delay, copy reset, draft save), two of
  which finding 8 and finding 9 delete.
- `shared/constants/latexToolchain.ts`: area I's.
