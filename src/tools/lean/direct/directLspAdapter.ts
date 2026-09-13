/**
 * Direct LSP adapter for Lean tools — used by the CLI and desktop builds.
 *
 * Provides the same {@link LeanLanguageServices} port as the VS Code
 * integration over a {@link LeanServerPool}: the first request that targets
 * a file in a given Lake project spawns `lake env lean --server` from that
 * project root; subsequent requests from any agent reuse the same server.
 * Every agent run that uses a server remains an owner until its run-end hook
 * fires; the server stops after its final owner and final lease are gone. An
 * unused one is otherwise stopped after thirty minutes.
 *
 * The pool's operations are already Effect programs, so each port method is
 * the pool's program plus the interruption fold documented below; the one run
 * of a tool-facing program sits in the calling tool's `execute()`. The pool
 * itself is a layer the process runtime builds once and closes when the
 * runtime is disposed, which is when the remaining servers stop: every host
 * disposes its runtime after run settlement, so no run is still attributed
 * to a server by then.
 */

import { NodeChildProcessSpawner } from '@effect/platform-node';
import {
  Cause,
  Duration,
  Effect,
  Layer,
  type FileSystem,
  type Path,
} from 'effect';

import { LeanAdapterStopped, LeanServerPool } from './leanServerPool';
import {
  LeanLanguageServices,
  type LeanLanguageServicesShape,
} from '../leanLanguageServices';
import type {
  LspHover,
  LspResult,
  PlainGoal,
  PlainTermGoal,
} from '../leanTypes';

/** Long-lived CLI/desktop hosts otherwise keep unused servers forever. */
const DEFAULT_LEAN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface DirectLspLeanAdapterOptions {
  /** Path or name of the `lake` binary (defaults to `lake` on PATH). */
  lakeCommand?: string;
  /** Stop a server after this much idle time. `0` disables idle eviction. */
  idleTimeoutMs?: number;
}

/**
 * The {@link LeanLanguageServices} port over `lake env lean --server`, for
 * hosts without a VS Code extension bridge (Electron desktop, CLI, the agent
 * package). A composition root hands this layer to `installProcessRuntime`,
 * which provides the `FileSystem`/`Path` the spawner validates and resolves a
 * command's `cwd` through; the pool it builds acquires no resource of its
 * own, so nothing happens at startup when no Lean tool is invoked, and its
 * servers stop when the process runtime that built it is disposed.
 */
export function directLeanLanguageServices(
  options: DirectLspLeanAdapterOptions = {},
): Layer.Layer<LeanLanguageServices, never, FileSystem.FileSystem | Path.Path> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_LEAN_IDLE_TIMEOUT_MS;
  return Layer.effect(
    LeanLanguageServices,
    Effect.map(LeanServerPool, portOverPool),
  ).pipe(
    Layer.provide(
      LeanServerPool.layer({
        lakeCommand: options.lakeCommand ?? 'lake',
        idleTimeToLive:
          idleTimeoutMs > 0
            ? Duration.millis(idleTimeoutMs)
            : Duration.infinity,
      }).pipe(
        // The library's Node `ChildProcessSpawner`, over the `FileSystem`
        // and `Path` it validates and resolves a command's `cwd` through:
        // the process runtime provides that pair, so only the spawner is
        // built here.
        Layer.provide(NodeChildProcessSpawner.layer),
      ),
    ),
  );
}

/** Ownership is supplied by the invoking tool and survives fiber scheduling. */
const portOverPool = (
  pool: LeanServerPool['Service'],
): LeanLanguageServicesShape => ({
  fetchDiagnosticsForFile: (file, runId) =>
    foldStopped(pool.fetchDiagnosticsForFile(file, runId), () => ({
      ok: false,
      kind: 'toolchain_unavailable',
      message: STOPPED_MESSAGE,
    })),

  // No navigateToFirstError here: CLI/desktop have no editor to move the
  // cursor, and the interface declares it an optional host capability so
  // `lean_diagnostics` skips it instead of pretending navigation happened.
  // The tool result still carries the diagnostic list for the agent to act
  // on.

  executeFileCommand: (command, filePath, runId) =>
    foldStopped(pool.executeFileCommand(command, filePath, runId), () => false),

  executeProjectCommand: (command, runId) =>
    pool
      .executeProjectCommand(command, runId)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.fail(new LeanAdapterStopped())
            : Effect.failCause(cause),
        ),
      ),

  getGoalState: (filePath, line, column, runId) =>
    foldStopped(
      pool.positionRequest<PlainGoal>(
        filePath,
        line,
        column,
        '$/lean/plainGoal',
        runId,
      ),
      stoppedLspResult<PlainGoal>,
    ),

  getTermGoal: (filePath, line, column, runId) =>
    foldStopped(
      pool.positionRequest<PlainTermGoal>(
        filePath,
        line,
        column,
        '$/lean/plainTermGoal',
        runId,
      ),
      stoppedLspResult<PlainTermGoal>,
    ),

  getHoverInfo: (filePath, line, column, runId) =>
    foldStopped(
      pool.positionRequest<LspHover>(
        filePath,
        line,
        column,
        'textDocument/hover',
        runId,
      ),
      stoppedLspResult<LspHover>,
    ),

  // The run-end hook: an interrupted stop is a no-op exactly as the
  // tool-facing folds are, and any other cause reaches the lifecycle's guard.
  stopSessionsForRun: (runId) =>
    foldStopped(pool.stopSessionsForRun(runId), () => undefined),
});

/** The one message a stopped adapter reports, however the call was stopped. */
const STOPPED_MESSAGE = new LeanAdapterStopped().message;

const stoppedLspResult = <T>(): LspResult<T> => ({
  data: null,
  error: STOPPED_MESSAGE,
});

/**
 * Fold an interrupted pool operation into the value that same call gets
 * after the pool's scope has closed. Closing the scope interrupts an
 * in-flight build and, with it, the fiber awaiting it; interruption is not a
 * failure the pool can fold into its total results, so the fold happens at
 * this port edge, keeping {@link LeanAdapterStopped} the one shape a stopped
 * adapter reports. This is the same fold the old Promise edge applied at
 * `runPromiseExit`, so a tool-call interruption is folded exactly as it was
 * there.
 */
const foldStopped = <A, E>(
  operation: Effect.Effect<A, E>,
  whenStopped: () => A,
): Effect.Effect<A, E> =>
  operation.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.succeed(whenStopped())
        : Effect.failCause(cause),
    ),
  );
