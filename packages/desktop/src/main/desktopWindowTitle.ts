import { basename } from 'node:path';
import { type BrowserWindow } from 'electron';
import { Effect, type Scope, Stream, SubscriptionRef } from 'effect';
import type { SessionHandle } from '@agent/runtime';
import {
  formatSessionTitle,
  NATIVE_WINDOW_TITLE,
  type SessionTitleState,
} from '@shared/sessionTitle';
import type { SessionView } from '@shared/session/sessionView';

type DesktopTitleSession = Pick<SessionHandle, 'view'>;

type DesktopTitleWindow = Pick<
  BrowserWindow,
  'getTitle' | 'isDestroyed' | 'setTitle' | 'webContents'
>;

/** The paper-level activity, read from the fold's rollup and nothing else:
 *  a decision waiting on the user outranks a run in progress. */
function sessionActivity(view: SessionView): SessionTitleState {
  if (view.rollup.waiting > 0) return 'approval';
  return view.rollup.running > 0 ? 'running' : 'idle';
}

/** Compute the current title synchronously, including before a window opens. */
export function getDesktopWindowTitle(
  session: DesktopTitleSession,
  workspacePath: string | undefined,
): string {
  const workspaceName = workspacePath ? basename(workspacePath) : undefined;
  return formatSessionTitle(
    workspaceName,
    sessionActivity(SubscriptionRef.getUnsafe(session.view)),
    { style: NATIVE_WINDOW_TITLE },
  );
}

/**
 * Keep one BrowserWindow title synchronized with its session's view, for as
 * long as the enclosing scope is open and `isCurrent` holds. Renderer page
 * titles are presentation content and cannot replace this host-owned
 * projection. `isCurrent` is the owner's synchronous check: a project switch
 * forks the old scope's close, so until that close runs, only this check
 * keeps the old session's stream from writing over the new project's title.
 */
export function installDesktopWindowTitle(
  window: DesktopTitleWindow,
  session: DesktopTitleSession,
  workspacePath: string | undefined,
  isCurrent: () => boolean,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    let currentTitle = window.getTitle();
    let disposed = false;
    const update = (): void => {
      if (disposed || !isCurrent() || window.isDestroyed()) return;
      const title = getDesktopWindowTitle(session, workspacePath);
      if (title === currentTitle) return;
      currentTitle = title;
      window.setTitle(title);
    };
    const preventRendererTitle = (event: { preventDefault(): void }): void => {
      event.preventDefault();
    };

    yield* Stream.runForEach(SubscriptionRef.changes(session.view), () =>
      Effect.sync(update),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          'The window title stopped following its session',
          cause,
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    // Registered after the fork, so the scope's close runs this first and
    // synchronously, before that fiber is interrupted.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        window.webContents.on('page-title-updated', preventRendererTitle);
      }),
      () =>
        Effect.sync(() => {
          disposed = true;
          // Check the window before touching `.webContents`: the property
          // getter itself throws "Object has been destroyed" once the window
          // is gone, which is the case when the window's own `closed`
          // handler closes this scope; the listener dies with it anyway.
          if (window.isDestroyed()) return;
          if (!window.webContents.isDestroyed()) {
            window.webContents.removeListener(
              'page-title-updated',
              preventRendererTitle,
            );
          }
        }),
    );
    update();
  });
}
