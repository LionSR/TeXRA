# Q. The public surface, read from the consumers' side: design red flags

Area: `packages/harness/src/effect/`, the six entry files (`index.ts`,
`node.ts`, `host.ts`, `plugins.ts`, `schemas.ts`, `transcriptEntry.ts`),
`config/api-reports/`, `packages/{harness,llm}/docs/api/`, read from their
consumers: `packages/texra`, the hosts (`packages/{extension,desktop,cli}`),
`packages/trace-viewer` and the example ladder (`packages/harness/example/`;
there is no repo-root `example/`). Read-only.

**Commit.** Read on `main` at `4e32bb921018ccb4626c0fb47b25a2c2d365b5f4`
(after R6, #14789). `HEAD` moved to `f5981e74e4` while the audit ran; the two
commits between add only round-3 reports, so every source line cited here is
the same at both. Open PRs: #14741 (blob link kinds: `controllers/session/Database.ts`,
`rowCodec.ts`, `rowReader.ts`, `storeAside.ts`, `storeSchema.ts`) and #14773
(docs only). No finding below sits in a file either rewrites. Package A of the
order note holds `hostRunActions.ts`; package B holds `SessionBridge.ts`,
`packages/texra/src/shared/` and `ui/progress/`; the findings that touch those
say so.

Paths are relative to `packages/harness/src` unless they start with
`packages/`, `src/` or `config/`.

**Method.** Exports per entry are the names in `config/api-reports/*.api.md`.
An importer is a file with `import { … } from` or `export { … } from` the entry's
specifier (no file imports a harness entry with `import * as`). Production is
`packages/{texra,extension,desktop,cli,trace-viewer}/src`; "example" is
`packages/harness/example`; "test" is everything else (`src/test-kernel`,
`packages/*/test`, `packages/cli/scripts`, `packages/desktop/{tests,design-harness}`).
Tests also reach harness internals through path aliases; those imports are not
counted, since they do not use the public surface. Script:
`/tmp/claude-0/-home-user-TeXRA/c8ea0043-6cf7-5d60-bf23-7aa369222841/scratchpad/counts.mjs`.

## Numbers

Lines: `effect/` 1,563 (7 files), entry files 1,307 (6 files). Generated:
`packages/harness/docs/api/` 10,471 lines (712 KB, `host.md` 2,899),
`packages/llm/docs/api/` 1,730; `config/api-reports/` 920 lines but
8,958,565 bytes.

Largest hand-written files: `schemas.ts` 353, `effect/sessions.ts` 302,
`host.ts` 288, `effect/sessionPrograms.ts` 280, `effect/processLayer.ts` 257.

Comment share, files ≥ 200 lines: `effect/sessions.ts` 54% (166/302: an
interface file, acceptable), `effect/processLayer.ts` 37% (97/257),
`host.ts` 25% (72/288), `effect/requestAnswerer.ts` 24% (56/233),
`effect/sessionPrograms.ts` 23% (66/280).

Primitives in `effect/`: `SubscriptionRef.getUnsafe` 3
(`runHandle.ts:152`, `sessionPrograms.ts:151`, `sessionReads.ts:201`),
`Deferred.doneUnsafe` 1 (`requestAnswerer.ts:199`, R8's attach), `Effect.never`
1 (`requestAnswerer.ts:170`, holding a recorded decision until the view drops
its request: the primitive used right), module-level `let` 1
(`sessionReads.ts:113`, finding 7), closure `let` 2 (`runHandle.ts:61`,
`sessionPrograms.ts:164`, R2's), `Effect.ignore` 1 (`runHandle.ts:161-166`,
item 8a), `uninterruptibleMask` / `Effect.uninterruptible` / `addObserver` 0.

The surface, per entry:

| Entry                          | Exports |          No production importer | No importer anywhere | One production file | One production package | Production files importing it |
| ------------------------------ | ------: | ------------------------------: | -------------------: | ------------------: | ---------------------: | ----------------------------: |
| `@texra-ai/harness`            |      59 |                              27 |                   15 |                   8 |                     16 |                           148 |
| `@texra-ai/harness/host`       |     174 |                              56 |                   50 |                  36 |                     48 |                           291 |
| `@texra-ai/harness/node`       |      51 |                               7 |                    5 |                  13 |                     21 |                            99 |
| `@texra-ai/harness/plugins`    |     126 |                              55 |                   49 |                  41 |                     67 |                            83 |
| `@texra-ai/harness/schemas`    |     260 |                              63 |                   51 |                  77 |                    112 |                           398 |
| `@texra-ai/harness/transcript` |      81 |                              26 |                   24 |                  32 |                     40 |                            91 |
| `@texra-ai/llm`                |      96 | 48 (app; harness counted apart) |                   11 |                  29 |                     38 |                           111 |
| `@texra-ai/llm/node`           |      25 |                              14 |                    8 |                   8 |                      9 |                            15 |

Of the 194 harness names nothing imports, 5 are values no public signature
names (dead on the surface: `storeHeld`, `senderOf`,
`approvalPolicyDenialMessage`, `RunViewSchema`, `ResumeBlockedSchema`; item
8c). The rest are types and error classes a public signature names (`HeldRun`
for `LocalSession.held`, `Composition` for `Sessions.layer`); the reports
expand type aliases, so the split between those and unnamed types cannot be
read from the reports alone, and none is counted as a defect here. llm is
fine: every llm value has a consumer (the harness, the app or the examples);
its 19 unimported names are signature types.

Two report lines are 2,344,506 and 2,344,552 bytes: `GlobalDatabase` and
`ProjectDatabases` on `./node` (`harness.node.api.md:21,42`), 4,689,058 of the
report set's 8,958,565 bytes (finding 2).

## The embedder's path, measured

Starting one run (`example/02-session-and-events.ts:10-87`) takes three
harness entries and `effect`: `nodePlatform({ agentsDir, storageDir,
workspaceDir })` (`./node`), `Sessions.layer({ platform, plugins:
harnessBuiltins })` and `Sessions` (root, `./plugins`), `sessions.open(platform.roots)`,
`session.start({ agent, instruction, model })`, `run.events.pipe(responseText)`,
`run.result`. That is the minimum the 2026-10-29 review counted (11 concepts;
`.agents/docs/evidence/2026-10-29-design-review/deep-modules.md`, its item 5
proposes the defaults that would remove two): FOUND, still open.

What this audit adds is what the embedder meets after the first run, where
the root entry's promise ("What an embedder needs to know", `index.ts:8-18`)
stops holding:

- **Writing a tool** takes root (`defineTool`, `ToolResult`), `./plugins`
  (`executed`, `ToolError`, `ToolContext`) and, as soon as the tool reads a
  file, a setting, a key or logs on a channel, `./host`, which says "an
  embedder that runs agents from a program needs none of it" and "No
  stability promise" (`host.ts:3-4,12-13`). Finding 1.
- **Branching on a refused launch** works for a named agent
  (`AgentNotFound`), but the same miss through `config`, an unknown model or
  an unknown tool is a `RunFailure` whose reason is read with
  `launchNoticeOf` from `./host`, which `Session.start`'s own TSDoc points to
  (`effect/sessions.ts:213-214`). Finding 5.
- **Handling every request error** means handling `Internal` and `Invalid`,
  which the harness never raises. Finding 4.
- **Stopping a run** has two doors, `run.interrupt` and
  `session.request({ kind: 'run.stop' })`, and the first swallows the
  refusal. Item 8a.
- **Finding a name**: `RunId` is on root and on `./schemas`; the examples
  import it from `./schemas` (`example/08-crash-and-resume.ts:27`,
  `10-external-plugin.ts:26`, `_evidence.ts:12`). Finding 6.

---

## Finding 1. The plugin authoring surface spans three entries; `./plugins` is not its closure

**Red flags:** information leakage (which entry holds an authoring name is
something a plugin author learns by trial); overexposure of `./host` (an
unstable host door that plugin bodies depend on); change amplification for an
external plugin.

**Evidence.**

- `./plugins` describes itself as "what a tool or plugin is written with
  (`definePlugin`, `ToolContext`)" (`index.ts:34-35`; `plugins.ts:16-23`).
  But `defineTool` is on root (`index.ts:91`), only its options type on
  `./plugins` (`plugins.ts:68`); `ToolResult` is on root (`index.ts:93`, 17
  production importers, all in `packages/texra/src/tools/`), `ToolError` and
  `executed` on `./plugins` (`plugins.ts:88,121-125`); `Plugin` is on both
  (`index.ts:47`, `plugins.ts:49`).
- `PluginToolServices`, the context every plugin tool body may require, is
  exported from `./plugins` (`plugins.ts:143-147`) and names `WorkspaceFs` and
  `StorageFs` (`agent/runtime/ToolServices.ts:64-69`), which only `./host`
  exports (`host.ts:181-187`). Its own doc says "A tool takes `WorkspaceFs`
  from context" (`ToolServices.ts:55-63`).
- The harness's own rules send plugin code to `./host`: logging is
  `Effect.log*` with `withLogChannel` (root `AGENTS.md`, "Logging";
  `host.ts:272`), catalog settings are read with `Settings`
  (`packages/harness/AGENTS.md`, "Catalog settings"; `host.ts:279-288`), and
  `SESSION_CLOSE_DEADLINE_MS` is documented as "a plugin's drain fits it"
  (`host.ts:146-147`).
- Measured on the app's plugins: 49 of the 97 files under
  `packages/texra/src/tools/` import `./host`, for 30 distinct names
  (`withLogChannel` 23 files, `Settings` 10, `Secrets` 9, `pathToLocationIn`
  5, `WorkspaceFs` 4, `SettingsStores` 4, `AgentCatalog` 4, `withPerKeyLane`
  3, `AppSignals` 3, …). All 30 files that define a tool import root and
  `./plugins`; 21 of them also import `./host`. Of the 75 `tools/` files that
  import the harness, 48 import from three or more entries and 9 from five or
  six.
- The external-plugin example never meets the gap: `acme-notes` imports root
  and `./plugins` only (`example/acme-notes/index.js:8-9`) because its one
  tool reads nothing, logs nothing and has no setting.

**The design decision behind it.** The entries were cut by the history of
who first needed a name (the hosts, through `./host`) rather than by
audience. The plugin author is an audience the surface names
(`./plugins`), but the names its body uses were exported where the hosts
already imported them.

**The better design.** One entry per audience, and `./plugins` is the whole
authoring closure: everything a tool body or a plugin layer names. Move, with
no new name: `defineTool`, `DefinedTool`, `ToolResult` and `ITool` from root;
`WorkspaceFs`, `StorageFs`, `Settings`, `SettingsStores`, `Secrets`,
`PlatformSecrets`, `withLogChannel`, `AppSignals`, `emitAppSignal`,
`SESSION_CLOSE_DEADLINE_MS` from `./host`. The rule is checkable by reading:
every tag in `PluginToolServices` is exported by `./plugins`. Root keeps the
session door (an embedder passing `start({ tools })` imports `./plugins` for
`defineTool`, as it already does for `harnessBuiltins`); `./host` keeps what a
composition root composes. Deleted: nothing; 13 to 14 names change entry,
`./host` shrinks from 174 to about 164 names and root from 59 to 55. Callers
afterwards: a tool file imports `./plugins` (and `./schemas` for browser-safe
helpers such as `toErrorMessage`), never `./host`.

**What we give up.** Import churn: the import lines of 207 production files
(`withLogChannel` alone has 110 importers, hosts included, which then import
it from `./plugins`). Hosts importing `./plugins` for a log helper reads oddly;
the alternative home is root, which the 2026-10-21 design wants near 30
names. Risk: none at run time; `npm run docgen` rewrites three reports.

**Change amplification.** "An external plugin with one tool that reads a
workspace file, its setting and its API key, and logs": today 4 entries (root,
`./plugins`, `./host`, `./schemas`), one of them without a stability promise;
after: 2 (`./plugins`, `./schemas`).

**Depends on:** none. Land with finding 6, which moves names by the same
rule.

---

## Finding 2. The store's write door is on the public surface and in every tool's context type

**Red flags:** information leakage (the store's full interface, row drafts
included, in public declarations); overexposure (two tags with no consumer
outside the harness on `./node`, and in the context type every tool,
process child and host program is given); a public declaration that names an
unexported type.

**Evidence.**

- `./node` exports `GlobalDatabase`, `ProjectDatabases` and `ProcessIdentity`
  (`node.ts:46-57`). `ProjectDatabases` and `ProcessIdentity` have no
  importer in production, the examples or the tests' public imports
  (consumer counts 0/0/0); inside the harness two modules read
  `ProjectDatabases` (`controllers/session/readSessionView.ts:79`,
  `controllers/session/appStateStore.ts:217`) and one `ProcessIdentity`
  (`controllers/session/Database.ts:203`).
- `ProjectDatabases` is `RcMap<string, Database['Service']>`
  (`shared/session/database.ts:324-327`): every project store's whole
  interface, `appendAll(drafts)` (`:206`), `job` (`:214`), `runRemoval`
  (`:268`) and `deletions.collect` (`:278`) included. `SessionEventDraft` is
  on `./schemas` (`schemas.ts:133`).
- Both are in `PlatformServices` (`platform/processRuntime.ts:89-104`), hence
  in `RunServices` (`agent/runtime/ToolServices.ts:48-53`), in
  `PluginToolServices` (`:64-69`, exported from `./plugins`), in
  `ProcessTurn.run`'s requirements (`agent/runtime/processRun.ts:65`) and in
  `ProcessServices` (`effect/processLayer.ts:49`). So a plugin tool may
  `RcMap.get(yield* ProjectDatabases, storage)` and `appendAll` rows, past the
  `SessionEvents` inbox `packages/harness/AGENTS.md` names as the one
  publisher ("Every write to a session's event table is a job on the
  `SessionEvents` inbox"). It is held by convention only.
- Of the 19 process tags a plugin tool may require, the 97 app plugin files
  name 8 (`FileSystem`, `Path`, `ChildProcessSpawner`, `HttpClient`,
  `Secrets`, `GlobalValues`, `AppSignals`, `AgentCatalog`); the built-in tool
  bodies none of `ProcessIdentity`, `GlobalDatabase`, `ProjectDatabases`,
  `StateStores`, `UsageLog`, `RouteRetries` (only engine modules,
  `tools/liveTools.ts`, `tools/agentCatalogFollower.ts`, read `AppState`,
  `AgentDirectories`, `ToolRegistry`).
- `GlobalDatabase` is declared `Pick<Context.Service.Shape<typeof Database>,
  'values' | 'inputHistory'>` (`database.ts:317-320`). Its runtime shape is
  narrow (the CLI's refusing stand-in implements just those two members,
  `packages/cli/src/runtime/cliProcessRuntime.ts:100-113`), but its
  declaration is the full store: the API reference prints `typeof Database`
  and `Database['Service']` (`packages/harness/docs/api/node.md:266-271,582-587`)
  though no entry exports `Database`, and the report expands both into
  2.3 MB lines (`config/api-reports/harness.node.api.md:21,42`), so every
  change to a row draft rewrites two unreadable public-surface lines.
- Why they are in the context at all: `readSessionView` (`./host`, 1
  production importer, `packages/texra/src/controllers/server/taskList.ts:84`)
  requires `ProcessProbe | ProjectDatabases | ProcessIdentity | ToolRegistry`
  (`controllers/session/readSessionView.ts:71-79`), and the host runtime
  serves it from `ProcessServices`.

**The design decision behind it.** The process context was typed as
"everything the composition built", so internal store handles leaked into
the context of every program that runs on it, and from there onto the
entries that export that context's members.

**The better design.** The store's handles stay beneath the session
composition. `ProjectDatabases` and `ProcessIdentity` are provided to the
session and state-store layers with `Layer.provide` inside the composition
(not merged into its output), leave `PlatformServices` and leave `./node`;
`readSessionView`'s requirement goes with finding 3. `GlobalDatabase` gets its
own interface, `{ values: CurrentValues; inputHistory: { read; append } }`,
declared where it is, so its public declaration no longer names `Database`.
Deleted from the surface: `ProjectDatabases`, `ProcessIdentity`,
`ProcessProbe` (`node.ts:56-57`); from `PlatformServices`: two members. The
CLI's input history and the refusal stand-in keep `GlobalDatabase` unchanged.
Afterwards a plugin that requires `ProjectDatabases` does not compile, and
`harness.node.api.md` shrinks from 4.7 MB to about 16 KB.

**What we give up.** The test kernel's fault injection reads `ProjectDatabases`
from the process context (`src/test-kernel/support/storeFaults.ts:141-144`,
`crashConformance.ts:371-375`); its runtime (`testKernel.ts`) must merge the
tag itself through the internal alias. Risk: `ownerProcessLayer` is
`Layer.provideMerge`d whole today (`effect/processLayer.ts:229`); splitting
its output is a change in `controllers/session/sessionLayer.ts`, R8's file.

**Change amplification.** "Add a field to a row draft": today the public
report diff includes the two 2.3 MB lines; after: none. "A plugin writes a
row": today compiles; after: a type error.

**Depends on:** none for `GlobalDatabase`'s own interface. The two tags leave
`PlatformServices` after finding 3 removes `readSessionView` from `./host`.

---

## Finding 3. "The projects under a storage root" is walked twice, and the app restates the harness's record and storage layout

**Red flags:** information leakage (a global-root record's name, its shape
and the storage directory layout known in two packages); two representations
of one schema; error handling for a case the shape already refused.

**Evidence.**

- The harness keeps a `workspace-store` record per project store
  (`WORKSPACE_STORES`, `shared/session/valueFamily.ts:43-46`, schema
  `Schema.Struct({ root: Schema.String.check(Schema.isMinLength(1)) })`),
  written at open (`controllers/session/appStateStore.ts:120-123`) and walked
  by storage maintenance: list the records, take
  `path.dirname(resolveWorkspaceStoragePath(storageRoot, undefined))` as the
  stores' directory, join each key (`controllers/session/projectDatabase.ts:61-75`).
- The app walks the same records the same way for its task list
  (`packages/texra/src/controllers/server/taskList.ts:56-92`): it imports
  `WORKSPACE_STORES` and `resolveWorkspaceStoragePath` from `./node`
  (`:15-18`; `WORKSPACE_STORES`' only production importer), spells the layout
  trick again (`:61-63`), and calls `readSessionView` from `./host` for each
  store not open (`:84`; `readSessionView`'s only production importer).
- It also restates the record's schema as `WorkspaceStoreSchema`
  (`taskList.ts:28-30`, identical to `valueFamily.ts:45`) and decodes
  `record.value` with it (`:66-75`), warning "it names no folder". But
  `GlobalValues.list` already decodes every row with the family's schema and
  dies on a mismatch (`controllers/session/currentValues.ts:62-70,146-157`),
  so the second decode cannot fail and the warning is dead.
- The walk's caller passes the sessions it has open (`open: ReadonlyMap<string,
  Session>`, `taskList.ts:55`) so it can read a live view instead of a cold
  one: a fact `Sessions.list` already holds (`effect/processLayer.ts:114`).

**The design decision behind it.** "Which projects this storage root holds"
has an owner (the global root's records, written by the harness), but no
read was exported for it, so the one app consumer exported the record, the
layout and a cold view read instead.

**The better design.** Compared two shapes:

- (a) One harness read, `projectStores(storageRoot): Effect<readonly { storage:
  string; workspace: string }[]>`, used by `readStorageInventory` and by
  `listTasks`. Deletes `WORKSPACE_STORES` from `./node`, `WorkspaceStoreSchema`
  and its dead warning, the second layout spelling. Leaves `readSessionView`
  on `./host` with its requirements.
- (b) One member of the process's `Sessions`, which already knows the storage
  root and its open sessions: `Sessions.projects: Effect<readonly { workspace:
  string; view: SessionView }[], DatabaseOpenFailed>`, a live view for an open
  session and a cold one (today's `readSessionView`, internal) for the rest.
  Deletes also `readSessionView` and `ActivationViewSource`'s sibling export
  pattern from `./host`, the `open` parameter, and with it the reason
  `ProjectDatabases`, `ProcessIdentity` and `ProcessProbe` are in the host
  runtime's context (finding 2).

Choose (b): it removes four exports and one parameter, where (a) removes one
export. `listTasks` keeps only its summary and limit (`taskList.ts:33-45,94-99`).

**What we give up.** (b) adds one member to an interface embedders see; it is
general (any persistent embedder lists its projects), but it is new surface.
The per-store isolation (`taskList.ts:82-91`: one damaged store is reported and
left out) moves into the member, which must keep it.

**Change amplification.** "Add a field to the workspace-store record (a
label)": today `valueFamily.ts`, `appStateStore.ts`, `projectDatabase.ts`,
`taskList.ts` (schema and read): 4 files in 2 packages; after: the first three.

**Depends on:** none.

---

## Finding 4. The app bridge's error vocabulary sits in the harness's request contract and on the SDK's root

**Red flags:** information leakage (the app's webview bridge protocol in the
harness); errors not defined out of existence (`Session.request` declares two
failures it never produces); special and general mixed in one union.

**Evidence.**

- `RequestErrorSchema`, whose type is `Session.request`'s failure
  (`effect/sessions.ts:238-240`), has seven members
  (`shared/session/runtimeRequest.ts:300-310`). Two are documented as not the
  runtime's: `Invalid`, "a bridge's answer, never the runtime's" (`:294-297`),
  and `Internal`, "A handler died … the surface hears that the request failed"
  (`:288-292`).
- No harness file constructs either. `Internal` is raised by the app's
  service handlers and webview bridge (`packages/texra/src/controllers/server/handlers.ts:127`,
  `packages/texra/src/controllers/session/SessionBridge.ts:405`); `Invalid` by
  the bridge and the webview transport (`SessionBridge.ts:328`,
  `packages/texra/src/ui/progress/sessionTransport.ts:174`). Every reader of
  `RequestErrorSchema` is app wire code: `packages/texra/src/shared/session/sessionFrames.ts:131`,
  `controllers/server/protocol.ts:199,257`, `SessionBridge.ts:133`,
  `ui/progress/sessionSurfaces.ts:248`.
- The bridge's own fold rule is also harness code on the root entry:
  `HostRequestFailure` ("How a host's request handler fails … the bridge
  folds onto the wire", `runtimeRequest.ts:312-323`), `RequestRefusal` and
  `isRequestRefusal` ("the four a handler may answer the surface with",
  `:325-341`), exported from root (`index.ts:115-126`). Consumers: 8, 7 and 7
  production files, all host request handlers and the bridge
  (`extensionHostRequests.ts`, `desktopToolEditApproval.ts`,
  `SessionBridge.ts`, `hostCallFailure.ts`, `runActionPolicy.ts`, …); 0
  examples.
- The classes are split across entries besides: root has `Cancelled`,
  `Conflict`, `Internal`, `RunActive`, `Rejected`, `Unavailable`
  (`index.ts:115-126`); `./schemas` has `Cancelled`, `Invalid`, `Rejected`
  (`schemas.ts:175-185`). Root's "Every failure is a tagged error listed
  below" (`index.ts:24-26`) omits `Invalid`.

**The design decision behind it.** The request union was written once for
the wire between a webview and its host, then reused as the runtime's own
answer type, so the wire's extra cases became the runtime's.

**The better design.** The harness's `RequestErrorSchema` is the five errors
the runtime raises (`RunActive`, `Unavailable`, `Cancelled`, `Rejected`,
`Conflict`), and `Session.request` fails with those. The app's wire declares
its union once as `RequestErrorSchema.mapMembers((members) => [...members,
Invalid, Internal])` in `packages/texra/src/shared/session/`, where `Invalid`
and `Internal` are defined; `HostRequestFailure`, `RequestRefusal` and
`isRequestRefusal` move to `packages/texra/src/controllers/session/hostCallFailure.ts`,
beside the fold that uses them. Deleted from the harness: 5 symbols
(`Internal`, `Invalid`, `HostRequestFailure`, `RequestRefusal`,
`isRequestRefusal`) and their 5 entry exports. The five runtime errors live on
`./schemas` only (finding 6), so a browser surface can match all of them.
`packages/texra/src/ui/copy/requestErrors.ts:8-23` switches over the app's
union.

**What we give up.** An embedder that builds its own bridge defines its own
"unparsable" and "handler died" errors; they are its bridge's facts. Risk:
`sessionFrames.ts` and `SessionBridge.ts` are package B's files and J2 (lane
3.5) rewrites the same response shape.

**Change amplification.** "A new runtime refusal": today `runtimeRequest.ts`
(class and union), a choice of root or `./schemas`, `isRequestRefusal`'s
membership, `requestErrors.ts`: 4 files and a decision in the bridge's rule;
after: `runtimeRequest.ts`, `schemas.ts`, `requestErrors.ts`.

**Depends on:** none. Borders J2 (`.agents/docs/evidence/2026-11-06-design-red-flags-round-2/J-ui-kit.md`
finding 2); land with lane 3.5 or before it.

---

## Finding 5. A refused launch has two types and crosses the service in four conversions

**Red flags:** two representations of one fact (an unknown agent is
`AgentNotFound` or a `RunFailure` by input shape); error handling instead of a
type (a host digs the reason out of an untyped `cause`); a public interface
whose doc sends the reader to the unstable entry.

**Evidence.**

- `start` types two refusals, `LaunchError = AgentNotFound | ToolsRefused`
  (`effect/errors.ts:70`; `LaunchError` has 0 importers). `AgentNotFound` is
  raised only when `input.agent` is a name (`effect/sessionPrograms.ts:107-116`).
- Every production start passes `config` (`packages/texra/src/controllers/session/hostRunActions.ts:222`,
  `controllers/server/handlers.ts:319`, `packages/cli/src/runtime/executeCli.ts:153`,
  `packages/cli/src/chat/chatSessionController.ts:489`). On that path the same
  miss is converted to `AgentError({ notice: { event: 'agentNotFound' } })`
  (`agent/runtime/AgentLaunchContext.ts:63-77`); an unknown model is
  `AgentError({ notice })` too (`:25-44`); `start` wraps every such failure in
  `RunFailure` (`sessionPrograms.ts:165-167`), as it does an invalid persona,
  an invalid config (`:122-134`) and a run id already in use (`:149-158`).
  The comment there says the schema refusal "reaches an embedder's `catchTag`
  in the vocabulary the surface names" (`:117-120`); the tag it reaches is
  `RunFailure`, documented as "A run that failed on its own" (`errors.ts:49-51`).
- The reason is read back with `launchNoticeOf(error: unknown)`, which peels
  `RunFailure.cause` and returns `AgentError.notice` (`agent/runtime/HostInteractions.ts:323-338`;
  `./host`, 4 production importers); `AgentError.notice` has no other reader.
  `Session.start`'s TSDoc points embedders there (`effect/sessions.ts:213-214`).
- Across the background service the fact is converted four times: harness
  `AgentError.notice` → `RunFailure.cause` → `launchNoticeOf` into
  `TaskFailed.notice` (`controllers/server/handlers.ts:323-327,402-406`;
  `protocol.ts:145-150`) → `refusedByService` rebuilds
  `RunFailure({ cause: new AgentError({ notice }) })`
  (`controllers/server/serviceSession.ts:242-258`) → each window's
  `launchNoticeOf` again.

**The design decision behind it.** The 1.0 PRD made `RunFailure` mean "this
activation has no readable end", including "the run never started"
(`.agents/docs/proposed/architecture/2026-10-28-harness-1-release-prd.md:285`).
That put refusals the caller caused and failures it did not into one tag, and
the refusal's kind into a field of a general error.

**The better design.** One tag for a refused launch: `LaunchRefused`, a
`Schema.TaggedError` with `message` and `notice: LaunchNoticeSchema`, in
`effect/errors.ts`, so `LaunchError = LaunchRefused | ToolsRefused`. The two
raise sites in `AgentLaunchContext.ts` raise it; the named-agent path's
`AgentNotFound` becomes `LaunchRefused({ notice: agentNotFound })` at the same
boundary, and the decode refusals and a duplicate run id become
`LaunchRefused` without a notice. `RunFailure` keeps "no readable end". The
service's `task.start` and `task.resume` declare `LaunchRefused` in their
`error` and carry it as itself, as requests already carry their classes.
Deleted: `AgentError.notice` (`common/errors/agentErrors.ts:21-23`),
`launchNoticeOf` (4 importers), `TaskFailed.notice`, `refusedByService`'s
`AgentError` wrap, and the second conversion at `AgentLaunchContext.ts:66-77`.
Hosts write `Effect.catchTag('LaunchRefused', ({ notice }) => …)`.

**What we give up.** Hosts' `catchTag('RunFailure')` sites (4 production
files) split into two cases. A `RunFailure` no longer reaches an embedder for
an input it supplied.

**Change amplification.** "Carry a refused launch across a new process
boundary": today 4 conversions and a field on the wire error; after: the RPC
names `LaunchRefused`. "A new host shows refused launches": today it learns
`launchNoticeOf` on `./host` and that `RunFailure` wraps; after: one
`catchTag`.

**Depends on:** none for the type. G5 and R10 (lane 2.2, package A) own the
presentation sites in `hostRunActions.ts`; land the type before or with 2.2.

---

## Finding 6. Which entry holds a name follows no rule

**Red flags:** information leakage (a consumer must know an entry map no
document states); conjoined / vague names (`./schemas` is the home of the
surface's most-imported error helper; `./transcript` of the hosts' process
runtime wrapper); a comment substituting for design.

**Evidence.**

- 22 internal modules, beside the `@shared/schemas` barrel, are re-exported
  by two or more entries, each with part of their names. Examples:
  `@utils/text/stringUtils` (six names on `./schemas`, `schemas.ts:235-242`;
  five on `./transcript`, `transcriptEntry.ts:161-167`); `@utils/errors/errorMessage`
  (four on `./schemas`, `schemas.ts:194-199`; `causeChain` on `./host`,
  `host.ts:241`); `@utils/files/fsEntryExists` (three on `./node`,
  `node.ts:102-106`; `isNotADirectoryError` on `./host`, `host.ts:243`);
  `@shared/tools/toolDisplayName` (three on `./transcript`,
  `transcriptEntry.ts:121-125`; `mcpServerOfToolName` on `./host`,
  `host.ts:200`); `@platform/processRuntime` (`./host`, `host.ts:53,85`;
  `./transcript`, `transcriptEntry.ts:67-70`); `@shared/session/runtimeRequest`
  (root and `./schemas`, finding 4).
- `host.ts:237-239` documents the split instead of removing it: "a failure's
  message with its classification (`toErrorMessage` is in `./schemas`)".
  `toErrorMessage` is the most-imported name on the surface (125 production
  files), from an entry named for schemas.
- 14 names are exported by two entries, and consumers pick inconsistently:
  `RunId` root 0 / `./schemas` 92 production importers (and all four example
  importers use `./schemas`); `RuntimeRequest` 1 / 13; `RequestDecision` 0 / 6;
  `PendingRequest` 0 / 4; `CommitOrdinal` 0 / 3 (`./transcript`);
  `DisplaySessionEvent` 0 / 1; `Rejected` 15 / 3; `Cancelled` 6 / 1;
  `RequestError` 2 / 3; `ExportNode` root 0 / `./host` 3; `Plugin` root 2 /
  `./plugins` 0; `AgentRunListingEntry` 1 / 0; `RunResult` 1 / 0;
  `RunWorkspaceFile` `./host` 0 / `./schemas` 0.
- The two browser-safe entries are one set to the bundle rule ("Browser
  bundle: use @texra-ai/harness/schemas or /transcript", `.oxlintrc.json:128-132`)
  and are imported together by 53 production files. `./transcript` also holds
  process plumbing: `withForkFailureReporting` is imported from it by the
  three Node hosts' process runtimes (`packages/cli/src/runtime/cliProcessRuntime.ts`,
  `packages/desktop/src/main/platform/index.ts`, `packages/extension/src/extension.ts`).

**The design decision behind it.** A name was added to whichever entry its
first consumer already imported, so the entries record the order names were
needed in, not what they are.

**The better design.** Two rules, stated in each entry's header: a source
module's names are exported by one entry, and a name by one entry. Concretely:
root drops its twelve duplicates (the types and request classes stay on
`./schemas`, `ExportNode` on `./host`, `Plugin` on `./plugins`); the request
classes live together on `./schemas`; `stringUtils`' eleven names on one
browser-safe entry; `causeChain` joins its module on `./schemas`,
`isNotADirectoryError` its module on `./node`, `mcpServerOfToolName` its module
on `./transcript`. Compared: merging `./transcript` into `./schemas` (one
browser-safe entry, about 340 names) answers the question "which of the two"
for good, but turns the renderer's coherent entry into a larger grab-bag; the
per-module rule keeps both and costs fewer import lines. Choose the rule.
Deleted: 14 duplicate exports; the comment at `host.ts:237-239`. No new lint
rule (root `AGENTS.md`: the open work is the surface, not another rule); a
reviewer reads the rule in the entry header and the report diff.

**What we give up.** The root imports of 20 production files move, plus the module splits' importers; the 2026-10-21
design's root list (`.agents/docs/proposed/architecture/2026-10-21-harness-general-package-design.md:193-200`)
names `RunId`, `RequestDecision`, `PendingRequest` on root, so that list is
revised to "what only an embedder needs".

**Change amplification.** "Add a browser-safe helper to `stringUtils`":
today the author picks between two entries with no rule (both are used);
after: the module's entry. "Find where `X` is exported": today up to six
entries; after: the module's one.

**Depends on:** none. Land with finding 1.

---

## Finding 7. A transcript subscription is a caller-named string port; five names are minted five ways, and the window session keeps a second port table

**Red flags:** information leakage (a key protocol, "pick a unique name;
subscribing `[]` releases it", known by every caller); reinvented primitive
(a scoped resource written as a name plus a release-by-empty-set); a module
counter; two public shapes for one operation.

**Evidence.**

- The table: `TranscriptSubscriptions.set(port, set)`, "an empty set removes
  the port" (`controllers/session/sessionSources.ts:88-123`), behind
  `SessionViewAccessShape.subscribe(port, set)` (`shared/session/sessionViewAccess.ts:33-38`).
- Public shapes: `LocalSession.view.subscribe(set): Effect<void, never, Scope>`
  is scoped (`effect/sessions.ts:261-263`); `RemoteSessionView.subscribe(port,
  set)` (`controllers/session/SessionView.ts:139-142`, on `./transcript`) and
  `ActivationViewSource.subscribe(port, set)` (`effect/runHandle.ts:37-40`, on
  `./host`) are port-keyed.
- Names minted: `sdk/reader/${N}` from a module-level counter
  (`effect/sessionReads.ts:113,193`); `sdk/${runId}/${crypto.randomUUID()}`
  (`runHandle.ts:60`); `watch/${N}` (`packages/texra/src/controllers/server/serviceSession.ts:349,432`);
  `'window'` (`serviceSession.ts:64`); `'shell'`
  (`packages/texra/src/ui/progress/sessionTransport.ts:60`). Releases are
  written by hand at three sites (`sessionReads.ts:196`, `runHandle.ts:79`,
  `serviceSession.ts:433-434`).
- The window session keeps its own port table to forward the union upstream:
  `watches: Map<port, set>` (`serviceSession.ts:299`), a union by id
  (`:306-313`), a lane, a generation counter and a hand-called `resubscribe`
  (`:300-347`), beside the harness table it also subscribes (`:315`).
- `activationView` detects a changed set by joining ids into a string
  (`runHandle.ts:61-69`, `let subscribed`).

**The design decision behind it.** Subscriptions were keyed by a name so a
caller could replace its set in place, and the name's lifetime was left to
each caller instead of a scope.

**The better design.** The subscription is a scoped value: `subscribe(set):
Effect<{ readonly set: (next) => Effect<void> }, never, Scope>` on
`TranscriptSubscriptions`, keyed inside by the entry object it registers and
released when the caller's scope closes; `set` replaces in place, which is
what the port name was for. `LocalSession.view.subscribe` is this, minus the
handle. `RemoteSessionView` and `ActivationViewSource` take the same shape.
For a caller that wants scoped replacement without a handle,
`ScopedRef.fromAcquire(subscribe(a))` then `ScopedRef.set(ref, subscribe(b))`
works: it acquires the new value before closing the old scope
(`node_modules/effect/src/ScopedRef.ts:230-236`), so the union never drops a
run between the two. The window session reads the union as a stream
(`SubscriptionRef.changes` on the table's ref) and drives `task.watch` with
`Stream.switchMap`, which deletes `watches`, its union and the hand-called
`resubscribe`. Deleted: `readerPorts`, the three port spellings in the harness
and the two in the app, three hand releases, `ActivationViewSource`'s port
parameter, `let subscribed`.

**What we give up.** Nothing a caller uses: no caller reads another's port.
Risk: the window's frames carry a generation (`graph.frames.begin(generation)`,
`serviceSession.ts:314`); `Stream.switchMap` must still number each upstream
subscription, which `Stream.zipWithIndex` or a `Ref` in the switch gives.

**Change amplification.** "A new reader that subscribes a transcript": today
it picks a unique port name and remembers to subscribe `[]` on every exit;
after: `yield* subscribe(set)` in its scope.

**Depends on:** none. The `serviceSession.ts` half is in the file the CLI
service note's PR 2 reshaped (`.agents/docs/proposed/architecture/2026-11-06-cli-service-root-causes.md`
§3.1, landed); it needs no root.

---

## 8. Smaller items, batched

- **(a) `Run.interrupt` forwards to `run.stop` and swallows its refusal.**
  `runHandle.ts:161-166` is `request({ kind: 'run.stop' })` under
  `Effect.ignore({ log: 'Warn' })`, so `RunActive` (another process holds the
  run) or `Unavailable` reach no caller; `serviceSession.ts:541-543` copies
  it. 0 production callers; the hosts send `run.stop`; three example uses
  (`example/05-durable-resume-and-fork.ts:108`, `10-external-plugin.ts:179`,
  `acceptance.ts:88`). The 1.0 PRD rejects methods on `Run` that only forward
  to `session.request` (recorded in
  `2026-10-21-harness-general-package-design.md:205-208`). Delete it; the
  examples write the request.
- **(b) Two conventions for a member with no argument.** `listRuns` and the
  eleven `RunRecords` members are `() => Effect<…>` (`effect/sessions.ts:195`,
  `effect/sessionReads.ts:51-84`); `Run.result`, `Run.interrupt`,
  `LocalSession.settled`, `HeldRun.drained`, `Sessions.closeAll`, `Sessions.list`
  are plain `Effect`s. An `Effect` is already a re-runnable description; the
  twelve thunks add a call and nothing else. Make them `Effect`s.
- **(c) Five values exported with no consumer and named by no signature:**
  `storeHeld` (`host.ts:99`), `senderOf` (`plugins.ts:175-178`),
  `approvalPolicyDenialMessage` (`schemas.ts:155`), `RunViewSchema`
  (`schemas.ts:51`), `ResumeBlockedSchema` (`transcriptEntry.ts:55`); plus
  `describeFollowUpFailure` (`host.ts:102`, one test importer only). The wire
  leaves `ExistenceReconciliationSchema`, `LocalRuntimeStateSchema`,
  `TextChunkSchema` and their types (`transcriptEntry.ts:50-63`) have no
  production importer: the app uses only their union, `SessionViewInputSchema`
  (`packages/texra/src/shared/session/sessionFrames.ts`). Drop them from the
  entries.
- **(d) A false comment.** `effect/errors.ts:2-4` says five errors are
  defined there, among them "a trace no reader can take"; the file defines
  four (`:30,41,51,58`). Fix it with the next change to the file.
- **(e) One `RunRecords` read is written five times.** Each member exists in
  `getRunRecords` (`agent/storage/runRecords.ts`), `sessionReads.ts:212-244`,
  `packages/texra/src/controllers/server/protocol.ts:264-322`,
  `handlers.ts:288-300` and `serviceSession.ts:559-583`, and its success type
  is a `./schemas` export whose only importer is `protocol.ts` (eight such
  names: `RunRecordFieldsSchema`, `RunResultSchema`, `RunWorkspaceFileSchema`,
  `ResumeRefusalSchema`, `SessionViewSchema`, `StartRequestSchema`,
  `AgentRunListingEntrySchema`, `ExportNodeSchema` on `./host`). This is the
  design the CLI service note's PR 2 landed ("mirrored as `records.*` and
  `session.*` procedures"); the count is new. An `RpcGroup` the harness owns
  (`RpcGroup.make`, `.prefix`, `.toLayer`; `node_modules/effect/dist/rpc/RpcGroup.d.ts:169,59,68`)
  would let the service and the window derive both sides; not proposed
  without the owner reopening that design.

## Found by round 1, round 2 or the root notes; this area's new angle only

- **`OpenOptions.host?: Record<string, never>`** (`effect/sessions.ts:85-93`)
  is a boolean written as an empty object: all four production opens pass
  `{ persistent: true, host: {} }` (`packages/extension/src/extension.ts:440-442`,
  `packages/desktop/src/main/desktopProjects.ts:286-288`,
  `packages/cli/src/runtime/cliService.ts:183`, `initPlatform.ts:330`), and it
  sets `approvalPromptsUnavailable` (`effect/sessionPrograms.ts:262-268`),
  which `SessionHost` can also set and `attach` overrides
  (`effect/requestAnswerer.ts:225-232`). R8 (B7, E8) makes that a boolean at
  attach; `OpenOptions.host` goes in the same PR.
- **`LocalSession.view.events(from, drained?)`** takes a `SubscriptionRef` the
  callee writes (`effect/sessions.ts:280-283`); its one caller is the CLI's
  progress drainer (`packages/cli/src/runtime/sessionProgressSubscription.ts:149`):
  R10's F6.
- **`start`'s `opened` flag and second `onInterrupt`** (`sessionPrograms.ts:164-176`):
  R2.
- **`LocalSession.held`'s two overloads and `HeldRun.modelSwitchDisabledReason`**
  (`effect/sessionReads.ts:86-132`): R2 and the CLI service note's liveness
  item.
- **`LocalSession.settled`** (`effect/sessions.ts:298-301`): R1's
  `settlement`.
- **`RunLabels` as the one difference besides the dispatcher between
  `Sessions.layer` and `processLayer`** (`effect/processLayer.ts:184-188`):
  `.agents/docs/proposed/simplification/2026-11-04-store-and-test-support-debts.md`
  B6.
- **The embedder's defaults** (`harnessBuiltins` required, `agentsDir` and
  `storageDir` required, `platform.roots` passed to the layer and to `open`)
  and **launch options renamed on the way down** (`interactive` →
  `stopAfterCycle`, `sessionPrograms.ts:206`): the 2026-10-29 review,
  `deep-modules.md` §3 items 3 and 5. Both still stand on `main`.

## Good modules in this area

- **`Run`** (`effect/sessions.ts:124-161`, `effect/runHandle.ts:108-168`): a
  view over the session's rows that holds nothing; leaving a stream stops the
  reading, never the run. `result` returns the stored `RunEnd`.
- **`followPendingRequests`** (`effect/requestAnswerer.ts:90-121`): one fiber
  per listed request in a `FiberMap` with `onlyIfMissing`, interrupted when
  the view drops the request, so a program holds its decision with
  `Effect.never` and releases it in a finalizer. Two app consumers reuse it.
- **`session.request` typed per kind** (`effect/sessions.ts:238-240`,
  `OutcomeOf`): the 2026-10-29 review's item 2, landed; no caller narrows an
  outcome by hand.
- **`Sessions.layer`** (`effect/processLayer.ts:133-152,250-256`): the plugin
  list is checked once at build and refused as `PluginsRefused` naming the
  plugin, before any session opens.
- **`withProcessServices`** (`effect/processLayer.ts:82-89`): the runtime's
  own cached context as a program, 14 production importers, no Promise hop.
- **The report and reference generator** (`scripts/check-api-report.mjs`):
  one type-checked program writes both, so a surface change shows as a diff in
  the PR that makes it. The packed-tarball ladder (`example/README.md`, run
  from `npm pack` output with `skipLibCheck: false`) is the only check that
  reads the surface from outside the workspace.
- **`@texra-ai/llm`'s surface**: every value has a consumer; the
  `./node` subpath (25 names) holds exactly the Node-bound binding and
  sign-in flows.

## Already settled, left alone

- No Promise entry: the 2026-09-21 ruling and #13723 item 8
  (`2026-10-21-harness-general-package-design.md:243-255`).
- `./host` kept as a subpath with no stability promise
  (`2026-10-21-harness-general-package-design.md:487-491`, owner question 2).
  Findings 1 and 6 move names off it by audience; they do not reopen its
  existence.
- The internal `shared/schemas/index.ts` barrel kept
  (`2026-10-21-harness-general-package-design.md:365-377`).
- `withPerKeyLane` on `./host`: `EFF-ADOPT-per-key-lane-semaphore`;
  `jitteredExponentialBackoffMs` on `./plugins`: `EFF-ADOPT-jitter-helper-stays`;
  `executeCommand` on `./node`: `RT-execute-command-lift`; `ConfigProvider` on
  `./host`: `EFF-ADOPT-config-provider`; `chatgptCoordinator` and
  `xaiCoordinator` on `@texra-ai/llm/node` with consumers in two packages:
  `LLM-subscription-credential-facade`.
- `SessionHost`'s presentation events and `HostInteractions`' replay queue on
  `./host`: R8 (B7, E8) and the 2026-10-30 comparison
  (`.agents/docs/evidence/2026-10-30-harness-design-against-pi-durable-and-deepseek/texra.md`,
  item 5).
- `viewDiagnosticsLayer`'s level rewrite (`./transcript`): round 2's M11.
- `AppState.layer`'s faked `changes`, `AgentPlatform.commandDirs?`,
  `WorkspaceRoots.globalStorage` and `globalState`: round 2's M8.
- The window's second `Run` (`serviceSession.ts`'s `runOf` beside `runView`):
  the CLI service note §3.1; `activationView` is shared since its PR 2.
- `RunFailure` meaning "no readable end, or never started": the 1.0 PRD
  (`2026-10-28-harness-1-release-prd.md:285`). Finding 5 narrows it on new
  evidence (the four-step round trip, the two types of one miss) and says so.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

| Finding | Hand-written today                                                                                                    | Primitive or structure, and the declaration checked                                                                                                                                                                                                                                                                                                                           | Why it fits                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1       | authoring names spread over root, `./plugins`, `./host`                                                               | none: an export map. The tags `PluginToolServices` names are `Context.Service` identifiers (`dist/Context.d.ts:196`), exported beside the union that names them                                                                                                                                                                                                               | a context type is only usable where its tags are importable                                                            |
| 2       | `GlobalDatabase` as `Pick` of the full store; `ProjectDatabases`, `ProcessIdentity` merged into `PlatformServices`    | `GlobalDatabase` as a `Context.Service` with its own shape (`dist/Context.d.ts:196`); the store tags fed to the session and state layers with `Layer.provide` (`dist/Layer.d.ts:1752`), which keeps a dependency out of the output, instead of `Layer.provideMerge` (`:2169`); `Layer.effect` (`:1166`) builds the layers as today                                            | a dependency a layer consumes need not be in its output; the type then refuses a plugin that requires the store        |
| 3       | two walks of `WORKSPACE_STORES`, a restated schema, a cold read exported for one caller                               | one `Effect.fn` (`dist/Effect.d.ts:18880`) member of `Sessions`, reusing a held connection with `RcMap.getOption` (`dist/RcMap.d.ts:520`) as `readSessionView` does, over the records with `Effect.forEach` (`dist/Effect.d.ts:972`)                                                                                                                                          | one owner reads the record it writes; the open sessions are already its own                                            |
| 4       | the bridge's `Invalid` and `Internal` in the runtime's union; the fold rule on root                                   | the runtime's `Schema.Union` (`dist/Schema.d.ts:4147`) of five `Schema.TaggedError`s (`:11985`); the app's wire union as `.mapMembers` (`:4118`) over its `.members` (`:4101`)                                                                                                                                                                                                | the wire extends the runtime's vocabulary in the package that owns the wire                                            |
| 5       | `RunFailure` wrapping `AgentError.notice`; `launchNoticeOf(unknown)`; `TaskFailed.notice` and a rebuilt `AgentError`  | `LaunchRefused` as a `Schema.TaggedError` (`dist/Schema.d.ts:11985`) in `LaunchError`; hosts use `Effect.catchTag` (`dist/Effect.d.ts:4392`); the service's `Rpc.make(tag, { error })` (`dist/rpc/Rpc.d.ts:505`) carries the class as itself                                                                                                                                  | a refusal is a typed failure the caller branches on, not a field found by peeling causes                               |
| 6       | names placed by first consumer                                                                                        | none: an export map with two stated rules                                                                                                                                                                                                                                                                                                                                     | naming and ownership                                                                                                   |
| 7       | string ports, a module counter, release by subscribing `[]`, a second port table with a lane and a hand `resubscribe` | `Effect.acquireRelease` (`dist/Effect.d.ts:12676`) returning a handle with `set`; `ScopedRef.fromAcquire` / `ScopedRef.set` (`dist/ScopedRef.d.ts:53,130`; acquires the new value before closing the old, `src/ScopedRef.ts:230-236`); the window's upstream as `SubscriptionRef.changes` (`dist/SubscriptionRef.d.ts:134`) into `Stream.switchMap` (`dist/Stream.d.ts:2505`) | a subscription's lifetime is its scope; "latest set wins upstream" is a switch over a stream, not a lane and a counter |
| 8a      | `Run.interrupt` under `Effect.ignore`                                                                                 | none: delete; `session.request` already answers with the typed refusal                                                                                                                                                                                                                                                                                                        | one door, one error channel                                                                                            |
| 8b      | twelve `() => Effect` members                                                                                         | plain `Effect` members (an `Effect` re-reads each time it runs)                                                                                                                                                                                                                                                                                                               | one convention                                                                                                         |
| 8e      | one record read in five files                                                                                         | `RpcGroup.make` / `.prefix` / `.toLayer` (`dist/rpc/RpcGroup.d.ts:169,59,68`), `RpcClient.make` (`dist/rpc/RpcClient.d.ts:140`); not proposed                                                                                                                                                                                                                                 | recorded for the owner; the landed design chose mirroring                                                              |

Primitives the brief names and no finding here uses: `Latch`, `FiberMap`
(already used right in `followPendingRequests`), `Semaphore`, `Queue`,
`PubSub`, `RcMap` beyond `getOption`. This area's problems are placement and
typing, not hand-written concurrency: `effect/` holds no
`uninterruptibleMask`, no `addObserver` and one module-level `let`.
