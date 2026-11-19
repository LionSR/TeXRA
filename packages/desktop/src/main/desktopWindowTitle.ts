import { type BrowserWindow } from 'electron';
import { Effect, type Scope, Stream } from 'effect';
import { sessionActivity } from '@texra-ai/harness/schemas';
import {
  formatSessionTitle,
  NATIVE_WINDOW_TITLE,
} from '@texra/shared/sessionTitle';
import type { Session } from '@texra-ai/harness';

type DesktopTitleProject = {
  readonly session: {
    readonly view: Pick<Session['view'], 'current' | 'changes'>;
  };
  /** No workspace for the no-workspace session, whose title names no
   *  project. */
  readonly roots: { readonly workspace: string | undefined };
  readonly display: { readonly name: string };
};

type DesktopTitleWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'setTitle' | 'webContents'
>;

/** Compute the current title synchronously, including before a window opens. */
export function getDesktopWindowTitle(project: DesktopTitleProject): string {
  return formatSessionTitle(
    project.roots.workspace === undefined ? undefined : project.display.name,
    sessionActivity(project.session.view.current()),
    { style: NATIVE_WINDOW_TITLE },
  );
}

/**
 * Keep the window's title on its project's view for this scope's life.
 * Switching projects closes the previous scope before installing the next
 * title follower. Renderer titles cannot replace this host-owned projection.
 */
export const installDesktopWindowTitle = Effect.fn('installDesktopWindowTitle')(
  function* (
    window: DesktopTitleWindow,
    project: DesktopTitleProject,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    const preventRendererTitle = (event: { preventDefault(): void }): void => {
      event.preventDefault();
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        window.webContents.on('page-title-updated', preventRendererTitle);
      }),
      () =>
        Effect.sync(() => {
          // The getter itself throws once Electron destroys the window.
          if (window.isDestroyed()) return;
          if (!window.webContents.isDestroyed()) {
            window.webContents.removeListener(
              'page-title-updated',
              preventRendererTitle,
            );
          }
        }),
    );
    // Registered last, so the scope interrupts and joins this follower before
    // releasing the renderer-title listener.
    yield* project.session.view.changes.pipe(
      Stream.map(() => getDesktopWindowTitle(project)),
      Stream.changes,
      Stream.runForEach((title) =>
        Effect.sync(() => {
          if (!window.isDestroyed()) window.setTitle(title);
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning(
          'The window title stopped following its session',
          defect,
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  },
);
