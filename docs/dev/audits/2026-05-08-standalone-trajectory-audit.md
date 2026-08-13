# Standalone Trajectory Audit — TeXRA Desktop (Electron)

This audit walks the user-facing trajectories that make TeXRA Desktop
"standalone-usable" (i.e. without the VS Code extension as a fallback) and
notes where each flow is wired end-to-end versus where it is a placeholder
or partial integration. Companion suite:
`packages/desktop/tests/e2e/trajectories.spec.ts`.

The trigger for this work is issue #3643 ("simulate many many user
trajectories ... see if there are frictions ... if things are working or
just placeholder"). The goal is **mapping**, not implementation: identify
gaps with concrete acceptance criteria so follow-up PRs can pick them off
one at a time.

## Status table

| #   | Trajectory                                  | Status  | Backed by                                                                                |
| --- | ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| 1   | First launch, no workspace                  | Works   | `desktopOnboarding.ts`, `main.ts` empty-state factory                                    |
| 2   | First launch, with workspace                | Works   | `--texra-workspace-path` arg, `DESKTOP_WORKSPACE_PATH_STATE_KEY`                         |
| 3   | Open Folder via chrome button               | Works   | `dialog.showOpenDialog` → `app.relaunch`                                                 |
| 4   | Sign In via Researcher Access banner        | Works   | `desktopSupabaseAuth.ts` (full OAuth + protocol cb)                                      |
| 5   | Manual API key entry (Models tab)           | Works   | `promptInRenderer` + `platform().secrets`                                                |
| 6   | API key persists across restart             | Works   | `electronSecrets.ts` (safeStorage + keychain)                                            |
| 7   | Run an agent, stream to Progress            | Works   | `desktopAgentExecution.ts` + `runValidatedExecutionRequest`                              |
| 8   | Tool-edit / Bash / Plan approval dialog     | Works   | `desktopToolEditApproval.ts`, `progressView` IPC                                         |
| 9   | Memory tab persistence                      | Works   | `@tools/memory` storage path resolved via platform                                       |
| 10  | Settings: Multi-Agent / Models / Latex tabs | Works   | `desktopSettingsIpc.ts`                                                                  |
| 11  | Logs view (Refresh / Copy / Export)         | Works   | `desktopAppLog.ts` + clipboard / save dialog                                             |
| 12  | Command palette                             | Works   | `desktopCommandPalette.ts`                                                               |
| 13  | First-run walkthrough                       | Works   | `desktopOnboarding.ts`                                                                   |
| 14  | Tool install via Settings → Tools           | Partial | Native dialog with copy/run command — no `code --install` automation                     |
| 15  | Install LaTeX Workshop / VS Code extension  | Partial | Used to silently open MV marketplace; now an honest "this is a VS Code extension" dialog |
| 16  | Recent commits banner / Git tab             | Works   | `desktopGitHost.ts` shells out to `git log` (audit item A)                               |
| 17  | LaTeX preview / build                       | Partial | `desktopPreviewHost.openBuildDisplay` opens externally; no in-app PDF tab                |
| 18  | Diff view inside the desktop                | Partial | `desktopDiffHost` opens diff in external editor only                                     |
| 19  | Cross-launch session restoration            | Works   | Workspace transcripts and stream sidecars load through the shared progress backend       |
| 20  | Crash reporting opt-in flow                 | Works   | `desktopCrashReporting.ts`                                                               |

Legend: **Works** = end-to-end on the standalone build · **Partial** =
shell exists, but the UX has a friction point or relies on a sibling
tool · **Stub** = the IPC handler exists for schema parity, but does not
do useful work standalone.

## Trajectory observations

1. **First launch, no workspace.** `main.ts` builds a `desktop-empty-workspace`
   placeholder for the launcher and progress routes when
   `window.texraDesktop.hasWorkspace === false`. The Open Folder button is
   bound to `DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER` and the relaunch
   path persists the selection via `DESKTOP_WORKSPACE_PATH_STATE_KEY`.

2. **Sign In.** The Researcher Access banner sends
   `MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER`, which `desktopShellIpc.ts`
   routes to `actions.signIn()` → `desktopAuth.signIn()`. The OAuth client
   begins the attempt, persists state, opens the browser, and the
   `texra://` protocol callback is received by
   `desktopProtocolCallbacks.ts`. Verified by `desktopSupabaseAuth.ts`
   tests. _Friction:_ first launch on a fresh macOS profile may hit a
   keychain prompt before the renderer mounts; mitigated by
   `prewarmElectronKeychain()` at startup.

3. **Manual API key entry.** Settings → Models → "Set API key" hits
   `SETTINGS_VIEW_CMD.SET_API_KEY` and is dispatched to
   `promptSecret`-backed flow in `desktopSettingsIpc.ts`. Storage is
   `platform().secrets` (Electron `safeStorage`).

4. **Agent execution.** `MainViewExecuteMessage` is validated by
   `prepareMainViewExecutionRequest` and dispatched to
   `runValidatedExecutionRequest` via the desktop progress bridge.
   Streaming, todos, conversation progress, and approvals are all
   relayed to the renderer through `DesktopProgressBridge`.

5. **Tool installation flows (#14, #15).** Previously the desktop's
   `installToolExtension` quietly opened the VS Code Marketplace URL,
   misleading users who don't have VS Code. After this PR the dialog
   is honest about the limitation and offers Open / Copy ID / Close.
   `runInstallCommand` and `runToolCommand` now provide a Copy button
   so users do not have to manually transcribe shell commands from a
   non-selectable Electron native dialog.

6. **Recent commits / Git (#16).** No `vscode.git`-equivalent host port
   exists for the desktop yet. Until one lands, the desktop shell
   answers `MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS` with an empty
   commit list. The `isGitRepo` flag now probes `.git` so the launcher
   banner reflects reality even though commit listings are still stubbed.

7. **LaTeX preview / Diff (#17, #18).** `desktopPreviewHost.openBuildDisplay`
   delegates to the OS — no in-app PDF tab. `desktopDiffHost.openDiff`
   currently only opens the two files via `openPath`; an in-app diff view
   is tracked in PR #3795/#3797 progress refactors but not desktop-wired.

## Tactical fixes shipped in this PR

1. `installToolExtension` now uses a clear info dialog (`Open in
Marketplace` / `Copy ID` / `Close`) instead of silently opening the
   VS Code Marketplace.
2. `runToolCommand` and `runInstallCommand` now expose a `Copy` button so
   users can paste the suggested command directly into a terminal.
3. `setRecentCommitsUnavailable` accepts an `isWorkspaceGitRepo` probe;
   `index.ts` wires it to `existsSync(workspace + '/.git')` so the banner
   reflects repo state. The commit list itself remains empty pending a
   real desktop git host port.

## Follow-up issues

Each of the following has concrete acceptance criteria so a single PR can
close it:

### A. Real desktop Git host (closes trajectory #16) — DONE

- Implemented in `packages/desktop/src/main/desktopGitHost.ts` (PR #3817).
  spawns `git log -n 20 --pretty=format:'%h\t%s\t%cr'` via
  `child_process.execFile` inside the workspace, parses tab-separated
  fields, and rebuilds the `<short>: <subject> (<relative>)` label
  shape the renderer already consumes. `desktopShellIpc.ts` accepts an
  injected `getRecentCommits` host; `index.ts` wires it. `git`-missing
  / not-a-repo / timeout failures fall back to an empty list.

### B. In-app PDF preview (closes #17)

- **Done when:** clicking "Compile & Open" on a `.tex` output renders the
  resulting PDF in a new desktop route (or modal), not in the OS preview.
- Notes: Electron supports `<webview>` + Chromium PDF viewer; gate behind
  a feature flag for the first cut.

### C. In-app diff view (closes #18)

- **Done when:** "Compare" actions on workflow output files render a
  side-by-side diff inside the desktop, mirroring the VS Code experience.
- Notes: reuse `<texra-diff-view>` (already imported in `main.ts`); wire
  `desktopDiffHost.openDiff` to set a diff route + payload.

### D. In-flight session restoration (closes #19) — shipped

- **Status:** The desktop loads the same workspace-scoped transcripts,
  stream sidecars, and execution mappings as the extension. Startup repair
  derives unfinished work from transcript summaries, distinguishes resumable
  executions through persisted flow records, and rebinds executions that are
  still active in another desktop window.
- The unreleased desktop now starts directly from the shared transcript and
  execution stores; its temporary `streams.json` importer was removed.

### E. Multi-launch settings persistence test — shipped

- **Status:** shipped in `packages/desktop/tests/e2e/settingsPersistence.spec.ts`.
  The fixture launches the desktop, writes a real Memory entry into the
  workspace storage rooted under a pinned Electron user-data directory, closes,
  relaunches, and verifies that the Memory tab lists the same entry.

### F. Native auto-installer for external tools

- **Done when:** clicking "Install" on a missing tool runs the install
  command (`brew install ...`, `pip install ...`) inside an embedded
  terminal output panel, instead of asking the user to copy/paste.
- Notes: needs a host-neutral `terminalRunner` port; today only VS Code
  has a real terminal host.
