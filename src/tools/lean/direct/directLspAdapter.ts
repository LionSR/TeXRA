/**
 * Direct LSP adapter for Lean tools — used by the CLI and desktop builds.
 *
 * Implements the same {@link LeanLanguageServices} interface as the VS Code
 * integration. Per-workspace sessions are cached: the first request that
 * targets a file in a given Lake project spawns `lake env lean --server`
 * from that project root; subsequent requests from any agent reuse the
 * same session. Every agent run that uses a server remains an owner until its
 * run-end hook fires; the server stops after its final owner and final lease
 * are gone. An unused one is otherwise stopped after thirty minutes. Sessions
 * are also torn down on platform shutdown.
 *
 * Effect inside, Promises at the {@link LeanLanguageServices} edge: starts
 * are serialized under one permit, the idle stop is a detached fiber the
 * tracked session owns (interrupted on use, forget, or dispose), an
 * in-progress disposal is a `Deferred` later callers join, and a stop
 * (`stop_server`, shutdown) invalidates every queued start by generation.
 */

// Node imports
import { access } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Result,
  Semaphore,
} from 'effect';

// Local imports
import {
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { info, warn } from '@logger/logUtils';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import type { ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { runLakeCommand } from './lakeCommands';
import { LeanSession, type LeanSessionError } from './leanSession';
import {
  setLeanLanguageServices,
  type LeanLanguageServices,
} from '../leanLanguageServices';
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

/** A stop (`stop_server` or shutdown) superseded the start this call queued. */
class LeanAdapterStopped extends Data.TaggedError('LeanAdapterStopped') {
  override readonly message = 'Lean adapter was stopped.';
}

/** No `lakefile.lean` / `lakefile.toml` above the file. */
class LeanProjectNotFound extends Data.TaggedError('LeanProjectNotFound')<{
  readonly message: string;
}> {}

/** A project command could not run or reported failure. */
class LeanProjectCommandError extends Data.TaggedError(
  'LeanProjectCommandError',
)<{ readonly message: string }> {}

type DisposeReason = 'idle' | 'exhausted' | 'restart' | 'run-end' | 'shutdown';

export interface DirectLspLeanAdapterOptions {
  /** Path or name of the `lake` binary (defaults to `lake` on PATH). */
  lakeCommand?: string;
  /** Stop a session after this much idle time. `0` disables idle eviction. */
  idleTimeoutMs?: number;
  /** Clock for idle decisions (tests). */
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
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_LEAN_IDLE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, TrackedLeanSession>();
  const starts = Semaphore.makeUnsafe(1);
  let startGeneration = 0;

  /** Fails once a stop has moved the generation past the one a call captured. */
  const stoppedUnless = (
    generation: number,
  ): Effect.Effect<void, LeanAdapterStopped> =>
    startGeneration === generation
      ? Effect.void
      : Effect.fail(new LeanAdapterStopped());

  const getSession = Effect.fn('DirectLspAdapter.getSession')(function* (
    filePath: string,
    runId: ExecutionId | undefined,
  ) {
    const generation = startGeneration;
    const absolute = path.resolve(filePath);
    const root = yield* resolveWorkspaceRoot(absolute);
    yield* stoppedUnless(generation);
    if (!root) {
      return yield* new LeanProjectNotFound({
        message: `No Lean project found for ${absolute}. Lake projects need a lakefile.lean or lakefile.toml in an ancestor directory.`,
      });
    }
    return yield* starts.withPermit(
      getOrStartSessionLocked(root, generation, runId),
    );
  });

  // Uninterruptible: the lease is one step. Disarming awaits the idle fiber,
  // and an interruption landing there would leave `inFlight` incremented
  // with no `endUse` to match it, so the session could never be idle-evicted
  // or stopped at run end. Interrupting the idle fiber from inside this
  // region is fine; only this fiber is shielded.
  const beginUse = Effect.fn('DirectLspAdapter.beginUse')(function* (
    root: string,
  ) {
    const tracked = sessions.get(root);
    if (!tracked || tracked.disposing) return undefined;
    tracked.inFlight += 1;
    tracked.lastUsedAt = now();
    yield* disarmIdleStop(tracked);
    return tracked;
  }, Effect.uninterruptible);

  const endUse = Effect.fn('DirectLspAdapter.endUse')(function* (
    root: string,
    session: LeanSession,
  ) {
    const tracked = sessions.get(root);
    if (!tracked || tracked.session !== session) return;
    tracked.inFlight = Math.max(0, tracked.inFlight - 1);
    if (tracked.inFlight > 0) return;
    tracked.lastUsedAt = now();
    if (tracked.stopWhenIdle) {
      yield* disposeSession(root, 'run-end');
      return;
    }
    yield* armIdleStop(root, tracked);
  });

  function registerSessionOwner(
    tracked: TrackedLeanSession,
    runId?: ExecutionId,
  ): void {
    if (runId === undefined || tracked.ownerRunIds.has(runId)) return;
    tracked.ownerRunIds.add(runId);
    // A new live owner supersedes a deferred stop requested after the previous
    // final owner ended. Its own run-end hook will mark the session again.
    tracked.stopWhenIdle = false;
  }

  const leaseSession = Effect.fn('DirectLspAdapter.leaseSession')(function* (
    root: string,
    session: LeanSession,
  ) {
    if (!(yield* beginUse(root))) return yield* new LeanAdapterStopped();
    return yield* session.ready().pipe(
      Effect.onError(() => endUse(root, session)),
      Effect.as(session),
    );
  });

  const withSession = Effect.fn('DirectLspAdapter.withSession')(function* <
    A,
    E,
  >(
    filePath: string,
    runId: ExecutionId | undefined,
    invoke: (session: LeanSession) => Effect.Effect<A, E>,
  ) {
    const session = yield* getSession(filePath, runId);
    return yield* invoke(session).pipe(
      Effect.ensuring(endUse(session.workspaceRoot, session)),
    );
  });

  const disarmIdleStop = Effect.fn('DirectLspAdapter.disarmIdleStop')(
    function* (tracked: TrackedLeanSession) {
      const idleStop = tracked.idleStop;
      if (!idleStop) return;
      tracked.idleStop = undefined;
      yield* Fiber.interrupt(idleStop);
    },
  );

  const armIdleStop = Effect.fn('DirectLspAdapter.armIdleStop')(function* (
    root: string,
    tracked: TrackedLeanSession,
  ) {
    yield* disarmIdleStop(tracked);
    if (idleTimeoutMs <= 0 || tracked.inFlight > 0) return;
    // Detached: the stop must outlive the tool call that armed it. Its owner
    // is the tracked entry, which interrupts it on use, forget, or dispose.
    // The fiber drops its own handle before stopping so the disposal never
    // interrupts the fiber it runs on. Nothing joins a detached fiber, so a
    // defect (the stop cannot fail) is logged here or it is lost.
    tracked.idleStop = yield* Effect.forkDetach(
      Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            tracked.idleStop = undefined;
            return disposeSession(root, 'idle');
          }),
        ),
        Effect.tapDefect((defect) =>
          Effect.sync(() => {
            warn(
              LOG_CHANNEL,
              `Idle stop of the Lean server at ${root} died: ${toErrorMessage(defect)}`,
              { data: defect },
            );
          }),
        ),
      ),
    );
  });

  const forgetSession = Effect.fn('DirectLspAdapter.forgetSession')(function* (
    root: string,
    session: LeanSession,
  ) {
    const tracked = sessions.get(root);
    if (!tracked || tracked.session !== session) return;
    yield* disarmIdleStop(tracked);
    sessions.delete(root);
  });

  const disposeSession = Effect.fn('DirectLspAdapter.disposeSession')(
    function* (root: string, reason: DisposeReason) {
      const tracked = sessions.get(root);
      if (!tracked) return;
      if (tracked.disposing) {
        yield* Deferred.await(tracked.disposing);
        return;
      }
      const disposing = Deferred.makeUnsafe<void>();
      // Runs to completion once begun, like close(): from the moment the
      // entry is marked disposing until the latch settles, no interruption
      // can land, and the registry entry and the latch are released on every
      // exit. An entry left marked disposing with an unsettled latch would
      // make every later start for this root wait forever under the permit.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          tracked.disposing = disposing;
          yield* disarmIdleStop(tracked);
          // 'restart' and 'shutdown' stops are caller-initiated and already
          // logged.
          if (reason !== 'restart' && reason !== 'shutdown') {
            info(LOG_CHANNEL, `Stopping Lean server at ${root} (${reason})`);
          }
          yield* tracked.session.close();
        }).pipe(
          Effect.ensuring(
            forgetSession(root, tracked.session).pipe(
              Effect.andThen(Deferred.succeed(disposing, undefined)),
            ),
          ),
        ),
      );
    },
  );

  const disposeSessions = (reason: DisposeReason, roots: Iterable<string>) =>
    Effect.forEach(roots, (root) => disposeSession(root, reason), {
      concurrency: 'unbounded',
      discard: true,
    });

  /**
   * Run-end hook: release the ended run's ownership of every server it used.
   * A shared server survives while another run still owns it. If the final
   * owner ends during an in-flight request, disposal waits for the final lease.
   * Sessions started outside any run have no owners and use the idle timeout.
   */
  const stopSessionsForRun = Effect.fn('DirectLspAdapter.stopSessionsForRun')(
    function* (runId: ExecutionId) {
      const roots: string[] = [];
      for (const [root, tracked] of sessions) {
        if (tracked.disposing || !tracked.ownerRunIds.delete(runId)) continue;
        if (tracked.ownerRunIds.size > 0) continue;
        if (tracked.inFlight > 0) {
          tracked.stopWhenIdle = true;
        } else {
          roots.push(root);
        }
      }
      yield* disposeSessions('run-end', roots);
    },
  );

  const evictIdleSessions = Effect.fn('DirectLspAdapter.evictIdleSessions')(
    function* () {
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
      yield* disposeSessions('idle', idleRoots);
    },
  );

  /**
   * Stop currently-idle other workspaces after EMFILE/ENFILE, then return so
   * the caller can retry the spawn. Await sessions already shutting down so
   * their descriptors are gone first. Do not wait for busy sessions: position
   * RPCs have no timeout, so one hung hover/goal would stall the start queue.
   */
  const evictOthersForExhausted = Effect.fn(
    'DirectLspAdapter.evictOthersForExhausted',
  )(function* (exceptRoot: string, generation: number) {
    yield* stoppedUnless(generation);
    const idleOthers: string[] = [];
    const alreadyDisposing: Array<Deferred.Deferred<void>> = [];
    for (const [key, tracked] of sessions) {
      if (key === exceptRoot) continue;
      if (tracked.disposing) {
        alreadyDisposing.push(tracked.disposing);
        continue;
      }
      if (tracked.inFlight === 0) idleOthers.push(key);
    }
    yield* Effect.all(
      [
        disposeSessions('exhausted', idleOthers),
        ...alreadyDisposing.map((disposing) => Deferred.await(disposing)),
      ],
      { concurrency: 'unbounded', discard: true },
    );
  });

  /**
   * Dispose every session and fail starts that have not begun: they observe
   * the new generation once they hold the permit, so holding it here means
   * every start has drained and the second pass catches any it readied.
   */
  const disposeAll = Effect.fn('DirectLspAdapter.disposeAll')(function* () {
    startGeneration += 1;
    yield* disposeSessions('shutdown', [...sessions.keys()]);
    yield* starts.withPermit(
      Effect.suspend(() => disposeSessions('shutdown', [...sessions.keys()])),
    );
  });

  const getOrStartSessionLocked = Effect.fn(
    'DirectLspAdapter.getOrStartSessionLocked',
  )(function* (
    root: string,
    generation: number,
    runId: ExecutionId | undefined,
  ) {
    yield* stoppedUnless(generation);
    let existing = sessions.get(root);
    while (existing?.disposing) {
      yield* Deferred.await(existing.disposing);
      yield* stoppedUnless(generation);
      existing = sessions.get(root);
    }
    if (existing) {
      // Register before the readiness wait so a concurrent run-end hook sees
      // this owner. Reusers join the owner set rather than displacing a parent
      // or sibling that may use the shared-worktree server again.
      registerSessionOwner(existing, runId);
      return yield* leaseSession(root, existing.session);
    }
    yield* evictIdleSessions();
    yield* stoppedUnless(generation);
    return yield* startAndLease(root, generation, runId).pipe(
      Effect.catchIf(
        (error) => isFileTableExhausted(error) && sessions.size > 0,
        (error) =>
          Effect.gen(function* () {
            warn(
              LOG_CHANNEL,
              `Lean spawn hit a full file table; stopping other servers and retrying (${toErrorMessage(error)})`,
            );
            yield* evictOthersForExhausted(root, generation);
            yield* stoppedUnless(generation);
            return yield* startAndLease(root, generation, runId);
          }),
      ),
    );
  });

  const startFreshSession = Effect.fn('DirectLspAdapter.startFreshSession')(
    function* (
      root: string,
      generation: number,
      runId: ExecutionId | undefined,
    ) {
      yield* stoppedUnless(generation);
      const session: LeanSession = new LeanSession({
        workspaceRoot: root,
        lakeCommand,
        onExit: () =>
          Effect.suspend(() => {
            const tracked = sessions.get(root);
            if (tracked?.disposing) return Effect.void;
            return forgetSession(root, session);
          }),
      });
      sessions.set(root, {
        session,
        lastUsedAt: now(),
        inFlight: 0,
        ownerRunIds: new Set(runId === undefined ? [] : [runId]),
      });
      // Re-check after readiness: a concurrent disposeAll must not leave a
      // freshly readied session behind. Any failure here (including this
      // stop) tears the just-tracked session down again.
      return yield* Effect.gen(function* () {
        yield* session.ready();
        yield* stoppedUnless(generation);
        return session;
      }).pipe(Effect.onError(() => disposeSession(root, 'shutdown')));
    },
  );

  const startAndLease = Effect.fn('DirectLspAdapter.startAndLease')(function* (
    root: string,
    generation: number,
    runId: ExecutionId | undefined,
  ) {
    const session = yield* startFreshSession(root, generation, runId);
    return yield* leaseSession(root, session);
  });

  const restartSession = Effect.fn('DirectLspAdapter.restartSession')(
    function* (root: string, runId: ExecutionId | undefined) {
      const generation = startGeneration;
      yield* starts.withPermit(
        Effect.gen(function* () {
          yield* stoppedUnless(generation);
          yield* disposeSession(root, 'restart');
          yield* stoppedUnless(generation);
          yield* evictIdleSessions();
          yield* stoppedUnless(generation);
          yield* startFreshSession(root, generation, runId);
          const tracked = sessions.get(root);
          if (tracked) yield* armIdleStop(root, tracked);
        }),
      );
    },
  );

  const fetchDiagnosticsForFile = Effect.fn(
    'DirectLspAdapter.fetchDiagnosticsForFile',
  )(function* (file: string, runId: ExecutionId | undefined) {
    const started = yield* Effect.result(getSession(file, runId));
    if (Result.isFailure(started)) {
      // Session start covers both "not a Lake project" and a missing or
      // broken `lake`/`lean` toolchain — report it as toolchain_unavailable
      // so the tool can give actionable setup guidance instead of a generic
      // "could not open file".
      const message = toErrorMessage(started.failure);
      warn(
        LOG_CHANNEL,
        `fetchDiagnosticsForFile: no Lean session for ${file}: ${message}`,
      );
      const result: FetchDiagnosticsResult = {
        ok: false,
        kind: 'toolchain_unavailable',
        message,
      };
      return result;
    }
    const session = started.success;
    return yield* session.diagnostics(file).pipe(
      Effect.map((diagnostics): FetchDiagnosticsResult => ({
        ok: true,
        diagnostics,
      })),
      Effect.catchTag(
        ['LeanSessionDisposed', 'LeanSessionNotRunning'],
        (error): Effect.Effect<FetchDiagnosticsResult> => {
          const message = toErrorMessage(error);
          warn(
            LOG_CHANNEL,
            `fetchDiagnosticsForFile: session interrupted for ${file}: ${message}`,
          );
          return Effect.succeed({
            ok: false,
            kind: 'toolchain_unavailable',
            message,
          });
        },
      ),
      Effect.catch((error): Effect.Effect<FetchDiagnosticsResult> => {
        // Opening/reading the file itself failed (e.g. ENOENT) — the file is
        // the problem, so the tool keeps its "could not open file" framing.
        const message = toErrorMessage(error);
        warn(
          LOG_CHANNEL,
          `fetchDiagnosticsForFile: could not read ${file}: ${message}`,
        );
        return Effect.succeed({ ok: false, kind: 'file_missing', message });
      }),
      Effect.ensuring(endUse(session.workspaceRoot, session)),
    );
  });

  const executeFileCommand = Effect.fn('DirectLspAdapter.executeFileCommand')(
    function* (
      command: LeanFileCommand,
      filePath: string,
      runId: ExecutionId | undefined,
    ) {
      // Both file commands have the same effect from our point of view: drop
      // the cached open state and re-open with fresh contents.
      return yield* withSession(filePath, runId, (session) =>
        session.restartFile(filePath),
      ).pipe(
        Effect.as(true),
        // Return false (LeanFileTool surfaces it as a failure result) and log
        // the cause. Honors the `Promise<boolean>` contract so a missing/broken
        // `lake` doesn't throw out of the JSON-RPC path.
        Effect.catch((error) =>
          Effect.sync(() => {
            warn(
              LOG_CHANNEL,
              `executeFileCommand(${command}) failed for ${filePath}: ${toErrorMessage(error)}`,
            );
            return false;
          }),
        ),
      );
    },
  );

  const executeProjectCommand = Effect.fn(
    'DirectLspAdapter.executeProjectCommand',
  )(function* (command: LeanProjectCommand, runId: ExecutionId | undefined) {
    // Project commands aren't tied to a file. We apply to every active
    // session; lake commands serialize per workspace via the mutex.
    switch (command) {
      case 'restart_server': {
        const roots = [...sessions.keys()];
        if (roots.length === 0) {
          return yield* new LeanProjectCommandError({
            message: 'No Lean server running to restart.',
          });
        }
        // Every root gets its restart attempt: a failing respawn must not
        // interrupt a sibling's queued restart. The first failure is
        // reported once all have settled.
        const restarts = yield* Effect.forEach(
          roots,
          (root) => Effect.result(restartSession(root, runId)),
          { concurrency: 'unbounded' },
        );
        const failed = restarts.find(Result.isFailure);
        if (failed) return yield* Effect.fail(failed.failure);
        return;
      }
      case 'stop_server':
        yield* disposeAll();
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
          const tracked = yield* beginUse(root);
          if (tracked) {
            registerSessionOwner(tracked, runId);
            acquired.push(tracked);
          }
        }
        yield* runForAllSessions(
          acquired.map((tracked) => tracked.session),
          lakeCommand,
          LAKE_PROJECT_ARGS[command],
        ).pipe(
          Effect.ensuring(
            Effect.forEach(
              acquired,
              (tracked) =>
                endUse(tracked.session.workspaceRoot, tracked.session),
              { concurrency: 'unbounded', discard: true },
            ),
          ),
        );
        return;
      }
      case 'install_elan':
      case 'install_deps':
      case 'update_elan':
      case 'select_toolchain':
        return yield* new LeanProjectCommandError({
          message:
            `Command "${command}" is only available inside VS Code with the leanprover.lean4 extension. ` +
            'In CLI/desktop builds, run the matching shell command directly (see https://leanprover-community.github.io/install/linux.html).',
        });
    }
  });

  const positionRequest = Effect.fn('DirectLspAdapter.positionRequest')(
    function* <T>(
      filePath: string,
      line: number,
      column: number,
      method: string,
      runId: ExecutionId | undefined,
    ) {
      return yield* withSession(filePath, runId, (session) =>
        session.requestSettled<T | null>(filePath, line, column, method),
      ).pipe(
        Effect.map((data): LspResult<T> =>
          data
            ? { data }
            : { data: null, error: 'Lean returned no data for this position.' },
        ),
        Effect.catch((error) =>
          Effect.succeed<LspResult<T>>({
            data: null,
            error: toErrorMessage(error),
          }),
        ),
      );
    },
  );

  // The Promise edge: one run per public entry. The run is captured here,
  // before the fiber starts, because the ambient run context is a property
  // of the calling turn, not of the scheduler the fiber resumes on.
  return {
    fetchDiagnosticsForFile: (file) =>
      effectRuntime().runPromise(fetchDiagnosticsForFile(file, currentRunId())),

    // No navigateToFirstError here: CLI/desktop have no editor to move the
    // cursor, and the interface declares it an optional host capability so
    // `lean_diagnostics` skips it instead of pretending navigation happened.
    // The tool result still carries the diagnostic list for the agent to act
    // on.

    executeFileCommand: (command, filePath) =>
      effectRuntime().runPromise(
        executeFileCommand(command, filePath, currentRunId()),
      ),

    executeProjectCommand: (command) =>
      effectRuntime().runPromise(
        executeProjectCommand(command, currentRunId()),
      ),

    getGoalState: (filePath, line, column) =>
      effectRuntime().runPromise(
        positionRequest<PlainGoal>(
          filePath,
          line,
          column,
          '$/lean/plainGoal',
          currentRunId(),
        ),
      ),

    getTermGoal: (filePath, line, column) =>
      effectRuntime().runPromise(
        positionRequest<PlainTermGoal>(
          filePath,
          line,
          column,
          '$/lean/plainTermGoal',
          currentRunId(),
        ),
      ),

    getHoverInfo: (filePath, line, column) =>
      effectRuntime().runPromise(
        positionRequest<LspHover>(
          filePath,
          line,
          column,
          'textDocument/hover',
          currentRunId(),
        ),
      ),

    stopSessionsForRun: (runId) =>
      effectRuntime().runPromise(stopSessionsForRun(runId)),

    dispose: () => effectRuntime().runPromise(disposeAll()),
  };
}

interface TrackedLeanSession {
  session: LeanSession;
  lastUsedAt: number;
  inFlight: number;
  /** Runs that used this shared server and have not reached run end yet. */
  ownerRunIds: Set<ExecutionId>;
  /** Final owner ended while a request was still leased. */
  stopWhenIdle?: boolean;
  /** The armed idle stop; interrupted on use, forget, or dispose. */
  idleStop?: Fiber.Fiber<void>;
  /** Settles when an in-progress disposal has fully released the session. */
  disposing?: Deferred.Deferred<void>;
}

/** The agent run the current tool call executes for, when it runs inside one. */
function currentRunId(): ExecutionId | undefined {
  return getRunContextExecutionId(tryUseRunContext());
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

const runForAllSessions = Effect.fn('DirectLspAdapter.runForAllSessions')(
  function* (
    activeSessions: LeanSession[],
    lakeCommand: string,
    args: readonly string[],
  ) {
    if (activeSessions.length === 0) {
      return yield* new LeanProjectCommandError({
        message: `No Lean project session active. Run a Lean tool against a file in your project first, then retry "${args.join(' ')}".`,
      });
    }
    // `runLakeCommand` resolves with the exit code, never rejects on it.
    const results = yield* Effect.forEach(
      activeSessions,
      (session) =>
        Effect.promise(() =>
          runLakeCommand({
            workspaceRoot: session.workspaceRoot,
            lakeCommand,
            args,
            serialize: true,
          }),
        ),
      { concurrency: 'unbounded' },
    );
    const failed = results.filter((r) => r.exitCode !== 0);
    if (failed.length > 0) {
      return yield* new LeanProjectCommandError({
        message: `lake ${args.join(' ')} failed in ${failed.length} workspace(s):\n${failed
          .map((r) => r.stderr.trim() || r.stdout.trim())
          .join('\n---\n')}`,
      });
    }
  },
);

// Uses fs/promises directly — must not call platform() because this runs
// before initPlatform() during early startup / test harness setup.
const pathExists = (target: string): Effect.Effect<boolean> =>
  Effect.isSuccess(Effect.tryPromise(() => access(target)));

/** Walk up from `filePath` looking for a Lake project root. */
const resolveWorkspaceRoot = Effect.fn('DirectLspAdapter.resolveWorkspaceRoot')(
  function* (filePath: string) {
    let dir = path.dirname(path.resolve(filePath));
    const root = path.parse(dir).root;
    for (;;) {
      if (
        (yield* pathExists(path.join(dir, 'lakefile.lean'))) ||
        (yield* pathExists(path.join(dir, 'lakefile.toml')))
      ) {
        return dir;
      }
      if (dir === root) return null;
      dir = path.dirname(dir);
    }
  },
);

/** Walk up from `filePath` looking for a Lake project root. */
export function defaultResolveWorkspaceRoot(
  filePath: string,
): Promise<string | null> {
  return effectRuntime().runPromise(resolveWorkspaceRoot(filePath));
}
