/**
 * Direct LSP adapter for Lean tools — used by the CLI and desktop builds.
 *
 * Implements the same {@link LeanLanguageServices} interface as the VS Code
 * integration. Per-workspace sessions are cached: the first request that
 * targets a file in a given Lake project spawns `lake env lean --server`
 * from that project root; subsequent requests from any agent reuse the
 * same session. Sessions are torn down on platform shutdown.
 */

import { access } from 'node:fs/promises';
import * as path from 'node:path';

import { warn } from '@logger/logUtils';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runLakeCommand } from './lakeCommands';
import { LeanSession } from './leanSession';
import { setLeanLanguageServices } from '../leanLanguageServices';
import type { LeanLanguageServices } from '../leanLanguageServices';
import type {
  LeanFileCommand,
  LeanProjectCommand,
  LeanDiagnostic,
  LspHover,
  LspResult,
  PlainGoal,
  PlainTermGoal,
} from '../leanTypes';

const LOG_CHANNEL = 'lean.direct';

/**
 * Lake arguments for project commands that fan out across all active sessions.
 * Commands absent here (restart_server, stop_server, install_elan, …) are
 * handled by their own dedicated branches.
 */
const LAKE_PROJECT_ARGS: Partial<
  Record<LeanProjectCommand, readonly string[]>
> = {
  build: ['build'],
  clean: ['clean'],
  fetch_cache: ['exe', 'cache', 'get'],
  fetch_file_cache: ['exe', 'cache', 'get'],
};

export interface DirectLspLeanAdapterOptions {
  /** Path or name of the `lake` binary (defaults to `lake` on PATH). */
  lakeCommand?: string;
  /** Override the project-root locator (mostly for tests). */
  resolveWorkspaceRoot?: (filePath: string) => Promise<string | null>;
}

/**
 * Wire the direct LSP adapter as the Lean language services for hosts without
 * a VS Code extension bridge (Electron desktop, CLI). Spawns `lake env lean
 * --server` lazily per Lake project root; nothing happens at startup when no
 * Lean tools are invoked.
 */
export function registerDirectLeanLanguageServices(
  lifecycle: LifecycleHost,
): void {
  const leanAdapter = createDirectLspLeanAdapter();
  setLeanLanguageServices(leanAdapter);
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => leanAdapter.dispose());
}

/**
 * Build a {@link LeanLanguageServices} implementation that talks directly to
 * `lake env lean --server`. Register the returned object with
 * `setLeanLanguageServices(...)` during platform startup.
 */
export function createDirectLspLeanAdapter(
  options: DirectLspLeanAdapterOptions = {},
): LeanLanguageServices & { dispose(): Promise<void> } {
  const lakeCommand = options.lakeCommand ?? 'lake';
  const resolveRoot =
    options.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot;
  const sessions = new Map<string, LeanSession>();
  const sessionStarts = new Map<string, Promise<LeanSession>>();

  async function getSession(filePath: string): Promise<LeanSession> {
    const absolute = path.resolve(filePath);
    const root = await resolveRoot(absolute);
    if (!root) {
      throw new Error(
        `No Lean project found for ${absolute}. Lake projects need a lakefile.lean or lakefile.toml in an ancestor directory.`,
      );
    }
    return getOrStartSession(root);
  }

  /**
   * Register an in-flight start so concurrent callers join the same promise,
   * dropping the session on failure and clearing the in-flight slot once it
   * settles.
   */
  function trackStart(
    root: string,
    session: LeanSession | undefined,
    start: Promise<LeanSession>,
  ): Promise<LeanSession> {
    sessionStarts.set(root, start);
    void start
      .catch(() => {
        if (session && sessions.get(root) === session) {
          sessions.delete(root);
        }
      })
      .finally(() => {
        if (sessionStarts.get(root) === start) {
          sessionStarts.delete(root);
        }
      });
    return start;
  }

  /** Dispose every session and clear all tracking. */
  async function disposeAll(): Promise<void> {
    const all = [...sessions.values()];
    sessions.clear();
    sessionStarts.clear();
    await Promise.all(all.map((session) => session.dispose()));
  }

  function getOrStartSession(root: string): Promise<LeanSession> {
    const inFlight = sessionStarts.get(root);
    if (inFlight) return inFlight;

    const existing = sessions.get(root);
    if (existing) {
      return trackStart(
        root,
        existing,
        existing.ensureReady().then(() => existing),
      );
    }

    return startFreshSession(root);
  }

  function startFreshSession(root: string): Promise<LeanSession> {
    const session = new LeanSession({
      workspaceRoot: root,
      lakeCommand,
      onExit: () => {
        if (sessions.get(root) === session) {
          sessions.delete(root);
        }
      },
    });
    sessions.set(root, session);
    return trackStart(
      root,
      session,
      session.ensureReady().then(() => session),
    );
  }

  function restartSession(root: string): Promise<LeanSession> {
    return trackStart(
      root,
      undefined,
      (async () => {
        const existing = sessions.get(root);
        if (existing) {
          sessions.delete(root);
          await existing.dispose();
        }
        return startFreshSession(root);
      })(),
    );
  }

  return {
    async fetchDiagnosticsForFile(
      file: string,
    ): Promise<LeanDiagnostic[] | null> {
      try {
        const session = await getSession(file);
        return await session.fetchDiagnostics(file);
      } catch (error) {
        // Return null (LeanDiagnosticsTool surfaces it as a failure result) and
        // log the cause. The interface contract is `LeanDiagnostic[] | null`;
        // honoring it keeps a missing/broken `lake` from throwing out of the
        // JSON-RPC path.
        warn(
          LOG_CHANNEL,
          `fetchDiagnosticsForFile failed for ${file}: ${toErrorMessage(error)}`,
        );
        return null;
      }
    },

    async navigateToFirstError(): Promise<void> {
      // No editor to navigate in CLI/desktop. The tool result still carries
      // the diagnostic list so the agent can act on it.
    },

    async executeFileCommand(
      command: LeanFileCommand,
      filePath: string,
    ): Promise<boolean> {
      try {
        // Both file commands have the same effect from our point of view: drop
        // the cached open state and re-open with fresh contents.
        const session = await getSession(filePath);
        await session.restartFile(filePath);
        return true;
      } catch (error) {
        // Return false (LeanFileTool surfaces it as a failure result) and log
        // the cause. Honors the `Promise<boolean>` contract so a missing/broken
        // `lake` doesn't throw out of the JSON-RPC path.
        warn(
          LOG_CHANNEL,
          `executeFileCommand(${command}) failed for ${filePath}: ${toErrorMessage(error)}`,
        );
        return false;
      }
    },

    async executeProjectCommand(command: LeanProjectCommand): Promise<void> {
      // Project commands aren't tied to a file. We apply to every active
      // session; lake commands serialize per workspace via the mutex.
      switch (command) {
        case 'restart_server': {
          const roots = [...sessions.keys()];
          if (roots.length === 0) {
            throw new Error('No Lean server running to restart.');
          }
          await Promise.all(roots.map((root) => restartSession(root)));
          return;
        }
        case 'stop_server':
          await disposeAll();
          return;
        // `fetch_file_cache` normally needs the active editor's file; we don't
        // have one in CLI/desktop, so it falls back to the project-wide cache
        // fetch (same as `fetch_cache`). All four fan out one lake-arg set per
        // active session via the LAKE_PROJECT_ARGS lookup below.
        case 'build':
        case 'clean':
        case 'fetch_cache':
        case 'fetch_file_cache': {
          const lakeArgs = LAKE_PROJECT_ARGS[command];
          if (lakeArgs) {
            await runForAllSessions(sessions, lakeCommand, lakeArgs);
          }
          return;
        }
        case 'install_elan':
        case 'install_deps':
        case 'update_elan':
        case 'select_toolchain':
          throw new Error(
            `Command "${command}" is only available inside VS Code with the leanprover.lean4 extension. ` +
              'In CLI/desktop builds, run the matching shell command directly (see https://leanprover-community.github.io/install/linux.html).',
          );
      }
    },

    async getGoalState(
      filePath: string,
      line: number,
      column: number,
    ): Promise<LspResult<PlainGoal>> {
      return positionRequest<PlainGoal>(filePath, (session) =>
        session.requestSettled<PlainGoal | null>(
          filePath,
          line,
          column,
          '$/lean/plainGoal',
        ),
      );
    },

    async getTermGoal(
      filePath: string,
      line: number,
      column: number,
    ): Promise<LspResult<PlainTermGoal>> {
      return positionRequest<PlainTermGoal>(filePath, (session) =>
        session.requestSettled<PlainTermGoal | null>(
          filePath,
          line,
          column,
          '$/lean/plainTermGoal',
        ),
      );
    },

    async getHoverInfo(
      filePath: string,
      line: number,
      column: number,
    ): Promise<LspResult<LspHover>> {
      return positionRequest<LspHover>(filePath, (session) =>
        session.requestSettled<LspHover | null>(
          filePath,
          line,
          column,
          'textDocument/hover',
        ),
      );
    },

    dispose: disposeAll,
  };

  async function positionRequest<T>(
    filePath: string,
    invoke: (session: LeanSession) => Promise<T | null>,
  ): Promise<LspResult<T>> {
    try {
      const session = await getSession(filePath);
      const data = await invoke(session);
      if (!data)
        return {
          data: null,
          error: 'Lean returned no data for this position.',
        };
      return { data };
    } catch (error) {
      return {
        data: null,
        error: toErrorMessage(error),
      };
    }
  }
}

async function runForAllSessions(
  sessions: Map<string, LeanSession>,
  lakeCommand: string,
  args: readonly string[],
): Promise<void> {
  if (sessions.size === 0) {
    throw new Error(
      `No Lean project session active. Run a Lean tool against a file in your project first, then retry "${args.join(' ')}".`,
    );
  }
  const results = await Promise.all(
    [...sessions.values()].map((session) =>
      runLakeCommand({
        workspaceRoot: session.workspaceRoot,
        lakeCommand,
        args,
        serialize: true,
      }),
    ),
  );
  const failed = results.filter((r) => r.exitCode !== 0);
  if (failed.length > 0) {
    throw new Error(
      `lake ${args.join(' ')} failed in ${failed.length} workspace(s):\n${failed
        .map((r) => r.stderr.trim() || r.stdout.trim())
        .join('\n---\n')}`,
    );
  }
}

// Uses fs/promises directly — must not call platform() because this function
// is invoked before initPlatform() during early startup / test harness setup.
async function fsPathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from `filePath` looking for a Lake project root. */
export async function defaultResolveWorkspaceRoot(
  filePath: string,
): Promise<string | null> {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;
  for (;;) {
    if (
      (await fsPathExists(path.join(dir, 'lakefile.lean'))) ||
      (await fsPathExists(path.join(dir, 'lakefile.toml')))
    ) {
      return dir;
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
