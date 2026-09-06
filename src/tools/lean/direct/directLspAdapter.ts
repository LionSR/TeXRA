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
 * This file is the Promise edge: the pool is built once into the adapter's
 * scope, every method is one `runPromise` of the pool's Effect, and
 * `dispose()` closes the scope, which ends the pool and every server.
 */

import { Context, Duration, Effect, Exit, Layer, Scope } from 'effect';

import {
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { nodeChildProcessSpawnerLayer } from '@platform/defaults/nodeChildProcessSpawner';
import type { ExecutionId } from '@shared/schemas';

import { LeanServerPool, resolveWorkspaceRoot } from './leanServerPool';
import {
  setLeanLanguageServices,
  type LeanLanguageServices,
} from '../leanLanguageServices';
import type { LspHover, PlainGoal, PlainTermGoal } from '../leanTypes';

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
 * `setLeanLanguageServices(...)` during platform startup.
 */
export function createDirectLspLeanAdapter(
  options: DirectLspLeanAdapterOptions = {},
): LeanLanguageServices & { dispose(): Promise<void> } {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_LEAN_IDLE_TIMEOUT_MS;
  const scope = Scope.makeUnsafe();
  // Building the pool acquires no resource of its own (the map is empty
  // until first use), so the build is synchronous and the run boundary here
  // is the constructor's; every operation below is one `runPromise`.
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

  // The run is captured here, before the fiber starts, because the ambient
  // run context is a property of the calling turn, not of the scheduler the
  // fiber resumes on.
  return {
    fetchDiagnosticsForFile: (file) =>
      effectRuntime().runPromise(
        pool.fetchDiagnosticsForFile(file, currentRunId()),
      ),

    // No navigateToFirstError here: CLI/desktop have no editor to move the
    // cursor, and the interface declares it an optional host capability so
    // `lean_diagnostics` skips it instead of pretending navigation happened.
    // The tool result still carries the diagnostic list for the agent to act
    // on.

    executeFileCommand: (command, filePath) =>
      effectRuntime().runPromise(
        pool.executeFileCommand(command, filePath, currentRunId()),
      ),

    executeProjectCommand: (command) =>
      effectRuntime().runPromise(
        pool.executeProjectCommand(command, currentRunId()),
      ),

    getGoalState: (filePath, line, column) =>
      effectRuntime().runPromise(
        pool.positionRequest<PlainGoal>(
          filePath,
          line,
          column,
          '$/lean/plainGoal',
          currentRunId(),
        ),
      ),

    getTermGoal: (filePath, line, column) =>
      effectRuntime().runPromise(
        pool.positionRequest<PlainTermGoal>(
          filePath,
          line,
          column,
          '$/lean/plainTermGoal',
          currentRunId(),
        ),
      ),

    getHoverInfo: (filePath, line, column) =>
      effectRuntime().runPromise(
        pool.positionRequest<LspHover>(
          filePath,
          line,
          column,
          'textDocument/hover',
          currentRunId(),
        ),
      ),

    stopSessionsForRun: (runId) =>
      effectRuntime().runPromise(pool.stopSessionsForRun(runId)),

    dispose: () => effectRuntime().runPromise(Scope.close(scope, Exit.void)),
  };
}

/** The agent run the current tool call executes for, when it runs inside one. */
function currentRunId(): ExecutionId | undefined {
  return getRunContextExecutionId(tryUseRunContext());
}

/** Walk up from `filePath` looking for a Lake project root. */
export function defaultResolveWorkspaceRoot(
  filePath: string,
): Promise<string | null> {
  return effectRuntime().runPromise(resolveWorkspaceRoot(filePath));
}
