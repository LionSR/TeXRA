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
  // cast: a test registry stands for no session, so what it starts reads
  // none of a session's services
  (fork) => fork as RunRegistryInit['fork'],
);

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
    // The registry reads its session's view (empty here), claims (no-ops)
    // and its own `run.detach` batches (dropped); nothing else.
    // cast: the registry reads only these members of its view and log.
    new RunRegistry({
      view: {
        run: () => undefined,
        ref: emptyView,
      } as unknown as RunRegistryInit['view'],
      log: {
        transact: () => Effect.succeed([]),
        hold: () => Effect.void,
      } as unknown as RunRegistryInit['log'],
      roots: testWorkspaceRoots(),
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
  resume: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/runtime/resumeRun')),
      (module) => module.decideResume(...args),
    ),
  finalize: (...args) =>
    Effect.flatMap(
      Effect.promise(() => import('@agent/storage/runLifecycle')),
      (module) => module.finalizeRun(...args),
    ),
};

/**
 * A run whose generation is live on the run registry, the way a real launch
 * admits one: the fiber is the run's stop target, and a stop reaches the
 * run by interrupting it. `onInterrupt` fires from the fiber's own
 * unwinding, so it has observably landed once the stop's settlement (or an
 * await of the returned fiber) resolves.
 */
export function admitInterruptibleRun(
  runs: RunsShape,
  runId: RunId,
  onInterrupt: () => void,
  launchParent: RunId | null = null,
): Fiber.Fiber<void> {
  const interruptEffect = Effect.sync(onInterrupt);
  // Awaited as a root launch awaits: interrupting this fiber stops the run.
  return Effect.runFork(
    startAwaited(
      runs,
      runId,
      Effect.never.pipe(Effect.onInterrupt(() => interruptEffect)),
      launchParent,
    ).pipe(Effect.ignore),
  );
}

/** A run admitted at `runs`' door and awaited, as a root launch awaits its
 *  program: the caller's interruption stops it. */
export function startAwaited<A, E extends Error, R extends AgentRunServices>(
  runs: RunsShape,
  runId: RunId,
  program: Effect.Effect<A, E, R>,
  launchParent: RunId | null = null,
): Effect.Effect<A, E | Error> {
  return Effect.flatMap(
    registryOf(runs).start(runId, program, (run) => run, launchParent),
    ({ fiber }) =>
      Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
  );
}
