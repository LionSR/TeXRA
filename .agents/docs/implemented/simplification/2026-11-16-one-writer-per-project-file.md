# One writer per project file: the desktop save and the service's runs

Date: 2026-11-16
Status: implemented. A window whose project the background service holds
sends the editor's save and the toolbar's accept to the service (`file.save`,
`file.replace`), which runs them under the write lane its tasks' edits take;
"Landed" below says what that covers and what it leaves.

Origin: LN-4 of the 2026-11-15 design red-flag audit
(`../../evidence/2026-11-15-design-red-flags/LN-nonobvious-degradation.md`),
re-read on `main` after #14971.

## The problem

`withFileWriteLane` (`packages/harness/src/utils/files/fileWriteLane.ts`) is
one lane per file per process. The desktop editor's save takes it in the
process that holds the window, the Electron main process
(`packages/texra/src/controllers/session/workspaceFileRequest.ts`,
`writeFile`, which the window's shared request body runs); an agent's approved edit takes it where the tool runs
(`packages/harness/src/tools/approval/approvedWrite.ts`). A desktop window with
a folder runs its tasks in the background service whenever the service is
reached (`openProjectSession`, `where: 'service'`), so on macOS and Linux the
two writers hold two lanes and the race the lane exists for is open: the later
write replaces the earlier with no `changedOnDisk`. The window between check
and write is a read and a write on each side, so the loss is rare. The
toolbar's accept of a document task's output (LN-1) runs in the host process
too.

## The design

Every read-decide-write of a project file runs in the process that holds the
project's session, which is where the runs write. The save and the toolbar
accept become one session request (`file.write { path, contents, base }`),
which a `serviceSession` forwards and a local session serves in process. One
handler holds the lane and answers `done`, `changedOnDisk` or a rejection,
as the desktop's `writeFile` does today; the desktop's own check-and-write and
LN-1's staged write go. A cross-process lock file per workspace file was
weighed and refused: it is hand-written infrastructure, needs stale-lock
recovery, and still leaves two writers.

## Decisions it needs

1. **A new request on the harness's public session surface.** `file.write`
   joins `RuntimeRequest` (`packages/harness/src/shared/session/runtimeRequest.ts`),
   which is not run-scoped like every request there today, and its handler
   needs the containment rules the editor's save holds (`resolveWritable`:
   canonical parent, no symlinked final component). That moves workspace-file containment into the harness. An
   older service answers the new kind with a parse error, so the window must
   say "update the service" rather than fail the save silently.
2. **A save while the service link reconnects.** FB1's policy for a request
   made mid-outage is to reject it with `SERVICE_OFFLINE`. For an editor save
   that means the user cannot save their file until the link is back.
   Options:
   - (a) reject with the offline reason; the editor keeps the buffer dirty
     and shows why. One policy for one outage, as FB1 chose for runs.
   - (b) write in the window's own process while the link is away, logged
     at warn. Saves never fail for the link; the race stays open only while
     the service is unreachable (its runs may still be writing).
   - (c) queue the save until the link returns. Hides the outage, and a
     quit loses the queue.

   Recommendation: (b). A save is the user's own work and should not depend
   on the service; the window it leaves open is the outage, which the
   service banner already shows.

## Decisions taken (2026-11-18)

1. **Not a harness request.** Compared: (i) `file.write` on the harness's
   `RuntimeRequest`, served by the session in whichever process holds it,
   with workspace-file containment moved into the harness; (ii) the app's
   `workspaceFile` host request, one operation over the session's rooted
   `WorkspaceFs` and the write lane, served where the window's request body
   runs, and forwarded by the app to the service when the service holds the
   project. Chosen: (ii). `RuntimeRequest` is run-scoped and public; what
   the editor may list, open and save (the tree's hidden entries, agent
   definitions opened by catalog name) is TeXRA's policy, and the service is
   app code, so the forward needs no harness surface. The list, read and
   write moved out of the desktop in one module; the forward is next: the
   window sends a `write` to the service's process when `GuiSession.where`
   is `'service'`, and the service answers it with the same operation.
2. **(b)**, as recommended: while the link is away the window writes in its
   own process and logs the fallback at warn. Until the forward lands, every
   save is written in the window's process, which is this policy's outage
   path taken always.

## First step taken

The comment over the desktop's `writeFile` claimed the lane kept it apart
from every approved edit. It now says the lane is per process and names the
case it does not cover.

## Landed

The forward, through the service's one protocol (`protocol.ts`):

- `file.save { workspace, path, contents, base }` is the `workspaceFile`
  write. The window's request body (`answerWorkspaceFile`) sends it when its
  session is the service's, and the service answers with the same operation
  (`writeWorkspaceFile`) over the project's rooted filesystem, so containment
  is checked where the write happens.
- `file.replace { target, contents, confirmedAgainst }` is the accept's
  replace-if-unchanged (`replaceIfUnchanged`,
  `packages/texra/src/latex/acceptedFileTarget.ts`), which the accept reaches
  through a port the toolbar's controller binds. The confirmation, the notice
  and the `workspaceFilesWritten` signal stay in the window.
- Decision 2's outage path is `writeInService`
  (`packages/texra/src/controllers/server/serviceSession.ts`): while the link
  holds no service, or the service does not answer the call, the same write
  runs in the window's process and a warn names the file. A call the service
  was cut off in the middle of may have landed there; the local write that
  follows then finds the file changed and answers `changedOnDisk`.
- A service of another build never takes these calls: the protocol digest
  differs, so the link retires it or refuses it before any request.

Left as it is, on purpose:

- An agent definition the editor opened by catalog name is written in the
  window's process. The window's catalog named the file the editor shows; the
  service's catalog follows the agent directories with a delay, and a save
  refused as "no longer available" for a definition created a moment ago
  would be a new failure. A task that edits the same definition file at the
  same instant can still be replaced unseen.
- A file the user edits in VS Code's own editor is saved by VS Code, which
  no lane of TeXRA's covers.
- Reads and directory listings stay in the window: they decide nothing.
