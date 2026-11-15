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

### EX-10: The instruction notice is a second lift of VS Code's message box, with a wait option the one caller that needs it does not set, and a wire flag whose default each host picks

- **Package:** extension (the `showSuppress` half: harness, cli)
- **Flags:** an option for a special case; repetition (a rule with two owners); non-obvious code
- **Evidence:**
  - `showInstructionWithSuppress` (`packages/extension/src/frontend/ui/instruction.ts:28-91`) calls `vscode.window.showInformationMessage` itself (`:53`) and lifts the thenable with its own `tryPromise` and warn (`:54-66`), beside `vscodeUi.ask`, which is that lift (`frontend/hosts/VscodeUiHost.ts:99-107,150-182`). It is the only `window.show*Message` call in `src/` outside `VscodeUiHost` and the unhandled-rejection listener (which runs outside any fiber).
  - Whether the caller waits for the person is the option `{ deferDismissal?: boolean }` (`:36`, `:79-90`), a hand-written `forkDetach` that `VscodeUiHost.notify` already does (`:87-97`). Two callers: `agentEventListeners.ts:128-135` sets it; `promptExtensionInstall` (`:97-121`) does not. `promptExtensionInstall` is called by `frontend/setup.ts:60` (already off the activation fiber) and by the Lean adapter's `getClientProvider` (`frontend/lean/VscodeIntegration.ts:273-284`), which every Lean tool path runs (`:243`, `:325`, `:465`). So a Lean tool call in a window without the Lean 4 extension waits until the person clicks or dismisses the install toast, and, on "Install", for the Marketplace install, before it answers `not-installed` (`:286`). The file's own neighbour says why: "VS Code finishes its promise only when the user dismisses it" (`frontend/ui/errorHandlingUtils.ts:70-73`). The adapter's comment "the prompt is an offer, so failing to show it does not change the answer" (`:263-266`) does not cover the wait.
  - `RequestShowInstructionPayload.showSuppress?` (`packages/harness/src/shared/schemas/progressEvents.ts:40,61`) is a per-notice wire flag. Its writers: the harness's two keys pass `false` (`agent/runtime/AgentLaunchContext.ts:39`, `common/errors/agentErrorClassification.ts:60`); the app's two keys omit it (`packages/texra/src/tools/documents/documentTools.ts:317-330`). The extension reads absent as `true` through a parameter default (`instruction.ts:35`, passed `payload.showSuppress` at `agentEventListeners.ts:133`), the CLI forwards absent as absent into its NDJSON (`packages/cli/src/runtime/headless/cliPresentationHost.ts:98`), the desktop ignores it (`packages/desktop/src/main/desktopDialogs.ts:139-140`). Which notices can be silenced is a fact of the key, and the app already has the per-key table for what a notice offers: "which affordances a key gets is the application's to say, here, once" (`packages/texra/src/ui/copy/instructionActions.ts:1-6,28-42`).
  - Not in earlier rounds: grep `deferDismissal|showSuppress|showInstructionWithSuppress` over the evidence and proposals finds only the PT4 channel hop (`pass-through.md:397`), which landed.
- **Better design:** `showInstructionWithSuppress` is `vscodeUi.ask('info', message, { items })` followed by the action or the suppression write, forked detached always (a notice's answer is never what a caller waits on). The suppressible keys are a column of the app's `ACTIONS_BY_KEY` table (or a set beside it); the extension and the CLI read it by key.
- **Deleted:** the raw `showInformationMessage` lift and its `tryPromise`/warn, the `options`/`deferDismissal` parameter and its branch, the `showSuppress` parameter default; `showSuppress` on `RequestShowInstructionPayload`, `LaunchNoticeSchema`, the two harness writers and the CLI's forwarding.
- **Size:** ~45 lines in the extension (2 files); ~15 more across harness, app and CLI for the flag.
- **Risk / owner decision:** the extension half (one lift, no wait) is none, and it fixes the blocked Lean call. Dropping `showSuppress` changes a published schema export (`@texra-ai/harness/schemas`) and the CLI's NDJSON field: **owner decision**, and it decides which of today's four keys are silenceable (today: the app's two in VS Code only).

### EX-11: Inline comments and inline criticism keep their VS Code handle in module slots that a provider object reads

- **Package:** extension
- **Flags:** shared mutable state; temporal decomposition
- **Evidence:**
  - `frontend/comments/inlineComments.ts:33,37-38`: `let controller`, a module `Map` of threads, `let sequence`. The exported `inlineCommentProvider` (`:96-140`) reads the slot (`if (!controller) return null`, `:98`) and is handed to the process layer at module load (`extension.ts:150-153`, in `initVscodePlatform`, so the no-folder window's runtime holds it too). The slot is filled later by `registerInlineComments` (`:142-160`, guarded `if (controller) return`, `:143`) from `activateWorkspace` (`extension.ts:599`) and emptied by `disable` (`:177-182`).
  - `frontend/latex/inlineCriticism.ts:51,55`: a module `fileLanes` map and `let collection`. `showDiagnostics` writes the slot (`:135-148`), `refreshFileDiagnostics` re-reads it after a yield to notice a swap (`:85,103`), and `pushManualCriticism` (`:214-238`) reads it from another module: the progress view's editor capability (`progressView/ProgressViewProvider.ts:190-191`). The writer runs from `extension.ts:598`; the reader is wired at `:490`; nothing but the slot connects them.
  - The guardrail: "A module-level object that is returned or crosses a module boundary is deep-frozen or built fresh by a factory." Both cross. No test touches either module (grep over `packages/*/test` and `src/`: 0), so nothing needs a resettable handle either.
- **Better design:** each is a value built in the activation that owns it. `makeInlineComments(context)` creates the controller, the thread map and the counter in a closure, registers the three comment commands, and returns the `InlineCommentProvider`; `initVscodePlatform` passes it on the folder path only (`TexraProcessHost.inlineComments` is already optional, `packages/texra/src/tools/registry.ts:346`). `makeInlineCriticism()` returns `{ follow, push }` over one closure-held collection and lane map; `activateWorkspace` builds it before the progress view, passes `push` into the editor capability and forks `follow`.
- **Deleted:** four module `let`/`const` slots, the `if (controller) return` re-registration guard, the `null`-before-registration branch, `disable` as a module function (it becomes the returned disposable), the exported `inlineCommentProvider` and `pushManualCriticism` names.
- **Size:** ~50 lines, 4 files (`inlineComments.ts`, `inlineCriticism.ts`, `extension.ts`, `ProgressViewProvider.ts`).
- **Risk / owner decision:** none. `ProgressViewProvider.ts` is in open PR #14955's scope (the line it changes is the editor capability, which that PR leaves alone).

### EX-12: Four VS Code calls are lifted again, in five places, beside the wrapper that owns each

- **Package:** extension
- **Flags:** repetition (a rule with two owners); a comment that is false; an export with one consumer
- **Evidence:**
  - **The input box twice.** `vscodeUi.input` (`frontend/hosts/VscodeUiHost.ts:129-149`) lifts `showInputBox` with a cancellation token into `HostFailed`; `inputBox` (`frontend/ui/dialogs.ts:59-66`) lifts the same call with the same token helper into a second tag, `HostPromptFailed` (`:26-35`), whose only reader is a type annotation (`commands/git/gitCommands.ts:11,57`). `inputBox` has two callers (`commands/latex/arXivCommands.ts:43`, `gitCommands.ts:58`), which use `title` and `validateInput` that `InputField` does not carry. GS2 (landed, #14818) reduced the dialog port to notify, confirm and input; this second input box and its tag were not in it. `quickPick` (`dialogs.ts:37-57`) fails with the same second tag.
  - **Open a file at a line twice.** `openFileInEditor(path, { line })` (`frontend/vscode/vscodeEditor.ts:111-142`) places the cursor; its `line` option has one caller (`frontend/lean/VscodeIntegration.ts:440-442`). `progressView/openFile.ts:19-33` re-implements the placement as `openInEditor(path, at)` with a position callback, whose one caller passes a constant line (`:42`). The comment "for a line request and a label match alike" (`:15-18`) is false: the label search left this file with N2.
  - **Show a document three more times.** `previewFinalOutput` (`frontend/agents/finalOutputOpener.ts:17-38`) and the settings view's `openPath` (`settingsView/SettingsViewProvider.ts:51-61,129`) each lift `vscode.window.showTextDocument` themselves; both are `openFileInEditor(path, { preview })` (the settings view's untitled YAML buffer, `:134-140`, is a different call and stays).
  - **A command failure re-wrapped.** `VscodeCommandFailed` (`frontend/lean/VscodeIntegration.ts:48-55`) re-tags `executeVscodeCommand`'s `VscodeCommandRefused` (`frontend/system/commandUtils.ts:16-25`) with the same `commandId`, `message` and `cause` (`:214-228`). Nothing reads it by tag (`grep catchTag|_tag ===` over `packages/extension/src`: only `LeanExtensionUnavailable` and `LspRequestFailed`); the Lean port's error is `Error` (`packages/texra/src/tools/lean/leanLanguageServices.ts:78-80`) or is re-mapped by message (`VscodeIntegration.ts:246-258`).
- **Better design:** one lift per VS Code call. `vscodeUi.input` and `quickPick` share one `HostFailed` (`member: 'input' | 'quickPick'`); the arXiv prompt validates its answer after the box (or `InputField` grows an optional `validate` that VS Code honours and the desktop ignores, if the inline message is worth a port field). `openFile` is `openFileInEditor(path, { preview: true, line })` or `vscode.open`; `previewFinalOutput` and the settings `openPath` call `openFileInEditor`. `executeLeanCommand` is `executeVscodeCommand(id).pipe(Effect.asVoid)`.
- **Deleted:** `inputBox`, `HostPromptFailed` and its mapper, `openInEditor` and its false comment, two `showTextDocument` lifts (the settings one keeps only the untitled-buffer branch), `VscodeCommandFailed` and `executeLeanCommand`'s mapping.
- **Size:** ~80 lines removed, ~20 added, 8 files.
- **Risk / owner decision:** the arXiv box loses its inline validation if the port does not grow `validate`; choose which. Otherwise none. EX-7's `OpenDialogFailed.member` is the same species and can land in the same commit.

### EX-13: Which guide page a notice's button opens is decided per host, and the agent-issue reporter passes a page that has one value

- **Package:** extension (with desktop, app, harness)
- **Flags:** repetition (a rule with two owners); an option for a special case
- **Evidence:**
  - The app's instruction tokens are host-neutral by design ("each host maps a token to its own UI", `packages/texra/src/ui/copy/instructionActions.ts:13`), but two of the three tokens are not UI: they name a guide page. The extension maps `OPEN_CONFIGURATION_GUIDE` to `openGuidePage('configuration')` and `OPEN_MODELS_DOC` to `openGuidePage('models')` (`frontend/events/agentEventListeners.ts:72-81`); the desktop writes the same two pages in a switch (`packages/desktop/src/main/desktopWindowHost.ts:106-118`). The page is the token's meaning; only "open a page" and "ask for a key" are host verbs. The failure notice already carries its page on the wire (`RequestShowErrorPayload.docsPage`, opened the same way by both hosts: `agentEventListeners.ts:86-104`, `desktopWindowHost.ts:39-41`). Round 2's N2 moved the labels to the app (landed) and listed "the guide URL" as the body's; the page per token was not moved.
  - The agent-directory reporter carries a page parameter typed as one literal: `issueReporter.report(message, docsId: 'custom-agents')` (`packages/harness/src/agent/index/AgentDirectoryService.ts:64-66`), called only with that literal (`:253`), re-declared by the app option (`packages/texra/src/controllers/texraProcessLayer.ts:66-69`), and received by `showLoggedMessageWithDocs(message, docId: DocId)` (`frontend/ui/errorHandlingUtils.ts:12,96-111`) through `extension.ts:166`. `DocId`'s other member, `'latex-diff'`, has no caller (grep: 0 in `packages/*/src`). `showLoggedMessageWithDocs` has that one caller.
- **Better design:** `instructionActions.ts` gives each guide token its page (`INSTRUCTION_ACTION_GUIDE_PAGE`, or tokens shaped `{ kind: 'guide', page } | { kind: 'setApiKey' }`); each host implements `openGuide(page)` and `setApiKey` once. The reporter is `report(message)` (the directory's page is the reporter's constant, or the message carries it as the failure notice does).
- **Deleted:** two per-host case arms in each host (4), the `docsId` parameter at three layers, `DocId` and its unused member.
- **Size:** ~30 lines, 5 files.
- **Risk / owner decision:** `AgentDirectoryServiceOptions.issueReporter` is in the `@texra-ai/harness/host` API report (`config/api-reports/harness.host.api.md:19`): **owner decision** for that half. The token-page half is app and host code only.

### EX-14 (batched): Branches and parameters the code could decide for itself

- **Package:** extension (one item crosses into texra and desktop)
- **Flags:** an option for a special case; conjoined methods; a comment that is false; silent degradation
- **Evidence:**
  - **The active-file guard is two functions joined by a status union.** `getActiveLatexEditor` (`frontend/editor/activeFileGuards.ts:62-111`) shows the user message for a failed guard and returns `{ status }` (`:48-56`), so that its one caller `runGuardedLatexCommand` (`:130-168`) can look the same reason up again in `GUARD_FAILURE_MESSAGES` (`:25-46`, columns `user`, `logTail`, `level`) to write the log line `Cannot ${action}: ${logTail}` (`:141-148`). The `action` option (`:117`) exists only for that line; four callers write it (`commands/latex/figCommands.ts:30`, `latexCommands.ts:36,72,113`). The `.tex` test is written by hand (`:73`) beside `isTexFile` (`packages/texra/src/shared/latexFileTypes.ts:18-20`). (The `channel` option stays: PT4 kept it as the command's one naming, `pass-through.md:428-431`.)
  - **`registerWalkthroughWorkspaceAction(context, hasSingleWorkspace, runtime)`** (`extension.ts:339-353`) is called once per activation path with a literal (`:409` false, `:531` true); the boolean picks between two handlers that share nothing.
  - **`BundledViewContentProvider`'s `viewName`** (`common/webview/BundledViewContentProvider.ts:76,85,89`) is passed beside `viewFolder` as its capitalized spelling (`'ProgressView', 'progressView'`, `ProgressViewProvider.ts:172-176`; `'SettingsView', 'settingsView'`, `SettingsViewProvider.ts:95-99`) and read only in two log lines (`:132,138`). The class comment "Covers the main, progress, and settings views" (`:72`) names three views; the main view is the progress view (`ProgressViewProvider.viewType = 'texra.mainView'`, `:141`).
  - **An activation that silently does nothing.** `extension.ts:412-413`: after `workspaceFolders?.length === 1`, `if (!rawWorkspacePath) return;` ends activation with no command, no `texra.activated` context and no log. A folder's `uri.fsPath` is never empty, so the branch is dead; were it reached, it would be the silent degradation the guardrail names.
  - **`findCommitInHistory`'s `typeof commitHash !== 'string'`** (`progressView/findCommit.ts:17-19`) guards a parameter typed `string`, with one caller passing a parsed string (`extensionHostRequests.ts:248`).
  - **`LatexdiffHost.withProgress` (remainder of N2, landed #14794/#14802).** N2's design deleted it ("`withProgress` goes"). It stands: the port (`packages/texra/src/latex/latexdiff/latexdiffVerbs.ts:72-80`, one caller `:224`), the extension's binding (`progressView/extensionHostRequests.ts:322-330`), and the desktop's, which is the identity (`packages/desktop/src/main/desktopHostRequests.ts:119`: `task({ report: () => undefined })`).
- **Better design:** the guard shows and logs a failure where it detects it and returns `Option<{ editor, relativePath }>`; the two walkthrough handlers are registered by their own paths; `BundledViewContentProvider` logs `viewFolder`; the dead `return` and `typeof` go. For `withProgress`, N2's own design: the latexdiff body reports its progress through the window's notice, or keeps the port and the desktop says why it has no progress surface.
- **Deleted:** `ActiveFileGuardResult`, `ActiveFileGuardFailureReason`, the `logTail`/`level` columns, the `action` option at 4 call sites; the `hasSingleWorkspace` parameter; the `viewName` constructor parameter and field at 2 sites, the false comment; one dead branch each in `extension.ts` and `findCommit.ts`; (with the owner) `LatexdiffHost.withProgress` and its two bindings.
- **Size:** ~70 lines, 9 files.
- **Risk / owner decision:** none, except `withProgress`, whose removal drops VS Code's progress notification during a latexdiff batch: **owner decision**, as N2 left it.

## Open PRs touching these files

`open-prs.txt` lists `progressView/ProgressViewProvider.ts`, `progressView/extensionHostRequests.ts` (two PRs), `frontend/events/agentEventListeners.ts`, `frontend/auth/subscriptionSignIn.ts`, `common/extensionService.ts`, `frontend/hosts/VscodeUiHost.ts`, `frontend/setupTerminalRunner.ts` and three settings components. EX-4 and EX-5 sit in the first three; whoever implements them reads the PR's version first. EX-1, EX-2 (outside `extensionHostRequests.ts:205-211`), EX-3's `commands.ts` half, EX-6, EX-7's `dialogs.ts` half, EX-8's `fileSelection.ts` half and EX-9 are in files no open PR changes. Of the later findings: EX-10 touches `agentEventListeners.ts:128-135` and EX-13 `agentEventListeners.ts:72-81`, both lines PR #14955 (`claude/clever-pascal-h5a0xm`) leaves as they are (it rewrites `createAgentPresentationHost`, not the instruction path); EX-11 touches `ProgressViewProvider.ts:190-191`, also unchanged there; EX-12's `VscodeUiHost.ts` half meets PR #14953 (`claude/optimistic-cori-q0n270`), which only replaces the `HostFailed` literal with `hostFailed(...)`; EX-14's `withProgress` binding at `extensionHostRequests.ts:322-330` is untouched by both PRs. None of the open PRs already fixes a finding here.

## Good modules here

- **`withVSCodeProgress`** (`frontend/ui/progress.ts:25-53`): the one lift of `vscode.window.withProgress`; the body stays a step of the calling fiber, and `ensuring` resolves VS Code's promise on every exit, interrupt included. Six callers and no copies.
- **`firstEventOrTimeout` / `tokenCancelled`** (`frontend/vscode/vscodeEventWait.ts`): a one-shot VS Code event as a scoped `Deferred` with `timeoutOption`, and a cancellation token as `Effect.callback` with its listener disposed on both exits. Three modules build on them instead of hand-writing listeners.
- **`executeVscodeCommand`** (`frontend/system/commandUtils.ts:29-48`): the one lift of `executeCommand`, reading VS Code's "not registered" text once into a `reason` that a caller does read (`progressView/compareFiles.ts:61`).
- **The command registration** (`commands.ts:111-209`): one id-to-handler map, `satisfies Record<RegisteredCommandId, …>` so a new catalog row fails to compile until handled, arguments decoded at the boundary, and the program's value and rejection returned to `executeCommand` callers.
- **`ProgressViewProvider.attach`** (`progressView/ProgressViewProvider.ts:457-550`): each surface is a child scope of the view's; the port, its listeners, its render and the tab's disposal are finalizers of that scope, so closing either surface or the view releases everything in order.
- **`vscodeEditorIntegration`** (`frontend/vscodeEditorIntegration.ts`): the editor port implemented over VS Code's configuration API, merging and unmerging object settings so the user's other keys survive both directions.

## Considered and left alone

- **The setup launch bound twice in the extension** (`commands.ts:125-132` and `extensionHostRequests.ts:358-368`, identical `launchSetupAssistant` calls). Round 2's N3 listed it; it is item 3 of `.agents/docs/proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md` (the `runSetup` case of `openGuiWindow` owns the launch). The same holds for the other onboarding verbs the host table binds beside their commands (`gettingStarted`, `setApiKey`, `openSettings`): they are one-line bindings and follow item 3's fix.
- **`checkCoreDependencies` living in the extension and the desktop answering `[]`** (`progressView/checkCoreDependencies.ts`; `packages/desktop/src/main/desktopProjectBindings.ts:251`): `.agents/docs/proposed/simplification/2026-11-04-core-dependency-check-overlap.md`.
- **`openBuild.ts`'s build-to-show program and the LaTeX Workshop `outDir` expansion**: note item 2 (compile for display) and TC1 (landed).
- **`latexPreamble` / `resourcesPath` and the `hostFailure` literal in `extensionHostRequests.ts`**: this round's TC2 report (`TC2-texra-controllers.md:10,52`); open PR #14953 also replaces the `HostFailed` literals there.
- **`dispatchCommandFromRegistry`'s unreachable `unhandled` branch in the extension** (`commands.ts:196-200`; the handler map is total): round 2's J named the registry's generality; the lens audit kept the registry as a good module (`general-special.md:670-673`). One branch, not worth reopening.
- **The `texra.removeApiKey` and `texra.show*` rows hidden from the palette**: each has a reachable invoker (the setup agent's `invoke_command` allowlist, `packages/texra/src/tools/setup/InvokeCommandTool.ts:23-38`, the walkthrough links, the desktop palette), so none is unreachable. `texra.showApprovalSettings` is reached only from the walkthrough (`packages/extension/package.json:248`), which is enough.
- **Settings-view message types**: every inbound `SETTINGS_VIEW_COMMANDS` member has a sender in `settingsView/frontend` and a handler in the settings body, and every outbound member a handler (checked member by member); no orphan.
- **Agent YAML fields** (`packages/extension/resources/agents/`): `name` equals the file stem in all 35 bundled files, but it is the persona format's identity and users write their own files (root `AGENTS.md`, "Agent system"); `temperature` is set by 5 of 33, `tools` by 19, `task` by 13. Nothing constant or unread.
- **Two sample-project commands** (`commands/system/sampleProjectCommands.ts`: create beside, or create inside the open folder): different products for the two windows, not a duplicated rule.
- **`clean.ts` beside `cleanCommands.ts`**: the split keeps the listing VS Code-free for its test (`packages/extension/test/housekeeping/CleanBuild.vitest.ts`).
- **`instruction.ts`'s per-key suppression read through `Settings.state`**: the `globalState` threading is M8's refused part (`PLATFORM-roots-drop-global-slots`).

## Summary

| Id | Title | Package | Flags | Size | Owner decision? |
| --- | --- | --- | --- | --- | --- |
| EX-1 | Sessions closed three times at deactivation; the ordering comment is false | extension | repetition; false comment | ~12 lines, 1 file | no |
| EX-2 | "Is there a folder?" asked at seven sites with six answers after activation settled it | extension | errors not defined out of existence; silent degradation; special and general mixed | ~60 lines, 9 files | partly (where the narrowed roots type lives) |
| EX-3 | `texra.showProgressView` decodes an `inPlace` option no caller passes | extension | option for a special case; overexposure | ~14 lines, 2 files | no |
| EX-4 | `globalState` travels beside the `roots` that hold it | extension | pass-through variable | ~20 lines, 3 files | no |
| EX-5 | Placement verbs written three times; five reach the host table through a `Deferred` | extension | pass-through method; temporal decomposition; repetition | ~60 lines, 2 files | no |
| EX-6 | `initVscodePlatform` takes the service as an option its other argument decides | extension | option for a special case; non-obvious code | ~18 lines, 1 file | no |
| EX-7 | Two error classes carry a `member` literal nothing reads | extension | error kind nothing branches on; overexposure | ~12 lines, 2 files | no |
| EX-8 | Three file pickers are a factory, an options interface and a thunk | extension | single-caller extraction; shallow module; derivable column | ~70 removed / ~30 added, 3 files | no |
| EX-9 | `registerCommands` also builds the settings view and returns it | extension | conjoined methods; vague name | ~25 lines, 2 files | no |
| EX-10 | Instruction notice: a second message-box lift, a wait option missing where a Lean call blocks, a per-host `showSuppress` default | extension, harness, cli | option for a special case; repetition; non-obvious code | ~60 lines, 6 files | yes (the `showSuppress` schema and NDJSON field) |
| EX-11 | Inline comments and inline criticism keep their VS Code handle in module slots | extension | shared mutable state; temporal decomposition | ~50 lines, 4 files | no |
| EX-12 | Four VS Code calls lifted again in five places beside their owning wrappers | extension | repetition; false comment; export with one consumer | ~80 removed / ~20 added, 8 files | no (pick: arXiv inline validation) |
| EX-13 | Guide page per notice button decided per host; the agent-issue page has one value | extension, desktop, texra, harness | repetition; option for a special case | ~30 lines, 5 files | yes (`issueReporter` in `/host`) |
| EX-14 | Batched: guard status union, walkthrough boolean, `viewName`, dead branches, `withProgress` (N2 remainder) | extension, texra, desktop | option for a special case; conjoined methods; false comment; silent degradation | ~70 lines, 9 files | only `withProgress` |
