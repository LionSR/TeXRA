# Rules decided per host and app facts with two owners

Date: 2026-11-15
Status: proposed (four findings landed with this note, and more in the
three sweeps listed at the end; the rest are open)
Origin: the 2026-11-15 scheduled responsibility audit on `main` at `1dd278b`.
Two read-only surveys (the three hosts against the shared controllers; the
app package and `packages/llm`) and a check of each finding against the code.

The package boundaries hold: the host request tables, the settings body, the
session open, the update check and the API-key controller each have one
owner, and `packages/llm` showed no duplicated classification, retry or
header logic. What remains is smaller: a sequence of ten to seventy lines
that two or three hosts each write, and an app fact listed in two tables.
Most copies have drifted, which is why they matter.

## Landed with this note

1. **A subscription sign-in's outcome.** Five wordings of the success
   sentence, the failure reported by the extension's binding instead of the
   settings body, and an onboarding card that bypassed the body. The host
   binding now answers the account; the body
   (`packages/texra/src/controllers/settingsView/settingsViewBody.ts`) tells
   the outcome for every entry point of a window.
2. **Instruction button labels.** One table in
   `packages/texra/src/ui/copy/instructionActions.ts` for both windows.
3. **Managed directories.** `EXCLUDED_DIRS` is deleted;
   `packages/texra/src/common/files/fileHandlingRules.ts` states the managed
   directories once. Clean Build no longer lists a `build/` inside
   `node_modules` or `venv`, and the formatter no longer walks into them.
4. **Coding-plan columns.** `credentialName` and `credentialSetupUrl`
   restated the API provider's name and key page. (`usageProvider`, which
   restates the row's id, is removed by the same day's data-structure
   audit.)

Two items of earlier notes are closed by these or were already done:
`2026-11-14-reading-a-failed-cause.md` (the sign-out preference and the
onboarding sign-in) and `2026-11-03-git-reads-and-subscription-facts-overlap.md`
(item 2, the file is `subscriptionAuthStatus.ts` now; the note moves to
`implemented/`).

## Open: rules each host decides

In order of size. Each needs the decision named.

1. **Opening a project's roots.** Landed for the extension, the desktop
   and the service: `openProjectRoots`
   (`packages/texra/src/controllers/session/openProjectSession.ts`) opens a
   project's config stores and roots, and `openProjectSession` decides
   "service or local" for a window. The CLI
   (`packages/cli/src/runtime/platform/initPlatform.ts`) stays on its own
   open. Checked on 2026-11-19 against both files, its difference is real:
   - **The config stores are already open.** `buildCliContext` opens the
     project, local and user stores before the command's runtime exists
     (`loadCliStartupConfig`), because the runtime is built from what they
     say: the log level, the output format, the approval policy, the model.
     `openProjectRoots` opens the project and local stores itself, so
     calling it would give the process two providers over the same files,
     `context.config` (which every command holds) and `roots.config`, and a
     value written through one would reach the other only through the file.
     Taking an open provider instead would make its config parameter a union
     and leave the `serviceProjectState` spread as the only shared lines.
   - **The CLI needs both sessions, lazily.** `openProjectSession` opens one
     session when called and answers a window's link
     (`HostWindows.localLink`). The CLI opens none until a step asks
     (`auth`, `doctor` and `models` never do), a headless `run` reads the
     local session (`services.session`) whether or not a service is linked,
     and each command words an unreachable service itself from the
     `ServiceUnavailable` it keeps. The CLI would call `openLocalSession`
     beside `openProjectSession`, not instead of it.

   What the CLI restates is one conditional
   (`link === undefined ? openSession : serviceSession(...)`) over the app's
   own `serviceSession`, `serviceProjectState` and `openLocalSession`. It
   goes away with the dual itself (part C of
   `.agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md`),
   not before. The config warnings are still shown three ways (a toast, a
   log line and a warning, a log line only); that decision is open.

2. **Building a TeX file to show it.** The extension
   (`packages/extension/src/frontend/latex/openBuild.ts`) and the desktop
   (`packages/desktop/src/main/desktopPreviewHost.ts`) each write "the file
   must exist, a non-LaTeX file opens plainly, else compile and show the
   PDF". On a failed compile the extension logs a warning and shows nothing;
   the desktop shows the error. The desktop names a missing compiler; the
   extension passes the raw error on. Proposed: one "compile for display"
   program in `packages/texra/src/controllers/approval/latexPreview.ts`, which already
   defines `BuildDisplayFn`, answering a PDF path or a sentence. The output
   directory stays a host fact (LaTeX Workshop's `outDir`). Decision: the
   extension starts showing the failure.
3. **What a setup launch's outcomes do.** Landed 2026-11-17, see the end
   of this note.
4. **A rejected GitHub token.** The extension
   (`packages/extension/src/extension.ts`) offers "Open Git settings"; the
   desktop (`packages/desktop/src/main/desktopSettingsIpc.ts`) shows a plain
   error. The settings body already follows app signals and could own the
   follower, with "open the Git page" as the host binding.
5. **The settings view's run verbs.** `revealRun`, `runLabel` and
   `selectLauncherAgent` are the same reads of the bridge and the session in
   `packages/extension/src/progressView/ProgressViewProvider.ts` and
   `packages/desktop/src/main/desktopProjectSurface.ts`. The desktop reads
   the active project, not the one the settings surface is bound to, which
   may be a defect when two projects are open. `openGuiWindow` holds both
   and could return the verbs.
6. **Reaching the bundled service.** Fourteen lines in
   `packages/extension/src/common/extensionService.ts` and eighteen in
   `packages/desktop/src/main/desktopService.ts`; only the desktop checks
   that the bundle exists. One function in
   `packages/texra/src/controllers/server/client.ts`. Low value.

## Open: app facts with two owners

1. **Symbol to LaTeX command.** Landed: `MATH_SYMBOL_SPELLINGS`
   (`packages/texra/src/replacement/constants.ts`) owns both spellings,
   and the last nine entity-only symbols joined it on 2026-11-18. Was:
   `MATH_UNICODE_MAP`
   (`packages/texra/src/replacement/advanced.ts`) and
   `HTML_ENTITY_REPLACEMENTS` (`packages/texra/src/replacement/rules.ts`)
   state about forty of the same pairs, one keyed by character and one by
   entity name. Nine symbols have an entity mapping and no character
   mapping (`&plusmn;`, `&forall;`, `&exist;`, `&oplus;`, `&otimes;`,
   `&there4;` and three arrows), so a `±` in math is left alone while
   `&plusmn;` is converted. Proposed: one table in
   `packages/texra/src/replacement/constants.ts` of character, entity name
   and command, as the Greek letters already have. It changes what the
   replacement engine converts, so it needs the replacement suites run and a
   look at each newly converted symbol.
   Done, checked 2026-11-19: both tables build their rows from
   `MATH_SYMBOL_SPELLINGS`, and `±` in math is converted.
2. **The aux files of a base name.** `collectFilesFromPatterns`
   (`packages/texra/src/housekeeping/artifactFiles.ts`) folds case on macOS
   and Windows and searches `build/`; `deleteWithAuxFiles`
   (`packages/texra/src/controllers/approval/latexPreview.ts`) expands the same
   extension table over `filesByPrefix`, a case-sensitive lister exported
   from the latexindent module
   (`packages/texra/src/latex/formatter/latexindentpt.ts`).
3. **Which `.bib` files a `.tex` names.**
   `packages/texra/src/latex/extractBibliography.ts` resolves beside the
   path it is given; `packages/texra/src/latex/extractFileDependencies.ts`
   follows the run-storage symlink first (`resolveLatexDir`). A third reader
   in `packages/texra/src/latex/latexdiff.ts` has its own pattern and does
   not know `\addbibresource`. One reader in
   `packages/texra/src/latex/latexParsingUtils.ts`.
   (`extractBibliography.ts` went with the `latex-extract` plugin on
   2026-11-19; the dependency reader is the one that remains.)
4. **What counts as `\input`.** Dependency mirroring
   (`packages/texra/src/latex/extractFileDependencies.ts`) accepts
   `\input {x}` and `\include{x}` and strips comments; the output rewrite
   (`packages/texra/src/agent/output/fileMapping.ts`) accepts neither and
   rewrites a commented-out line. Sharing the pattern changes which lines of
   a run's output are rewritten.
5. **LaTeX tool names.**
   `packages/texra/src/controllers/settingsView/LatexToolingController.ts`
   lists seven `*Path` fields by hand after probing the catalog's tools, so
   each tool is located twice; the status could carry one record keyed by
   the probed tool.
6. **Which models an agent CLI serves.**
   `packages/texra/src/shared/agentCliSettings.ts` tests `retired` itself;
   `packages/llm/src/models/modelRoute.ts` also treats an OpenRouter-only
   model as unserved. The app should ask llm.
7. **Key pages, a third time.** Landed 2026-11-19: `KEY_PAGES` is the leaf
   module `packages/texra/src/shared/model/keyPages.ts`, and the three
   `warningUrl`s in `packages/texra/src/shared/settings/settingSurfaces.ts`
   read it. Was: they restated three of its pages.

## Landed in the follow-up sweep

- **Host rule 1** (roots): `openProjectRoots` in
  `packages/texra/src/controllers/session/openProjectSession.ts` opens the
  config stores and the roots, with the service's project state when the
  host reached it, for the extension, the desktop's registry and the
  service; each shows the returned warnings its own way. Still open: the
  CLI's process roots (`packages/cli/src/runtime/platform/initPlatform.ts`)
  are built over the config provider its pre-runtime startup read opened,
  before `StateStores` exists, so they keep their own
  `openNodeWorkspaceRoots` call and service-state rule; and
  `openProjectSession` still decides service or local from `reached` a
  second time.
- **Host rule 2** (compile for display): `compileForDisplay` in
  `packages/texra/src/controllers/approval/latexPreview.ts`. The extension now shows
  a failed internal compile. The "file must exist, non-LaTeX opens plainly"
  steps stay per host: the extension builds workspace files through LaTeX
  Workshop, so the order of its checks differs.
- **Host rule 6** (bundled service): `reachBundledService` in
  `packages/texra/src/controllers/server/client.ts`; both host files are
  deleted.
- **App fact 2** (aux files): the preview cleanup reads
  `collectFilesFromPatterns`, which also fixed previews leaving their build
  files in `build/`.
- **App fact 3** (`.bib` files): not a finding. `collectBibliographyPaths`
  is already the one reader; the base directory differs by caller on purpose
  (a workspace path versus a run-storage mirror), and latexdiff's pattern
  restores the edited document's `\bibliography` directive text over a
  flattened `thebibliography` block, which biblatex's `\addbibresource` never
  produces.
- **App fact 4** (`\input`): `texInputPaths` and `rewriteTexInputs` in
  `packages/texra/src/latex/latexParsingUtils.ts`.
- **App fact 5** (tool names): `probeLatexTools` in
  `packages/texra/src/latex/latexToolchain.ts` is the one toolchain probe
  for the doctor, the setup assistant, the LaTeX tab and the dependency
  banner, so no tool is located twice. The LaTeX status carries one
  `paths` record keyed by probed tool since 2026-11-19 (the seven `*Path`
  fields are gone; the tab shows what it showed). Still open: the
  banner's check (`packages/extension/src/progressView/checkCoreDependencies.ts`)
  is VS Code-free code living in the extension, which belongs in the app
  once its one importer, the progress view provider, can be edited.

## Landed in the 2026-11-16 sweep

- **Host rule 5** (run verbs): `openGuiWindow` returns the settings body's
  `selectLauncherAgent`, `revealRun` and `runLabel` over the window's own
  bridge and session (`GuiWindowSettingsRuns`), and each host binds them;
  the extension's three `ProgressViewProvider` methods and the desktop's
  `ProjectBindings.active` are gone. The desktop read the shown project
  (`projects.active()`), not the one its settings belong to, so a settings
  request handled while the window switched projects (between the
  registry's change and the surface's re-attach) looked the run up in the
  other project. A host's "bring the run view up" is the window host's
  `runs.showRunView`.
- **App fact 5, the banner's check**: `missingDependencyTools` in
  `packages/texra/src/latex/latexToolchain.ts`, read by the host snapshot
  itself, so `missingTools` is no longer a host option, and its "Recheck"
  (`recheckDependencies`) is the shared body's, not a host binding. Whether
  a host shows the banner is a row of its `shows` table beside the
  credential banner: VS Code shows it, the desktop does not. Showing it on
  the desktop is left for a decision: the banner outranks the "tasks run in
  this window only" notice (`SessionBanners`), so on a machine without
  latexindent, Perl, Ghostscript or an image tool it would hide that
  notice, as the desktop E2E `serviceClient.spec.ts` showed. The LaTeX
  status's seven `*Path` fields stay open.
- **App fact 6** (agent CLI models): `isClaudeCodeModel` and `isCodexModel`
  ask llm's `isUnservedModel`, so an OpenRouter-only model leaves the Claude
  Code and Codex pickers. No listed model changes today: the registry's
  OpenRouter-only OpenAI models have no Codex entry and no Anthropic model
  is OpenRouter-only.
- **Host rule 1, "decided a second time"**: not a finding. In
  `openProjectSession` the second test is the first one's other branch,
  restated so TypeScript narrows `reached`; the service-or-local choice has
  one owner there.
- **App fact 7** (key pages): left open then, landed 2026-11-19 as the
  leaf module (see app fact 7 above). The three toggle links are chosen
  per toggle with their own labels (Moonshot's and MiniMax's point at the
  international platform, GLM's at the China one, against Moonshot's and
  GLM's China default), so they are not "the key page the toggle picks".
  `settingSurfaces.ts` cannot read `KEY_PAGES`: `texraSettings.ts` imports
  it and `providerPresentation.ts` imports `texraSettings.ts`, a cycle that
  breaks at module load when `providerPresentation.ts` is evaluated first.
  Either `KEY_PAGES` moves below both (a leaf module, or llm beside
  `providerDisplayName`), or the link follows the toggle, which changes its
  copy.

## Landed in the 2026-11-17 sweep

- **Host rule 3** (setup launch outcomes): `openWindowSetup` in
  `packages/texra/src/controllers/onboarding/setupLaunch.ts` is the window's
  one setup verb. `openGuiWindow` builds it over the window's session,
  launcher, notices and run view, answers the setup card's Run Setup with
  it and returns it, so VS Code's command and status pill call the same
  verb. The extension's `launchSetupAssistant`, the desktop's
  `openWindowOnboarding`, the `onboarding.runSetup` host binding and the
  extension view's `showConnectModel` are deleted. Behavior changes: the
  desktop shows the "Connect a model" card instead of an error dialog when
  no model is usable, and a setup run already live is announced and
  selected on both hosts (the desktop said nothing; the extension showed the
  task list without selecting it). One launch at a time is now held per
  project window on both hosts, with a semaphore over the start only: a
  second Run Setup once the run is live gets the "already running" answer
  instead of a silent no-op, and the extension's double-click race is
  closed. A failure before the run opens is presented through the window's
  notices on both hosts.
- **Host rule 4** (rejected GitHub token): done, checked 2026-11-19. Both
  hosts run one follower, `followGitHubTokenRejections`
  (`packages/texra/src/controllers/session/windowNotices.ts`), per window,
  and it words the notice itself. What follows is the 2026-11-17 reading. Moving the follower into the settings body needs two decisions
  first. `Dialogs` has no non-modal notice with an action: `confirm` is
  the only call that takes an action label, and the extension's toast with
  "Open Git settings" would become a modal. And the body runs once per
  project on the desktop (`createDesktopSettingsIpc`) but once per
  activation in VS Code, so a follower in the body would raise one notice
  for each project the desktop has open. Either `Dialogs` gains
  `notify(level, message, action)`, or the follower stays one per process
  and only its wording is shared.

## Landed in the 2026-11-21 sweep

- **The helper model of a merge.** `HostRunActions.merge` read the helper
  model itself (`getHelperModelName ?? DEFAULT_AGENT_MODEL`), beside the
  session's `servableHelperModel`; it now launches with `helperModel: true`
  as the compile fixer and Fix Compilation do, so a helper model that cannot
  serve falls back to the default agent model with a logged swap.
- **A failed final-output open.** The extension's `previewFinalOutput`
  warn-logged its own failure, the rule `hostRunActions`' `whenEnded`
  already applies for every host; the shared rule logs it once.
- **Which files a launcher field takes.** The extension's "add opened
  files" rebuilt the drop's extension test; `fieldTakes`
  (`packages/texra/src/controllers/mainView/MainViewDroppedFilesController.ts`)
  is the one test.
- Write-only fields of a desktop project binding (`snapshot`,
  `runValidated`, `present`) are gone.

## Still open after the 2026-11-21 sweep

- `openGuiWindow` returns `present`, which no host reads now that the
  desktop binding dropped it. The file was held by an open PR that day.
- **Where a tool edit's staged pair lives** is decided per host: the
  desktop makes a directory per request and removes it whole, the extension
  writes into its storage directory and unlinks the two files
  (`packages/texra/src/controllers/approval/tempFileManager.ts` documents
  both). One staging owner would move the extension's previews out of its
  storage directory, a visible change that needs a decision.
