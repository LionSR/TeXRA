# N. The VS Code extension, the desktop app and the trace viewer: design red flags

Area: `packages/extension/src/`, `packages/desktop/src/` (main, renderer,
shared, preload), `packages/trace-viewer/`. Read-only, at the working tree of
2026-11-06. Paths are repo-relative. Consumer counts are over
`packages/*/src` unless stated.

Found before this round and not repeated: R10's hosts (`admitLaunch` in both
binding tables, `useCurrentFile`'s 68 lines, the `GuiSession` union; the
`2026-11-06-cli-service-root-causes.md` "Status" says the union, the
presenter and the toolbar refusals landed), and §3.3's windows and attach
(notice round-trips, `editorHost` keyed by storage root, two windows on one
project). Where a finding below touches one of those it says so and adds
only the new angle.

## Numbers

Lines (`.ts`/`.mjs`, excluding tests and `dist/`):

| Subtree                                    | Lines  |
| ------------------------------------------ | ------ |
| `packages/extension/src`                   | 17,142 |
| `  settingsView/` (frontend 7,330 of it)   | 7,900  |
| `  frontend/`                              | 4,742  |
| `  commands/`                              | 2,015  |
| `  progressView/`                          | 1,514  |
| `  common/`, `extension.ts`, `commands.ts` | 971    |
| `packages/desktop/src`                     | 15,045 |
| `  main/`                                  | 7,534  |
| `  renderer/`                              | 6,135  |
| `  shared/` + `preload/`                   | 1,376  |
| `packages/trace-viewer`                    | 468    |

Five largest files: `packages/desktop/src/renderer/main.ts` 940,
`packages/extension/src/progressView/ProgressViewProvider.ts` 817,
`packages/desktop/src/renderer/editorPane.ts` 705,
`packages/extension/src/extension.ts` 615,
`packages/desktop/src/renderer/workbenchController.ts` 612.

Comment-line share (`^\s*(/\*|\*|//)` over total) of the five worst files
≥ 200 lines: `extension/src/settingsView/frontend/settingsState.ts` 45%
(114/249; mostly section banners and a header that explains the reset
registry), `desktop/src/main/desktopPtyHost.ts` 30% (81/265; a pending/live/
disposed hand-off in prose, finding 8), `extension/src/frontend/latex/openBuild.ts`
25% (86/341), `desktop/src/main/desktopDiffHost.ts` 25% (67/262; why two
temp-dir removals exist), `extension/src/frontend/setupTerminalRunner.ts`
25% (58/226). Next: `desktopWindows.ts` 24%, `desktopWindowOnboarding.ts`
24%, `desktopWorkspaceIpc.ts` 23%, `desktopProjects.ts` 21%.

Primitives in scope: `new Promise` 0; `.then(` 9 (`editorPane.ts` ×3, the
pty loader, two Lit `updateComplete`s, the trace viewer ×2, the rejection
surface ×1); `setInterval` 1 (`logsPane.ts:294`, a log poll); `setTimeout`
0; `catch {` with an empty or comment-only body 5 (all documented: two in
`desktopAppLog.ts`, `desktopPtyHost.ts:149`, `terminalPane.ts:142`,
`desktopAppLog.ts:181`); `Effect.run*` entry sites 4, `runtime.run*`
(`ProcessRuntime`) 32; `Effect.uninterruptible` 4 (all in
`desktopProjects.ts`); `Semaphore.make` 3; `withPerKeyLane` 12;
`Deferred.` 9; optional interface fields `x?:` 58; module-level mutable
`let` in the renderer entry 8, in `editorPane.ts` 14. The hints' "silent
catches" in `ProgressViewProvider.ts`, `commands.ts`, `extension.ts` and
`setupAssistantCommand.ts` are `Effect.ignore({ log: 'Warn' })` or
`catchCause` → log sites, not silent; not findings.

---

## Finding 1. "Open a window's session" is written by all three hosts

**Red flags:** information leakage (a six-step protocol known by three
modules); repetition; change amplification.

**Evidence.** The decision "a window's runs run in the service when it is
reachable, else here", with its consequences, is spelled out per host:

- `packages/extension/src/extension.ts:429-451`: `reached` → `serviceSession(link, root, roots)`,
  else `Sessions.open(roots, { persistent: true, host: {} })`,
  `recordFirstCompletedRun(session)`, `hosts.localLink(session)`, warn
  `storeMovedAside`; plus `:217-227` (`openNodeWorkspaceRoots` with the
  spread `workspaceState: serviceProjectState(...)`) and `:198-216`
  (`openTexraConfigStores` with a warn callback).
- `packages/desktop/src/main/desktopProjects.ts:260-301` (`openProjectSession`: the same
  six steps, `host: {}` at `:288`), `:373-398` (the same stores and roots
  spread, `serviceProjectState` at `:393`), `:244-252` (`warnInDialog`).
- `packages/cli/src/runtime/initPlatform.ts:319,337`, `packages/cli/src/runtime/cliService.ts:186-190`
  (the third copy; area K, cited for the count).

`serviceProjectState(` has 3 production callers, one per host;
`recordFirstCompletedRun(` 3; `storeMovedAside` is read in 4 host files;
`hosts.localLink(` 2 (GUI hosts). `GuiSession`
(`packages/texra/src/controllers/session/openGuiWindow.ts:104-107`) is now a
plain `{ session, link }` pair, so the union R10 named is gone, but each
host still assembles the pair by hand.

**The design decision behind it.** "Where does this project's session
live, and what does opening it entail" is answered by every host that
opens one instead of by the module that knows what a session is.

**The better design.** The window's session is a scoped resource built by
one layer: `GuiSessionLive = Layer.effect(GuiSession, openProjectSession)`
(`Layer.effect` runs its effect in the layer's scope, Layer.d.ts:1166;
`Layer.scoped` does not exist in 4.1.2), where `openProjectSession` is one
program in `packages/texra/src/controllers/session/` (area G's directory;
the deletion is this area's): `Effect.acquireRelease(sessions.open(...), close)`
or `serviceSession(...)`, then `recordFirstCompletedRun` (already
scope-bound) and the moved-aside notice through the window's `emit`. The
hosts build the window under `Layer.build`/`Effect.provide` of that layer
in the scope they already open (`desktopWindow.ts:95-101`,
`extension.ts:391-397`), so the session closes with the window and nobody
calls `dispose()` by hand. The config-store and roots assembly
(`openTexraWorkspaceConfigStores` + `openNodeWorkspaceRoots` with the
service's `workspaceState`) goes with it as a second `Layer.effect`
(`WorkspaceRootsLive`). Deleted:
`extension.ts:198-227,429-451` (~55 lines), `desktopProjects.ts:260-301,373-398`
(~65 lines), the CLI's copy; `warnInDialog` (2 callers, both this flow).
Callers write `const window = yield* openProjectSession(root, { service })`.

**What we give up.** The desktop's `warnInDialog` shows the moved-aside
notice as a native dialog before the window exists; through `emit` it would
queue for the first window (the replay class the CLI note keeps). Nothing
else.

**Change amplification.** "A session gains a second open-time notice (a
schema upgrade applied)": today 3 host files + the harness; after: the one
opener + the harness.

**Depends on:** none.

## Finding 2. The host binding tables carry whole flows where the host owns one verb

**Red flags:** overexposure / pass-through (a port with one real
implementation; a binding that re-decides what the shared body decides);
information leakage (an error tag's construction, a title's wording, a
picker's cancel convention known by both hosts).

**Evidence.** `packages/extension/src/progressView/extensionHostRequests.ts`
(544 lines) and `packages/desktop/src/main/desktopHostRequests.ts` (281)
both fill `SharedHostRequestBindings` and `GuiWindowHost`
(`openGuiWindow.ts:194-262`). Side by side:

| Member                   | Extension                                                                                                                                                    | Desktop                                                                                                   | Shared knowledge restated                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs.openFinalOutput`   | `openFinalOutputIfAvailable(roots, config)(result)` (`:508-509`), which is `selectAutoOpenFinalOutput` + show (`frontend/agents/finalOutputOpener.ts:22-52`) | `selectAutoOpenFinalOutput(...)` then `host.openPath` (`:225-230`)                                        | which output auto-opens; `selectAutoOpenFinalOutput(` has exactly these 2 callers                                                                              |
| `openLabel`              | `openLabel(roots, label)` = `findLabelInWorkspace` + `openInEditor` (`commands/files/openFileCommands.ts:62-65`)                                             | `findLabelInWorkspace(roots.workspace, label, host.openPath)` (`:134-137`)                                | the label search; `findLabelInWorkspace(` has exactly these 2 callers                                                                                          |
| `files.acceptEditedFile` | `handleAcceptEdited` = `validateFilesExist` + `acceptEditedFileReplace` with VS Code `confirm` (`commands/latex/compareCommands.ts:141-167`)                 | `acceptEditedFileReplace(..., { confirm, showInfo })` (`:249-257`)                                        | the confirm-then-replace flow; the extension adds a `catchCause` → toast → `false` the desktop does not                                                        |
| `files.compareFiles`     | `handleCompare` builds `` `Compare: ${edited} ↔ ${base}` `` (`compareCommands.ts:98`)                                                                        | builds `` `Compare: ${edited} <-> ${base}` `` (`:238`) and words `DiffViewUnavailable` (`:86-92`, 3 refs) | the compare title, spelled two ways                                                                                                                            |
| `export.openPath`        | wraps in `new ExternalOpenFailed({ kind: 'path', target, message, cause })` (`:178-206`)                                                                     | the same wrap (`:264-275`)                                                                                | the export's tag; `ExternalOpenFailed(` is constructed at 8 sites, 5 of them in these two hosts                                                                |
| `own.pickFiles`          | `selected ? files : Effect.fail(new Cancelled())` (`:349-355`)                                                                                               | `paths === null ? Cancelled : files` (`:193-201`)                                                         | "`null` means cancelled"; `new Cancelled()` 6 sites                                                                                                            |
| `latexdiff.withProgress` | VS Code notification progress (`:402-410`)                                                                                                                   | `task({ report: () => undefined })` (`:155`)                                                              | a port with one implementation                                                                                                                                 |
| `admitLaunch`            | reads `vscode.workspace.workspaceFolders` (`:232-247`), against the AGENTS.md rule "never `vscode.workspace.workspaceFolders`"                               | `() => Effect.void` (`:139`)                                                                              | R10's deletion, still standing; the extension reads the same VS Code fact again at `ProgressViewProvider.ts:290-294` for the launcher's working-directory list |
| `openGuide`              | `texraGuideUrl(page, anchor)` then `openExternal` (`:420-427`)                                                                                               | `texraGuideUrl(page, anchor)` then `openExternalUrl` (`:168-169`)                                         | the URL; the binding could be `openExternal(url)`                                                                                                              |

Both hosts also build `new HostSnapshotReadFailed({ member: 'fileOptions', message: 'The … file lists could not be read.' })`
around the snapshot source's own read (`ProgressViewProvider.ts:283-289`,
`desktopProjectBindings.ts:273-279`; 3 construction sites, all in hosts),
and both carry the instruction-action button labels as a table beside the
shared tokens (`frontend/events/agentEventListeners.ts:69-91`:
"Open Settings Guide"; `desktop/src/main/desktopDialogs.ts:20-22`:
"Configuration Guide"), with `instructionActions(` called in 3 places.

**The design decision behind it.** The binding interface is "what the body
needs done", written as flows the hosts happen to share, rather than "what
only this host can do": open a path, show a document, confirm, open a diff,
reveal a file, open a URL. Everything above the verb (the selection, the
search, the confirm order, the title, the tag, the cancel reading) is a
decision the shared body should make once.

**The better design.** `SharedHostRequestBindings` becomes the verb set:
`openPath(file, line?)`, `showDocument`, `openExternal(url)`, `confirm(message)`,
`openDiff(base, edited, title)`, `pickFiles(fileType): Effect<readonly string[] | null>`
(the body reads `null` as `Cancelled` once), `revealInOs`. The body owns
`selectAutoOpenFinalOutput`, `findLabelInWorkspace`, `acceptEditedFileReplace`,
the compare title, the export tag wrap, the `HostSnapshotReadFailed`
member wrap (inside `HostSnapshotSource`), the instruction labels (in
`@ui/copy/instructionActions` beside the tokens), and the guide URL.
`withProgress` goes: the body reports diff progress as a notice, which the
extension's `emit` may show as a progress notification. `admitLaunch` goes as
R10 says, with `roots.workspaces` captured once at activation (today
`WorkspaceRoots` has no such field: `packages/harness/src/platform/workspaceRoots.ts:17-54`),
which also replaces the second `workspaceFolders` read at
`ProgressViewProvider.ts:290`. Deleted: `openFinalOutputIfAvailable` (1
caller), `openLabel` (1), `handleAcceptEdited` (1), `DiffViewUnavailable`,
two `ExternalOpenFailed` wraps, two `Cancelled` maps, two label tables,
three `HostSnapshotReadFailed` wraps, `LatexdiffHost.withProgress`, both
`admitLaunch`s. About 150 lines across the two host files and 60 in the
extension's command modules.

**What we give up.** The extension's `handleAcceptEdited` catches every
failure into a toast and answers `false`; through the body it fails with
its tag and the card shows it (the same change the CLI note made for the
toolbar actions). The desktop's `<->` becomes `↔`.

**Change amplification.** "A new host-request kind that opens a file at a
label" today: `hostRequest.ts`, `openGuiWindow.ts`, both host files (4);
after: `hostRequest.ts`, `openGuiWindow.ts` (2). A fourth GUI host today
writes ~280-540 lines of bindings; after, about 60.

**Depends on:** none. The `roots.workspaces` field is R10's and can come
with it.

## Finding 3. The onboarding funnel is wired twice, the setup launch twice, and the credential answer cached a third time

**Red flags:** two representations of one fact; reinvented Effect primitive
(a boolean double-click guard with `forkDetach` + `ensuring`); temporal
hand-off in prose; repetition.

**Evidence.**

- The extension's `OnboardingFunnelRefresher` (`ProgressViewProvider.ts:192-215`) and
  the desktop's (`desktopWindowOnboarding.ts:104-121`) are built with the same
  three members; both fork `followFirstRunDone` (`ProgressViewProvider.ts:407-418`,
  `desktopWindowOnboarding.ts:201`); both spell `skip` as
  `setOnboardingDeclined(state, true)` then refresh (`extensionHostRequests.ts:438-441`,
  `desktopWindowOnboarding.ts:127-128`) and `skipSetup` as `setFirstRunDone`
  (`extensionHostRequests.ts:456`, `desktopWindowOnboarding.ts:129`).
- The extension keeps `credentialUsable` (`ProgressViewProvider.ts:133`), written
  inside the API-key banner producer (`:312`) and read by the funnel's
  `hasCredential` (`:201`), so a refresh must run the banner first; the
  comment at `:195-198` and `refreshApiKeyStatus` (`:140-146`) exist to keep
  that order. The desktop asks `hasUsableSetupCredential` directly
  (`desktopWindowOnboarding.ts:109-117`). The snapshot's `apiKeyBanner.visible`
  (`:323-325`) and the setup pill (`extension.ts:478`) are the same answer
  painted twice more.
- The setup assistant's launch is wired with five positional arguments in two
  places of the extension: `commands.ts:86-103` and
  `extensionHostRequests.ts:442-454`, each followed by its own funnel refresh.
- The desktop's "Run Setup" guard is `let setupKickoffStarted = false` with
  `Effect.forkDetach` and an `ensuring` that clears it
  (`desktopWindowOnboarding.ts:123-165`), with a 12-line comment explaining
  why: a `FiberHandle` (one in-flight launch, a second `run` is a no-op
  while it lives) is the primitive.

**The design decision behind it.** "What is the funnel state, and what
does each card action do" is decided per host, over a shared planner that
already decides it. The hosts differ in exactly two verbs (how a credential
is asked for, how the setup run is started) and one presentation (select
the setup agent on the launcher), and in nothing else.

**The better design.** `openGuiWindow` owns one refresher per window: it
builds `OnboardingFunnelRefresher` from `hasUsableSetupCredential(roots)`
under the project's environment layer, publishes the state into a
`SubscriptionRef<OnboardingFunnelState>` (`SubscriptionRef.make`, `.changes`:
SubscriptionRef.d.ts:93,134) that the snapshot and the extension's setup
pill both follow with one `Stream.runForEach` each, forks
`followFirstRunDone` (already a `Stream` over `StateStore.changes`), and
binds `skip`/`skipSetup` once. The extension's `credentialUsable`,
`refreshApiKeyStatus`, the ordering comment, and `paintSetupPill` as a
constructor callback go; the desktop's `funnel: State | null` goes because
the ref is seeded by the first refresh before the window attaches.
`runSetup` is `FiberHandle.run(setupLaunch, { onlyIfMissing: true })`
(FiberHandle.d.ts:542-549: a second `run` while the fiber lives is a no-op,
which is exactly the double-click guard, and the window's scope interrupts
it) over the window's `runValidated`; the two extension copies and the
desktop's boolean guard with its `forkDetach` + `ensuring` go. Deleted: ~90 lines in `ProgressViewProvider.ts`, ~100 in
`desktopWindowOnboarding.ts` (the file reduces to the two verbs),
`commands.ts:86-103`, `extensionHostRequests.ts:433-461`.

**What we give up.** The extension's "select the setup agent on entering
State 1" (`ProgressViewProvider.ts:202-213`) becomes a surface action the
body sends; the desktop would receive it too (today it discards that case:
`desktopWindowOnboarding.ts:99-103`), which is a behaviour change for the
desktop launcher. Acceptable or made a binding boolean the body reads.

**Change amplification.** "A new onboarding card action": today
`hostRequest.ts`, `openGuiWindow.ts`, `extensionHostRequests.ts`,
`desktopHostRequests.ts`, `desktopWindowOnboarding.ts` (5); after 2.

**Depends on:** none.

## Finding 4. The desktop window host decides "present or not" by building every port twice

**Red flags:** option for a special case (a boolean, an optional member, and
a second instance for one caller's case); special and general code mixed
(a presenter inside an opener); four error reporters for one fact.

**Evidence.** `packages/desktop/src/main/desktopWindowHost.ts:96-121` builds
`previewHost` (with `showErrorMessage`) and `requestPreviewHost` (without),
then `diffHost` and `requestDiffHost` over each. `desktopPreviewHost.ts:81`
makes `showErrorMessage` optional; `fail()` (`:106-119`) shows a modal then
fails when it is present; `openExternal` has two overloads on
`reportFailure` (`:150-180`, `reportFailure` 14 references); the window host
adds `openExternalProgram(url, reportFailure: boolean)` (`:129-144`, 5
refs) and `openExternalInBackground` (`:151-171`) with a different wording
for the same failure. Above those, four reporters: `reportBackgroundError`
(9 refs), `reportAsyncError` (11), `reported` (`:87-94`), `awaitOrReport`
(`:191-198`, 6). `forProject` (`:296-346`) then assembles three port records
(`run`, `toolEditPreview`, `request`) from the two instances.

**The design decision behind it.** "Who shows a failure" was answered at
the port (the opener shows a dialog and then fails) and then un-answered
for the request path by instantiating the port again without the dialog.
The CLI note's rule, "a notice is presented by the requesting window's
`emit`", landed one layer up; the layer below still carries the switch.

**The better design.** Ports never present. `openPath`, `openExternal`,
`openDiff` fail with their tag; the one presenter is a
`Context.Reference<Presenter>` (`Context.Reference(key, { defaultValue })`,
Context.d.ts:1741) whose default logs at warn, which the window provides
once with its dialogs: a port that needs no presenter takes no optional
member, and a call site that wants the dialog left out provides nothing
instead of constructing a second host. `reported` (already
`Effect.catchCause` → present) is the only report site for a window-level
program, and the session's `emit` the only presenter for run-time
failures. One preview host, one diff host, one `forProject` record. Deleted: `requestPreviewHost`, `requestDiffHost`,
`showErrorMessage?`, `reportFailure`, `openExternalProgram`,
`openExternalInBackground`, `awaitOrReport`, `reportBackgroundError` (its 9
callers become `reported` or a log), the `fail()` dialog (`PreviewUnavailable`
keeps its message; 25 references stay). About 120 lines.

**What we give up.** A failure in a menu action (not a request) that today
shows a native modal from inside `openPath` would be shown by the window's
reporter instead: same dialog, one site.

**Change amplification.** "Open a new kind of surface (a notebook tab) from a
run": today the preview host, both instances' wiring, and three
`forProject` records (4 edits in 2 files); after one host and one record.

**Depends on:** none.

## Finding 5. The renderer's reachability is a tri-state optional with a fallback that exists for tests

**Red flags:** silent degradation by design; option for a special case ("when
undefined the overlay is skipped entirely, which keeps tests … working");
information leakage (the diff title's grammar parsed back); renderer
compensating for data (a build counter to force a reload).

**Evidence.** `desktopIpcTypes.ts:45-53`: `postToRenderer?(message): boolean | void`,
three states for one fact; `tryShowInRenderer` (`:61-75`, 4 callers) turns
`undefined`, `false` and a throw into "fall back to the external
application" with a `source`/`fallback` string pair. `desktopWindowHost.ts:40-56`:
`let renderer: DesktopHostBridge | undefined`, `reachable()`,
`connectRenderer(next)` set once at `desktopWindow.ts:366`; the window
serves project bindings and requests before that line, so the "startup IPC
race" the comments name (`desktopDiffHost.ts:157-159`, `desktopIpcTypes.ts:48-50`)
is a window that answers requests before its renderer exists. `desktopDiffHost.ts:171`
recovers `displayPath` by `title.replace(/^Tool edit:\s*/, '')`, the grammar
`desktopToolEditApproval.ts:179` writes; `desktopPreviewHost.ts:99-100,257`
keeps `let builds = 0` so "its tab reloads however close in time two builds
land".

**The design decision behind it.** "Is there a renderer to show this in" is
read at every show instead of being a precondition of the window serving
anything; the bridge's absence is modelled as a port that may be missing.

**The better design.** `installDesktopHostBridge` runs before
`openProjectBindings` (it needs only `window`), so `post` is a required
member and `DesktopOverlayPostOptions.postToRenderer` is `(message) => void`;
a destroyed window is the binding scope's close, not a per-call check.
Where the bridge must stay a later event (the preload's `listening`
handshake), the window holds `Deferred<DesktopHostBridge>`
(`Deferred.make`/`succeed`/`await`: Deferred.d.ts:152,1405) and `post` is
`Deferred.await(bridge).pipe(Effect.flatMap(...))`: a show that arrives
before the renderer waits for it instead of falling back, and the window's
scope interrupts the wait.
`tryShowInRenderer` and the `source`/`fallback` pair go; the external
fallback remains only for the OS editor path when the user asks for it.
The diff message carries `displayPath` from the request
(`ToolEditPreviewRequest.relativePath`) and the title is the renderer's;
the `builds` counter becomes the PDF tab reload keyed by the build's output
path plus its `commit` (the row the build belongs to), which the renderer
already receives. Deleted: `tryShowInRenderer`, `postToRenderer?`,
`reachable`, `connectRenderer`, `DesktopOverlayPostOptions`, the title regex,
`builds`.

**What we give up.** A test that constructs a preview host with no renderer
constructs a fake `post` instead. Nothing user-visible.

**Change amplification.** "A third in-app overlay (a notebook viewer)":
today a new `tryShowInRenderer` site with its fallback strings, a
`postToRenderer?` plumb, a `reachable` read (3 files); after, one `post`.

**Depends on:** none.

## Finding 6. The progress view's two surfaces are four optional fields and a callback

**Red flags:** state machine in optional fields; a callback parameter with
one shape per caller; four readers of "which surface is showing".

**Evidence.** `ProgressViewProvider.ts:124-127`: `sidebarView?`, `sidebarPort?`,
`editor?: { panel, port }`, held in two shapes for the same thing (a view
and its port). `attach(id, view, onDisposed)` (`:572-585`) takes a callback
whose body is "clear the fields" at both call sites (`:471-474`, `:775-777`).
`closeSidebarPort` (`:588-591`) and `closePort` exist to clear them. The
rule "which surface a host action lands on" is read in `visibleSurfacePort`
(`:668-674`), `chime` (`:680-684`), `submit` (`:690-701`), `isViewVisible`
(`:703-707`) and again in `RequestAttention` through four getters
(`requestAttention.ts:23-31`, `:88-93`). `send` (`:545-570`) forks a
`tryPromise(postMessage)` per message with a comment asserting order.

**The design decision behind it.** A port's lifetime is tracked by hand
(set a field, clear it in a callback) when the port is already a `Scope`
(`Port.scope`, `:106-110`): the scope's close is the fact.

**The better design.** The two surfaces are one `FiberMap<'sidebar' | 'editor'>`
(`FiberMap.make`/`run`/`remove`: FiberMap.d.ts:115,1016,881): `attach`
is `FiberMap.run(map, id, acquireRelease(attachPort, close) + Effect.never)`,
VS Code's `onDidDispose` is `FiberMap.remove(map, id)` (interrupts, which
runs the release), and the provider's `dispose` is the map's scope close.
`onDisposed`, `closeSidebarPort`, `closePort`, the three fields and the
`Port.scope` hand-off go. `visibleSurfacePort`
is the one reader of that map; `RequestAttention` takes
`surface(): Port | undefined` and `reveal()` instead of six getters.
Deleted: `sidebarView`, `sidebarPort`, `editor` (as fields), `onDisposed`,
`closeSidebarPort`, `isViewVisible` (2 external callers:
`agentEventListeners.ts:184,196` read `visibleSurfacePort() !== undefined`),
`AttentionSurface.sidebar/panel/isViewVisible`.

**What we give up.** Nothing; the sidebar's "retained while hidden" rule is
the same map lookup with `view.visible`.

**Change amplification.** "A third surface (a status-bar quick panel)": today
three fields, two close helpers, four readers, `RequestAttention` (6 edits);
after one map entry.

**Depends on:** none.

## Finding 7. The desktop's open projects: a persisted list read back four times, lanes as a `Symbol`, a bindings map diffed by hand

**Red flags:** two representations of one fact; reinvented Effect primitives
(a per-key lane keyed by a `Symbol` as `Semaphore(1)`; a `Map` + `sync`
diff as `RcMap`; a `released` flag as a scope; `Effect.uninterruptible` ×4
around scope hand-offs); a sentinel (`funnel: State | null`).

**Evidence.** `desktopProjects.ts`: the `recent` list lives in
`DesktopProjectRecords` and is copied into the `SubscriptionRef` after
every write (`records.readRecent` at `:338,350,413,456`; `syncRecent`
`:349-352`), so `DesktopProjectsState.recent` is a cache of a store the
same module writes. `lanes = new Map()` with `selection = Symbol()`
(`:320-321`) and `withPerKeyLane(lanes, selection)` at `:352,361,420,470`
is one `Semaphore(1)` written through the per-key API; `withPerKeyLane(lanes, root)`
at `:431,472` and `Effect.uninterruptible` at `:322,401,444,499` protect
"acquire then install" sequences that an `RcMap` keyed by root performs
(`RcMap.get` opens once and shares, `RcMap.invalidate` closes; the CLI note
§2.2 already names `RcMap` for the service's projects, the same shape).
`desktopProjectBindings.ts:120,396-411`: `bindings = new Map` kept in step with
`projects.list()` by a `sync` that diffs; `:146-148` `let released = false`
guards late callbacks the binding's scope already ends; `:316-325` forks a
follower per binding and special-cases `funnel === null` for "not yet
refreshed".

**The design decision behind it.** The registry is a hand-maintained
projection of three sources (the records, the open sessions, the active
key) instead of one keyed resource map whose state is derived.

**The better design.** `DesktopProjectRecords` is the one owner of
`remembered`/`recent`; `DesktopProjectsState` is a
`SubscriptionRef<{ open, activeKey }>` (SubscriptionRef.d.ts:93) and the
menu reads `recent` from a change stream over the records (the same shape
`StateStore.changes([key])` gives `followFirstRunDone`,
`onboardingFunnel.ts:129`; the `CurrentValues` family needs that member).
Projects are `RcMap.make({ lookup: openProjectSession })` (RcMap.d.ts:215,
`idleTimeToLive` omitted: a project is released only by `invalidate`);
`open` is `RcMap.get(map, root)` in the window's scope (RcMap.d.ts:379;
a second `get` of an open root shares the entry, so `byRoot` goes), `close`
is `RcMap.invalidate(map, root)` (RcMap.d.ts:701) then `records.forget` in
one program; the `Symbol` lane, the four `uninterruptible`s (the map's
lookup is already run once per key and released by its own scope),
`syncRecent` and the four `readRecent` copies go. Bindings are a second
`RcMap.make({ lookup: bindProject })`; `sync` is
`Stream.runForEach(SubscriptionRef.changes(state), …)` doing `invalidate`
for keys no longer open and `get` for new ones, each entry in its own scope,
so `released` goes with the scope. The funnel is
`SubscriptionRef<OnboardingFunnelState>` seeded by the first refresh
(finding 3), so `null` goes. Deleted: ~90 lines in `desktopProjects.ts`, ~40
in `desktopProjectBindings.ts`.

**What we give up.** `RcMap.get` shares an entry while any scope holds it;
the desktop wants exactly one holder (the window), which is the `invalidate`
path. The risk is ordering on close: today `records.forget` runs before
`project.dispose()` under one lane; with `RcMap` it is `invalidate` then
`forget`, which must stay in one program.

**Change amplification.** "A project gains a per-project resource (a watcher)":
today `bindProject`, `release`, `sync`, `releaseAll` (4 sites); after
`bindProject` alone.

**Depends on:** finding 1 for the lookup; otherwise none.

## Finding 8. The editor pane keeps five generation counters and a promise lane, justified by a stale comment

**Red flags:** reinvented primitives (generation counters where
interruption is the fact; a promise chain as a per-key lane; a coalescing
rerun loop); state machine in optional fields; comment substituting for
design.

**Evidence.** `packages/desktop/src/renderer/editorPane.ts:126,134,135,51-52`:
`latestOpenRequest`, `refreshGeneration`, `treeRevision`, `writeEpoch`,
`activeWrites`, each compared after an `await` to drop a stale result
(`:262,266,272,381,461-469,497,529,566,574`). `onModelSyncLane` (`:436-446`)
chains promises per path and its header (`:421-435`) says it is
`withPerKeyLane` in promise form because "this renderer runs no Effect
programs: importing `effect` here would make all six of the pane's promise
boundaries Effect-file catch sites". The renderer entry already imports
`effect` (`renderer/main.ts:5`, and `messageRoutes.ts`, `settingsDialog.ts`,
`projectWorkbench.ts`, `logsPane.ts`), as do five `@ui/progress`
components. `refresh` (`:595-613`) is the same coalescing-rerun loop as
`OnboardingFunnelRefresher.run`. `FileState` (`:43-58`) has five optional
members (`model`, `viewState`, `pendingLoad`, `syncTail`, `disk`) whose
presence encodes unloaded / loading / loaded / syncing. The same pattern
recurs in `desktopPtyHost.ts:188-192` (`child`, `disposed`, `heldInput`).

**The design decision behind it.** "A newer request supersedes an in-flight
read" is modelled as "let the read finish and discard its result" (hence a
counter per kind of newer request) rather than "the newer request
interrupts the read".

**The better design.** One `FiberHandle` per file for its in-flight read or
save (`FiberHandle.run` interrupts the previous fiber unless
`onlyIfMissing`, FiberHandle.d.ts:117,542; `activeWrites`, `writeEpoch`,
`refreshGeneration`, `latestOpenRequest` go), one `FiberHandle` for the tree
listing (`treeRevision` goes), `Semaphore.make(1).withPermit` per file
(Semaphore.d.ts:253,95; `onModelSyncLane` and its header go), and the
pane's state as one `SubscriptionRef<EditorState>` whose `files` is
`Map<path, { _tag: 'unloaded' } | { _tag: 'loaded', model, disk, dirty }>`
with the view state beside: the tree template is one
`Stream.runForEach(SubscriptionRef.changes(state), renderTree)`, so the
nine hand-placed `renderTree()` calls go. The pane runs its programs on
one renderer `ManagedRuntime.make(Layer.empty)` (ManagedRuntime.d.ts:125,
Layer.d.ts:978; `Effect.run*` is allowed under `packages/desktop/src/`,
`.oxlintrc.json:185-218` bans only `vscode` and the harness's non-browser
entries there). The callbacks (`listFiles`, `readFile`, `writeFile`) become
Effects over the host bridge, which already answers `workspaceFile`
requests as `Effect<HostOutcome, Rejected>` on the main side
(`desktopWorkspaceIpc.ts:79-81`). Deleted: five counters, `onModelSyncLane`,
`refreshPromise`/`refreshQueued`, `pendingLoad`, `syncTail`, `editorLoad`,
about 150 lines of the 705.

**What we give up.** The pane's six promise `catch` sites become typed
recovery, which the comment estimated as the cost; the cost is the point.

**Change amplification.** "A second supersede case (a rename while a read
is in flight)": today a sixth counter and a check at every `await` (five
sites); after, one more `FiberHandle.run`.

**Depends on:** none.

## Finding 9. The desktop window's lifecycle is three mutable optionals beside a FiberSet, a Semaphore and a cached close

**Red flags:** state machine in optional fields; reinvented Effect primitive;
comments substituting for design.

**Evidence.** `desktopWindows.ts:107-109`: `current?`, `releasing?`,
`continueQuit?` encode closed / open / closing / closing-then-quit;
`onClosed` (`:117-139`) hands `release` from `current` to `releasing`,
clears it in an `ensuring`, and `setImmediate(resume)`s the quit;
`openWindow` (`:146-162`) caches the scope close with `Effect.cached`;
`open` (`:171-177`) is `Semaphore(1)` over `releasing ?? Effect.void`;
`reopen` is a `FiberSet.run` (`:104-106,179-194`). `desktopWindowLifecycle.ts:70-96`
adds `let quitting = false`. `desktopWindow.ts:141-143` says of its own
locals: "declared below and read only inside lazy callbacks; the order
cannot flip, since the surface takes the onboarding this call returns".

**The design decision behind it.** "The one window and whether it is
open" is modelled as a mutable handle plus a separate "its close in
flight" plus a separate "what to do after", when a window is one fiber
whose interruption is its close and whose exit is its release.

**The better design.** `FiberHandle<void>` for the window
(`FiberHandle.make`, FiberHandle.d.ts:110): `open` is
`FiberHandle.run(handle, { onlyIfMissing: true })(openWindow.pipe(Effect.andThen(Effect.never)))`
(FiberHandle.d.ts:542-549: a no-op while a fiber lives, which is what
`current ? Effect.void` does, and `opening`'s permit did), the `closed`
event is `FiberHandle.clear(handle)` (`:504`, interrupts and awaits the
window's scope), `released` is `FiberHandle.awaitEmpty(handle)` (`:774`),
and `continueQuit` is a `Deferred<void>` the `before-quit` handler
`Deferred.await`s after `awaitEmpty`; `releasing`, `onClosed`'s hand-off,
`quitting`, `setImmediate`, the `Semaphore` and the `FiberSet` go.
`Effect.cached` (Effect.d.ts:13539) stays where it is right: one close for
many awaiters is exactly what it memoizes. `desktopWindow.ts`'s forward references are resolved by
building `surface` before `onboarding` takes it, or by passing `settings` as
a `SubscriptionRef` the surface fills. About 60 lines.

**What we give up.** Nothing user-visible; macOS's "reopen after close"
becomes `run` again on the same handle.

**Change amplification.** "A second window per process": today every field
above becomes a map (6 sites); after a `FiberMap<WindowId>`.

**Depends on:** none.

## Finding 10. Tool-edit approval staging is implemented twice, down to the preview class

**Red flags:** base class with hooks written as two full subclasses;
information leakage (the staged-files layout and the dispose order known by
both hosts); a class whose methods are its fields' getters.

**Evidence.** `desktopToolEditApproval.ts` (233 lines) and
`extension/src/frontend/approval/VscodeToolEditApprovalHost.ts` (225) both:
make a directory (`:78-83` tmp vs `:69-74` storage), call
`writeApprovalTempFiles` (`:86-91` vs `:77-82`), construct a `ToolEditPreview`
over `{ originalPath, proposedPath }` with `originalPath()`/`proposedPath()`
getters (`:148-171` vs `:115-141`), `dispose(unapplied)` as close-diff then
remove then warn with `UNAPPLIED_TOOL_EDIT` (`:210-232` vs `:205-225`), and
a `warn`/`reportError` pair. The desktop re-declares the staged shape as
`DesktopStagedFiles` (`:142-146`) beside the shared `ApprovalTempFiles`. The
host-specific content is `openDiff`/`closeDiff`/`openPath`/`focused()` and
the title (two grammars: `:179` vs `:216-225`).

**The design decision behind it.** The controller (`ToolEditApprovalController`,
area G) delegates the whole preview lifetime to the host, so each host
re-implements the lifetime around its one verb.

**The better design.** The controller stages (one `writeApprovalTempFiles`
into a directory the host names) as `Effect.acquireRelease(stage, remove)`
in a `Scope.fork` of the request's scope (Scope.d.ts:493; its `close` is
the one dispose, running close-diff then remove in finalizer order), builds
the title once, and asks the host only for
`openDiff(original, proposed, title)`, `closeDiff()`, `openPath()`,
`focused()`. Both host classes reduce to that record (~40 lines each);
`DesktopToolEditPreview`, `VscodeToolEditPreview`, `DesktopStagedFiles`,
both `dispose`s, both `warn`s go.

**What we give up.** The extension keeps proposed text in the editor on an
unapplied edit (`keepProposedText`); that becomes the host's `closeDiff`
reading an `unapplied` argument, one branch instead of a method.

**Change amplification.** "A third thing a preview must stage (a rendered
PDF of the proposal)": today both `stagePreview`s, both preview classes,
both `dispose`s (6 sites); after the controller.

**Depends on:** the controller taking the lifetime (G); the host deletions
are this area's.

## Finding 11 (batched). Smaller instances of the same species

- **Three spellings of "not loaded yet" and an acknowledgement generation**
  in the settings frontend: `providerKeyStatuses: … | null` (`settingsState.ts:152-156`),
  `pluginsPage: … | null` (`:212`), `gitSettingsLoaded`/`latexSettingsLoaded`
  booleans beside their data (`:217,241`; set at `messageDispatcher.ts:120,166`),
  and `settingsSnapshotRevisions` (`:186-195`), a counter bumped per message
  so a number row "repaints the acknowledged value over the edit": a
  renderer compensating for a message that does not say whether it answers
  a write. One shape (`Loadable<T> = { _tag: 'loading' } | { _tag: 'loaded', value }`)
  and a reply that carries the request it answers.
- **`openFileInEditor`'s five options and a reason nothing reads**
  (`frontend/vscode/vscodeEditor.ts:126-136`): `save` and `reuseVisible`
  are set by one of ten callers (`frontend/latex/linter.ts:69-72`); the
  `reason` literal (`:21-25`) has zero readers outside the file ("it is a
  message, not a kind"). The linter's open-and-save is its own two-step
  program; `reason` becomes the message.
- **The trace viewer re-declares the reader's frame order** (`trace-viewer/src/traceFrames.ts:354-380`,
  with `:326-329` citing `sessionInputs.ts` and `sessionViewUpdate.ts` for
  why the listing is sent twice), and resets the shell by `cloneNode` and
  replace (`main.ts:93-101`) to get a "fresh generation"; the bridge keeps
  `cut`/`selected` as module `let`s (`traceHostBridge.ts:179-181`). The
  frame's input order is the reader's fact: expose one `frameFromRows(rows, subscribe)`
  from the harness's reader that both the live path and the trace use.
- **An ambient workspace fallback** at `frontend/latex/openBuild.ts:65`
  (`vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? dir`), against
  "there is no ambient fallback"; `roots.workspace` is in hand at every
  caller.
- **`WorkspaceHostCallFailed.member: Schema.Literal('ptyHost.create')`**
  (`desktopWorkspaceIpc.ts:123`): a one-value kind; and `desktopWorkspaceIpc.ts:403-407`
  lifts `ptyHost.create` with `Effect.tryPromise`, so the one consumer of
  the pty host's `create` is already an Effect program (see "Already
  settled" for what that does and does not reopen).
- **A log poll** (`renderer/logsPane.ts:294`, `setInterval`) where the main
  process already pushes `desktop:setLog` on request. The main side owns
  the file: `FileSystem.watch(logPath)` is a `Stream<WatchEvent>`
  (FileSystem.d.ts:324), debounced (`Stream.debounce`, Stream.d.ts:11372)
  and `Stream.runForEach`ed into `desktop:setLog` for as long as the logs
  tab is shown (a `FiberHandle.run` the show/hide route sets and clears);
  the renderer's interval, `active` and `refreshHandle` go.
- **The renderer entry's `applyingProjectList` flag** (`renderer/main.ts:181`,
  read at `:316,480,597,621,859`) is a hand-rolled "apply this batch without
  repainting" transaction over eight module-level `let`s (`shell`,
  `projectsKnown`, `recentProjects`, `renamingProjectKey`,
  `shellRenderQueued`, …). One `SubscriptionRef<Shell>` on the renderer's
  runtime (finding 8's `ManagedRuntime`): `desktop:projects` is a single
  `SubscriptionRef.update` (SubscriptionRef.d.ts:1248), so one change event
  reaches the one `Stream.runForEach(SubscriptionRef.changes(shell), rerenderShell)`
  subscriber and there is no intermediate paint to suppress; the
  `queueMicrotask` scheduler (`:199-206`) goes with it. `railProjects()`
  (`:215-218`) overrides the host snapshot's project name with a
  renderer-persisted rename (`projectName`, `shared/desktopShellState.ts:49`)
  that the main process's window title (`desktopWindowTitle.ts:20-30`) and
  dialogs never see: two owners of a project's name. The rename belongs in
  the records (finding 7) so every surface reads one.
- **Browser safety of the above.** `SubscriptionRef`, `Stream`,
  `FiberHandle`, `Deferred`, `Semaphore`, `Scope` and `ManagedRuntime` are
  core `effect` modules with no Node import; the Node-only surface is
  `@effect/platform-node` (a separate package) and `effect/process/*`. The
  renderer and the settings frontend already import `effect` core
  (`renderer/main.ts:5`, `settingsState.ts:25`) and may import only
  `@texra-ai/harness/schemas` and `/transcript` (`.oxlintrc.json:201-218`),
  which is enough: a frontend subscribes by forking one
  `Stream.runForEach(SubscriptionRef.changes(ref), paint)` on its runtime,
  and `paint` sets the Lit signals the components already read
  (`sessionSurfaces.ts:74-76`); nothing in the frontend reaches the
  harness's `/host` or `/node` entries. The progress frontend under
  `packages/texra/src/ui/` stays as it is: `Effect.run*` is banned there
  and its signals are fed by the host bridge, not by a ref.

---

## Good modules in this area

- `packages/desktop/src/main/desktopWindow.ts` as a composition root: one
  router over `commandRoutes` with a duplicate-owner check (`:272-277`), one
  run site per command (`:302`), session messages addressed by key (`:307-324`),
  everything in the window's scope. Keep its shape; findings 9 and 5 trim
  what it composes.
- `packages/desktop/src/main/desktopProjectRecords.ts`: two lists as one
  stored value, one `update`, every list operation a pure function of the
  previous value. The registry should read from it, not copy it.
- `packages/desktop/src/main/desktopIpcTypes.ts` `parsedRoute`: a schema
  per inbound command, drift logged, no program run on a malformed message.
- `packages/extension/src/progressView/requestAttention.ts` as a reading
  of `attentionOf` (the shared rule) with no decision of its own; its
  surface interface is finding 6's only complaint.
- `packages/extension/src/commands.ts`'s registration loop over
  `EXTENSION_COMMAND_HANDLERS` through `dispatchCommandFromRegistry`: one
  execution boundary, the same dispatch as the desktop.
- `packages/trace-viewer/src/traceHostBridge.ts`'s idea (a page-local
  `HostBridgeApi`, so the unchanged webview runs against a document) is
  right; finding 11 moves only the frame's construction.
- `packages/desktop/src/main/desktopWorkspaceIpc.ts`'s path containment
  (`resolveWorkspacePath`, `resolveWorkspaceWritePath`): untrusted renderer
  paths refused once at the boundary.

## Already settled, left alone

- **The desktop PTY host as an Effect**: refused, built and measured
  (`.agents/docs/refuted-candidates.json` `RT-desktop-pty-host-effect`, +21
  LoC for one lift). New evidence noted, not re-proposed: its one `create`
  consumer is already an Effect program (`desktopWorkspaceIpc.ts:403-407`)
  and the window holds a runtime and a spawner (`desktopWindows.ts:27-39`),
  which the refutation said the module lacked. The pending/live/disposed
  protocol in `desktopPtyHost.ts:183-187,224-226,258-260` is the same
  species as finding 8; if finding 8 lands on the renderer side, the pty
  host's `create` returning an Effect whose interruption is the dispose is
  a ~15-line follow-up, to be measured again before it is kept.
- **`admitLaunch`, `useCurrentFile`'s 68 lines, `GuiSession`**: R10's
  deletions (`2026-11-05-root-designs-effect-native.md` "R10 … Deletes").
  Finding 2 cites the first two only for the new angle (the extension's
  second `workspaceFolders` read) and counts them in the table.
- **The notice round-trips, `editorHost` keyed by storage root, two windows
  on one project, service sessions reading as "can ask"**: the CLI note's
  §3.3 "Left for a later PR". Not repeated.
- **`terminalPane.ts:142`'s `catch {}`** (xterm's `fit()` throws on a
  hidden tab) and `desktopAppLog.ts:53,161,181` (logging must never be a
  startup dependency): accepted exceptions under the review checklist's
  §15 class, each with its reason beside it.
- **Module-level `trackedSignal`s with `resetSettingsState`**
  (`settingsState.ts:57-58,247-249`): the AGENTS.md "injectable, resettable
  handle" rule, followed; only finding 11's "not loaded" shapes are at
  issue.
- **`Effect.ignore({ log: 'Warn' })` sites** in `ProgressViewProvider.ts:413-416,453`,
  `commands.ts:96-99`, `extension.ts:562-565`, `setupAssistantCommand.ts:50`:
  the hints called these silent catches; each logs at warn and names the
  step, which is the guardrail's "logs the cause at `warn` and surfaces it".
- **The settings view's two architectures** (request/response versus
  event-driven): documented as the state of the world in
  `packages/extension/src/AGENTS.md` "Webviews"; this round found no third
  variant and does not propose unifying them.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

Every row names the exported API as `File.d.ts:line` under
`node_modules/effect/dist/`. One assumption did not hold: `Layer.scoped` is
not exported in 4.1.2 (`Layer.d.ts` exports `effect`, `effectDiscard`,
`succeed`, `build`, `buildWithScope`, `empty`); `Layer.effect` runs its
effect in the layer's scope, so finding 1 names that instead. Everything
else assumed in the findings exists as written.

| Finding | Hand-rolled today                                                                                                                                                                | Effect 4.1.2 API                                                                                                                                                                                                                                                                          | Why it is the thing                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | three per-host copies of open-session / record-first-run / moved-aside / `dispose()` by hand                                                                                     | `Layer.effect` (Layer.d.ts:1166) over `Effect.acquireRelease`; `Layer.build` (`:644`) into the window's `Scope` (Scope.d.ts:243 `make`, `:574` `close`)                                                                                                                                   | the session is a resource whose lifetime is the window's scope; the layer is built once per window and released by the scope, not by a `dispose` method         |
| 2       | flows (select, search, confirm, title, tag wrap, cancel reading) in both binding tables                                                                                          | no primitive: a narrower `SharedHostRequestBindings` of verbs returning `Effect<…, Tag>`; `pickFiles: Effect<readonly string[] \| null>` read once by the body                                                                                                                            | the body decides; ports fail with their own tag (`Schema.TaggedError`, already the pattern)                                                                     |
| 3       | two `OnboardingFunnelRefresher`s, `credentialUsable` cache, boolean double-click guard with `forkDetach` + `ensuring`                                                            | `SubscriptionRef.make`/`changes` (SubscriptionRef.d.ts:93,134) for the state; `FiberHandle.run(handle, { onlyIfMissing: true })` (FiberHandle.d.ts:542-549) for the launch                                                                                                                | a ref publishes one state to every follower; a handle holds at most one launch and ignores a second `run` while it lives                                        |
| 4       | two preview hosts, two diff hosts, `reportFailure`, `showErrorMessage?`, four reporters                                                                                          | `Context.Reference(key, { defaultValue })` (Context.d.ts:1741) for the presenter; `Effect.catchCause` at one `reported`                                                                                                                                                                   | a service with a sensible default is a Reference (AGENTS.md "Effect"); a port then has no optional presenter and no second instance                             |
| 5       | `postToRenderer?: boolean \| void`, `reachable()`, `connectRenderer`, `tryShowInRenderer` fallback                                                                               | ordering (bridge first), else `Deferred.make`/`succeed`/`await` (Deferred.d.ts:152,1405) for the bridge                                                                                                                                                                                   | a value that arrives once and is awaited by many is a Deferred; the window's scope interrupts the wait                                                          |
| 6       | `sidebarView?`, `sidebarPort?`, `editor?`, `onDisposed` callback, `closePort`/`closeSidebarPort`                                                                                 | `FiberMap.make`/`run`/`remove` (FiberMap.d.ts:115,1016,881) keyed by `'sidebar' \| 'editor'`, each port as `acquireRelease` + `Effect.never`                                                                                                                                              | a set of things in flight keyed by id is a FiberMap; removing the key releases the port                                                                         |
| 7       | `recent` copied 4×, `withPerKeyLane(lanes, Symbol())`, 4× `Effect.uninterruptible`, `bindings` Map + `sync` diff, `released` flag, `funnel: State \| null`                       | `RcMap.make({ lookup })`/`get`/`invalidate` (RcMap.d.ts:215,379,701) for projects and bindings; `SubscriptionRef` (`:93`) for `{ open, activeKey }`; `Stream.runForEach(SubscriptionRef.changes)` (Stream.d.ts:15953) for sync                                                            | a keyed resource map opens once per key in its own scope and releases on invalidate; the lanes and the uninterruptible blocks exist to fake that                |
| 8       | `latestOpenRequest`, `refreshGeneration`, `treeRevision`, `writeEpoch`, `activeWrites`; `onModelSyncLane` promise chain; `FileState` optionals; `refreshPromise`/`refreshQueued` | `FiberHandle.run` (FiberHandle.d.ts:542; interrupts the previous unless `onlyIfMissing`); `Semaphore.make(1).withPermit` (Semaphore.d.ts:253,95); `SubscriptionRef<EditorState>` (`:93,134`); `ManagedRuntime.make` + `runFork` (ManagedRuntime.d.ts:125), `Layer.empty` (Layer.d.ts:978) | "a newer request supersedes the read" is interruption; one lane per key is a semaphore of one permit; the pane's state as one ref makes the render a subscriber |
| 9       | `current?`, `releasing?`, `continueQuit?`, `quitting`, `setImmediate`, `Semaphore(1)`, `FiberSet` for reopens                                                                    | `FiberHandle.make`/`run({ onlyIfMissing: true })`/`clear`/`awaitEmpty` (FiberHandle.d.ts:110,542,504,774); `Deferred` for continue-quit; `Effect.cached` (Effect.d.ts:13539) stays                                                                                                        | the window is one fiber: `run` is open-if-closed, `clear` is close-and-await, `awaitEmpty` is released; the cached close is the one correct piece today         |
| 10      | two `stagePreview` + two preview classes + two `dispose(unapplied)`                                                                                                              | `Effect.acquireRelease` in `Scope.fork` (Scope.d.ts:493) per request, `Scope.addFinalizer` (`:460`) for close-diff                                                                                                                                                                        | staged files are a resource of the request's scope; the controller owns the scope, the host owns four verbs                                                     |
| 11      | `setInterval` log poll; eight renderer `let`s + `applyingProjectList` + `queueMicrotask`                                                                                         | `FileSystem.watch` (FileSystem.d.ts:324) + `Stream.debounce` (Stream.d.ts:11372) on the main side; `SubscriptionRef.update` (`:1248`) + one `changes` subscriber in the renderer                                                                                                          | a file's changes are a stream the main process already has; one ref update is one change event, so there is no intermediate paint to suppress                   |

Browser-safe set used by the renderer-side rows (8, 11): `Effect`, `Stream`,
`SubscriptionRef`, `FiberHandle`, `Deferred`, `Semaphore`, `Scope`,
`ManagedRuntime`, `Layer.empty`, `Schema`, all under `node_modules/effect/dist/`
with no Node import; `FileSystem.watch` and `RcMap`-held sessions are
main-process only. The frontend subscribes by forking one
`Stream.runForEach(SubscriptionRef.changes(ref), paint)` on its own
`ManagedRuntime` and lets `paint` set the Lit signals the components read;
it imports the harness only through `@texra-ai/harness/schemas` and
`/transcript` (`.oxlintrc.json:201-218`).
