# Rules decided per host and app facts with two owners

Date: 2026-11-15
Status: proposed (four findings landed with this note; the rest are open)
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

1. **Opening a project's roots.** Four sites open the config stores, show
   their warnings and call `openNodeWorkspaceRoots`, adding
   `workspaceState: serviceProjectState(...)` when the service was reached:
   `packages/extension/src/extension.ts`,
   `packages/desktop/src/main/desktopProjects.ts`,
   `packages/cli/src/runtime/platform/initPlatform.ts` and (without the
   service state) `packages/cli/src/runtime/platform/cliService.ts`.
   `openProjectSession`
   (`packages/texra/src/controllers/session/openProjectSession.ts`) then
   decides "service or local" a second time from the same result. The guards
   differ: only the extension also asks that a workspace root exists. The
   config warnings are shown three ways (a toast, a log line and a warning,
   a log line only). Proposed: one function beside `openProjectSession` that
   returns the roots and the service-or-local choice together. Decision: how
   a config warning is shown when a host has no window yet.
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
3. **What a setup launch's outcomes do.**
   `packages/extension/src/commands/setup/setupAssistantCommand.ts` and
   `packages/desktop/src/main/desktopWindowOnboarding.ts` each map
   `launchSetup`'s outcomes
   (`packages/texra/src/controllers/onboarding/setupLaunch.ts`). Already
   running: a toast and the task list in the extension, nothing on the
   desktop. No usable model: the "Connect a model" card in the extension, an
   error dialog on the desktop. The desktop holds one launch at a time with a
   `FiberHandle`; the extension relies on the live-run check, which a
   double-click can beat. Proposed: the `runSetup` case of
   `packages/texra/src/controllers/session/openGuiWindow.ts` owns the
   single launch and maps each outcome to a host verb. Decision: the desktop
   gets the card instead of the dialog. This was listed in
   `2026-11-14-reading-a-failed-cause.md` and is still true.
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

1. **Symbol to LaTeX command.** `MATH_UNICODE_MAP`
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
7. **Key pages, a third time.** `warningUrl` in
   `packages/texra/src/shared/settings/settingSurfaces.ts` restates three
   pages of `KEY_PAGES` (`packages/texra/src/model/providerPresentation.ts`).
