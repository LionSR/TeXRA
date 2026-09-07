/**
 * Direct LSP adapter for Lean tools — used by the CLI and desktop builds.
 *
 * Implements the same {@link LeanLanguageServices} interface as the VS Code
 * integration over a {@link LeanServerPool}: the first request that targets
 * a file in a given Lake project spawns `lake env lean --server` from that
 * project root; subsequent requests from any agent reuse the same server.
 * Every agent run that uses a server remains an owner until its run-end hook
 * fires; the server stops after its final owner and final lease are gone. An
 * unused one is otherwise stopped after thirty minutes. Servers are also torn
 * down on platform shutdown.
 *
 * The pool's operations are already Effect programs, so each port method is
 * the pool's program plus the interruption fold documented below; the one run
 * of a tool-facing program sits in the calling tool's `execute()`. The runs
 * left in this file are the construction of the pool into the adapter's scope
 * and its disposal, which belong to the platform-lifetime seam (lane D:
 * platform ports become Effect-typed), and the run-end hook's Promise seam,
 * which converts with its only caller there.
 */

import { Cause, Context, Duration, Effect, Exit, Layer, Scope } from 'effect';

import {
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { nodeChildProcessSpawnerLayer } from '@platform/defaults/nodeChildProcessSpawner';
import type { ExecutionId } from '@shared/schemas';

import { LeanAdapterStopped, LeanServerPool } from './leanServerPool';
import {
  setLeanLanguageServices,
  type LeanLanguageServices,
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
  /**
   * @deprecated Superseded by the runtime `Clock`: idle eviction runs on the
   * pool's clock and tests drive a `TestClock`. Kept for signature parity;
   * never read.
   */
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
 * `setLeanLanguageServices(...)` during platform startup, after
 * `installProcessRuntime(...)`: the pool's layer graph is built into the
 * adapter's scope here, on the process runtime.
 */
export function createDirectLspLeanAdapter(
  options: DirectLspLeanAdapterOptions = {},
): LeanLanguageServices & { dispose(): Promise<void> } {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_LEAN_IDLE_TIMEOUT_MS;
  const scope = Scope.makeUnsafe();
  // Building the pool acquires no resource of its own (the map is empty
  // until first use), so the build is synchronous and the run boundary here
  // is the constructor's.
  const pool = effectRuntime().runSync(
    Layer.build(
      LeanServerPool.layer({
        lakeCommand: options.lakeCommand ?? 'lake',
        idleTimeToLive:
          idleTimeoutMs > 0
            ? Duration.millis(idleTimeoutMs)
            : Duration.infinity,
      }).pipe(Layer.provide(nodeChildProcessSpawnerLayer)),
    ).pipe(
      Scope.provide(scope),
      Effect.map((context) => Context.get(context, LeanServerPool)),
    ),
  );

  // The run id is captured when the method is called, before any fiber
  // starts, because the ambient run context is a property of the calling
  // turn, not of the scheduler the fiber resumes on.
  return {
    fetchDiagnosticsForFile: (file) =>
      foldStopped(pool.fetchDiagnosticsForFile(file, currentRunId()), () => ({
        ok: false,
        kind: 'toolchain_unavailable',
        message: STOPPED_MESSAGE,
      })),

    // No navigateToFirstError here: CLI/desktop have no editor to move the
    // cursor, and the interface declares it an optional host capability so
    // `lean_diagnostics` skips it instead of pretending navigation happened.
    // The tool result still carries the diagnostic list for the agent to act
    // on.

    executeFileCommand: (command, filePath) =>
      foldStopped(
        pool.executeFileCommand(command, filePath, currentRunId()),
        () => false,
      ),

    executeProjectCommand: (command) =>
      pool
        .executeProjectCommand(command, currentRunId())
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.fail(new LeanAdapterStopped())
              : Effect.failCause(cause),
          ),
        ),

    getGoalState: (filePath, line, column) =>
      foldStopped(
        pool.positionRequest<PlainGoal>(
          filePath,
          line,
          column,
          '$/lean/plainGoal',
          currentRunId(),
        ),
        stoppedLspResult<PlainGoal>,
      ),

    getTermGoal: (filePath, line, column) =>
      foldStopped(
        pool.positionRequest<PlainTermGoal>(
          filePath,
          line,
          column,
          '$/lean/plainTermGoal',
          currentRunId(),
        ),
        stoppedLspResult<PlainTermGoal>,
      ),

    getHoverInfo: (filePath, line, column) =>
      foldStopped(
        pool.positionRequest<LspHover>(
          filePath,
          line,
          column,
          'textDocument/hover',
          currentRunId(),
        ),
        stoppedLspResult<LspHover>,
      ),

    // Promise seam of the run-end hook (see the interface): one run, folding
    // an interrupted stop into a no-op exactly as the tool-facing folds do.
    stopSessionsForRun: (runId) =>
      effectRuntime()
        .runPromiseExit(pool.stopSessionsForRun(runId))
        .then((exit) => {
          if (Exit.isSuccess(exit)) return;
          if (Cause.hasInterrupts(exit.cause)) return;
          throw Cause.squash(exit.cause);
        }),

    dispose: () => effectRuntime().runPromise(Scope.close(scope, Exit.void)),
  };
}

/** The one message a stopped adapter reports, however the call was stopped. */
const STOPPED_MESSAGE = new LeanAdapterStopped().message;

const stoppedLspResult = <T>(): LspResult<T> => ({
  data: null,
  error: STOPPED_MESSAGE,
});

/**
 * Fold an interrupted pool operation into the value that same call gets
 * after `dispose()` has returned. `dispose()` closes the pool's scope, which
 * interrupts an in-flight build and, with it, the fiber awaiting it;
 * interruption is not a failure the pool can fold into its total results, so
 * the fold happens at this port edge, keeping {@link LeanAdapterStopped} the
 * one shape a stopped adapter reports. This is the same fold the old Promise
 * edge applied at `runPromiseExit`, so a tool-call interruption is folded
 * exactly as it was there.
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

/** The agent run the current tool call executes for, when it runs inside one. */
function currentRunId(): ExecutionId | undefined {
  return getRunContextExecutionId(tryUseRunContext());
}
