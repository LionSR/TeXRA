Read on `main` at `cb22acd`. Covered: `packages/extension/src/` (`extension.ts`, `commands.ts`, `commands/`, `frontend/`, `common/`, `progressView/`, `settingsView/`) and the top-level keys of `packages/extension/resources/agents/*.yaml`.

### EX-1: The sessions are closed three times at deactivation, and the comment that orders them is false

- **Package:** extension
- **Flags:** repetition (a rule with two owners); a comment that is false
- **Evidence:**
  - `packages/extension/src/extension.ts:203-208` registers `sessions.closeAll` followed by the project scope's close ("The window's session closes before the project state it reads").
  - `packages/extension/src/extension.ts:518-520` registers `sessions.closeAll` again, under "Registered last, so the first thing the activation scope's close runs". It is not registered last: `registerFileDecorations` (`:532`), the `githubTokenInvalid` follower (`:568`), `followInlineCriticism` (`:598`), `taskStatusBar` (`:601`) and the welcome fiber (`:611`) all register scoped work after it, so they end before it.
  - `packages/harness/src/controllers/session/sessionLayer.ts:439` adds `closeAll` as the owner layer's own finalizer, which `runtime.disposeEffect` (`extension.ts:190`) runs; `packages/harness/src/effect/processLayer.ts:183-187` documents that "a host whose resources must outlive them runs `Sessions.closeAll` first", once.
  - Both extension finalizers live in the same activation scope, so on every deactivation the `:519` one runs, then the `:206` one finds nothing open, then the layer's. The same species was removed from the CLI (`.agents/docs/proposed/architecture/2026-11-06-cli-service-root-causes.md:306`, "`sessions.closeAll` ran three times at exit"); the extension copy was not listed there. The desktop registers it once (`packages/desktop/src/main/index.ts:115-120`).
- **Better design:** one explicit `closeAll` in the host, at the point the comment at `:183-189` describes. The `:203-208` finalizer keeps only `Scope.close(projectScope, Exit.void)`; the `:518` one stays and its comment says what is true (it runs after the followers registered below it and before the view and the project scope). The no-folder window opens no session, and the layer's finalizer still covers it.
- **Deleted:** one `closeAll` finalizer with its `withProcessServices` wrapper; the false sentence.
- **Size:** ~12 lines, 1 file.
- **Risk / owner decision:** none. Check the no-folder path once by hand (project scope then closes before the runtime's own `closeAll`, with no session open).

### EX-2: The folder window asks "is there a folder?" at seven sites, with six different answers

- **Package:** extension
- **Flags:** errors not defined out of existence; silent degradation; special and general code mixed
- **Evidence:** `activateExtension` settles the question once: a window without exactly one folder returns at `packages/extension/src/extension.ts:391-411` after registering four commands, and everything else (`registerCommands`, `ProgressViewProvider`, `SettingsViewProvider`) is built only on the path that holds `workspaceRoot: string` (`:412-414`). Yet the surfaces built there take `WorkspaceRoots` (`workspace: string | undefined`, `packages/harness/src/platform/workspaceRoots.ts:19`) and each re-decides:
  - `packages/extension/src/progressView/findCommit.ts:25-28`: `return null` (read by the caller as "commit not found", which then toasts "commit … was not found in the repository history", `extensionHostRequests.ts:255-259`).
  - `packages/extension/src/progressView/extensionHostRequests.ts:205-211`: a warning log and `[]`.
  - `packages/extension/src/frontend/ui/dialogs.ts:84-91`: an error toast "No workspace folder open" and `null`.
  - `packages/extension/src/commands/latex/arXivCommands.ts:100`: `workspaceRoot: roots.workspace ?? ''`, an empty path handed to the downloader.
  - `packages/extension/src/commands/housekeeping/clean.ts:21`: `[]`, which `cleanCommands.ts:26-28` reports as "No build/ folders found in this workspace."
  - `packages/extension/src/commands/git/gitCommands.ts:222-226` and `commands/system/sampleProjectCommands.ts:82-87`: two wordings of "open a workspace first".
  - `packages/extension/src/settingsView/SettingsViewProvider.ts:159`: `requiresOpenWorkspace: () => !roots.workspace`, constant `false` in the only window that builds a settings view.
  None of these branches can run: every caller is reached from `registerCommands` (`commands.ts:111-178`) or the progress view's host table. `G-app-controllers.md:585` discussed `requiresOpenWorkspace` as a port; the extension's seven guards are not listed anywhere.
- **Better design:** the fact has one owner, the activation branch. The folder path passes roots whose `workspace` is a `string` (a `FolderRoots = WorkspaceRoots & { readonly workspace: string }` named once beside `openNodeWorkspaceRoots`, or the canonical `workspaceRoot` string beside the roots), and the commands and host arms take that type. The no-folder commands (`extension.ts:264-306`) already take plain `WorkspaceRoots` and are unaffected.
- **Deleted:** seven guards and their six outcomes (two toasts, a warning, a `?? ''`, two empty answers), the `requiresOpenWorkspace` binding in the extension, `FileDialogOptions.workspaceRoot`'s `| undefined`.
- **Size:** ~60 lines, 9 files.
- **Risk / owner decision:** none for the extension. Whether the narrowed type is exported from `@texra-ai/harness/node` (a published entry) or declared in the extension is an **owner decision**; declaring it in the extension needs no SDK change.

### EX-3: `texra.showProgressView` decodes an `inPlace` option no caller passes

- **Package:** extension
- **Flags:** an option for a special case; overexposure
- **Evidence:** `packages/extension/src/commands.ts:145-155` wraps the handler in `definedHandler` over `Schema.Struct({ inPlace: Schema.optional(Schema.Boolean) })`; `packages/extension/src/progressView/ProgressViewProvider.ts:636,641` branches on it. `grep -rn inPlace packages/*/src packages/extension/package.json packages/extension/resources docs README.md` finds only those five lines: no keybinding argument, walkthrough link, webview message or internal `executeCommand` passes it. The four internal callers (`ProgressViewProvider.ts:278,656`, `agentEventListeners.ts:181,203`) pass nothing. Tests: 0 hits in `packages/*/test` and `src/`.
- **Better design:** `'texra.showProgressView': () => progressViewProvider.showProgressView()`; `showProgressView` takes no argument and always focuses the sidebar when no tab is open.
- **Deleted:** the `inPlace` option, its schema and `definedHandler` wrapper, the `options` parameter and its branch.
- **Size:** ~14 lines, 2 files.
- **Risk / owner decision:** a third-party caller of `executeCommand('texra.showProgressView', { inPlace: true })` would be refused by `onExcessProperty: 'error'`. None is documented; 1.0 keeps no such compatibility. Not an owner decision unless the command's argument is considered public.

### EX-4: `globalState` travels as its own argument beside the `roots` that hold it

- **Package:** extension
- **Flags:** pass-through variable
- **Evidence:** `packages/extension/src/extension.ts:460` reads `const { globalState } = roots;` and passes both to `ProgressViewProvider.make(context, globalState, runtime, roots, …)` (`:490-494`). From there: `ProgressViewProvider.ts:153` (parameter), `:132` (`ViewParts.globalState`), `:266` (argument to `createAgentPresentationHost`, next to `roots` at `:268`), `:359,370` (field); `frontend/events/agentEventListeners.ts:219,240` (parameter beside `roots`), `:108` (`handleRequestShowInstruction(globalState, roots, …)`). `extension.ts:445` passes `roots.globalState` to `initializeLatexSupport`. Every one of these sites holds `roots` already.
- **Better design:** the sites read `roots.globalState`. `ProgressViewProvider.make` loses a parameter, `ViewParts` a field, `createAgentPresentationHost` and `handleRequestShowInstruction` a parameter each.
- **Deleted:** four parameters, one interface member, one class field, the destructuring at `extension.ts:460`.
- **Size:** ~20 lines, 3 files.
- **Risk / owner decision:** none. `ProgressViewProvider.ts` is in open PR scope (see "Open PRs" below); rebase on it.
- **Earlier record:** the pass-through lens listed this threading under M8 (`../2026-11-07-design-red-flags-lenses/pass-through.md:578-598`), whose fix was to drop `WorkspaceRoots.globalState`; that part was refused (`PLATFORM-roots-drop-global-slots` in `refuted-candidates.json`). The fix here is the opposite direction and consistent with the refusal: the field stays on the roots, and the second copy beside them goes. The lens's `extensionHostRequests` hop (`options.globalState`) is already gone.

### EX-5: The progress view's placement verbs exist three times, and five of them reach its own host table through a `Deferred`

- **Package:** extension
- **Flags:** pass-through method; temporal decomposition; repetition
- **Evidence:**
  - `showInSidebar` is a module constant (`ProgressViewProvider.ts:92-103`), a public method that returns it (`:608-610`), a closure for the attention surface (`:353`) and a closure for the host table (`:282`), where `ExtensionHostRequestsOptions.showInSidebar` (`extensionHostRequests.ts:120`) re-types it as `Effect<void, HostCommandFailure, ProcessServices>`. The method has no caller outside the class (`grep showInSidebar packages/extension/src`: the three `this.showInSidebar()` calls at `:598,629,641`).
  - The host table is built inside `openGuiWindow`'s `host: (parts) =>` callback (`:258-283`), before the class instance exists, so `:181-184` makes a `Deferred<ProgressViewProvider>` and `onView`, and `:277-281` wraps `showConnectModel`, `showProgressView`, `revealProgress` and `popOutToEditor` in it; `:296` resolves it. `ExtensionHostRequestsOptions` declares the five members (`extensionHostRequests.ts:110-120`) only to receive them. The same shape repeats one level up: `extension.ts:489-506` makes a second `Deferred<SettingsViewProvider>` for `openSettings` and `signInSubscription`.
  - What the constructor waits for is small: `ViewParts` (`:122-138`) takes `bridge` and `snapshot`, which the `host` callback already receives as `parts`, plus `runValidated`, which the view only republishes (`:345,368`) for `commands.ts:129,140,171`.
  - N6 (the surfaces as optional fields) and TC2 (constructor / `initialize()` / `dispose`) are earlier findings on this class; both landed and neither lists the `Deferred` or the forwarding members.
- **Better design:** build the view inside the `host` callback from `parts.bridge` and `parts.snapshot`, and return `runValidated` from `make` beside the view (or let `commands.ts` take it from the `gui`). The host table then receives the view (`Pick<ProgressViewProvider, 'showConnectModel' | 'showProgressView' | 'popOutToEditor' | 'isViewVisible'>`) instead of five closures; `popBack` uses the exported `showInSidebar` constant.
- **Deleted:** the `built` `Deferred` and `onView`; five members of `ExtensionHostRequestsOptions`; the `showInSidebar()` method and two closures; `ViewParts.runValidated` and the `runValidated` field.
- **Size:** ~60 lines, 2 files (`commands.ts` if `runValidated` moves).
- **Risk / owner decision:** none in behavior. Both files are changed by open PRs; compare designs with `.agents/docs/proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md` item 5 (`openGuiWindow` returning the settings view's run verbs), which removes the reason `SettingsViewProvider` needs the provider at all and would let the second `Deferred` (`extension.ts:489`) go as well.

### EX-6: `initVscodePlatform` takes the service as an option that its other argument already decides

- **Package:** extension
- **Flags:** an option for a special case; non-obvious code
- **Evidence:** `packages/extension/src/extension.ts:129-138` declares `extras: { service? } = {}`. Two callers: `:397-400` passes `undefined` and no service, `:423-429` passes the folder and `reachExtensionService(context.extensionPath)`; `context` is already the first argument. Inside, `:212-219` tests `extras.service === undefined || workspaceRoot === undefined` and manufactures `Result.fail(new Error('a window with no folder uses no service'))`, an error no reader sees (the no-folder caller does not destructure `reached`, `:397`); `:240-241` re-tests `workspaceRoot !== undefined` inside `Result.isSuccess(reached)`, which already implies it.
- **Better design:** the function computes it: `workspaceRoot === undefined ? undefined : yield* Effect.result(reachExtensionService(context.extensionPath).pipe(Scope.provide(projectScope)))`, and returns `reached` only for a folder. This is the extension's part of the open note's item 1 ("Opening a project's roots", `2026-11-15-host-rules-and-app-facts-with-two-owners.md`), which proposes one function beside `openProjectSession`; the note does not list the `extras` option or the sentinel error, and they go whichever way item 1 lands.
- **Deleted:** the `extras` parameter and its type, the sentinel `Error`, one redundant guard.
- **Size:** ~18 lines, 1 file.
- **Risk / owner decision:** none.

### EX-7: Two error classes carry a `member` literal nothing reads

- **Package:** extension
- **Flags:** an error kind nothing branches on; overexposure
- **Evidence:** `SurfacePlacementFailed.member: Schema.String` (`progressView/ProgressViewProvider.ts:85`, set to `'showInSidebar'` at `:98` and `'attach'` at `:492`) and `OpenDialogFailed.member: Schema.Literals(['selectFiles', 'selectFolder'])` (`frontend/ui/dialogs.ts:19`, set at `:108,146`). `grep -rnE "\.member\b" packages/extension/src` has no hit; both classes are file-local, so no consumer exists in any package or test. By contrast `VscodeCommandRefused.reason` is read (`progressView/compareFiles.ts:61`) and stays. N11 recorded the same species for the desktop's `WorkspaceHostCallFailed.member` and for `EditorOpenFailed.reason`; these two are not in it.
- **Better design:** the message says which call failed (`'Could not focus the TeXRA sidebar: …'`); the field goes. "It is a message, not a kind."
- **Deleted:** two schema fields and four assignments.
- **Size:** ~12 lines, 2 files.
- **Risk / owner decision:** none.

### EX-8: Three file pickers are a factory, an options interface and a thunk for two strings each

- **Package:** extension
- **Flags:** single-caller extraction; shallow module; a declarative table whose column is derivable
- **Evidence:** `packages/extension/src/progressView/fileSelection.ts:19-22` (`PickerOptions`, with `filters` as a thunk), `:45-57` (`createMultiPicker`, called only at `:67,73,79`), `:63-86` (`createFileSelectionPickers`, one caller, `extensionHostRequests.ts:188`, used as `multipleFilePickers[fileType]()` at `:307`). The three rows differ in a button label and a filter name; the extension list is `getFilterExtensions(fileType)` in all three, derivable from the key. `selectFiles` (`frontend/ui/dialogs.ts:80-121`) and its `FileDialogOptions` have this one caller (1 production consumer, 0 tests).
- **Better design:** one `pickFiles(roots, fileType)` in `fileSelection.ts` that reads a two-column label table and calls `showOpenDialog` itself; the binding is `pickFiles: (fileType) => pickFiles(roots, fileType)`.
- **Deleted:** `createFileSelectionPickers`, `createMultiPicker`, `PickerOptions`, `selectFiles`, `FileDialogOptions`, the `multipleFilePickers` local.
- **Size:** ~70 lines removed, ~30 added, 3 files.
- **Risk / owner decision:** none.

### EX-9: `registerCommands` also builds the settings view and hands it back

- **Package:** extension
- **Flags:** conjoined methods; a vague name (the function does more than it says)
- **Evidence:** `packages/extension/src/commands.ts:85-101` constructs `SettingsViewProvider` and `:222` returns it; it also registers the sidebar's `WebviewViewProvider` (`:211-221`). `extension.ts:522-530` calls it for the return value, which resolves the `Deferred` the progress view waits on (`:489,530`) and feeds the `githubTokenInvalid` follower (`:579`). So "the settings view exists" is a side effect of "the commands are registered", and three consumers in `extension.ts` depend on that order. `registerCommands` has one caller.
- **Better design:** `activateWorkspace` constructs the `SettingsViewProvider` and registers the webview provider, then calls `registerCommands(context, { progressView, settingsView, … })`, which returns nothing. With EX-5 or the note's item 5, the settings view no longer needs the progress view and is built first, with no `Deferred`.
- **Deleted:** the return value, `registerCommands`' `fork` parameter (used only to construct the view, `:98`, and for two log forks that `runtime` can run), the webview registration from the commands module.
- **Size:** ~25 lines, 2 files.
- **Risk / owner decision:** none.

## Open PRs touching these files

`open-prs.txt` lists `progressView/ProgressViewProvider.ts`, `progressView/extensionHostRequests.ts` (two PRs), `frontend/events/agentEventListeners.ts`, `frontend/auth/subscriptionSignIn.ts`, `common/extensionService.ts`, `frontend/hosts/VscodeUiHost.ts`, `frontend/setupTerminalRunner.ts` and three settings components. EX-4 and EX-5 sit in the first three; whoever implements them reads the PR's version first. EX-1, EX-2 (outside `extensionHostRequests.ts:205-211`), EX-3's `commands.ts` half, EX-6, EX-7's `dialogs.ts` half, EX-8's `fileSelection.ts` half and EX-9 are in files no open PR changes.
