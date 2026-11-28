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
