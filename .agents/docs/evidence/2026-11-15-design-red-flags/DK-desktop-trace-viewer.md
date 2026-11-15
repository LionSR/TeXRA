Read at `cb22acd`. Covered: `packages/desktop/src/{main,preload,shared}` in full, `packages/desktop/src/renderer` for its message routes and module state only (the panes were not re-read), `packages/trace-viewer/src` in full.

No IPC channel or command without a caller was found: every `DESKTOP_*_COMMANDS` member has one sender and one receiver (grep per constant over `packages/desktop/src`), and the route table in `desktopWindow.ts:318-383` throws on a command two surfaces claim.

The cross-host rules of this slice (project roots, build for display, setup-launch outcomes, the rejected GitHub token, the settings view's run verbs, reaching the service) are already listed in `.agents/docs/proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md` and are not repeated here.

### DK-1: Electron's message box is lifted into Effect by hand at nine sites in five files

- **Package:** desktop
- **Flags:** repetition; a hand-written version repeated instead of one owner; a false comment
- **Evidence:** `Effect.tryPromise({ try: () => dialog.showMessageBox(window, {...}), catch: ... })` is written at `desktopDialogs.ts:55-62` (notify), `:83-99` (confirm), `:113-128` (error), `:152-167` (instruction), `:177-199` (export format), `desktopSignInPresenters.ts:11-24` (`showInfoDialog`), `desktopWindowHost.ts:168-178` (`announceRelease`), `platform/warningDialog.ts:11-25`, and as a bare unawaited promise at `index.ts:217-219` (the telemetry notice: its rejection reaches no handler). The same `new HostFailed({ member: 'dialog.showMessageBox', message: ..., cause })` is spelled at `desktopDialogs.ts:94-98`, `:123-128`, `:162-167` and again at `index.ts:251-256`. `warningDialog.ts` and `index.ts:216-219` each also decide "a parent window or none" on their own. `warningDialog.ts:5-9` says it shows "secret storage that is not encrypted, transcripts that could not be persisted"; its two callers (`index.ts:247`, `desktopProjects.ts:249`) show unopened projects and config warnings. GS2 (landed, #14818) reduced the host dialog ports to two primitives; this is the Electron call under those ports, which GS2 did not touch.
- **Better design:** one `messageBox(parent: BrowserWindow | undefined, options): Effect<number, HostFailed>` in `desktopDialogs.ts` owns the lift, the failure and the "no parent" case. Each dialog is then its options and what the answered index means. The telemetry notice and the startup warning call it too.
- **Deleted:** `showInfoDialog`, `platform/warningDialog.ts` (the file), four `HostFailed` literals, five `tryPromise` wrappers, the two parent-or-none branches, the unhandled promise at `index.ts:217`.
- **Size:** about 120 changed lines, 6 files.
- **Risk / owner decision:** none. `fatalStartupError.ts:61,73` stays: it runs outside any runtime.

### DK-2: The sign-in presenter crosses a three-member port that restates the app's two-member one

- **Package:** desktop
- **Flags:** shallow module; pass-through; information leakage
- **Evidence:** the app's contract is `SubscriptionSignInPresenter` (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts:62-67`: `presentDeviceCode`, `presentSignInUrl`). The extension implements it directly (`packages/extension/src/frontend/auth/subscriptionSignIn.ts:31-100`). The desktop puts a second port in between: `DesktopSettingsIpcOptions.signInPresentation` (`desktopSettingsIpc.ts:31-44`) with `openSubscriptionSignInUrl`, `presentSubscriptionSignInUrl(url, productName)`, `presentSubscriptionDeviceCode(prompt, productName)`. `desktopProjectSurface.ts:191-198` builds it from `host.openExternalUrl` and `desktopSignInPresenters(...)`, and `desktopSettingsIpc.ts:108-148` translates it back into the real presenter, adding `reportPresentation` and the `LoopbackTransportUnavailableError` mapping. One consumer each (grep `signInPresentation`: 2 files, `desktopSignInPresenters`: 2 files; no tests).
- **Better design:** `desktopSignInPresenters(window, dialogs, openExternal)` returns `(provider) => SubscriptionSignInPresenter`, with the failure report and the loopback mapping inside it. `createDesktopSettingsIpc` takes that one function and passes it to `provider.signIn`.
- **Deleted:** the `signInPresentation` option and its three member names, the `productName` parameters, the re-assembly at `desktopSettingsIpc.ts:113-145`, the spread at `desktopProjectSurface.ts:191-198`.
- **Size:** about 70 lines, 3 files.
- **Risk / owner decision:** none.

### DK-3: `createDesktopWorkspaceIpc` joins the editor's file handler to a switch that only forwards to the terminal and browser hosts

- **Package:** desktop
- **Flags:** conjoined methods; pass-through; special and general code mixed; a vague name; an option for a special case
- **Evidence:** `desktopProjectBindings.ts:128-182` builds `ptyHost` and `browserViews`, then hands both to `createDesktopWorkspaceIpc`, whose `handle` (`desktopWorkspaceIpc.ts:449-491`) is eight cases of `Effect.sync(() => options.ptyHost...)` / `options.browserViews...`, and whose `disposeRendererResources` (`:431-434`) is `ptyHost.disposeAll(); browserViews.disposeAll()`. The file half (`file`, `followFilesWritten`, `:245-383`, `:438-447`) reads none of those; the terminal half reads no file code. `toWindowBounds` (`:66-70`) is an option passed in only to be called once at `:479`. `getWorkspacePath()` (`:79`) is a thunk whose one production value is the constant `() => project.root` (`desktopProjectBindings.ts:180`), under a doc comment that still describes "the project this window shows". The one rule about browser bounds (a hidden project must not cover the shown one) is decided outside, at `desktopProjectBindings.ts:358-364`, so the browser's handling has two owners. `disposeRendererResources` is named for a document reload but is what a project's release calls (`desktopProjectBindings.ts:187-190`). The earlier tool-edit and PTY refusals (`RT-desktop-pty-host-effect`) are about the PTY host's internals, not this module.
- **Better design:** the workspace-file module exports `workspaceFileRequests(root)` (the `file` answer and `followFilesWritten`). The terminal and browser commands are a per-project route table built where `ptyHost` and `browserViews` already live (`createProjectWorkspace`), bounds rule included.
- **Deleted:** `DesktopWorkspaceIpcOptions.ptyHost`, `.browserViews`, `.toWindowBounds`, `.getWorkspacePath` (a plain `root`), `handle`, `disposeRendererResources`, the outside bounds check; `DesktopWorkspaceIpc.vitest.ts`'s three stub hosts (`:31-45`) go with them.
- **Size:** about 150 lines, 4 files (`desktopWorkspaceIpc.ts`, `desktopProjectBindings.ts`, `desktopHostRequests.ts`, the suite).
- **Risk / owner decision:** none. #14959 and #14953 each change other lines of `desktopWorkspaceIpc.ts` (`isAgentDocumentTarget`, `hostFailed`); #14959 also takes the last instance of L2-7.10.

### DK-4: "The user is looking at this project" is computed three times, over two hand-written focus streams

- **Package:** desktop
- **Flags:** repetition (a fact with two owners); shared mutable state
- **Evidence:** `desktopAttention.ts:127` (`activeKey === project.key && port.windowFocused()`), `desktopProjectBindings.ts:263` (`shown() && host.window.isFocused()`), and the per-binding stream at `desktopProjectBindings.ts:215-241`, which merges a `Stream.callback` over `window.on('focus')` with the registry's changes filtered by `host.window.isFocused()`. A second `Stream.callback` over `app.on('browser-window-focus')` is at `desktopAttention.ts:85-97`. Every open project's binding registers its own `focus` listener on the one window. `liveNotifications` (`desktopAttention.ts:46`) is a module-level `Map` behind the `electronAttentionPort` factory; the catalogue's N11 row counts the module `let`s and does not list it.
- **Better design:** the window host owns one value, the key of the project the user sees (the shown project while the window is focused, else none), as a `SubscriptionRef` updated from one `focus`/`blur` listener and the registry's `activeKey`. The bindings' `focused` stream, the tool-edit host's `focused()` and the attention port all read it.
- **Deleted:** the `Stream.callback` in each binding, `shown()`, `DesktopAttentionPortShape.windowFocused` and `.focused` (one `seen` read replaces both), the module-level map (moved into the factory's closure).
- **Size:** about 80 lines, 4 files.
- **Risk / owner decision:** none; the attention port is served at the process root while the value is the window's, so the port takes it through `windows` as `reveal` already is.

### DK-5: Structural interfaces written for tests that do not exist

- **Package:** desktop
- **Flags:** shallow module; overexposure; a vague name
- **Evidence:** `desktopWindowLifecycle.ts:3-12` declares `EventSource` and `DisposableRendererResources` so `bootstrapDesktopWindowLifecycle` (`:36-60`) need not name Electron's `WebContents`; no suite calls it (grep over `packages/desktop/test`, `tests`, `src/`: only `installDesktopBeforeQuitWiring` is tested). Its one caller wraps a callback in an object to fit: `workspaceIpc: { disposeRendererResources: () => spawn(...) }` (`desktopWindow.ts:307-310`), a name left from when the workspace IPC was the thing disposed. `clearContinueQuitAfterWindowClose` (`:33`) is `hooks.cancelPendingQuit` under a second name. `desktopPreviewHost.ts:33-36` declares `DesktopShellAdapter` and takes `shell` as an option; the one caller passes Electron's `shell` (`desktopWindowHost.ts:70-74`) and no suite builds the host. `desktopWindowHost.ts:181` meanwhile calls `shell.openExternal` directly, past the preview host.
- **Better design:** `followWindowUnload(webContents, { onDocumentReload, confirmDiscard, ... })` over Electron's own type; the preview host imports `shell`.
- **Deleted:** `EventSource`, `DisposableRendererResources`, `DesktopShellAdapter`, the `shell` option, the wrapper literal, one of the two names for cancelling a pending quit.
- **Size:** about 40 lines, 4 files.
- **Risk / owner decision:** none.

### DK-6: The window host exposes one capability under several names, and its callers rebuild what it already has

- **Package:** desktop
- **Flags:** overexposure; pass-through; repetition
- **Evidence:** opening a URL has four spellings on one object: `host.previewHost.openExternal` (`desktopWindow.ts:201`, `desktopProjectBindings.ts:152`), `host.openExternalUrl` (`desktopWindowHost.ts:145`, an alias of the former; used at `desktopProjectBindings.ts:277`, `desktopProjectSurface.ts:120,194,196`), `host.openExternalInBackground` (`:89-108`), and `shell.openExternal` (`:181`). `desktopProjectBindings.ts:149-158` rewrites `openExternalInBackground` by hand (`presented(previewHost.openExternal(url))` then `reportBackgroundError`). `post` (`:37`) forwards to `bridge.postToRenderer` and `postSession` (`:141`) re-exports `bridge.postSession`. `pickFolder(title, defaultPath, properties)` (`:186-201`) has two callers that pass the same `projects.active().root ?? app.getPath('home')` (`desktopProjectNavigation.ts:78-82`, `desktopProjectSurface.ts:139-144`) and differ only in `'createDirectory'`. `desktopFileSelection.ts` is a module with one caller (`desktopProjectBindings.ts:203`) whose `fileOptions` only forwards to `workspaceFileOptions` (`:64`), whose dialog-options interface (`:11-15`) restates `openFileDialog`'s parameter (`desktopWindowHost.ts:204-208`), and whose header cites a planning section ("(8.3)", `:27`).
- **Better design:** the host exposes `openExternal` (the caller presents) and `openExternalInBackground` (the window presents), nothing else; `pickFolder(title, { create })` reads the default path itself; `pickFiles` lives beside the open dialog it wraps and the snapshot takes `workspaceFileOptions(root)` directly.
- **Deleted:** `openExternalUrl`, the `previewHost` member (callers use the two verbs), the hand copy in the bindings, `pickFolder`'s two extra parameters, `DesktopFileSelection.fileOptions`, `DesktopFileSelectionDialogOptions`, likely `desktopFileSelection.ts` as a file.
- **Size:** about 110 lines, 7 files.
- **Risk / owner decision:** none. #14955 changes other lines of `desktopWindowHost.ts` and `desktopProjectBindings.ts` (`confirm`, the notices table); V-R17 and X (round 4) already settled `reportBackgroundError` / `awaitOrReport`, which are left alone here.

### DK-7: Platform start-up is split into two phases, and the second returns what the first computed

- **Package:** desktop
- **Flags:** temporal decomposition; pass-through variable; a comment that cites a ticket
- **Evidence:** `initializeElectronPlatform` (`platform/index.ts:53-129`) resolves `dataRoot`, `mainDir`, `resourcesPath` and the config stores, builds the runtime, and returns `{ runtime, processScope, initialize }`. `initialize` (`:104-127`) then opens the process roots and returns `ElectronPlatformInitResult`, three of whose five fields (`dataRoot`, `resourcesPath`, `mainDir`) are the phase-one values handed back unchanged; the entry reads them as `platformInit.*` at `index.ts:144-187`. The entry also keeps `let projects` (`index.ts:83`) so one finalizer can pick between two owners of the process scope: `projects?.dispose() ?? Scope.close(processScope, Exit.void)` (`:102-107`). Comments carry ticket numbers as their reason (`platform/index.ts:39` "#7987", `desktopAppLog.ts:47` "#12134").
- **Better design:** the platform returns its facts once (`{ runtime, dataRoot, resourcesPath, mainDir, configStores }`); the process scope and the no-workspace roots are opened by the project registry, which already owns the fallback project and its release, so the shutdown has one finalizer for projects and no optional.
- **Deleted:** `ElectronPlatformInitResult`, the `initialize` program as a returned value, `processScope` as an entry-level variable, `let projects` and the `??` branch, `DesktopProjectRegistryOptions.processRoots` and `.processScope`.
- **Size:** about 90 lines, 3 files.
- **Risk / owner decision:** none, but check the start-up failure path the comment at `platform/index.ts:101-103` protects (a failure after the roots open must still close them).

### DK-8: The recent list has two owners, and "every project" is rebuilt at each reader (N7 remainder)

- **Package:** desktop
- **Flags:** repetition (a fact with two owners); special and general code mixed
- **Evidence:** `recent` lives in the stored value (`desktopProjectRecords.ts`) and in `DesktopProjectsState.recent`. Each write is followed by a fresh read to copy it across: `desktopProjects.ts:335`, `:347` (`syncRecent`), `:405`, `:446`. The store's `update` computes the new lists and throws them away (`Result.succeed([undefined, ...])`, `desktopProjectRecords.ts:59-65`). `DesktopProjectFacts` (`desktopProjects.ts:51-63`) is used only to build `DesktopProject`, which declares `root` a second time (`:56`, `:69`). The no-workspace project is "never in `list()`", so each reader that wants all projects rebuilds the set: `desktopProjectBindings.ts:334`, `desktopAttention.ts:116-119`, `:177`, and `desktopProjectNavigation.ts:46-49` special-cases its key. The registry also offers `list()`, `active()` and `fallback()` beside the `state` they are read from, and callers use both (`SubscriptionRef.getUnsafe(projects.state).activeKey` at `desktopWindow.ts:242`, `desktopProjectBindings.ts:216`). N7 landed its lane (#14799) and its `RcMap` design was refused (`RT-desktop-projects-rcmap`); neither covers this.
- **Better design:** `update` answers the lists it wrote, so the state takes `recent` from the write. The state carries the no-workspace project (`fallback`) so "all projects" is one derived read, `all(state)`.
- **Deleted:** three `readRecent` re-reads and `syncRecent`, `DesktopProjectFacts`, the three hand-built unions and the navigation special case, `list()` or the direct `state` reads (one of the two).
- **Size:** about 90 lines, 6 files.
- **Risk / owner decision:** none; no stored format changes.

### TV-1: The scrubber's position is set in one module and takes effect only when a second call follows

- **Package:** trace-viewer
- **Flags:** conjoined methods; shared mutable state; an option for a special case
- **Evidence:** `traceHostBridge.ts:64,66` holds `cut` and `selected` as module `let`s; `setTraceCut` (`:72-75`) changes both and does nothing visible until `main.ts:80-81` also calls `remount()`. `main.ts` imports the bridge twice for this (`:12`, `:20`). `traceFrame(trace, session, subscribe, cut = null)` (`traceFrames.ts:78-83`) has one production caller, which always passes `TRACE_SESSION` and always passes `cut` (`traceHostBridge.ts:96`); the default serves only the suite (`src/test-kernel/traceViewer/traceFrames.vitest.ts:23`).
- **Better design:** the bridge exports `showAt(cut)`, which sets the position and remounts (it takes the remount from `main.ts` at install), so no caller can set a cut the page does not show. `traceFrame` takes `cut` as a required argument.
- **Deleted:** `setTraceCut` as a separate step, the default on `cut`, the second import.
- **Size:** about 25 lines, 3 files.
- **Risk / owner decision:** none.

## Good modules here

- `desktopWindows.ts`: one `WindowState` value, one release per window, a quit, a reopen and the shutdown all waiting on it.
- `shared/hostBridgeChannels.ts` + `preload/hostBridge.ts` + `main/hostBridge.ts`: two channel pairs, each end a pipe; `heldUntilListening` removes the "pushed before the page listens" case by its shape.
- `renderer/messageRoutes.ts` with `shared/desktopOutboundMessages.ts`: the route table is typed over the push union, so a push without a renderer end does not compile.
- `desktopBrowserViews.ts` and `desktopNavigationPolicy.ts`: small interfaces, the policy in one place each.
- `packages/trace-viewer/src/traceFrames.ts` and `traceDataSchema.ts`: the export is replayed through the live protocol's own inputs with no second reader, and an old document fails at the parse.

## Considered and left alone

- `DesktopToolEditApprovalHost` restating the diff host's `openDiff`/`closeDiff` signatures: inside `RT-tool-edit-staging-one-owner` (N10, refused).
- `desktopPtyHost.ts`'s hand-held session state: `RT-desktop-pty-host-effect` (built, measured, reverted).
- `DESKTOP_HEADLESS` read in six modules: `DESKTOP-headless-through-config` (refused).
- `desktopProjectSurface.ts`'s `revealRun` / `runLabel` reading the active project, the setup-launch mapping, the GitHub-token dialog, `desktopPreviewHost`'s build-for-display, `desktopService.ts`: items 2 to 6 of the open note `2026-11-15-host-rules-and-app-facts-with-two-owners.md`.
- `desktopHostRequests.ts`'s presentation table and `confirmAcceptFile`: #14955 deletes them; its `HostFailed` literals: #14953.
- `terminalCwd`'s `try/catch` and the `console.warn` drops in `desktopWindow.ts`: #14959.
- `renderer/main.ts:184` `applyingProjectList`: the N11 row says its dead checks were deleted; three checks remain (`:320`, `:484`, `:617`) and were not verified dead, so not reported.
- `DesktopPromptController`'s pending map: a `Deferred` per request would be the same map; nothing to delete.
- `fatalStartupError.ts`, `desktopAppLog.ts` module state: read outside any runtime, as the N11 row records.

## Summary

| Id   | Title                                                                                          | Package      | Flags                                                                     | Size                 | Owner decision? |
| ---- | ---------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------- | -------------------- | --------------- |
| DK-1 | Electron's message box lifted into Effect by hand at nine sites in five files                  | desktop      | repetition, hand-written version, false comment                           | ~120 lines, 6 files  | no              |
| DK-2 | The sign-in presenter crosses a three-member port that restates the app's two-member one       | desktop      | shallow module, pass-through, information leakage                         | ~70 lines, 3 files   | no              |
| DK-3 | `createDesktopWorkspaceIpc` joins the file handler to a switch that only forwards              | desktop      | conjoined methods, pass-through, special-general mixed, vague name, option | ~150 lines, 4 files  | no              |
| DK-4 | "The user is looking at this project" computed three times over two hand-written focus streams | desktop      | repetition, shared mutable state                                          | ~80 lines, 4 files   | no              |
| DK-5 | Structural interfaces written for tests that do not exist                                      | desktop      | shallow module, overexposure, vague name                                  | ~40 lines, 4 files   | no              |
| DK-6 | The window host exposes one capability under several names; callers rebuild what it has        | desktop      | overexposure, pass-through, repetition                                    | ~110 lines, 7 files  | no              |
| DK-7 | Platform start-up split into two phases, the second returning what the first computed          | desktop      | temporal decomposition, pass-through variable, ticket-citing comments     | ~90 lines, 3 files   | no              |
| DK-8 | The recent list has two owners; "every project" rebuilt at each reader (N7 remainder)          | desktop      | repetition, special-general mixed                                         | ~90 lines, 6 files   | no              |
| TV-1 | The scrubber's position is set in one module and takes effect only when a second call follows  | trace-viewer | conjoined methods, shared mutable state, option for a special case        | ~25 lines, 3 files   | no              |
