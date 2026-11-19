# One writer per project file: the desktop save and the service's runs

Date: 2026-11-16
Status: implemented. Every write of a project file a window makes on a
person's word is one operation (`writeFileIfUnchanged`), and the window's
session says once, at open, which process runs it (`GuiSession.writeFile`):
the background service when it holds the project, so the write takes the
lane its tasks' edits take. "Landed" below says what that covers.

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

One operation, one owner of where it runs:

- `writeFileIfUnchanged` (`packages/texra/src/common/files/projectFileWrite.ts`)
  makes a file hold `contents` provided it is as the person last saw it
  (`anything`, `absent`, or `holds` some text, line endings aside). The
  editor's save and the toolbar's accept are both this call; the accept's
  staged rename (atomic, through a symlink, keeping the mode) is the one way
  it writes, so a save gained it. A file that already holds `contents` is the
  write done: a write repeated after its answer was lost reads as the success
  it was, not as someone else's change.
- `GuiSession.writeFile` is decided in `openProjectSession`, beside `where`:
  `serviceFileWrite(link)` when the service holds the project, else the
  operation itself. The window's request body and the toolbar's controller
  take it as given and decide nothing about processes.
- `file.write { path, contents, expected }` is the one procedure
  (`protocol.ts`); the service runs the same operation and opens no project
  for it, so a write that reaches a service on its way out still lands.
- Decision 2's outage path is inside `serviceFileWrite`
  (`packages/texra/src/controllers/server/serviceSession.ts`): while the link
  holds no service, or the call does not come back, the same write runs in
  the window's process and a warn names the file.
- What a surface may name stays the window's rule (`resolveWritable`, an
  agent definition by catalog name); the path the service is handed is
  already resolved, as a task's tools resolve theirs.
- A service of another build never takes the call: the protocol digest
  differs, so the link retires it or refuses it before any request.

Left as it is:

- A file the user edits in VS Code's own editor is saved by VS Code, which
  no lane of TeXRA's covers.
- Reads and directory listings stay in the window: they decide nothing.
