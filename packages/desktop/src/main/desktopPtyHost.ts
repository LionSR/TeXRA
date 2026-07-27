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

/**
 * Structural subset of node-pty we depend on. Declared locally so this module
 * type-checks without the native addon's types resolving at build time, and so
 * the import can stay dynamic.
 */
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

const PTY_MIN_COLS = 20;
const PTY_MAX_COLS = 1_000;
const PTY_MIN_ROWS = 5;
const PTY_MAX_ROWS = 500;

function normalizePtySize(
  cols: number,
  rows: number,
): { cols: number; rows: number } {
  return {
    cols: Math.min(Math.max(cols, PTY_MIN_COLS), PTY_MAX_COLS),
    rows: Math.min(Math.max(rows, PTY_MIN_ROWS), PTY_MAX_ROWS),
  };
}

export interface DesktopPtyHostOptions {
  /** Default working directory for new sessions (the workspace root). */
  cwd?: string;
  /** Streams pty output to the renderer. */
  onData(sessionId: string, data: string): void;
  /** Reports process exit so the UI can mark the session finished. */
  onExit(sessionId: string, exitCode: number): void;
  onError?(error: unknown): void;
  /** Test seam for the lazily imported native addon. */
  loadPty?(): Promise<NodePtyModule>;
}

export interface DesktopPtyHost {
  /**
   * Starts a session. Rejects when the native module is unavailable, so the
   * caller can report "terminal unavailable" rather than hanging on a
   * terminal that will never produce output.
   */
  create(input: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
  }): Promise<PtySessionHandle>;
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
  return env;
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
function ensureSpawnHelperExecutable(): void {
  if (osPlatform() === 'win32') return;
  try {
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
  } catch {
    // A missing helper or read-only filesystem is not fatal here: the spawn
    // below will fail with its own error, which the caller surfaces in the
    // terminal as "Could not start a terminal".
  }
}

let nodePtyLoad: Promise<NodePtyModule> | undefined;

async function loadNodePty(): Promise<NodePtyModule> {
  // Cached so repeated terminals don't re-resolve the addon; a failure clears
  // the cache so a later attempt can retry.
  nodePtyLoad ??= import('node-pty')
    .then((module) => {
      ensureSpawnHelperExecutable();
      return module as unknown as NodePtyModule;
    })
    .catch((error: unknown) => {
      nodePtyLoad = undefined;
      throw error;
    });
  return nodePtyLoad;
}

export function createDesktopPtyHost(
  options: DesktopPtyHostOptions,
): DesktopPtyHost {
  const sessions = new Map<string, PtySessionHandle>();
  const pendingSessions = new Map<string, Promise<PtySessionHandle>>();
  let generation = 0;

  async function startSession(input: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
  }): Promise<PtySessionHandle> {
    const createGeneration = generation;
    const pty = await (options.loadPty?.() ?? loadNodePty());
    const size = normalizePtySize(input.cols, input.rows);
    const child = pty.spawn(defaultShell(), [], {
      name: 'xterm-256color',
      // A pty spawned at 0 columns makes shells emit unusable line wrapping,
      // so clamp to a sane minimum until the renderer reports real bounds.
      cols: size.cols,
      rows: size.rows,
      cwd: input.cwd ?? options.cwd ?? process.cwd(),
      env: ptyEnvironment(),
    });

    if (createGeneration !== generation) {
      child.kill();
      throw new Error(
        'Terminal creation was cancelled during renderer reload.',
      );
    }

    child.onData((data) => options.onData(input.id, data));
    const handle: PtySessionHandle = {
      id: input.id,
      write: (data) => child.write(data),
      resize: (nextCols, nextRows) => {
        try {
          const nextSize = normalizePtySize(nextCols, nextRows);
          child.resize(nextSize.cols, nextSize.rows);
        } catch (error) {
          // Resizing a pty whose process already exited throws; the exit
          // handler has cleaned up, so this is not actionable.
          options.onError?.(error);
        }
      },
      dispose: () => {
        if (sessions.get(input.id) === handle) {
          sessions.delete(input.id);
        }
        try {
          child.kill();
        } catch (error) {
          options.onError?.(error);
        }
      },
    };
    child.onExit(({ exitCode }) => {
      if (sessions.get(input.id) === handle) {
        sessions.delete(input.id);
      }
      options.onExit(input.id, exitCode);
    });
    sessions.set(input.id, handle);
    return handle;
  }

  return {
    async create(input) {
      const existing = sessions.get(input.id);
      if (existing) return existing;

      const pending = pendingSessions.get(input.id);
      if (pending) return pending;

      const creation = startSession(input);
      pendingSessions.set(input.id, creation);
      try {
        return await creation;
      } finally {
        if (pendingSessions.get(input.id) === creation) {
          pendingSessions.delete(input.id);
        }
      }
    },

    get: (id) => sessions.get(id),

    disposeAll() {
      generation += 1;
      pendingSessions.clear();
      // Copy first: dispose() mutates the map through the shared handle.
      for (const handle of [...sessions.values()]) handle.dispose();
      sessions.clear();
    },
  };
}
