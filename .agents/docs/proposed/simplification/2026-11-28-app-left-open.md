# The app outside `ui/`: what the 2026-11-28 sweep left open

Date: 2026-11-28
Status: proposed
Origin: the scheduled Saturday sweep on `main` at `5b7f63e`, over the app
outside `ui/`. The PR that adds this note lands its findings.

## Session controllers

Landed with this note: one table per GUI host (`GuiWindowHost` in
`packages/texra/src/controllers/session/openGuiWindow.ts`, with optional
`placement` and `gettingStarted` verbs in place of the per-host request
table, and the getting-started card shown where the host can start a
project); the tool-dashboard command lookup failing itself
(`toolTerminalCommand`, `controllers/settingsView/ToolDashboardData.ts`);
the run actions' and host requests' stale comments
(`controllers/session/hostRunActions.ts`,
`shared/session/hostRequest.ts`).

Each item below needs a file this sweep stays out of (the progress view or
settings frontends under `packages/texra/src/ui/`) or one an open PR
holds.

1. **The launch request states its instruction twice.** The `launch` case
   of `HostCommandSchema` (`shared/session/hostRequest.ts`) carries
   `launch: LaunchSurfaceSchema`, whose `instruction` is the composer's
   text, and a second `instruction`, the same text trimmed
   (`ui/progress/sessionSurfaces.ts`, the one sender).
   `prepareSurfaceLaunch`
   (`controllers/mainView/backend/MainViewRunLaunchController.ts`) reads the
   second; the frontend compares the first when the launch answers.
   Proposed: drop the second field and trim `launch.instruction` in
   `prepareSurfaceLaunch`. The sender's literal must lose the field in the
   same change (an excess property fails the type check), so it waits for
   a change that may edit `sessionSurfaces.ts`. Risk: low; the wire is
   between the app's own host and frontend, built together.
2. **A plan with no credential reaches the snapshot, and the view drops
   it.** `openHostSnapshotSource` (`controllers/session/hostSnapshotSource.ts`)
   maps a `failed` quota to `{ plan, windows: [], unknown: quota.reason }`
   whatever the reason; `PlanUsageMeters.ts` filters
   `unknown === 'missing_credentials'` at render time. The desktop's footer
   (`packages/desktop/src/renderer/desktopShell.ts`,
   `shellStatusBarTemplate`) tests the unfiltered list, so a project whose
   only plans lack a credential paints an empty status bar. Proposed: the
   source returns no entry for `missing_credentials`, the meters' filter
   goes, and `PlanUsageSchema.unknown` (`shared/session/hostSnapshot.ts`)
   loses that literal. It is a bug fix and takes one regression test over
   the source, which no suite opens today; with the render-time filter in
   a `ui/` file, it is one change for whoever may edit both.
3. **`setReasoningLevel` still sits with the Models tab**
   (`controllers/settingsView/modelSelection.ts`; item 2 of
   `2026-11-27-ownership-left-open.md`). Open #15275 gives the terminal's
   picker the row and imports the writer from there, so the move to its
   reader, `packages/harness/src/model/reasoningLevel.ts`,
   waits for that PR.
4. **`ModelSelectionItem` declares a field its producer never writes.** It
   spreads `ModelAvailabilityFieldsSchema.fields`
   (`shared/settingsView/settingsViewMessages.ts`), so the wire admits
   `unavailableReason`, but `buildSelectionItems` (`modelSelection.ts`)
   copies `availability`, `usageRoute` and `routeLabel` only, and the
   Models tab reads none of it. With the copy of `ModelOptionData` field by
   field (item 6 of `2026-11-23-data-shapes-left-open.md`, `context`
   renamed `contextWindow` for `ModelSelectionList.ts`), this is one change
   to the item's shape and its renderer, and the controller should also
   send the groups, the last-enabled lock and the helper choices
   (section 4 of `2026-11-25-layer-audit-left-open.md`). `modelSelection.ts`
   is in #15275's neighbourhood; take it after that PR lands.

Checked and kept:

- `HostSnapshotSourceOptions.shows.apiKeyBanner` and `.dependencyBanner`
  are true together on the extension and false together on the desktop,
  but neither follows from a verb the host binds: the desktop keeps the
  credential in Settings by choice, and both banners' buttons run verbs
  every host has. One flag would merge two decisions that only coincide.
- `GuiWindowHost.runs.revealProgress` and `.showRunView` are no-ops on the
  desktop (its run view is always on screen), as `revealProgress` is in
  the terminal chat; optional members would add a branch to every caller
  for no deleted line.
- The `host.request` switch in `openGuiWindow` stays a switch: a handler
  map is the same cases as properties, and lifting its multi-step cases is
  single-caller extraction (2026-11-25 ad-hoc implementation scan).

## LaTeX

The LaTeX layer (`packages/texra/src/latex/`, the toolchain catalog
`packages/texra/src/shared/constants/latexToolchain.ts`, the runner in
`packages/texra/src/utils/system/`) has been through several audits, and
its large modules are large for their domain: the arXiv download's
retry, extraction and ownership of the paper folder; latexdiff's output
repairs; the catalog's install records. What the sweep landed: the TikZ
template is filled by plain replacement instead of a template engine; the
arXiv download and the directory formatter lost the fields and defaults
their deleted callers used; each LaTeX setting row states its own choices
(`latexConfig.ts` is gone); `probe_environment`'s description names the
catalog's probed tools; two single-caller helpers in the compile path are
folded into their callers; three guides no longer describe the removed
program figure options.

Open, in the order worth taking:

1. **`renderPrompt` on the `./plugins` entry has no reader outside the
   harness.** Its one app caller was the TikZ template. The export
   (`packages/harness/src/tools/pluginSurface.ts`, recorded in
   `config/api-reports/harness.plugins.api.md`) is the 0.x SDK's surface,
   so dropping it is a public-surface decision; with it, the harness keeps
   nunjucks only for the system prompt's `{{ CWD }}`, which item 3 of
   `2026-11-27-responsibility-audit-left-open.md` already questions.
2. **Ghostscript's Windows names are stated twice.** The catalog's `gs`
   entry lists `alternates: ['gswin64c', 'gswin32c']`, which `probeTool`
   tries in turn, and `toolCandidates`
   (`packages/texra/src/utils/system/binaryResolver.ts`) adds the same names
   and their `.exe` forms for `gs` alone. The probe's path lookup
   (`probeLatexTools` calls `findCommand(name)`) is the only reader that
   needs the resolver's copy. Reading the alternates from the catalog
   changes the Windows search order (name-major instead of directory-major)
   and adds a `gs.exe` candidate, so it wants a check on a Windows machine
   with Ghostscript installed. `WINDOWS_EXTENSIONLESS_PERL_TOOLS` and
   `TEXMF_SCRIPTS` in the same file are a property of five catalog entries
   too, but they differ by `texcount` for a reason nobody recorded.
3. **latexdiff drops a preamble line that says "Here is".**
   `PREAMBLE_SKIP_MARKERS` (`packages/texra/src/latex/latexdiff.ts`) skips
   lines before `\documentclass` that contain `Here is` or `以下是`: the
   chatter a model wrote ahead of a document the deleted pipeline diffed.
   Today latexdiff runs only on a workspace file and its proposed edit, so
   those markers only drop a user's own comment. `%DIF ADD` is latexdiff's
   header and stays. Removing the two keeps such a line in the diff, a
   behavior change for the approval preview.
4. **"No TikZ figures found" when every figure failed.**
   `handleCompileTikzFigures`
   (`packages/extension/src/commands/latex/figCommands.ts`) reads an empty
   list from `compileTikzPictures` as "none found", which is also what a
   file whose figures all failed to compile returns (each failure is logged
   at warn with its log tail). Telling the two apart needs a wording
   decision for the failure notice.
5. **`openFirstLabelMatch` has one caller.** `packages/texra/src/latex/labelSearch.ts`
   is generic over its read and its handler for
   `packages/texra/src/controllers/session/workspaceFileOptions.ts` alone.
   Moving it beside its caller is a file in another worker's area this
   run; take it with the next pass over `controllers/session/`.

Checked and left alone:

- **`getTeXCount` succeeds with a `Result` of two strings** rather than
  failing with a tagged error. A `TexcountFailed` would carry the same
  sentence and move the branch to `catchTag` in the one host caller, for
  no element removed.
- **`DiagnosticsReadFailed.reason`** is printed, never branched on, so it
  is a message; but it is in the diagnostics tool's model-facing text and
  its producers are in `controllers/server/`.
- **`extractTikzPictures` then `compileTikzPictures`** is called as one
  pair by its one host; the suite tests the extraction alone, so merging
  them would trade an export for a test seam.
- **`LATEX_RECOMMENDED_SETTINGS` spells `build/`** where
  `LATEX_BUILD_DIRECTORY` exists, but the catalog is browser code and the
  constant's module imports `node:path`.
