// Interactive terminal sessions for the desktop app.
//
// This host owns long-lived pseudo-terminals the user types into, so it needs a
// real pty (job control, TTY-aware programs, ANSI, resize) rather than a
// buffered child process.
//
// node-pty is a native module, but it loads under Electron's ABI as shipped
// (verified against the bundled Electron 43 before adopting it), so no
// electron-rebuild step is required. It is imported lazily all the same: a
// user who never opens a terminal shouldn't pay for loading a native addon, and
// if the addon is missing on some platform the failure surfaces as "terminal
// unavailable" instead of preventing the app from starting.

import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';

import { Effect, Exit, Schema } from 'effect';

import { withExtendedPath } from '@texra-ai/harness/node';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';

/**
 * The subset of node-pty this host depends on: node-pty's own module type
 * satisfies it structurally, and a test fakes only this much through
 * `loadPty`.
 */

/** A terminal could not start: the native module would not load, or the
 *  shell would not spawn. */
class PtyStartFailed extends Schema.TaggedError<PtyStartFailed>()(
  'PtyStartFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const startFailed = (cause: unknown) =>
  new PtyStartFailed({ message: toErrorMessage(cause), cause });

interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  readonly pid: number;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): PtyProcess;
}

interface PtySessionHandle {
  readonly id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface DesktopPtyHostOptions {
  /** Working directory for every session, decided by the owner. */
  readonly cwd: string;
  /** Streams pty output to the renderer. */
  onData(sessionId: string, data: string): void;
  /** Reports process exit so the UI can mark the session finished. */
  onExit(sessionId: string, exitCode: number): void;
  onError(error: unknown): void;
  /** Overrides native-module loading for a controlled host environment. */
  loadPty?: () => Promise<NodePtyModule>;
}

export interface DesktopPtyHost {
  /**
   * Starts a session. Fails when the native module is unavailable or the
   * shell does not spawn, so the caller can report "terminal unavailable"
   * rather than hanging on a terminal that will never produce output.
   * Succeeds with `undefined` when resource disposal invalidates the request
   * while the native module is loading.
   */
  create(input: {
    id: string;
    cols: number;
    rows: number;
  }): Effect.Effect<PtySessionHandle | undefined, PtyStartFailed>;
  get(id: string): PtySessionHandle | undefined;
  disposeAll(): void;
}

/**
 * Default shell for an interactive session. `$SHELL` is the user's actual
 * choice; the per-platform fallbacks only matter when it is unset (some launch
 * contexts, notably a GUI app started by launchd, don't inherit it).
 */
function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (osPlatform() === 'win32') {
    return process.env.COMSPEC ?? 'powershell.exe';
  }
  return '/bin/bash';
}

/**
 * Environment for the pty. Electron injects variables that confuse child
 * processes into thinking they are the Electron app rather than a plain shell,
 * so they are stripped.
 */
function ptyEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    if (key === 'ELECTRON_RENDERER_URL') continue;
    env[key] = value;
  }
  // Programs branch on TERM for color and cursor support. xterm.js speaks
  // xterm-256color, and without this many tools fall back to dumb output.
  env.TERM = 'xterm-256color';
  // A Finder- or Dock-launched app inherits a minimal PATH with no Homebrew,
  // no /usr/local/bin and no ~/.local/bin. TeXRA resolves its own tools
  // through the shared PATH extension, so without it here the terminal cannot
  // run the very commands the app tells the user to run — the Integrations
  // card would offer `brew install ...` to a shell that then reports
  // `brew: command not found`. `withExtendedPath` also owns the Windows
  // `Path`-vs-`PATH` rule this used to hand-roll.
  return withExtendedPath(env);
}

/**
 * Restores the executable bit on node-pty's `spawn-helper`.
 *
 * On macOS, node-pty shells out to a small `spawn-helper` binary to allocate the
 * pty. It ships in the package's `prebuilds/<platform>-<arch>/` directory, but
 * pnpm's content-addressed store extracts it without the executable bit — so
 * every `pty.spawn()` fails with a bare `posix_spawnp failed.` and no hint as to
 * why. (A plain npm install happens to preserve the mode, which is why this is
 * easy to miss.)
 *
 * Fixed here rather than in a postinstall script so it survives any install
 * path, including a packaged app whose files were copied by the builder.
 */
const ensureSpawnHelperExecutable = Effect.try({
  try: () => {
    if (osPlatform() === 'win32') return;
    const require_ = createRequire(import.meta.url);
    const packageRoot = dirname(require_.resolve('node-pty/package.json'));
    const helper = join(
      packageRoot,
      'prebuilds',
      `${osPlatform()}-${process.arch}`,
      'spawn-helper',
    );
    const mode = statSync(helper).mode;
    // Only write when a bit is actually missing: chmod on every launch would be
    // a pointless syscall, and on a read-only install it would throw.
    if ((mode & 0o111) === 0o111) return;
    chmodSync(helper, mode | 0o111);
  },
  catch: ensureError,
}).pipe(
  // A missing helper or read-only filesystem is not fatal here: the spawn
  // fails with its own error, which the caller surfaces in the terminal as
  // "Could not start a terminal". The warning names why it may.
  Effect.catch((error) =>
    Effect.logWarning(
      "node-pty's spawn-helper could not be made executable; a terminal may fail to start",
      error,
    ),
  ),
);

/** The loaded module, kept once a load succeeds so repeated terminals don't
 *  re-resolve the addon; a failed load keeps nothing, so a later attempt
 *  retries. */
let nodePty: NodePtyModule | undefined;

const loadNodePty: Effect.Effect<NodePtyModule, PtyStartFailed> =
  Effect.suspend(() =>
    nodePty !== undefined
      ? Effect.succeed(nodePty)
      : Effect.tryPromise({
          try: () => import('node-pty'),
          catch: startFailed,
        }).pipe(
          Effect.tap((module) =>
            Effect.andThen(
              ensureSpawnHelperExecutable,
              Effect.sync(() => {
                nodePty = module;
              }),
            ),
          ),
        ),
  );

export function createDesktopPtyHost(
  options: DesktopPtyHostOptions,
): DesktopPtyHost {
  const sessions = new Map<string, PtySessionHandle>();
  const loadPty =
    options.loadPty === undefined
      ? loadNodePty
      : Effect.tryPromise({ try: options.loadPty, catch: startFailed });

  return {
    create: ({ id, cols, rows }) =>
      Effect.suspend(() => {
        const existing = sessions.get(id);
        if (existing) return Effect.succeed(existing);

        // The handle is the session's one owner from this synchronous step on,
        // before the native module load suspends: a close (or `disposeAll`)
        // that lands while the load is pending finds it in the map and marks
        // it disposed, so the shell is never spawned for a tab that is gone.
        // Input typed before the shell exists is held and replayed to it.
        let child: PtyProcess | undefined = undefined;
        let disposed = false;

        let size = { cols: Math.max(cols, 20), rows: Math.max(rows, 5) };
        const heldInput: string[] = [];
        const handle: PtySessionHandle = {
          id,
          write: (data) => {
            if (child) child.write(data);
            else heldInput.push(data);
          },
          resize: (nextCols, nextRows) => {
            // A pty spawned at 0 columns makes shells emit unusable line
            // wrapping, so clamp to a sane minimum until the renderer reports
            // real bounds.
            size = {
              cols: Math.max(nextCols, 20),
              rows: Math.max(nextRows, 5),
            };
            if (!child) return;
            try {
              child.resize(size.cols, size.rows);
            } catch (error) {
              // Resizing a pty whose process already exited throws; the exit
              // handler has cleaned up, so this is not actionable.
              options.onError(error);
            }
          },
          dispose: () => {
            disposed = true;
            if (sessions.get(id) === handle) sessions.delete(id);
            if (!child) return;
            try {
              child.kill();
            } catch (error) {
              options.onError(error);
            }
          },
        };
        sessions.set(id, handle);
        return Effect.gen(function* () {
          const pty = yield* loadPty;
          if (disposed) return undefined;
          const spawned = yield* Effect.try({
            try: () =>
              pty.spawn(defaultShell(), [], {
                name: 'xterm-256color',
                cols: size.cols,
                rows: size.rows,
                cwd: options.cwd,
                env: ptyEnvironment(),
              }),
            catch: startFailed,
          });
          child = spawned;
          spawned.onData((data) => {
            if (sessions.get(id) !== handle) return;
            options.onData(id, data);
          });
          spawned.onExit(({ exitCode }) => {
            if (sessions.get(id) !== handle) return;
            sessions.delete(id);
            options.onExit(id, exitCode);
          });
          for (const data of heldInput.splice(0)) spawned.write(data);
          return handle;
        }).pipe(
          // Until a shell runs, a failure (the module load, or the spawn
          // itself: a helper that cannot execute) or an interruption gives the
          // id back, so a later start for it spawns again rather than finding
          // a handle no shell ever backs.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => {
                  if (sessions.get(id) === handle) sessions.delete(id);
                }),
          ),
          // A creation the tab's close or `disposeAll` already invalidated
          // ends quietly, whatever its load did.
          Effect.catch((error) =>
            disposed ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        );
      }),

    get: (id) => sessions.get(id),

    disposeAll() {
      // Copy first: dispose() mutates the map through the shared handle. A
      // creation still loading its module is in the map too, and its
      // `disposed` flag abandons the spawn when the load resolves.
      for (const handle of [...sessions.values()]) handle.dispose();
      sessions.clear();
    },
  };
}
