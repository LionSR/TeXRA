/**
 * Where a GUI window's project session lives, decided once for every host:
 * a folder whose window reached the background service runs its tasks
 * there, and this process opens no session for it; any other window (no
 * folder, no service) opens the project's session here, for the caller's
 * scope.
 */
import { type Context, Effect, type Scope } from 'effect';

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
  const session = yield* openLocalSession(yield* Sessions, roots);
  // A store moved aside at open (pre-1.0 or corrupt) is said once.
  if (session.storeMovedAside)
    yield* warn(sessionStoreMovedAsideMessage(session.storeMovedAside));
  return { session, link: yield* (yield* HostWindows).localLink(session) };
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
    // shutdown deadline, the ones still live past it settled, its
    // artifacts flushed, its entry released.
    (opened) => Effect.asVoid(sessions.close(opened.roots)),
  ).pipe(Effect.tap(recordFirstCompletedRun));
