/**
 * Where a GUI window's project session lives, decided once for every host:
 * a folder whose window reached the background service runs its tasks
 * there, and this process opens no session for it; any other window (no
 * folder, no service) opens the project's session here, for the caller's
 * scope. The window's state carries the answer (`GuiSession.where`), so its
 * banner says when a folder's tasks run here.
 */
import { type Context, Effect, Result, type Scope } from 'effect';

import {
  type LocalSession,
  type SessionOpenError,
  Sessions,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import { recordFirstCompletedRun } from '@texra/controllers/onboarding/onboardingFunnel';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import { serviceSession } from '@texra/controllers/server/serviceSession';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';
import type { ServiceLink } from '@texra/controllers/server/client';
import type { GuiSession } from './openGuiWindow';

/**
 * Open the session of the project at `roots`. `reached` is the host's one
 * attempt to reach the background service; `warn` tells the user what
 * opening a session here found (a store moved aside at open), as each host
 * shows a warning.
 */
export const openProjectSession = Effect.fn('openProjectSession')(function* (
  roots: WorkspaceRoots,
  reached: Result.Result<ServiceLink, Error>,
  warn: (message: string) => Effect.Effect<void>,
): Effect.fn.Return<GuiSession, Error, Scope.Scope | Sessions | HostWindows> {
  if (roots.workspace !== undefined && Result.isSuccess(reached))
    return {
      where: 'service',
      link: reached.success,
      session: yield* serviceSession(reached.success, roots.workspace, roots),
    };
  // A folder the service would hold runs here because it is out of reach;
  // a window with no folder always runs here.
  const local =
    roots.workspace !== undefined && Result.isFailure(reached)
      ? `TeXRA runs this project's tasks in this window only, so other windows and terminals will not see them: ${reached.failure.message}`
      : null;
  if (local !== null) yield* Effect.logWarning(local);
  const session = yield* openLocalSession(yield* Sessions, roots);
  // A store moved aside at open (pre-1.0 or corrupt) is said once.
  if (session.storeMovedAside)
    yield* warn(sessionStoreMovedAsideMessage(session.storeMovedAside));
  return {
    where: { local },
    session,
    link: yield* (yield* HostWindows).localLink(session),
  };
});

/**
 * Open the persistent session of the project at `roots` in this process,
 * closed with the caller's scope, and record the onboarding milestone its
 * first completed run marks: the one local open every host makes (a GUI
 * window, the CLI's platform, a project of the background service). Each
 * says a store moved aside at open (`storeMovedAside`) in its own place.
 */
export const openLocalSession = (
  sessions: Context.Service.Shape<typeof Sessions>,
  roots: WorkspaceRoots,
): Effect.Effect<LocalSession, SessionOpenError, Scope.Scope> =>
  Effect.acquireRelease(
    sessions.open(roots, { persistent: true, host: {} }),
    // The one close every session takes: its runs stopped under the
    // shutdown deadline, the ones still live past it ended, its
    // artifacts flushed, its entry released.
    (opened) => Effect.asVoid(sessions.close(opened.roots)),
  ).pipe(Effect.tap(recordFirstCompletedRun));
