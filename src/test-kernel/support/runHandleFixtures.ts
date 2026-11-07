import { Effect, Fiber, FiberSet, type Scope, SubscriptionRef } from 'effect';

// Local imports
import {
  registryOf,
  RunRegistry,
  type RunPrograms,
  type RunRegistryInit,
  type AgentRunServices,
} from '@agent/runtime/runRegistry';
import type { RunsShape } from '@agent/runtime/runs';
import type { RunServices } from '@agent/runtime/ToolServices';
import { emptySessionView } from '@shared/session/sessionView';
import type { RunId } from '@shared/schemas';
import { testWorkspaceRoots } from './testWorkspaceRoots';

/** A registry's launch door over the calling fiber's process services,
 *  standing in for the session context the session layer forks runs from:
 *  the runs it starts end with the calling scope, as a session's end with
 *  the session. */
export const testRunFork: Effect.Effect<
  RunRegistryInit['fork'],
  never,
  RunServices | Scope.Scope
> = Effect.map(
  FiberSet.makeRuntime<RunServices>(),
  // A test registry stands for no session, so what it starts reads none of
  // a session's services.
  (fork): RunRegistryInit['fork'] =>
    (_runId, effect) =>
      // cast: nothing the runtime starts asks for a session service.
      fork(effect as Effect.Effect<never, never, RunServices>),
);

/** A test registry's launches open on the calling fiber, which stands for
 *  the session ({@link testRunFork}). */
// cast: nothing a test registry opens asks for a session service.
export const testRunInSession = ((effect) =>
  effect) as RunRegistryInit['inSession'];

/** A registry over an empty fold: no run has a view, which is what a
 *  fixture that never publishes a phase-moving row would see. */
export const testRunRegistry: Effect.Effect<
  RunRegistry,
  never,
  RunServices | Scope.Scope
> = Effect.zipWith(
  testRunFork,
  // The empty fold the registry reads its grants from.
  SubscriptionRef.make(emptySessionView('test-run-registry')),
  (fork, emptyView) =>
    // The registry reads its session's view (empty here) and its own
    // `run.detach` batches (dropped); nothing else.
    new RunRegistry({
      // cast: the registry reads only these members of its view.
      view: {
        run: () => undefined,
        ref: emptyView,
      } as unknown as RunRegistryInit['view'],
      // cast: the registry reads only these members of its log.
      log: {
        transact: () => Effect.succeed([]),
      } as unknown as RunRegistryInit['log'],
      runsHere: () => {},
      roots: testWorkspaceRoots(),
      inSession: testRunInSession,
      fork,
      programs: testRunPrograms,
      wake: () => {},
    }),
);

/** The run programs a test registry runs: the production ones, each read
 *  per call so a suite's own mock of its module is the program it reaches. */
export const testRunPrograms: RunPrograms = {
  executeAgent: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/runtime/executeAgent')),
      (module) => module.executeAgent(...args),
    ),
  stop: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/storage/runLifecycle')),
      (module) => module.stopRun(...args),
    ),
};

/** A run started at `runs`' door with nothing to open, and awaited: the
 *  caller's interruption stops it. Its parent, when it has one, is the
 *  view's (`run.start` published first). */
export function startAwaited<A, E, R extends AgentRunServices>(
  runs: RunsShape,
  runId: RunId,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error> {
  return Effect.flatMap(
    registryOf(runs).start(runId, { open: Effect.void, run: () => program }),
    ({ fiber }) =>
      Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
  );
}
