/**
 * Where a GUI window's project session lives, decided once for every host:
 * a folder whose window reached the background service runs its tasks
 * there, and this process opens no session for it; any other window (no
 * folder, no service) opens the project's session here, for the caller's
 * scope.
 */
import { Effect, type Scope } from 'effect';

import { Sessions, type WorkspaceRoots } from '@texra-ai/harness';
import { recordFirstCompletedRun } from '@texra/controllers/onboarding/onboardingFunnel';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import { serviceSession } from '@texra/controllers/server/serviceSession';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';
import type { ServiceLink } from '@texra/controllers/server/client';
import type { GuiSession } from './openGuiWindow';

/**
 * Open the session of the project at `roots`. `service` is the link the
 * window reached, if any; `warn` tells the user what opening a session here
 * found (a store moved aside at open), as each host shows a warning.
 */
export const openProjectSession = Effect.fn('openProjectSession')(function* (
  roots: WorkspaceRoots,
  service: ServiceLink | undefined,
  warn: (message: string) => Effect.Effect<void>,
): Effect.fn.Return<GuiSession, Error, Scope.Scope | Sessions | HostWindows> {
  if (service !== undefined && roots.workspace !== undefined)
    return {
      link: service,
      session: yield* serviceSession(service, roots.workspace, roots),
    };
  const sessions = yield* Sessions;
  const session = yield* Effect.acquireRelease(
    sessions.open(roots, { persistent: true, host: {} }),
    // The one close every session takes: its runs stopped under the
    // shutdown deadline, the ones still live past it ended, its
    // artifacts flushed, its entry released.
    (opened) => Effect.asVoid(sessions.close(opened.roots)),
  );
  yield* recordFirstCompletedRun(session);
  // A store moved aside at open (pre-1.0 or corrupt) is said once.
  if (session.storeMovedAside)
    yield* warn(sessionStoreMovedAsideMessage(session.storeMovedAside));
  return { session, link: yield* (yield* HostWindows).localLink(session) };
});
