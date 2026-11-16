# One writer per project file: the desktop save and the service's runs

Date: 2026-11-16
Status: proposed, held for two decisions

Origin: LN-4 of the 2026-11-15 design red-flag audit
(`../../evidence/2026-11-15-design-red-flags/LN-nonobvious-degradation.md`),
re-read on `main` after #14971.

## The problem

`withFileWriteLane` (`packages/harness/src/utils/files/fileWriteLane.ts`) is
one lane per file per process. The desktop editor's save takes it in the
Electron main process (`packages/desktop/src/main/desktopWorkspaceIpc.ts`,
`writeFile`); an agent's approved edit takes it where the tool runs
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
   needs the containment rules the desktop holds
   (`resolveWorkspaceWritePath`: canonical parent, no symlinked final
   component). That moves workspace-file containment into the harness. An
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

## First step taken

The comment over the desktop's `writeFile` claimed the lane kept it apart
from every approved edit. It now says the lane is per process and names the
case it does not cover.
