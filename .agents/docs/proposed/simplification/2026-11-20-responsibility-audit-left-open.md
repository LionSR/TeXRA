# Responsibility audit: what the 2026-11-20 run left open

Date: 2026-11-20
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
run on `main` at `f38bb2a`. It ran two read-only surveys: the three hosts
against the shared app, and the harness, app and llm against each other.
Each candidate was checked against the code, the other notes in this
directory and `.agents/docs/refuted-candidates.json`.

The PR that adds this note lands the findings that have one clear owner.
In each, one rule had two or three owners, decided separately by a host
or a module:

- what "running" counts: the session's `rollup.running` reads `isLive`,
  as a run's own rollup does, and the VS Code task pill reads it;
- stopping a spawned server: the spawner's scoped release, given
  `forceKillAfter`, for the MCP and Lean servers;
- a failed browser open's wording: `externalOpenFailed`
  (`packages/texra/src/hosts/uiHosts.ts`), which names the origin and
  never the URL, on all three hosts;
- a compare's missing file: the shared file-action controller;
- a permanent GitHub status: `isTransientHttpStatus`;
- a shell command's elapsed time: `formatWallTime`.

The items below each need a decision or are too small to stand alone.

## Open

1. **The run list's "Running" section is a fourth reading.** `runSection`
   (`packages/texra/src/shared/session/runStatusKey.ts`) puts a run held
   here in "Running" unless its position is `ready`. `isLive`, which every
   count now reads, counts a held run unless it is idle between turns. So
   an idle conversation sits under "Running" with the status word "Idle",
   while no count shows it as running; a held run before its first
   activation is counted but listed under "Recent". Making the section read
   `isLive` would move a conversation between "Running" and "Recent" at
   every turn in the tab strip
   (`packages/texra/src/ui/progress/components/RunTabs.ts`) and the TUI's
   run tree (`packages/cli/src/chat/tui/state/cliState.ts`). Decision:
   whether the section follows the count, or a list section is meant to
   stay put across turns.
2. **Only the extension keeps the launcher's file list current.** The list
   is read by `loadFiles` in
   `packages/texra/src/controllers/session/hostSnapshotSource.ts` when a
   window opens, and again only on a `refreshFiles` request. The extension
   runs its own watcher that calls `refreshFiles` on creates and deletes
   (`packages/extension/src/progressView/ProgressViewProvider.ts`). The
   desktop has none, so a file made after the project opened (an accepted
   output, a terminal command, a save from the editor pane) is missing
   from its launcher until the project is reopened. The desktop's
   `workspaceFilesWritten` follower
   (`packages/desktop/src/main/desktopWorkspaceIpc.ts`) re-lists only the
   file tree. Proposed: the snapshot source follows the workspace itself,
   and the extension's watcher goes. Whether that is an Effect
   `FileSystem.watch` or the app signal plus the editor's save decides how
   much moves, so it is a change of its own.
3. **The CLI writes its four-step model choice twice.**
   `resolveChatDefaults` (`packages/cli/src/runtime/models/chatDefaults.ts`)
   and `cliRunModelCandidates` (`packages/cli/src/runtime/models/runModel.ts`)
   both list `--model`, the environment, the `texra.<role>` setting and the
   cheap start model. `run` and `tasks` reject an unknown `--model` with
   "Model not found"; the chat skips that check, so the same typo gets the
   unavailable-model message. One candidate list in `runModel.ts`, read by
   both. Changes the chat's message for an unknown model.
4. **`packages/llm/src/errors.ts` also holds the plan catalog**
   (`PLAN_ROUTES`, `PlanRoute`, `BillingRoute`) and the background-operation
   identity (`RemoteOperationSchema`). They sit there because
   `ModelError.quota` needs `PlanRouteSchema`. A plan module that
   `errors.ts` imports would make each file say one thing. About eleven
   import lines; wait for the step that makes a plan one row
   (`.agents/docs/proposed/architecture/2026-11-19-a-subscription-plan-is-one-row.md`),
   which rewrites the same table.
5. **Two sample-project paths in the extension**
   (`packages/extension/src/commands/system/sampleProjectCommands.ts`): an
   existing `texra-sample` folder is opened when no folder is open and
   refused inside a workspace, and the two copy differently. Low value.

## Checked and declined

- **`toErrorMessage` in the harness and in llm.** Already recorded as kept
  in `2026-11-03-storage-errors-and-stop-paths.md`: llm cannot import the
  harness, and the harness's browser-safe entries cannot take llm's.
- **`sameIdentity` in the harness and in llm.** Only the name is shared:
  one compares an offered tool, the other a provider part.
- **`formatConversation` in the CLI and in the harness.** The node
  rendering is already shared (`formatConversationMessage`); each caller
  composes its own output.
- **`cloneOverleafProject` in the extension and the app.** The command
  prompts and presents over the app's one clone program.
