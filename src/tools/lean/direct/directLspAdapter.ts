/**
 * Direct LSP adapter for Lean tools — used by the CLI and desktop builds.
 *
 * Implements the same {@link LeanLanguageServices} interface as the VS Code
 * integration. Per-workspace sessions are cached: the first request that
 * targets a file in a given Lake project spawns `lake env lean --server`
 * from that project root; subsequent requests from any agent reuse the
 * same session. An unused server is stopped after thirty minutes. Sessions
 * are also torn down on platform shutdown.
 */

// Node imports
import { access } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import PQueue from 'p-queue';

// Local imports
import { info, warn } from '@logger/logUtils';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runLakeCommand } from './lakeCommands';
import { LeanSession } from './leanSession';
import { setLeanLanguageServices } from '../leanLanguageServices';
import type { LeanLanguageServices } from '../leanLanguageServices';
import type {
  LeanFileCommand,
  LeanProjectCommand,
  FetchDiagnosticsResult,
  LspHover,
  LspResult,
  PlainGoal,
  PlainTermGoal,
} from '../leanTypes';

const LOG_CHANNEL = 'lean.direct';
const ADAPTER_STOPPED_MESSAGE = 'Lean adapter was stopped.';

/** Long-lived CLI/desktop hosts otherwise keep unused servers forever. */
const DEFAULT_LEAN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Lake arguments for project commands that fan out across all active sessions.
 * Commands absent here (restart_server, stop_server, install_elan, …) are
 * handled by their own dedicated branches.
 */
const LAKE_PROJECT_ARGS = {
  build: ['build'],
  clean: ['clean'],
  fetch_cache: ['exe', 'cache', 'get'],
  fetch_file_cache: ['exe', 'cache', 'get'],
} satisfies Partial<Record<LeanProjectCommand, readonly string[]>>;

export interface DirectLspLeanAdapterOptions {
  /** Path or name of the `lake` binary (defaults to `lake` on PATH). */
  lakeCommand?: string;
  /** Override the project-root locator (mostly for tests). */
  resolveWorkspaceRoot?: (filePath: string) => Promise<string | null>;
  /**
   * Optional cap on simultaneous `lean --server` processes. Unset means no
   * capacity eviction — parallel worktrees stay up until they go idle.
   */
  maxSessions?: number;
  /** Stop a session after this much idle time. `0` disables idle eviction. */
  idleTimeoutMs?: number;
  /** Clock for idle/LRU decisions (tests). */
  now?: () => number;
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
  const maxSessions =
    options.maxSessions == null ? undefined : Math.max(1, options.maxSessions);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_LEAN_IDLE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, TrackedLeanSession>();
  const startQueue = new PQueue({ concurrency: 1 });
  const sessionFreedWaiters = new Set<() => void>();
  const startsIdleWaiters = new Set<() => void>();
  let startsInFlight = 0;
  let startGeneration = 0;
  let startAbort = new AbortController();

  async function getSession(filePath: string): Promise<LeanSession> {
    const generation = startGeneration;
    const absolute = path.resolve(filePath);
    const root = await resolveRoot(absolute);
    throwIfStopped(generation);
    if (!root) {
      throw new Error(
        `No Lean project found for ${absolute}. Lake projects need a lakefile.lean or lakefile.toml in an ancestor directory.`,
      );
    }
    return getOrStartSession(root, generation);
  }

  function throwIfStopped(generation: number): void {
    if (startGeneration !== generation) {
      throw new Error(ADAPTER_STOPPED_MESSAGE);
    }
  }

  function notifySessionFreed(): void {
    for (const resolve of sessionFreedWaiters) resolve();
    sessionFreedWaiters.clear();
  }

  function waitForSessionFreed(): Promise<void> {
    return new Promise((resolve) => {
      sessionFreedWaiters.add(resolve);
    });
  }

  function notifyStartsIdle(): void {
    for (const resolve of startsIdleWaiters) resolve();
    startsIdleWaiters.clear();
  }

  function waitForStartsIdle(): Promise<void> {
    if (startsInFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      startsIdleWaiters.add(resolve);
    });
  }

  function beginUse(root: string): TrackedLeanSession | undefined {
    const tracked = sessions.get(root);
    if (!tracked || tracked.disposing) return undefined;
    tracked.inFlight += 1;
    tracked.lastUsedAt = now();
    if (tracked.idleTimer) {
      clearTimeout(tracked.idleTimer);
      tracked.idleTimer = undefined;
    }
    return tracked;
  }

  function endUse(root: string, session?: LeanSession): void {
    const tracked = sessions.get(root);
    if (!tracked) return;
    if (session && tracked.session !== session) return;
    tracked.inFlight = Math.max(0, tracked.inFlight - 1);
    if (tracked.inFlight > 0) return;
    tracked.lastUsedAt = now();
    armIdleTimer(root, tracked);
    notifySessionFreed();
  }

  async function leaseSession(
    root: string,
    session: LeanSession,
  ): Promise<LeanSession> {
    if (!beginUse(root)) {
      throw new Error(ADAPTER_STOPPED_MESSAGE);
    }
    try {
      await session.ensureReady();
      return session;
    } catch (error) {
      endUse(root, session);
      throw error;
    }
  }

  async function withSession<T>(
    filePath: string,
    invoke: (session: LeanSession) => Promise<T>,
  ): Promise<T> {
    const session = await getSession(filePath);
    try {
      return await invoke(session);
    } finally {
      endUse(session.workspaceRoot, session);
    }
  }

  function armIdleTimer(root: string, tracked: TrackedLeanSession): void {
    if (tracked.idleTimer) {
      clearTimeout(tracked.idleTimer);
      tracked.idleTimer = undefined;
    }
    if (idleTimeoutMs <= 0 || tracked.inFlight > 0) return;
    const timer = setTimeout(() => {
      void disposeSession(root, 'idle').catch((error) => {
        warn(
          LOG_CHANNEL,
          `Idle stop failed for ${root}: ${toErrorMessage(error)}`,
        );
      });
    }, idleTimeoutMs);
    timer.unref?.();
    tracked.idleTimer = timer;
  }

  function forgetSession(root: string, session?: LeanSession): void {
    const tracked = sessions.get(root);
    if (!tracked) return;
    if (session && tracked.session !== session) return;
    if (tracked.idleTimer) clearTimeout(tracked.idleTimer);
    sessions.delete(root);
    notifySessionFreed();
  }

  async function disposeSession(
    root: string,
    reason: 'idle' | 'capacity' | 'exhausted' | 'restart' | 'shutdown',
  ): Promise<void> {
    const tracked = sessions.get(root);
    if (!tracked) return;
    if (tracked.disposing) {
      await tracked.disposing;
      return;
    }
    let settleDisposing!: () => void;
    tracked.disposing = new Promise<void>((resolve) => {
      settleDisposing = resolve;
    });
    if (tracked.idleTimer) {
      clearTimeout(tracked.idleTimer);
      tracked.idleTimer = undefined;
    }
    if (reason === 'idle' || reason === 'capacity' || reason === 'exhausted') {
      info(LOG_CHANNEL, `Stopping Lean server at ${root} (${reason})`);
    }
    try {
      await tracked.session.dispose();
    } finally {
      forgetSession(root, tracked.session);
      settleDisposing();
    }
  }

  async function evictIdleSessions(): Promise<void> {
    if (idleTimeoutMs <= 0) return;
    const cutoff = now() - idleTimeoutMs;
    const idleRoots = [...sessions.entries()]
      .filter(
        ([, tracked]) =>
          !tracked.disposing &&
          tracked.inFlight === 0 &&
          tracked.lastUsedAt <= cutoff,
      )
      .map(([root]) => root);
    await Promise.all(idleRoots.map((root) => disposeSession(root, 'idle')));
  }

  function lruRootExcept(exceptRoot: string): string | undefined {
    let oldestRoot: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [root, tracked] of sessions) {
      if (root === exceptRoot || tracked.disposing || tracked.inFlight > 0) {
        continue;
      }
      if (tracked.lastUsedAt < oldestAt) {
        oldestAt = tracked.lastUsedAt;
        oldestRoot = root;
      }
    }
    return oldestRoot;
  }

  async function evictForNewSession(
    newRoot: string,
    generation: number,
  ): Promise<void> {
    await evictIdleSessions();
    if (maxSessions == null) return;
    while (sessions.size >= maxSessions) {
      throwIfStopped(generation);
      const victim = lruRootExcept(newRoot);
      if (victim) {
        await disposeSession(victim, 'capacity');
        continue;
      }
      await waitForSessionFreed();
    }
  }

  /**
   * Stop currently-idle other workspaces after EMFILE/ENFILE, then return so
   * the caller can retry the spawn. Do not wait for busy sessions: position
   * RPCs have no timeout, so one hung hover/goal would stall the start queue.
   */
  async function evictOthersForExhausted(
    exceptRoot: string,
    generation: number,
  ): Promise<void> {
    throwIfStopped(generation);
    const idleOthers = [...sessions.entries()]
      .filter(
        ([key, tracked]) =>
          key !== exceptRoot && !tracked.disposing && tracked.inFlight === 0,
      )
      .map(([key]) => key);
    await Promise.all(
      idleOthers.map((key) => disposeSession(key, 'exhausted')),
    );
  }

  /** Dispose every session and reject starts that have not begun. */
  async function disposeAll(): Promise<void> {
    startGeneration += 1;
    // Abort queued `add()` promises in place. `clear()` would drop them
    // without settling, leaving Lean tool calls pending forever.
    startAbort.abort(new Error(ADAPTER_STOPPED_MESSAGE));
    startAbort = new AbortController();
    notifySessionFreed();
    await Promise.all(
      [...sessions.keys()].map((root) => disposeSession(root, 'shutdown')),
    );
    await waitForStartsIdle();
    await Promise.all(
      [...sessions.keys()].map((root) => disposeSession(root, 'shutdown')),
    );
  }

  function enqueueStart<T>(task: () => Promise<T>): Promise<T> {
    return startQueue.add(
      async () => {
        startsInFlight += 1;
        try {
          return await task();
        } finally {
          startsInFlight -= 1;
          if (startsInFlight === 0) notifyStartsIdle();
        }
      },
      { signal: startAbort.signal },
    ) as Promise<T>;
  }

  function getOrStartSession(
    root: string,
    generation = startGeneration,
  ): Promise<LeanSession> {
    return enqueueStart(() => getOrStartSessionLocked(root, generation));
  }

  async function getOrStartSessionLocked(
    root: string,
    generation: number,
  ): Promise<LeanSession> {
    throwIfStopped(generation);
    const existing = sessions.get(root);
    if (existing?.disposing) {
      await existing.disposing;
      throwIfStopped(generation);
      return getOrStartSessionLocked(root, generation);
    }
    if (existing) {
      return leaseSession(root, existing.session);
    }
    await evictForNewSession(root, generation);
    throwIfStopped(generation);
    try {
      return await startAndLease(root, generation);
    } catch (error) {
      if (!isFileTableExhausted(error) || sessions.size === 0) {
        throw error;
      }
      warn(
        LOG_CHANNEL,
        `Lean spawn hit a full file table; stopping other servers and retrying (${toErrorMessage(error)})`,
      );
      await evictOthersForExhausted(root, generation);
      throwIfStopped(generation);
      return startAndLease(root, generation);
    }
  }

  async function startFreshSession(
    root: string,
    generation: number,
  ): Promise<LeanSession> {
    throwIfStopped(generation);
    const session = new LeanSession({
      workspaceRoot: root,
      lakeCommand,
      onExit: () => {
        const tracked = sessions.get(root);
        if (tracked?.disposing) return;
        forgetSession(root, session);
      },
    });
    sessions.set(root, {
      session,
      lastUsedAt: now(),
      inFlight: 0,
    });
    if (startGeneration !== generation) {
      await disposeSession(root, 'shutdown');
      throw new Error(ADAPTER_STOPPED_MESSAGE);
    }
    try {
      await session.ensureReady();
    } catch (error) {
      await disposeSession(root, 'shutdown');
      throw error;
    }
    if (startGeneration !== generation) {
      await disposeSession(root, 'shutdown');
      throw new Error(ADAPTER_STOPPED_MESSAGE);
    }
    return session;
  }

  async function startAndLease(
    root: string,
    generation: number,
  ): Promise<LeanSession> {
    const session = await startFreshSession(root, generation);
    return leaseSession(root, session);
  }

  function restartSession(root: string): Promise<void> {
    const generation = startGeneration;
    return enqueueStart(async () => {
      throwIfStopped(generation);
      await disposeSession(root, 'restart');
      throwIfStopped(generation);
      await evictForNewSession(root, generation);
      throwIfStopped(generation);
      await startFreshSession(root, generation);
      const tracked = sessions.get(root);
      if (tracked) armIdleTimer(root, tracked);
    });
  }

  return {
    async fetchDiagnosticsForFile(
      file: string,
    ): Promise<FetchDiagnosticsResult> {
      let session: LeanSession;
      try {
        session = await getSession(file);
      } catch (error) {
        // Session start covers both "not a Lake project" and a missing or
        // broken `lake`/`lean` toolchain — report it as toolchain_unavailable
        // so the tool can give actionable setup guidance instead of a generic
        // "could not open file".
        const message = toErrorMessage(error);
        warn(
          LOG_CHANNEL,
          `fetchDiagnosticsForFile: no Lean session for ${file}: ${message}`,
        );
        return { ok: false, kind: 'toolchain_unavailable', message };
      }

      try {
        const diagnostics = await session.fetchDiagnostics(file);
        return { ok: true, diagnostics };
      } catch (error) {
        const message = toErrorMessage(error);
        if (isInterruptedLeanSession(message)) {
          warn(
            LOG_CHANNEL,
            `fetchDiagnosticsForFile: session interrupted for ${file}: ${message}`,
          );
          return { ok: false, kind: 'toolchain_unavailable', message };
        }
        // Opening/reading the file itself failed (e.g. ENOENT) — the file is
        // the problem, so the tool keeps its "could not open file" framing.
        warn(
          LOG_CHANNEL,
          `fetchDiagnosticsForFile: could not read ${file}: ${message}`,
        );
        return { ok: false, kind: 'file_missing', message };
      } finally {
        endUse(session.workspaceRoot, session);
      }
    },

    // No navigateToFirstError here: CLI/desktop have no editor to move the
    // cursor, and the interface declares it an optional host capability so
    // `lean_diagnostics` skips it instead of pretending navigation happened.
    // The tool result still carries the diagnostic list for the agent to act
    // on.

    async executeFileCommand(
      command: LeanFileCommand,
      filePath: string,
    ): Promise<boolean> {
      try {
        // Both file commands have the same effect from our point of view: drop
        // the cached open state and re-open with fresh contents.
        await withSession(filePath, (session) => session.restartFile(filePath));
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
          const acquired: TrackedLeanSession[] = [];
          for (const [root] of [...sessions]) {
            const tracked = beginUse(root);
            if (tracked) acquired.push(tracked);
          }
          try {
            await runForAllSessions(
              new Map(
                acquired.map((tracked) => [
                  tracked.session.workspaceRoot,
                  tracked.session,
                ]),
              ),
              lakeCommand,
              LAKE_PROJECT_ARGS[command],
            );
          } finally {
            for (const tracked of acquired) {
              endUse(tracked.session.workspaceRoot, tracked.session);
            }
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
      const data = await withSession(filePath, invoke);
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

interface TrackedLeanSession {
  session: LeanSession;
  lastUsedAt: number;
  inFlight: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  disposing?: Promise<void>;
}

function isInterruptedLeanSession(message: string): boolean {
  return (
    message.includes('Lean session has been disposed') ||
    message.includes('Lean session is not running') ||
    message.includes(ADAPTER_STOPPED_MESSAGE)
  );
}

function isFileTableExhausted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === 'EMFILE' || code === 'ENFILE') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
