# EX: the VS Code extension (`packages/extension/src/`, `packages/extension/resources/`)

Read on `main` at `d70ad92` (the working tree's code is that commit; later
commits only add audit reports). Read-only.

## Numbers

TypeScript lines under `packages/extension/src/` (15,758 total):

| Directory                                    | Lines |
| -------------------------------------------- | ----: |
| `settingsView/`                              | 7,346 |
| `frontend/`                                  | 4,607 |
| `progressView/`                              | 1,603 |
| `commands/`                                  | 1,167 |
| root entries (`extension.ts`, `commands.ts`) |   853 |
| `common/`                                    |   182 |

Five largest files: `progressView/ProgressViewProvider.ts` (687),
`extension.ts` (630), `frontend/lean/VscodeIntegration.ts` (531),
`settingsView/frontend/tabs/LaTeXTab.ts` (505),
`settingsView/frontend/components/plugins/PluginCard.ts` (487).

`resources/agents/` holds 33 persona YAML files, `criticize.tex`, and `write/` (two
more YAML files and their LaTeX templates).

## EX-1: A VS Code call that fails has six spellings in the extension; `HostFailed`, the one tag defined for it, is used beside five local copies of its shape

- flags: repetition, special-general mixed, comment restates code
- package: extension
- kind: refactor
- size: M
- earlier: remainder of G10 / V-R14 (#14802 "one `HostFailed`"), which merged
  the app's host-port tags in `packages/texra`; the extension's own tags were
  never in its scope. Not the refused `RT-tool-edit-staging-one-owner`.
- open PR: #14953 (`claude/optimistic-cori-q0n270`) swaps one hand-built
  `new HostFailed` for `hostFailed()` in `VscodeUiHost.ts` and
  `extensionHostRequests.ts`; it leaves every class below.

**Evidence.** `HostFailed { member, message, cause }`
(`packages/texra/src/hosts/uiHosts.ts:59-63`) is documented as the tag for "a
host capability failed on a channel its caller has no other tag for: a
message or dialog the host's own machinery would not show ..., a
promise-faced host API that rejected" (`uiHosts.ts:43-58`), with
`hostFailed(member, cause)` as its constructor
(`packages/texra/src/controllers/session/hostCallFailure.ts:47-49`). The
extension declares nine more `Schema.TaggedError` classes; five of them are
that shape under another name, and nothing tells them apart:

| Class                    | Fields                                  | Raised                                                      | Discriminated by tag or field                         |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `SurfacePlacementFailed` | `member, message, cause`                | `progressView/ProgressViewProvider.ts:82-89`, `:97`, `:491` | 0                                                     |
| `OpenDialogFailed`       | `member` (2 literals), `message, cause` | `frontend/ui/dialogs.ts:16-23`, `:104`, `:144`              | 0                                                     |
| `HostPromptFailed`       | `message, cause`                        | `frontend/ui/dialogs.ts:26-35`                              | 0 (one type import, `commands/git/gitCommands.ts:11`) |
| `EditorOpenFailed`       | `message, absolutePath, cause`          | `frontend/vscode/vscodeEditor.ts:14-21`, `:60`, `:87`       | 0                                                     |
| `VscodeCommandFailed`    | `message, commandId, cause`             | `frontend/lean/VscodeIntegration.ts:48-55`, `:221`          | 0                                                     |

`SurfacePlacementFailed` is `HostFailed` field for field, and its comment
gives the reason it exists as "these reach the request channel, whose
failures are tags without exception" (`ProgressViewProvider.ts:77-81`), which
`HostFailed` already is. `VscodeCommandFailed` only re-wraps the
`VscodeCommandRefused` that `executeVscodeCommand` returns
(`VscodeIntegration.ts:214-228` over `frontend/system/commandUtils.ts:30-48`),
copying its `commandId` and `cause`; its comment says "VS Code reports an
unregistered id the same way it reports a faulting one"
(`VscodeIntegration.ts:44-47`), which `commandUtils.ts:12-15` and
`:40-42` contradict (VS Code names an unregistered id in the message, and
`compareFiles.ts:61` branches on it). A grep of `catchTag`, `catchTags`,
`catchIf` and `_tag ===` in `packages/extension/src` finds six sites; none
names any of the five classes (`compareFiles.ts:60`,
`VscodeIntegration.ts:250`, `:395`, `apiKeyCommands.ts:148`, `:170`,
`setupAssistantCommand.ts:38`). The classes that are read stay:
`VscodeCommandRefused.reason` (`compareFiles.ts:61`),
`LeanExtensionUnavailable.reason` (`VscodeIntegration.ts:250-251`),
`LspRequestFailed` (`:395`), `WebviewTemplateMissingBody`
(`common/webview/BundledViewContentProvider.ts:10-19`, its own message).

**The design decision behind it.** What a failed VS Code call is called. The
app answered it once (`HostFailed`, named by `member`); each extension
module answers it again when it lifts its own API.

**The better design.** Every lift of a VS Code API that no caller branches
on fails with `HostFailed`, built by `hostFailed(member, cause)`, or by
`new HostFailed` where the message is worded (`VscodeUiHost.ts:118-124`,
`:143-147` keep theirs). `showInSidebar` and `attach` map to
`hostFailed('showInSidebar' | 'attach', cause)`; `quickPick`, `inputBox`,
`selectFiles`, `selectFolder` and `openFileInEditor` pass
`(cause) => hostFailed('<member>', cause)`; `executeLeanCommand` disappears
and its two callers yield `executeVscodeCommand(id)` directly. Deleted: the
five classes (5 declarations, 9 construction sites, 1 type import), the
`hostPromptFailed` helper (`dialogs.ts:34-35`), `executeLeanCommand`, and the
false comment. Callers write nothing new: their error unions narrow to
`HostFailed`.

**What we give up, and risk.** `EditorOpenFailed.absolutePath` is read by
nobody (the message already names the path). A future caller that wants to
tell a dialog fault from a command fault reads `member`, as the app's do.

**How I tried to refute it.** Looked for any reader of each tag or field
(`grep -rn` over `packages/*/src`, `src/`, `packages/*/test`: the five
names appear only at their declarations and raise sites, plus the one type
import). Checked that the request channel needs only "a tag"
(`hostCallFailure.ts:20-31`: `HostCommandFailure` is `Error & { _tag }`).
Checked V-R14's scope: #14802 merged `PromptFailed`, `NotificationFailed`
and `ExternalOpenFailed` in `packages/texra`; the extension's files were not
in it.

## EX-2: Both GUI hosts hand the shared settings body and window four values that are the same on every host, and the process already holds the resources root they restate

- flags: information leakage, pass-through, overexposure, comment restates code
- package: texra (`controllers/settingsView/`, `controllers/session/openGuiWindow.ts`,
  `controllers/progressView/ChatExportController.ts`); touches desktop
  (five `main/` modules) and extension (two modules)
- kind: refactor
- size: M
- earlier: none (no earlier report names `resourcesPath` on the window or
  settings body, `latexPreamble`, `accountCopy` or `skillDisplay`; round 2's
  `G-app-controllers.md:721-723` was about `TexraProcessHost.resourcesPath?`,
  which is now required). TC-8 (this round) is about the export's input
  loader, not these ports.
- open PR: #14955 (`claude/clever-pascal-h5a0xm`) edits
  `openGuiWindow.ts`, `settingsViewBody.ts`, `extensionHostRequests.ts`
  and `desktopHostRequests.ts`, none of these fields.

**Evidence.** Each host computes its resources root once for the process
layer (`packages/extension/src/extension.ts:165`;
`packages/desktop/src/main/platform/index.ts:83-87`), which keeps it as
`AgentDirectoryService.resourcesRoot`
(`packages/texra/src/controllers/texraProcessLayer.ts:52-54,99-108`;
`packages/harness/src/agent/index/AgentDirectoryService.ts:73,80`), served
as `AgentDirectories` (`packages/harness/src/platform/interfaces.ts:106-111`).
Then each host hands the same value again to two shared bodies:

- **The resources root, again.** `makeSettingsViewBody({ resourcesPath })`
  (`packages/texra/src/controllers/settingsView/settingsViewBody.ts:86-88`,
  read only to pass on at `:133` to `settingsAgentCommands.ts:104`, read at
  `:403` to find `templates/*.yaml`, `:84-91`), and the window's
  `export.resourcesPath` (`controllers/session/openGuiWindow.ts:214-221`,
  `:428`, read by `ChatExportController.ts:57,67` for the trace-viewer
  template). The extension writes `path.join(context.extensionPath,
  'resources')` three times (`extension.ts:165`,
  `settingsView/SettingsViewProvider.ts:103`,
  `progressView/extensionHostRequests.ts:449`). The desktop threads the
  value through five modules to reach the two bodies
  (`main/desktopWindow.ts:84-85,218,228`;
  `main/desktopProjectBindings.ts:86,279`;
  `main/desktopProjectSurface.ts:55,200`;
  `main/desktopSettingsIpc.ts:49,154`;
  `main/desktopHostRequests.ts:49,203`).
- **The chat-export preamble.** Both hosts write the same bundle-time import,
  `import latexPreamble from '@resources/templates/chatExport.tex'`
  (`extensionHostRequests.ts:48,448`; `desktopHostRequests.ts:18,202`), so
  the window can hand it to `formatChatAsLatex`
  (`openGuiWindow.ts:218,427`; `ChatExportController.ts:55,137`). The agent
  templates in the same `templates/` directory are read at run time from the
  resources root (`settingsAgentCommands.ts:84-91`). One directory, two ways
  in.
- **The account copy.** Both hosts pass `accountCopy: ACCOUNT_OUTCOME`
  (`SettingsViewProvider.ts:105`; `desktopSettingsIpc.ts:156`), and the
  extension imports the same constant for its own message
  (`extension.ts:70,278`). The port's comment gives the reason as "the
  account copy (`src/ui`), which controllers likewise take from their host"
  (`settingsViewBody.ts:93-94`); controllers import `@ui/copy` directly
  elsewhere (`openGuiWindow.ts:73`, `controllers/server/serviceSession.ts:51`),
  so the stated rule does not hold.
- **The skills listing.** Both hosts pass `skillDisplay: Skills.display(roots)`
  (`SettingsViewProvider.ts:104`; `desktopSettingsIpc.ts:155`), the body
  already holding `roots` (`settingsViewBody.ts:86`); the comment says
  "controllers take from their host rather than import" (`:90-91`), and
  `Skills` comes from `@texra-ai/harness/host`, which texra controllers
  import throughout.

Consumers: `makeSettingsViewBody` has exactly these two callers (grep over
`packages`, `src`); no test passes a different `accountCopy` or
`skillDisplay` (grep over `src/`, `packages/*/test`: 0).

**The design decision behind it.** Where the app's packaged resources are,
and which copy and listing the settings view shows. Each is one fact the
app decides; the ports make every host decide it again and keep the two
answers equal by hand.

**The better design.** `texraProcessLayer` serves its `resourcesPath` as a
texra `Context.Service` (an `AppResources { root }`, provided beside
`HostWindows`), or the bodies read `AgentDirectories.resourcesRoot`. The
settings body and the chat export yield it; `exportRunTranscript` reads
`templates/chatExport.tex` from it at export time, as the agent templates
already are. The settings body imports `ACCOUNT_OUTCOME` and calls
`Skills.display(roots)` itself. Deleted: `SettingsViewBodyPorts.resourcesPath`,
`.skillDisplay`, `.accountCopy` (with its 14-line inline type and two false
comments); `GuiWindowHost.export.latexPreamble` and `.resourcesPath`; the
two `chatExport.tex` imports and the `.tex` text loader entries if nothing
else needs them (`packages/extension/esbuild.config.mjs:30`,
`packages/desktop/esbuild.main.mjs:62`); `resourcesPath` from
`DesktopHostRequestsOptions`, the desktop settings IPC, surface and bindings
options and `desktopWindow`'s options (about 12 lines), and the extension's two
extra `path.join` sites.

**What we give up, and risk.** The export reads a small file at export time
instead of carrying a bundled string; a missing template becomes an export
failure, the same as a missing trace-viewer template is today. A host that
wanted different account wording would need a port again; none does.

**How I tried to refute it.** Looked for a host whose value differs: both
pass the same constant and the same call. Looked for a layer rule that
forbids `@ui` or `@texra-ai/harness/host` in `controllers/`: none in
`oxlint.config.mts`, and both are imported there today. Checked that the
process layer's root is the same directory the bodies read: both hosts pass
one variable to both (`extension.ts:165` vs `SettingsViewProvider.ts:103`,
`desktop/main/platform/index.ts:87` and `:124` returning the same
`resourcesPath` that `desktop/main/index.ts:186` hands `openDesktopWindow`).

## EX-3: "Which progress surface is on screen, and how to bring one forward" is still decided at six sites in three modules

- flags: conjoined methods, repetition, pass-through, shallow module
- package: extension
- kind: refactor
- size: M
- earlier: remainder of round 2's N6 ("The progress view's two surfaces are
  four optional fields and a callback", `2026-11-06-design-red-flags-round-2/N-vscode-desktop.md:372-413`),
  catalogued as landed (#14791). The fields became one `Surfaces` record
  with scoped surfaces; N6's other half, "`visibleSurfacePort` is the one
  reader ...; `RequestAttention` takes `surface()` and `reveal()` instead of
  six getters", and the deletion of `isViewVisible` did not land.
- open PR: #14955 (`claude/clever-pascal-h5a0xm`) edits
  `ProgressViewProvider.ts` and `agentEventListeners.ts` (the setup-agent
  follower and the presentation host); it leaves every site below.

**Evidence.** In `packages/extension/src/progressView/ProgressViewProvider.ts`:

1. `visibleSurface()` (`:566-572`): editor tab if active, else a visible
   sidebar, else a visible tab.
2. `isViewVisible()` (`:603-606`): `sidebar.visible || editor.visible`, the
   same fact as `visibleSurface() !== undefined` (an active panel is a
   visible one) in a second formula. Readers: `RequestAttention`
   (`:352`, `requestAttention.ts:92`) and `revealProgressView`
   (`frontend/events/agentEventListeners.ts:176,188`).
3. `chime()` (`:578-584`) and `submit()` (`:590-601`) each add a fallback
   order of their own after `visibleSurface()`.
4. `showProgressView()` (`:634-647`): the tab if attached, else the sidebar.
5. `RequestAttention.bringForward` (`progressView/requestAttention.ts:87-110`):
   the tab if attached, else a resolved sidebar, else the focus command,
   each without focus.
6. `revealProgressView` (`agentEventListeners.ts:169-206`): visible? else
   `showProgressView`, visible again? else a toast. It is a method of the
   provider in all but location: it takes
   `Pick<ProgressViewProvider, 'isViewVisible' | 'showProgressView'>` and has
   one caller, `ProgressViewProvider.ts:280`, in a module whose job is the
   runtime's presentation events (`agentEventListeners.ts:1-11`).

`RequestAttention` (`requestAttention.ts:23-111`) is constructed once
(`ProgressViewProvider.ts:349-357`) with a six-member port, four of whose
members read the provider's private `surfaces` back (`sidebar`, `panel`,
`isViewVisible`, `showInSidebar`): the class cannot be read without the
provider, and the provider's surface rules cannot be read without the class.
`ProgressViewProvider.showInSidebar()` (`:608-610`) only returns the module
constant `showInSidebar` (`:92-103`); it has no caller outside the class
(grep: three internal calls, `:598`, `:629`, `:641`), and the constant is
also handed out directly at `:282` and `:353`.

**The design decision behind it.** Which surface a host action lands on, and
how a hidden one is brought forward. `visibleSurface`'s own comment calls
itself "the one rule" (`:558-565`); five other sites restate or extend it.

**The better design.** The provider keeps two private verbs:
`visibleSurface()` (the only reader of visibility) and
`reveal({ preserveFocus })` (tab if attached, else sidebar, else the focus
command). `showProgressView`, `bringForward`, `submit` and `chime` call them;
`revealProgressView` moves into the provider as a method over them. The
attention follower becomes a provider method (or a function taking
`{ reveal, showSessions, chime, paintBadge }`), keeping its badge state.
Deleted: `isViewVisible` (2 external readers), `AttentionSurface` and its six
members, the `RequestAttention` class shell, the public `showInSidebar()`
method, and the `Pick<ProgressViewProvider, ...>` parameter of
`revealProgressView`. A third surface would then be one entry in `Surfaces`
and one line in each of the two verbs, instead of six edits in three files.

**What we give up, and risk.** `requestAttention.ts` stops being a separate
file; the provider grows by about 60 lines and the extension shrinks by
about 80. The quiet reveal and the focusing reveal differ only in
`preserveFocus`, so behavior stays as it is.

**How I tried to refute it.** Checked whether the rules really differ by
intent (they do in focus only: `bringForward` must not take focus,
`showProgressView` may), which a parameter carries. Checked for other users
of `RequestAttention`, `isViewVisible` and `revealProgressView` across
`packages/*/src`, `src/` and `packages/*/test`: none beyond those cited.
Read #14955's diff for these files: it removes the setup-agent follower and
the `agentNotFound` handler, nothing here.

## EX-4: The two editor annotation surfaces are module-level `let`s that an activation function writes and a provider handed elsewhere reads

- flags: conjoined methods, non-obvious code, temporal decomposition
- package: extension (touches texra `tools/registry.ts` only if the comment
  provider becomes a layer)
- kind: refactor
- size: S
- earlier: none for this state (round 2's H9, `H-app-tools.md:602-650`, was
  about how `texraPlugins` takes host services; it did not look at what the
  extension passes in). Root `AGENTS.md` "No shared mutable state" is the
  rule.
- open PR: none

**Evidence.**

- _Inline comments._ `frontend/comments/inlineComments.ts:35-39` holds
  `let controller`, a module `Map` of threads and `let sequence`.
  `registerInlineComments(context)` (`:142-157`) creates the controller and
  writes it; `inlineCommentProvider` (`:95-139`), a module constant, reads it
  and answers `null` when it is unset (`:97`). The provider is handed to the
  process layer before any registration
  (`extension.ts:150-153`, whose comment explains that "the provider reads
  the controller this host registers at activation, so it is a value from
  module load"), and `registerInlineComments` runs only on the folder path,
  late in `activateWorkspace` (`extension.ts:599`). So the window without a
  folder serves a provider whose every `add` answers `null`, and a second
  activation in the same module instance (a test, a reload that reuses the
  module) inherits the old `sequence` (thread ids keep counting) unless
  `disable` ran. `registerInlineComments` guards itself with
  `if (controller) return` (`:143`), which only works because the state is
  global.
- _Inline criticism._ `frontend/latex/inlineCriticism.ts:52-56` holds
  `let collection`; `showDiagnostics` (`:132-180`) writes and clears it while
  the setting is on, and `refreshFileDiagnostics` re-reads it after each
  await to notice a toggle (`:85-86,102`). `pushManualCriticism`
  (`:207-242`), exported, reads it and answers `false` when unset; it is
  handed to every window as `editor.addCriticism`
  (`progressView/ProgressViewProvider.ts:190-191`). The collection's lifetime
  is the activation scope's (`extension.ts:598`), the reader's is each
  window's.

In both, one function sets what another, in another module's wiring, reads;
neither can be understood without the order `extension.ts` happens to
call them in.

**The design decision behind it.** Who owns the comment controller and the
diagnostics collection, and for how long. Today: the module, forever, with
activation writing into it.

**The better design.** Each surface is built by the scope that owns it and
returns its reader. `makeInlineComments: Effect<InlineCommentProvider, never,
Scope>` acquires the controller, registers the three thread commands and
returns a provider closing over its own threads map and counter; the
extension passes it to `texraProcessLayer` as a `Layer.effect` (as it already
does for `lean`, `extension.ts:155-158`), or keeps the value form and builds
it in `initVscodePlatform`. `followInlineCriticism` takes a `Ref` (or
`SubscriptionRef`) of the open collection that it writes, and the window's
`addCriticism` reads the same `Ref`, created once in `activateWorkspace`.
Deleted: the three module `let`s and the module map, the
`if (controller) return` guard, `disable`'s global reset, and the comment
that justifies reading a controller registered later.

**What we give up, and risk.** The no-folder window would no longer serve
an `inline_comment` provider at all; no agent runs there (agents need a
folder, `extension.ts:391-411`), so nothing observes the difference. Thread
ids restart per activation, which is what a reader would expect.

**How I tried to refute it.** Checked whether something else needs the
module form: the only readers of `controller`, `threads`, `sequence` and
`collection` are in their own files (grep), the provider has one consumer
(`extension.ts:153`) and `pushManualCriticism` one (`ProgressViewProvider.ts:191`).
`fileLanes` (`inlineCriticism.ts:52`) is fine: `withPerKeyLane` deletes an
idle key (`packages/harness/src/utils/core/perKeyQueue.ts:61-64`), so it is
left out.

## EX-5: The settings view's frontend is app UI two hosts mount, but it lives in the extension package, so the desktop imports a host package's source and four configs name it as an exception

- flags: information leakage, special-general mixed
- package: extension (the move); touches texra (`ui/`), desktop
  (`renderer/settingsDialog.ts`, `design-harness/scenes/settings.ts`),
  root (`oxlint.config.mts`, `tsconfig.json` alias, the guides)
- kind: refactor
- size: L (34 files move; about 60 changed lines outside the move)
- earlier: none. The progress view's frontend made the same move earlier
  ("Its frontend is app code that the desktop renderer and the trace viewer
  mount too (`packages/texra/src/ui/progress/`)",
  `packages/extension/src/AGENTS.md:16`); no report or proposal names the
  settings frontend's location (grep of `.agents/docs` for
  `settingsView/frontend` finds only per-line citations).
- open PR: #14950 and #14949 edit three files inside it
  (`components/plugins/PluginCard.ts`, `components/profile/ModelSelectionList.ts`,
  `ProviderKeyList.ts`); a move should follow them.

**Evidence.** `packages/extension/src/settingsView/frontend/` is 34 files,
7,041 lines, with no VS Code import (it is a VS Code-free zone). The desktop
renderer mounts it: `import '@settingsView/frontend'`
(`packages/desktop/src/renderer/settingsDialog.ts:4`), then
`document.createElement('settings-app')` with
`data-desktop-view="settings"` (`:51-52`); the design harness does the same
(`packages/desktop/design-harness/scenes/settings.ts`). Because the code sits
in a host package, every rule that holds for app UI has to name it again:

- `oxlint.config.mts:216-222` (`VSCODE_FREE`), `:225-230`
  (`BROWSER_BUNDLES`) and `:292-300` (the `Effect.run*` zone) each list
  `packages/extension/src/settingsView/frontend` beside
  `packages/texra/src/ui` (or `packages/texra/src`, which would already cover
  it).
- `packages/extension/vite.config.mts:7-12`: "the progress view renders from
  the app's UI kit, the settings view from this package".
- `tsconfig.json:101-105`: the `@settingsView/*` alias exists so the desktop
  and the frontend's own files can reach it
  (`components/shared/stateSettingRows.ts:19`,
  `components/profile/ModelSelectionList.ts:15` import their sibling
  `settingsState` through it).
- Root `AGENTS.md` lists "the settings webview frontend" separately among
  the VS Code-free zones; `packages/extension/src/AGENTS.md:15` documents its
  state and dispatcher as the extension's.

Inside the "extension" package, the frontend carries the desktop's own
cases: `SettingsApp.isDesktopHost` and the `desktop:*` filter
(`settingsView/frontend/SettingsApp.ts:74-87`), and six
`:host([data-desktop-view])` rule blocks (`settingsView/frontend/styles.ts:161-212`,
15 `data-desktop-view`/`isDesktopHost` mentions in the folder). The
extension's host half (`SettingsViewProvider.ts`) and the shared body
(`packages/texra/src/controllers/settingsView/`) are already split along the
right line; only the frontend is on the wrong side.

**The design decision behind it.** Whose code the settings page is. Both GUI
hosts render it over the same body and the same messages
(`packages/texra/src/shared/settingsView/settingsViewMessages.ts`), so it is
the app's, as the progress view is.

**The better design.** Move `settingsView/frontend/` to
`packages/texra/src/ui/settings/` (beside `ui/progress/`), with its
`index.html` entry staying in the extension. The vite entry becomes
`'../texra/src/ui/settings/index.ts'`; the desktop imports `@ui/settings`.
Deleted: the three `oxlint.config.mts` zone entries, the `@settingsView/*`
alias's frontend use (the alias may still serve `SettingsViewProvider`, or
go), the vite comment's "from this package" case, and the separate mention
in the root guide's zone list. The `data-desktop-view` cases stay, now in
app code where a host attribute is an ordinary input.

**What we give up, and risk.** A large mechanical diff that conflicts with
any open edit inside the folder (three today). Imports inside the folder are
relative or `@ui/*` already, so the move changes few lines besides paths.
The extension's `vite:webviews` script and the desktop's renderer build must
both resolve the new path; the progress view shows they can.

**How I tried to refute it.** Looked for a VS Code dependency that would
pin it to the extension: none (`VSCODE_FREE` holds and lint enforces it).
Looked for a decision that kept it here: neither
`2026-09-03-prd-one-fold-three-renderers.md` nor
`2026-10-02-harness-package-split.md` mentions the settings frontend's
location. Checked that `packages/texra/src/ui` is already a browser bundle
zone, so the bans the frontend needs follow it there.

## EX-6 (batched): The command surface has a second registration path that drops arguments and restates a sign-in, a mode flag with one value per caller, and a command option nobody sets

- flags: repetition, special-general mixed, overexposure, conjoined methods
- package: extension (touches texra `controllers/settingsView/settingsViewBody.ts`
  for the shared sign-in outcome)
- kind: refactor
- size: S
- earlier: T8 (#14818) made "one id-to-handler map for the extension
  commands" (`commands.ts:111-178`); the no-folder table beside it was not
  in its scope. TC7's settings-panel hand-off is a different item.
- open PR: none

**Evidence.**

1. _A second registration path._ `NO_FOLDER_COMMANDS`
   (`packages/extension/src/extension.ts:258-306`) are four catalog commands
   the window without a folder registers with a raw
   `vscode.commands.registerCommand(id, () => runtime.runPromise(command(context, roots)))`
   (`:402-408`). The folder path registers through
   `dispatchCommandFromRegistry` "so the dispatch path is identical to the
   desktop's" (`commands.ts:76-84,180-209`), which decodes arguments and
   reports a bad payload. The no-folder callback takes no arguments, so
   `texra.setApiKey`'s provider argument, decoded on the folder path
   (`commands.ts:156-159`), is silently dropped there, and a failed command
   has no registry log line.
2. _The sign-in outcome, twice._ The no-folder `texra.auth.chatgpt.signIn`
   (`extension.ts:273-296`) writes its own outcome: the
   `ACCOUNT_OUTCOME.signedInEnabled(displayName, account.label, modelFamily)`
   notice, a `Cancelled` that says nothing, and the failure prefix
   `` `${displayName} sign-in failed` ``. The settings body's
   `signInSubscription` writes the same three
   (`packages/texra/src/controllers/settingsView/settingsViewBody.ts:216-237`),
   and the folder path's command runs that one (`commands.ts:123-124`).
   The CLI writes it twice more
   (`packages/cli/src/chat/tui/commands/handlers/loginCommands.ts:75`,
   `packages/cli/src/commands/_helpers/subscriptionAuthCommand.ts:96`).
3. _A flag with one value per caller._
   `registerWalkthroughWorkspaceAction(context, hasSingleWorkspace, runtime)`
   (`extension.ts:339-353`) has two calls, one passing `false` (`:409`), one
   `true` (`:531`); the flag only picks which of two bodies the command
   runs, so each path could register its own one-line handler.
4. _An option with no producer._ `texra.showProgressView` decodes an
   optional `{ inPlace?: boolean }` (`commands.ts:145-155`) into
   `showProgressView(options?)` (`progressView/ProgressViewProvider.ts:636-641`).
   Nothing passes it: the manifest binds the command with no arguments
   (`packages/extension/package.json:162`), the task pill sets
   `item.command = 'texra.showProgressView'`
   (`frontend/statusBar/taskStatusBar.ts:137`), the setup tool refuses
   arguments (`packages/texra/src/tools/setup/InvokeCommandTool.ts:47-57`),
   no `executeCommand` names it (grep over `packages/*/src`, `src/`,
   `packages/*/test`, `docs/`), and the three internal callers pass nothing
   (`ProgressViewProvider.ts:656`, `:278`, `agentEventListeners.ts:181,203`).

**The design decision behind it.** How a command id reaches its program, and
what "signed in" says. The registry answers the first and the settings body
the second; the no-folder window answers both again.

**The better design.** The registration loop in `commands.ts:180-209`
becomes the one `registerHandlers(context, runtime, table, roots)` both paths
call, with `NO_FOLDER_COMMANDS` as its second table; the no-folder table's
`setApiKey` row takes the same `definedHandler` as the folder row. The
sign-in's outcome is one texra function (the body's lines 218-235,
`announceSignIn(provider, signIn)`) that the body and the no-folder command
both run. `registerWalkthroughWorkspaceAction` loses its flag: each path
registers its own handler. `inPlace` and the argument schema of
`texra.showProgressView` go; the handler becomes `() => showProgressView()`.
Deleted: about 40 lines, one boolean parameter, one option.

**What we give up, and risk.** A user keybinding that passed
`{ "inPlace": true }` to `texra.showProgressView` would stop being honored;
no documentation mentions the option (grep `docs/`: 0).

**How I tried to refute it.** Looked for a caller that relies on the
no-folder path ignoring arguments: none passes any. Checked that the no-folder
window can run the registry path: it holds `runtime` and `roots`
(`extension.ts:397-400`), which is all the loop uses besides the settings
view, and none of its four rows needs that. Checked the CLI copies are the
same wording (`ACCOUNT_OUTCOME.signedInEnabled`), so a shared function could
serve them too; they are outside this area and left as a pointer.

## EX-7 (batched): The extension's guide names deleted symbols and wrong homes, and its code carries false comments, comments that narrate the code they replaced, and refused words

- flags: comment restates code, vague name
- package: extension (touches root `AGENTS.md` for one line)
- kind: docs
- size: S
- earlier: none for these lines. TU-8 (this round) covers the same words in
  the progress view's request path in `packages/texra`; the round-5 docs
  report did not cover `packages/extension/src/AGENTS.md`.
- open PR: none of the lines below is in an open PR's diff.

**Evidence.**

_The area guide (`packages/extension/src/AGENTS.md`)._

- `:15`: "`settingsView/frontend/messageDispatcher.ts` holds the one outbound
  registry (`settingsViewHandlers`, typed
  `SettingsViewOutboundHandlerRegistry` to stay exhaustive)". Neither name
  exists anywhere in the repo (grep: only this line); the dispatcher is a
  `switch` over the decoded message (`settingsView/frontend/messageDispatcher.ts:28-87`),
  exhaustive through the schema union.
- `:24`: "Shared notification primitives: `frontend/ui/dialogs.ts` and
  `instruction.ts`". `dialogs.ts` holds the pickers (`quickPick`,
  `inputBox`, `selectFiles`, `selectFolder`, `:37-149`); the notices are
  `vscodeUi` (`frontend/hosts/VscodeUiHost.ts:78-185`) and the logged
  helpers (`frontend/ui/errorHandlingUtils.ts`).
- `:8`: "`frontend/` ... (`system/`, `ui/`, `editor/`, `agents/`, `latex/`:
  agent directories, approvals, ...)". `frontend/agents/` is one file,
  `finalOutputOpener.ts`, with nothing about agent directories; eight of the
  thirteen subdirectories (`approval/`, `auth/`, `comments/`, `events/`,
  `hosts/`, `lean/`, `statusBar/`, `vscode/`) are not listed.
- Root `AGENTS.md:166`: "Webview base classes are in
  `packages/extension/src/common/webview/`". That folder holds one class,
  `BundledViewContentProvider`, which no view extends; the area guide itself
  says "There is no shared message-handler base class" (`:13`).

_False comments in code._

- `extension.ts:555-557`: "Workspace folders opened/closed can flip
  `isGitRepository` ... ProgressViewProvider owns the ordered
  workspace-storage and native-config replacement." The provider's folder
  listener only refreshes the snapshot's roots and files
  (`progressView/ProgressViewProvider.ts:405-424`) and says the storage
  root never moves under a live window (#11432); the git probe reads the
  window's workspace (`packages/texra/src/tools/github/plugin.ts:37-44`),
  the first folder, which a folder change in a live host cannot replace.
- `frontend/lean/VscodeIntegration.ts:44-47` (in EX-1).

_Comments that narrate the code they replaced_ (a reader of the current
code has never seen it):

- `frontend/editor/activeFileGuards.ts:153-158`: "as the `try`/`catch` it
  replaces was".
- `commands/system/sampleProjectCommands.ts:70-72`: "with the options the
  replaced facade used"; `:108-110`: "as the single `Effect.catch` over the
  async body it replaces was".
- `frontend/approval/VscodeToolEditApprovalHost.ts:99`: "Fire-and-forget, as
  the voided promise was".
- `frontend/approval/VscodeDiffViewHost.ts:121-122`: "the same last attempt
  the raced promise made".
- `frontend/ui/dialogs.ts:86-88`: "as the caller's `runFork` left it".

_Words the root guide's "Plain names" table refuses._

- "plane": `frontend/events/agentEventListeners.ts:9` ("presentation plane").
- "settle(s)": `extension.ts:431,516`, `progressView/extensionHostRequests.ts:102`,
  `progressView/ProgressViewProvider.ts:451`,
  `agentEventListeners.ts:87,125`, `frontend/ui/progress.ts:17-18` (and its
  `taskSettled` variable, `:38`), `frontend/ui/instruction.ts:51-82` (a
  variable named `settle`, and "Failed to settle instruction" in a log line,
  `:82`), `commands/latex/figCommands.ts:39`, `commands/latex/latexCommands.ts:142`.
- "arm(s)" for a request handler or error case:
  `extensionHostRequests.ts:4-8,101,129,375-378`,
  `frontend/ui/errorHandlingUtils.ts:19`.

**The design decision behind it.** None; these are the guide and comments
falling behind the code.

**The better design.** Rewrite the three guide lines to name what exists
(the `switch` in `messageDispatcher.ts`; `VscodeUiHost.ts` and
`errorHandlingUtils.ts` for notices; the actual subdirectories) and the
root line to "the webview HTML provider is in ...". Replace the
`extension.ts:555-557` comment with what the listener is for, or delete the
listener if the tool probes read nothing a non-first folder changes. Cut the
narrations to the reason they carry ("one boundary for the whole command:
a failed step and a failed operation are reported alike"). Use "finish",
"layer", "handler" or "case" for the refused words; rename `settle` and
`taskSettled` (`showAndAnswer`, `taskDone`).

**What we give up, and risk.** Nothing; comments and one log string.

**How I tried to refute it.** Grepped each named symbol and directory;
read the provider's folder listener and the GitHub probe for the
`extension.ts` claim. The `#3782` citations (`commands.ts:82-83`) carry
their reason beside the number and are left alone.

## EX-8 (batched): The progress view threads its roots, runtime, scope and a second copy of the global state store into three builders, each of which wraps the same `openBuilt` call

- flags: pass-through, repetition
- package: extension
- kind: refactor
- size: S
- earlier: the `globalState`-beside-`roots` hops were listed under M8 in the
  pass-through lens (`2026-11-07-design-red-flags-lenses/pass-through.md:580-598`),
  whose fix (drop the roots' global slots) was refused
  (`PLATFORM-roots-drop-global-slots`); this finding goes the other way:
  keep `roots.globalState` and drop the separate parameter, which the
  refusal does not touch. The duplicate `openBuilt` wrappers are not in any
  earlier report.
- open PR: #14955 (`claude/clever-pascal-h5a0xm`) drops `snapshot` from
  `createAgentPresentationHost` and keeps the rest of its parameters; the
  items below remain on its branch.

**Evidence.**

- _A second copy of one store._ `activateWorkspace` reads
  `const { globalState } = roots` (`extension.ts:460`) and passes both
  (`:490-494`) to `ProgressViewProvider.make(context, globalState, runtime,
  roots, ...)` (`progressView/ProgressViewProvider.ts:150-160`), which keeps
  it as a field (`:132`, `:359`, `:370`; one read, `:621`) and forwards both
  again to `createAgentPresentationHost(snapshot, globalState, runtime,
  roots, scope)` (`:264-270`), which forwards both to
  `handleRequestShowInstruction(globalState, roots, runtime, payload)`
  (`frontend/events/agentEventListeners.ts:107-112,239-240`).
  `roots.globalState` is the same object at every hop.
- _`openBuilt` wrapped three times._ Each of the window's three consumers of
  "show a built file" captures `roots` and the view's `scope` and adds the
  same pipe: the presentation host's `openFile`
  (`agentEventListeners.ts:232-238`, plus `withProcessServices(runtime, ...)`),
  the approval host's `openBuildDisplay`
  (`frontend/approval/VscodeToolEditApprovalHost.ts:44-47`, whose
  constructor takes `roots` and `scope` for this line alone, `:50-64`), and
  the latexdiff `openDiffs` (`progressView/extensionHostRequests.ts:309-319`,
  through its own `inViewScope`, `:190-194`). The desktop builds its
  counterpart once per window, `previewHost.openBuildDisplayIn(roots)`
  (`packages/desktop/src/main/desktopPreviewHost.ts:58,190`), and hands the
  one function to each consumer (`desktopWindowHost.ts:254-260`).

**The design decision behind it.** Where the window's "show a built file"
is bound to its roots and scope. The extension binds it at each use; the
desktop binds it once.

**The better design.** `ProgressViewProvider.make` builds one
`showBuilt(locations, options)` over `roots`, `scope` and `runtime` and
passes it to the three consumers. `VscodeToolEditApprovalHost` takes
`(storageDirectory, fork, showBuilt)`; `createAgentPresentationHost` takes
`(roots, runtime, showBuilt)` and reads `roots.globalState`; the
`globalState` parameter and field of `ProgressViewProvider` go (its one
read becomes `roots.globalState`, which needs `roots` kept as a field or the
read moved into `make`). Deleted: 2 constructor parameters and fields of the
approval host, the `globalState` parameter at three hops, `inViewScope`, two
copies of the `openBuilt(...).pipe(provideService(Scope, scope))` wrapper.

**What we give up, and risk.** Nothing visible; the three call sites keep
their own options (`preserveFocus`).

**How I tried to refute it.** Checked that `roots.globalState` and the
passed `globalState` are one object (`extension.ts:460`). Checked that the
approval host reads `roots`/`scope` nowhere else (grep in the file: only
`:44-47` and the constructor). Checked that the three wrappers differ only
in the location list and `preserveFocus`.

## EX-9 (batched): Three small VS Code adapters are written by hand at each use: an event as a stream (five copies), the browser opener (seven instances of a stateless class), and the LaTeX-command guard's log channel

- flags: repetition, overexposure, non-obvious code
- package: extension
- kind: refactor
- size: S
- earlier: none (PT4, #14818, removed log channels passed through ports;
  `runGuardedLatexCommand`'s `channel` option was not in it).
- open PR: none

**Evidence.**

1. _A VS Code event as a stream._ The extension turns a `vscode.Event` into
   a `Stream` with the same eight lines (`Stream.callback` +
   `Effect.acquireRelease(Effect.sync(() => event(() => Queue.offerUnsafe(queue, ...))), (l) => Effect.sync(() => l.dispose()))`)
   five times: `progressView/ProgressViewProvider.ts:217-226` (window
   focus), `:392-404` (file watcher), `:408-417` (workspace folders),
   `frontend/ui/diffView.ts:25-34` (view columns),
   `commands/api/apiKeyCommands.ts:65-73` (an input-box button). The
   one-shot counterpart already has its module,
   `firstEventOrTimeout` (`frontend/vscode/vscodeEventWait.ts:15-33`, four
   callers). A `vscode.Event<T>` is itself the subscribe function, so the
   adapter is one function, `eventStream(event)`.
2. _The browser opener._ `VscodeExternalOpener` holds no state
   (`frontend/hosts/VscodeExternalOpener.ts:13-41`, one method), yet is
   constructed per use at seven sites:
   `progressView/extensionHostRequests.ts:165,339`,
   `settingsView/SettingsViewProvider.ts:122`,
   `frontend/auth/subscriptionSignIn.ts:28`,
   `frontend/hosts/VscodeExternalOpener.ts:47`,
   `commands/api/apiKeyCommands.ts:78`, `commands/git/gitCommands.ts:43`.
   The dialogs beside it are one module instance for exactly that reason
   ("The host holds no state ... so the surfaces that present on it share
   this rather than each constructing a copy of the same empty object",
   `frontend/hosts/VscodeUiHost.ts:180-185`).
3. _The guard's channel._ `runGuardedLatexCommand` takes `channel`
   (`frontend/editor/activeFileGuards.ts:114-115`) and applies it to the
   whole program (`:166`); its callers pass their channel and then put
   `withLogChannel(CHANNEL)` on their own log lines inside the operation as
   well (`commands/latex/latexCommands.ts:40-42`, `:73-75`, `:113-115`),
   so the channel is said twice per line. Root `AGENTS.md` puts the channel
   at the program's entry (`withLogChannel`), which each command already is.
   The same guard decides "is LaTeX" as `fileName.toLowerCase().endsWith('.tex')`
   (`activeFileGuards.ts:73`) while the rest of the app uses `isLatexFile`
   (`packages/texra/src/shared/latexFileTypes.ts:23-29`, `.tex`, `.ltx`,
   `.latex`), which `frontend/latex/openBuild.ts:217` uses for the same
   editor; a `.ltx` file opens and builds there but the four LaTeX commands
   refuse it.

**The design decision behind it.** Each is the extension's own adapter over
a VS Code API, written again where it is needed.

**The better design.** `eventStream<T>(event: vscode.Event<T>): Stream<T>`
in `frontend/vscode/vscodeEventWait.ts` (renamed `vscodeEvents.ts`), and the
five sites call it (the file watcher merges two). `VscodeExternalOpener`
becomes one module value (`vscodeOpener`), as `vscodeUi` is, or its method
a plain function `openExternal(url)`. `runGuardedLatexCommand` drops
`channel` (callers wrap their program in `withLogChannel` once) and checks
`isLatexFile`. Deleted: about 30 lines of listener boilerplate, six
constructions, one option and three inner `withLogChannel` pipes.

**What we give up, and risk.** The four LaTeX commands start accepting
`.ltx` and `.latex` files; each tool behind them is handed the file by
path, so a tool that turns out to refuse the extension would say so in its
own error, which the guard already surfaces. Worth one manual check per
command before landing.

**How I tried to refute it.** Checked the five stream sites for a
difference beyond the event and the value offered: the file watcher
subscribes two events on one watcher it must also dispose, which the helper
covers by taking the watcher's disposal as a finalizer. Checked whether the
opener class is subclassed or stubbed by tests through its constructor:
`grep -rn VscodeExternalOpener src packages/*/test` finds no test use.

## Good modules in this area

- `frontend/ui/progress.ts` (`withVSCodeProgress`): VS Code's promise-only
  `withProgress` wrapped once; the body is a step of the caller's fiber, and
  `ensuring` keeps the notification from outliving an interrupted body.
- `frontend/hosts/VscodeUiHost.ts`: one wrap of the three
  `window.show*Message` calls behind the app's `Dialogs`, one module
  instance, and `withCancellationToken` as the one owner of a cancellable
  VS Code call (four users).
- `frontend/vscode/vscodeEventWait.ts` (`firstEventOrTimeout`): a small
  interface over subscribe, wait, dispose and timeout; four callers. EX-9
  asks for its streaming sibling beside it.
- `frontend/latex/openBuild.ts` (`openBuilt`): one entry for "show these
  files, build the TeX ones, open the viewer once", with the failure policy
  (what is warn-logged, what fails) stated and kept in one place.
- `frontend/statusBar/taskStatusBar.ts`: paints from the session's level
  stream through `Stream.changesWith`, so the pill repaints only when its
  status changes, and owns nothing else.
- `commands.ts`'s handler map: `satisfies Record<RegisteredCommandId, ...>`
  over the catalog makes a new catalog row fail to compile until its handler
  exists.

## Already settled, left alone

- The tool-edit preview's staging per host (`frontend/approval/`):
  refused as `RT-tool-edit-staging-one-owner`
  (`.agents/docs/refuted-candidates.json`).
- `WorkspaceRoots.globalState` itself: refused as
  `PLATFORM-roots-drop-global-slots`; EX-8 only drops the second copy beside
  it.
- `SubscriptionProvider.sessionName` and `.copyTarget`, read by
  `frontend/auth/subscriptionSignIn.ts:34`: refused as
  `G11f-subscription-descriptor-columns`.
- `progressView/findCommit.ts` (two `git` processes for a yes/no): TC-5 in
  this round.
- The settings frontend's untyped `postMessage(command, payload)` calls:
  TC-9 in this round.
- The settings panel's ready hand-off (a `Latch`,
  `settingsView/SettingsViewProvider.ts:70-73`): TC7's extension half,
  landed.
- The setup-agent selection follower and the `agentNotFound` handler in
  `ProgressViewProvider.ts` / `agentEventListeners.ts`: moved out by open
  PR #14955.

## Dropped on verification (12)

- The two `Deferred`s that break construction cycles
  (`extension.ts:489-506`, settings view and progress view;
  `ProgressViewProvider.ts:181-184`, host verbs and the view): both cycles
  are real (each side needs the other's bridge or verbs), and routing
  through VS Code commands instead would re-enter the runtime, which
  `extensionHostRequests.ts:374-380` avoids on purpose.
- `Sessions.closeAll` registered as a finalizer twice (`extension.ts:203-208`,
  `:518-520`): the early one orders the close before the view tears down;
  the late one is the backstop when activation fails before the early one
  is registered.
- `DiffViewHost` as a one-implementation port: the desktop implements it
  too (`packages/desktop/src/main/desktopDiffHost.ts:31`).
- `createProfileKeyController` (`commands/api/apiKeyCommands.ts:32-36`):
  two callers.
- `instruction.ts` calling `window.showInformationMessage` past `vscodeUi`:
  it needs "shown now, answered later" (`deferDismissal`), which `ask` does
  not offer; small and stated.
- `launchSetupAssistant` called with the same arguments from two sites
  (`commands.ts:125-132`, `extensionHostRequests.ts:356-366`): a remainder
  of N3 too small to stand alone.
- The coder agents' `temperature` column (`resources/agents/*.yaml`): the
  values differ (0.2, 0.3), so it is not a constant column.
- `SettingsViewProvider.signInSubscription` forwarding to the body: two
  callers, and it is the class's public verb for the command.
- The settings bindings `runLabel` / `revealRun` asked of each host: the
  desktop's answer differs (`'unavailable'`, `desktopProjectSurface.ts:155-165`).
- `findCommitInHistory`: TC-5.
- The untyped settings `postMessage`: TC-9.
- `activeFileGuards`' reason table split between a notifier and a logger:
  one file, one caller, and the table is the stated single owner.
