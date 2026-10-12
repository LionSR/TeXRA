import { Cause, Effect, Exit, FiberSet, Scope, Semaphore } from 'effect';
import { Menu, type BrowserWindow } from 'electron';

import { workspaceEnvironmentLayer } from '@texra-ai/harness';
import { DESKTOP_HEADLESS } from './desktopPresentation.js';
import type { ProcessRuntime, ProcessServices } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/**
 * Run a program on the process runtime as a fiber of the window's scope: it
 * is interrupted, and awaited, when the window closes, and a callback that
 * fires after the close never starts one. Every Electron callback of a window
 * forks through this, never through a bare `runtime.runFork`.
 */
export type DesktopSpawn = (
  program: Effect.Effect<void, never, ProcessServices>,
) => void;

export function desktopSpawner(
  runtime: ProcessRuntime,
  scope: Scope.Scope,
  /** The project a surface serves: its programs (credential status, model
   *  availability) see that project's `.env`, as its runs do. */
  workspace?: string,
): DesktopSpawn {
  const env = workspaceEnvironmentLayer(workspace);
  return (program) => {
    runtime.runFork(Effect.forkIn(Effect.provide(program, env), scope));
  };
}

/** What an opened window hands the process. */
export interface OpenedDesktopWindow {
  readonly window: BrowserWindow;
  /** Show a run of a project in the window; the window assigns it. */
  reveal(key: string, runId: RunId): void;
}

/** What the process lends the window it opens. */
export interface DesktopWindowHooks {
  /** The user kept editing: a quit waiting on this window's close is off. */
  cancelPendingQuit(): void;
}

interface CurrentWindow extends OpenedDesktopWindow {
  /** Closes the window's scope: run once, a later caller joining the close
   *  in flight, so the closed event, a reopen and the shutdown all wait on
   *  the same release. */
  readonly release: Effect.Effect<void>;
}

/**
 * The process's one window and the lifetime it is bound to. A window is a
 * scope: opening it builds every resource into that scope, and its `closed`
 * event closes the scope, awaited. A quit, a reopen and the process shutdown
 * all wait for that release, so two windows' resources never overlap and the
 * shutdown never drains services under a window still tearing down.
 */
export interface DesktopWindows {
  /** The open window, if any. */
  window(): BrowserWindow | null;
  /** Show the window, or reopen it once the closed one has released. */
  focus(then?: () => void): void;
  /** Show a run of a project in the open window. */
  revealRun(key: string, runId: RunId): void;
  /** Open the window when none is open, once the closed one has released,
   *  then run `then`; a reopen asked for while one is opening joins it. */
  reopen(then?: () => void): void;
  /** Open the window unless one is open. Opening waits (a project of the
   *  background service attaches the window over IPC), so it is always run
   *  as a fiber, never synchronously; opens run one at a time, and one that
   *  finds the window open does nothing. */
  readonly open: Effect.Effect<void, never, ProcessServices>;
  /** Run `continueQuit` once the window has closed and released; the process
   *  shutdown resumes there. */
  continueQuitAfterClose(continueQuit: () => void): void;
  /** The shutdown: interrupt a reopen in flight (its window releases what it
   *  built) and refuse later ones, then wait for the open or closing window
   *  to release everything it held. */
  readonly released: Effect.Effect<void>;
}

export function createDesktopWindows(options: {
  readonly runtime: ProcessRuntime;
  /** Builds the window into the scope it runs in. */
  readonly open: (
    hooks: DesktopWindowHooks,
  ) => Effect.Effect<OpenedDesktopWindow, never, Scope.Scope | ProcessServices>;
}): DesktopWindows {
  const { runtime } = options;
  // The reopens in flight. The shutdown closes this scope (`released`):
  // a window still opening releases its scope before the services drain,
  // and a reopen asked for afterwards never starts.
  const reopensScope = Scope.makeUnsafe();
  const reopens = runtime.runSync(
    FiberSet.make<void>().pipe(Scope.provide(reopensScope)),
  );
  let current: CurrentWindow | undefined;
  let releasing: Effect.Effect<void> | undefined;
  let continueQuit: (() => void) | undefined;

  const hooks: DesktopWindowHooks = {
    cancelPendingQuit: () => {
      continueQuit = undefined;
    },
  };

  const onClosed = (closed: CurrentWindow) => {
    const resume = continueQuit;
    continueQuit = undefined;
    if (current === closed) {
      current = undefined;
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }]));
      }
    }
    // Published before the close starts, so a reopen asked for meanwhile
    // waits for it even when every finalizer runs synchronously.
    releasing = closed.release;
    runtime.runFork(
      closed.release.pipe(
        // Resume the quit once the window's resources are released and
        // Electron has finished closing it. A quit requested from inside
        // `closed` lands before the window leaves the window list, so
        // Electron abandons it and emits `window-all-closed` instead of
        // `will-quit`, which on macOS leaves the process running.
        Effect.ensuring(
          Effect.sync(() => {
            if (releasing === closed.release) releasing = undefined;
            if (resume) setImmediate(resume);
          }),
        ),
      ),
    );
  };

  const openWindow = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const release = yield* Effect.cached(
      Scope.close(scope, Exit.void).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error(
              'The desktop window did not release cleanly:',
              Cause.squash(cause),
            ),
          ),
        ),
      ),
    );
    const opened = yield* options.open(hooks).pipe(
      Scope.provide(scope),
      Effect.onError(() => release),
    );
    const window: CurrentWindow = { ...opened, release };
    current = window;
    // Closed while the open waited: release it now, as `closed` would have.
    if (opened.window.isDestroyed()) onClosed(window);
    else opened.window.once('closed', () => onClosed(window));
  });

  // One open at a time: an open asked for while another is in flight waits
  // for it and then finds the window open.
  const opening = Semaphore.makeUnsafe(1);
  const open = opening.withPermit(
    Effect.suspend(() =>
      current
        ? Effect.void
        : Effect.andThen(releasing ?? Effect.void, openWindow),
    ),
  );

  const reopen = (then?: () => void) => {
    // An interrupted reopen (the shutdown) neither logs nor runs `then`.
    runtime.runFork(
      FiberSet.run(
        reopens,
        open.pipe(
          Effect.catchDefect((defect) =>
            Effect.sync(() =>
              console.error(
                'The desktop window could not be reopened:',
                defect,
              ),
            ),
          ),
          Effect.andThen(Effect.sync(() => then?.())),
        ),
      ),
    );
  };

  return {
    window: () => current?.window ?? null,
    focus: (then) => {
      const window = current?.window;
      if (!window) {
        reopen(then);
        return;
      }
      if (!DESKTOP_HEADLESS) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      then?.();
    },
    revealRun: (key, runId) => current?.reveal(key, runId),
    reopen,
    open,
    continueQuitAfterClose: (resume) => {
      continueQuit = resume;
    },
    released: Effect.andThen(
      Scope.close(reopensScope, Exit.void),
      Effect.suspend(() => current?.release ?? releasing ?? Effect.void),
    ),
  };
}
