# Responsibility audit: what the 2026-11-22 run left open

Date: 2026-11-22
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
on `main` at `0d72e15`. It started from item 2 of the 2026-11-20 note (the
launcher's file list) and a read-only survey of the per-host bindings of
the shared GUI window body (`openGuiWindow.ts`) and the followers of the
`workspaceFilesWritten` app signal.

The PR that adds this note lands three findings. In each, a rule the
shared window body owns was decided by a host instead:

- **The launcher's file list after TeXRA's own writes.** Only the
  extension's VS Code file watcher re-listed it, so the desktop launcher
  missed an accepted output or diff until the project was reopened. The
  host snapshot source (`hostSnapshotSource.ts`) now follows
  `workspaceFilesWritten` for writes inside its project, on every host.
- **"A write landed in this project".** The desktop's file tree follower
  (`desktopWorkspaceIpc.ts`) filtered the signal by its root itself; it now
  follows the snapshot source's `filesWritten`, the same filter the
  launcher re-lists on, and the IPC no longer takes the workspace root.
- **A failed Compare.** The extension swallowed every failure into a VS Code
  toast and answered `done`; the desktop's became a defect the bridge
  answers `Internal`. The file-action controller, which already words a
  missing side, now words a diff view that would not open as a rejection
  the surface shows.

## Open

1. **Edits made outside TeXRA still reach only the extension's launcher.**
   The extension keeps its VS Code watcher for creates and deletes from a
   terminal or another program (`ProgressViewProvider.followWorkspace`).
   Moving that into the snapshot source means an Effect `FileSystem.watch`
   of the whole project: on Linux, Node's recursive watcher walks the tree
   and holds one inotify watch per directory, `.git` and dependency folders
   included, with no exclusion. Decision: accept that cost, take a
   watcher backend with exclusions (`FileSystem.WatchBackend`), or keep the
   host watcher as a documented host capability.
2. **"Ask for a provider API key" is bound twice on each GUI host.**
   `SharedHostCommandBindings.setApiKey` (`openGuiWindow.ts`) and the
   `setApiKey` that `windowNotices` takes (`windowNotices.ts`) carry the same
   rule. The desktop binds both to the Models tab
   (`desktopHostRequests.ts`, `desktopWindowHost.ts`); the extension's notice
   copy (`agentEventListeners.ts`) has drifted from its request binding: no
   provider and no tagged `runHandler` log. The body cannot simply call
   `windowNotices` with its binding: a notice runs on a fiber the session
   forks, outside the request's context, and the binding's type requires
   all of `ProcessServices`, which `Context.pick` cannot forward wholesale.
   First narrow `HostVerb`'s requirements for `setApiKey` to what the two
   hosts read, then the body owns the notice's verb.
3. **The extension turns editor files into launcher paths, twice, with
   different no-folder behaviour.** `getCurrentFile` and `getOpenedFiles`
   (`packages/extension/src/progressView/extensionHostRequests.ts`) each
   apply `workspaceRelativePath`, although the binding's contract says the
   body decides which form a launcher field takes. With no folder open, the
   current file comes back absolute and the opened files come back empty.
   Decision: which of those two is right; then the body's `useCurrentFile`
   and `addOpenedFiles` cases apply it and the binding returns absolute
   paths.
