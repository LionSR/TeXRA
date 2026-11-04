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
 * the pool's program plus the interruption conversion documented below; the one run
 * of a tool-facing program sits in the calling tool's `execute()`. The pool
 * itself is a layer the process runtime builds once and closes when the
 * runtime is disposed, which is when the remaining servers stop: every host
 * disposes its runtime after the run ends, so no run is still attributed
 * to a server by then.
 */

import {
  Cause,
  Duration,
  Effect,
  Layer,
  type FileSystem,
  type Path,
} from 'effect';

import { adapterStopped, LeanServerPool } from './leanServerPool';
import {
  LeanLanguageServices,
  type LeanLanguageServicesShape,
} from '../leanLanguageServices';
import {
  LspHoverSchema,
  PlainGoalSchema,
  PlainTermGoalSchema,
  type LeanUnavailable,
  type LspHover,
  type LspResult,
  type PlainGoal,
  type PlainTermGoal,
} from '../leanTypes';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** Long-lived CLI/desktop hosts otherwise keep unused servers forever. */
const LEAN_IDLE_TIMEOUT = Duration.minutes(30);

/**
 * The {@link LeanLanguageServices} port over `lake env lean --server`, for
 * hosts without a VS Code extension bridge (Electron desktop, CLI, the agent
 * package). A composition root hands this layer to `processLayer`,
 * which provides the process's `ChildProcessSpawner` (and the `FileSystem`/
 * `Path` it runs over); the pool it builds acquires no resource of its
 * own, so nothing happens at startup when no Lean tool is invoked, and its
 * servers stop when the process runtime that built it is disposed.
 */
export function directLeanLanguageServices(): Layer.Layer<
  LeanLanguageServices,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  return Layer.effect(
    LeanLanguageServices,
    Effect.map(LeanServerPool, portOverPool),
  ).pipe(
    Layer.provide(
      LeanServerPool.layer({
        lakeCommand: 'lake',
        idleTimeToLive: LEAN_IDLE_TIMEOUT,
      }),
    ),
  );
}

/** Ownership is supplied by the invoking tool and survives fiber scheduling. */
const portOverPool = (
  pool: LeanServerPool['Service'],
): LeanLanguageServicesShape => ({
  listServers: () => pool.listServers(),

  fetchDiagnosticsForFile: (file, runId) =>
    failStopped(pool.fetchDiagnosticsForFile(file, runId)),

  // No navigateToFirstError here: CLI/desktop have no editor to move the
  // cursor, and the interface declares it an optional host capability so
  // `lean_diagnostics` skips it instead of pretending navigation happened.
  // The tool result still carries the diagnostic list for the agent to act
  // on.

  executeFileCommand: (command, filePath, runId) =>
    failStopped(pool.executeFileCommand(filePath, runId)),

  executeProjectCommand: (command, runId) =>
    failStopped(pool.executeProjectCommand(command, runId)),

  getGoalState: (filePath, line, column, runId) =>
    foldStopped(
      pool.positionRequest(
        filePath,
        line,
        column,
        '$/lean/plainGoal',
        PlainGoalSchema,
        runId,
      ),
      stoppedLspResult<PlainGoal>,
    ),

  getTermGoal: (filePath, line, column, runId) =>
    foldStopped(
      pool.positionRequest(
        filePath,
        line,
        column,
        '$/lean/plainTermGoal',
        PlainTermGoalSchema,
        runId,
      ),
      stoppedLspResult<PlainTermGoal>,
    ),

  getHoverInfo: (filePath, line, column, runId) =>
    foldStopped(
      pool.positionRequest(
        filePath,
        line,
        column,
        'textDocument/hover',
        LspHoverSchema,
        runId,
      ),
      stoppedLspResult<LspHover>,
    ),

  // The run-end hook: an interrupted stop is a no-op exactly as the
  // tool-facing conversions are, and any other cause reaches the lifecycle's guard.
  stopSessionsForRun: (runId) =>
    foldStopped(pool.stopSessionsForRun(runId), () => undefined),
});

const stoppedLspResult = <T>(): LspResult<T> => ({
  data: null,
  error: adapterStopped().message,
});

/**
 * Convert an interrupted pool operation into the answer that same call gets
 * after the pool's scope has closed. Closing the scope interrupts an
 * in-flight build and, with it, the fiber awaiting it; interruption is not a
 * failure the pool can convert into its total results, so the conversion happens at
 * this port edge, keeping {@link adapterStopped} the one shape a stopped
 * adapter reports: a value for the calls that answer with one, the
 * `LeanUnavailable` failure for the rest ({@link failStopped}). This is the
 * same conversion the old Promise edge applied at `runPromiseExit`, so a
 * tool-call interruption is converted exactly as it was there.
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

/** {@link foldStopped} for a call whose stopped answer is its failure. */
const failStopped = <A, E>(
  operation: Effect.Effect<A, E>,
): Effect.Effect<A, E | LeanUnavailable> =>
  operation.pipe(
    Effect.catchCause((cause): Effect.Effect<never, E | LeanUnavailable> =>
      Cause.hasInterrupts(cause)
        ? Effect.fail(adapterStopped())
        : Effect.failCause(cause),
    ),
  );
