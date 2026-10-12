/**
 * Where a window's runs run, decided once at activation. A window that
 * reaches the background service drives the service's session for its
 * project and opens none of its own: no session handle, no run log, no run
 * claims. Only a window that cannot reach the service runs its tasks here,
 * on a session this process owns, and says so once.
 */
import {
  Effect,
  Result,
  type Context,
  type FileSystem,
  type Path,
  type Scope,
} from 'effect';

import {
  SessionOwner,
  type Session,
  type Sessions,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import type { SessionHandle } from '@agent/runtime';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { withLogChannel } from '@logger/effectLog';
import { StorageFs, withSessionFs } from '@platform/rootedFs';
import type { ServiceLink } from '@texra/controllers/server/client';
import { serviceSession } from '@texra/controllers/server/serviceSession';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';

/** The window's session: the service's, or, when the service could not be
 *  reached, this process's own with the handle that owns it. */
export type WindowSession =
  | {
      readonly session: Session;
      readonly service: ServiceLink;
      readonly handle?: undefined;
    }
  | {
      readonly session: Session;
      readonly handle: SessionHandle;
      readonly service?: undefined;
    };

/**
 * The window's session over `roots`, from the activation's one attempt to
 * reach the service; `sessions` opens the fallback's driving session. `warn` shows a notice: the fallback's "runs here only",
 * and a session store moved aside at open.
 *
 * A reconnect never re-enters this decision: the service's session answers
 * every call with the offline refusal while the link holds no client, and
 * takes the service up again when the link reaches it.
 */
export const openWindowSession = Effect.fn('openWindowSession')(function* (
  reached: Result.Result<ServiceLink, Error>,
  roots: WorkspaceRoots,
  sessions: Context.Service.Shape<typeof Sessions>,
  warn: (message: string) => Effect.Effect<void>,
): Effect.fn.Return<
  WindowSession,
  Error,
  Scope.Scope | SessionOwner | FileSystem.FileSystem | Path.Path
> {
  if (Result.isSuccess(reached)) {
    const service = reached.success;
    const session = yield* serviceSession(
      service,
      roots.workspace ?? '',
      roots,
    );
    return { session, service };
  }
  const handle = yield* (yield* SessionOwner).open({
    roots,
    interruptedTasks: 'offer',
  });
  const session = yield* sessions.open(roots, { persistent: true });
  const reason = `TeXRA runs this window's tasks here only, so other windows and terminals will not see them: ${reached.failure.message}`;
  yield* Effect.logWarning(reason).pipe(withLogChannel('extension'));
  yield* warn(reason);
  if (handle.log.movedAside)
    yield* warn(sessionStoreMovedAsideMessage(handle.log.movedAside));
  // The run-storage directory of the session just opened, through that
  // session's own storage view.
  yield* withSessionFs(
    roots,
    Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
      storageFs.makeDirectory(WORKSPACE_STORAGE_LAYOUT.runs, {
        recursive: true,
      }),
    ),
  );
  return { session, handle };
});
